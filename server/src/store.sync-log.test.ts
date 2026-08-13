import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SyncLogEntry } from '@lines/shared';
import { createStore } from './store.ts';

/**
 * `sync-log.jsonl` is the only place a user can read *why* cloud sync dropped —
 * the bridge console isn't reachable on a desktop or VPS install. It is written
 * from a failure path, so it has to tolerate a torn write and must not grow
 * without bound while storage is down for days.
 */

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-synclog-'));
  return { root, store: createStore(root), file: path.join(root, 'sync-log.jsonl') };
}

const row = (at: number, event: SyncLogEntry['event'] = 'fail'): SyncLogEntry => ({
  at,
  event,
  kind: 'network',
  method: 'GET',
  path: '/settings',
  reason: 'connect ECONNREFUSED',
});

test('sync log rows round-trip, oldest first', () => {
  const { store } = tmpStore();
  store.appendSyncLog(row(1, 'fail'));
  store.appendSyncLog(row(2, 'down'));
  store.appendSyncLog(row(3, 'up'));

  assert.deepEqual(
    store.readSyncLog().map((e) => [e.at, e.event]),
    [[1, 'fail'], [2, 'down'], [3, 'up']],
  );
});

test('readSyncLog returns the newest rows up to its limit', () => {
  const { store } = tmpStore();
  for (let at = 1; at <= 10; at++) store.appendSyncLog(row(at));

  assert.deepEqual(store.readSyncLog(3).map((e) => e.at), [8, 9, 10]);
});

test('a torn trailing line is dropped, not thrown', () => {
  const { store, file } = tmpStore();
  store.appendSyncLog(row(1));
  // What a crash mid-append leaves behind.
  fs.appendFileSync(file, '{"at":2,"event":"fa');

  const entries = store.readSyncLog();
  assert.deepEqual(entries.map((e) => e.at), [1]);
});

test('an absent log reads as empty', () => {
  const { store } = tmpStore();
  assert.deepEqual(store.readSyncLog(), []);
});

test('the log is trimmed to its newer half once over the size cap', () => {
  const { store, file } = tmpStore();
  // Pre-fill past the 256KB cap directly: the cap only binds after days of
  // outage, and appending that many rows one at a time proves nothing extra.
  const padded = { ...row(0), reason: 'x'.repeat(500) };
  const count = 700;
  fs.writeFileSync(
    file,
    Array.from({ length: count }, (_, i) => JSON.stringify({ ...padded, at: i + 1 })).join('\n') + '\n',
  );
  assert.ok(fs.statSync(file).size > 256 * 1024, 'the fixture must exceed the cap');

  store.appendSyncLog(row(9_999, 'up'));

  const entries = store.readSyncLog(count + 10);
  assert.ok(entries.length < count, 'the older half is gone');
  assert.ok(entries.length > count / 3, 'the newer half is kept');
  assert.equal(entries.at(-1)?.at, 9_999, 'the row that triggered the trim survives');
  assert.ok(entries.every((e) => e.at > count / 4), 'the oldest rows were the ones dropped');
  assert.ok(fs.statSync(file).size < 256 * 1024, 'the file is back under the cap');
});
