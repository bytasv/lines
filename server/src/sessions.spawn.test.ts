import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta, TranscriptEvent } from '@lines/shared';
import { AuthRequiredError, type AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient } from './workerClient.ts';

const meta = (id: string): SessionMeta =>
  ({
    id,
    name: id,
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    caveman: { enabled: false, level: 'full' },
    status: 'idle',
    createdAt: 1,
  }) as SessionMeta;

interface Push {
  sessionId: string;
  options: Record<string, unknown>;
}

/** A manager over a throwaway store, with every worker push recorded. */
function harness(ensureFreshToken: () => Promise<string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-spawn-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta('s1')]));
  const store = createStore(root);
  const auth = {
    getAccessTokenSync: () => null,
    ensureFreshToken,
    handleTokenRejected: async () => {},
  } as unknown as AuthManager;
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (msg) => broadcasts.push(msg), auth);
  const pushes: Push[] = [];
  sessions.attachWorker({
    push: (sessionId: string, _message: unknown, options: Record<string, unknown>) =>
      pushes.push({ sessionId, options }),
    close: () => {},
  } as unknown as WorkerClient);
  return { sessions, broadcasts, pushes, transcript: () => store.loadTranscript('s1') };
}

/** The trailing transcript event, which is what the web Retry button keys off. */
const lastResult = (events: TranscriptEvent[]) => {
  const last = events.at(-1);
  assert.equal(last?.kind, 'sdk');
  return last!.data as { type?: string; is_error?: boolean; subtype?: string; result?: string };
};

/** Let the fire-and-forget pushTurn chain settle (no timers involved). */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const tokenEnv = (push: Push) =>
  (push.options.env as Record<string, string> | undefined)?.CLAUDE_CODE_OAUTH_TOKEN;

test('a turn while logged out is refused instead of falling back to ambient credentials', async () => {
  const h = harness(async () => {
    throw new AuthRequiredError();
  });

  h.sessions.prompt('s1', 'hello');
  await settle();

  assert.deepEqual(h.pushes, []);
  const result = lastResult(h.transcript());
  assert.equal(result.is_error, true);
  assert.equal(result.result, 'Not signed in to Claude. Sign in, then Retry.');
  assert.equal(h.sessions.get('s1')?.status, 'error');
  // Re-broadcast so a dismissed login modal reopens.
  assert.ok(h.broadcasts.some((m) => m.type === 'authStatus' && m.auth.loggedIn === false));
});

test('a stale token is refreshed before the query spawns', async () => {
  const h = harness(async () => 'new-token');

  h.sessions.prompt('s1', 'hello');
  await settle();

  assert.equal(h.pushes.length, 1);
  assert.equal(tokenEnv(h.pushes[0]!), 'new-token');
});

test('every spawn carries the OAuth token', async () => {
  const h = harness(async () => 'tok');

  h.sessions.prompt('s1', 'one');
  await settle();
  h.sessions.prompt('s1', 'two');
  await settle();

  assert.equal(h.pushes.length, 2);
  for (const push of h.pushes) assert.equal(tokenEnv(push), 'tok');
});

test('a refresh failure fails the turn with the reason', async () => {
  const h = harness(async () => {
    throw new Error('Token refresh failed (503)');
  });

  h.sessions.prompt('s1', 'hello');
  await settle();

  assert.deepEqual(h.pushes, []);
  const message = h.sessions.get('s1')?.errorMessage;
  assert.match(String(message), /Could not refresh the Claude login: Token refresh failed \(503\)/);
  // Still signed in, so no login modal.
  assert.ok(!h.broadcasts.some((m) => m.type === 'authStatus'));
});
