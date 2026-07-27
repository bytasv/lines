import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMessage, UsageSnapshot } from '@lines/shared';
import { AuthRequiredError, type AuthManager } from './auth.ts';
import { UsagePoller } from './usage.ts';

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
