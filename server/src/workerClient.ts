import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  WORKER_PORT,
  type BridgeToWorker,
  type LiveSessionInfo,
  type RpcKind,
  type WorkerToBridge,
} from './workerProtocol.ts';

export interface WorkerRpc {
  id: string;
  sessionId: string;
  kind: RpcKind;
  resend: boolean;
  payload: Record<string, unknown>;
}

export interface WorkerClientCallbacks {
  /** Fired on every (re)connect with the worker's live sessions. */
  onHello(live: LiveSessionInfo[]): void;
  onEvent(sessionId: string, message: Record<string, unknown> & { type: string }): void;
  onEnded(sessionId: string, error?: string): void;
  onRpc(rpc: WorkerRpc): void;
  onRpcCancel(id: string): void;
}

/**
 * Bridge-side connection to the worker process. Auto-reconnects (the worker
 * outlives bridge restarts by design); commands issued while disconnected are
 * queued and flushed after the hello handshake, so a prompt sent during the
 * boot window is never dropped.
 */
export class WorkerClient {
  private ws: WebSocket | null = null;
  private ready = false;
  private pending: BridgeToWorker[] = [];
  private warnedVersion: number | null = null;
  everConnected = false;

  constructor(private callbacks: WorkerClientCallbacks) {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${WORKER_PORT}`);
    this.ws = ws;

    ws.on('message', (raw) => {
      let msg: WorkerToBridge;
      try {
        msg = JSON.parse(String(raw)) as WorkerToBridge;
      } catch {
        return;
      }
      this.dispatch(ws, msg);
    });
    ws.on('close', () => {
      this.ready = false;
      if (this.ws === ws) this.ws = null;
      setTimeout(() => {
        if (!this.ws) this.connect();
      }, 1000);
    });
    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private dispatch(ws: WebSocket, msg: WorkerToBridge) {
    switch (msg.type) {
      case 'hello': {
        if (msg.version !== PROTOCOL_VERSION) {
          // A stale worker (started before a protocol change, outside tsx
          // watch) — keep retrying and tell the user what to do, once.
          if (this.warnedVersion !== msg.version) {
            this.warnedVersion = msg.version;
            console.error(
              `[worker] protocol mismatch: worker v${msg.version}, bridge v${PROTOCOL_VERSION} — restart the worker process`,
            );
          }
          ws.close();
          return;
        }
        this.ready = true;
        this.everConnected = true;
        // Reconcile first so command handlers see fresh session statuses.
        this.callbacks.onHello(msg.live);
        for (const queued of this.pending.splice(0)) ws.send(JSON.stringify(queued));
        break;
      }
      case 'event':
        this.callbacks.onEvent(msg.sessionId, msg.message as Record<string, unknown> & { type: string });
        break;
      case 'ended':
        this.callbacks.onEnded(msg.sessionId, msg.error);
        break;
      case 'rpc':
        this.callbacks.onRpc({
          id: msg.id,
          sessionId: msg.sessionId,
          kind: msg.kind,
          resend: msg.resend === true,
          payload: msg.payload,
        });
        break;
      case 'rpcCancel':
        this.callbacks.onRpcCancel(msg.id);
        break;
    }
  }

  private send(msg: BridgeToWorker) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.pending.push(msg);
    }
  }

  push(sessionId: string, message: unknown, options: Record<string, unknown>) {
    this.send({ type: 'push', sessionId, message, options });
  }

  interrupt(sessionId: string) {
    this.send({ type: 'interrupt', sessionId });
  }

  setModel(sessionId: string, model: string) {
    this.send({ type: 'setModel', sessionId, model });
  }

  setPermissionMode(sessionId: string, mode: string) {
    this.send({ type: 'setPermissionMode', sessionId, mode });
  }

  close(sessionId: string) {
    this.send({ type: 'close', sessionId });
  }

  rpcResult(id: string, result: unknown) {
    this.send({ type: 'rpcResult', id, result });
  }
}
