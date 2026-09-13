import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta } from '@lines/shared';
import { AuthRequiredError, type AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager, localSessionName } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient } from './workerClient.ts';

/**
 * Auto-naming when the helper cannot answer.
 *
 * A title is the one thing a session gets before its first turn has produced
 * anything, so "the helper failed" must never settle as "New session" — it used
 * to, permanently, because the catch wrote no fallback and nothing ever retried.
 *
 * No provider is wired here (`ensureFreshToken` throws, no OpenAI account), so
 * the helper answers null naturally — no stub or seam needed.
 */
function harness(extra: Partial<SessionMeta> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-autoname-'));
  const meta = {
    id: 's1',
    name: 'New session',
    cwd: '/tmp',
    model: 'claude-opus-5',
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
  return { sessions, broadcasts };
}

/** Let the fire-and-forget autoName chain settle, timers included. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('a dead helper still names the session from its prompt', async () => {
  const h = harness();
  const prompt = 'Fix the sidebar scroll jump\nand add a test';

  h.sessions.prompt('s1', prompt);
  await settle();

  assert.equal(h.sessions.get('s1')?.name, localSessionName(prompt));
  assert.notEqual(h.sessions.get('s1')?.name, 'New session');
});

test('a second prompt re-attempts the title after a failed one', async () => {
  const h = harness();

  h.sessions.prompt('s1', 'first thing');
  await settle();
  assert.equal(h.sessions.get('s1')?.name, 'first thing');

  // nameAuto is already spent; only the retry set can get us back in here.
  h.sessions.prompt('s1', 'second thing');
  await settle();
  assert.equal(h.sessions.get('s1')?.name, 'second thing');
});

test('a failed attempt still spends nameAuto', async () => {
  // The Sidebar reads `nameAuto === true` as "never prompted, safe to delete
  // outright instead of archiving". A prompted session must never read that way,
  // however its title turned out — which is why the retry state is a separate set.
  const h = harness();

  h.sessions.prompt('s1', 'first thing');
  await settle();

  assert.equal(h.sessions.get('s1')?.nameAuto, false);
});
