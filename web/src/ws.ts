import type { ClientMessage, ServerMessage } from '@claude-ui/shared';
import { useStore } from './store';

const WS_URL = `ws://${location.hostname}:8787`;
const PING_INTERVAL_MS = 1000;
// Declare the link dead after this long without a pong (~3 missed pings).
const PONG_TIMEOUT_MS = 3000;
const RECONNECT_DELAY_MS = 1500;

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastPongAt = 0;
let connectivityWired = false;

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat() {
  stopHeartbeat();
  lastPongAt = Date.now();
  heartbeatTimer = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    // No pong for a while means the socket is dead even if the OS never told us.
    if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) socket.close();
  }, PING_INTERVAL_MS);
}

/** Re-send prompts queued while offline, dropping any whose session vanished. Runs after `hello`. */
function flushQueue() {
  const queued = useStore.getState().drainQueuedPrompts();
  for (const p of queued) {
    if (useStore.getState().sessions[p.sessionId]) {
      send({ type: 'prompt', sessionId: p.sessionId, text: p.text, attachments: p.attachments });
    } else {
      console.warn('dropped queued prompt, session gone', p.sessionId);
    }
  }
}

export function connect() {
  if (socket && socket.readyState !== WebSocket.CLOSED) return;
  wireConnectivity();
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    useStore.getState().setConnectionStatus('connected');
    startHeartbeat();
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
      // The native folder picker's only job is opening projects now.
      if (msg.type === 'folderPicked' && msg.path) {
        send({ type: 'openProject', path: msg.path });
        useStore.getState().setActiveProject(msg.path);
      }
    } catch (err) {
      console.error('bad server message', err);
    }
  };

  socket.onclose = () => {
    stopHeartbeat();
    useStore.getState().setConnectionStatus(navigator.onLine ? 'reconnecting' : 'offline');
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
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
    connect();
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
      queuedAt: Date.now(),
    });
  } else {
    console.warn('ws not connected, dropped', msg.type);
  }
}
