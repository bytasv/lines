import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionMeta, SyncOutbox } from '@lines/shared';
import { StorageSyncClient, emptyOutbox } from './sync.ts';

/**
 * The outbox is what lets a storage outage (or the desktop's local window, which
 * has no token at all) cost nothing: every write storage has not confirmed is
 * kept, on disk, until it is — and the client flushes it on its own the moment
 * the link comes back. These pin the pieces that make that true.
 */

/** Pushes are debounced (PUSH_DEBOUNCE_MS, 2s). */
const DEBOUNCE_WAIT_MS = 2_200;
const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

/** Capture every request; `status(url, method)` decides what the fake storage server answers. */
function captureFetch(
  t: { after: (fn: () => void) => void },
  status: (url: string, method: string) => number = () => 200,
): Sent[] {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const raw = init.body ? String(init.body) : '';
    const method = init.method ?? 'GET';
    sent.push({ method, url: String(url), body: raw ? JSON.parse(raw) : undefined });
    return new Response('{}', { status: status(String(url), method), headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

function meta(id: string, updatedAt = 1_000): SessionMeta {
  return { id, name: id, cwd: '/tmp', model: 'sonnet', status: 'idle', createdAt: 500, updatedAt } as unknown as SessionMeta;
}

interface Harness {
  sync: StorageSyncClient;
  /** The last outbox handed to `persistOutbox`, as it would be on disk. */
  saved: () => SyncOutbox | undefined;
  recovered: () => number;
  setToken: (token: string | null) => void;
}

function harness(opts?: { token?: string | null; outbox?: SyncOutbox; sessions?: SessionMeta[] }): Harness {
  let token = opts && 'token' in opts ? (opts.token ?? null) : 'clerk-token';
  let saved: SyncOutbox | undefined;
  let recovered = 0;
  const sync = new StorageSyncClient('https://storage.test', () => token, () => {}, {}, () => {}, {
    probeMs: 60_000,
    outbox: opts?.outbox,
    // A deep copy, as a round trip through the file would be.
    persistOutbox: (outbox) => {
      saved = JSON.parse(JSON.stringify(outbox)) as SyncOutbox;
    },
    onRecovered: () => {
      recovered += 1;
    },
    localSessions: () => opts?.sessions ?? [],
  });
  return { sync, saved: () => saved, recovered: () => recovered, setToken: (t) => (token = t) };
}

test('a delete issued with no token is persisted and sent by the next client to load it', async (t) => {
  const sent = captureFetch(t);
  const offline = harness({ token: null });

  offline.sync.deleteWorkflow('wf1');
  offline.sync.deleteStep('st1');
  offline.sync.deleteRecipe('rc1');
  offline.sync.deleteSession('s1');
  await flush();
  assert.equal(sent.length, 0, 'nothing can go out without a token');
  const disk = offline.saved();
  assert.ok(disk, 'the outbox reached disk');
  assert.deepEqual(Object.keys(disk.deletes.workflow), ['wf1']);
  assert.deepEqual(Object.keys(disk.deletes.step), ['st1']);
  assert.deepEqual(Object.keys(disk.deletes.recipe), ['rc1']);
  assert.deepEqual(Object.keys(disk.deletes.session), ['s1']);

  // A restart: a fresh client seeded from what was on disk.
  const restarted = harness({ outbox: disk });
  assert.equal(restarted.sync.isPendingDelete('workflow', 'wf1'), true, 're-seeded from the outbox');
  assert.equal(restarted.sync.pending().deletes, 4);
  await restarted.sync.drainDeletes();

  const deletes = sent.filter((r) => r.method === 'DELETE').map((r) => new URL(r.url).pathname).sort();
  assert.deepEqual(deletes, ['/recipes/rc1', '/sessions/s1', '/steps/st1', '/workflows/wf1']);
  assert.equal(restarted.sync.isPendingDelete('workflow', 'wf1'), false, 'confirmed deletes leave the outbox');
  assert.equal(restarted.sync.pending().deletes, 0);
  assert.deepEqual(restarted.saved()?.deletes, emptyOutbox().deletes);
});

test('a failed delete stays queued, and a 404 counts as done', async (t) => {
  let status = 503;
  captureFetch(t, () => status);
  const h = harness();

  h.sync.deleteWorkflow('wf1');
  await flush();
  assert.equal(h.sync.isPendingDelete('workflow', 'wf1'), true, 'a failure keeps the delete');

  status = 404;
  await h.sync.drainDeletes();
  assert.equal(h.sync.isPendingDelete('workflow', 'wf1'), false, 'a row that is already gone needs no retry');
});

test('a dirty mark clears only once storage accepts the push', async (t) => {
  let status = 500;
  captureFetch(t, () => status);
  const h = harness();

  h.sync.pushSettings({ theme: 'dark' });
  await flush();
  assert.equal(h.sync.pending().settings, 1, 'a rejected push stays pending');
  assert.equal(h.saved()?.dirty.settings, true);

  status = 200;
  h.sync.pushSettings({ theme: 'dark' });
  await flush();
  assert.equal(h.sync.pending().settings, 0);
  assert.equal(h.saved()?.dirty.settings, undefined);
});

test('a push with no token is marked dirty instead of dropped', async (t) => {
  const sent = captureFetch(t);
  const h = harness({ token: null });

  h.sync.pushWorkflows([]);
  h.sync.pushSteps([]);
  h.sync.pushRecipes([]);
  h.sync.pushMemory({ 'user/CLAUDE.md': { content: 'x', updatedAt: 1 } });
  h.sync.pushProjectKeys({ '/tmp': 'k' });
  await flush();

  assert.equal(sent.length, 0);
  const pending = h.sync.pending();
  assert.equal(pending.workflows, 1);
  assert.equal(pending.steps, 1);
  assert.equal(pending.recipes, 1);
  assert.equal(pending.memory, 1);
  assert.equal(pending.settings, 1, 'project keys count with settings');
});

test('pulled state being applied marks nothing dirty', () => {
  const h = harness({ token: null });
  h.sync.applying = true;
  h.sync.pushWorkflows([]);
  h.sync.pushSettings({});
  h.sync.applying = false;
  assert.deepEqual(h.sync.pending(), { sessions: 0, deletes: 0, workflows: 0, steps: 0, recipes: 0, settings: 0, memory: 0 });
});

test('onRecovered fires once per down->up transition, not per success', async (t) => {
  let status = 503;
  captureFetch(t, () => status);
  const h = harness();

  // The first success of a process is not a recovery.
  status = 200;
  await h.sync.pullStepVersions('o', 's');
  assert.equal(h.recovered(), 0);

  status = 503;
  await h.sync.pullStepVersions('o', 's');
  assert.equal(h.sync.status.available, false);
  assert.equal(h.sync.status.cloud, 'unreachable');

  status = 200;
  await h.sync.pullStepVersions('o', 's');
  await h.sync.pullStepVersions('o', 's');
  assert.equal(h.recovered(), 1, 'one flush for one outage');
  assert.equal(h.sync.status.cloud, 'ok');
  assert.equal(typeof h.sync.status.lastSyncedAt, 'number');
});

test('a first token flushes the outbox when there is something in it', async (t) => {
  captureFetch(t);
  const h = harness({ token: null });
  assert.equal(h.sync.status.cloud, 'signedOut');

  h.sync.tokenArrived();
  assert.equal(h.recovered(), 0, 'still no token, nothing to do');

  h.setToken('clerk-token');
  h.sync.tokenArrived();
  assert.equal(h.recovered(), 0, 'an empty outbox needs no flush');

  h.setToken(null);
  h.sync.deleteWorkflow('wf1');
  h.setToken('clerk-token');
  h.sync.tokenArrived();
  assert.equal(h.recovered(), 1);
});

test('a failed session chunk is retried on its own, without another local change', async (t) => {
  let status = 500;
  const sent = captureFetch(t, () => status);
  const h = harness();

  h.sync.pushSessions([meta('a')]);
  await flush(DEBOUNCE_WAIT_MS);
  const puts = () => sent.filter((r) => r.method === 'PUT' && r.url.endsWith('/sessions'));
  assert.equal(puts().length, 1);

  // The first retry is armed at twice the debounce.
  status = 200;
  await flush(4_300);
  assert.equal(puts().length, 2, 'the failed batch went out again with nothing else changing');
  assert.deepEqual((puts()[1].body as SessionMeta[]).map((m) => m.id), ['a']);
});

test('memory reports success only once storage accepts the map', async (t) => {
  let status = 500;
  captureFetch(t, () => status);
  const h = harness();
  let committed = 0;

  h.sync.pushMemory({ 'user/CLAUDE.md': { content: 'x', updatedAt: 1 } }, () => committed++);
  await flush(DEBOUNCE_WAIT_MS);
  assert.equal(committed, 0, 'a rejected push must not advance the manifest');
  assert.equal(h.sync.pending().memory, 1);

  status = 200;
  h.sync.pushMemory({ 'user/CLAUDE.md': { content: 'y', updatedAt: 2 } }, () => committed++);
  await flush(DEBOUNCE_WAIT_MS);
  assert.equal(committed, 1);
  assert.equal(h.sync.pending().memory, 0);
});

test('pending counts sessions newer than the last accepted push', async (t) => {
  captureFetch(t);
  const sessions = [meta('a', 1_000), meta('b', 2_000)];
  const h = harness({ sessions });
  assert.equal(h.sync.pending().sessions, 2);

  h.sync.pushSessions(sessions);
  await flush(DEBOUNCE_WAIT_MS);
  assert.equal(h.sync.pending().sessions, 0);

  sessions.push(meta('c', 3_000));
  assert.equal(h.sync.pending().sessions, 1);
  assert.deepEqual(h.sync.status.pending?.sessions, 1, 'the status carries the same counts');
});
