import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StorageSyncClient } from './sync.ts';

/**
 * Storage sync is the bridge's *second* outbound cloud path, independent of the
 * relay: `StorageSyncClient` talks straight to STORAGE_URL. The schema test
 * proves Postgres has nowhere to put a credential; this proves the bridge never
 * tries to send one in the first place — including inside an opaque `data` blob,
 * where a schema check would never see it.
 */

/** Anything that smells like a secret, whatever nesting it hides in. */
const SUSPICIOUS = /token|secret|credential|password|apikey|api_key|refresh|accesskey|private_key/i;

/** Every string key anywhere in a payload, however deeply nested. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

/** Every string value anywhere in a payload. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) allStrings(v, out);
  return out;
}

interface Sent {
  url: string;
  body: unknown;
  authorization: string | undefined;
}

/** Capture everything the client would put on the wire. */
function captureFetch(t: { after: (fn: () => void) => void }): Sent[] {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init.headers).get('authorization') ?? undefined,
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

/**
 * Session pushes are debounced (PUSH_DEBOUNCE_MS, 2s) and batched into one
 * request, so a short wait silently observes nothing at all — which is exactly
 * what the planted-credential test below exists to catch.
 */
const DEBOUNCE_WAIT_MS = 2_200;
const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/** A token that would be unmistakable if it ever leaked into a payload. */
const CLERK_TOKEN = 'clerk-session-token-CANARY';
/** Shaped like a real Claude OAuth token, to catch a value-level leak. */
const OAUTH_CANARY = 'sk-ant-oat01-CANARY';

function client(sent: Sent[]) {
  void sent;
  return new StorageSyncClient('https://storage.test', () => CLERK_TOKEN);
}

test('every push carries the Clerk token as a header, never in the body', async (t) => {
  const sent = captureFetch(t);
  const sync = client(sent);

  // The undebounced pushes: these hit the wire synchronously.
  sync.pushSettings({ theme: 'dark' });
  sync.pushGuardAllowlist({ entries: [], updatedAt: 1 } as never);
  await flush();

  assert.ok(sent.length >= 2, 'expected the undebounced pushes to fire');
  for (const req of sent) {
    assert.equal(req.authorization, `Bearer ${CLERK_TOKEN}`, 'auth belongs in the header');
    const strings = allStrings(req.body);
    assert.ok(
      !strings.includes(CLERK_TOKEN),
      `${req.url} put the session token in its body`,
    );
  }
});

test('no push payload has a credential-shaped key', async (t) => {
  const sent = captureFetch(t);
  const sync = client(sent);

  // A session carries the widest, least-controlled shape of the lot.
  sync.pushSession({ id: 's1', cwd: '/tmp', name: 'x' } as never);
  sync.pushSettings({ theme: 'dark' });
  sync.pushGuardAllowlist({ entries: [], updatedAt: 1 } as never);
  await flush(DEBOUNCE_WAIT_MS);

  assert.ok(
    sent.some((r) => r.url.endsWith('/sessions')),
    'the debounced session push must have landed, or this test proves nothing',
  );
  for (const req of sent) {
    const offenders = allKeys(req.body).filter((k) => SUSPICIOUS.test(k));
    assert.deepEqual(offenders, [], `${req.url} pushes credential-shaped key(s): ${offenders.join(', ')}`);
  }
});

test('a credential planted in session metadata would be caught', async (t) => {
  const sent = captureFetch(t);
  const sync = client(sent);

  // Not asserting current behaviour — proving the detector actually fires, so a
  // future field that does carry a secret cannot pass this suite silently.
  sync.pushSession({ id: 's1', cwd: '/tmp', accessToken: OAUTH_CANARY } as never);
  await flush(DEBOUNCE_WAIT_MS);

  const offenders = sent.flatMap((r) => allKeys(r.body)).filter((k) => SUSPICIOUS.test(k));
  assert.ok(offenders.length > 0, 'the key detector must fire on a planted credential');
});

test('sync is inert without a token, so nothing leaves on a logged-out bridge', async (t) => {
  const sent = captureFetch(t);
  const sync = new StorageSyncClient('https://storage.test', () => null);

  assert.equal(sync.enabled, false);
  sync.pushSettings({ theme: 'dark' });
  await flush();
  assert.deepEqual(sent, [], 'a bridge with no Clerk token must not talk to storage at all');
});
