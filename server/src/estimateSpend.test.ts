import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateSpendUsd, hasEstimatedSpend } from '@lines/shared';

// Rates read off DEFAULT_MODELS: gpt-5.6-terra is $2 / $0.20 / $12 per 1M.
const TERRA = 'gpt-5.6-terra';

test('an unpriced model estimates nothing rather than nothing-spent', () => {
  // undefined, never 0: a zero renders as "this turn was free", which is a
  // different and wrong claim from "we cannot say".
  assert.equal(estimateSpendUsd('some-model-we-never-listed', { input_tokens: 1_000 }), undefined);
  assert.equal(estimateSpendUsd(TERRA, undefined), 0);
});

test('a priced model with no usage really did cost nothing', () => {
  assert.equal(estimateSpendUsd(TERRA, {}), 0);
  assert.equal(estimateSpendUsd(TERRA, { input_tokens: 0, output_tokens: 0 }), 0);
});

test('a cached read is billed once, at the cached rate', () => {
  // input_tokens already contains the cached reads, so 100 in with 20 cached is
  // 80 at $2 plus 20 at $0.20 — not 100 at $2 plus 20 again.
  assert.equal(
    estimateSpendUsd(TERRA, { input_tokens: 100, cache_read_input_tokens: 20 }),
    (80 * 2 + 20 * 0.2) / 1_000_000,
  );
  // The naive reading, asserted as what this is NOT.
  assert.notEqual(
    estimateSpendUsd(TERRA, { input_tokens: 100, cache_read_input_tokens: 20 }),
    (100 * 2 + 20 * 0.2) / 1_000_000,
  );
});

test('a cache write has no rate of its own and bills as input', () => {
  assert.equal(
    estimateSpendUsd(TERRA, { input_tokens: 0, cache_creation_input_tokens: 5 }),
    (5 * 2) / 1_000_000,
  );
});

test('reasoning is billed as output, not as a third kind of token', () => {
  assert.equal(
    estimateSpendUsd(TERRA, { output_tokens: 30, reasoning_output_tokens: 7 }),
    (37 * 12) / 1_000_000,
  );
});

test('the codex fixture prices out as the sum of its four parts', () => {
  assert.equal(
    estimateSpendUsd(TERRA, {
      input_tokens: 100,
      output_tokens: 30,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      reasoning_output_tokens: 7,
    }),
    (80 * 2 + 20 * 0.2 + 5 * 2 + 37 * 12) / 1_000_000,
  );
});

test('a retired model id is priced as its replacement', () => {
  assert.equal(
    estimateSpendUsd('claude-opus-4-8', { input_tokens: 1_000_000 }),
    estimateSpendUsd('claude-opus-5-5', { input_tokens: 1_000_000 }),
  );
  assert.equal(
    estimateSpendUsd('claude-opus-5', { input_tokens: 1_000_000 }),
    estimateSpendUsd('claude-opus-5-5', { input_tokens: 1_000_000 }),
  );
});

test('spend is marked estimated only where the provider reports no cost', () => {
  assert.equal(hasEstimatedSpend(undefined), false);
  assert.equal(hasEstimatedSpend({}), false);
  assert.equal(
    hasEstimatedSpend({ 'claude-opus-5-5': { costUsd: 1, tokens: 10, turns: 1 } }),
    false,
  );
  assert.equal(hasEstimatedSpend({ [TERRA]: { costUsd: 1, tokens: 10, turns: 1 } }), true);
  // A mixed session — one provider-crossing workflow — marks the total.
  assert.equal(
    hasEstimatedSpend({
      'claude-opus-5-5': { costUsd: 1, tokens: 10, turns: 1 },
      [TERRA]: { costUsd: 0.5, tokens: 10, turns: 1 },
    }),
    true,
  );
  // A codex row recorded before estimates existed: tokens, no money. There is
  // nothing estimated about a zero, so it must not put a tilde on the total.
  assert.equal(hasEstimatedSpend({ [TERRA]: { costUsd: 0, tokens: 10, turns: 1 } }), false);
});
