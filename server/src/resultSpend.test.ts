import assert from 'node:assert/strict';
import { test } from 'node:test';
import { billRun, foldResultSpend, resultSpend, startsQueryLifetime } from '@lines/shared';
import type { ResultSpendPayload } from '@lines/shared';

/**
 * A `result` whose query-lifetime counters stand at `cumulativeCost` /
 * `cumulativeTokens`, and whose own turn spent `turnTokens`. The first result of
 * a lifetime is the one where those last two agree.
 */
const result = (
  cumulativeCost: number,
  cumulativeTokens: number,
  turnTokens: number,
): ResultSpendPayload => ({
  total_cost_usd: cumulativeCost,
  usage: { input_tokens: turnTokens },
  modelUsage: { 'claude-opus-5': { inputTokens: cumulativeTokens } },
});

test('a result whose cumulative tokens are its own turn opens a lifetime', () => {
  assert.equal(startsQueryLifetime(result(1, 100, 100)), true);
  assert.equal(startsQueryLifetime(result(3, 250, 150)), false);
});

test('a result with no modelUsage cannot date the lifetime either way', () => {
  assert.equal(startsQueryLifetime({ total_cost_usd: 1, usage: { input_tokens: 100 } }), false);
});

test('a turn that spent nothing is not read as a boundary', () => {
  assert.equal(startsQueryLifetime(result(1, 0, 0)), false);
});

test('a later result in the same lifetime bills the delta, not the reading', () => {
  assert.deepEqual(resultSpend(result(3, 250, 150), 1), { billed: 2, cumulative: 3 });
});

test('the first result of a lifetime bills whole even when the cost rose', () => {
  // The trap the naive "cost went down" check falls into: this lifetime opens at
  // $10 while the previous one closed at $3.
  assert.deepEqual(resultSpend(result(10, 400, 400), 3), { billed: 10, cumulative: 10 });
});

test('a cumulative reading that went backwards bills whole', () => {
  const dropped: ResultSpendPayload = { total_cost_usd: 2, usage: { input_tokens: 100 } };
  assert.deepEqual(resultSpend(dropped, 5), { billed: 2, cumulative: 2 });
});

test('a result with no earlier reading bills whole', () => {
  assert.deepEqual(resultSpend(result(1, 100, 100)), { billed: 1, cumulative: 1 });
});

test('a result carrying no cost yields no spend', () => {
  assert.equal(resultSpend({ usage: { input_tokens: 100 } }, 1), undefined);
  assert.equal(resultSpend({ total_cost_usd: Number.NaN }, 1), undefined);
});

test('a run of results totals its lifetimes, not the sum of its readings', () => {
  const run = [
    result(1, 100, 100), // lifetime A opens: $1
    result(3, 250, 150), // +$2
    result(10, 400, 400), // lifetime B opens higher than A closed: $10
    result(12, 500, 100), // +$2
  ];
  assert.deepEqual(foldResultSpend(run), { totalUsd: 15, lastUsd: 2 });
  // What the old accumulate-every-reading pass would have booked.
  assert.equal(
    run.reduce((n, r) => n + (r.total_cost_usd ?? 0), 0),
    26,
  );
});

test('cost-less results are skipped without disturbing the running lifetime', () => {
  assert.deepEqual(
    foldResultSpend([result(1, 100, 100), { usage: { input_tokens: 50 } }, result(3, 250, 150)]),
    { totalUsd: 3, lastUsd: 2 },
  );
});

test('a run with no cost anywhere folds to nothing', () => {
  assert.deepEqual(foldResultSpend([{ usage: { input_tokens: 50 } }]), {
    totalUsd: 0,
    lastUsd: undefined,
  });
});

test('billRun is index-aligned with the results it was given', () => {
  const billed = billRun([result(1, 100, 100), result(3, 250, 150), result(10, 400, 400)]);
  assert.equal(billed.length, 3);
  // First of a lifetime, then a delta, then a lifetime that opens above the last.
  assert.deepEqual(
    billed.map((b) => b?.billed),
    [1, 2, 10],
  );
  // And the fold over the same run agrees with the sum of the parts.
  assert.equal(
    foldResultSpend([result(1, 100, 100), result(3, 250, 150), result(10, 400, 400)]).totalUsd,
    13,
  );
});

test('billRun yields undefined for a result carrying no cost, keeping alignment', () => {
  const codex: ResultSpendPayload = { usage: { input_tokens: 500 } };
  const billed = billRun([result(1, 100, 100), codex, result(3, 250, 150)]);
  assert.equal(billed.length, 3);
  assert.equal(billed[1], undefined);
  // The uncosted result does not disturb the lifetime the two around it share.
  assert.deepEqual(billed[2], { billed: 2, cumulative: 3 });
});
