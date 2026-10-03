/**
 * Rebuilds historical session spend from the transcripts on disk.
 *
 *   npm run repair:spend -w server                # dry run: prints, writes nothing
 *   npm run repair:spend -w server -- --write     # applies
 *   npm run repair:spend -w server -- --user <clerk-user-id>
 *
 * Stored totals were billed by rules that got Claude Code's running total wrong
 * in both directions (see shared/resultSpend.ts): every reading summed whole
 * before the delta fix; then a whole reading billed again whenever a query was
 * closed or the bridge restarted, though the resumed CLI usually carries the
 * total on; and a fresh-start step or fork, whose new session starts from zero,
 * billed as a delta against the old one. The totals are additive and never
 * rewound, so they stay wrong until this runs.
 *
 * It replays every `result` — rewind sidecars included, since a cut tail's spend
 * was real — through the same shared lineage and attribution the live bridge
 * now uses (`spendReplay.ts`), and rebuilds, per session:
 *   - totalCostUsd, lastCostUsd            — Claude Code's reported cost, or the
 *                                           static-table estimate for a provider
 *                                           that reports none (codex)
 *   - totalTokens, lastTokens              — every model's, subagents included,
 *                                           as live now counts them
 *   - costByModel                          — split by the models that spent it
 *   - workflow stepCostsUsd, stepTokens    — charged to the step under way when
 *                                           each result landed, read off the
 *                                           transcript's workflow markers; left
 *                                           alone when no marker survives
 *   - updatedAt                            — bumped, so the correction wins
 *                                           last-writer-wins sync and reaches the
 *                                           user's other machines
 * Durations are left alone. A session with no `result` events on disk is left
 * untouched — its spend cannot be recomputed.
 *
 * Run with the bridge STOPPED — the desktop app included: it holds sessions in
 * memory and whole-file persists, so a live bridge would write the old totals
 * straight back.
 *
 * Rollout note: `adoptSynced` is a last-writer-wins whole-object replace with no
 * field merge, so a machine still on an older build can clobber a correction by
 * running one turn on the same session. Update every machine before repairing.
 *
 * Throwaway — delete once every store has been repaired. The shared rule it calls
 * stays; the rest of this file does not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { addSpend } from '@lines/shared';
import type { ModelSpendMap, SessionMeta } from '@lines/shared';
import { bridgeRunning, replaySpend, sessionEvents, USERS_ROOT } from './spendReplay.ts';

const args = process.argv.slice(2);
const write = args.includes('--write');
const userIdx = args.indexOf('--user');
const onlyUser = userIdx >= 0 ? args[userIdx + 1] : undefined;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

const usd = (n: number | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);

/** Equal up to key order and float noise — live and the replay add the same
 *  numbers in different orders, and that alone must not count as a change. */
const same = (a: unknown, b: unknown) => {
  const canonical = (v: unknown): string =>
    JSON.stringify(v, (_key, value: unknown) =>
      typeof value === 'number'
        ? Math.round(value * 1e9) / 1e9
        : value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([x], [y]) => (x < y ? -1 : 1)))
          : value,
    );
  return canonical(a) === canonical(b);
};

interface Repair {
  name: string;
  before: number;
  after: number;
  /** Per-step cost, when the workflow's figures changed. */
  steps?: { before: number[]; after: number[] };
}

function repairUser(userId: string): { repairs: Repair[]; skipped: number } {
  const root = path.join(USERS_ROOT, userId);
  const file = path.join(root, 'sessions.json');
  const sessions = readJson<SessionMeta[]>(file, []);
  const repairs: Repair[] = [];
  let skipped = 0;

  for (const meta of sessions) {
    const replay = replaySpend(meta, sessionEvents(root, meta.id));
    if (replay.results.length === 0) {
      // No evidence left to recompute from — leave the stored numbers alone
      // rather than replacing them with made-up ones.
      if (meta.totalCostUsd != null) skipped++;
      continue;
    }
    const costByModel: ModelSpendMap = {};
    for (const result of replay.results) {
      for (const share of result.models) addSpend(costByModel, share.modelId, share.costUsd, share.tokens);
    }
    const wf = meta.workflow;
    const stepsBefore = wf?.stepCostsUsd ? [...wf.stepCostsUsd] : [];
    const next = {
      totalCostUsd: replay.totalCostUsd ?? meta.totalCostUsd,
      lastCostUsd: replay.lastCostUsd,
      totalTokens: replay.totalTokens ?? meta.totalTokens,
      lastTokens: replay.lastTokens,
      costByModel,
    };
    const stepsChanged =
      !!wf &&
      !!replay.steps &&
      (!same(wf.stepCostsUsd ?? [], replay.steps.costUsd) || !same(wf.stepTokens ?? [], replay.steps.tokens));
    const changed =
      stepsChanged ||
      !same(next, {
        totalCostUsd: meta.totalCostUsd,
        lastCostUsd: meta.lastCostUsd,
        totalTokens: meta.totalTokens,
        lastTokens: meta.lastTokens,
        costByModel: meta.costByModel ?? {},
      });
    if (!changed) continue;

    const before = meta.totalCostUsd ?? 0;
    Object.assign(meta, next);
    if (stepsChanged) {
      wf!.stepCostsUsd = replay.steps!.costUsd;
      wf!.stepTokens = replay.steps!.tokens;
    }
    meta.updatedAt = Date.now();
    repairs.push({
      name: meta.name ?? meta.id,
      before,
      after: meta.totalCostUsd ?? 0,
      ...(stepsChanged ? { steps: { before: stepsBefore, after: replay.steps!.costUsd } } : {}),
    });
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
const running = await bridgeRunning();
if (running && write) {
  console.error(
    `A bridge is running: ${running}. Stop it first — it whole-file persists from memory and would write the old totals straight back.`,
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
  for (const r of repairs.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))) {
    storedTotal += r.before;
    correctedTotal += r.after;
    console.log(`  ${usd(r.before).padStart(10)} → ${usd(r.after).padStart(10)}  ${r.name}`);
    if (r.steps) {
      const n = Math.max(r.steps.before.length, r.steps.after.length);
      for (let i = 0; i < n; i++) {
        if ((r.steps.before[i] ?? 0) === (r.steps.after[i] ?? 0)) continue;
        console.log(`      step ${i + 1}: ${usd(r.steps.before[i] ?? 0)} → ${usd(r.steps.after[i] ?? 0)}`);
      }
    }
  }
  if (skipped) console.log(`  (${skipped} sessions left as-is: no result events on disk)`);
}

console.log(`\nStored    ${usd(storedTotal)}`);
console.log(`Corrected ${usd(correctedTotal)}`);
// Signed: the old rules over-billed and under-billed, so this can go either way.
const delta = correctedTotal - storedTotal;
console.log(`${delta < 0 ? 'Removed  ' : 'Added    '} ${usd(Math.abs(delta))}`);
if (skippedTotal) console.log(`Unrecoverable (left as-is): ${skippedTotal} sessions`);
if (running) console.log(`\nNote: ${running}. Stop it before re-running with --write.`);
else if (!write) console.log('\nRe-run with --write to apply.');
