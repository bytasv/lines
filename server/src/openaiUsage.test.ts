import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOpenaiUsage } from './openaiUsage.ts';

/** A `/wham/usage` body, shaped as the CLI's generated models describe it. */
const body = (over: Record<string, unknown> = {}) => ({
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 5 * 3600,
      reset_after_seconds: 900,
      reset_at: 1_800_000_000,
    },
    secondary_window: {
      used_percent: 7,
      limit_window_seconds: 7 * 24 * 3600,
      reset_after_seconds: 100_000,
      reset_at: 1_800_500_000,
    },
  },
  ...over,
});

test('both windows are read, in primary-then-secondary order', () => {
  const snapshot = parseOpenaiUsage(body());
  assert.equal(snapshot.windows.length, 2);
  // The chip picks windows[0] as its ring value, so the order is load-bearing.
  assert.equal(snapshot.windows[0].id, 'openai_primary');
  assert.equal(snapshot.windows[0].utilization, 42);
  assert.equal(snapshot.windows[1].utilization, 7);
});

test('labels are derived from the window length, since the API names none', () => {
  const snapshot = parseOpenaiUsage(body());
  assert.equal(snapshot.windows[0].label, 'Session (5h)');
  assert.equal(snapshot.windows[1].label, 'Weekly');
});

test('reset_at is converted from unix seconds to the ISO the chip renders', () => {
  const snapshot = parseOpenaiUsage(body());
  assert.equal(snapshot.windows[0].resetsAt, new Date(1_800_000_000_000).toISOString());
});

test('a window with no reset reads as unknown rather than as epoch zero', () => {
  const snapshot = parseOpenaiUsage(
    body({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 3600, reset_at: 0 },
      },
    }),
  );
  assert.equal(snapshot.windows[0].resetsAt, null);
});

test('additional rate limits ride along without displacing the main ones', () => {
  const snapshot = parseOpenaiUsage(
    body({
      additional_rate_limits: [
        { details: { primary_window: { used_percent: 90, limit_window_seconds: 3600, reset_at: 0 } } },
      ],
    }),
  );
  assert.equal(snapshot.windows.length, 3);
  assert.equal(snapshot.windows[2].id, 'openai_additional_0');
  assert.equal(snapshot.windows[2].utilization, 90);
});

test('a body with nothing parsable throws, so the caller keeps its last snapshot', () => {
  // Replacing a good reading with an empty one would blank the chip on a shape
  // change; throwing leaves the previous snapshot (and its visible age) in place.
  for (const bad of [null, 'nope', {}, { rate_limit: null }, { rate_limit: { primary_window: {} } }]) {
    assert.throws(() => parseOpenaiUsage(bad), /usage response|no usage windows/);
  }
});

test('a double-optional null window is tolerated, not treated as data', () => {
  const snapshot = parseOpenaiUsage(
    body({
      rate_limit: {
        primary_window: { used_percent: 5, limit_window_seconds: 3600, reset_at: 0 },
        secondary_window: null,
      },
    }),
  );
  assert.equal(snapshot.windows.length, 1);
});
