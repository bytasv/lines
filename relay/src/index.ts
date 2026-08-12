/**
 * Relay: pairs a browser with the user's own machine.
 *
 * The bridge dials OUT to `/agent`, so the user's machine needs no inbound port
 * and no firewall or NAT setup. The browser connects to `/client`, and the relay
 * pipes frames between them.
 *
 * It is deliberately dumb. It never parses an app message, never persists a
 * payload, and never logs one — see protocol.ts on why the payload stays opaque.
 * Anything that needs to understand a Lines message belongs in the bridge.
 */
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

import { verifyToken } from '@clerk/backend';
import { WebSocketServer, type WebSocket } from 'ws';
import { HubRegistry, type Sink } from './mux.ts';
import {
  RELAY_PROTOCOL_VERSION,
  decode,
  encode,
  type AgentToRelay,
  type LinkClass,
} from './protocol.ts';

const PORT = Number(process.env.RELAY_PORT ?? 8791);
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

/**
 * Dev escape hatch. With auth off every connection binds to a fixed user and any
 * device secret is accepted, which is what lets Phase 2 run against a loopback
 * relay before the Device table exists. Never set this in a deployment.
 */
const AUTH_DISABLED = process.env.RELAY_AUTH_DISABLED === '1';
const STORAGE_URL = process.env.STORAGE_URL ?? 'http://localhost:8790';
/** Presented to storage on /v1/devices/verify, which has no user token to check. */
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET;
const DEV_USER = 'local';

/**
 * Keepalive for the /agent link, and why it has to exist.
 *
 * After a laptop sleep, a Wi-Fi change or a NAT rebind the TCP connection is
 * half-open: both ends still report OPEN, so `hub.online` stays true, so a
 * browser gets a channel wired to a dead bridge and its `hello` never arrives —
 * an indefinite spinner with no way out. Nothing else in the system can notice
 * that; only silence on this socket can.
 *
 * Env-overridable so tests can compress them: they drive real `ws` sockets, and
 * mixing those with node's mock timers corrupts the timer list.
 */
const AGENT_PING_MS = Number(process.env.RELAY_AGENT_PING_MS ?? 20_000);
/** ~2 missed pings. Generous on purpose: reaping a healthy-but-busy bridge drops every open channel. */
const AGENT_DEAD_MS = Number(process.env.RELAY_AGENT_DEAD_MS ?? 55_000);
/** How often an already-attached device's claim is re-checked against storage. */
const REVERIFY_MS = Number(process.env.RELAY_REVERIFY_MS ?? 300_000);

if (!AUTH_DISABLED && !CLERK_SECRET_KEY) {
  console.error('[relay] CLERK_SECRET_KEY is required unless RELAY_AUTH_DISABLED=1');
  process.exit(1);
}

const hubs = new HubRegistry();
setInterval(() => hubs.sweep(), 60_000).unref();

/** Verify a Clerk session token; returns the user id or null. */
async function verifyClerkUserId(token: string): Promise<string | null> {
  if (AUTH_DISABLED) return DEV_USER;
  try {
    const claims = await verifyToken(token, { secretKey: CLERK_SECRET_KEY! });
    return claims.sub ?? null;
  } catch {
    return null;
  }
}

/** Refused by storage, versus storage could not be asked. Never conflate the two. */
type DeviceVerification = { userId: string } | 'unauthorized' | 'unreachable';

/**
 * Resolve which device a bridge is claiming, by asking storage to check the
 * secret against the stored hash.
 *
 * The relay deliberately holds no database credentials: it is the most exposed
 * process in the system, and a compromise of it should not also be a compromise
 * of Postgres. Storage owns the check and answers with the owning userId only.
 *
 * The three-way result matters: "storage refused this device" and "storage could
 * not be asked" look the same to an attaching bridge (both fail closed) but must
 * never look the same to the re-verify tick below, which tears live sessions down.
 */
async function verifyDevice(deviceId: string, secret: string | null): Promise<DeviceVerification> {
  if (AUTH_DISABLED) return { userId: DEV_USER };
  if (!secret) return 'unauthorized';
  try {
    const res = await fetch(`${STORAGE_URL}/v1/devices/verify`, {
      method: 'POST',
      // Storage has no user token to check on this call, so the shared secret is
      // what distinguishes the relay from anyone else who can reach that route.
      headers: {
        'content-type': 'application/json',
        ...(RELAY_SHARED_SECRET ? { 'x-relay-secret': RELAY_SHARED_SECRET } : {}),
      },
      body: JSON.stringify({ id: deviceId, secret }),
      signal: AbortSignal.timeout(10_000),
    });
    // 403 is storage's single answer for unknown, revoked and wrong-secret — the
    // only reply that means the device itself is refused. A 401 (bad relay
    // secret) or 503 (verification not configured) is our misconfiguration, and a
    // 5xx is an outage: none of them says anything about this device.
    if (res.status === 403) return 'unauthorized';
    if (!res.ok) return 'unreachable';
    const { userId } = (await res.json()) as { userId?: string };
    return userId ? { userId } : 'unauthorized';
  } catch (err) {
    // Storage unreachable: callers still fail closed on attach. A relay that
    // admits unverified devices during an outage is worse than one that is
    // briefly down.
    console.warn('[relay] device verification failed:', (err as Error).message);
    return 'unreachable';
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, version: RELAY_PROTOCOL_VERSION, devices: hubs.size }));
});

const wss = new WebSocketServer({ server });
wss.on('error', (err) => console.warn('[wss]', (err as Error).message));

const sinkFor = (ws: WebSocket): Sink => ({
  send: (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  },
  close: (code, reason) => ws.close(code, reason),
});

wss.on('connection', (ws, req) => {
  // A per-socket 'error' listener is mandatory: unhandled, it throws and takes
  // the relay down. Over the public internet these are routine.
  ws.on('error', (err) => console.warn('[ws] socket error:', err.message));
  void route(ws, req);
});

async function route(ws: WebSocket, req: http.IncomingMessage) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const deviceId = url.searchParams.get('device');
  if (!deviceId) {
    ws.close(1008, 'device required');
    return;
  }
  if (url.pathname === '/agent') return handleAgent(ws, url, deviceId);
  if (url.pathname === '/client') return handleClient(ws, url, deviceId);
  ws.close(1008, 'unknown endpoint');
}

async function handleAgent(ws: WebSocket, url: URL, deviceId: string) {
  const secret = url.searchParams.get('secret');
  const device = await verifyDevice(deviceId, secret);
  // Fail closed on a refusal *and* on an outage: an outage must never widen access.
  if (typeof device === 'string') {
    ws.close(1008, 'unauthorized');
    return;
  }
  const hub = hubs.get(deviceId);
  hub.ownerId = device.userId;
  const sink = sinkFor(ws);
  hub.attachAgent(sink);
  console.log(`[relay] agent attached for device ${deviceId}`);

  /** Any inbound frame proves the socket is alive; silence is what we act on. */
  let lastSeen = Date.now();
  /** Milliseconds of ping ticks since the last storage re-check. */
  let sinceVerify = 0;

  /**
   * Re-check the claim of a device that is already attached, so revoking one in
   * the web app stops it serving within REVERIFY_MS rather than only at its next
   * reconnect.
   *
   * Deliberately asymmetric with attach: only an explicit refusal drops a live
   * device. Treating 'unreachable' as a refusal here would turn a storage blip
   * into every user being kicked off their own machine.
   */
  async function reverify(): Promise<void> {
    if ((await verifyDevice(deviceId, secret)) !== 'unauthorized') return;
    console.warn(`[relay] device ${deviceId} is no longer authorized — dropping its hub`);
    hubs.drop(deviceId, 'revoked');
    if (ws.readyState === ws.OPEN) ws.close(1008, 'revoked');
  }

  const health = setInterval(() => {
    if (Date.now() - lastSeen > AGENT_DEAD_MS) {
      console.warn(`[relay] agent for device ${deviceId} silent for >${AGENT_DEAD_MS}ms — terminating`);
      // terminate, not close: a close handshake on a half-open socket waits for a
      // reply from a peer that is gone, which is the very state being cleared.
      // The 'close' handler below then detaches the agent, which is what makes
      // hub.online false and gets `deviceOffline` to the browser.
      ws.terminate();
      return;
    }
    if (ws.readyState === ws.OPEN) ws.send(encode({ t: 'ping' }));
    sinceVerify += AGENT_PING_MS;
    if (sinceVerify >= REVERIFY_MS) {
      sinceVerify = 0;
      void reverify();
    }
  }, AGENT_PING_MS);
  health.unref();

  ws.on('message', (raw) => {
    lastSeen = Date.now();
    const frame = decode<AgentToRelay>(raw);
    if (!frame) return;
    // Liveness only — already accounted for above. `fromAgent` ignores it, but
    // being explicit keeps that from being load-bearing.
    if (frame.t === 'pong') return;
    if (frame.t === 'hello') {
      if (frame.version !== RELAY_PROTOCOL_VERSION) {
        console.warn(`[relay] agent speaks relay v${frame.version}, relay is v${RELAY_PROTOCOL_VERSION}`);
      }
      return;
    }
    // Forwarded synchronously — an await here would let two frames race and
    // reorder a stream.
    hub.fromAgent(frame);
  });
  ws.on('close', () => {
    clearInterval(health);
    hub.detachAgent(sink);
    console.log(`[relay] agent detached for device ${deviceId}`);
  });
}

async function handleClient(ws: WebSocket, url: URL, deviceId: string) {
  const token = url.searchParams.get('token');
  const userId = token ? await verifyClerkUserId(token) : AUTH_DISABLED ? DEV_USER : null;
  if (!userId) {
    ws.close(1008, 'unauthorized');
    return;
  }
  const cls: LinkClass = url.searchParams.get('class') === 'bulk' ? 'bulk' : 'ctrl';
  const hub = hubs.get(deviceId);
  // Without this, any signed-in user who learns a device id could reach someone
  // else's machine — the single most damaging thing this service could get wrong.
  if (!AUTH_DISABLED && hub.ownerId !== userId) {
    ws.close(1008, 'unauthorized');
    return;
  }
  const ch = hub.openChannel(userId, cls, sinkFor(ws), token);

  ws.on('message', (raw) => hub.fromClient(ch, String(raw)));
  ws.on('close', () => hub.closeChannel(ch));
}

server.listen(PORT, () => {
  // The bound port, not PORT: with RELAY_PORT=0 the OS picks one, and callers
  // (tests, a supervisor) read it from this line.
  const { port } = server.address() as { port: number };
  console.log(`lines relay listening on http://localhost:${port}`);
});

function shutdown() {
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
