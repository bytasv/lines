import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyncLogEntry } from '@lines/shared';
import { StorageSyncClient, THROTTLED } from './sync.ts';
import { signBlob, verifyBlob, type SignerStore, type SigningIdentity } from './syncSignature.ts';

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

/**
 * Signed paths await key generation + signing before fetch; the first push in a
 * cold process generates the signing key, which can outlast a fixed short wait.
 */
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await flush(10);
}

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
  await until(() => sent.length >= 2);

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

/**
 * MCP connections are the one synced shape whose *purpose* involves a
 * credential: a stdio server's env and an HTTP server's headers are where its
 * API key goes. Names may travel; values never do. Env values used to — the
 * whole connection, `env` included, went to Postgres — so these pin the
 * boundary itself rather than trusting `McpConnections.blob()` to stay clean.
 */

const ENV_CANARY = 'sk-env-CANARY';
const HEADER_CANARY = 'sk-header-CANARY';

/** In-memory signer pins, so these checks never write a counter under `~/.lines-app`. */
function memorySigners(): SignerStore {
  const map = new Map<string, { key: string; counter: number }>();
  return {
    get: (resource) => map.get(resource),
    set: (resource, record) => void map.set(resource, record),
  };
}

async function signingKey(): Promise<SigningIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as { privateKey: unknown; publicKey: Parameters<typeof crypto.subtle.exportKey>[1] };
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: Buffer.from(raw).toString('base64'), privateKey: pair.privateKey };
}

/** Answer every request with `bodyFor(url)`, as a storage server would per route. */
function serveFetch(t: { after: (fn: () => void) => void }, bodyFor: (url: string) => unknown): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    new Response(JSON.stringify(bodyFor(String(url)) ?? null), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

/** A stdio row the way a bridge that predates names-only sync wrote it: value inline. */
const LEGACY_MCP_ROW = {
  connections: [
    { id: 'c1', name: 'local', transport: 'stdio', command: 'npx', env: { API_KEY: ENV_CANARY }, enabled: true },
  ],
  updatedAt: 1,
};

test('MCP connections leave with credential names only, signed as sent', async (t) => {
  const sent = captureFetch(t);
  const sync = new StorageSyncClient('https://storage.test', () => CLERK_TOKEN, undefined, undefined, undefined, {
    signers: memorySigners(),
  });

  // Planted rather than produced — blob() carries names only, so this proves the
  // push strips whatever a caller hands it.
  sync.pushMcpConnections({
    connections: [
      {
        id: 'c1',
        name: 'local',
        transport: 'stdio',
        command: 'npx',
        envKeys: ['REGION'],
        env: { API_KEY: ENV_CANARY },
        enabled: true,
      },
      {
        id: 'c2',
        name: 'figma',
        transport: 'http',
        url: 'https://mcp.figma.com/mcp',
        headerKeys: ['Authorization'],
        headers: { Authorization: `Bearer ${HEADER_CANARY}` },
        enabled: true,
      },
    ],
    updatedAt: 1,
  } as never);
  await until(() => sent.some((r) => r.url.endsWith('/mcp-connections')), 5_000);

  const req = sent.find((r) => r.url.endsWith('/mcp-connections'));
  assert.ok(req, 'the push must have landed, or this test proves nothing');
  const leaked = allStrings(req.body).filter((s) => s.includes(ENV_CANARY) || s.includes(HEADER_CANARY));
  assert.deepEqual(leaked, [], 'a credential value left the bridge');
  assert.deepEqual(allKeys(req.body).filter((k) => k === 'env' || k === 'headers'), []);
  // Names survive, so the other side still knows what each server needs.
  const body = req.body as { connections: { envKeys?: string[]; headerKeys?: string[] }[] };
  assert.deepEqual(body.connections[0].envKeys, ['REGION', 'API_KEY']);
  assert.deepEqual(body.connections[1].headerKeys, ['Authorization']);
  // Stripped *before* signing: the signature covers exactly these bytes, so a
  // storage server that keeps them as sent keeps them verifiable.
  assert.equal((await verifyBlob('/mcp-connections', req.body, memorySigners())).ok, true);
});

test('a verified MCP row still carrying env values hands this machine names only', async (t) => {
  // Validly signed with the value inside: a bridge that predates names-only sync,
  // read back through a storage server that predates the route filter.
  const signed = await signBlob(LEGACY_MCP_ROW, await signingKey(), memorySigners());
  serveFetch(t, (url) => (url.endsWith('/mcp-connections') ? signed : []));
  const sync = new StorageSyncClient('https://storage.test', () => CLERK_TOKEN, undefined, undefined, undefined, {
    signers: memorySigners(),
  });

  const pulled = await sync.pullAll();

  assert.ok(pulled && pulled !== THROTTLED);
  assert.ok(pulled.mcpConnections, 'a row that verifies still applies');
  assert.equal(JSON.stringify(pulled.mcpConnections).includes(ENV_CANARY), false);
  assert.deepEqual(pulled.mcpConnections.connections[0].envKeys, ['API_KEY']);
});

test('a legacy MCP row with its values scrubbed is refused, so the push replaces it', async (t) => {
  // The migration and storage's read filter take the value out from under the
  // signature that covered it. That has to read as a refusal — null, the same as
  // an empty cloud — which `syncNow` answers by pushing this machine's own
  // names-only copy, signed, over the row.
  const signed = await signBlob(LEGACY_MCP_ROW, await signingKey(), memorySigners());
  const { env: _env, ...scrubbed } = signed.connections[0];
  const served = { ...signed, connections: [{ ...scrubbed, envKeys: ['API_KEY'] }] };
  serveFetch(t, (url) => (url.endsWith('/mcp-connections') ? served : []));
  const rows: SyncLogEntry[] = [];
  const sync = new StorageSyncClient(
    'https://storage.test',
    () => CLERK_TOKEN,
    undefined,
    undefined,
    (row) => rows.push(row),
    { signers: memorySigners() },
  );

  const pulled = await sync.pullAll();

  assert.ok(pulled && pulled !== THROTTLED, 'one refused resource must not abort the pull');
  assert.equal(pulled.mcpConnections, null);
  assert.ok(
    rows.some((r) => r.path === '/mcp-connections' && /signature forged — refused/.test(String(r.reason))),
    'the refusal is logged where a user can see why the row stopped applying',
  );
});

test('sync is inert without a token, so nothing leaves on a logged-out bridge', async (t) => {
  const sent = captureFetch(t);
  const sync = new StorageSyncClient('https://storage.test', () => null);

  assert.equal(sync.enabled, false);
  sync.pushSettings({ theme: 'dark' });
  await flush();
  assert.deepEqual(sent, [], 'a bridge with no Clerk token must not talk to storage at all');
});
