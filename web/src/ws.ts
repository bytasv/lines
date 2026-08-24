import type {
  ClientMessage,
  FileRequestKind,
  FileRequestParams,
  ServerMessage,
} from '@lines/shared';
import { APP_PROTOCOL_VERSION } from '@lines/shared';
import { useStore } from './store';
import { refreshDevices } from './lib/devices';

/**
 * One link per machine.
 *
 * This module used to hold a single module-level socket, because the client
 * talked to exactly one machine and `switchDevice` tore everything down to move.
 * Sharing breaks that: your own sessions and a colleague's shared one have to be
 * on screen together, which means holding both machines at once.
 *
 * Every piece of per-socket state that used to be a module global — the socket,
 * its generation, the retry/heartbeat/auth timers, the in-flight fileRequests —
 * now lives on a {@link MachineLink}, and every frame is tagged with the link it
 * arrived on. `socketGeneration` survives *per link*: cross-machine
 * misattribution is now structural rather than guarded, but a reconnect within
 * one link still delivers frames from the socket it replaced.
 */

/**
 * Where the bridge lives. Hosted builds set VITE_BRIDGE_WS_URL and never probe;
 * in dev the bridge binds an ephemeral port, so the URL is resolved from the dev
 * server's /__bridge endpoint (see web/vite.config.ts) on every connect attempt —
 * a restarted bridge comes back on a different port.
 */
const ENV_WS_URL = import.meta.env.VITE_BRIDGE_WS_URL as string | undefined;

/**
 * Frames the relay itself sends, about the machine rather than from it. Mirrors
 * `RelayToClient` in relay/src/protocol.ts; not imported, because a browser bundle
 * must not depend on the relay package. No ServerMessage uses either `type`.
 */
type RelayControlMessage = { type: 'deviceOffline' } | { type: 'deviceOnline' };

let WS_URL = ENV_WS_URL ?? '';

/**
 * Resolve where the bridge is listening. A failure leaves WS_URL empty, which
 * surfaces as an ordinary failed connection and retry rather than a boot error.
 */
async function resolveBridgeUrl(): Promise<void> {
  if (ENV_WS_URL) return;
  try {
    const res = await fetch('/__bridge', { cache: 'no-store' });
    const { port } = (await res.json()) as { port: number | null };
    if (!port) return;
    WS_URL = `ws://${location.hostname}:${port}`;
  } catch {
    console.warn('[ws] bridge discovery failed — is the bridge running?');
  }
}

const PING_INTERVAL_MS = 1000;
// Declare the link dead after this long without a pong (~10 missed pings). Generous
// on purpose: pings are sent and pongs are handled on the main thread, so a long
// render blocks both and a tight timeout kills a perfectly healthy socket.
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 1500;
// Slower than an ordinary reconnect: a 1008 is usually a state that needs
// something to change elsewhere (sign in again, start the machine), not a blip.
const UNAUTHORIZED_RETRY_DELAY_MS = 5000;
// Re-send a fresh Clerk token before its ~60s expiry.
const AUTH_RELAY_INTERVAL_MS = 50_000;
/**
 * How many machines this client will hold links to at once, and how long a
 * non-primary one may sit unused.
 *
 * Each link heartbeats independently (1s ping), so N links is N pings a second.
 * Fine for the two to four machines this realistically serves, which is exactly
 * why the cap and the idle disconnect exist rather than connecting to everything
 * shared with you.
 */
const LINK_CAP = 4;
const IDLE_DISCONNECT_MS = 5 * 60_000;

/** Everything one machine's socket needs. Nothing here is shared between links. */
interface MachineLink {
  /** '' for a direct bridge, which serves exactly one machine — its own. */
  deviceId: string;
  socket: WebSocket | null;
  /** Monotonic per socket, so a replaced socket's in-flight frames are dropped. */
  generation: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  authRelayTimer: ReturnType<typeof setInterval> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
  /** In-flight fileRequests for *this* machine, keyed by reqId. */
  pending: Map<string, { resolve: (r: { status: number; body?: unknown }) => void; reject: (e: Error) => void }>;
  reqCounter: number;
  /** Set while an intentional close is in flight, so it does not schedule a retry. */
  closing: boolean;
}

const links = new Map<string, MachineLink>();
let connectivityWired = false;

/**
 * The machine the UI is "on": the one whose account-wide state (settings,
 * projects, workflows) the app shows, and the default target for anything not
 * tied to a session. Null before a device is chosen, and '' when talking
 * straight to a local bridge.
 */
let primaryDeviceId: string | null = null;

/** Set by main.tsx once Clerk is active; null means local no-auth mode. */
let tokenProvider: (() => Promise<string | null>) | null = null;

export function setTokenProvider(fn: () => Promise<string | null>) {
  tokenProvider = fn;
}

function linkFor(deviceId: string): MachineLink {
  let link = links.get(deviceId);
  if (!link) {
    link = {
      deviceId,
      socket: null,
      generation: 0,
      retryTimer: null,
      heartbeatTimer: null,
      authRelayTimer: null,
      idleTimer: null,
      lastPongAt: 0,
      pending: new Map(),
      reqCounter: 0,
      closing: false,
    };
    links.set(deviceId, link);
  }
  return link;
}

/**
 * Which paired machine to reach, in a relayed deployment. The relay refuses a
 * connection without it (`1008 device required`) because one user may have
 * several machines and it has no basis to guess.
 */
export function setDeviceId(id: string | null) {
  primaryDeviceId = id;
  if (id !== null) useStore.getState().setPrimaryMachine(id);
}

/**
 * Point the UI at a different machine.
 *
 * No teardown and no `clearBootstrap()` any more: the previous machine's link
 * stays open and its sessions stay in the store, which is the whole point of
 * holding several. Frames are tagged with their link, so nothing can be
 * misattributed while both are live.
 */
export function switchDevice(id: string) {
  const previous = primaryDeviceId;
  primaryDeviceId = id;
  // Re-derives the banner scalars from the machine now in front of the user,
  // instead of leaving them describing the one they just left.
  useStore.getState().setPrimaryMachine(id);
  if (previous !== null && previous !== id) {
    // It is no longer the machine in front of you, so start its idle clock.
    armIdleDisconnect(linkFor(previous));
  }
  const link = linkFor(id);
  cancelIdleDisconnect(link);
  if (link.socket && link.socket.readyState !== WebSocket.CLOSED) return;
  void connectMachine(id);
}

/** Open a link to a machine without making it the one the UI is on. */
export async function connectMachine(deviceId: string): Promise<void> {
  const link = linkFor(deviceId);
  cancelIdleDisconnect(link);
  if (link.socket && link.socket.readyState !== WebSocket.CLOSED) return;
  // The cap is a real limit, not a suggestion — and a silently dropped machine
  // reads as "connected to everything" when it is not, so say so.
  const open = [...links.values()].filter((l) => l.socket && l.socket.readyState !== WebSocket.CLOSED);
  if (open.length >= LINK_CAP && deviceId !== primaryDeviceId) {
    console.warn(`[ws] link cap (${LINK_CAP}) reached — not connecting ${deviceId}`);
    return;
  }
  await openSocket(link);
}

/** Close a link deliberately. Its sessions stay in the store, flagged not-linked. */
export function disconnectMachine(deviceId: string): void {
  const link = links.get(deviceId);
  if (!link) return;
  cancelIdleDisconnect(link);
  clearTimers(link);
  link.closing = true;
  link.socket?.close();
  link.socket = null;
  rejectPending(link);
  useStore.getState().setConnectionStatus('reconnecting', deviceId);
}

function armIdleDisconnect(link: MachineLink) {
  cancelIdleDisconnect(link);
  link.idleTimer = setTimeout(() => {
    if (link.deviceId === primaryDeviceId) return;
    console.log(`[ws] ${link.deviceId} idle for ${IDLE_DISCONNECT_MS}ms — disconnecting`);
    disconnectMachine(link.deviceId);
  }, IDLE_DISCONNECT_MS);
}

function cancelIdleDisconnect(link: MachineLink) {
  if (link.idleTimer) clearTimeout(link.idleTimer);
  link.idleTimer = null;
}

/**
 * Re-dial the machine in front of the user now, instead of waiting out its retry.
 *
 * `switchDevice` cannot serve this: it does nothing when the id has not changed,
 * which is exactly the case here. Non-destructive — nothing is revoked and
 * nothing is forgotten; the socket is simply replaced.
 */
export function reconnectNow() {
  if (primaryDeviceId === null) return;
  const link = linkFor(primaryDeviceId);
  if (link.retryTimer) clearTimeout(link.retryTimer);
  link.retryTimer = null;
  if (link.socket && link.socket.readyState !== WebSocket.CLOSED) link.socket.close();
  else void openSocket(link);
}

/**
 * Read a workspace file/tree/docs bundle, search files, or fetch an attachment,
 * over the already-authenticated socket.
 *
 * Takes the machine, because a shared session's file tree, mentions and docs live
 * on the *host's* disk — asking the wrong bridge would either 403 or, worse,
 * answer with a same-named file from the wrong computer.
 */
export function fileRequest(
  kind: FileRequestKind,
  params: FileRequestParams,
  deviceId?: string,
): Promise<{ status: number; body?: unknown }> {
  // Defaults to the machine hosting the *selected* session, not the primary.
  // Every session-scoped reader here — the file tree, @mention search, docs, a
  // clicked path — is driven by that session's cwd, so with a shared session
  // open the paths only exist on the host's disk. Falling back to the primary
  // would 403 at best and, on a same-named path, answer from the wrong computer.
  const link = links.get(deviceId ?? machineForSelectedSession() ?? primaryDeviceId ?? '');
  if (link?.socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Not connected to the bridge.'));
  }
  const reqId = `f${++link.reqCounter}`;
  return new Promise((resolve, reject) => {
    link.pending.set(reqId, { resolve, reject });
    link.socket!.send(JSON.stringify({ type: 'fileRequest', reqId, kind, params } satisfies ClientMessage));
  });
}

/** The machine hosting whatever session is on screen, if it is known. */
function machineForSelectedSession(): string | undefined {
  const { selectedSessionId, sessionMachine } = useStore.getState();
  return selectedSessionId ? sessionMachine[selectedSessionId] : undefined;
}

function rejectPending(link: MachineLink) {
  for (const [, p] of link.pending) p.reject(new Error('Connection lost.'));
  link.pending.clear();
}

function clearTimers(link: MachineLink) {
  if (link.heartbeatTimer) clearInterval(link.heartbeatTimer);
  if (link.authRelayTimer) clearInterval(link.authRelayTimer);
  if (link.retryTimer) clearTimeout(link.retryTimer);
  link.heartbeatTimer = null;
  link.authRelayTimer = null;
  link.retryTimer = null;
}

/**
 * One fresh Clerk token per link per interval. N links means N mints, which is
 * acceptable, but the relay has to be told per socket — each carries its own.
 */
function startAuthRelay(link: MachineLink) {
  if (link.authRelayTimer) clearInterval(link.authRelayTimer);
  link.authRelayTimer = null;
  if (!tokenProvider) return;
  link.authRelayTimer = setInterval(async () => {
    if (link.socket?.readyState !== WebSocket.OPEN) return;
    const token = await tokenProvider?.().catch(() => null);
    if (token) link.socket.send(JSON.stringify({ type: 'auth', token } satisfies ClientMessage));
  }, AUTH_RELAY_INTERVAL_MS);
}

function startHeartbeat(link: MachineLink) {
  if (link.heartbeatTimer) clearInterval(link.heartbeatTimer);
  link.lastPongAt = Date.now();
  let expectedTick = Date.now() + PING_INTERVAL_MS;
  link.heartbeatTimer = setInterval(() => {
    const now = Date.now();
    // How late this tick itself ran = how long the main thread was blocked. Pongs
    // arriving during that block were never processed, so the silence says nothing
    // about the link — skip the liveness check and re-baseline instead of closing.
    const stalledMs = now - expectedTick;
    expectedTick = now + PING_INTERVAL_MS;
    if (link.socket?.readyState !== WebSocket.OPEN) return;
    link.socket.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    if (stalledMs > PING_INTERVAL_MS) {
      link.lastPongAt = now;
      return;
    }
    // No pong for a while means the socket is dead even if the OS never told us.
    if (now - link.lastPongAt > PONG_TIMEOUT_MS) link.socket.close();
  }, PING_INTERVAL_MS);
}

/** Re-send prompts queued while offline, dropping any whose session vanished. Runs after `hello`. */
function flushQueue() {
  const queued = useStore.getState().drainQueuedPrompts();
  for (const p of queued) {
    if (useStore.getState().sessions[p.sessionId]) {
      send({ type: 'prompt', sessionId: p.sessionId, text: p.text, attachments: p.attachments, mentions: p.mentions });
    } else {
      console.warn('dropped queued prompt, session gone', p.sessionId);
    }
  }
}

/**
 * Build the connect URL, preserving whatever path WS_URL carries.
 *
 * Parsed rather than concatenated: the relay matches its endpoint path exactly
 * (`/client`), so appending "/?token=" — as this once did — turns a valid URL
 * into `/client/` and the socket closes with 1008. A bridge ignores the path
 * entirely, so both cases come out right.
 */
function socketUrl(token: string | null, deviceId: string): string {
  const url = new URL(WS_URL);
  if (token) url.searchParams.set('token', token);
  if (deviceId) url.searchParams.set('device', deviceId);
  return url.toString();
}

/** Connect the machine the UI is on. Kept as the entry point main.tsx already calls. */
export async function connect() {
  await connectMachine(primaryDeviceId ?? '');
}

async function openSocket(link: MachineLink) {
  if (link.socket && link.socket.readyState !== WebSocket.CLOSED) return;
  wireConnectivity();
  // Re-resolve on every attempt, not just the first: a restarted bridge comes
  // back on a different ephemeral port, and this is what finds it.
  await resolveBridgeUrl();
  if (!WS_URL) {
    useStore.getState().setConnectionStatus('reconnecting', link.deviceId);
    if (link.retryTimer) clearTimeout(link.retryTimer);
    link.retryTimer = setTimeout(() => void openSocket(link), RECONNECT_DELAY_MS);
    return;
  }
  // Mint a fresh token for every (re)connect — a stale one fails the handshake.
  const token = tokenProvider ? await tokenProvider().catch(() => null) : null;
  if (link.socket && link.socket.readyState !== WebSocket.CLOSED) return; // raced a parallel connect
  link.closing = false;
  const socket = new WebSocket(socketUrl(token, link.deviceId));
  link.socket = socket;
  const generation = ++link.generation;

  socket.onopen = () => {
    useStore.getState().setConnectionStatus('connected', link.deviceId);
    startHeartbeat(link);
    startAuthRelay(link);
  };

  socket.onmessage = (e) => {
    // A superseded socket's frames describe a state we have already left.
    if (generation !== link.generation) return;
    try {
      const msg = JSON.parse(e.data as string) as ServerMessage | RelayControlMessage;
      // Relay control frames, not app messages: the socket is healthy, the machine
      // behind it is not. Handled here with the other non-app frames because the
      // reducer has no case for them and would drop them silently.
      if (msg.type === 'deviceOffline' || msg.type === 'deviceOnline') {
        useStore.getState().setMachineOffline(msg.type === 'deviceOffline', link.deviceId);
        return;
      }
      if (msg.type === 'pong') {
        link.lastPongAt = Date.now();
        return;
      }
      if (msg.type === 'fileResponse') {
        // Point-to-point reply, not app state — settled here, never in the store,
        // and only against this link's own in-flight requests.
        const pending = link.pending.get(msg.reqId);
        link.pending.delete(msg.reqId);
        pending?.resolve({ status: msg.status, body: msg.body });
        return;
      }
      // Which project (if any) this pick adds a root to — read before the reducer
      // clears it below.
      const folderPickTarget =
        msg.type === 'folderPicked' ? useStore.getState().folderPickTarget : null;
      // Tagged with the link: this is what lets the reducer keep two machines'
      // sessions apart instead of letting the newest `hello` win.
      useStore.getState().applyServerMessage(msg, link.deviceId);
      // Flush only after the hello reducer ran: sessions are fresh and transcripts reset.
      if (msg.type === 'hello') {
        if (useStore.getState().protocolSkew) {
          console.warn(
            `[ws] protocol skew: bridge speaks v${msg.bridge?.appProtocol ?? '<pre-versioning>'}, ` +
              `this client speaks v${APP_PROTOCOL_VERSION}. Unknown messages are ignored.`,
          );
        }
        flushQueue();
      }
      // Pop the Claude approval page; the login modal keeps a link as the popup-blocked fallback.
      if (msg.type === 'authLoginStarted') {
        window.open(msg.authorizeUrl, '_blank', 'noopener');
      }
      // The native folder picker either opens a project or widens one, depending on
      // where the pick was started from. Adding a root leaves the active tab alone —
      // the tab the root lands in need not be the one in front.
      if (msg.type === 'folderPicked' && msg.path) {
        if (folderPickTarget) {
          send({ type: 'addProjectRoot', project: folderPickTarget, path: msg.path });
        } else {
          send({ type: 'openProject', path: msg.path });
          useStore.getState().setActiveProject(msg.path);
        }
      }
    } catch (err) {
      console.error('bad server message', err);
    }
  };

  socket.onclose = (e) => {
    clearTimers(link);
    rejectPending(link);
    // A deliberate disconnect must not immediately dial back.
    if (link.closing) {
      link.closing = false;
      return;
    }
    // 1008 = rejected. Against a bridge that means the token; through a relay it
    // also means "that machine has not attached yet", or that a share was revoked
    // — all of which recover on their own if they are going to, so this retries
    // rather than parking, but slowly, so a genuinely bad token does not hammer
    // the gate.
    if (e.code === 1008) {
      console.warn(
        `[ws] ${link.deviceId || 'bridge'} rejected (1008) — retrying slowly; check sign-in, ` +
          'that the machine is running, and that the share is still granted',
      );
      useStore.getState().setConnectionStatus('reconnecting', link.deviceId);
      // A revoked machine is indistinguishable from a sleeping one at this layer,
      // so re-read the list: if it is gone, the gate shows the pairing screen
      // instead of retrying a machine that will now be refused forever.
      if (link.deviceId) refreshDevices();
      link.retryTimer = setTimeout(() => void openSocket(link), UNAUTHORIZED_RETRY_DELAY_MS);
      return;
    }
    useStore
      .getState()
      .setConnectionStatus(navigator.onLine ? 'reconnecting' : 'offline', link.deviceId);
    link.retryTimer = setTimeout(() => void openSocket(link), RECONNECT_DELAY_MS);
  };

  socket.onerror = () => socket.close();
}

/** Register once: react to the OS network toggling so we don't wait out the heartbeat. */
function wireConnectivity() {
  if (connectivityWired) return;
  connectivityWired = true;
  window.addEventListener('offline', () => {
    for (const link of links.values()) {
      useStore.getState().setConnectionStatus('offline', link.deviceId);
      link.socket?.close();
    }
  });
  window.addEventListener('online', () => {
    // Every link, not just the primary: a shared machine that was up when the
    // network went is still expected on screen when it comes back.
    for (const link of links.values()) {
      if (link.retryTimer) clearTimeout(link.retryTimer);
      link.retryTimer = null;
      void openSocket(link);
    }
  });
}

/**
 * Which link a message belongs to.
 *
 * A session-scoped message goes to the machine hosting that session — sending a
 * prompt for a shared session to your own bridge would either be refused or, if
 * the id happened to collide, run on the wrong computer. Everything else is about
 * the machine the UI is on.
 *
 * One helper owns the routing so no call site outside this module needs to know
 * about devices at all.
 */
function linkForMessage(msg: ClientMessage): MachineLink | undefined {
  const sessionId = 'sessionId' in msg ? (msg as { sessionId?: string }).sessionId : undefined;
  const deviceId = sessionId
    ? (useStore.getState().sessionMachine[sessionId] ?? primaryDeviceId)
    : primaryDeviceId;
  return links.get(deviceId ?? '');
}

/** False when the message was dropped — the caller can then say so instead of
 *  leaving the user with a button that appears to do nothing. */
export function send(msg: ClientMessage): boolean {
  const link = linkForMessage(msg);
  if (link?.socket?.readyState === WebSocket.OPEN) {
    link.socket.send(JSON.stringify(msg));
    return true;
  }
  if (msg.type === 'prompt') {
    // Only prompts are safe to replay blind; other control messages depend on live state.
    useStore.getState().enqueuePrompt({
      id: crypto.randomUUID(),
      sessionId: msg.sessionId,
      text: msg.text,
      attachments: msg.attachments,
      mentions: msg.mentions,
      queuedAt: Date.now(),
    });
    return true;
  }
  console.warn('ws not connected, dropped', msg.type);
  // Not only a console line: a silently dropped control message is exactly what
  // "delete does nothing" looked like from the outside.
  useStore
    .getState()
    .setActionError(`Not connected to your machine — that action wasn't sent. Try again once it reconnects.`);
  return false;
}
