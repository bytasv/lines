import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';

/**
 * Sidebar groups: membership is one field on the synced meta (`groupId`), set by
 * `setSessionGroup` and otherwise left alone — archiving, unarchiving, sending a
 * prompt and adopting a synced row all keep it.
 */

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id,
    name: id,
    cwd: '/tmp',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }) as SessionMeta;

function harness(seed: SessionMeta[] = [meta('s1')]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-groups-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(seed));
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (msg) => broadcasts.push(msg));
  sessions.attachWorker({ setModel: () => {}, close: () => {}, push: () => {}, interrupt: () => {} } as never);
  return { store, sessions, broadcasts };
}

const upserted = (broadcasts: ServerMessage[]) =>
  broadcasts.flatMap((m) => (m.type === 'sessionUpsert' ? [m.session] : []));

test('setSessionGroup sets and clears the group, broadcasting each change', () => {
  const h = harness();
  h.sessions.setSessionGroup('s1', 'g1');
  assert.equal(h.sessions.get('s1')!.groupId, 'g1');
  assert.equal(upserted(h.broadcasts).at(-1)?.groupId, 'g1');

  h.sessions.setSessionGroup('s1', null);
  assert.equal(h.sessions.get('s1')!.groupId, undefined);
  assert.equal(upserted(h.broadcasts).length, 2);
  assert.equal(upserted(h.broadcasts).at(-1)?.groupId, undefined);
});

test('setSessionGroup persists across a reload', () => {
  const h = harness();
  h.sessions.setSessionGroup('s1', 'g1');
  // The write is debounced like every other status write, so flush to read it.
  h.sessions.flushPersist();
  const saved = h.store.loadSessions().find((s) => s.id === 's1');
  assert.equal(saved?.groupId, 'g1');
});

test('setSessionGroup ignores an unknown session', () => {
  const h = harness();
  h.sessions.setSessionGroup('nope', 'g1');
  assert.deepEqual(h.broadcasts, []);
});

test('archive and unarchive keep the group, so unarchiving returns the session to it', () => {
  const h = harness([meta('s1', { groupId: 'g1' })]);
  h.sessions.archiveSession('s1');
  assert.equal(h.sessions.get('s1')!.archived, true);
  assert.equal(h.sessions.get('s1')!.groupId, 'g1');
  h.sessions.unarchiveSession('s1');
  assert.equal(h.sessions.get('s1')!.archived, false);
  assert.equal(h.sessions.get('s1')!.groupId, 'g1');
});

test('sending a prompt reactivates an archived session without leaving its group', () => {
  const h = harness([meta('s1', { groupId: 'g1', archived: true, archivedAt: 5 })]);
  h.sessions.prompt('s1', 'pick this back up');
  assert.equal(h.sessions.get('s1')!.archived, false);
  assert.equal(h.sessions.get('s1')!.groupId, 'g1');
});

test('adoptSynced keeps a remote groupId', () => {
  const h = harness([]);
  h.sessions.adoptSynced(meta('s2', { groupId: 'g9', updatedAt: 10 }));
  assert.equal(h.sessions.get('s2')!.groupId, 'g9');
  // A newer remote write that moved it back to Active clears it here too.
  h.sessions.adoptSynced(meta('s2', { updatedAt: 20 }));
  assert.equal(h.sessions.get('s2')!.groupId, undefined);
});
