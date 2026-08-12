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

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let authRelayTimer: ReturnType<typeof setInterval> | null = null;
let lastPongAt = 0;
let connectivityWired = false;

/** Set by main.tsx once Clerk is active; null means local no-auth mode. */
let tokenProvider: (() => Promise<string | null>) | null = null;

export function setTokenProvider(fn: () => Promise<string | null>) {
  tokenProvider = fn;
}

/**
 * Which paired machine to reach, in a relayed deployment. The relay refuses a
 * connection without it (`1008 device required`) because one user may have
 * several machines and it has no basis to guess. Null when talking to a bridge
 * directly, which serves exactly one machine — its own.
 */
let deviceId: string | null = null;

export function setDeviceId(id: string | null) {
  deviceId = id;
}

/**
 * Point the socket at a different machine. Closes the current one rather than
 * waiting for it to drop: every message in flight belongs to the old machine's
 * bridge, and delivering any of them to the new one would attribute a session to
 * the wrong host. The close handler's normal retry path does the reconnecting.
 */
export function switchDevice(id: string) {
  if (id === deviceId) return;
  deviceId = id;
  // The store still describes the previous machine. Clearing it puts the
  // connecting screen back up rather than showing one machine's sessions under
  // another's name until the new `hello` lands.
  useStore.getState().clearBootstrap();
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  else void connect();
}

/**
 * Re-dial the current machine now, instead of waiting out the retry timer.
 *
 * `switchDevice` cannot serve this: it early-returns when the device id has not
 * changed, which is exactly the case here. Non-destructive — nothing is revoked
 * and nothing is forgotten; the socket is simply replaced.
 */
export function reconnectNow() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  // The close handler's own retry does the reconnecting; only a socket that is
  // already gone needs the direct call.
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  else void connect();
}

/**
 * In-flight fileRequests, keyed by reqId. Rejected on disconnect rather than
 * left hanging — the caller surfaces a normal error and can retry.
 */
const pendingFileRequests = new Map<
  string,
  { resolve: (r: { status: number; body?: unknown }) => void; reject: (e: Error) => void }
>();
let reqCounter = 0;

/**
 * Read a workspace file/tree/docs bundle, search files, or fetch an attachment,
 * over the already-authenticated socket. Replaces the old token-in-query-string
 * HTTP routes.
 */
export function fileRequest(
  kind: FileRequestKind,
  params: FileRequestParams,
): Promise<{ status: number; body?: unknown }> {
  if (socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Not connected to the bridge.'));
  }
  const reqId = `f${++reqCounter}`;
  return new Promise((resolve, reject) => {
    pendingFileRequests.set(reqId, { resolve, reject });
    socket!.send(JSON.stringify({ type: 'fileRequest', reqId, kind, params } satisfies ClientMessage));
  });
}

function rejectPendingFileRequests() {
  for (const [, p] of pendingFileRequests) p.reject(new Error('Connection lost.'));
  pendingFileRequests.clear();
}

function stopAuthRelay() {
  if (authRelayTimer) clearInterval(authRelayTimer);
  authRelayTimer = null;
}

function startAuthRelay() {
  stopAuthRelay();
  if (!tokenProvider) return;
  authRelayTimer = setInterval(async () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const token = await tokenProvider?.().catch(() => null);
    if (token) {
      socket.send(JSON.stringify({ type: 'auth', token } satisfies ClientMessage));
    }
  }, AUTH_RELAY_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat() {
  stopHeartbeat();
  lastPongAt = Date.now();
  let expectedTick = Date.now() + PING_INTERVAL_MS;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    // How late this tick itself ran = how long the main thread was blocked. Pongs
    // arriving during that block were never processed, so the silence says nothing
    // about the link — skip the liveness check and re-baseline instead of closing.
    const stalledMs = now - expectedTick;
    expectedTick = now + PING_INTERVAL_MS;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    if (stalledMs > PING_INTERVAL_MS) {
      lastPongAt = now;
      return;
    }
    // No pong for a while means the socket is dead even if the OS never told us.
    if (now - lastPongAt > PONG_TIMEOUT_MS) socket.close();
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
function socketUrl(token: string | null): string {
  const url = new URL(WS_URL);
  if (token) url.searchParams.set('token', token);
  if (deviceId) url.searchParams.set('device', deviceId);
  return url.toString();
}

export async function connect() {
  if (socket && socket.readyState !== WebSocket.CLOSED) return;
  wireConnectivity();
  // Re-resolve on every attempt, not just the first: a restarted bridge comes
  // back on a different ephemeral port, and this is what finds it.
  await resolveBridgeUrl();
  if (!WS_URL) {
    useStore.getState().setConnectionStatus('reconnecting');
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
    return;
  }
  // Mint a fresh token for every (re)connect — a stale one fails the handshake.
  const token = tokenProvider ? await tokenProvider().catch(() => null) : null;
  if (socket && socket.readyState !== WebSocket.CLOSED) return; // raced a parallel connect
  socket = new WebSocket(socketUrl(token));

  socket.onopen = () => {
    useStore.getState().setConnectionStatus('connected');
    startHeartbeat();
    startAuthRelay();
  };

  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data as string) as ServerMessage | RelayControlMessage;
      // Relay control frames, not app messages: the socket is healthy, the machine
      // behind it is not. Handled here with the other non-app frames because the
      // reducer has no case for them and would drop them silently.
      if (msg.type === 'deviceOffline' || msg.type === 'deviceOnline') {
        useStore.getState().setMachineOffline(msg.type === 'deviceOffline');
        return;
      }
      if (msg.type === 'pong') {
        lastPongAt = Date.now();
        return;
      }
      if (msg.type === 'fileResponse') {
        // Point-to-point reply, not app state — settled here, never in the store.
        const pending = pendingFileRequests.get(msg.reqId);
        pendingFileRequests.delete(msg.reqId);
        pending?.resolve({ status: msg.status, body: msg.body });
        return;
      }
      // Which project (if any) this pick adds a root to — read before the reducer
      // clears it below.
      const folderPickTarget =
        msg.type === 'folderPicked' ? useStore.getState().folderPickTarget : null;
      useStore.getState().applyServerMessage(msg);
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
    stopHeartbeat();
    stopAuthRelay();
    rejectPendingFileRequests();
    // 1008 = rejected. Against a bridge that means the token; through a relay it
    // also means "that machine has not attached yet", which recovers on its own
    // the moment it does — so this retries rather than parking, but slowly, so a
    // genuinely bad token does not hammer the gate.
    if (e.code === 1008) {
      console.warn('[ws] rejected (1008) — retrying slowly; check sign-in and that your machine is running');
      useStore.getState().setConnectionStatus('reconnecting');
      // A revoked machine is indistinguishable from a sleeping one at this layer,
      // so re-read the list: if it is gone, the gate shows the pairing screen
      // instead of retrying a machine that will now be refused forever.
      if (deviceId) refreshDevices();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void connect(), UNAUTHORIZED_RETRY_DELAY_MS);
      return;
    }
    useStore.getState().setConnectionStatus(navigator.onLine ? 'reconnecting' : 'offline');
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
  };

  socket.onerror = () => socket?.close();
}

/** Register once: react to the OS network toggling so we don't wait out the heartbeat. */
function wireConnectivity() {
  if (connectivityWired) return;
  connectivityWired = true;
  window.addEventListener('offline', () => {
    useStore.getState().setConnectionStatus('offline');
    socket?.close();
  });
  window.addEventListener('online', () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    void connect();
  });
}

export function send(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else if (msg.type === 'prompt') {
    // Only prompts are safe to replay blind; other control messages depend on live state.
    useStore.getState().enqueuePrompt({
      id: crypto.randomUUID(),
      sessionId: msg.sessionId,
      text: msg.text,
      attachments: msg.attachments,
      mentions: msg.mentions,
      queuedAt: Date.now(),
    });
  } else {
    console.warn('ws not connected, dropped', msg.type);
  }
}
