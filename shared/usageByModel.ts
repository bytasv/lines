import type { ModelSpend, ModelSpendMap } from './types.ts';

/**
 * Fold one settled chat turn into `map`, keyed by the model it ran on. Mutates —
 * the caller owns the map (it lives on `SessionMeta.costByModel`, accumulated in
 * the same pass that owns `totalCostUsd`).
 *
 * `turns` counts calls, not billed API requests, so a zero-cost turn still
 * registers. Missing numbers are the caller's job to default; anything
 * non-finite is dropped so one bad payload can't poison the row with NaN.
 */
export function addSpend(
  map: ModelSpendMap,
  modelId: string,
  costUsd: number,
  tokens: number,
): void {
  const row = (map[modelId] ??= { costUsd: 0, tokens: 0, turns: 0 });
  if (Number.isFinite(costUsd)) row.costUsd += costUsd;
  if (Number.isFinite(tokens)) row.tokens += tokens;
  row.turns += 1;
}

/** Global rollup: sums per-model rows across sessions. `undefined` entries (a
 *  session that hasn't produced a turn since the field existed) are skipped. */
export function mergeSpend(maps: (ModelSpendMap | undefined)[]): ModelSpendMap {
  const merged: ModelSpendMap = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [modelId, spend] of Object.entries(map)) {
      const row = (merged[modelId] ??= { costUsd: 0, tokens: 0, turns: 0 });
      row.costUsd += spend.costUsd;
      row.tokens += spend.tokens;
      row.turns += spend.turns;
    }
  }
  return merged;
}

/** Rows most-expensive first — the order the by-model table renders in. */
export function sortedSpend(map: ModelSpendMap): [string, ModelSpend][] {
  return Object.entries(map).sort((a, b) => b[1].costUsd - a[1].costUsd);
}

/**
 * Calendar bucketing for the spend ledger.
 *
 * Everything below works in day keys — `YYYY-MM-DD` strings in the *local*
 * timezone of whoever produced them — because that is the resolution the ledger
 * is stored at (see `SpendHistoryBlob`). Week/month/year totals are then
 * `mergeSpend` over a contiguous range of those keys, so no new row arithmetic
 * exists anywhere.
 *
 * Two traps this file is deliberately written around:
 *  - `Date.prototype.toISOString()` formats in UTC, so it names the previous day
 *    for any evening west of Greenwich. Keys are always built from
 *    `getFullYear`/`getMonth`/`getDate`.
 *  - `new Date('2026-09-14')` parses as UTC midnight, which renders as the 13th
 *    in those same timezones. Keys are always parsed via `new Date(y, m - 1, d)`.
 */

/** Which calendar span a period covers. `'all'` is the un-bucketed total. */
export type Granularity = 'day' | 'week' | 'month' | 'year' | 'all';

/** Inclusive day-key range. */
export interface PeriodBounds {
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for a timestamp, in the local timezone — never UTC. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a day key. Never `new Date(key)` — that is UTC midnight. */
function parseDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The widest range the ledger can hold, used for `'all'`. String comparison is
 * the range test, and day keys are fixed-width, so these two sort outside every
 * real key without any date maths.
 */
const ALL_BOUNDS: PeriodBounds = { from: '0000-01-01', to: '9999-12-31' };

/**
 * The inclusive day-key range the anchor day falls in.
 *
 * Weeks start Monday (ISO 8601), hardcoded rather than derived from the locale:
 * the ledger's keys are stamped by the bridge while the boundary is drawn by the
 * browser, so a locale-dependent week start would make the same day land in two
 * different weeks on two machines looking at one file.
 */
export function periodBounds(anchor: string, g: Granularity): PeriodBounds {
  if (g === 'all') return ALL_BOUNDS;
  // A day is its own bounds — the resolution the ledger is stored at.
  if (g === 'day') return { from: anchor, to: anchor };
  const d = parseDay(anchor);
  if (g === 'year') {
    return { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` };
  }
  if (g === 'month') {
    const y = d.getFullYear();
    const m = d.getMonth();
    // Day 0 of the next month is the last day of this one, leap years included.
    return { from: `${y}-${pad(m + 1)}-01`, to: keyOf(new Date(y, m + 1, 0)) };
  }
  // getDay(): 0 = Sunday, so Sunday is 6 days *after* the week's Monday.
  const back = (d.getDay() + 6) % 7;
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6);
  return { from: keyOf(from), to: keyOf(to) };
}

/**
 * Total spend over an inclusive day-key range. Iterates the rows that exist
 * rather than the days in the range, so `'all'` costs the same as one week.
 */
export function foldDays(
  days: Record<string, ModelSpendMap>,
  from: string,
  to: string,
): ModelSpendMap {
  const inRange: ModelSpendMap[] = [];
  for (const [day, spend] of Object.entries(days)) {
    if (day >= from && day <= to) inRange.push(spend);
  }
  return mergeSpend(inRange);
}

/** The anchor one period earlier (`-1`) or later (`1`). `'all'` cannot page. */
export function shiftPeriod(anchor: string, g: Granularity, delta: -1 | 1): string {
  if (g === 'all') return anchor;
  const d = parseDay(anchor);
  if (g === 'day') return keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta));
  if (g === 'year') return keyOf(new Date(d.getFullYear() + delta, 0, 1));
  if (g === 'month') return keyOf(new Date(d.getFullYear(), d.getMonth() + delta, 1));
  // From the week's own Monday, so paging from a Sunday doesn't skip a week.
  const monday = parseDay(periodBounds(anchor, 'week').from);
  return keyOf(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + delta * 7));
}

// en-GB throughout, matching the sidebar's date column (web/src/components/Sidebar.tsx).
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const monthYear = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });

/** What a period containing today is called instead of its own name. */
const CURRENT: Record<Exclude<Granularity, 'all'>, string> = {
  // Not "Current day": the word for it already exists and everyone uses it.
  day: 'Today',
  week: 'Current week',
  month: 'Current month',
  year: 'Current year',
};

/**
 * Human heading for the period an anchor names, e.g. `8 – 14 Sep 2026`.
 *
 * `now` is a parameter rather than a `Date.now()` read so the function stays
 * pure and its "is this the month in progress?" branch is testable without
 * freezing the clock.
 */
export function periodLabel(anchor: string, g: Granularity, now: number = Date.now()): string {
  if (g === 'all') return 'All time';
  const { from, to } = periodBounds(anchor, g);
  // The period in progress is named by its relation to today rather than by its
  // own name: "what have I spent this month" is the question the view exists
  // for, and a running total labelled "September 2026" reads as a closed one.
  const today = dayKey(now);
  if (today >= from && today <= to) return CURRENT[g];
  const d = parseDay(anchor);
  if (g === 'day') return dayMonthYear.format(d);
  if (g === 'year') return String(d.getFullYear());
  if (g === 'month') return monthYear.format(d);
  return `${dayMonth.format(parseDay(from))} – ${dayMonthYear.format(parseDay(to))}`;
}
