import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionMeta } from '@lines/shared';
import { StorageSyncClient } from './sync.ts';

/**
 * The bulk session push is the one payload that can outgrow the storage
 * server's 2mb body limit (a `workflow.outputs` blob per session, times every
 * session ever). These tests pin the two defences: only push what storage
 * doesn't already have, and split whatever is left under the limit.
 */

/** Must match SESSIONS_PUSH_MAX_BYTES in sync.ts. */
const BUDGET = 1.5 * 1024 * 1024;
/** Session pushes are debounced (PUSH_DEBOUNCE_MS, 2s), so a short wait sees nothing. */
const DEBOUNCE_WAIT_MS = 2_200;
const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

interface Sent {
  url: string;
  bytes: number;
  body: unknown;
}

/** Capture every request; `status()` decides what the fake storage server answers. */
function captureFetch(t: { after: (fn: () => void) => void }, status: () => number = () => 200): Sent[] {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const raw = init.body ? String(init.body) : '';
    sent.push({ url: String(url), bytes: Buffer.byteLength(raw), body: raw ? JSON.parse(raw) : undefined });
    return new Response('{}', { status: status(), headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

function client(): StorageSyncClient {
  return new StorageSyncClient('https://storage.test', () => 'clerk-token');
}

/** A session meta padded to roughly `padBytes` of JSON. */
function meta(id: string, padBytes = 0, updatedAt = 1_000): SessionMeta {
  return {
    id,
    name: 'x'.repeat(padBytes),
    cwd: '/tmp',
    model: 'sonnet',
    status: 'idle',
    createdAt: 500,
    updatedAt,
  } as unknown as SessionMeta;
}

const idsOf = (sent: Sent[]) => sent.flatMap((r) => (r.body as SessionMeta[]).map((m) => m.id)).sort();
const sessionPuts = (sent: Sent[]) => sent.filter((r) => r.url.endsWith('/sessions'));

test('an oversized batch is split into bodies under the push budget', async (t) => {
  const sent = captureFetch(t);
  const sync = client();

  const big = ['a', 'b', 'c', 'd'].map((id) => meta(id, 600 * 1024));
  sync.pushSessions(big);
  await flush(DEBOUNCE_WAIT_MS);

  const puts = sessionPuts(sent);
  assert.ok(puts.length >= 2, `expected the batch to be chunked, got ${puts.length} request(s)`);
  for (const put of puts) assert.ok(put.bytes < BUDGET, `chunk of ${put.bytes} bytes exceeds the budget`);
  assert.deepEqual(idsOf(puts), ['a', 'b', 'c', 'd'], 'every session must land in exactly one chunk');
});

test('a bulk push of unchanged sessions after a successful one sends nothing', async (t) => {
  const sent = captureFetch(t);
  const sync = client();

  const list = [meta('a'), meta('b')];
  sync.pushSessions(list);
  await flush(DEBOUNCE_WAIT_MS);
  assert.equal(sessionPuts(sent).length, 1, 'the first push must go out');

  sync.pushSessions(list);
  await flush(DEBOUNCE_WAIT_MS);
  assert.equal(sessionPuts(sent).length, 1, 'storage already holds these rows — re-sending them is pure waste');
});

test('only the session whose updatedAt moved is pushed again', async (t) => {
  const sent = captureFetch(t);
  const sync = client();

  sync.pushSessions([meta('a'), meta('b')]);
  await flush(DEBOUNCE_WAIT_MS);

  sync.pushSessions([meta('a'), meta('b', 0, 2_000)]);
  await flush(DEBOUNCE_WAIT_MS);

  const puts = sessionPuts(sent);
  assert.equal(puts.length, 2);
  assert.deepEqual(idsOf([puts[1]]), ['b']);
});

test('a rejected push keeps its metas and does not advance the watermark', async (t) => {
  let status = 500;
  const sent = captureFetch(t, () => status);
  const persisted: (string | undefined)[] = [];
  const sync = new StorageSyncClient(
    'https://storage.test',
    () => 'clerk-token',
    (marks) => persisted.push(marks.sessionsPushed),
  );

  sync.pushSessions([meta('a'), meta('b')]);
  await flush(DEBOUNCE_WAIT_MS);
  assert.equal(sessionPuts(sent).length, 1, 'the first attempt still goes out');
  assert.deepEqual(persisted, [], 'a rejected batch must not move the push watermark');

  // The failed batch is requeued, so the next push carries it along rather than dropping it.
  status = 200;
  sync.pushSession(meta('c'));
  await flush(DEBOUNCE_WAIT_MS);

  const retry = sessionPuts(sent)[1];
  assert.deepEqual(idsOf([retry]), ['a', 'b', 'c'], 'a rejected batch must not be lost');
  assert.deepEqual(persisted, ['1000'], 'the watermark lands once the retry is accepted');
});

const sessionDeletes = (sent: Sent[]) => sent.filter((r) => r.url.includes('/sessions/'));

test('a delete issued while a push is in flight is not undone by it', async (t) => {
  const sent = captureFetch(t);
  const sync = client();

  // Two sessions too big to share one body, so the push goes out as two requests and
  // the delete is issued from inside the first one — genuinely in flight, which is the
  // window the per-chunk re-check in flushSessions exists for. A delete raised after
  // the bytes of its own chunk are already on the wire cannot be retracted at all.
  const captured = globalThis.fetch;
  let first = true;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const res = await (captured as typeof fetch)(url as never, init as never);
    if (first && String(url).endsWith('/sessions')) {
      first = false;
      sync.deleteSession('b');
    }
    return res;
  }) as typeof fetch;

  sync.pushSessions([meta('a', 800 * 1024), meta('b', 800 * 1024)]);
  await flush(DEBOUNCE_WAIT_MS);

  const puts = sessionPuts(sent);
  assert.deepEqual(idsOf(puts), ['a'], 'a session deleted mid-flight must not be pushed');
  assert.ok(sessionDeletes(sent).length >= 1, 'and its delete still goes out');
});

test('a delete issued while pulled state is applied is queued, not lost', async (t) => {
  const sent = captureFetch(t);
  const sync = client();

  // `applying` is the window where a pull is being written to disk; the resulting
  // broadcasts route back through here, and a delete used to be dropped outright.
  sync.applying = true;
  sync.deleteSession('gone');
  await flush();
  assert.deepEqual(sessionDeletes(sent), [], 'nothing is sent while applying');

  sync.applying = false;
  sync.pushSessions([meta('a')]);
  await flush(DEBOUNCE_WAIT_MS);
  assert.equal(sessionDeletes(sent).length, 1, 'the queued delete rides the next sync');
  assert.ok(sessionDeletes(sent)[0].url.endsWith('/sessions/gone'));
});

test('a bulk push does not carry a session whose delete is still unconfirmed', async (t) => {
  const sent = captureFetch(t);
  const sync = client();

  // A reconnect pushes the whole list; if the delete has not been acknowledged yet,
  // that list must not be the thing that puts the row back.
  sync.deleteSession('gone');
  sync.pushSessions([meta('a'), meta('gone')]);
  await flush(DEBOUNCE_WAIT_MS);

  assert.deepEqual(idsOf(sessionPuts(sent)), ['a'], 'the whole-list push must not undo a delete');
});

test('a single over-budget session is skipped while its siblings still go out', async (t) => {
  const sent = captureFetch(t);
  const sync = client();

  sync.pushSessions([meta('a'), meta('huge', 2 * 1024 * 1024), meta('b')]);
  await flush(DEBOUNCE_WAIT_MS);

  const puts = sessionPuts(sent);
  assert.equal(puts.length, 1);
  assert.ok(puts[0].bytes < BUDGET);
  assert.deepEqual(idsOf(puts), ['a', 'b'], 'the unchunkable session is dropped, not the whole batch');
});
