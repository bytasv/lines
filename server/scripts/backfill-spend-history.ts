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
 *  - Complete. Deleting a session hard-deletes its transcript, so a session
 *    whose events are gone contributes nothing and cannot be recovered. A *later* run can therefore produce a SMALLER history
 *    than an earlier one, which is why the write is a whole-blob replace with a
 *    backup rather than an addition to whatever is already there.
 *  - Different from live in where it starts: it replays the transcripts — and
 *    the rewind sidecars that keep a cut tail — rather than the turns as they
 *    settled. The billing and the attribution are live's own (`spendReplay.ts`):
 *    each result billed by the shared cost lineage, split by the models that
 *    spent it, or under the session's model when it carries no per-model
 *    counters (codex, and old transcripts). A result split across two models
 *    counts a turn against each, exactly as live.
 *
 * Where the provider reports no cost at all, the same shared estimator the live
 * path uses fills in (see shared/estimateSpend.ts), for exactly that reason.
 *
 * Run with the bridge STOPPED: it holds the ledger in memory and whole-file
 * persists, so a live bridge would write its own copy straight back over this.
 *
 * Throwaway — delete once every store has been backfilled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { addSpend, dayKey, sortedSpend } from '@lines/shared';
import type { ModelSpendMap, SessionMeta, SpendHistoryBlob } from '@lines/shared';
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

const usd = (n: number) => `$${n.toFixed(2)}`;

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
    const { results } = replaySpend(meta, sessionEvents(root, meta.id));
    if (results.length === 0) {
      skipped++;
      continue;
    }
    sessionsSeen++;
    for (const result of results) {
      total += result.costUsd ?? 0;
      const row = (days[dayKey(result.ts)] ??= {});
      for (const share of result.models) addSpend(row, share.modelId, share.costUsd, share.tokens);
    }
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
const running = await bridgeRunning();
if (running && write) {
  console.error(
    `A bridge is running: ${running}. Stop it first — it holds the ledger in memory and whole-file persists, so it would write its own copy straight back.`,
  );
  process.exit(1);
}

const users = onlyUser
  ? [onlyUser]
  : fs.readdirSync(USERS_ROOT).filter((e) => fs.statSync(path.join(USERS_ROOT, e)).isDirectory());

console.log(write ? 'Rebuilding spend history' : 'Dry run — nothing will be written');
console.log(
  'Sessions whose transcripts are gone (deleted) contribute nothing and cannot; a rewind\n' +
    "keeps its cut tail in a sidecar, which is read.\n",
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
console.log('differing by deleted sessions.');
if (running) console.log(`\nNote: ${running}. Stop it before re-running with --write.`);
else if (!write) console.log('\nRe-run with --write to apply.');
