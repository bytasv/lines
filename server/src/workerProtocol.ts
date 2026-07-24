/**
 * Wire protocol between the bridge (restarts freely under tsx watch) and the
 * worker (owns the Claude CLI child processes; restarts only when this file
 * or worker.ts changes).
 *
 * KEEP THIS FILE MINIMAL AND STABLE. The worker's runtime import graph is
 * worker.ts + this file + the SDK — nothing else — so tsx watch only restarts
 * the worker (killing in-flight agent turns) when the protocol itself changes.
 * Import from '@lines/shared' with `import type` only, if at all.
 */

export const PROTOCOL_VERSION = 1;
export const WORKER_PORT = Number(process.env.CLAUDE_UI_WORKER_PORT ?? 8788);

export type RpcKind = 'canUseTool' | 'preToolUse';

export type BridgeToWorker =
  /**
   * Deliver a user message. `options` is the full serializable query-options
   * object; the worker uses it only when no live query exists for the session
   * (creation is lazy and idempotent — no separate "ensure" message, so a
   * push can never race an ensure).
   */
  | { type: 'push'; sessionId: string; message: unknown; options: Record<string, unknown> }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'setModel'; sessionId: string; model: string }
  /** `mode` is pre-mapped to an SDK mode by the bridge (our 'auto' -> 'acceptEdits'). */
  | { type: 'setPermissionMode'; sessionId: string; mode: string }
  /** Kill the session's query (options change, deletion). Resume revives context. */
  | { type: 'close'; sessionId: string }
  /** Answer to a worker->bridge rpc. Unknown/settled ids are ignored. */
  | { type: 'rpcResult'; id: string; result: unknown };

export interface LiveSessionInfo {
  sessionId: string;
  /** CLI session id, so the bridge can repair its persisted resume pointer. */
  claudeSessionId?: string;
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
  | { type: 'rpcCancel'; id: string };
