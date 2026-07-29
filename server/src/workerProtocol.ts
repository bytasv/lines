/**
 * Wire protocol between the bridge (restarts freely under tsx watch) and the
 * worker (owns the Claude CLI child processes; restarts only when this file
 * or worker.ts changes).
 *
 * KEEP THIS FILE MINIMAL AND STABLE. The worker's runtime import graph is
 * worker.ts + this file + workerMcp.ts + the SDK — nothing else — so tsx watch
 * only restarts the worker (killing in-flight agent turns) when the protocol
 * itself changes. Import from '@lines/shared' with `import type` only, if at all.
 */

export const PROTOCOL_VERSION = 3;
export const WORKER_PORT = Number(process.env.CLAUDE_UI_WORKER_PORT ?? 8788);

export type RpcKind = 'canUseTool' | 'preToolUse' | 'mcpTool';

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

/** MCP `CallToolResult`, narrowed to the text content our tools return. */
export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * Bridge->worker requests that expect exactly one `askResult`. Methods read the
 * live Query handle (which only the worker owns); adding one here is not a
 * protocol bump, adding a message type is.
 */
export type AskMethod = 'contextUsage';

export type BridgeToWorker =
  /**
   * Deliver a user message. `options` is the full serializable query-options
   * object; the worker uses it only when no live query exists for the session
   * (creation is lazy and idempotent — no separate "ensure" message, so a
   * push can never race an ensure).
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
  | { type: 'setModel'; sessionId: string; model: string }
  /** `mode` is pre-mapped to an SDK mode by the bridge (our 'auto' -> 'acceptEdits'). */
  | { type: 'setPermissionMode'; sessionId: string; mode: string }
  /** Kill the session's query (options change, deletion). Resume revives context. */
  | { type: 'close'; sessionId: string }
  /** Answer to a worker->bridge rpc. Unknown/settled ids are ignored. */
  | { type: 'rpcResult'; id: string; result: unknown }
  /** Read something off the live Query handle; answered by exactly one `askResult`. */
  | { type: 'ask'; id: string; sessionId: string; method: AskMethod };

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
