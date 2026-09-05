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
 * Deleting a session has to be a positive fact, not an absence.
 *
 * Storage sync pushes session rows both ways, so an absent session loses every
 * race: whichever machine has not heard about the delete pushes the row it still
 * holds, and `adoptSynced` has nothing to compare a re-arriving session against —
 * which is what made a deleted session come straight back.
 */

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id,
    name: id,
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }) as SessionMeta;

/** A manager over a throwaway store, reopenable so a reload can be asserted. */
function harness(root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-delete-'))) {
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (msg) => broadcasts.push(msg));
  sessions.attachWorker({ close: () => {}, push: () => {}, interrupt: () => {} } as never);
  return {
    root,
    store,
    sessions,
    broadcasts,
    ids: () => sessions.list().map((s) => s.id),
    tombstones: () => store.loadDeletedSessions(),
  };
}

test('a tombstone blocks a stale peer from resurrecting the session', () => {
  const h = harness();
  h.sessions.adoptSynced(meta('s1'));
  assert.deepEqual(h.ids(), ['s1']);

  h.sessions.deleteSession('s1');
  assert.deepEqual(h.ids(), []);

  // Exactly what a peer that has not pulled the tombstone yet pushes: the row as it
  // last knew it, stamped before the delete.
  h.sessions.adoptSynced(meta('s1', { updatedAt: 1 }));
  assert.deepEqual(h.ids(), [], 'a delete must outlive the other machine not knowing about it');
});

test('a write genuinely newer than the delete brings the session back', () => {
  const h = harness();
  h.sessions.adoptSynced(meta('s1'));
  h.sessions.deleteSession('s1');
  const after = (h.tombstones()['s1'] ?? 0) + 1_000;

  // Someone edited it elsewhere after the delete landed. LWW still applies: the
  // tombstone is a floor, not a permanent ban on the id.
  h.sessions.adoptSynced(meta('s1', { updatedAt: after }));
  assert.deepEqual(h.ids(), ['s1']);
});

test('a remote delete is applied even for a session this machine never held', () => {
  const h = harness();
  h.sessions.applyRemoteDelete('never-seen', 5_000);
  assert.deepEqual(
    h.broadcasts.map((m) => m.type),
    ['sessionDeleted'],
    'the browsers are told, so a row adopted a moment ago disappears',
  );

  // The point of recording it without the row: a third machine that is still behind
  // pushes the session later, and it must not be adopted here.
  h.sessions.adoptSynced(meta('never-seen', { updatedAt: 4_999 }));
  assert.deepEqual(h.ids(), []);
});

test('tombstones survive a reload', () => {
  const first = harness();
  first.sessions.adoptSynced(meta('s1'));
  first.sessions.deleteSession('s1');
  first.sessions.flushPersist();

  const reloaded = harness(first.root);
  assert.deepEqual(reloaded.ids(), []);
  reloaded.sessions.adoptSynced(meta('s1', { updatedAt: 1 }));
  assert.deepEqual(reloaded.ids(), [], 'a restart must not forget what was deleted');
});

test('a session left in sessions.json despite a tombstone does not come back on load', () => {
  // Belt and braces for a downgrade/upgrade cycle where an older build rewrote the
  // session list without knowing about tombstones.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-delete-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta('s1')]));
  // A real timestamp, not the fake clock the metas use: the loader prunes tombstones
  // past the 30-day window, so a 1970 one would be dropped before it could guard.
  fs.writeFileSync(path.join(root, 'deleted-sessions.json'), JSON.stringify({ s1: Date.now() }));

  assert.deepEqual(harness(root).ids(), []);
});

test('pruning drops tombstones past the retention window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-delete-'));
  const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(path.join(root, 'deleted-sessions.json'), JSON.stringify({ ancient: old, recent: Date.now() }));

  const h = harness(root);
  assert.deepEqual(Object.keys(h.tombstones()), ['recent']);
  // And the pruned id is adoptable again — the alternative is a file that only grows.
  h.sessions.adoptSynced(meta('ancient'));
  assert.deepEqual(h.ids(), ['ancient']);
});
