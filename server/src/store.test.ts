import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SessionMeta, TranscriptEvent } from '@lines/shared';
import { createStore } from './store.ts';

/** Fixed mtime, restored after an out-of-band write so the cache's stat check
 *  sees an unchanged file. Whole seconds — utimes round-trips those exactly. */
const STAMP = new Date(1_700_000_000_000);

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-store-'));
  return { root, store: createStore(root), file: (id: string) => path.join(root, 'transcripts', `${id}.jsonl`) };
}

const ev = (seq: number): TranscriptEvent => ({ seq, ts: 0, kind: 'user', data: { text: `m${seq}` } }) as TranscriptEvent;

test('transcript reads are served from cache while mtime and size match', () => {
  const { store, file } = tmpStore();
  const f = file('s1');
  store.appendTranscript('s1', ev(0));
  fs.utimesSync(f, STAMP, STAMP);
  assert.equal(store.loadTranscript('s1')[0].seq, 0);

  // Same size, same mtime — the cached lines win even though the bytes changed.
  fs.writeFileSync(f, `${JSON.stringify(ev(9))}\n`);
  fs.utimesSync(f, STAMP, STAMP);
  assert.equal(store.loadTranscript('s1')[0].seq, 0);
});

test('a write with a different size is picked up', () => {
  const { store, file } = tmpStore();
  store.appendTranscript('s1', ev(0));
  store.loadTranscript('s1');
  fs.writeFileSync(file('s1'), `${JSON.stringify(ev(0))}\n${JSON.stringify(ev(1))}\n`);
  assert.deepEqual(
    store.loadTranscript('s1').map((e) => e.seq),
    [0, 1],
  );
});

test('appendTranscript extends the cached entry instead of invalidating it', () => {
  const { store } = tmpStore();
  store.appendTranscript('s1', ev(0));
  assert.equal(store.loadTranscript('s1').length, 1); // populates `parsed`
  store.appendTranscript('s1', ev(1));
  assert.deepEqual(
    store.loadTranscript('s1').map((e) => e.seq),
    [0, 1],
  );
  assert.deepEqual(store.loadTranscriptRaw('s1').length, 2);
});

test('deleteTranscript drops the cache entry', () => {
  const { store } = tmpStore();
  store.appendTranscript('s1', ev(0));
  store.loadTranscript('s1');
  store.deleteTranscript('s1');
  assert.deepEqual(store.loadTranscript('s1'), []);
  assert.deepEqual(store.loadTranscriptRaw('s1'), []);
});

test('a torn trailing line is dropped from both the raw and parsed views', () => {
  const { store, file } = tmpStore();
  fs.writeFileSync(file('s1'), `${JSON.stringify(ev(0))}\n${JSON.stringify(ev(1)).slice(0, 12)}`);
  assert.deepEqual(store.loadTranscriptRaw('s1'), [JSON.stringify(ev(0))]);
  assert.deepEqual(
    store.loadTranscript('s1').map((e) => e.seq),
    [0],
  );
});

test('raw lines join into a parseable events array', () => {
  const { store } = tmpStore();
  store.appendTranscript('s1', ev(0));
  store.appendTranscript('s1', ev(1));
  const events = JSON.parse(`[${store.loadTranscriptRaw('s1').join(',')}]`) as TranscriptEvent[];
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1],
  );
});

test('the cache is bounded — old sessions are evicted, not accumulated', () => {
  const { store, file } = tmpStore();
  for (let i = 0; i < 20; i++) store.appendTranscript(`s${i}`, ev(0));
  for (let i = 0; i < 20; i++) {
    fs.utimesSync(file(`s${i}`), STAMP, STAMP);
    store.loadTranscript(`s${i}`);
  }
  // s0 fell out of the bound: an edit it would otherwise have masked is visible.
  const evicted = file('s0');
  fs.writeFileSync(evicted, `${JSON.stringify(ev(7))}\n`);
  fs.utimesSync(evicted, STAMP, STAMP);
  assert.equal(store.loadTranscript('s0')[0].seq, 7);
  // The most recent one is still cached, so the same edit is masked there.
  const kept = file('s19');
  fs.writeFileSync(kept, `${JSON.stringify(ev(7))}\n`);
  fs.utimesSync(kept, STAMP, STAMP);
  assert.equal(store.loadTranscript('s19')[0].seq, 0);
});

test('guard sync state round-trips, and a missing file reads as empty', () => {
  const { store } = tmpStore();
  assert.deepEqual(store.loadGuardSync(), { updatedAt: 0, pending: null, rejected: null });
  const state = {
    updatedAt: 7,
    pending: { entries: [{ tool: 'Bash', prefix: 'npm run' }], remoteUpdatedAt: 3, detectedAt: 5 },
    rejected: { entries: [{ tool: 'WebFetch' }], rejectedAt: 6 },
  };
  store.saveGuardSync(state);
  assert.deepEqual(store.loadGuardSync(), state);
});

test('sessions.json is written compactly', () => {
  const { store, root } = tmpStore();
  const meta = {
    id: 'a',
    name: 'n',
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    caveman: { enabled: false, level: 'full' },
    status: 'idle',
    createdAt: 1,
  } as SessionMeta;
  store.saveSessions([meta]);
  assert.equal(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8').includes('\n'), false);
});
