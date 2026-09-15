/**
 * One-time repair of historical session spend.
 *
 *   npm run repair:spend -w server                # dry run: prints, writes nothing
 *   npm run repair:spend -w server -- --write     # applies
 *   npm run repair:spend -w server -- --user <clerk-user-id>
 *
 * `result.total_cost_usd` is cumulative over the lifetime of the query process,
 * not the turn's own cost, and the accumulator used to add every reading to
 * `SessionMeta.totalCostUsd`. That re-bills every earlier turn of a query on each
 * later one, so stored totals are inflated — measured at roughly 3.5x on a real
 * store. The fix in `server/src/sessions.ts` only corrects new turns; the totals
 * already on disk stay wrong until this runs, because they are additive and never
 * rewound.
 *
 * Recomputation reads the `result` events still present in
 * `transcripts/<sessionId>.jsonl` and folds them with the same shared rule the
 * live accumulator uses (`shared/resultSpend.ts`), so the two cannot disagree
 * about where a query lifetime starts.
 *
 * It also fills in the sessions that never had a cost to inflate. A provider that
 * reports none (codex) left `totalCostUsd` unset and its `costByModel` rows at
 * zero; those turns are now priced from the static table the live path uses
 * (`shared/estimateSpend.ts`), from the same transcripts. Without this the usage
 * card's All-time rollup — which reads these metas, not the day ledger — stays
 * blank for codex however many times `backfill-spend-history.ts` is run.
 *
 * What it touches, per session:
 *   - totalCostUsd, lastCostUsd  — recomputed, estimate included
 *   - costByModel[*].costUsd     — rescaled to the corrected total, keeping the
 *                                  existing split. Historical per-turn model
 *                                  attribution is not recoverable from the meta,
 *                                  and the split was already keyed on whatever
 *                                  `meta.model` was at the time. An estimated
 *                                  share lands on the unpriced rows only, split
 *                                  by tokens — the one weight that survives on a
 *                                  row whose costs are all zero.
 *   - updatedAt                  — bumped, so the correction wins last-writer-wins
 *                                  sync and reaches the user's other machines
 * Tokens and durations are verified correct and left alone. A session with no
 * surviving `result` events is left untouched — its spend cannot be recomputed.
 *
 * Run with the bridge STOPPED: it holds sessions in memory and whole-file
 * persists, so a live bridge would write its inflated totals straight back.
 *
 * Rollout note: `adoptSynced` is a last-writer-wins whole-object replace with no
 * field merge, so a machine still on the old build can clobber a correction by
 * running one turn on the same session. Update every machine before repairing.
 *
 * Throwaway — delete once every store has been repaired. The shared rule it calls
 * stays; the rest of this file does not.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  capabilitiesFor,
  estimateSpendUsd,
  foldResultSpend,
  providerForModel,
  resolveModelId,
} from '@lines/shared';
import type { ModelSpendMap, ResultSpendPayload, SessionMeta } from '@lines/shared';

const args = process.argv.slice(2);
const write = args.includes('--write');
const userIdx = args.indexOf('--user');
const onlyUser = userIdx >= 0 ? args[userIdx + 1] : undefined;
const USERS_ROOT = path.join(os.homedir(), '.lines-app', 'users');

async function bridgeRunning(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:8787/', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The SDK `result` payloads of one session, in transcript order. Transcript
 *  lines are `{ seq, ts, kind, data }`; SDK messages ride under kind 'sdk'. */
function resultsOf(file: string): ResultSpendPayload[] {
  if (!fs.existsSync(file)) return [];
  const out: ResultSpendPayload[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event: { kind?: string; data?: { type?: string } };
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a torn trailing line; the rest of the file is still usable
    }
    if (event.kind !== 'sdk' || event.data?.type !== 'result') continue;
    out.push(event.data as ResultSpendPayload);
  }
  return out;
}

/** Spread `total` across the existing rows in proportion to what they hold now,
 *  so the shape of the split survives while its magnitude is corrected. */
function rescale(map: ModelSpendMap | undefined, total: number): void {
  if (!map) return;
  const rows = Object.values(map);
  const current = rows.reduce((n, row) => n + row.costUsd, 0);
  if (current <= 0) return; // nothing to spread proportionally against
  for (const row of rows) row.costUsd = (row.costUsd / current) * total;
}

/**
 * Put an estimated total onto the rows it belongs to — the ones whose provider
 * reports no cost, since those are the only ones an estimate was computed for.
 *
 * Split by tokens rather than by cost, which is what `rescale` above cannot do
 * here: every one of these rows holds a zero, so there is no existing proportion
 * to preserve. Tokens are the only recorded weight that survived.
 */
function fillEstimated(map: ModelSpendMap | undefined, total: number): void {
  if (!map) return;
  const rows = Object.entries(map)
    .filter(([id]) => !capabilitiesFor(providerForModel(id)).cost)
    .map(([, row]) => row);
  const tokens = rows.reduce((n, row) => n + row.tokens, 0);
  if (tokens <= 0) return;
  for (const row of rows) row.costUsd = (row.tokens / tokens) * total;
}

interface Repair {
  id: string;
  name: string;
  before: number;
  after: number;
}

function repairUser(userId: string): { repairs: Repair[]; skipped: number } {
  const root = path.join(USERS_ROOT, userId);
  const file = path.join(root, 'sessions.json');
  const sessions = readJson<SessionMeta[]>(file, []);
  const repairs: Repair[] = [];
  let skipped = 0;

  for (const meta of sessions) {
    const results = resultsOf(path.join(root, 'transcripts', `${meta.id}.jsonl`));
    if (results.length === 0) {
      // No evidence left to recompute from — leave the stored number alone rather
      // than replacing a wrong total with a made-up one.
      if (meta.totalCostUsd != null) skipped++;
      continue;
    }
    const { totalUsd, lastUsd } = foldResultSpend(results);

    // What the provider never priced, priced from the table — the same gate the
    // live accumulator uses, so a Claude turn that merely happens to be missing a
    // cost is still left alone. Attributed to the session's model, which is what
    // the live path attributes to and what the stored split was already keyed on.
    const modelId = resolveModelId(meta.model);
    let estimatedUsd = 0;
    let lastEstimateUsd: number | undefined;
    if (!capabilitiesFor(providerForModel(modelId)).cost) {
      for (const payload of results) {
        // A result that did report a cost is already inside `totalUsd`.
        if (payload.total_cost_usd != null) continue;
        const estimate = estimateSpendUsd(modelId, payload.usage);
        if (estimate == null) continue;
        estimatedUsd += estimate;
        lastEstimateUsd = estimate;
      }
    }

    const after = totalUsd + estimatedUsd;
    const before = meta.totalCostUsd ?? 0;
    if (before === after) continue;
    meta.totalCostUsd = after;
    // The last result wins. On a session the estimator ran over, every result is
    // uncosted, so the last estimate is the last turn.
    const last = lastEstimateUsd ?? lastUsd;
    if (last != null) meta.lastCostUsd = last;
    rescale(meta.costByModel, totalUsd);
    if (estimatedUsd > 0) fillEstimated(meta.costByModel, estimatedUsd);
    meta.updatedAt = Date.now();
    repairs.push({ id: meta.id, name: meta.name ?? meta.id, before, after });
  }

  if (write && repairs.length > 0) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, JSON.stringify(sessions, null, 2));
    console.log(`  wrote ${file} (backup: ${path.basename(backup)})`);
  }
  return { repairs, skipped };
}

if (!fs.existsSync(USERS_ROOT)) {
  console.error(`no store found at ${USERS_ROOT}`);
  process.exit(1);
}
if (onlyUser?.startsWith('--') || (userIdx >= 0 && !onlyUser)) {
  console.error('usage: repair-spend.ts [--write] [--user <clerk-user-id>]');
  process.exit(1);
}
if (await bridgeRunning()) {
  console.error(
    'The bridge is running on :8787 — stop it first (it whole-file persists from memory and would write the inflated totals straight back).',
  );
  process.exit(1);
}

const users = onlyUser
  ? [onlyUser]
  : fs.readdirSync(USERS_ROOT).filter((e) => fs.statSync(path.join(USERS_ROOT, e)).isDirectory());

console.log(write ? 'Repairing session spend' : 'Dry run — nothing will be written');
let storedTotal = 0;
let correctedTotal = 0;
let skippedTotal = 0;

for (const userId of users) {
  const { repairs, skipped } = repairUser(userId);
  skippedTotal += skipped;
  if (repairs.length === 0) {
    console.log(`${userId}: nothing to correct${skipped ? ` (${skipped} without transcripts)` : ''}`);
    continue;
  }
  console.log(`${userId}: ${repairs.length} sessions`);
  for (const r of repairs.sort((a, b) => b.before - a.before)) {
    storedTotal += r.before;
    correctedTotal += r.after;
    console.log(`  ${usd(r.before).padStart(10)} → ${usd(r.after).padStart(10)}  ${r.name}`);
  }
  if (skipped) console.log(`  (${skipped} sessions left as-is: no result events on disk)`);
}

console.log(`\nStored    ${usd(storedTotal)}`);
console.log(`Corrected ${usd(correctedTotal)}`);
// Signed, because this no longer only ever removes: a codex session had no cost
// stored at all and gains one.
const delta = correctedTotal - storedTotal;
console.log(`${delta < 0 ? 'Removed  ' : 'Added    '} ${usd(Math.abs(delta))}`);
if (skippedTotal) console.log(`Unrecoverable (left as-is): ${skippedTotal} sessions`);
if (!write) console.log('\nRe-run with --write to apply.');
