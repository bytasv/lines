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
 * KEEP THE IMPORT GRAPH MINIMAL (stdlib + ws + zod + SDK + workerProtocol.ts +
 * workerMcp.ts): this file runs under tsx watch too, and only restarts when its
 * own graph changes — which is exactly when a restart is unavoidable anyway.
 *
 * workerMcp.ts qualifies for the same reason workerProtocol.ts does: it only
 * turns protocol-shaped JSON Schema into MCP tool definitions whose handlers
 * call back into the bridge, so it holds no domain knowledge and changes about
 * as often as the protocol. The tools themselves (names, descriptions, argument
 * shapes) are authored on the bridge and arrive as data on `push`.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  PROTOCOL_VERSION,
  WORKER_PORT,
  WORKER_TOKEN_HEADER,
  clearRuntimeInfo,
  newRuntimeToken,
  publishRuntimeInfo,
  type BridgeToWorker,
  type McpToolManifest,
  type McpToolResult,
  type RpcKind,
  type WorkerToBridge,
} from './workerProtocol.ts';
import { buildMcpServer } from './workerMcp.ts';

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
  /** Last `background_tasks_changed` payload for this query — the live set of
   *  backgrounded subagents/Bash commands. Reported in hello because the bridge's
   *  own copy dies with the bridge while these CLI children do not. */
  backgroundTasks?: { task_id: string; task_type: string; description: string }[];
}

interface PendingRpc {
  sessionId: string;
  kind: RpcKind;
  payload: Record<string, unknown>;
  settle: (result: unknown) => void;
}

const startedAt = Date.now();
/** Minted per boot and published (0600) in worker.json. The bridge must echo it
 *  to connect — see the note on RuntimeInfo.token. */
const bootToken = newRuntimeToken();
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

/**
 * The SDK's MCP tool timeout is effectively unbounded by default, so a tool call
 * issued to a bridge that then went away would park the turn forever. Shorter
 * than the hook fallback: nothing downstream retries an MCP tool call, and the
 * model can recover from an error result on its own.
 */
const MCP_TOOL_FALLBACK_MS = 30_000;

/**
 * Per-kind deadline for a bridge that never answers, and what to answer in its
 * place. canUseTool is absent deliberately: the SDK parks it with no deadline,
 * and a permission request is exactly the thing that must wait for a human.
 */
const RPC_FALLBACK: Partial<Record<RpcKind, { ms: number; result: unknown }>> = {
  preToolUse: {
    ms: HOOK_FALLBACK_MS,
    result: {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'Bridge unavailable — escalated to a permission prompt.',
      },
    },
  },
  mcpTool: {
    ms: MCP_TOOL_FALLBACK_MS,
    result: {
      content: [{ type: 'text', text: 'The Lines bridge is unavailable — try again in a moment.' }],
      isError: true,
    } satisfies McpToolResult,
  },
};

/** How to answer a pending rpc that the bridge can no longer decide. */
function unavailableResult(kind: RpcKind, message: string): unknown {
  switch (kind) {
    case 'canUseTool':
      return { behavior: 'deny', message };
    case 'mcpTool':
      return { content: [{ type: 'text', text: message }], isError: true } satisfies McpToolResult;
    default:
      return { continue: true };
  }
}

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

    const fallback = RPC_FALLBACK[kind];
    if (fallback) {
      timer = setTimeout(() => {
        if (bridge?.readyState === WebSocket.OPEN) return; // bridge alive — keep waiting
        settle(fallback.result);
      }, fallback.ms);
      timer.unref();
    }

    signal?.addEventListener('abort', () => {
      send({ type: 'rpcCancel', id });
      settle(unavailableResult(kind, 'Interrupted.'));
    });

    if (bridge?.readyState === WebSocket.OPEN) {
      bridge.send(JSON.stringify({ type: 'rpc', id, sessionId, kind, payload } satisfies WorkerToBridge));
    }
    // else: delivered by the reconnect handler from pendingRpcs.
  });
}

function ensureSession(
  sessionId: string,
  options: Record<string, unknown>,
  tools?: McpToolManifest,
): SessionState {
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
    // One server instance per session, never a cached singleton: the handler has
    // to close over this sessionId so the bridge can route the call to the
    // owning user context. MCP's own `extra` carries no Lines session id.
    ...(tools
      ? {
          mcpServers: {
            [tools.serverName]: buildMcpServer(
              tools,
              (toolName, args, signal) =>
                rpcCall(sessionId, 'mcpTool', { tool: toolName, args }, signal) as Promise<McpToolResult>,
            ),
          },
        }
      : {}),
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
      // Level signal, REPLACE semantics; nothing is emitted at CLI startup, so an
      // `init` resets the set. Recorded verbatim — the worker interprets nothing.
      if (msg.type === 'system') {
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype === 'background_tasks_changed') {
          state.backgroundTasks = (msg as { tasks?: SessionState['backgroundTasks'] }).tasks ?? [];
        } else if (subtype === 'init') {
          state.backgroundTasks = undefined;
        }
      }
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
      p.settle(unavailableResult(p.kind, 'Session ended.'));
    }
  }
}

function handleBridgeMessage(msg: BridgeToWorker) {
  switch (msg.type) {
    case 'push': {
      const state = ensureSession(msg.sessionId, msg.options, msg.tools);
      state.busy = true;
      state.queue.push(msg.message as SDKUserMessage);
      break;
    }
    case 'interrupt':
      sessions.get(msg.sessionId)?.query.interrupt().catch((err) => console.warn('[worker] interrupt', err));
      break;
    case 'stopTask':
      sessions
        .get(msg.sessionId)
        ?.query.stopTask(msg.taskId)
        .catch((err) => console.warn('[worker] stopTask', err));
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

function handleConnection(ws: WebSocket, req: IncomingMessage) {
  // Check the token *before* the newest-bridge-wins takeover below: otherwise
  // any local process could terminate the real bridge just by connecting.
  if (req.headers[WORKER_TOKEN_HEADER] !== bootToken) {
    console.warn('[worker] rejected connection with a missing or stale token');
    ws.close(1008, 'unauthorized');
    return;
  }
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
        backgroundTasks: s.backgroundTasks,
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
    // The bound port, not WORKER_PORT: the default is 0, so the OS picked one.
    // Publishing is what makes the worker reachable at all — the bridge has no
    // other way to learn the port, and handleConnection rejects anyone who
    // cannot echo the token in this file.
    const { port } = wss.address() as { port: number };
    publishRuntimeInfo('worker', {
      port,
      pid: process.pid,
      startedAt,
      protocolVersion: PROTOCOL_VERSION,
      token: bootToken,
    });
    console.log(`lines worker listening on ws://127.0.0.1:${port}`);
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

// tsx watch restarts this process with SIGTERM; a stale worker.json left behind
// would point the bridge at a dead port until the pid check in readRuntimeInfo
// caught it. Clearing on the way out makes the common case exact.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearRuntimeInfo('worker');
    process.exit(0);
  });
}
process.on('exit', () => clearRuntimeInfo('worker'));

listen();
