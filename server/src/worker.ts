/**
 * Worker process: owns every Claude SDK query (and therefore every Claude CLI
 * child process), so the bridge can restart freely — tsx watch, crashes,
 * dogfooding edits to bridge code — without killing in-flight agent turns.
 *
 * Deliberately thin: no business logic lives here. Permission decisions, the
 * auto-mode guard, file snapshots, transcripts, and workflows all stay in the
 * bridge; the worker forwards those decisions over blocking RPCs and buffers
 * session events while the bridge is away.
 *
 * KEEP THE IMPORT GRAPH MINIMAL (stdlib + ws + SDK + workerProtocol.ts):
 * this file runs under tsx watch too, and only restarts when its own graph
 * changes — which is exactly when a restart is unavoidable anyway.
 */
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  PROTOCOL_VERSION,
  WORKER_PORT,
  type BridgeToWorker,
  type RpcKind,
  type WorkerToBridge,
} from './workerProtocol.ts';

/** Push-based async iterable used as the streaming-input prompt for the SDK. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T) {
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

interface SessionState {
  queue: AsyncQueue<SDKUserMessage>;
  query: Query;
  claudeSessionId?: string;
  /** A pushed turn has not produced its `result` yet. Reported in hello so the
   *  bridge can reconcile a status in either direction, not just demote. */
  busy: boolean;
}

interface PendingRpc {
  sessionId: string;
  kind: RpcKind;
  payload: Record<string, unknown>;
  settle: (result: unknown) => void;
}

const startedAt = Date.now();
const sessions = new Map<string, SessionState>();
const pendingRpcs = new Map<string, PendingRpc>();

let bridge: WebSocket | null = null;

/**
 * Events buffered while no bridge is connected, flushed FIFO on reconnect.
 * Stream deltas are dropped (never persisted; the browser reloads transcripts
 * on reconnect anyway) and rpcs are excluded (re-sent from pendingRpcs).
 */
const outbox: WorkerToBridge[] = [];
const OUTBOX_CAP = 10_000;

function send(msg: WorkerToBridge) {
  if (bridge?.readyState === WebSocket.OPEN) {
    bridge.send(JSON.stringify(msg));
    return;
  }
  if (msg.type === 'event' && (msg.message as { type?: string }).type === 'stream_event') return;
  if (msg.type === 'rpc') return; // re-sent from pendingRpcs on reconnect
  outbox.push(msg);
  if (outbox.length > OUTBOX_CAP) {
    outbox.splice(0, outbox.length - OUTBOX_CAP);
    console.warn(`[worker] outbox overflow — dropped oldest events (cap ${OUTBOX_CAP})`);
  }
}

/**
 * Read something off a live Query handle for the bridge. Replies bypass send():
 * the outbox is for session events, and an ask the bridge already timed out on
 * is worthless.
 */
async function handleAsk(msg: Extract<BridgeToWorker, { type: 'ask' }>) {
  const reply = (result: WorkerToBridge) => {
    if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(result));
  };
  const state = sessions.get(msg.sessionId);
  if (!state) {
    reply({ type: 'askResult', id: msg.id, ok: false, error: 'no-live-session' });
    return;
  }
  try {
    const value = await state.query.getContextUsage();
    reply({ type: 'askResult', id: msg.id, ok: true, value });
  } catch (err) {
    reply({ type: 'askResult', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * PreToolUse hooks have a CLI-side timeout; if the bridge stays away this
 * long, fail closed into 'ask' — that routes the call to canUseTool, which
 * the SDK parks with no deadline until the bridge answers.
 */
const HOOK_FALLBACK_MS = 90_000;

function rpcCall(
  sessionId: string,
  kind: RpcKind,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const settle = (result: unknown) => {
      if (!pendingRpcs.delete(id)) return; // already settled
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    pendingRpcs.set(id, { sessionId, kind, payload, settle });

    if (kind === 'preToolUse') {
      timer = setTimeout(() => {
        if (bridge?.readyState === WebSocket.OPEN) return; // bridge alive — keep waiting
        settle({
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: 'Bridge unavailable — escalated to a permission prompt.',
          },
        });
      }, HOOK_FALLBACK_MS);
      timer.unref();
    }

    signal?.addEventListener('abort', () => {
      send({ type: 'rpcCancel', id });
      settle(
        kind === 'canUseTool'
          ? { behavior: 'deny', message: 'Interrupted.' }
          : { continue: true },
      );
    });

    if (bridge?.readyState === WebSocket.OPEN) {
      bridge.send(JSON.stringify({ type: 'rpc', id, sessionId, kind, payload } satisfies WorkerToBridge));
    }
    // else: delivered by the reconnect handler from pendingRpcs.
  });
}

function ensureSession(sessionId: string, options: Record<string, unknown>): SessionState {
  let state = sessions.get(sessionId);
  if (state) return state;

  const queue = new AsyncQueue<SDKUserMessage>();
  const fullOptions = {
    ...options,
    stderr: (data: string) => {
      if (data.trim()) console.error(`[claude:${sessionId.slice(0, 8)}]`, data.trim());
    },
    canUseTool: (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) =>
      rpcCall(sessionId, 'canUseTool', { toolName, input }, opts.signal),
    hooks: {
      PreToolUse: [
        {
          timeout: 600, // seconds; generous so a bridge restart never lapses the hook
          hooks: [
            (input: unknown, _toolUseID: string | undefined, opts: { signal: AbortSignal }) =>
              rpcCall(sessionId, 'preToolUse', input as Record<string, unknown>, opts.signal),
          ],
        },
      ],
    },
  };

  const q = query({ prompt: queue as AsyncIterable<SDKUserMessage>, options: fullOptions as never });
  state = { queue, query: q, busy: false };
  sessions.set(sessionId, state);
  void pump(sessionId, state, q);
  return state;
}

async function pump(sessionId: string, state: SessionState, q: Query) {
  try {
    for await (const message of q) {
      const msg = message as Record<string, unknown> & { type: string; session_id?: string };
      if (typeof msg.session_id === 'string') state.claudeSessionId = msg.session_id;
      if (msg.type === 'result') state.busy = false; // turn settled; query stays open
      send({ type: 'event', sessionId, message: msg });
    }
    send({ type: 'ended', sessionId });
  } catch (err) {
    console.error(`[worker] session ${sessionId} query failed:`, err);
    send({ type: 'ended', sessionId, error: err instanceof Error ? err.message : String(err) });
  } finally {
    state.busy = false;
    if (sessions.get(sessionId) === state) sessions.delete(sessionId);
    // Settle rpcs still waiting on this dead query so their promises resolve.
    for (const [, p] of [...pendingRpcs]) {
      if (p.sessionId !== sessionId) continue;
      p.settle(
        p.kind === 'canUseTool' ? { behavior: 'deny', message: 'Session ended.' } : { continue: true },
      );
    }
  }
}

function handleBridgeMessage(msg: BridgeToWorker) {
  switch (msg.type) {
    case 'push': {
      const state = ensureSession(msg.sessionId, msg.options);
      state.busy = true;
      state.queue.push(msg.message as SDKUserMessage);
      break;
    }
    case 'interrupt':
      sessions.get(msg.sessionId)?.query.interrupt().catch((err) => console.warn('[worker] interrupt', err));
      break;
    case 'setModel':
      sessions.get(msg.sessionId)?.query.setModel(msg.model).catch((err) => console.warn('[worker] setModel', err));
      break;
    case 'setPermissionMode':
      sessions
        .get(msg.sessionId)
        ?.query.setPermissionMode(msg.mode as never)
        .catch((err) => console.warn('[worker] setPermissionMode', err));
      break;
    case 'close': {
      const state = sessions.get(msg.sessionId);
      if (state) {
        sessions.delete(msg.sessionId); // next push re-creates (resume keeps context)
        state.queue.close();
      }
      break;
    }
    case 'rpcResult':
      pendingRpcs.get(msg.id)?.settle(msg.result);
      break;
    case 'ask':
      void handleAsk(msg);
      break;
  }
}

function handleConnection(ws: WebSocket) {
  if (bridge && bridge !== ws) bridge.terminate(); // newest bridge wins
  bridge = ws;

  ws.on('message', (raw) => {
    try {
      handleBridgeMessage(JSON.parse(String(raw)) as BridgeToWorker);
    } catch (err) {
      console.warn('[worker] bad bridge message:', err);
    }
  });
  ws.on('close', () => {
    if (bridge === ws) bridge = null;
  });
  ws.on('error', (err) => {
    console.warn('[worker] bridge socket error:', (err as Error).message);
    ws.close();
  });

  // Handshake order matters: hello (version + live sessions for status
  // reconciliation) -> buffered events -> unanswered rpcs (resend: true).
  ws.send(
    JSON.stringify({
      type: 'hello',
      version: PROTOCOL_VERSION,
      startedAt,
      live: [...sessions].map(([sessionId, s]) => ({
        sessionId,
        claudeSessionId: s.claudeSessionId,
        busy: s.busy,
      })),
    } satisfies WorkerToBridge),
  );
  for (const msg of outbox.splice(0)) ws.send(JSON.stringify(msg));
  for (const [id, p] of pendingRpcs) {
    ws.send(
      JSON.stringify({
        type: 'rpc',
        id,
        sessionId: p.sessionId,
        kind: p.kind,
        resend: true,
        payload: p.payload,
      } satisfies WorkerToBridge),
    );
  }
}

// Port bind with retry: a dying predecessor (worker self-restart under tsx
// watch) may still hold the port for a moment.
let listenAttempts = 0;
function listen() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: WORKER_PORT });
  wss.on('listening', () => {
    console.log(`lines worker listening on ws://127.0.0.1:${WORKER_PORT}`);
  });
  wss.on('connection', handleConnection);
  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && listenAttempts < 20) {
      listenAttempts++;
      console.warn(`[worker] port ${WORKER_PORT} busy, retrying (${listenAttempts}/20)…`);
      wss.close();
      setTimeout(listen, 500);
    } else {
      throw err;
    }
  });
}

listen();
