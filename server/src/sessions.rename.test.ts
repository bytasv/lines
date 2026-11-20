import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SESSION_NAME_MAX, type ServerMessage, type SessionMeta } from '@lines/shared';
import { AuthRequiredError, type AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient } from './workerClient.ts';

/**
 * Manual session rename (`renameSession`): the user's name is trimmed and capped,
 * spends `nameAuto`, and wins over any auto-name — one not yet started, one in
 * flight when the rename lands, or a retry owed after a failed attempt.
 */
function harness(extra: Partial<SessionMeta> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-rename-'));
  const meta = {
    id: 's1',
    name: 'New session',
    cwd: '/tmp',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
    nameAuto: true,
    ...extra,
  } as SessionMeta;
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta]));
  const store = createStore(root);
  const auth = {
    getAccessTokenSync: () => null,
    ensureFreshToken: async () => {
      throw new AuthRequiredError();
    },
    handleTokenRejected: async () => ({ outcome: 'refreshed' }),
  } as unknown as AuthManager;
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (msg) => broadcasts.push(msg), auth);
  sessions.attachWorker({ push: () => {}, close: () => {} } as unknown as WorkerClient);
  const upserts = () => broadcasts.filter((m) => m.type === 'sessionUpsert').length;
  return { sessions, broadcasts, upserts };
}

/** Let fire-and-forget chains settle, timers included. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('a rename trims, collapses whitespace, spends nameAuto and broadcasts', () => {
  const h = harness();
  const before = h.upserts();

  h.sessions.renameSession('s1', '   Fix   the\n\tsidebar  ');

  const s = h.sessions.get('s1')!;
  assert.equal(s.name, 'Fix the sidebar');
  assert.equal(s.nameAuto, false);
  assert.equal(h.upserts(), before + 1);
});

test('a rename is capped at SESSION_NAME_MAX', () => {
  const h = harness();
  h.sessions.renameSession('s1', 'x'.repeat(SESSION_NAME_MAX + 50));
  assert.equal(h.sessions.get('s1')!.name.length, SESSION_NAME_MAX);
});

test('empty, whitespace-only and unchanged names do nothing', () => {
  const h = harness({ name: 'Keep me' });
  const before = h.upserts();

  h.sessions.renameSession('s1', '');
  h.sessions.renameSession('s1', '   \n ');
  h.sessions.renameSession('s1', '  Keep   me ');

  const s = h.sessions.get('s1')!;
  assert.equal(s.name, 'Keep me');
  assert.equal(s.nameAuto, true);
  assert.equal(h.upserts(), before);
});

test('a read-only session or an unknown id is not renamed', () => {
  const h = harness({ readOnly: true });
  const before = h.upserts();

  h.sessions.renameSession('s1', 'Nope');
  h.sessions.renameSession('missing', 'Nope');

  assert.equal(h.sessions.get('s1')!.name, 'New session');
  assert.equal(h.upserts(), before);
});

test('a rename before the first prompt stops the auto-namer', async () => {
  const h = harness();
  let calls = 0;
  h.sessions.helper = (async () => {
    calls++;
    return 'Generated title';
  }) as SessionManager['helper'];

  h.sessions.renameSession('s1', 'Mine');
  h.sessions.maybeAutoName('s1', 'do the thing');
  await settle();

  assert.equal(calls, 0);
  assert.equal(h.sessions.get('s1')!.name, 'Mine');
});

test('a rename during an in-flight auto-name wins, and the waiter gets it', async () => {
  const h = harness();
  let resolve!: (title: string) => void;
  h.sessions.helper = (() =>
    new Promise<string>((r) => {
      resolve = r;
    })) as SessionManager['helper'];
  const named: string[] = [];
  h.sessions.onAutoNamed = (_meta, title) => named.push(title);

  h.sessions.maybeAutoName('s1', 'do the thing');
  await settle();
  h.sessions.renameSession('s1', 'Mine');
  resolve('Generated title');
  await settle();

  assert.equal(h.sessions.get('s1')!.name, 'Mine');
  assert.deepEqual(named, ['Mine']);
});

test('a rename after a failed auto-name cancels the owed retry', async () => {
  // No provider is wired, so the helper answers null and the session lands in
  // the retry set with a title cut from its prompt.
  const h = harness();
  h.sessions.prompt('s1', 'first thing');
  await settle();
  assert.equal(h.sessions.get('s1')!.name, 'first thing');

  h.sessions.renameSession('s1', 'Mine');
  h.sessions.prompt('s1', 'second thing');
  await settle();

  assert.equal(h.sessions.get('s1')!.name, 'Mine');
});
