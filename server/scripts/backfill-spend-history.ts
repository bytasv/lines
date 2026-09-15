/**
 * One-shot reconstruction of the day-resolution spend ledger from transcripts.
 *
 *   npm run backfill:spend-history -w server                # dry run: prints, writes nothing
 *   npm run backfill:spend-history -w server -- --write     # applies
 *   npm run backfill:spend-history -w server -- --user <clerk-user-id>
 *
 * `spend-history.json` is written live by `server/src/spendHistory.ts` from the
 * turn that settles, so it starts empty and only ever grows forward. Everything
 * spent before it existed is still on disk, though — every `result` event in
 * `transcripts/<sessionId>.jsonl` carries its own `ts` — so the history can be
 * rebuilt once, here.
 *
 * Two things the rebuilt history is NOT:
 *
 *  - Complete. Deleting a session hard-deletes its transcript and a rewind
 *    truncates one, so a session whose events are gone contributes nothing and
 *    cannot be recovered. A *later* run can therefore produce a SMALLER history
 *    than an earlier one, which is why the write is a whole-blob replace with a
 *    backup rather than an addition to whatever is already there.
 *  - Attributed the way the live path attributes. Live, a turn's whole spend goes
 *    under `resolveModelId(meta.model)` — the session's model at that moment,
 *    which the transcript does not record. Here it is split across the models the
 *    SDK itself reported in `modelUsage`, by per-model delta, falling back to the
 *    session's *current* model when a result carries no `modelUsage`. Both land
 *    in the same key space via `resolveModelId`; only the provenance differs. One
 *    visible consequence: a turn split across two models counts a `turns` against
 *    each, so backfilled turn counts can exceed the number of turns actually run.
 *
 * Cost is always `billRun`'s billed delta, never a raw `total_cost_usd` reading
 * — that field is cumulative over a query lifetime (see shared/resultSpend.ts),
 * and the same shared rule is used here as live so the two cannot diverge.
 *
 * Run with the bridge STOPPED: it holds the ledger in memory and whole-file
 * persists, so a live bridge would write its own copy straight back over this.
 *
 * Throwaway — delete once every store has been backfilled.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { addSpend, billRun, dayKey, resolveModelId, sortedSpend } from '@lines/shared';
import type {
  ModelSpendMap,
  ResultSpendPayload,
  SessionMeta,
  SpendHistoryBlob,
} from '@lines/shared';

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

/** A transcript `result` with the moment it was written — the whole reason this
 *  script can date spend that `SessionMeta` cannot. */
interface StampedResult {
  ts: number;
  payload: ResultSpendPayload;
}

/** The SDK `result` events of one session, in transcript order. Transcript lines
 *  are `{ seq, ts, kind, data }`; SDK messages ride under kind 'sdk'. */
function resultsOf(file: string): StampedResult[] {
  if (!fs.existsSync(file)) return [];
  const out: StampedResult[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event: { ts?: number; kind?: string; data?: { type?: string } };
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a torn trailing line; the rest of the file is still usable
    }
    if (event.kind !== 'sdk' || event.data?.type !== 'result') continue;
    if (typeof event.ts !== 'number') continue; // undatable, so unusable here
    out.push({ ts: event.ts, payload: event.data as ResultSpendPayload });
  }
  return out;
}

/** Same composition as the live accumulator's per-turn token sum. */
function turnTokens(usage: ResultSpendPayload['usage']): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

type ModelUsage = NonNullable<ResultSpendPayload['modelUsage']>;

function modelTokens(m: ModelUsage[string]): number {
  return (
    (m.inputTokens ?? 0) +
    (m.outputTokens ?? 0) +
    (m.cacheReadInputTokens ?? 0) +
    (m.cacheCreationInputTokens ?? 0)
  );
}

/**
 * How this result's spend divides between models, as weights summing to 1.
 *
 * `modelUsage` is cumulative over the query lifetime exactly like
 * `total_cost_usd`, so the per-model share of one turn is the delta against the
 * previous result of the same lifetime. Cost deltas first; tokens when the SDK
 * reported no per-model cost (codex). An empty result means "cannot tell".
 */
function weights(current: ModelUsage, previous: ModelUsage | null): Record<string, number> {
  for (const read of [
    (m: ModelUsage[string]) => m.costUSD ?? 0,
    modelTokens,
  ]) {
    const deltas: Record<string, number> = {};
    let total = 0;
    for (const [model, usage] of Object.entries(current)) {
      const before = previous?.[model];
      const delta = read(usage) - (before ? read(before) : 0);
      if (delta <= 0) continue;
      deltas[model] = delta;
      total += delta;
    }
    if (total > 0) {
      for (const model of Object.keys(deltas)) deltas[model] /= total;
      return deltas;
    }
  }
  return {};
}

interface UserResult {
  days: Record<string, ModelSpendMap>;
  sessions: number;
  skipped: number;
  total: number;
}

function rebuildUser(userId: string): UserResult {
  const root = path.join(USERS_ROOT, userId);
  const metas = readJson<SessionMeta[]>(path.join(root, 'sessions.json'), []);
  const days: Record<string, ModelSpendMap> = {};
  let sessionsSeen = 0;
  let skipped = 0;
  let total = 0;

  for (const meta of metas) {
    const results = resultsOf(path.join(root, 'transcripts', `${meta.id}.jsonl`));
    if (results.length === 0) {
      skipped++;
      continue;
    }
    sessionsSeen++;
    const billed = billRun(results.map((r) => r.payload));
    const fallbackModel = resolveModelId(meta.model);
    let previousUsage: ModelUsage | null = null;

    results.forEach(({ ts, payload }, i) => {
      const spend = billed[i];
      const tokens = turnTokens(payload.usage);
      // The live guard, restated: a result carrying neither number opens no row.
      if (!spend && tokens === 0) return;
      const cost = spend?.billed ?? 0;
      total += cost;

      // `billRun` bills the whole reading exactly when it decides the lifetime
      // restarted, which is also when the cumulative `modelUsage` counters reset
      // — so the previous snapshot must not be subtracted from this one. Read off
      // its output rather than re-deciding, so the two cannot disagree.
      const fresh = spend != null && spend.billed === spend.cumulative;
      const usage = payload.modelUsage;
      const split = usage ? weights(usage, fresh ? null : previousUsage) : {};
      if (usage) previousUsage = usage;

      const row = (days[dayKey(ts)] ??= {});
      const entries = Object.entries(split);
      if (entries.length === 0) {
        // No per-model evidence: attribute the turn whole, under the session's
        // model as the live path would have.
        addSpend(row, fallbackModel, cost, tokens);
        return;
      }
      for (const [model, weight] of entries) {
        addSpend(row, resolveModelId(model), cost * weight, tokens * weight);
      }
    });
  }

  return { days, sessions: sessionsSeen, skipped, total };
}

function writeUser(userId: string, days: Record<string, ModelSpendMap>): void {
  const file = path.join(USERS_ROOT, userId, 'spend-history.json');
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    console.log(`  backed up existing ledger to ${path.basename(backup)}`);
  }
  const blob: SpendHistoryBlob = {
    v: 1,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    days,
  };
  // Whole replace, never a merge: running this twice must not double-count.
  fs.writeFileSync(file, JSON.stringify(blob, null, 2));
  console.log(`  wrote ${file}`);
}

if (!fs.existsSync(USERS_ROOT)) {
  console.error(`no store found at ${USERS_ROOT}`);
  process.exit(1);
}
if (onlyUser?.startsWith('--') || (userIdx >= 0 && !onlyUser)) {
  console.error('usage: backfill-spend-history.ts [--write] [--user <clerk-user-id>]');
  process.exit(1);
}
if (await bridgeRunning()) {
  console.error(
    'The bridge is running on :8787 — stop it first (it holds the ledger in memory and whole-file persists, so it would write its own copy straight back).',
  );
  process.exit(1);
}

const users = onlyUser
  ? [onlyUser]
  : fs.readdirSync(USERS_ROOT).filter((e) => fs.statSync(path.join(USERS_ROOT, e)).isDirectory());

console.log(write ? 'Rebuilding spend history' : 'Dry run — nothing will be written');
console.log(
  'Model attribution here is the SDK-reported modelUsage split, not the session model the live\n' +
    'path uses, and a turn split across two models counts a turn against each. Sessions whose\n' +
    'transcripts are gone (deleted, or truncated by a rewind) contribute nothing and cannot.\n',
);

let grandTotal = 0;
for (const userId of users) {
  const { days, sessions, skipped, total } = rebuildUser(userId);
  const dayKeys = Object.keys(days).sort();
  grandTotal += total;
  if (dayKeys.length === 0) {
    console.log(`${userId}: no datable result events${skipped ? ` (${skipped} sessions without transcripts)` : ''}`);
    continue;
  }
  console.log(
    `${userId}: ${dayKeys.length} days from ${sessions} sessions, ${dayKeys[0]} → ${dayKeys.at(-1)}, ${usd(total)}`,
  );
  if (skipped) console.log(`  (${skipped} sessions contributed nothing: no result events on disk)`);
  // By year, so the printout stays readable on a store with years of history.
  const byYear = new Map<string, number>();
  for (const [day, row] of Object.entries(days)) {
    const year = day.slice(0, 4);
    const spent = sortedSpend(row).reduce((n, [, s]) => n + s.costUsd, 0);
    byYear.set(year, (byYear.get(year) ?? 0) + spent);
  }
  for (const year of [...byYear.keys()].sort()) {
    console.log(`  ${year}  ${usd(byYear.get(year)!).padStart(10)}`);
  }
  if (write) writeUser(userId, days);
}

console.log(`\nGrand total ${usd(grandTotal)}`);
console.log('Compare against the hover card\'s All-time rollup before writing — they should be close,');
console.log('differing by deleted sessions and by the model-attribution asymmetry above.');
if (!write) console.log('\nRe-run with --write to apply.');
