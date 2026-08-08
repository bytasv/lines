import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  WORKER_TOKEN_HEADER,
  readRuntimeInfo,
  watchRuntimeInfo,
  type AskMethod,
  type BridgeToWorker,
  type LiveSessionInfo,
  type McpToolManifest,
  type RpcKind,
  type WorkerToBridge,
} from './workerProtocol.ts';

/**
 * An ask round-trips through the CLI's control loop; generous for a healthy CLI,
 * short enough that a wedged one doesn't hold a browser request open.
 */
const ASK_TIMEOUT_MS = 10_000;

/**
 * How long the socket can be down before we tell every in-flight session it's
 * gone. An ordinary tsx-watch restart reconnects in ~1-2s (the retry loop plus
 * the runtime-file watch), so this only trips for an outage nothing recovers
 * from on its own — a crashed worker, a killed process, a stuck rebuild.
 */
export const WORKER_LOST_MS = 20_000;

export interface WorkerRpc {
  id: string;
  sessionId: string;
  kind: RpcKind;
  resend: boolean;
  payload: Record<string, unknown>;
}

/**
 * The worker's hello snapshot plus the sessions whose `push` is still sitting in
 * our queue: the snapshot was taken before the flush, so those turns are about
 * to run and must not be reconciled as dead.
 */
export function withQueuedPushes(live: LiveSessionInfo[], pending: BridgeToWorker[]): LiveSessionInfo[] {
  const queued = new Set(pending.flatMap((m) => (m.type === 'push' ? [m.sessionId] : [])));
  for (const l of live) queued.delete(l.sessionId);
  return [...live, ...[...queued].map((sessionId) => ({ sessionId, busy: true }))];
}

export interface WorkerClientCallbacks {
  /** Fired on every (re)connect with the worker's live sessions. */
  onHello(live: LiveSessionInfo[]): void;
  onEvent(sessionId: string, message: Record<string, unknown> & { type: string }): void;
  onEnded(sessionId: string, error?: string): void;
  onRpc(rpc: WorkerRpc): void;
  onRpcCancel(id: string): void;
  /**
   * The socket has been down continuously for `WORKER_LOST_MS`. Fired once per
   * outage — not on every ordinary tsx-watch blip, see `WORKER_LOST_MS` — and
   * re-armed by the next successful `hello`.
   */
  onWorkerLost(): void;
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
  private pendingAsks = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private warnedVersion: number | null = null;
  everConnected = false;
  /** A worker answered hello but on an incompatible protocol version. It is
   *  demonstrably alive and may be running turns, so in-flight statuses are
   *  *not* stale — see the blind-clear timer in index.ts. */
  sawIncompatibleWorker = false;
  /** When the socket last went down, or null while connected/never connected.
   *  Set in the `close` handler, cleared on the next successful `hello`. */
  private disconnectedAt: number | null = null;
  /** Guards `onWorkerLost` to once per outage; cleared alongside `disconnectedAt`. */
  private lostFired = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopWatching: (() => void) | null = null;
  private disposed = false;

  /**
   * Overridable only so tests can drive real elapsed time instead of a mocked
   * clock: this client owns a live WebSocket, and `ws` schedules its own real
   * timers, so faking the clock underneath it corrupts node's timer list.
   */
  constructor(
    private callbacks: WorkerClientCallbacks,
    private timing: { retryMs?: number; lostMs?: number } = {},
  ) {
    // A worker that restarts lands on a new port and a new token, so re-dial as
    // soon as it republishes rather than waiting out the retry timer.
    this.stopWatching = watchRuntimeInfo('worker', () => {
      if (!this.ws) this.connect();
    });
    this.connect();
  }

  /**
   * Release the socket, the fs watcher, and the retry chain. The bridge never
   * calls this — it holds the client for its whole life — but the retry chain
   * re-arms forever while the worker is down, so anything shorter-lived (tests,
   * a future CLI) needs a way to stop it and exit. Deliberately not `unref()`:
   * that makes the timer invisible to mocked clocks.
   */
  dispose() {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopWatching?.();
    this.stopWatching = null;
    this.ws?.close();
    this.ws = null;
  }

  private retry() {
    if (this.disposed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.checkWorkerLost();
      if (!this.ws) this.connect();
    }, this.timing.retryMs ?? 1000);
  }

  /** Checked on every retry tick rather than a second timer — see `onWorkerLost`. */
  private checkWorkerLost() {
    if (this.lostFired || this.disconnectedAt === null) return;
    if (Date.now() - this.disconnectedAt >= (this.timing.lostMs ?? WORKER_LOST_MS)) {
      this.lostFired = true;
      this.callbacks.onWorkerLost();
    }
  }

  private connect() {
    // The worker publishes its port and per-boot token; there is no fixed port
    // to fall back on. Absent file = worker down or still booting — retry.
    const info = readRuntimeInfo('worker');
    if (!info) {
      this.retry();
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}`, {
      headers: { [WORKER_TOKEN_HEADER]: info.token },
    });
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
      // Only start the clock once we've actually seen the worker: a boot-time
      // "no runtime file yet" retry loop isn't an outage.
      if (this.everConnected) this.disconnectedAt ??= Date.now();
      // Asks are not replayed on reconnect — callers re-ask when they need to.
      for (const [, p] of this.pendingAsks) {
        clearTimeout(p.timer);
        p.reject(new Error('worker-disconnected'));
      }
      this.pendingAsks.clear();
      this.retry();
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
          this.sawIncompatibleWorker = true;
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
        this.sawIncompatibleWorker = false;
        this.disconnectedAt = null;
        this.lostFired = false;
        // Reconcile first so command handlers see fresh session statuses, and
        // count queued pushes as live — otherwise reconcile idles a session
        // milliseconds before its turn actually starts.
        this.callbacks.onHello(withQueuedPushes(msg.live, this.pending));
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
      case 'askResult': {
        const ask = this.pendingAsks.get(msg.id);
        if (!ask) break; // timed out or duplicate
        this.pendingAsks.delete(msg.id);
        clearTimeout(ask.timer);
        if (msg.ok) ask.resolve(msg.value);
        else ask.reject(new Error(msg.error));
        break;
      }
    }
  }

  private send(msg: BridgeToWorker) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.pending.push(msg);
    }
  }

  /** `tools` is only read when the worker has to create the query (see `push` in workerProtocol.ts). */
  push(
    sessionId: string,
    message: unknown,
    options: Record<string, unknown>,
    tools?: McpToolManifest,
  ) {
    this.send({ type: 'push', sessionId, message, options, tools });
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

  /**
   * Bridge->worker request/response. Unlike send(), an ask is never queued while
   * disconnected: it would resolve minutes later against a caller that has long
   * given up, and leak a pending entry. Callers treat rejection as "no data".
   */
  private ask(sessionId: string, method: AskMethod): Promise<unknown> {
    const ws = this.ws;
    if (!this.ready || ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('worker-unavailable'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAsks.delete(id);
        reject(new Error('worker-timeout'));
      }, ASK_TIMEOUT_MS);
      timer.unref();
      this.pendingAsks.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'ask', id, sessionId, method } satisfies BridgeToWorker));
    });
  }

  /** Raw SDKControlGetContextUsageResponse from the session's live query. */
  contextUsage(sessionId: string): Promise<unknown> {
    return this.ask(sessionId, 'contextUsage');
  }
}
