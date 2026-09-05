import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta } from '@lines/shared';
import { createStore } from './store.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';

const meta = (id: string): SessionMeta =>
  ({
    id,
    name: id,
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
  }) as SessionMeta;

/** A manager over a throwaway store, with saveSessions counted. */
function harness(ids: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-persist-'));
  const file = path.join(root, 'sessions.json');
  fs.writeFileSync(file, JSON.stringify(ids.map(meta)));
  const store = createStore(root);
  let writes = 0;
  const save = store.saveSessions;
  store.saveSessions = (sessions) => {
    writes++;
    save(sessions);
  };
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (msg) => broadcasts.push(msg));
  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')) as SessionMeta[];
  return { sessions, broadcasts, onDisk, writes: () => writes };
}

test('upsert broadcasts immediately, without waiting on the debounce', () => {
  const h = harness(['a']);
  h.sessions.archiveSession('a');
  assert.equal(h.broadcasts.length, 1);
  assert.equal(h.broadcasts[0].type, 'sessionUpsert');
  assert.equal(h.onDisk()[0].archived, undefined); // write is still pending
  h.sessions.flushPersist();
});

test('flushPersist writes the pending state out synchronously', () => {
  const h = harness(['a']);
  h.sessions.archiveSession('a');
  h.sessions.flushPersist();
  assert.equal(h.onDisk()[0].archived, true);
  assert.equal(h.writes(), 1);
});

test('a burst of transitions coalesces into one write', () => {
  const h = harness(['a', 'b']);
  h.sessions.archiveSession('a');
  h.sessions.archiveSession('b');
  h.sessions.unarchiveSession('a');
  assert.equal(h.broadcasts.length, 3); // every change was announced
  h.sessions.flushPersist();
  assert.equal(h.writes(), 1);
  const disk = h.onDisk();
  assert.equal(disk.find((s) => s.id === 'a')?.archived, false);
  assert.equal(disk.find((s) => s.id === 'b')?.archived, true);
});

test('flushPersist with nothing pending does not write', () => {
  const h = harness(['a']);
  h.sessions.flushPersist();
  assert.equal(h.writes(), 0);
});
