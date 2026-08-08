import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthManager } from './auth.ts';
import type { Store } from './store.ts';
import type { StoredAuth } from './store.ts';

/**
 * Two logins can be in flight at once — two browser tabs today, two paired
 * devices once the app is hosted. Each needs its own PKCE verifier kept until
 * its own paste arrives.
 */

function makeManager() {
  let saved: StoredAuth | null = null;
  const store = {
    loadAuth: () => saved,
    saveAuth: (auth: StoredAuth) => {
      saved = auth;
    },
    deleteAuth: () => {
      saved = null;
    },
  } as unknown as Store;
  return new AuthManager(store);
}

const stateOf = (authorizeUrl: string) =>
  new URL(authorizeUrl).searchParams.get('state') as string;

const verifierOf = (authorizeUrl: string) =>
  new URL(authorizeUrl).searchParams.get('code_challenge') as string;

/** Capture the token-exchange body so we can see which verifier was used. */
function stubFetch(t: { after: (fn: () => void) => void }) {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      { status: 200 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return bodies;
}

test('two overlapping logins each keep their own verifier', async (t) => {
  const manager = makeManager();
  const bodies = stubFetch(t);

  const first = manager.startLogin().authorizeUrl;
  const second = manager.startLogin().authorizeUrl;
  const firstState = stateOf(first);

  assert.notEqual(firstState, stateOf(second), 'each login gets its own state');
  assert.notEqual(verifierOf(first), verifierOf(second), 'and its own verifier');

  // The *first* tab's paste arrives after the second login started. A single
  // pending slot would have thrown 'State mismatch' here.
  await manager.completeLogin(`code-1#${firstState}`);

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].code, 'code-1');
  assert.equal(bodies[0].state, firstState, 'exchanged against the first login');
  assert.equal(manager.isLoggedIn(), true);
});

test('a paste with an unknown state is rejected', async (t) => {
  const manager = makeManager();
  stubFetch(t);

  manager.startLogin();
  await assert.rejects(
    () => manager.completeLogin('code-1#not-a-real-state'),
    /State mismatch/,
  );
});

test('a paste with no state falls back to the newest login', async (t) => {
  const manager = makeManager();
  const bodies = stubFetch(t);

  manager.startLogin();
  const newest = stateOf(manager.startLogin().authorizeUrl);

  // Older paste format, no `#state` — the single-slot behaviour it replaced.
  await manager.completeLogin('code-only');

  assert.equal(bodies[0].state, newest);
});

test('completing one login clears the others', async (t) => {
  const manager = makeManager();
  stubFetch(t);

  const first = stateOf(manager.startLogin().authorizeUrl);
  manager.startLogin();

  await manager.completeLogin(`code-1#${first}`);

  // Signed in already; the abandoned attempt must not still be completable.
  await assert.rejects(() => manager.completeLogin('code-2'), /No login in progress/);
});

test('completeLogin with nothing pending explains itself', async (t) => {
  const manager = makeManager();
  stubFetch(t);
  await assert.rejects(() => manager.completeLogin('code-1'), /No login in progress/);
});
