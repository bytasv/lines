import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { authorizeClient, reauthorizeGuests, type ClientAuthorization } from './authorize.ts';
import { HubRegistry, type Sink } from './mux.ts';
import type { AttestedGrant } from './protocol.ts';

/**
 * The /client gate for a browser that does not own the machine, and the sweep
 * that keeps re-asking while it stays connected.
 *
 * A regression here is one signed-in user reaching another's computer, so the
 * cases that matter are the ones where storage does *not* say a clean yes. None
 * of them may come back as a grant — an outage, a proxy's HTML error page, a body
 * that claims `allowed` without saying by whom. Which kind of not-a-yes each one
 * is matters too: the gate refuses both, but the sweep closes a live guest's
 * channel only on storage's no, never on its silence.
 *
 * The socket half below runs a real relay with auth ON to prove the gate refuses
 * an unauthenticated or junk-token client. It cannot prove the *allow* path: that
 * needs a Clerk-signed token, which a test has no way to mint — that path is
 * covered by storage's own grant tests plus the manual two-account run.
 */

const RELAY_DIR = path.resolve(import.meta.dirname, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const servers: http.Server[] = [];
const spawned: ChildProcess[] = [];

after(async () => {
  for (const child of spawned) child.kill('SIGKILL');
  for (const server of servers) server.close();
  await sleep(100);
});

/** Storage, stubbed, answering /v1/devices/authorize however this test needs. */
async function stubStorage(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; calls: () => number }> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, calls: () => calls };
}

const json = (status: number, body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const ask = (url: string) =>
  authorizeClient({ storageUrl: url, sharedSecret: 'shared', timeoutMs: 2000 }, 'd1', 'guest-user');

describe('authorizeClient', () => {
  test('a machine grant is carried through with its caps', async () => {
    const { url } = await stubStorage(
      json(200, {
        allowed: true,
        ownerId: 'host-user',
        scope: 'machine',
        caps: { prompt: true, readFiles: true },
        profile: { userId: 'host-user', email: 'a@b.c', name: 'Host', imageUrl: null },
      }),
    );
    const grant = await ask(url);
    assert.ok(grant && grant !== 'unreachable', 'a grant');
    assert.equal(grant.hostUserId, 'host-user');
    assert.equal(grant.scope, 'machine');
    assert.equal(grant.caps?.prompt, true);
  });

  test('a session grant carries exactly its session ids', async () => {
    const { url } = await stubStorage(
      json(200, { allowed: true, ownerId: 'host-user', scope: 'session', sessionIds: ['s1', 's2'] }),
    );
    const grant = await ask(url);
    assert.ok(grant && grant !== 'unreachable', 'a grant');
    assert.deepEqual(grant.sessionIds, ['s1', 's2']);
  });

  test('an explicit denial denies', async () => {
    const { url } = await stubStorage(json(200, { allowed: false }));
    assert.equal(await ask(url), null);
  });

  // The next five are no answer at all, not a no. The gate refuses them just the
  // same — an initial grant is not a link worth protecting — but the sweep must
  // not read one as a revoke.
  test('a storage outage is no answer', async () => {
    const { url } = await stubStorage(json(500, { error: 'boom' }));
    assert.equal(await ask(url), 'unreachable');
  });

  test('a 401 from a wrong relay secret is no answer either', async () => {
    // The relay and storage disagree about the shared secret: a misconfiguration,
    // which says nothing about this user.
    const { url } = await stubStorage(json(401, { error: 'unauthenticated' }));
    assert.equal(await ask(url), 'unreachable');
  });

  test('an unreachable storage is no answer', async () => {
    // Nothing is listening on this port; the fetch rejects.
    assert.equal(
      await authorizeClient(
        { storageUrl: 'http://127.0.0.1:1', sharedSecret: 'shared', timeoutMs: 1000 },
        'd1',
        'guest-user',
      ),
      'unreachable',
    );
  });

  test('a storage that never answers is no answer', async () => {
    // Holds the request open past the timeout: the hang, not the refusal.
    const { url } = await stubStorage(() => {});
    assert.equal(
      await authorizeClient({ storageUrl: url, sharedSecret: 'shared', timeoutMs: 200 }, 'd1', 'guest-user'),
      'unreachable',
    );
  });

  test('a non-JSON body is no answer, and does not throw', async () => {
    // What a proxy in front of storage returns on a bad day.
    const { url } = await stubStorage((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>502 Bad Gateway</html>');
    });
    assert.equal(await ask(url), 'unreachable');
  });

  test('allowed without an owner denies', async () => {
    const { url } = await stubStorage(json(200, { allowed: true, scope: 'machine' }));
    assert.equal(await ask(url), null);
  });

  test('a truthy-but-not-true allowed denies', async () => {
    // `allowed: 'yes'` must not pass. The check is `!== true` for exactly this.
    const { url } = await stubStorage(json(200, { allowed: 'yes', ownerId: 'host', scope: 'machine' }));
    assert.equal(await ask(url), null);
  });

  test('an owner-scoped answer for a non-owner denies', async () => {
    // The caller already took the fast path for the machine's own user, so this
    // is a contradiction — and 'owner' carries every capability.
    const { url } = await stubStorage(json(200, { allowed: true, ownerId: 'host', scope: 'owner' }));
    assert.equal(await ask(url), null);
  });

  test('a session grant with no sessions denies', async () => {
    const { url } = await stubStorage(
      json(200, { allowed: true, ownerId: 'host', scope: 'session', sessionIds: [] }),
    );
    assert.equal(await ask(url), null);
  });

  test('without a relay secret nothing is asked and nothing is granted', async () => {
    const stub = await stubStorage(json(200, { allowed: true, ownerId: 'host', scope: 'machine' }));
    const grant = await authorizeClient(
      { storageUrl: stub.url, sharedSecret: undefined, timeoutMs: 2000 },
      'd1',
      'guest-user',
    );
    assert.equal(grant, null);
    assert.equal(stub.calls(), 0, 'storage must not even be asked');
  });
});

// ---------------------------------------------------------------------------
// The re-authorization sweep
// ---------------------------------------------------------------------------

const HELD: AttestedGrant = { hostUserId: 'host-user', scope: 'machine', caps: { prompt: true } };

/** A hub with one live guest channel opened under HELD, and how its browser was closed. */
function guestOnline() {
  const hubs = new HubRegistry();
  const hub = hubs.get('d1');
  hub.ownerId = 'host-user';
  hub.attachAgent({ send: () => {}, close: () => {} });
  let closed: { code?: number; reason?: string } | null = null;
  const browser: Sink = {
    send: () => {},
    close: (code, reason) => {
      closed = { code, reason };
    },
  };
  hub.openChannel('guest-user', 'ctrl', browser, null, HELD);
  return { hubs, hub, closed: () => closed as { code?: number; reason?: string } | null };
}

/** One sweep, asking `url` the way the relay asks storage. */
const sweepAgainst = (url: string, hubs: HubRegistry) =>
  reauthorizeGuests(hubs, (deviceId, userId) =>
    authorizeClient({ storageUrl: url, sharedSecret: 'shared', timeoutMs: 2000 }, deviceId, userId),
  );

describe('the re-authorization sweep', () => {
  test('a storage outage leaves every guest connected', async () => {
    // The bug this guards: an outage used to come back exactly like a denial, so
    // a single blip closed every guest channel on the relay.
    const down = await stubStorage(json(503, { error: 'unavailable' }));
    const guest = guestOnline();
    await sweepAgainst(down.url, guest.hubs);
    await sweepAgainst('http://127.0.0.1:1', guest.hubs);
    assert.equal(guest.hub.guestChannels().length, 1);
    assert.equal(guest.closed(), null);
  });

  test('a lookup that throws counts as no answer too', async () => {
    const guest = guestOnline();
    const failing = (): Promise<ClientAuthorization> => Promise.reject(new Error('boom'));
    await reauthorizeGuests(guest.hubs, failing);
    assert.equal(guest.hub.guestChannels().length, 1);
  });

  test("storage's no closes the channel", async () => {
    const { url } = await stubStorage(json(200, { allowed: false }));
    const guest = guestOnline();
    await sweepAgainst(url, guest.hubs);
    assert.equal(guest.hub.guestChannels().length, 0);
    // 1008, so the browser goes back through the gate instead of redialling into
    // a channel the bridge would build from a grant that no longer exists.
    assert.deepEqual(guest.closed(), { code: 1008, reason: 'grant changed' });
  });

  test('a narrowed grant closes the channel, and an unchanged one is left alone', async () => {
    const same = await stubStorage(
      json(200, { allowed: true, ownerId: 'host-user', scope: 'machine', caps: { prompt: true } }),
    );
    const narrowed = await stubStorage(json(200, { allowed: true, ownerId: 'host-user', scope: 'machine', caps: {} }));
    const guest = guestOnline();
    await sweepAgainst(same.url, guest.hubs);
    assert.equal(guest.closed(), null, 'the same grant again changes nothing');
    await sweepAgainst(narrowed.url, guest.hubs);
    assert.equal(guest.closed()?.code, 1008);
  });
});

// ---------------------------------------------------------------------------
// The gate on a real socket
// ---------------------------------------------------------------------------

async function startRelay(env: Record<string, string>): Promise<number> {
  const relay = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: RELAY_DIR,
    env: { ...process.env, RELAY_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  spawned.push(relay);
  let out = '';
  relay.stdout!.on('data', (c) => (out += String(c)));
  const deadline = Date.now() + 10_000;
  for (;;) {
    const match = /listening on http:\/\/localhost:(\d+)/.exec(out);
    if (match) return Number(match[1]);
    if (Date.now() > deadline) throw new Error('relay did not start');
    await sleep(20);
  }
}

/** Resolves with the close code the relay answered with. */
function clientCloseCode(port: number, query: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/client?device=d-gate${query}`);
    ws.on('close', (code: number) => resolve(code));
    ws.on('error', () => {
      /* a close follows */
    });
    setTimeout(() => reject(new Error('no close within 8s')), 8000).unref();
  });
}

describe('the /client gate with auth on', () => {
  test('a browser with no token, or a junk one, is refused', async () => {
    const port = await startRelay({
      // Explicitly empty, not absent: a repo-root .env with the dev escape hatch
      // on would make this pass vacuously.
      RELAY_AUTH_DISABLED: '',
      CLERK_SECRET_KEY: 'sk_test_invalid_on_purpose',
      RELAY_SHARED_SECRET: 'shared',
    });
    assert.equal(await clientCloseCode(port, ''), 1008, 'no token must be refused');
    assert.equal(await clientCloseCode(port, '&token=not-a-jwt'), 1008, 'a junk token must be refused');

    // Both refusals are in the device's history, with their reason, and only
    // behind the secret — the public health shape must not grow device ids.
    const health = async (secret?: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: secret ? { 'x-relay-secret': secret } : {} });
      return (await res.json()) as { events?: Record<string, { kind: string; detail?: { reason?: string } }[]> };
    };
    assert.equal((await health()).events, undefined, 'events are secret-gated');
    const refusals = ((await health('shared')).events?.['d-gate'] ?? []).filter((e) => e.kind === 'client-refused');
    assert.deepEqual(
      refusals.map((e) => e.detail?.reason),
      ['no-token', 'bad-token'],
    );
  });
});
