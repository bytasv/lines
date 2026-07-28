import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODELS, contextWindowFor } from '@lines/shared';
import { extractContextUsage } from './sessions.ts';

const assistantMsg = (usage: unknown) => ({ type: 'assistant', message: { usage } });

test('well-formed assistant usage yields all four components', () => {
  const got = extractContextUsage(
    assistantMsg({
      input_tokens: 12,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 1_500,
      output_tokens: 320,
    }),
    'claude-opus-5',
    1000,
  );
  assert.deepEqual(got, {
    inputTokens: 12,
    cacheReadTokens: 40_000,
    cacheCreationTokens: 1_500,
    outputTokens: 320,
    reportedTotal: undefined,
    model: 'claude-opus-5',
    at: 1000,
  });
});

test('missing usage fields coerce to 0, never NaN', () => {
  const got = extractContextUsage(
    assistantMsg({ input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 7 }),
    'claude-sonnet-5',
    1,
  );
  assert.equal(got?.cacheCreationTokens, 0);
  assert.equal(Number.isNaN(got?.cacheCreationTokens), false);
});

test('assistant message without usage returns undefined', () => {
  assert.equal(extractContextUsage({ type: 'assistant', message: {} }, 'claude-opus-5', 1), undefined);
  assert.equal(extractContextUsage({ type: 'assistant' }, 'claude-opus-5', 1), undefined);
});

test('reported prompt total differing from the component sum is preserved', () => {
  const got = extractContextUsage(
    assistantMsg({
      input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0,
      output_tokens: 5,
      // Beta shapes split cache creation into ephemeral buckets the sum misses.
      prompt_tokens: 250,
    }),
    'claude-opus-5',
    1,
  );
  assert.equal(got?.reportedTotal, 250);
});

test('reported prompt total equal to the component sum is not flagged', () => {
  const got = extractContextUsage(
    assistantMsg({
      input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0,
      output_tokens: 5,
      prompt_tokens: 110,
    }),
    'claude-opus-5',
    1,
  );
  assert.equal(got?.reportedTotal, undefined);
});

test('contextWindowFor resolves known, legacy and unknown ids', () => {
  assert.equal(contextWindowFor('claude-opus-5', DEFAULT_MODELS), 200_000);
  assert.equal(contextWindowFor('claude-opus-4-8', DEFAULT_MODELS), 200_000);
  assert.equal(contextWindowFor('some-future-model', DEFAULT_MODELS), undefined);
});
