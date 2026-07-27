import type { ClientMessage, ServerMessage } from '@lines/shared';
import { useStore } from './store';

const WS_URL = `ws://${location.hostname}:8787`;
const PING_INTERVAL_MS = 1000;
// Declare the link dead after this long without a pong (~10 missed pings). Generous
// on purpose: pings are sent and pongs are handled on the main thread, so a long
// render blocks both and a tight timeout kills a perfectly healthy socket.
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 1500;
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
/** Latest minted token — kept fresh by connect() and the ~50s relay, for HTTP URLs. */
let lastToken: string | null = null;

export function setTokenProvider(fn: () => Promise<string | null>) {
  tokenProvider = fn;
}

/**
 * Append the current auth token to a bridge HTTP URL (file/tree/attachment
 * routes verify it like the WS handshake). No-op in local no-auth mode.
 */
export function withAuthToken(url: string): string {
  if (!lastToken) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(lastToken)}`;
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
      lastToken = token;
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

export async function connect() {
  if (socket && socket.readyState !== WebSocket.CLOSED) return;
  wireConnectivity();
  // Mint a fresh token for every (re)connect — a stale one fails the handshake.
  const token = tokenProvider ? await tokenProvider().catch(() => null) : null;
  if (token) lastToken = token;
  if (socket && socket.readyState !== WebSocket.CLOSED) return; // raced a parallel connect
  socket = new WebSocket(token ? `${WS_URL}/?token=${encodeURIComponent(token)}` : WS_URL);

  socket.onopen = () => {
    useStore.getState().setConnectionStatus('connected');
    startHeartbeat();
    startAuthRelay();
  };

  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      if (msg.type === 'pong') {
        lastPongAt = Date.now();
        return;
      }
      useStore.getState().applyServerMessage(msg);
      // Flush only after the hello reducer ran: sessions are fresh and transcripts reset.
      if (msg.type === 'hello') flushQueue();
      // Pop the Claude approval page; the login modal keeps a link as the popup-blocked fallback.
      if (msg.type === 'authLoginStarted') {
        window.open(msg.authorizeUrl, '_blank', 'noopener');
      }
      // The native folder picker's only job is opening projects now.
      if (msg.type === 'folderPicked' && msg.path) {
        send({ type: 'openProject', path: msg.path });
        useStore.getState().setActiveProject(msg.path);
      }
    } catch (err) {
      console.error('bad server message', err);
    }
  };

  socket.onclose = (e) => {
    stopHeartbeat();
    stopAuthRelay();
    // 1008 = bridge rejected the token. Blind reconnects would spam the gate;
    // Clerk's session state (sign-in redirect) is what recovers from here.
    if (e.code === 1008) {
      console.warn('[ws] unauthorized (1008) — waiting for sign-in');
      useStore.getState().setConnectionStatus('reconnecting');
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
