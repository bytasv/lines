import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexCliStatus, ServerMessage } from '@lines/shared';
import {
  OpenaiUsagePoller,
  openaiPlanLabel,
  parseOpenaiUsage,
  type OpenaiUsageDeps,
  type ResetCreditRpc,
} from './openaiUsage.ts';
import type { Store } from './store.ts';

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
  credits: {
    has_credits: true,
    unlimited: false,
    balance: '120.5',
    approx_local_messages: 40,
    approx_cloud_messages: 12,
  },
  additional_rate_limits: [
    {
      limit_name: 'GPT-5-Codex-Mini',
      metered_feature: 'codex_mini',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 90, limit_window_seconds: 5 * 3600, reset_at: 0 },
      },
    },
  ],
  rate_limit_reset_credits: { available_count: 2 },
  ...over,
});

test('both windows are read, in primary-then-secondary order', () => {
  const snapshot = parseOpenaiUsage(body({ additional_rate_limits: undefined }));
  assert.equal(snapshot.windows.length, 2);
  // The chip picks windows[0] as its ring value, so the order is load-bearing.
  assert.equal(snapshot.windows[0].id, 'openai_primary');
  assert.equal(snapshot.windows[0].utilization, 42);
  assert.equal(snapshot.windows[1].utilization, 7);
});

test('labels are derived from the window length, since the API names none', () => {
  const snapshot = parseOpenaiUsage(body());
  assert.equal(snapshot.windows[0].label, '5-hour limit');
  assert.equal(snapshot.windows[1].label, 'Weekly limit');
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

test('reset_after_seconds stands in for a missing reset_at, relative to the fetch', () => {
  const before = Date.now();
  const snapshot = parseOpenaiUsage(
    body({
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 3600, reset_after_seconds: 600 } },
    }),
  );
  const resetMs = new Date(snapshot.windows[0].resetsAt!).getTime();
  assert.ok(resetMs >= before + 600_000 && resetMs <= Date.now() + 600_000);
});

test('additional rate limits are read from rate_limit and named after the limit', () => {
  const snapshot = parseOpenaiUsage(body());
  assert.equal(snapshot.windows.length, 3);
  assert.equal(snapshot.windows[2].id, 'openai_additional_0');
  assert.equal(snapshot.windows[2].utilization, 90);
  assert.equal(snapshot.windows[2].label, 'GPT-5-Codex-Mini · 5-hour limit');
});

test('the legacy details shape of an additional limit still parses', () => {
  const snapshot = parseOpenaiUsage(
    body({
      additional_rate_limits: [
        { details: { primary_window: { used_percent: 90, limit_window_seconds: 3600, reset_at: 0 } } },
      ],
    }),
  );
  assert.equal(snapshot.windows.length, 3);
  assert.equal(snapshot.windows[2].label, '1-hour limit');
});

test('plan_type maps to a display name; unknown ids are title-cased', () => {
  assert.equal(parseOpenaiUsage(body()).plan, 'Pro');
  const table: [unknown, string | undefined][] = [
    ['plus', 'Plus'],
    ['prolite', 'Pro Lite'],
    ['team', 'Team'],
    ['business', 'Business'],
    ['enterprise_cbp_usage_based', 'Enterprise'],
    ['edu', 'Edu'],
    ['go', 'Go'],
    ['free', 'Free'],
    ['self_serve_business_usage_based', 'Self Serve Business Usage Based'],
    ['', undefined],
    [42, undefined],
  ];
  for (const [input, expected] of table) assert.equal(openaiPlanLabel(input), expected, String(input));
  assert.equal(parseOpenaiUsage(body({ plan_type: undefined })).plan, undefined);
});

test('credits are parsed, the balance string included', () => {
  assert.deepEqual(parseOpenaiUsage(body()).credits, {
    enabled: true,
    balance: 120.5,
    approxLocalMessages: 40,
    approxCloudMessages: 12,
  });
  assert.deepEqual(
    parseOpenaiUsage(body({ credits: { has_credits: true, unlimited: true, balance: null } })).credits,
    { enabled: true, unlimited: true },
  );
});

test('missing or odd credits never throw and never drop the windows', () => {
  for (const credits of [undefined, null, 'x', 7, { balance: 'NaN' }, { balance: '' }]) {
    const snapshot = parseOpenaiUsage(body({ credits }));
    assert.equal(snapshot.windows.length, 3);
    assert.equal(snapshot.credits?.balance, undefined);
  }
});

test('limitReached follows either limit_reached or allowed:false', () => {
  const win = { used_percent: 100, limit_window_seconds: 3600, reset_at: 0 };
  assert.equal(parseOpenaiUsage(body()).limitReached, undefined);
  assert.equal(
    parseOpenaiUsage(body({ rate_limit: { limit_reached: true, primary_window: win } })).limitReached,
    true,
  );
  assert.equal(parseOpenaiUsage(body({ rate_limit: { allowed: false, primary_window: win } })).limitReached, true);
});

test('reset credits are counted only when positive', () => {
  assert.equal(parseOpenaiUsage(body()).resetCreditsAvailable, 2);
  for (const rate_limit_reset_credits of [undefined, null, {}, { available_count: 0 }, { available_count: 'x' }]) {
    assert.equal(parseOpenaiUsage(body({ rate_limit_reset_credits })).resetCreditsAvailable, undefined);
  }
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
      additional_rate_limits: null,
    }),
  );
  assert.equal(snapshot.windows.length, 1);
});

// --- consumeResetCredit -------------------------------------------------------

const OK_CLI: CodexCliStatus = { state: 'ok', path: '/bin/codex', minVersion: '0' };

/** `fetch` is private on the poller; the tests count calls to it instead of hitting the network. */
interface TestPoller {
  consumeResetCredit: OpenaiUsagePoller['consumeResetCredit'];
  fetch(): Promise<void>;
}

function makeConsumer(request: ResetCreditRpc['request'], deps: Partial<OpenaiUsageDeps> = {}) {
  const calls = { closed: 0, fetches: 0, keys: [] as unknown[] };
  const store = { codexHome: () => '/tmp/codex-home' } as unknown as Store;
  const poller = new OpenaiUsagePoller((_msg: ServerMessage) => {}, store, {
    codexStatus: () => OK_CLI,
    createAppServer: () => ({
      request: (method, params) => {
        calls.keys.push(params.idempotencyKey);
        return request(method, params);
      },
      close: () => {
        calls.closed++;
      },
    }),
    ...deps,
  }) as unknown as TestPoller;
  poller.fetch = async () => {
    calls.fetches++;
  };
  return { poller, calls };
}

test('each codex outcome is passed through, and the app-server is always closed', async () => {
  for (const outcome of ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'] as const) {
    const { poller, calls } = makeConsumer(async () => ({ outcome }));
    assert.deepEqual(await poller.consumeResetCredit(), { outcome });
    assert.equal(calls.closed, 1);
  }
});

test('a reset triggers an immediate fetch; other outcomes do not', async () => {
  const reset = makeConsumer(async () => ({ outcome: 'reset' }));
  await reset.poller.consumeResetCredit();
  assert.equal(reset.calls.fetches, 1);
  const nothing = makeConsumer(async () => ({ outcome: 'nothingToReset' }));
  await nothing.poller.consumeResetCredit();
  assert.equal(nothing.calls.fetches, 0);
});

test('a missing CLI answers error without spawning anything', async () => {
  const { poller, calls } = makeConsumer(async () => ({ outcome: 'reset' }), {
    codexStatus: () => ({ state: 'missing', minVersion: '0' }),
  });
  const result = await poller.consumeResetCredit();
  assert.equal(result.outcome, 'error');
  assert.match(result.message ?? '', /not installed/);
  assert.equal(calls.keys.length, 0);
});

test('a second concurrent consume is refused', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { poller } = makeConsumer(async () => {
    await gate;
    return { outcome: 'nothingToReset' };
  });
  const first = poller.consumeResetCredit();
  const second = await poller.consumeResetCredit();
  assert.equal(second.outcome, 'error');
  assert.match(second.message ?? '', /already in progress/);
  release();
  assert.equal((await first).outcome, 'nothingToReset');
});

test('a transport failure retries once with the same idempotency key, and closes both times', async () => {
  let n = 0;
  const { poller, calls } = makeConsumer(async () => {
    if (n++ === 0) throw new Error('codex app-server exited');
    return { outcome: 'reset' };
  });
  assert.equal((await poller.consumeResetCredit()).outcome, 'reset');
  assert.equal(calls.keys.length, 2);
  assert.equal(calls.keys[0], calls.keys[1]);
  assert.equal(calls.closed, 2);
});

test('a thrown request ends in error with the app-server closed', async () => {
  const { poller, calls } = makeConsumer(async () => {
    throw new Error('boom');
  });
  const result = await poller.consumeResetCredit();
  assert.equal(result.outcome, 'error');
  assert.equal(result.message, 'boom');
  assert.equal(calls.closed, 2);
});

test('a hung app-server times out, is closed, and releases the lock', async () => {
  const { poller, calls } = makeConsumer(() => new Promise(() => {}), { consumeTimeoutMs: 10 });
  const result = await poller.consumeResetCredit();
  assert.equal(result.outcome, 'error');
  assert.match(result.message ?? '', /timed out/);
  assert.equal(calls.closed, 2);
  // Not stuck "in progress" afterwards.
  assert.doesNotMatch((await poller.consumeResetCredit()).message ?? '', /already in progress/);
});
