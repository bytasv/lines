import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthStatus } from '@lines/shared';
import { AuthManager, isAuthFailureMessage } from './auth.ts';
import type { Store, StoredAuth } from './store.ts';

test('isAuthFailureMessage matches rejected-token error text', () => {
  const positives = [
    'OAuth token refresh failed: invalid_grant',
    '{"type":"authentication_error","message":"..."}',
    'Invalid bearer token',
    'API Error: 401 Unauthorized',
    'Unauthorized (401)',
    'OAuth token has expired',
    'OAuth authentication failed',
    'Invalid API key · Please run /login',
  ];
  for (const message of positives) {
    assert.equal(isAuthFailureMessage(message), true, message);
  }
});

test('isAuthFailureMessage ignores ordinary failures', () => {
  const negatives = [
    'read ECONNRESET',
    'Claude Code process exited with code 1',
    'Request timed out',
    '{"type":"rate_limit_error"}',
    'API Error: 500 Internal Server Error',
    'API Error: 400 Bad Request',
    // A prompt or tool output quoting the word must not log the user out.
    'The endpoint returns unauthorized for anonymous callers — add a test.',
    'Error: 4011 rows written',
  ];
  for (const message of negatives) {
    assert.equal(isAuthFailureMessage(message), false, message);
  }
});

const LIVE_AUTH: StoredAuth = {
  version: 1,
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: Date.now() + 60 * 60_000,
  scopes: [],
};

function makeManager(initial: StoredAuth | null) {
  let saved = initial;
  const store = {
    loadAuth: () => saved,
    saveAuth: (auth: StoredAuth) => {
      saved = auth;
    },
    deleteAuth: () => {
      saved = null;
    },
  } as unknown as Store;

  const manager = new AuthManager(store);
  const changes: AuthStatus[] = [];
  let refreshes = 0;
  manager.onChange = (status) => changes.push(status);
  manager.onRefresh = () => refreshes++;
  return { manager, changes, refreshCount: () => refreshes, stored: () => saved };
}

/** Swap global fetch for the duration of one test; returns the call count. */
function stubFetch(t: { after: (fn: () => void) => void }, respond: () => Response) {
  const original = globalThis.fetch;
  const calls = { count: 0 };
  globalThis.fetch = (async () => {
    calls.count++;
    return respond();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const okToken = () =>
  new Response(
    JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

test('handleTokenRejected is a no-op when logged out', async (t) => {
  const calls = stubFetch(t, okToken);
  const { manager, changes } = makeManager(null);

  await manager.handleTokenRejected();

  assert.equal(calls.count, 0);
  assert.deepEqual(changes, []);
});

test('handleTokenRejected recovers silently when the refresh token still works', async (t) => {
  const calls = stubFetch(t, okToken);
  const { manager, changes, refreshCount, stored } = makeManager({ ...LIVE_AUTH });

  await manager.handleTokenRejected();

  assert.equal(calls.count, 1);
  assert.equal(manager.isLoggedIn(), true);
  assert.equal(stored()?.accessToken, 'new-access');
  assert.equal(refreshCount(), 1);
  // No logout, so no authStatus broadcast and no login modal.
  assert.deepEqual(changes, []);
});

test('handleTokenRejected logs out on invalid_grant, which opens the login modal', async (t) => {
  const calls = stubFetch(t, () => new Response('{"error":"invalid_grant"}', { status: 400 }));
  const { manager, changes, stored } = makeManager({ ...LIVE_AUTH });

  await manager.handleTokenRejected();

  assert.equal(calls.count, 1);
  assert.equal(manager.isLoggedIn(), false);
  assert.equal(stored(), null);
  assert.deepEqual(changes, [{ loggedIn: false } satisfies AuthStatus]);
});

test('concurrent rejections share one refresh', async (t) => {
  const calls = stubFetch(t, okToken);
  const { manager } = makeManager({ ...LIVE_AUTH });

  await Promise.all([
    manager.handleTokenRejected(),
    manager.handleTokenRejected(),
    manager.handleTokenRejected(),
  ]);

  assert.equal(calls.count, 1);
});
