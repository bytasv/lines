import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addSpend,
  dayKey,
  foldDays,
  mergeSpend,
  periodBounds,
  periodLabel,
  shiftPeriod,
  sortedSpend,
} from '@lines/shared';
import type { ModelSpendMap } from '@lines/shared';

test('the first turn for a model creates its row with one turn counted', () => {
  const map: ModelSpendMap = {};
  addSpend(map, 'claude-opus-5-5', 0.25, 1_000);
  assert.deepEqual(map, { 'claude-opus-5-5': { costUsd: 0.25, tokens: 1_000, turns: 1 } });
});

test('repeat turns accumulate cost, tokens and turn count', () => {
  const map: ModelSpendMap = {};
  addSpend(map, 'claude-opus-5-5', 0.25, 1_000);
  addSpend(map, 'claude-opus-5-5', 0.75, 500);
  addSpend(map, 'claude-haiku-4-5', 0.01, 200);
  assert.deepEqual(map['claude-opus-5-5'], { costUsd: 1, tokens: 1_500, turns: 2 });
  assert.deepEqual(map['claude-haiku-4-5'], { costUsd: 0.01, tokens: 200, turns: 1 });
});

test('a zero-cost turn still counts a turn and produces no NaN', () => {
  const map: ModelSpendMap = {};
  addSpend(map, 'claude-sonnet-5-5', 0, 0);
  addSpend(map, 'claude-sonnet-5-5', Number.NaN, Number.NaN);
  assert.deepEqual(map['claude-sonnet-5-5'], { costUsd: 0, tokens: 0, turns: 2 });
});

test('mergeSpend sums across maps and skips undefined entries', () => {
  const a: ModelSpendMap = { 'claude-opus-5-5': { costUsd: 1, tokens: 10, turns: 1 } };
  const b: ModelSpendMap = {
    'claude-opus-5-5': { costUsd: 2, tokens: 20, turns: 3 },
    'claude-haiku-4-5': { costUsd: 0.5, tokens: 5, turns: 1 },
  };
  const merged = mergeSpend([a, undefined, b, undefined]);
  assert.deepEqual(merged['claude-opus-5-5'], { costUsd: 3, tokens: 30, turns: 4 });
  assert.deepEqual(merged['claude-haiku-4-5'], { costUsd: 0.5, tokens: 5, turns: 1 });
  // Sources are left alone — the rollup is derived, not accumulated in place.
  assert.equal(a['claude-opus-5-5'].costUsd, 1);
});

test('mergeSpend over nothing is an empty map, so the section renders nothing', () => {
  assert.deepEqual(mergeSpend([undefined, undefined]), {});
  assert.deepEqual(sortedSpend({}), []);
});

test('sortedSpend orders rows by cost, most expensive first', () => {
  const map: ModelSpendMap = {
    'claude-haiku-4-5': { costUsd: 0.01, tokens: 5, turns: 1 },
    'claude-opus-5-5': { costUsd: 2.5, tokens: 50, turns: 2 },
    'claude-sonnet-5-5': { costUsd: 0.4, tokens: 20, turns: 1 },
  };
  assert.deepEqual(
    sortedSpend(map).map(([id]) => id),
    ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  );
});

test('dayKey names the local calendar day, not the UTC one', () => {
  // 22:30 local on the 14th. toISOString() would say the 15th east of Greenwich
  // and the 13th west of it; the key must say the 14th either way.
  const local = new Date(2026, 8, 14, 22, 30);
  assert.equal(dayKey(local.getTime()), '2026-09-14');
  // And the first instant of the day, where a UTC read is wrong in the other
  // direction for anyone east of Greenwich.
  assert.equal(dayKey(new Date(2026, 8, 14, 0, 0).getTime()), '2026-09-14');
});

test('a week runs Monday to Sunday whichever day anchors it', () => {
  // 2026-09-14 is a Monday; 2026-09-20 is the Sunday that closes its week.
  const expected = { from: '2026-09-14', to: '2026-09-20' };
  assert.deepEqual(periodBounds('2026-09-14', 'week'), expected);
  assert.deepEqual(periodBounds('2026-09-17', 'week'), expected);
  // The Sunday belongs to the week that started six days earlier, not the next one.
  assert.deepEqual(periodBounds('2026-09-20', 'week'), expected);
});

test('month and year bounds cover the whole calendar span', () => {
  assert.deepEqual(periodBounds('2026-09-14', 'month'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(periodBounds('2026-02-14', 'month'), { from: '2026-02-01', to: '2026-02-28' });
  // Leap year: the last day is computed, never assumed.
  assert.deepEqual(periodBounds('2028-02-14', 'month'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(periodBounds('2026-09-14', 'year'), { from: '2026-01-01', to: '2026-12-31' });
});

test('a week straddling a month and a year boundary keeps its seven days', () => {
  // 2026-12-28 (Mon) → 2027-01-03 (Sun).
  assert.deepEqual(periodBounds('2026-12-31', 'week'), { from: '2026-12-28', to: '2027-01-03' });
});

test('paging wraps across December into January', () => {
  assert.equal(periodBounds(shiftPeriod('2026-12-14', 'month', 1), 'month').from, '2027-01-01');
  assert.equal(periodBounds(shiftPeriod('2027-01-14', 'month', -1), 'month').from, '2026-12-01');
  assert.equal(periodBounds(shiftPeriod('2026-06-14', 'year', 1), 'year').from, '2027-01-01');
  // A week paged from a Sunday steps back to the previous Monday, not four days.
  assert.deepEqual(periodBounds(shiftPeriod('2026-09-20', 'week', -1), 'week'), {
    from: '2026-09-07',
    to: '2026-09-13',
  });
});

test('a day is its own period, and pages one day at a time', () => {
  assert.deepEqual(periodBounds('2026-09-14', 'day'), { from: '2026-09-14', to: '2026-09-14' });
  assert.equal(shiftPeriod('2026-09-14', 'day', 1), '2026-09-15');
  assert.equal(shiftPeriod('2026-09-14', 'day', -1), '2026-09-13');
  // Across a month boundary, and across a year one.
  assert.equal(shiftPeriod('2026-09-30', 'day', 1), '2026-10-01');
  assert.equal(shiftPeriod('2027-01-01', 'day', -1), '2026-12-31');
});

test('an `all` period spans every real day key and cannot page', () => {
  const bounds = periodBounds('2026-09-14', 'all');
  assert.ok('1999-01-01' >= bounds.from && '2099-12-31' <= bounds.to);
  assert.equal(shiftPeriod('2026-09-14', 'all', -1), '2026-09-14');
});

test('a day period folds to exactly that day', () => {
  const days: Record<string, ModelSpendMap> = {
    '2026-09-13': { 'claude-opus-5-5': { costUsd: 1, tokens: 10, turns: 1 } },
    '2026-09-14': { 'claude-opus-5-5': { costUsd: 2, tokens: 20, turns: 1 } },
  };
  const day = periodBounds('2026-09-14', 'day');
  assert.deepEqual(foldDays(days, day.from, day.to), {
    'claude-opus-5-5': { costUsd: 2, tokens: 20, turns: 1 },
  });
});

test('foldDays merges the days inside the range, inclusive of both ends', () => {
  const days: Record<string, ModelSpendMap> = {
    '2026-09-13': { 'claude-opus-5-5': { costUsd: 1, tokens: 10, turns: 1 } },
    '2026-09-14': { 'claude-opus-5-5': { costUsd: 2, tokens: 20, turns: 1 } },
    '2026-09-20': { 'claude-haiku-4-5': { costUsd: 0.5, tokens: 5, turns: 1 } },
    '2026-09-21': { 'claude-opus-5-5': { costUsd: 8, tokens: 80, turns: 1 } },
  };
  const week = periodBounds('2026-09-14', 'week');
  const folded = foldDays(days, week.from, week.to);
  // The 13th is the previous week and the 21st the next; the 14th and the 20th
  // are both ends of this one and both count.
  assert.deepEqual(folded, {
    'claude-opus-5-5': { costUsd: 2, tokens: 20, turns: 1 },
    'claude-haiku-4-5': { costUsd: 0.5, tokens: 5, turns: 1 },
  });
});

test('an empty range folds to an empty map, so the period renders as empty', () => {
  const days: Record<string, ModelSpendMap> = {
    '2026-09-14': { 'claude-opus-5-5': { costUsd: 2, tokens: 20, turns: 1 } },
  };
  assert.deepEqual(foldDays(days, '2026-10-01', '2026-10-31'), {});
  assert.deepEqual(foldDays({}, '2026-09-01', '2026-09-30'), {});
});

/** A fixed "today" so the month branch below is not clock-dependent. */
const NOW = new Date(2026, 9, 5).getTime(); // 5 Oct 2026

test('periodLabel reads en-GB and names the span, not the anchor', () => {
  assert.equal(periodLabel('2026-09-14', 'all', NOW), 'All time');
  assert.equal(periodLabel('2025-09-14', 'year', NOW), '2025');
  assert.equal(periodLabel('2026-09-14', 'month', NOW), 'September 2026');
  // Any day of the week labels the same Monday-to-Sunday span.
  assert.equal(periodLabel('2026-09-17', 'week', NOW), periodLabel('2026-09-14', 'week', NOW));
  // ICU's abbreviated en-GB month varies by Node/runner ('Sep' vs 'Sept').
  assert.match(periodLabel('2026-09-14', 'week', NOW), /14 Sept?.*20 Sept? 2026/);
});

test('the period in progress is labelled by its relation to today', () => {
  assert.equal(periodLabel('2026-10-05', 'day', NOW), 'Today');
  // NOW is Mon 5 Oct 2026, so its week runs 5–11 Oct.
  assert.equal(periodLabel('2026-10-05', 'week', NOW), 'Current week');
  assert.equal(periodLabel('2026-10-11', 'week', NOW), 'Current week');
  assert.equal(periodLabel('2026-10-01', 'month', NOW), 'Current month');
  assert.equal(periodLabel('2026-10-31', 'month', NOW), 'Current month');
  assert.equal(periodLabel('2026-01-01', 'year', NOW), 'Current year');
  assert.equal(periodLabel('2026-12-31', 'year', NOW), 'Current year');
});

test('a period next to the current one still names itself', () => {
  assert.equal(periodLabel('2026-10-04', 'day', NOW), '4 Oct 2026');
  // The week that ends the day before NOW, not "current" by one day.
  assert.match(periodLabel('2026-09-28', 'week', NOW), /28 Sep.*4 Oct 2026/);
  // The same month and the same week-of-year a year either side, so neither
  // label is matched on its name alone.
  assert.equal(periodLabel('2025-10-05', 'month', NOW), 'October 2025');
  assert.equal(periodLabel('2027-10-05', 'month', NOW), 'October 2027');
  assert.equal(periodLabel('2027-10-05', 'year', NOW), '2027');
});
