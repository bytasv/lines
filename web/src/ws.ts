import type { ClientMessage, ServerMessage } from '@claude-ui/shared';
import { useStore } from './store';

const WS_URL = `ws://${location.hostname}:8787`;

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export function connect() {
  if (socket && socket.readyState !== WebSocket.CLOSED) return;
  socket = new WebSocket(WS_URL);

  socket.onopen = () => useStore.getState().setConnected(true);

  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      useStore.getState().applyServerMessage(msg);
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
    useStore.getState().setConnected(false);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 1500);
  };

  socket.onerror = () => socket?.close();
}

export function send(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else {
    console.warn('ws not connected, dropped', msg.type);
  }
}
