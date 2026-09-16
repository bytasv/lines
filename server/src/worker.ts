// SPDX-License-Identifier: AGPL-3.0-only
// Additional permission under GNU AGPL v3 section 7 — see LICENSE-EXCEPTION.

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
import { devRuntime } from './devRuntime.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  PROTOCOL_VERSION,
  WORKER_PORT,
  WORKER_TOKEN_HEADER,
  clearRuntimeInfo,
  mcpAuthSupport,
  mergeMcpServers,
  newRuntimeToken,
  publishRuntimeInfo,
  staleDynamicServers,
  type BridgeToWorker,
  type McpToolManifest,
  type McpToolResult,
  type RpcKind,
  type WorkerToBridge,
} from './workerProtocol.ts';
import { buildMcpServer } from './workerMcp.ts';
import {
  closeCodex,
  shutdownCodex,
  codexLiveInfo,
  codexMcpStatus,
  forkCodex,
  hasCodexSession,
  interruptCodex,
  pushCodex,
} from './workerCodex.ts';

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
  /**
   * The Lines in-process MCP server this query was created with, and its name.
   *
   * Stashed because `setMcpServers` *destroys* an in-process server omitted from
   * its payload (measured: `removed: ['lines']`), so every later replace has to
   * re-include this exact instance. The instance, not the manifest: its handler
   * closes over the session id, and rebuilding one per call would tear down a
   * live server for nothing. Absent when the session was created with no tools.
   */
  linesServerName?: string;
  linesServer?: unknown;
}

interface PendingRpc {
  sessionId: string;
  kind: RpcKind;
  payload: Record<string, unknown>;
  settle: (result: unknown) => void;
}

/**
 * Injected by the desktop bundler (esbuild `--define`); undefined under tsx,
 * Tilt and every test — hence the `typeof` guard. Same idiom as the bridge's
 * BRIDGE_VERSION, which this is the worker-side twin of.
 */
declare const __LINES_VERSION__: string | undefined;

/** Reported on `hello` so the Updates pane can show a worker that outlived a
 *  bridge upgrade. Read from disk rather than imported, like the bridge does it;
 *  a missing manifest is cosmetic. */
const WORKER_VERSION: string = (() => {
  try {
    const pkg = fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8');
    return (JSON.parse(pkg) as { version?: string }).version ?? '0.0.0';
  } catch {
    return typeof __LINES_VERSION__ === 'string' ? __LINES_VERSION__ : '0.0.0';
  }
})();

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
 * Dispatch one `ask` against a live Query. Split out of handleAsk so the reply
 * plumbing stays one shape regardless of which method ran.
 *
 * The two OAuth methods are guarded by `mcpAuthSupport` rather than called
 * directly: they exist in the SDK bundle but not in its typings, so an upgrade
 * that renames them must surface as a reportable error here instead of a
 * TypeError. `mcp-auth-unsupported` is what the bridge turns into UI copy.
 */
async function runAsk(
  msg: Extract<BridgeToWorker, { type: 'ask' }>,
  state: SessionState,
): Promise<unknown> {
  const q = state.query;
  const params = msg.params ?? {};
  switch (msg.method) {
    case 'mcpStatus':
      return q.mcpServerStatus();
    case 'mcpAuthStart': {
      const support = mcpAuthSupport(q);
      if (!support.ok) throw new Error(`mcp-auth-unsupported:${support.missing.join(',')}`);
      return support.api.mcpAuthenticate(String(params.serverName ?? ''), String(params.redirectUri ?? ''));
    }
    case 'mcpAuthCallback': {
      const support = mcpAuthSupport(q);
      if (!support.ok) throw new Error(`mcp-auth-unsupported:${support.missing.join(',')}`);
      await support.api.mcpSubmitOAuthCallbackUrl(
        String(params.serverName ?? ''),
        String(params.callbackUrl ?? ''),
      );
      // Reconnect on this side: the token is now stored, but the server is still
      // parked in `needs-auth` until something re-dials it. Typed API, so no probe.
      await q.reconnectMcpServer(String(params.serverName ?? ''));
      return q.mcpServerStatus();
    }
    case 'mcpSetServers': {
      const wanted = (params.mcpServers ?? {}) as Record<string, unknown>;
      // Lines re-included on every replace, and last, for the same two reasons
      // ensureSession merges it: an omitted in-process server is destroyed, and a
      // same-named user connection must never win the `mcp__lines__*` namespace.
      const payload =
        state.linesServerName && state.linesServer !== undefined
          ? mergeMcpServers(wanted, state.linesServerName, state.linesServer)
          : { ...wanted };
      const result = await q.setMcpServers(payload as never);
      // A replace cannot remove a process-based server it omits, so the ones the
      // user turned off have to be named — see staleDynamicServers.
      for (const name of staleDynamicServers(await q.mcpServerStatus(), payload)) {
        // Both throws are expected and neither means failure: an unknown name
        // throws `Server not found`, and a *successful* toggle throws
        // `Server status: needs-auth`. The status read below is the real answer.
        await q.toggleMcpServer(name, false).catch(() => {});
      }
      return { result, servers: await q.mcpServerStatus() };
    }
    case 'contextUsage':
    default:
      return q.getContextUsage();
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
  // The one ask allowed to run without a live query, because creating one is what
  // it does — hence handled here rather than in runAsk, ahead of the check below.
  // No `busy` flag is set: nothing is pushed, so no turn is running.
  if (msg.method === 'mcpWarm') {
    const params = msg.params ?? {};
    try {
      const warmed = ensureSession(
        msg.sessionId,
        (params.options ?? {}) as Record<string, unknown>,
        params.tools as McpToolManifest | undefined,
      );
      reply({ type: 'askResult', id: msg.id, ok: true, value: await warmed.query.mcpServerStatus() });
    } catch (err) {
      reply({ type: 'askResult', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  // Codex's own ask, handled before the Claude session lookup for the same reason
  // the engine dispatch is first: a codex session has no Query to read.
  if (msg.method === 'codexFork') {
    const lastTurnId = String((msg.params ?? {}).lastTurnId ?? '');
    // Optional: a rewind across a provider switch names the abandoned thread,
    // which this worker holds no binding for.
    const threadId = String((msg.params ?? {}).threadId ?? '') || undefined;
    const forked = await forkCodex(msg.sessionId, lastTurnId, threadId);
    reply({ type: 'askResult', id: msg.id, ok: true, value: forked });
    return;
  }
  if (msg.method === 'codexMcpStatus') {
    // Deliberately not gated on a live codex session: the app-server holds the
    // MCP servers for the whole CODEX_HOME, so it can answer for a session that
    // has never run a turn — which is exactly when Settings asks.
    reply({ type: 'askResult', id: msg.id, ok: true, value: await codexMcpStatus() });
    return;
  }
  const state = sessions.get(msg.sessionId);
  if (!state) {
    reply({ type: 'askResult', id: msg.id, ok: false, error: 'no-live-session' });
    return;
  }
  try {
    reply({ type: 'askResult', id: msg.id, ok: true, value: await runAsk(msg, state) });
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
    case 'elicitation':
      // Cancel, not decline: the user never saw the request, so this is "nobody
      // answered", which is what the MCP server should be told.
      return { action: 'cancel' };
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
  // Built ahead of the options object so the instance can be kept on the session
  // state — see SessionState.linesServer for why a later replace needs it.
  const linesServer = tools
    ? buildMcpServer(
        tools,
        (toolName, args, signal) =>
          rpcCall(sessionId, 'mcpTool', { tool: toolName, args }, signal) as Promise<McpToolResult>,
      )
    : undefined;
  const fullOptions = {
    ...options,
    stderr: (data: string) => {
      if (data.trim()) console.error(`[claude:${sessionId.slice(0, 8)}]`, data.trim());
    },
    canUseTool: (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) =>
      rpcCall(sessionId, 'canUseTool', { toolName, input }, opts.signal),
    // An MCP server asking the user for something — in practice an OAuth
    // authorization URL. Lives here for the same reason canUseTool does: it is a
    // function, so it cannot ride the serialized options, and the decision itself
    // belongs to the bridge.
    onElicitation: (request: Record<string, unknown>, opts: { signal: AbortSignal }) =>
      rpcCall(sessionId, 'elicitation', { request }, opts.signal) as Promise<{
        action: 'accept' | 'decline' | 'cancel';
      }>,
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
    //
    // MERGED over whatever `options.mcpServers` carried (the user's own
    // connections, which are plain serializable config), never a replacement for
    // it — see mergeMcpServers for why the Lines entry has to win.
    ...(tools && linesServer
      ? { mcpServers: mergeMcpServers(options.mcpServers, tools.serverName, linesServer) }
      : {}),
  };

  const q = query({ prompt: queue as AsyncIterable<SDKUserMessage>, options: fullOptions as never });
  state = {
    queue,
    query: q,
    busy: false,
    ...(tools && linesServer ? { linesServerName: tools.serverName, linesServer } : {}),
  };
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
  // Engine dispatch first, before anything reaches the Claude session map.
  //
  // Not optional: the control cases below are `sessions.get(id)?.query.foo(...)`,
  // where the `?.` guards only the map lookup — a codex session reaching one of
  // them would throw a synchronous TypeError past the attached `.catch()`, in the
  // one process whose job is to survive.
  if (msg.type === 'push' && msg.engine === 'codex') {
    pushCodex(msg.sessionId, msg.options, msg.message, {
      event: (sessionId, message) => send({ type: 'event', sessionId, message }),
      ended: (sessionId, error) => send({ type: 'ended', sessionId, error }),
      // The same rpc the Claude side's canUseTool uses, so a codex approval lands
      // in the same card, under the same guard, with the same provenance.
      approve: (sessionId, toolName, input) =>
        rpcCall(sessionId, 'canUseTool', { toolName, input }) as Promise<{
          behavior?: string;
          message?: string;
          /** Question text -> chosen label(s); set only for `AskUserQuestion`. */
          answers?: Record<string, string>;
        }>,
    });
    return;
  }
  if ('sessionId' in msg && hasCodexSession(msg.sessionId)) {
    switch (msg.type) {
      case 'interrupt':
        interruptCodex(msg.sessionId);
        return;
      case 'close':
        closeCodex(msg.sessionId);
        return;
      // stopTask / setModel / setPermissionMode have no codex equivalent: thread
      // options bind at startThread, so the bridge applies them to the next turn
      // rather than to this one. Dropped rather than forwarded.
      case 'stopTask':
      case 'setModel':
      case 'setPermissionMode':
        return;
      default:
        break;
    }
  }
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
      void devRuntime.run(() => handleAsk(msg)).catch((error) => {
        send({ type: 'askResult', id: msg.id, ok: false, error: String(error) });
      });
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
      appVersion: WORKER_VERSION,
      startedAt,
      live: [
        ...[...sessions].map(([sessionId, s]) => ({
          sessionId,
          claudeSessionId: s.claudeSessionId,
          busy: s.busy,
          backgroundTasks: s.backgroundTasks,
        })),
        // Codex sessions are live too — a bridge that restarted mid-codex-turn
        // must not reconcile one as dead, and repairs its `codexThreadId` here.
        ...codexLiveInfo(),
      ],
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
let readinessPort = 0;
let listenAttempts = 0;
function listen() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: WORKER_PORT });
  wss.on('listening', () => {
    // The bound port, not WORKER_PORT: the default is 0, so the OS picked one.
    // Publishing is what makes the worker reachable at all — the bridge has no
    // other way to learn the port, and handleConnection rejects anyone who
    // cannot echo the token in this file.
    const { port } = wss.address() as { port: number };
    readinessPort = port;
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
    for (const session of sessions.values()) {
      try { session.query.close(); } catch { /* already closed */ }
    }
    shutdownCodex();
    process.exit(0);
  });
}
process.on('exit', () => clearRuntimeInfo('worker'));

devRuntime.configure(() => ({
  ready: !!readinessPort,
  blockers: [
    ...[...sessions].filter(([, s]) => s.busy || s.backgroundTasks?.length).map(([id]) => `Claude ${id}`),
    ...codexLiveInfo().filter((s) => s.busy).map((s) => `Codex ${s.sessionId}`),
    ...(pendingRpcs.size ? ['pending RPCs'] : []),
    ...(outbox.length ? ['undelivered events'] : []),
  ],
}));
listen();
