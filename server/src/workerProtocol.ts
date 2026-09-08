/**
 * Wire protocol between the bridge (restarts freely under tsx watch) and the
 * worker (owns the Claude CLI child processes; restarts only when this file
 * or worker.ts changes).
 *
 * KEEP THIS FILE MINIMAL AND STABLE. The worker's runtime import graph is
 * worker.ts + this file + workerMcp.ts + the SDK — nothing else — so tsx watch
 * only restarts the worker (killing in-flight agent turns) when the protocol
 * itself changes. Import from '@lines/shared' with `import type` only, if at all.
 * Node stdlib is fine (see the runtime-discovery section below); anything else
 * is not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// v4 = ephemeral ports + the runtime-discovery handshake below. A v3 bridge and
// a v4 worker cannot find each other at all, which the version check in
// workerClient.ts reports as the protocol mismatch it is.
// v5 = the `stopTask` message (background tasks).
export const PROTOCOL_VERSION = 5;

/** Explicit pin for local dev; unset means "bind :0 and let the OS pick", which
 *  is the default so two Lines instances can never fight over a port. */
export const WORKER_PORT = Number(process.env.LINES_WORKER_PORT ?? 0);

/** Carries the discovery-file token on the bridge's connect request. A header
 *  rather than a query param so it cannot leak into a URL that gets logged. */
export const WORKER_TOKEN_HEADER = 'x-lines-worker-token';

/* ------------------------------------------------------------------ *
 * Runtime discovery
 *
 * Nothing hardcodes a port. Each local listener binds an ephemeral one and
 * publishes it to `~/.lines-app/run/<instance>/<name>.json`; whoever needs to
 * reach it reads (and watches) that file.
 *
 * This lives here rather than in a module of its own because it *is* part of
 * the bridge<->worker contract, and this file is already inside the worker's
 * deliberately-minimal import graph — a separate module would widen the
 * worker's tsx-watch restart trigger for no benefit.
 * ------------------------------------------------------------------ */

/** Machine-global app root. Re-exported by store.ts, which owns everything else
 *  under it; defined here so the worker can reach it without importing store.ts
 *  (and dragging the whole bridge graph into the worker). */
export const APP_ROOT = path.join(os.homedir(), '.lines-app');

/** Separates concurrent Lines installs on one machine — the desktop shell sets
 *  `desktop`, so an installed app and a dev checkout (which leaves this unset, and
 *  so is `default`) do not publish over each other. Tilt deliberately sets nothing:
 *  web/vite.config.ts resolves /__bridge from this same variable, so pinning it for
 *  the bridge alone would stop the dev server finding it. */
export const INSTANCE = process.env.LINES_INSTANCE ?? 'default';

export const RUNTIME_DIR = path.join(APP_ROOT, 'run', INSTANCE);

export type RuntimeName = 'worker' | 'bridge';

export interface RuntimeInfo {
  port: number;
  pid: number;
  startedAt: number;
  protocolVersion: number;
  /** Per-boot secret the peer must present to connect. The file is 0600, so
   *  this is what stops another process on the same host from driving a worker
   *  that is otherwise protected only by its 127.0.0.1 binding. */
  token: string;
}

const runtimeFile = (name: RuntimeName, instance: string = INSTANCE) =>
  path.join(APP_ROOT, 'run', instance, `${name}.json`);

export const newRuntimeToken = () => randomBytes(32).toString('hex');

/** Publish atomically (write temp + rename) so a reader never sees a partial
 *  file, and 0600 so the token stays private to this OS user. */
export function publishRuntimeInfo(name: RuntimeName, info: RuntimeInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const target = runtimeFile(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** True unless the pid is demonstrably gone. EPERM means it exists but belongs
 *  to another user, which still counts as alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read a peer's published info, or null if it is missing, unparseable, or
 * names a dead process (in which case the stale file is removed).
 *
 * A file that outlived a SIGKILL and now names an unrelated live pid still
 * reads as valid here — the handshake token is what makes that case fail
 * closed rather than connecting to a stranger.
 *
 * `instance` defaults to ours. The bridge passes another install's instance for
 * exactly one reason: cross-checking a pid named by ~/.lines-app/bridge.lock
 * before signalling it (server/src/index.ts).
 */
export function readRuntimeInfo(name: RuntimeName, instance?: string): RuntimeInfo | null {
  const file = runtimeFile(name, instance);
  let info: RuntimeInfo;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimeInfo;
  } catch {
    return null;
  }
  if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') return null;
  if (!pidAlive(info.pid)) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* raced with another reader; harmless */
    }
    return null;
  }
  return info;
}

/** Best-effort removal on clean exit. A crash leaves the file behind; that is
 *  what the pid check and the token are for. */
export function clearRuntimeInfo(name: RuntimeName): void {
  try {
    fs.unlinkSync(runtimeFile(name));
  } catch {
    /* already gone */
  }
}

/**
 * Watch for a peer republishing (restart on a fresh port). Watches the
 * directory, not the file: publishing renames over the target, so a file watch
 * would keep following the replaced inode.
 */
export function watchRuntimeInfo(name: RuntimeName, onChange: () => void): () => void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  let debounce: NodeJS.Timeout | null = null;
  const watcher = fs.watch(RUNTIME_DIR, (_event, filename) => {
    if (filename && filename !== `${name}.json`) return;
    if (debounce) clearTimeout(debounce);
    // A rename fires several events; coalesce so we re-dial once.
    debounce = setTimeout(onChange, 50);
  });
  watcher.on('error', () => {
    /* the dir went away; the reconnect loop keeps retrying regardless */
  });
  // Never let the watcher be the reason a process stays alive: the bridge is
  // held open by its own listener, while a short-lived consumer (a test, a CLI)
  // must still be able to exit.
  watcher.unref();
  return () => {
    if (debounce) clearTimeout(debounce);
    watcher.close();
  };
}

export type RpcKind = 'canUseTool' | 'preToolUse' | 'mcpTool' | 'elicitation';

/**
 * Closed subset of JSON Schema used by the tool manifest below. Deliberately
 * small: the worker converts it to Zod at runtime, and every shape the bridge
 * can express has to be one the converter understands.
 */
export type JsonSchemaType = 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';

export interface JsonSchemaNode {
  type?: JsonSchemaType;
  description?: string;
  /** `type: 'object'` only. */
  properties?: Record<string, JsonSchemaNode>;
  /** Property names that are not optional. Ignored outside objects. */
  required?: string[];
  /** `type: 'array'` only. */
  items?: JsonSchemaNode;
  /** String enums only — the converter has no use for mixed-type enums. */
  enum?: string[];
}

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchemaNode;
  /**
   * The tool only observes state. Bridge-side policy (it decides whether a call
   * raises a permission card), but carried here so the manifest is the single
   * description of the surface rather than a list to keep in sync elsewhere.
   */
  readOnly?: boolean;
}

/**
 * The in-process MCP server one session should expose. Sent with `push` so tool
 * authoring stays on the bridge (hot-reloadable) even though the server instance
 * — which holds a live, unserializable `McpServer` — must be built in the worker.
 */
export interface McpToolManifest {
  serverName: string;
  instructions?: string;
  tools: McpToolSpec[];
}

/**
 * Combine the user's own MCP servers (plain serializable config, carried on
 * `push.options`) with the Lines in-process server the worker just built.
 *
 * The Lines entry is written LAST and that ordering is load-bearing: a user
 * connection sharing its name would otherwise silently take over the
 * `mcp__lines__*` namespace, breaking every workflow with no error message.
 * Bridge-side validation refuses that name, but this is the invariant, so it is
 * enforced where the merge actually happens.
 *
 * Lives here rather than in worker.ts so a test can import it without starting
 * a worker; it is protocol shape, not behaviour.
 */
export function mergeMcpServers<T>(
  fromOptions: unknown,
  linesServerName: string,
  linesServer: T,
): Record<string, unknown> {
  const user =
    fromOptions && typeof fromOptions === 'object' && !Array.isArray(fromOptions)
      ? (fromOptions as Record<string, unknown>)
      : {};
  return { ...user, [linesServerName]: linesServer };
}

/**
 * Which live MCP servers a `setMcpServers(payload)` has left behind.
 *
 * `setMcpServers` adds and updates, and it destroys an in-process SDK server it
 * omits — but it does *not* remove a process-based (http/sse/stdio) server it
 * omits: measured, an omitted http server kept running on its old config. So a
 * connection the user disabled or deleted has to be switched off by name, and
 * this is the list of names to switch off.
 *
 * `scope: 'dynamic'` is the discriminator for "added by this SDK client". A
 * server from a settings file or a `claudeai-proxy` entry is the user's own and
 * must never be touched — Lines did not add it and has no business disabling it.
 * Already-disabled servers are skipped so a repeat call is a no-op.
 *
 * Lives here, next to mergeMcpServers, for the same reason: it is a decision
 * about protocol shape and needs no live Query, so a test can import it without
 * starting a worker.
 */
export function staleDynamicServers(
  statuses: unknown,
  payload: Record<string, unknown>,
): string[] {
  if (!Array.isArray(statuses)) return [];
  const stale: string[] = [];
  for (const entry of statuses) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, scope, status } = entry as { name?: unknown; scope?: unknown; status?: unknown };
    if (scope !== 'dynamic' || typeof name !== 'string' || !name) continue;
    if (status === 'disabled') continue;
    if (Object.prototype.hasOwnProperty.call(payload, name)) continue;
    stale.push(name);
  }
  return stale;
}

/** MCP `CallToolResult`, narrowed to the text content our tools return. */
export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * The runtime-only half of `Query` that MCP OAuth needs.
 *
 * These three exist in the SDK bundle but are absent from `sdk.d.ts`, so nothing
 * type-checks a call to them. They live here rather than in mcpAuth.ts because
 * the worker must probe them (it is the only side holding a Query) and the
 * worker's import graph is deliberately confined to this module — see the header
 * of worker.ts. mcpAuth.ts imports the list from here, so the canary test and the
 * call site cannot disagree about what is being relied on.
 */
export interface McpAuthApi {
  /** Leg 1: returns the URL the user must visit. `redirectUri` is honoured verbatim. */
  mcpAuthenticate(serverName: string, redirectUri?: string): Promise<unknown>;
  /** Leg 2: hand back the full callback URL the browser landed on. */
  mcpSubmitOAuthCallbackUrl(serverName: string, callbackUrl: string): Promise<unknown>;
}

/** Probed at runtime and asserted by mcpAuth.contract.test.ts. */
export const MCP_AUTH_METHODS = ['mcpAuthenticate', 'mcpSubmitOAuthCallbackUrl'] as const;

export type McpAuthSupport = { ok: true; api: McpAuthApi } | { ok: false; missing: string[] };

/**
 * Is this Query still able to drive an OAuth handshake?
 *
 * Probed per call, not once at boot: the claim that matters is "the method exists
 * on the handle about to be used", so a renamed or dropped method degrades into a
 * reportable answer instead of a TypeError mid-turn.
 */
export function mcpAuthSupport(q: unknown): McpAuthSupport {
  if (!q || (typeof q !== 'object' && typeof q !== 'function')) {
    return { ok: false, missing: [...MCP_AUTH_METHODS] };
  }
  const candidate = q as Record<string, unknown>;
  const missing = MCP_AUTH_METHODS.filter((name) => typeof candidate[name] !== 'function');
  return missing.length ? { ok: false, missing } : { ok: true, api: q as McpAuthApi };
}

/**
 * Bridge->worker requests that expect exactly one `askResult`. Methods read the
 * live Query handle (which only the worker owns); adding one here is not a
 * protocol bump, adding a message type is.
 */
export type AskMethod =
  | 'contextUsage'
  | 'mcpStatus'
  | 'mcpAuthStart'
  | 'mcpAuthCallback'
  /** Replace the session's user MCP servers on the live query (see mcpSetServers
   *  in worker.ts for why a replace alone is not enough to remove one). */
  | 'mcpSetServers'
  /**
   * Materialize a query for a session that has none, without running a turn.
   *
   * The odd one out: every other method reads a Query the worker already holds,
   * this one creates it. It is an `ask` rather than its own message type so that
   * adding it is not a protocol bump — and it is handled in `handleAsk` ahead of
   * the liveness check, since "no live query" is the whole point of the call.
   *
   * Why it works at all: the CLI child spawns with `query()` and answers control
   * requests while it waits for input, but emits nothing (not even `system:init`)
   * until a user message arrives. So a warmed session is readable and
   * authorizable, and costs no tokens. Verified against the installed SDK; see
   * mcpAuth.contract.test.ts.
   */
  | 'mcpWarm';

export type BridgeToWorker =
  /**
   * Deliver a user message. `options` is the full serializable query-options
   * object; the worker uses it only when no live query exists for the session
   * (creation is lazy and idempotent, and the one other path that creates a
   * query — the `mcpWarm` ask — funnels through the same `ensureSession`, so on
   * a single-threaded worker the two cannot race).
   *
   * `tools` is read on that same first push: the worker builds one MCP server
   * instance per session from it and every tool call comes back as an `mcpTool`
   * rpc. Omitted = the session gets no MCP tools.
   */
  | {
      type: 'push';
      sessionId: string;
      message: unknown;
      options: Record<string, unknown>;
      tools?: McpToolManifest;
    }
  | { type: 'interrupt'; sessionId: string }
  /** Stop one background task (a backgrounded subagent or Bash command). The CLI
   *  answers with a `task_notification` carrying `status: 'stopped'`, so nothing
   *  here has to guess when the task actually died. */
  | { type: 'stopTask'; sessionId: string; taskId: string }
  | { type: 'setModel'; sessionId: string; model: string }
  /** `mode` is pre-mapped to an SDK mode by the bridge (our 'auto' -> 'acceptEdits'). */
  | { type: 'setPermissionMode'; sessionId: string; mode: string }
  /** Kill the session's query (options change, deletion). Resume revives context. */
  | { type: 'close'; sessionId: string }
  /** Answer to a worker->bridge rpc. Unknown/settled ids are ignored. */
  | { type: 'rpcResult'; id: string; result: unknown }
  /**
   * Read something off (or drive something on) the live Query handle; answered by
   * exactly one `askResult`. `params` carries per-method arguments — adding it is
   * not a protocol bump for the same reason a new `AskMethod` value is not: an
   * older worker ignores a field it does not read, and the methods that need
   * arguments are exactly the ones it does not implement.
   */
  | { type: 'ask'; id: string; sessionId: string; method: AskMethod; params?: Record<string, unknown> };

export interface LiveSessionInfo {
  sessionId: string;
  /** CLI session id, so the bridge can repair its persisted resume pointer. */
  claudeSessionId?: string;
  /**
   * A turn is in flight (pushed, no `result` yet). `undefined` = a worker too
   * old to report it; the bridge then only demotes, as it always did. Adding
   * this field is not a protocol bump (see the note above AskMethod).
   */
  busy?: boolean;
  /**
   * Background tasks the session's CLI process still owns, as last reported by
   * `background_tasks_changed`. `undefined` = a worker too old to report it; the
   * bridge then leaves its own set alone, exactly as `busy: undefined` only
   * demotes. Survives a bridge restart, which the bridge's own live state does not.
   */
  backgroundTasks?: { task_id: string; task_type: string; description: string }[];
}

export type WorkerToBridge =
  /** Sent on every (re)connect, before buffered events and rpc re-sends. */
  | { type: 'hello'; version: number; startedAt: number; live: LiveSessionInfo[] }
  /** One SDK message from a session's query stream. */
  | { type: 'event'; sessionId: string; message: Record<string, unknown> }
  /** The session's query stream finished (error = it threw). */
  | { type: 'ended'; sessionId: string; error?: string }
  /**
   * A blocking callback from inside the CLI (permission request or PreToolUse
   * hook), forwarded for the bridge to decide. `id` doubles as the permission
   * requestId in the bridge transcript. `resend: true` = re-delivered after a
   * bridge restart; handlers must be idempotent per id.
   */
  | {
      type: 'rpc';
      id: string;
      sessionId: string;
      kind: RpcKind;
      resend?: boolean;
      payload: Record<string, unknown>;
    }
  /** The CLI aborted a pending rpc (e.g. interrupt) — drop the UI card. */
  | { type: 'rpcCancel'; id: string }
  /**
   * Answer to a bridge->worker `ask`. `value` is raw SDK JSON — the worker
   * normalizes nothing. Never buffered: a bridge that went away has already
   * timed the request out.
   */
  | ({ type: 'askResult'; id: string } & ({ ok: true; value: unknown } | { ok: false; error: string }));
