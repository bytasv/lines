import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMessage, UsageSnapshot } from '@lines/shared';
import { AuthRequiredError, type AuthManager } from './auth.ts';
import { UsagePoller, parseExtraUsage, parseSnapshot, planLabelFromProfile } from './usage.ts';

const OK_BODY = { five_hour: { utilization: 42, resets_at: '2026-01-01T00:00:00Z' } };

/** `fetch` is private on the poller; tests drive one poll at a time instead of the interval. */
interface TestPoller {
  fetch(): Promise<void>;
  readonly snapshot: UsageSnapshot | null;
}

function makePoller(opts: { loggedIn?: () => boolean; token?: () => Promise<string> } = {}) {
  const sent: ServerMessage[] = [];
  const auth = {
    isLoggedIn: () => opts.loggedIn?.() ?? true,
    ensureFreshToken: opts.token ?? (async () => 'tok'),
    forceRefresh: async () => 'tok',
  } as unknown as AuthManager;
  const poller = new UsagePoller((msg) => sent.push(msg), auth) as unknown as TestPoller;
  return { poller, sent };
}

/** Swap `globalThis.fetch` for the duration of a test. */
function stubFetch(impl: () => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const okResponse = () => Promise.resolve(new Response(JSON.stringify(OK_BODY), { status: 200 }));

test('successful poll stores and broadcasts a snapshot', async (t) => {
  t.after(stubFetch(okResponse));
  const { poller, sent } = makePoller();

  await poller.fetch();

  assert.equal(poller.snapshot?.windows.length, 1);
  assert.equal(poller.snapshot?.windows[0].utilization, 42);
  assert.deepEqual(
    sent.map((m) => m.type),
    ['usage'],
  );
});

test('repeated transient failures keep the stale snapshot and never broadcast null', async (t) => {
  let fail = false;
  t.after(stubFetch(() => (fail ? Promise.reject(new Error('network down')) : okResponse())));
  const { poller, sent } = makePoller();

  await poller.fetch();
  const good = poller.snapshot;
  assert.ok(good);

  fail = true;
  for (let i = 0; i < 5; i++) await poller.fetch();

  assert.equal(poller.snapshot, good, 'stale snapshot survives failures');
  assert.equal(sent.length, 1, 'no further broadcasts, in particular no usage: null');
});

test('non-ok responses are transient too', async (t) => {
  let status = 200;
  t.after(
    stubFetch(() =>
      status === 200 ? okResponse() : Promise.resolve(new Response('nope', { status })),
    ),
  );
  const { poller, sent } = makePoller();

  await poller.fetch();
  status = 503;
  for (let i = 0; i < 4; i++) await poller.fetch();

  assert.ok(poller.snapshot);
  assert.equal(sent.length, 1);
});

test('AuthRequiredError clears the snapshot and broadcasts null', async (t) => {
  let authed = true;
  t.after(stubFetch(okResponse));
  const { poller, sent } = makePoller({
    token: async () => {
      if (!authed) throw new AuthRequiredError();
      return 'tok';
    },
  });

  await poller.fetch();
  assert.ok(poller.snapshot);

  authed = false;
  await poller.fetch();

  assert.equal(poller.snapshot, null);
  assert.deepEqual(sent.at(-1), { type: 'usage', usage: null });
});

test('logout clears the snapshot and broadcasts null once', async (t) => {
  let loggedIn = true;
  t.after(stubFetch(okResponse));
  const { poller, sent } = makePoller({ loggedIn: () => loggedIn });

  await poller.fetch();
  assert.ok(poller.snapshot);

  loggedIn = false;
  await poller.fetch();
  await poller.fetch();

  assert.equal(poller.snapshot, null);
  assert.deepEqual(sent.at(-1), { type: 'usage', usage: null });
  assert.equal(sent.filter((m) => m.type === 'usage' && m.usage === null).length, 1);
});

test('extra_usage with a numeric utilization is not a window, and limits is ignored', () => {
  const snapshot = parseSnapshot({
    ...OK_BODY,
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 24.68 },
    limits: [{ kind: 'x', percent: 10, utilization: 10 }],
  });
  assert.deepEqual(
    snapshot.windows.map((w) => w.id),
    ['five_hour'],
  );
  assert.equal(snapshot.credits?.usedMinor, 1234);
});

test('extra usage: metered, unlimited, disabled and malformed', () => {
  assert.deepEqual(
    parseExtraUsage({
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 24.68, currency: 'USD' },
    }),
    { enabled: true, limitMinor: 5000, usedMinor: 1234, utilization: 24.68, currency: 'USD' },
  );
  assert.deepEqual(
    parseExtraUsage({ extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 0, utilization: null } }),
    { enabled: true, unlimited: true, usedMinor: 0 },
  );
  assert.deepEqual(
    parseExtraUsage({ extra_usage: { is_enabled: false, monthly_limit: null, disabled_reason: 'org_disabled' } }),
    { enabled: false, disabledReason: 'org_disabled' },
  );
  for (const extra_usage of [undefined, null, 'on', 3]) {
    assert.equal(parseExtraUsage({ extra_usage }), undefined);
  }
  assert.deepEqual(parseExtraUsage({ extra_usage: { is_enabled: 'yes', monthly_limit: 'lots' } }), {
    enabled: false,
  });
});

test('planLabelFromProfile maps organization type and Max tier', () => {
  const profile = (organization_type: unknown, rate_limit_tier?: unknown) => ({
    organization: { organization_type, rate_limit_tier },
  });
  const table: [unknown, string | undefined][] = [
    [profile('claude_pro'), 'Pro'],
    [profile('claude_max', 'default_claude_max_5x'), 'Max 5x'],
    [profile('claude_max', 'default_claude_max_20x'), 'Max 20x'],
    [profile('claude_max'), 'Max'],
    [profile('claude_team'), 'Team'],
    [profile('claude_enterprise'), 'Enterprise'],
    [profile('claude_student_plan'), 'Student Plan'],
    [profile(null), undefined],
    [{}, undefined],
    [null, undefined],
  ];
  for (const [input, expected] of table) assert.equal(planLabelFromProfile(input), expected, JSON.stringify(input));
});

/** Answers by URL, so usage and profile can fail independently. */
function urlFetch(profile: () => Promise<Response>) {
  return ((url: string) =>
    String(url).endsWith('/profile') ? profile() : okResponse()) as unknown as () => Promise<Response>;
}

test('a profile success adds the plan to the snapshot', async (t) => {
  t.after(
    stubFetch(
      urlFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } }),
            { status: 200 },
          ),
        ),
      ),
    ),
  );
  const { poller } = makePoller();
  await poller.fetch();
  assert.equal(poller.snapshot?.plan, 'Max 20x');
});

test('a profile failure leaves the snapshot intact, with no plan', async (t) => {
  for (const profile of [
    () => Promise.resolve(new Response('forbidden', { status: 403 })),
    () => Promise.reject(new Error('network down')),
  ]) {
    const restore = stubFetch(urlFetch(profile));
    const { poller, sent } = makePoller();
    await poller.fetch();
    restore();
    assert.equal(poller.snapshot?.windows.length, 1);
    assert.equal(poller.snapshot?.plan, undefined);
    assert.equal(sent.length, 1);
  }
  t.diagnostic('profile failures never fail the usage poll');
});
