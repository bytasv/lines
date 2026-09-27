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
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

import { verifyToken } from '@clerk/backend';
import { WebSocketServer, type WebSocket } from 'ws';
import { authorizeClient as authorizeClientAgainst } from './authorize.ts';
import { HubRegistry, type EventDetail, type Sink } from './mux.ts';
import {
  RELAY_PROTOCOL_VERSION,
  decode,
  encode,
  type AgentToRelay,
  type AttestedGrant,
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
/**
 * How often a *guest* channel's grant is re-authorized. Much shorter than the
 * device re-verify above: revoking a share has to land on a live socket, and the
 * up-to-this-long window is the documented bound on how stale a grant can be.
 */
const GUEST_REAUTH_MS = Number(process.env.RELAY_GUEST_REAUTH_MS ?? 60_000);
/**
 * The lowest bridge app-protocol that may serve a guest.
 *
 * A bridge older than this ignores the `grant` field on the `open` frame — it
 * would happily serve a guest as if they were the owner, since unknown fields
 * are dropped silently. Refusing the connection at the gate is what makes adding
 * those fields safe without a RELAY_PROTOCOL_VERSION bump.
 */
const COLLAB_MIN_PROTOCOL = Number(process.env.RELAY_COLLAB_MIN_PROTOCOL ?? 2);
/**
 * How long a browser waits for a bridge to attach before the /client gate gives
 * up and classifies it against what the relay knows.
 *
 * Only ever paid when no bridge has attached for the device in this process, so
 * a running machine never sees it. Sized against the measured race: a browser
 * reconnects roughly a second before its bridge finishes `verifyDevice`, and
 * losing that race costs the browser a five-second backoff, not another second.
 */
const OWNER_ATTACH_GRACE_MS = Number(process.env.RELAY_OWNER_ATTACH_GRACE_MS ?? 2000);

if (!AUTH_DISABLED && !CLERK_SECRET_KEY) {
  console.error('[relay] CLERK_SECRET_KEY is required unless RELAY_AUTH_DISABLED=1');
  process.exit(1);
}

/** Bound once: the gate and the re-auth sweep must ask storage the same way. */
const authorizeClient = (deviceId: string, userId: string) =>
  authorizeClientAgainst({ storageUrl: STORAGE_URL, sharedSecret: RELAY_SHARED_SECRET }, deviceId, userId);

const hubs = new HubRegistry();

/**
 * Log a relay decision about one device and keep it in that device's event
 * history (secret-gated `GET /`). Every refusal goes through here: before, a
 * browser refused at the gate left no trace at all.
 */
function note(deviceId: string, kind: string, detail?: EventDetail): void {
  hubs.events.record(deviceId, kind, detail);
  console.log(`[relay] ${deviceId} ${kind}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
}
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

/**
 * Tell storage whether a device's bridge is attached.
 *
 * The relay is the only process that knows this — storage sees a device only when
 * its secret is verified, and a browser sees only the machine it holds a socket
 * to. Without this report a machine you are not connected to has no liveness
 * signal at all, and the web app can only say when it was last seen.
 *
 * Fire and forget, and never awaited on the attach path: presence is a UI hint,
 * and a storage blip must not delay or fail a bridge attaching. Storage gates the
 * flag on `lastSeenAt` freshness, so a report that never lands decays to "unknown"
 * rather than sticking.
 */
function reportPresence(deviceId: string, online: boolean): void {
  // With auth off there is no Device row to report against — the dev relay
  // accepts any secret precisely because storage may not be running.
  if (AUTH_DISABLED || !RELAY_SHARED_SECRET) return;
  void fetch(`${STORAGE_URL}/v1/devices/presence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-secret': RELAY_SHARED_SECRET },
    body: JSON.stringify({ deviceId, online }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      // 404 is expected on the revoke path: the row is tombstoned before its
      // socket finishes closing, and storage refuses to touch a revoked device.
      if (!res.ok && res.status !== 404) {
        console.warn(`[relay] presence report for ${deviceId} answered ${res.status}`);
      }
    })
    .catch((err) => console.warn('[relay] presence report failed:', (err as Error).message));
}

/**
 * Constant-time check of the shared secret on a public endpoint, so the header
 * cannot be guessed byte by byte from response timing. Length is compared first
 * because timingSafeEqual throws on a mismatch — that leak is only the length.
 */
function presentedSecretMatches(presented: string | string[] | undefined): boolean {
  if (!RELAY_SHARED_SECRET || typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(RELAY_SHARED_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Health, plus a triage payload behind the shared secret.
 *
 * The unauthenticated shape is unchanged and must stay that way: device ids are
 * the addresses of users' machines, and this endpoint is public.
 */
const server = http.createServer((req, res) => {
  const authorized = presentedSecretMatches(req.headers['x-relay-secret']);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      version: RELAY_PROTOCOL_VERSION,
      devices: hubs.size,
      ...(authorized ? { hubs: hubs.list(), events: hubs.events.snapshot() } : {}),
    }),
  );
});

const wss = new WebSocketServer({ server });
wss.on('error', (err) => console.warn('[wss]', (err as Error).message));

const sinkFor = (ws: WebSocket): Sink => ({
  send: (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  },
  close: (code, reason) => ws.close(code, reason),
  terminate: () => ws.terminate(),
});

wss.on('connection', (ws, req) => {
  // A per-socket 'error' listener is mandatory: unhandled, it throws and takes
  // the relay down. Over the public internet these are routine.
  ws.on('error', (err) => console.warn('[ws] socket error:', err.message));
  void route(ws, req);
});

/**
 * Hold frames that arrive before a handler can listen for them.
 *
 * Both handlers await a network verification before they wire a 'message'
 * listener, and a peer that speaks immediately on open — the bridge sends
 * `hello` from its own open handler — would have those frames emitted with
 * nothing listening, and dropped. That cost nothing while `hello` was only
 * logged; now the /client gate reads what it carries, so losing it strands the
 * hub at appProtocol=null and refuses every guest against a bridge that is in
 * fact new enough.
 *
 * A queue rather than ws.pause(): a paused socket also stalls the closing
 * handshake, so an early refusal — the whole point of the gate — never reaches
 * the peer. One listener, installed at once and dispatching to a mutable target,
 * is also what keeps a frame that lands mid-handover from overtaking the queued
 * ones.
 */
function deferFrames(ws: WebSocket): (handler: (raw: unknown) => void) => void {
  const queued: unknown[] = [];
  let target: ((raw: unknown) => void) | null = null;
  ws.on('message', (raw) => {
    if (target) target(raw);
    else queued.push(raw);
  });
  return (handler) => {
    target = handler;
    for (const raw of queued.splice(0)) handler(raw);
  };
}

async function route(ws: WebSocket, req: http.IncomingMessage) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const deviceId = url.searchParams.get('device');
  if (!deviceId) {
    console.warn(`[relay] refused ${url.pathname}: no device`);
    ws.close(1008, 'device required');
    return;
  }
  const onFrames = deferFrames(ws);
  if (url.pathname === '/agent') return handleAgent(ws, url, deviceId, onFrames);
  if (url.pathname === '/client') return handleClient(ws, url, deviceId, onFrames);
  note(deviceId, 'refused-endpoint', { path: url.pathname });
  ws.close(1008, 'unknown endpoint');
}

async function handleAgent(
  ws: WebSocket,
  url: URL,
  deviceId: string,
  onFrames: (handler: (raw: unknown) => void) => void,
) {
  const secret = url.searchParams.get('secret');
  const device = await verifyDevice(deviceId, secret);
  // Fail closed on a refusal *and* on an outage: an outage must never widen access.
  if (typeof device === 'string') {
    // 'unreachable' is a storage outage refusing a healthy machine — the case
    // that looks, from the browser, exactly like the machine being asleep.
    note(deviceId, 'agent-refused', { reason: device });
    ws.close(1008, 'unauthorized');
    return;
  }
  const hub = hubs.get(deviceId);
  hub.ownerId = device.userId;
  const sink = sinkFor(ws);
  const superseded = hub.attachAgent(sink);
  if (superseded) {
    // A takeover used to read exactly like a first attach. It is the one thing
    // worth shouting about: two bridges claiming one device is what lets a
    // superseded process keep writing state into live browser channels.
    console.warn(
      `[relay] duplicate agent attach for device ${deviceId} — superseding (attach #${hub.agentAttaches})`,
    );
  } else {
    console.log(`[relay] agent attached for device ${deviceId}`);
  }
  reportPresence(deviceId, true);

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
    // A superseded socket owns nothing: its still-running tick would otherwise
    // drop the hub — and every channel on it — out from under the live bridge.
    if (!hub.isAgent(sink)) return;
    if ((await verifyDevice(deviceId, secret)) !== 'unauthorized') return;
    // Re-checked after the await: the takeover may have happened while we asked.
    if (!hub.isAgent(sink)) return;
    console.warn(`[relay] device ${deviceId} is no longer authorized — dropping its hub`);
    hubs.events.record(deviceId, 'agent-revoked');
    hubs.drop(deviceId, 'revoked');
    if (ws.readyState === ws.OPEN) ws.close(1008, 'revoked');
  }

  const health = setInterval(() => {
    // Superseded: stop pinging and stop re-verifying. The socket has already been
    // closed and terminated by attachAgent; this only stops the bookkeeping.
    if (!hub.isAgent(sink)) {
      clearInterval(health);
      return;
    }
    if (Date.now() - lastSeen > AGENT_DEAD_MS) {
      console.warn(`[relay] agent for device ${deviceId} silent for >${AGENT_DEAD_MS}ms — terminating`);
      hubs.events.record(deviceId, 'agent-silent', { ms: Date.now() - lastSeen });
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

  onFrames((raw) => {
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
      // Recorded, not just logged: the /client gate refuses a guest on a bridge
      // too old to enforce the grant it would be sent. Only the current bridge's
      // hello counts — a superseded one must not raise the hub's capability.
      if (hub.isAgent(sink) && typeof frame.appProtocol === 'number') {
        hub.appProtocol = frame.appProtocol;
      }
      return;
    }
    // Forwarded synchronously — an await here would let two frames race and
    // reorder a stream. The sink goes along so the hub can refuse a frame from a
    // bridge it has already superseded.
    hub.fromAgent(frame, sink);
  });
  ws.on('close', (code: number) => {
    clearInterval(health);
    const current = hub.isAgent(sink);
    hub.detachAgent(sink);
    console.log(`[relay] agent detached for device ${deviceId} (code ${code}${current ? '' : ', superseded'})`);
    // Only when nothing is attached any more. A superseded predecessor closing
    // late must not report the *replacement* bridge offline — the same reason
    // detachAgent itself is a no-op for a socket that is no longer the agent.
    if (!hub.online) reportPresence(deviceId, false);
  });
}

async function handleClient(
  ws: WebSocket,
  url: URL,
  deviceId: string,
  onFrames: (handler: (raw: unknown) => void) => void,
) {
  const token = url.searchParams.get('token');
  const userId = token ? await verifyClerkUserId(token) : AUTH_DISABLED ? DEV_USER : null;
  if (!userId) {
    note(deviceId, 'client-refused', { reason: token ? 'bad-token' : 'no-token' });
    ws.close(1008, 'unauthorized');
    return;
  }
  const cls: LinkClass = url.searchParams.get('class') === 'bulk' ? 'bulk' : 'ctrl';
  const hub = hubs.get(deviceId);

  /**
   * Give the bridge a moment before deciding who this is.
   *
   * `ownerId` is null until a bridge authenticates, and the gate below reads
   * "not the owner" off that null — so a browser that reconnects during a relay
   * restart, a second ahead of its own bridge, is refused `1008` and backs off
   * five seconds. Repeated over a flapping bridge that is the difference between
   * a reload taking one second and taking a minute.
   *
   * Costs nothing once a bridge has attached, and nothing in the no-auth dev
   * path. A machine that is genuinely away pays the grace once per attempt and
   * then gets the same answer it would have got immediately.
   */
  if (!AUTH_DISABLED && hub.ownerId === null) {
    const waitStarted = Date.now();
    const released = await hub.waitForAgent(OWNER_ATTACH_GRACE_MS);
    note(deviceId, 'client-wait', { userId, released, ms: Date.now() - waitStarted });
    // The browser may have given up while we held it.
    if (ws.readyState !== ws.OPEN) {
      note(deviceId, 'client-left-waiting', { userId });
      return;
    }
  }

  /**
   * Owner fast path, byte for byte what it always was: the machine's own user
   * reaches it without storage being consulted at all — no added latency, no new
   * failure surface, and no dependency on the share tables for the common case.
   *
   * Anyone else must hold a grant. Without one of these two, a signed-in user who
   * merely learns a device id reaches someone else's machine — the single most
   * damaging thing this service could get wrong.
   */
  let grant: AttestedGrant | undefined;
  if (!AUTH_DISABLED && hub.ownerId !== userId) {
    // A bridge too old to understand the grant would serve this guest as if they
    // owned the machine, so the version check comes before the grant lookup. It
    // asks only about an *attached* bridge: with the host asleep there is nothing
    // to be too old, and refusing here would give an authorized guest the same
    // `unauthorized` a revoke does instead of the offline state `openChannel`
    // sends. Nothing after this changes — `authorizeClient` still runs for every
    // non-owner, so an unauthorized one is refused identically either way.
    if (hub.guestNeedsNewerBridge(COLLAB_MIN_PROTOCOL)) {
      console.warn(
        `[relay] refusing ${userId} on device ${deviceId} (owner ${hub.ownerId ?? 'unknown'}): ` +
          `bridge speaks app v${hub.appProtocol ?? '?'}, sharing needs v${COLLAB_MIN_PROTOCOL}`,
      );
      hubs.events.record(deviceId, 'client-refused', { reason: 'bridge-too-old', userId });
      ws.close(1008, 'unauthorized');
      return;
    }
    const authorized = await authorizeClient(deviceId, userId);
    if (!authorized || authorized.scope === 'owner') {
      // ownerId null here means no bridge has proven this device since the relay
      // started — the machine's own user is refused as a stranger until it does.
      note(deviceId, 'client-refused', {
        reason: 'not-owner-no-grant',
        userId,
        ownerId: hub.ownerId,
        agentOnline: hub.online,
      });
      ws.close(1008, 'unauthorized');
      return;
    }
    grant = authorized;
  }

  const ch = hub.openChannel(userId, cls, sinkFor(ws), token, grant);
  const openedAt = Date.now();
  console.log(
    `[relay] client ${userId} → device ${deviceId} ${ch}${grant ? ' (guest)' : ''}` +
      `${hub.online ? '' : ' — no agent, sent deviceOffline'}`,
  );

  onFrames((raw) => hub.fromClient(ch, String(raw)));
  ws.on('close', (code: number) => {
    console.log(`[relay] client ${ch} on device ${deviceId} closed ${code} after ${Date.now() - openedAt}ms`);
    hub.closeChannel(ch);
  });
}

/**
 * Re-authorize every live guest channel, and close the ones whose grant is gone
 * or has narrowed.
 *
 * Without this, revoking a share only takes effect at the guest's next reconnect
 * — which for an open tab is never. Owner channels are deliberately not swept:
 * they are covered by the device re-verify, which is the check that a *machine*
 * still belongs to an account.
 *
 * Only an explicit denial closes a channel. A storage outage returns null from
 * `authorizeClient` too, and treating that as a revoke would kick every guest off
 * during a blip — the same asymmetry `reverify` applies to devices, for the same
 * reason. A revoke landing late is recoverable; a mass disconnect is not.
 */
async function reauthorizeGuests(): Promise<void> {
  for (const { deviceId, hub } of hubs.withGuests()) {
    for (const ch of hub.guestChannels()) {
      const fresh = await authorizeClient(deviceId, ch.userId).catch(() => undefined);
      if (fresh === undefined) continue; // could not ask — leave the channel alone
      const narrowed =
        !fresh ||
        fresh.scope !== ch.grant.scope ||
        fresh.hostUserId !== ch.grant.hostUserId ||
        !sameCaps(fresh.caps, ch.grant.caps) ||
        !coversSameSessions(fresh.sessionIds, ch.grant.sessionIds);
      if (!narrowed) continue;
      console.log(`[relay] grant for ${ch.userId} on ${deviceId} changed — closing channel ${ch.id}`);
      // Closed rather than mutated in place: the bridge derived its whole view of
      // this connection from the grant on the `open` frame, so a changed grant has
      // to arrive as a new channel. The browser reconnects and gets the new one.
      hub.dropChannel(ch.id, 'grant changed');
    }
  }
}

const sameCaps = (a?: Record<string, boolean>, b?: Record<string, boolean>): boolean => {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) if ((a?.[key] === true) !== (b?.[key] === true)) return false;
  return true;
};

const coversSameSessions = (a?: string[], b?: string[]): boolean => {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  return left.size === right.size && [...left].every((id) => right.has(id));
};

setInterval(() => void reauthorizeGuests(), GUEST_REAUTH_MS).unref();

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
