import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { SyncLogEntry } from '@lines/shared';
import { StorageSyncClient, THROTTLED, classifyError, classifyStatus } from './sync.ts';

/**
 * The "cloud sync unavailable" banner used to have exactly one input — a
 * boolean flipped by whichever request failed last — so a Clerk token that went
 * stale between relays looked identical to a dead storage server, and a
 * recovered server stayed "down" until some unrelated request happened to run.
 * These tests pin the three behaviours that fix that: every failure is
 * classified and logged, auth failures are waited out, and an outage re-probes
 * itself.
 */

const TOKEN = 'clerk-token';
const BASE = 'http://storage.test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Harness {
  /** Rows the client handed to its injected `appendLog`. */
  rows: SyncLogEntry[];
  /** Every URL the client asked for, probes included. */
  calls: string[];
  sync: StorageSyncClient;
  /** Swap what the storage server answers with, mid-test. */
  respond: (fn: () => Response | Promise<Response>) => void;
}

/** A client whose fetch, log sink and timings are all under the test's control. */
function harness(t: TestContext, opts?: { authGraceMs?: number; probeMs?: number }): Harness {
  const original = globalThis.fetch;
  const rows: SyncLogEntry[] = [];
  const calls: string[] = [];
  let responder: () => Response | Promise<Response> = () => json({});
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return responder();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const sync = new StorageSyncClient(
    BASE,
    () => TOKEN,
    () => {},
    {},
    (entry) => rows.push(entry),
    // Probes default to 15s; unless a test drives them, keep them out of its way.
    { probeMs: 60_000, ...opts },
  );
  return { rows, calls, sync, respond: (fn) => { responder = fn; } };
}

/** One request that fails softly (returns null), so a test can await a single round trip. */
const oneRequest = (sync: StorageSyncClient) => sync.pullStepVersions('o', 's');
const REQUEST_PATH = '/steps/o/s/versions';

test('classify maps statuses and transport errors to their kinds', () => {
  assert.equal(classifyStatus(401), 'auth');
  assert.equal(classifyStatus(403), 'auth');
  assert.equal(classifyStatus(500), 'server');
  assert.equal(classifyStatus(503), 'server');
  assert.equal(classifyStatus(404), 'client');

  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(classifyError(timeout), 'timeout');
  assert.equal(classifyError(aborted), 'timeout');
  assert.equal(classifyError(new Error('ECONNREFUSED')), 'network');
});

test('a transport failure goes down as network, with a fail row and a down row', async (t) => {
  const h = harness(t);
  h.respond(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8788')));

  assert.equal(await oneRequest(h.sync), null);

  assert.equal(h.sync.status.available, false);
  assert.equal(h.sync.status.kind, 'network');
  assert.equal(typeof h.sync.status.since, 'number');
  assert.equal(h.sync.status.failures, 1);
  assert.deepEqual(h.rows.map((r) => r.event), ['fail', 'down']);
  assert.equal(h.rows[0].method, 'GET');
  assert.equal(h.rows[0].path, REQUEST_PATH);
  assert.match(String(h.rows[0].reason), /ECONNREFUSED/);
  assert.equal(typeof h.rows[0].ms, 'number');
});

test('an AbortSignal timeout is classified as timeout, not network', async (t) => {
  const h = harness(t);
  h.respond(() => Promise.reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })));

  await oneRequest(h.sync);

  assert.equal(h.sync.status.kind, 'timeout');
  assert.equal(h.rows[0].kind, 'timeout');
});

test("a 500 takes its reason from the server's error body", async (t) => {
  const h = harness(t);
  // The shape an unmigrated storage server answers with (Prisma P2021).
  h.respond(() => json({ error: 'P2021: The table `public.GuardAllowlist` does not exist' }, 500));

  await oneRequest(h.sync);

  assert.equal(h.sync.status.kind, 'server');
  assert.match(String(h.sync.status.reason), /P2021/);
  assert.equal(h.rows[0].status, 500);
});

test('an unmigrated mcp_connections table degrades the pull instead of aborting it', async (t) => {
  const h = harness(t);
  // A storage server running without the newest migration answers 500 for that
  // one route. Every other resource must still come back, and the failure must
  // surface as a `server` status rather than a null pull.
  h.respond(() =>
    h.calls.at(-1)?.includes('/mcp-connections')
      ? json({ error: 'P2021: The table `public.mcp_connections` does not exist' }, 500)
      : json([]),
  );

  const pulled = await h.sync.pullAll();

  assert.ok(pulled !== null && pulled !== THROTTLED, 'the pull must not abort');
  assert.ok(Array.isArray(pulled.workflows));
  assert.equal(pulled.mcpConnections, null);
  assert.equal(h.sync.status.kind, 'server');
  assert.match(String(h.sync.status.reason), /P2021/);
});

test('a non-JSON 5xx body falls back to a synthesized reason', async (t) => {
  const h = harness(t);
  h.respond(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

  await oneRequest(h.sync);

  assert.equal(h.sync.status.kind, 'server');
  assert.equal(h.sync.status.reason, `storage GET ${REQUEST_PATH} → 502`);
});

test('one 401 inside the grace window is logged but does not raise the banner', async (t) => {
  const h = harness(t, { authGraceMs: 60_000 });
  h.respond(() => json({ error: 'unauthenticated' }, 401));

  await oneRequest(h.sync);

  assert.equal(h.sync.status.available, true);
  assert.equal(h.sync.status.kind, undefined);
  assert.deepEqual(h.rows.map((r) => r.event), ['fail']);
  assert.equal(h.rows[0].kind, 'auth');
});

test('401s that outlive the grace window do take the link down', async (t) => {
  const h = harness(t, { authGraceMs: 20 });
  h.respond(() => json({ error: 'unauthenticated' }, 401));

  await oneRequest(h.sync);
  await sleep(40);
  await oneRequest(h.sync);

  assert.equal(h.sync.status.available, false);
  assert.equal(h.sync.status.kind, 'auth');
  assert.deepEqual(h.rows.map((r) => r.event), ['fail', 'fail', 'down']);
});

test('a success between two 401s restarts the grace window', async (t) => {
  const h = harness(t, { authGraceMs: 20 });

  h.respond(() => json({ error: 'unauthenticated' }, 401));
  await oneRequest(h.sync);
  await sleep(40);

  // A fresh token landed and one request went through — the next 401 is a new
  // stale-token episode, not a continuation of the old one.
  h.respond(() => json([]));
  await oneRequest(h.sync);
  h.respond(() => json({ error: 'unauthenticated' }, 401));
  await oneRequest(h.sync);

  assert.equal(h.sync.status.available, true);
  assert.ok(!h.rows.some((r) => r.event === 'down'), 'no outage should have been declared');
});

test('an outage re-probes itself and clears its timer on recovery', async (t) => {
  const h = harness(t, { probeMs: 20 });
  h.respond(() => Promise.reject(new Error('connect ECONNREFUSED')));

  // Two failures back to back: the second must not schedule a second probe, or
  // the interval below would outlive the recovery that clears only one handle.
  await oneRequest(h.sync);
  await oneRequest(h.sync);
  assert.equal(h.sync.status.available, false);

  h.respond(() => json({}));
  await sleep(120);

  assert.equal(h.sync.status.available, true);
  const up = h.rows.find((r) => r.event === 'up');
  assert.ok(up, 'recovery should be logged');
  assert.equal(typeof up!.downMs, 'number');
  assert.ok((up!.failures ?? 0) >= 2, 'the up row carries the failure count');
  assert.ok(h.calls.some((url) => url === `${BASE}/settings`), 'the probe hits /settings');

  const afterRecovery = h.calls.length;
  await sleep(80);
  assert.equal(h.calls.length, afterRecovery, 'no probe may survive the recovery');
});

test('no probe runs while the link is healthy', async (t) => {
  const h = harness(t, { probeMs: 20 });
  h.respond(() => json([]));

  await oneRequest(h.sync);
  await sleep(80);

  assert.equal(h.calls.length, 1, 'a healthy client only talks when asked to');
});

test('retryNow while down probes at once and recovers without waiting for the timer', async (t) => {
  // A long probe interval, so only retryNow can explain the recovery.
  const h = harness(t, { probeMs: 60_000 });
  h.respond(() => Promise.reject(new Error('connect ECONNREFUSED')));
  await oneRequest(h.sync);
  assert.equal(h.sync.status.available, false);

  const statuses: boolean[] = [];
  h.sync.onStatusChange = (s) => statuses.push(s.available);
  h.respond(() => json({}));
  await h.sync.retryNow();

  assert.equal(h.sync.status.available, true);
  assert.equal(h.calls.at(-1), `${BASE}/settings`);
  assert.deepEqual(statuses, [true]);
  assert.equal(h.rows.at(-1)?.event, 'up');
});

test('retryNow while up makes no request', async (t) => {
  const h = harness(t);
  h.respond(() => json([]));
  await oneRequest(h.sync);

  await h.sync.retryNow();

  assert.equal(h.calls.length, 1);
});

test('retryNow that fails on auth stays down, logs the failure and arms no second probe', async (t) => {
  const h = harness(t, { authGraceMs: 0, probeMs: 20 });
  h.respond(() => json({ error: 'unauthenticated' }, 401));
  await oneRequest(h.sync);
  assert.equal(h.sync.status.available, false);

  const before = h.rows.length;
  await h.sync.retryNow();

  assert.equal(h.sync.status.available, false);
  assert.equal(h.sync.status.kind, 'auth');
  assert.deepEqual(h.rows.slice(before).map((r) => r.event), ['fail']);

  // One recovery clears one handle: if retryNow had armed another interval,
  // probes would keep coming after the link is back.
  h.respond(() => json({}));
  await sleep(120);
  assert.equal(h.sync.status.available, true);
  const afterRecovery = h.calls.length;
  await sleep(80);
  assert.equal(h.calls.length, afterRecovery, 'no probe may survive the recovery');
});

test('appendLog is optional — a failure without one still just fails', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const sync = new StorageSyncClient(BASE, () => TOKEN);
  assert.equal(await sync.pullStepVersions('o', 's'), null);
  assert.equal(sync.status.available, false);
});
