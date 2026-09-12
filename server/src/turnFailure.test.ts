import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAuthFailureMessage } from './auth.ts';
import { authRecoveryMessage } from './sessions.ts';
import {
  classifyTurnFailure,
  turnFailureAdvice,
  turnFailureRetryHint,
  type TurnFailureKind,
} from './turnFailure.ts';

const KINDS: TurnFailureKind[] = ['filtered', 'context', 'invalid', 'overloaded'];

/** Wording seen from the CLI/SDK for each kind, as close to verbatim as we have. */
const SAMPLES: Record<TurnFailureKind, string[]> = {
  filtered: [
    "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy.",
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Output blocked by content filtering policy"}}',
    'The model returned stop_reason "refusal"',
  ],
  context: [
    'API Error: 400 {"type":"invalid_request_error","message":"prompt is too long: 214331 tokens > 200000 maximum"}',
    'Input exceeds the maximum context length for this model',
    'context_length_exceeded',
  ],
  invalid: [
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: unexpected role"}}',
    'API Error: 400 Bad Request',
  ],
  overloaded: [
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}',
    'API Error: 429 Too Many Requests',
  ],
};

test('each kind matches the error text it exists for', () => {
  for (const kind of KINDS) {
    for (const sample of SAMPLES[kind]) {
      assert.equal(classifyTurnFailure(sample), kind, sample);
    }
  }
});

test('an unrelated failure stays unclassified, so the raw text stands', () => {
  for (const message of [
    'read ECONNRESET',
    'Claude Code process exited with code 1',
    'Failed to start the turn: spawn ENOENT',
    'Bash tool failed: exit code 429 lines written',
  ]) {
    assert.equal(classifyTurnFailure(message), null, message);
  }
});

test('a filter refusal wins over the 400 wording it arrives wrapped in', () => {
  // Content-filter blocks come back AS invalid_request_error 400s — the specific
  // reason has to beat the generic envelope.
  assert.equal(
    classifyTurnFailure(
      'API Error: 400 {"type":"invalid_request_error","message":"Output blocked by content filtering policy"}',
    ),
    'filtered',
  );
});

test('an overflowing prompt reads as a context problem, not a bad request', () => {
  assert.equal(
    classifyTurnFailure(
      'API Error: 400 Bad Request — invalid_request_error: prompt is too long: 214331 tokens > 200000 maximum',
    ),
    'context',
  );
});

test('advice and hints cannot re-classify themselves into a loop', () => {
  // Every one of these strings can end up in errorMessage and be re-classified on
  // the next failure; a self-match would rewrite the banner forever.
  const strings = [
    ...KINDS.flatMap((kind) => [
      turnFailureAdvice(kind, { inWorkflow: true }),
      turnFailureAdvice(kind, { inWorkflow: false }),
      turnFailureRetryHint(kind),
    ]),
    // The auth banners ride in errorMessage the same way and are re-classified on
    // the next failure, so they are under the same constraint.
    authRecoveryMessage({ outcome: 'refreshed' }),
    authRecoveryMessage({ outcome: 'signed-out' }),
    authRecoveryMessage({ outcome: 'refresh-failed', error: new Error('Token refresh failed (500)') }),
  ].filter((s): s is string => s !== null);

  for (const text of strings) {
    assert.equal(classifyTurnFailure(text), null, text);
    assert.equal(isAuthFailureMessage(text), false, text);
  }
});

test('the skip sentence rides only on a workflow session', () => {
  for (const kind of KINDS) {
    const plain = turnFailureAdvice(kind, { inWorkflow: false });
    const inWorkflow = turnFailureAdvice(kind, { inWorkflow: true });
    assert.equal(plain.includes('approve the step'), false, kind);
    assert.match(inWorkflow, /approve the step/);
    assert.ok(inWorkflow.startsWith(plain));
  }
});

test('every kind names an action the user can take next', () => {
  for (const kind of KINDS) {
    // These banners are only ever shown once the app has stopped acting on its own:
    // 'overloaded' is re-driven transparently first and reaches a banner only after
    // the attempt budget is spent, and the rest were never auto-retried at all. So
    // Retry really is the next step by the time the user reads this.
    assert.match(turnFailureAdvice(kind, { inWorkflow: false }), /Retry/);
  }
});

test('a hint is added only where re-phrasing is what changes the outcome', () => {
  assert.match(turnFailureRetryHint('filtered')!, /verbatim/);
  assert.match(turnFailureRetryHint('context')!, /smaller pieces/);
  assert.equal(turnFailureRetryHint('invalid'), null);
  assert.equal(turnFailureRetryHint('overloaded'), null);
  // The auth path rewrites its own banner and re-sends the prompt untouched.
  assert.equal(turnFailureRetryHint('auth'), null);
  assert.equal(turnFailureRetryHint(undefined), null);
});
