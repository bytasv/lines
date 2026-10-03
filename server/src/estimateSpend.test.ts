import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateClaudeCallUsd, estimateSpendUsd, hasEstimatedSpend } from '@lines/shared';

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
  assert.equal(
    estimateSpendUsd('claude-sonnet-5', { input_tokens: 1_000_000 }),
    estimateSpendUsd('claude-sonnet-5-5', { input_tokens: 1_000_000 }),
  );
  // A step still stored on a retired OpenAI id is costed at its replacement's
  // rate, not left undefined — OpenAI reports no cost, so this estimate is the
  // only figure that step will ever show. Asserted against the literal rate as
  // well as the replacement, so two unknown ids answering undefined cannot pass.
  assert.equal(estimateSpendUsd('gpt-5.6-sol', { input_tokens: 1_000_000 }), 2);
  assert.equal(
    estimateSpendUsd('gpt-5.6-sol', { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    estimateSpendUsd('gpt-6-sol', { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
  );
  assert.equal(estimateSpendUsd('gpt-5.6-luna', { output_tokens: 1_000_000 }), 0.5);
  assert.equal(
    estimateSpendUsd('gpt-5.6-luna', { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    estimateSpendUsd('gpt-6-luna', { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
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

test('a Claude call is priced the way Claude Code prices it', () => {
  // The implementation step measured against its own transcript: Opus 5.5's
  // per-model counters and the `costUSD` the CLI reported for them, reproduced
  // to the cent by list prices with every write at the 1-hour rate.
  const usd = estimateClaudeCallUsd('claude-opus-5-5', {
    input_tokens: 230,
    output_tokens: 211_545,
    cache_read_input_tokens: 34_464_696,
    cache_creation_input_tokens: 436_338,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 436_338 },
  });
  assert.ok(Math.abs(usd! - 14.6154632) < 1e-9, String(usd));
});

test('a Claude call’s input is never reduced by its cache reads', () => {
  // Codex's input contains the cached share; Anthropic's sits beside it.
  assert.equal(
    estimateClaudeCallUsd('claude-sonnet-5-5', { input_tokens: 1_000, cache_read_input_tokens: 10_000 }),
    (1_000 * 2 + 10_000 * 0.2) / 1_000_000,
  );
});

test('a 5-minute cache write costs 1.25x input and an unsplit one is taken as 1-hour', () => {
  const split = estimateClaudeCallUsd('claude-haiku-4-5', {
    cache_creation_input_tokens: 3_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
  });
  assert.equal(split, (1_000 * 1.25 + 2_000 * 2) / 1_000_000);
  assert.equal(
    estimateClaudeCallUsd('claude-haiku-4-5', { cache_creation_input_tokens: 3_000 }),
    (3_000 * 2) / 1_000_000,
  );
});

test('a dated snapshot id is priced as its model, and an unknown one not at all', () => {
  assert.equal(
    estimateClaudeCallUsd('claude-haiku-4-5-20251001', { input_tokens: 1_000_000 }),
    estimateClaudeCallUsd('claude-haiku-4-5', { input_tokens: 1_000_000 }),
  );
  assert.equal(estimateClaudeCallUsd('claude-unlisted-0', { input_tokens: 1 }), undefined);
});
