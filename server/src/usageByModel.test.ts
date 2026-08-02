import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addSpend, mergeSpend, sortedSpend } from '@lines/shared';
import type { ModelSpendMap } from '@lines/shared';

test('the first turn for a model creates its row with one turn counted', () => {
  const map: ModelSpendMap = {};
  addSpend(map, 'claude-opus-5', 0.25, 1_000);
  assert.deepEqual(map, { 'claude-opus-5': { costUsd: 0.25, tokens: 1_000, turns: 1 } });
});

test('repeat turns accumulate cost, tokens and turn count', () => {
  const map: ModelSpendMap = {};
  addSpend(map, 'claude-opus-5', 0.25, 1_000);
  addSpend(map, 'claude-opus-5', 0.75, 500);
  addSpend(map, 'claude-haiku-4-5', 0.01, 200);
  assert.deepEqual(map['claude-opus-5'], { costUsd: 1, tokens: 1_500, turns: 2 });
  assert.deepEqual(map['claude-haiku-4-5'], { costUsd: 0.01, tokens: 200, turns: 1 });
});

test('a zero-cost turn still counts a turn and produces no NaN', () => {
  const map: ModelSpendMap = {};
  addSpend(map, 'claude-sonnet-5', 0, 0);
  addSpend(map, 'claude-sonnet-5', Number.NaN, Number.NaN);
  assert.deepEqual(map['claude-sonnet-5'], { costUsd: 0, tokens: 0, turns: 2 });
});

test('mergeSpend sums across maps and skips undefined entries', () => {
  const a: ModelSpendMap = { 'claude-opus-5': { costUsd: 1, tokens: 10, turns: 1 } };
  const b: ModelSpendMap = {
    'claude-opus-5': { costUsd: 2, tokens: 20, turns: 3 },
    'claude-haiku-4-5': { costUsd: 0.5, tokens: 5, turns: 1 },
  };
  const merged = mergeSpend([a, undefined, b, undefined]);
  assert.deepEqual(merged['claude-opus-5'], { costUsd: 3, tokens: 30, turns: 4 });
  assert.deepEqual(merged['claude-haiku-4-5'], { costUsd: 0.5, tokens: 5, turns: 1 });
  // Sources are left alone — the rollup is derived, not accumulated in place.
  assert.equal(a['claude-opus-5'].costUsd, 1);
});

test('mergeSpend over nothing is an empty map, so the section renders nothing', () => {
  assert.deepEqual(mergeSpend([undefined, undefined]), {});
  assert.deepEqual(sortedSpend({}), []);
});

test('sortedSpend orders rows by cost, most expensive first', () => {
  const map: ModelSpendMap = {
    'claude-haiku-4-5': { costUsd: 0.01, tokens: 5, turns: 1 },
    'claude-opus-5': { costUsd: 2.5, tokens: 50, turns: 2 },
    'claude-sonnet-5': { costUsd: 0.4, tokens: 20, turns: 1 },
  };
  assert.deepEqual(
    sortedSpend(map).map(([id]) => id),
    ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  );
});
