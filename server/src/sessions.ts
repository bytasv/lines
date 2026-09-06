import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { forkSession, query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Actor,
  Attachment,
  AttachmentKind,
  BackgroundTaskInfo,
  ContextBreakdown,
  ContextCompactBlockInfo,
  ContextCompactData,
  ContextUsage,
  FileChange,
  FilesChangedData,
  FileSnapshotData,
  InterjectData,
  MentionValue,
  PermissionMode,
  PermissionRequestData,
  PermissionResolutionSource,
  PlanComment,
  PromptAttachment,
  PromptMention,
  RewindBlockInfo,
  RewindPrompt,
  ServerMessage,
  SessionDiffRepo,
  SessionDiffResponse,
  SessionErrorKind,
  SessionMeta,
  SessionStatus,
  TranscriptEvent,
} from '@lines/shared';
import {
  addSpend,
  contextCompactBlock,
  formatPlanComments,
  isPlanFilePath,
  isSessionActive,
  isSessionInterruptible,
  KEEP_PLANNING_MESSAGE,
  resolveModelId,
  resultErrorText,
  rewindBlock,
  rootsForCwd,
  subagentParentId,
} from '@lines/shared';
import type { Store } from './store.ts';
import {
  captureBaseline,
  captureBaselines,
  changedBetween,
  changedFiles,
  groupByRepo,
  refExists,
  repoBranch,
  type RepoBaseline,
} from './git.ts';
import { COMPRESS_RESPONSES_PROMPT } from './caveman.ts';
import {
  ALWAYS_ASK_TOOLS,
  allowEntryFor,
  assessToolCall,
  isPlanPath,
  isSafePlanWrite,
  isSafeReadOnly,
  type GuardAllowlist,
} from './autoGuard.ts';
import {
  normalizeContextBreakdown,
  sameContextSummary,
  summarizeContextBreakdown,
} from './contextBreakdown.ts';
import { claudeCliRefusalMessage, claudeCliStatus } from './claudeCli.ts';
import { classifyTurnFailure, turnFailureAdvice, turnFailureRetryHint } from './turnFailure.ts';
import { isLinesMcpTool, isReadOnlyLinesTool, LINES_TOOL_MANIFEST } from './mcpWorkflowTools.ts';
import type { WorkerClient, WorkerRpc } from './workerClient.ts';
import type { LiveSessionInfo } from './workerProtocol.ts';
import {
  AuthRequiredError,
  isAuthFailureMessage,
  type AuthManager,
  type TokenRejection,
} from './auth.ts';

/** 'auto' is our guard layer on top of the SDK's acceptEdits mode. */
function sdkPermissionMode(mode: PermissionMode): string {
  return mode === 'auto' ? 'acceptEdits' : mode;
}

/**
 * Which `claude` binary every query runs, for the whole bridge.
 *
 * The packaged app ships no CLI, so leaving this to the SDK's own resolution
 * would mean the tray reporting one binary while turns silently used another (or
 * none). Absent only when discovery found nothing at all — in which case
 * `pushTurn` has already refused the turn.
 */
function claudeExecutableOption(): Record<string, unknown> {
  const cli = claudeCliStatus();
  return cli.path ? { pathToClaudeCodeExecutable: cli.path } : {};
}

/**
 * The shared shape of the bridge's own one-shot helper queries (autoName,
 * summarizeTurn, consolidateStepOutput): non-agentic, no tools, no setting
 * sources, the owner's OAuth token, and this machine's CLI. Extracted so the
 * four query sites cannot drift on any of that.
 */
function baseQueryOptions(token: string, model: string, systemPrompt: string): Record<string, unknown> {
  return {
    model,
    maxTurns: 1,
    allowedTools: [],
    settingSources: [],
    systemPrompt,
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
    ...claudeExecutableOption(),
  };
}

/** Why a turn was refused before it started, in one place (see pushTurn). */
function authRefusalMessage(err: unknown): string {
  if (err instanceof AuthRequiredError) return 'Not signed in to Claude. Sign in, then Retry.';
  const message = err instanceof Error ? err.message : String(err);
  return `Could not refresh the Claude login: ${message}. Check your connection, then Retry.`;
}

/**
 * What to tell the user after a turn failed on a rejected token and recovery has
 * resolved — the raw CLI text ("Re-authenticate to continue") names no action they
 * can take in this app. These strings deliberately avoid every word
 * AUTH_FAILURE_PATTERNS matches, so re-showing one cannot re-classify itself.
 */
export function authRecoveryMessage(rejection: TokenRejection): string {
  switch (rejection.outcome) {
    case 'refreshed':
      return 'The Claude login expired mid-turn and has been renewed. Retry to continue.';
    case 'signed-out':
      return 'The Claude login expired and could not be renewed. Sign in to Claude, then Retry.';
    case 'refresh-failed':
      return authRefusalMessage(rejection.error);
  }
}

/**
 * Context occupancy from a single `assistant` SDK message. Its usage covers one
 * API call, so the input components are the actual prompt size — unlike a
 * `result`'s usage, which aggregates every call in the turn (spend, not size).
 * Returns undefined when the message carries no usage.
 */
export function extractContextUsage(
  msg: Record<string, unknown>,
  model: string,
  at: number,
): ContextUsage | undefined {
  const usage = (msg.message as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const num = (key: string): number => {
    const v = usage[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  const inputTokens = num('input_tokens');
  const cacheReadTokens = num('cache_read_input_tokens');
  const cacheCreationTokens = num('cache_creation_input_tokens');
  const outputTokens = num('output_tokens');
  // Newer betas split cache creation into ephemeral 5m/1h buckets, so the
  // reported prompt total can exceed the components. Surface the gap, don't hide it.
  const reported = usage.prompt_tokens ?? usage.total_input_tokens;
  const sum = inputTokens + cacheReadTokens + cacheCreationTokens;
  const reportedTotal =
    typeof reported === 'number' && Number.isFinite(reported) && reported !== sum ? reported : undefined;
  return { inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens, reportedTotal, model, at };
}

/**
 * A compaction and everything it produced, removed from a transcript slice.
 * Turn scans (collectTurns and friends) must never see it: the summarization
 * turn has no user prompt of its own, so an unstripped compaction registers as
 * an extra workflow-step "attempt" whose output is the compaction summary —
 * which then becomes the `{previous}` hand-off to the next step.
 *
 * A span runs from a `phase:'requested'` marker to its matching `phase:'done'`.
 * An unmatched `requested` (the bridge died mid-compaction) is bounded by the
 * next `user` event rather than by the end of the array — otherwise one crash
 * would silently swallow the rest of the transcript forever.
 */
export function withoutCompactSpans(events: TranscriptEvent[]): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  let dropping = false;
  for (const event of events) {
    if (event.kind === 'context-compact') {
      // The markers themselves are display-only; scans never want them either.
      dropping = (event.data as ContextCompactData).phase === 'requested';
      continue;
    }
    if (dropping && event.kind === 'user') dropping = false; // the next turn closes an orphan span
    if (!dropping) out.push(event);
  }
  return out;
}

/**
 * Compaction facts from an SDK `system`/`compact_boundary` message, or undefined
 * for any other message. `trigger` is omitted when the metadata doesn't say —
 * the caller knows whether it asked for this one.
 */
export function extractCompactBoundary(
  msg: Record<string, unknown>,
): { trigger?: 'manual' | 'auto'; preTokens?: number; postTokens?: number } | undefined {
  if (msg.type !== 'system' || msg.subtype !== 'compact_boundary') return undefined;
  const md = (msg.compact_metadata ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  return {
    trigger: md.trigger === 'manual' || md.trigger === 'auto' ? md.trigger : undefined,
    preTokens: num(md.pre_tokens),
    postTokens: num(md.post_tokens),
  };
}

/** Cap on a persisted, synced compact_error — it rides SessionMeta everywhere. */
const COMPACT_ERROR_MAX = 200;

/**
 * Compaction outcome from an SDK `system`/`status` message — the authoritative
 * signal, unlike the absence of a boundary. Undefined for any other message and
 * for status messages that carry no compact verdict.
 */
export function extractCompactStatus(
  msg: Record<string, unknown>,
): { result: 'success' | 'failed'; error?: string } | undefined {
  if (msg.type !== 'system' || msg.subtype !== 'status') return undefined;
  const result = msg.compact_result;
  if (result !== 'success' && result !== 'failed') return undefined;
  const error = typeof msg.compact_error === 'string' ? msg.compact_error : undefined;
  return { result, error: error ? error.slice(0, COMPACT_ERROR_MAX) : undefined };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** How long persist() waits to coalesce a burst of session writes. Short enough
 *  that a crash can only ever lose the tail of one turn's transitions. */
const PERSIST_DEBOUNCE_MS = 250;

/** system subtypes nothing renders and nothing derives state from. Still broadcast
 *  (they keep the client's `lastEventAt` clock honest) but never written to disk:
 *  they are ~half of every transcript's lines and cost a reload for nothing. */
const EPHEMERAL_SYSTEM_SUBTYPES = new Set([
  'thinking_tokens',
  'status',
  'hook_started',
  'hook_response',
  'task_progress',
  'task_updated',
]);

interface PermissionAnswer {
  allow: boolean;
  updatedInput?: Record<string, unknown>;
  denyMessage?: string;
}

/** Tools whose write to a plan file can carry a plan-mode deliverable. */
const PLAN_WRITE_TOOLS = new Set(['Write', 'Edit']);

/** Cap on a plan file read back from disk, matching the /file route's limit. */
const MAX_PLAN_FILE_BYTES = 2 * 1024 * 1024;

interface TurnScan {
  user: string;
  lastText: string;
  /** ExitPlanMode's inline `plan` argument (older harness shape). */
  planArg?: string;
  /** Content of a plan file written in this turn (current harness shape). */
  planFileText?: string;
  /** Path of that write, so a plan revised by `Edit` can be read from disk. */
  planFilePath?: string;
  sawExitPlan: boolean;
}

/**
 * The plan file's current text, or undefined if it can't be read. Guarded by
 * `isPlanPath` (so only real plan directories are ever opened) and a size cap;
 * every failure degrades to the transcript-captured text.
 */
function readPlanFile(filePath: string, roots: string[]): string | undefined {
  try {
    if (!isPlanPath(filePath, roots)) return undefined;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_PLAN_FILE_BYTES) return undefined;
    const text = fs.readFileSync(filePath, 'utf8');
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split a transcript slice into turns: each `user` event opens one. A turn's output
 * is the plan it exited plan mode with, when it produced one — plan mode puts the
 * deliverable in the `ExitPlanMode` tool input (or in the plan file it wrote, since
 * the current harness passes no `plan` argument), and the turn's last *text* block is
 * then only trailing chatter. Otherwise the last text block, as before.
 *
 * The plan file's *current* text wins over the `Write` content captured in the
 * transcript, so a plan revised by `Edit` (which carries no full content) still
 * reaches the next step. `roots` gates that read via `isPlanPath`; with no roots
 * only `~/.claude/plans` is readable, and an unreadable file degrades to the
 * captured content — i.e. the previous transcript-local behaviour.
 */
export function collectTurns(
  events: TranscriptEvent[],
  from: number,
  roots: string[] = [],
): { user: string; output: string }[] {
  const turns: TurnScan[] = [];
  for (const ev of events.slice(Math.max(from, 0))) {
    if (ev.kind === 'user') {
      turns.push({ user: (ev.data as { text?: string }).text ?? '', lastText: '', sawExitPlan: false });
      continue;
    }
    if (ev.kind !== 'sdk') continue;
    // Subagent output belongs to its parent Task call, never to the turn: a subagent
    // that answers after the main agent's final text must not become the step output.
    if (subagentParentId(ev.data)) continue;
    const msg = ev.data as { type?: string; message?: { content?: unknown } };
    if (msg.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    // A slice that opens on assistant output (no user event yet) still has one turn.
    if (turns.length === 0) turns.push({ user: '', lastText: '', sawExitPlan: false });
    const turn = turns[turns.length - 1];
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        turn.lastText = block.text;
        continue;
      }
      if (block.type !== 'tool_use') continue;
      const input = (block.input ?? {}) as { plan?: unknown; file_path?: unknown; content?: unknown };
      if (block.name === 'ExitPlanMode') {
        turn.sawExitPlan = true;
        if (typeof input.plan === 'string' && input.plan.trim()) turn.planArg = input.plan;
        continue;
      }
      if (
        typeof block.name === 'string' &&
        PLAN_WRITE_TOOLS.has(block.name) &&
        typeof input.file_path === 'string' &&
        isPlanFilePath(input.file_path)
      ) {
        // Tracked even for an `Edit` (no `content` argument) — the path alone is
        // enough to read the revised plan back off disk.
        turn.planFilePath = input.file_path;
        if (typeof input.content === 'string' && input.content.trim()) {
          turn.planFileText = input.content;
        }
      }
    }
  }
  // Later blocks overwrite earlier ones, so a revised plan resolves to the final one.
  // The plan file only counts when the turn actually exited plan mode — an ordinary
  // step that happens to write into the plans directory keeps its text output.
  return turns.map((t) => {
    const planFile = t.sawExitPlan
      ? (t.planFilePath ? readPlanFile(t.planFilePath, roots) : undefined) ?? t.planFileText
      : undefined;
    return { user: t.user, output: t.planArg ?? planFile ?? t.lastText };
  });
}

/**
 * The tool calls, failed tool ids, and final text of a turn slice — the raw material
 * for the turn summary. Main-agent only: a subagent's own tool calls and text belong
 * to its parent `Task` card, and that `Task` call is itself in the list, so the
 * summary still reads as "spawned an Explore subagent".
 */
export function scanTurnActivity(events: TranscriptEvent[]): {
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  toolErrors: Set<string>;
  finalText: string;
} {
  const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
  const toolErrors = new Set<string>();
  let finalText = '';
  for (const ev of events) {
    if (ev.kind !== 'sdk') continue;
    if (subagentParentId(ev.data)) continue;
    const msg = ev.data as { type?: string; message?: { content?: unknown } };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') finalText = block.text;
          if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            toolCalls.push({ id: block.id, name: block.name, input: (block.input as Record<string, unknown>) ?? {} });
          }
        }
      }
    } else if (msg.type === 'user') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.is_error) {
            toolErrors.add(block.tool_use_id);
          }
        }
      }
    }
  }
  return { toolCalls, toolErrors, finalText };
}

/** Tools whose `file_path` argument names a file the agent wrote. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Absolute paths this session is known to have changed, for bucketing its review
 * diff into "yours" and "everything else dirty in this repo".
 *
 * Two sources, unioned:
 *
 * - `files-changed` events — the authoritative one. Each is a git snapshot window
 *   around a turn, so it sees every mechanism (a shell redirect, a script, an MCP
 *   tool), not just file-tool calls.
 * - `tool_use` arguments — a backstop for turns with no window: one that crashed
 *   before settling, or a session that predates the feature. Unlike
 *   `scanTurnActivity`, subagent blocks are **included** — a Task subagent's
 *   writes are this session's changes.
 *
 * `ambiguous` holds paths that only ever arrived through a window another session
 * was live in. A path a tool call names is claimed outright: that is direct
 * evidence, and it outranks the window's uncertainty.
 */
export function collectChangedPaths(
  events: TranscriptEvent[],
  roots: string[],
): { paths: string[]; ambiguous: string[] } {
  const paths = new Set<string>();
  const ambiguous = new Set<string>();
  for (const ev of events) {
    if (ev.kind === 'files-changed') {
      const data = ev.data as FilesChangedData;
      for (const repo of data?.repos ?? []) {
        for (const rel of repo.rels ?? []) {
          (repo.ambiguous ? ambiguous : paths).add(path.resolve(repo.repo, rel));
        }
      }
      continue;
    }
    if (ev.kind !== 'sdk') continue;
    const msg = ev.data as { type?: string; message?: { content?: unknown } };
    if (msg.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
      if (!FILE_WRITE_TOOLS.has(block.name)) continue;
      const file = (block.input as { file_path?: unknown } | undefined)?.file_path;
      if (typeof file !== 'string' || !file) continue;
      // A relative path from the agent is relative to its cwd, which is the
      // session's primary root.
      paths.add(path.isAbsolute(file) ? path.resolve(file) : path.resolve(roots[0] ?? '', file));
    }
  }
  for (const p of paths) ambiguous.delete(p);
  return { paths: [...paths], ambiguous: [...ambiguous] };
}

/**
 * Index of the `started` marker that opened `stepIndex`, scanning backwards so a
 * re-entered step resolves to its latest pass. Falls back to the newest `started`
 * marker of any step (and -1 when there is none), which is the pre-scoping
 * behaviour — used when the caller can't name a step.
 */
export function findStepStart(events: TranscriptEvent[], stepIndex?: number): number {
  let newestStarted = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== 'workflow') continue;
    const data = ev.data as { event?: string; stepIndex?: number };
    if (data.event !== 'started') continue;
    if (stepIndex === undefined || data.stepIndex === stepIndex) return i;
    if (newestStarted === -1) newestStarted = i;
  }
  return newestStarted;
}

/**
 * Permission requests recorded with no resolution, with the tool each asked for.
 * One pass: a busy session can hold hundreds of permission events, and resolving
 * each one against its own scan of the transcript was quadratic.
 */
export function unresolvedPermissions(
  events: TranscriptEvent[],
): { requestId: string; toolName: string }[] {
  const requested = new Map<string, string>();
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'permission') continue;
    const data = event.data as PermissionRequestData;
    if (!data.requestId) continue;
    if (data.resolution) resolved.add(data.requestId);
    else if (data.toolName) requested.set(data.requestId, data.toolName);
  }
  return [...requested]
    .filter(([id]) => !resolved.has(id))
    .map(([requestId, toolName]) => ({ requestId, toolName }));
}

export function unresolvedPermissionIds(events: TranscriptEvent[]): string[] {
  return unresolvedPermissions(events).map((p) => p.requestId);
}

/**
 * A card only a human may answer (plan approval, clarifying questions) is still
 * open. Auto-continue and card expiry both defer to this: nothing the server
 * does on its own may stand in for that decision.
 */
export function hasUnresolvedAlwaysAsk(events: TranscriptEvent[]): boolean {
  return unresolvedPermissions(events).some((p) => ALWAYS_ASK_TOOLS.has(p.toolName));
}

/**
 * A plan is up for review and the user typed into the composer instead of
 * clicking: that message *is* the "Keep planning" gesture. Decides which
 * pending request to deny and with what reason, or null to fall through to the
 * ordinary queue/prompt path.
 *
 * Pure: the caller supplies live pending ids and the transcript. The status gate
 * matters — flushPending deliberately leaves stale cards open, so an ancient
 * unresolved ExitPlanMode must not hijack an ordinary prompt.
 */
export function planReplyDecision(input: {
  status: SessionStatus;
  pendingPermissionTool?: string;
  text: string;
  hasAttachments: boolean;
  livePendingIds: string[];
  events: TranscriptEvent[];
}): { requestId: string; denyMessage: string; alsoQueue: boolean } | null {
  const text = input.text.trim();
  if (!text) return null;
  if (input.status !== 'waiting-permission') return null;
  if (input.pendingPermissionTool !== 'ExitPlanMode') return null;

  const requestId = exitPlanRequestId(input.events, input.livePendingIds);
  if (!requestId) return null;

  // Attachments can't ride a tool_result (plain string), so the deny only
  // unblocks the query and the real payload follows through the queue — the
  // reason must not repeat the text the queued turn will carry.
  return input.hasAttachments
    ? {
        requestId,
        denyMessage: `${KEEP_PLANNING_MESSAGE}\n\nTheir message and its attachments follow as the next turn.`,
        alsoQueue: true,
      }
    : {
        requestId,
        // Raw user text alone reads to the model as a rejection reason, not as
        // "stay in plan mode" — hence the wrapper.
        denyMessage: `${KEEP_PLANNING_MESSAGE}\n\nThe user's message:\n${text}`,
        alsoQueue: false,
      };
}

/**
 * The ExitPlanMode request to answer: a live pending one when the query is
 * still up, else the newest unresolved one in the transcript (orphan case —
 * resolvePermission routes that to recoverOrphanedPermission).
 */
function exitPlanRequestId(events: TranscriptEvent[], livePendingIds: string[]): string | undefined {
  const live = new Set(livePendingIds);
  const resolved = new Set<string>();
  let newestUnresolved: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind !== 'permission') continue;
    const data = event.data as PermissionRequestData;
    if (!data.requestId) continue;
    if (data.resolution) {
      resolved.add(data.requestId);
      continue;
    }
    if (data.toolName !== 'ExitPlanMode' || resolved.has(data.requestId)) continue;
    if (live.has(data.requestId)) return data.requestId;
    newestUnresolved ??= data.requestId;
  }
  return newestUnresolved;
}

/** SDK PermissionResult shape returned to the worker's canUseTool rpc. */
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

interface LiveState {
  seq: number;
  pendingPermissions: Map<string, (answer: PermissionAnswer) => void>;
  /** Wall-clock ms spent waiting on the user across this turn's permission
   *  prompts so far — subtracted from the SDK's duration_ms, which otherwise
   *  counts human approval wait as "active" time. Reset once read. */
  permissionWaitMs: number;
  /** Reading from the latest `assistant` message of the in-flight turn; committed
   *  to the meta when the turn settles, so the sidebar isn't re-rendered per message. */
  contextUsage?: ContextUsage;
  /** A compaction boundary landed inside the turn still in flight. Its remaining
   *  `assistant` messages can describe either side of the boundary, so none of
   *  them is a trustworthy occupancy reading — compact_metadata is. */
  compactedInTurn?: boolean;
  /** The status a manual compaction interrupted, put back when it settles. A
   *  compaction runs as an ordinary 'running' turn, so without this the settle
   *  branch would land a parked step on 'done' and wipe a failed step's red banner.
   *  Only set for statuses that carry step-lifecycle meaning (waiting-approval,
   *  error); an idle/done session settles the normal way. */
  compactResume?: { status: SessionStatus; errorMessage?: string; errorKind?: SessionErrorKind };
  /** Working-tree snapshot taken as the in-flight turn started, one per commit
   *  unit — the open end of the attribution window closed at settle. Live only:
   *  a turn that never settles simply leaves no window (see collectChangedPaths). */
  turnBaselines?: RepoBaseline[];
  /** Live background tasks, replaced wholesale from `background_tasks_changed`.
   *  Per-CLI-process: cleared on `init`, on `ended`, and whenever the query closes
   *  (see setBackgroundTasks). */
  backgroundTasks?: BackgroundTaskInfo[];
}

/**
 * Fired by {@link SessionManager.rewindSession} once the transcript is truncated
 * and broadcast, and before the session settles — the window in which a listener
 * may roll its own derived state back to what the surviving transcript shows, and
 * emit events of its own (they land after the truncation on the wire, so the
 * client keeps them).
 *
 * Returns true when the listener settled the session itself, e.g. parked it on a
 * workflow step; the caller must not then set 'idle' over that park. Same
 * contract as restoreCompactedStatus.
 */
export type RewindListener = (sessionId: string) => boolean;

export type TurnCompleteListener = (
  sessionId: string,
  source: 'user' | 'workflow',
  /** The turn settled under a Stop (see WorkflowEngine.onWorkflowTurnComplete). */
  interrupted: boolean,
  /** The turn ended in failure (is_error result, or a query that crashed) — the
   *  step parks as failed instead of auto-advancing. */
  failed: boolean,
) => void;

export class SessionManager {
  private sessions = new Map<string, SessionMeta>();
  /**
   * Deleted session id -> ms epoch of the delete. A delete has to be a positive
   * fact, not an absence: storage sync pushes rows both ways, so an absent session
   * is re-adopted from whichever peer has not heard yet.
   */
  private deletedAt = new Map<string, number>();
  private live = new Map<string, LiveState>();
  /** Sessions with a manual interrupt in flight — lets an `ended` without a
   *  `result` still settle the turn (see handleWorkerEnded). */
  private interrupting = new Set<string>();
  /** Sessions with a manual compaction in flight. Guards against a second
   *  concurrent request, and its survival past the turn's `result` is how we
   *  detect that no compaction happened (see handleWorkerEvent). */
  private compacting = new Set<string>();
  /** Sessions with a rewind in flight. Claimed before the fork's await, so two
   *  rapid requests cannot both pass the gate (see rewindSession). */
  private rewinding = new Set<string>();
  /** Access token each live worker query was spawned with (see pushTurn). */
  private queryTokens = new Map<string, string | null>();
  private onTurnComplete: TurnCompleteListener | null = null;
  private onRewind: RewindListener | null = null;
  private worker!: WorkerClient;
  /** In-flight `/context` fetches, so a hover during the post-turn refresh reuses
   *  it instead of issuing a second control request. */
  private contextFetches = new Map<string, Promise<ContextBreakdown | null>>();
  /** Pending debounced sessions.json write, if any (see persist/flushPersist). */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long consolidateStepOutput waits on its query before falling back to the
   *  last assistant text. A field so tests can shrink it. */
  consolidateTimeoutMs = 60_000;
  /** The SDK's session fork, used by rewindSession. A field so a test can stand in
   *  for it without a real CLI session on disk. */
  forkSession: typeof forkSession = forkSession;
  /**
   * Fired once the auto-titler has settled, with the title it produced — or `''`
   * when it produced none (no token, a failed query). A work-tree session's branch
   * is cut from this, so the empty case has to fire too, or the work tree would sit
   * on detached HEAD forever.
   *
   * A callback rather than a direct call into worktreeCommands: that layer needs a
   * whole `UserContext`, which this manager is only a part of. Wired in
   * userContext.ts, exactly as `GuardAllowlist.onChange` is.
   */
  onAutoNamed?: (session: SessionMeta, title: string) => void;

  constructor(
    private store: Store,
    private guard: GuardAllowlist,
    private broadcast: (msg: ServerMessage) => void,
    private auth?: AuthManager,
  ) {
    for (const meta of this.store.loadSessions()) {
      // An advance in flight belonged to the previous process — nothing is
      // consolidating now, so a persisted flag would wedge the Approve loader.
      if (meta.workflow) meta.workflow.advancing = false;
      // A verdict from a previous process proved nothing durable about this one.
      if (meta.contextCompact?.ok === false) meta.contextCompact = undefined;
      // Background tasks are per-CLI-process and live-only. A persisted set
      // describes children of a process this one has no handle on; the worker's
      // `hello` repopulates it for the ones that really are still running.
      meta.backgroundTasks = undefined;
      this.sessions.set(meta.id, meta);
    }
    // Pruned by the store on load, so an old tombstone doesn't suppress a session
    // id forever.
    for (const [id, at] of Object.entries(this.store.loadDeletedSessions())) {
      this.deletedAt.set(id, at);
      // A row that survived in sessions.json despite being deleted (an older build
      // wrote it back) must not come back to life on this restart.
      this.sessions.delete(id);
    }
  }

  /** Wired by index.ts right after construction, before any client can prompt. */
  attachWorker(worker: WorkerClient) {
    this.worker = worker;
  }

  setTurnCompleteListener(fn: TurnCompleteListener) {
    this.onTurnComplete = fn;
  }

  setRewindListener(fn: RewindListener) {
    this.onRewind = fn;
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }

  /**
   * Coalesce bursts of status transitions into one write. sessions.json holds
   * every session's metadata (workflow state included) and is rewritten whole,
   * synchronously, on the bridge's only thread — so a turn's worth of
   * transitions used to stall every other session that many times over.
   */
  private persist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeState();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Sessions and their tombstones are one state: written together, always. */
  private writeState() {
    this.store.saveSessions([...this.sessions.values()]);
    this.store.saveDeletedSessions(Object.fromEntries(this.deletedAt));
  }

  /**
   * Write now rather than in 250 ms. A delete is the one transition that cannot be
   * debounced: `forget` drops the transcript synchronously, so a crash inside the
   * debounce window leaves the row in sessions.json with no tombstone and no
   * transcript — an empty session that the next bulk push also re-uploads, undoing
   * the remote delete (`pendingDeletes` lives only in memory).
   */
  private persistNow() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.writeState();
  }

  /** Write pending session state out now. Called on shutdown — the debounce
   *  must never be the reason a status transition is lost. */
  flushPersist() {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.writeState();
  }

  private upsert(meta: SessionMeta) {
    meta.updatedAt = Date.now(); // LWW key for cross-instance sync
    this.sessions.set(meta.id, meta);
    this.persist();
    this.broadcast({ type: 'sessionUpsert', session: meta });
  }

  /**
   * Adopt a session pulled from the storage server. LWW on updatedAt (no
   * restamp — the remote timestamp is the point). In-flight statuses belong
   * to whichever instance is actually running the turn, not this one.
   */
  adoptSynced(meta: SessionMeta) {
    const tombstone = this.deletedAt.get(meta.id);
    if (tombstone !== undefined) {
      // The branch the LWW check below never reaches: with no local copy there is
      // nothing to compare against, so a deleted session used to be re-adopted from
      // every peer that had not heard about the delete yet — the undeletable session.
      if ((meta.updatedAt ?? meta.createdAt ?? 0) <= tombstone) return;
      // Written after the delete, somewhere else: a deliberate resurrection wins.
      this.deletedAt.delete(meta.id);
    }
    const cur = this.sessions.get(meta.id);
    if (cur && (meta.updatedAt ?? 0) <= (cur.updatedAt ?? 0)) return;
    if (isSessionActive(meta.status)) meta.status = 'idle';
    // In-flight statuses were just reset, so no pause is owned by this instance.
    meta.pendingPermissionTool = undefined;
    // Same reasoning: only the instance actually consolidating is advancing.
    if (meta.workflow) meta.workflow.advancing = false;
    // A failure verdict belongs to the CLI conversation that produced it, on
    // whichever device that was — it must not disable the button here.
    if (meta.contextCompact?.ok === false) meta.contextCompact = undefined;
    this.sessions.set(meta.id, meta);
    this.persist();
    this.broadcast({ type: 'sessionUpsert', session: meta });
  }

  setStatus(id: string, status: SessionStatus, errorMessage?: string, errorKind?: SessionErrorKind) {
    const meta = this.sessions.get(id);
    if (!meta) return;
    meta.status = status;
    meta.errorMessage = errorMessage;
    // Same lifetime as the message it qualifies, so every 3-arg caller clears it.
    meta.errorKind = errorKind;
    // The pending tool only means anything while paused for permission.
    if (status !== 'waiting-permission') meta.pendingPermissionTool = undefined;
    this.upsert(meta);
    // A settled status may release a queued prompt (e.g. workflow-done -> idle).
    if (!this.isBusy(meta)) this.maybeFlush(id);
  }

  /**
   * Persist + broadcast a session's metadata as it stands — no status change, so
   * no error-message reset and no queue flush. For fields written outside a status
   * transition (a workflow step's captured output) that must survive a crash
   * before the next transition writes them out.
   */
  persistMeta(id: string) {
    const meta = this.sessions.get(id);
    if (meta) this.upsert(meta);
  }

  /** Clears the post-turn 'done' badge once the user views the session. */
  ackSession(id: string) {
    const meta = this.sessions.get(id);
    if (!meta || meta.status !== 'done') return;
    meta.status = 'idle';
    this.upsert(meta);
  }

  archiveSession(id: string) {
    const meta = this.sessions.get(id);
    if (!meta) return;
    meta.archived = true;
    meta.archivedAt = Date.now();
    // Putting a session away answers the Continue banner; nothing to resume.
    meta.interruptedAt = undefined;
    this.upsert(meta);
  }

  /** Mark done by the user: adds the completed indicator and archives. */
  completeSession(id: string) {
    const meta = this.sessions.get(id);
    if (!meta) return;
    meta.completed = true;
    meta.archived = true;
    meta.archivedAt = Date.now();
    meta.interruptedAt = undefined;
    this.upsert(meta);
  }

  unarchiveSession(id: string) {
    const meta = this.sessions.get(id);
    if (!meta) return;
    meta.archived = false;
    meta.archivedAt = undefined;
    meta.completed = false;
    this.upsert(meta);
  }

  /**
   * Whether this instance has ever run a turn for this session — live state, or a
   * transcript on this disk. False for a session that only exists here because
   * storage sync adopted it from another machine.
   */
  private ranHere(id: string): boolean {
    return this.live.has(id) || this.store.loadTranscriptRaw(id).length > 0;
  }

  private liveState(id: string): LiveState {
    let state = this.live.get(id);
    if (!state) {
      state = { seq: this.nextSeqFromDisk(id), pendingPermissions: new Map(), permissionWaitMs: 0 };
      this.live.set(id, state);
    }
    return state;
  }

  private nextSeqFromDisk(id: string): number {
    const events = this.store.loadTranscript(id);
    return events.length > 0 ? events[events.length - 1].seq + 1 : 0;
  }

  emitEvent(sessionId: string, kind: TranscriptEvent['kind'], data: unknown, persistToDisk = true): number {
    const state = this.liveState(sessionId);
    const event: TranscriptEvent = { seq: state.seq++, ts: Date.now(), kind, data };
    if (persistToDisk) this.store.appendTranscript(sessionId, event);
    this.broadcast({ type: 'event', sessionId, event });
    return event.seq;
  }

  /**
   * One line per permission resolution. There was no server-side record of *how*
   * a request got answered, which is why a report of "I never approved that plan"
   * could not be settled from the logs — so every resolution site logs here.
   */
  private logResolution(
    sessionId: string,
    toolName: string,
    resolution: 'allow' | 'deny' | 'expired',
    source: PermissionResolutionSource,
    actor?: Actor,
  ) {
    // Named in the host's log when it was not them: "who approved that" is the
    // question asked after the fact, and the console is where it gets answered.
    const who = actor ? ` (${actor.name ?? actor.userId})` : '';
    console.log(
      `[permission] [session ${sessionId}] ${toolName || '?'} ${resolution} by ${source}${who}`,
    );
  }

  createSession(params: {
    name: string;
    cwd: string;
    model: string;
    permissionMode: PermissionMode;
  }): SessionMeta {
    const meta: SessionMeta = {
      id: randomUUID(),
      name: params.name,
      cwd: params.cwd,
      model: params.model,
      permissionMode: params.permissionMode,
      status: 'idle',
      createdAt: Date.now(),
      nameAuto: true,
    };
    this.store.addRecentDir(params.cwd);
    this.upsert(meta);
    // The floor the session review diff is taken against. Fire-and-forget: a
    // worktree for a new session is created *before* the session, so `cwd` is
    // already final here, and nothing reads the baseline until a turn settles.
    void this.captureSessionBaseline(meta.id);
    return meta;
  }

  /**
   * Snapshot every commit unit this session spans, once. Never overwrites an
   * existing capture — re-running it would move the floor and silently drop work
   * the session had already done out of its own review diff.
   */
  private async captureSessionBaseline(sessionId: string) {
    try {
      const meta = this.sessions.get(sessionId);
      if (!meta || meta.diffBaselines?.length) return;
      const baselines = await captureBaselines(this.rootsFor(meta));
      if (!baselines.length) return;
      // Re-read: the session can have been deleted, or adopted from storage with
      // a baseline of its own, while the snapshot was running.
      const live = this.sessions.get(sessionId);
      if (!live || live.diffBaselines?.length) return;
      live.diffBaselines = baselines;
      live.diffBaselineAt = Date.now();
      this.upsert(live);
    } catch (err) {
      console.warn('[diffBaseline]', err);
    }
  }

  deleteSession(id: string) {
    this.forget(id);
    this.deletedAt.set(id, Date.now());
    this.persistNow();
    this.broadcast({ type: 'sessionDeleted', sessionId: id });
  }

  /**
   * Another machine deleted this session. Records the tombstone even when we never
   * held the row, so a later pull from a third machine that is still behind cannot
   * reintroduce it here.
   */
  applyRemoteDelete(id: string, deletedAt: number) {
    const known = this.deletedAt.get(id);
    if (known !== undefined && known >= deletedAt) return;
    this.deletedAt.set(id, deletedAt);
    this.forget(id);
    this.persistNow();
    this.broadcast({ type: 'sessionDeleted', sessionId: id });
  }

  /** Drop every trace of a session from this instance. Shared by both delete paths. */
  private forget(id: string) {
    // Nothing here to tear down (a remote delete for a session this machine never
    // held): closing a query the worker has no record of is a pointless round trip.
    if (!this.sessions.has(id) && !this.live.has(id)) return;
    this.closeQuery(id);
    this.flushPending(id); // the session is gone with its cards
    this.sessions.delete(id);
    this.live.delete(id);
    this.compacting.delete(id);
    this.store.deleteTranscript(id);
  }

  /**
   * Every directory a session may work in: its project's roots when the cwd
   * belongs to one, else just the cwd. Resolved at use time rather than
   * snapshotted onto the meta, so adding a root applies to existing sessions and
   * `SessionMeta` (which is synced) keeps its shape.
   */
  private rootsFor(meta: SessionMeta): string[] {
    return rootsForCwd(this.store.loadProjects(), meta.cwd);
  }

  /**
   * The floor a session's review diff is taken against, one per commit unit, and
   * where it came from. Resolution order:
   *
   * 1. `meta.diffBaselines` — captured at session creation, authoritative.
   * 2. the workflow's own snapshot — so a session already running across the
   *    deploy that introduced (1) still gets a correct diff.
   * 3. a synthesized HEAD per commit unit, flagged `synthetic` so the UI can say
   *    "no baseline was recorded — this is all uncommitted work in the repo"
   *    rather than presenting somebody else's dirty tree as this session's.
   *
   * Public because `WorkflowEngine` resolves against the same chain — a step's
   * `{diff}`/`{changed}` must not fall back to `[]` (which renders as nothing at
   * all) when a workflow's own snapshot was never captured.
   *
   * @param prefer Which snapshot wins when both exist. The review UI wants the
   *   session's own floor; a workflow step wants "since this run started", which
   *   is the workflow's — a workflow started in a long-lived session has a much
   *   later floor than the session's, and diffing from the session's would drag
   *   pre-existing work into the step.
   */
  async baselinesFor(
    meta: SessionMeta,
    prefer: 'session' | 'workflow' = 'session',
  ): Promise<{ baselines: RepoBaseline[]; source: 'session' | 'workflow' | 'synthetic' }> {
    const session = meta.diffBaselines?.length
      ? { baselines: meta.diffBaselines, source: 'session' as const }
      : null;
    const snapshot = meta.workflow?.diffBaselines;
    const legacy = meta.workflow?.diffBaseline;
    const workflow = snapshot?.length
      ? { baselines: snapshot, source: 'workflow' as const }
      : legacy
        ? { baselines: [{ repo: meta.cwd, ...legacy }], source: 'workflow' as const }
        : null;
    const resolved = prefer === 'workflow' ? (workflow ?? session) : (session ?? workflow);
    if (resolved) return resolved;
    const { repos } = await groupByRepo(this.rootsFor(meta));
    return {
      baselines: repos.map((r) => ({ repo: r.root, ref: 'HEAD', untracked: [] })),
      source: 'synthetic',
    };
  }

  /**
   * This session's changes, file by file, per commit unit — what the review modal
   * renders. Assembled here rather than in fileRoutes.ts because the baseline
   * chain, the session's roots and its transcript all live on this class; the
   * route stays a permission clamp over it.
   *
   * No content, and no `MAX_DIFF_CHARS` cap: the list is bounded by the number of
   * changed files, contents load one file at a time on click, and nothing on this
   * path reaches a model.
   */
  async changeSummary(sessionId: string): Promise<SessionDiffResponse | null> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return null;
    const roots = this.rootsFor(meta);
    const { baselines, source } = await this.baselinesFor(meta);
    const { orphans } = await groupByRepo(roots);
    const { paths, ambiguous } = collectChangedPaths(this.store.loadTranscript(sessionId), roots);
    const mine = new Set(paths);
    const unclear = new Set(ambiguous);

    const repos: SessionDiffRepo[] = [];
    for (const baseline of baselines) {
      const { files, stale, untrackedOmitted } = await changedFiles(baseline.repo, baseline);
      const attributed: FileChange[] = [];
      const other: FileChange[] = [];
      for (const file of files) {
        const abs = path.resolve(baseline.repo, file.rel);
        if (mine.has(abs)) attributed.push(file);
        else if (unclear.has(abs)) attributed.push({ ...file, ambiguous: true });
        else other.push(file);
      }
      repos.push({
        repo: baseline.repo,
        branch: await repoBranch(baseline.repo),
        baseline: stale ? 'stale' : source,
        attributed,
        other,
        ...(untrackedOmitted ? { untrackedOmitted } : {}),
      });
    }
    return { repos, orphans };
  }

  /**
   * The commit-ish one of this session's repos is diffed against, for loading a
   * single file's "before" side. Null when `repo` is not one of its commit units —
   * which is also the containment check for the file route.
   */
  async baselineRefFor(sessionId: string, repo: string): Promise<string | null> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return null;
    const { baselines } = await this.baselinesFor(meta);
    const match = baselines.find((b) => b.repo === repo);
    if (!match) return null;
    return (await refExists(repo, match.ref)) ? match.ref : 'HEAD';
  }

  /**
   * Open this turn's attribution window: a snapshot of every commit unit, taken
   * as the turn starts and diffed against a second one at settle.
   *
   * Fire-and-forget, and lossy on purpose — a turn that settles before this
   * resolves simply records no window, and `collectChangedPaths` falls back to
   * scanning its tool calls.
   */
  private async openTurnWindow(sessionId: string) {
    try {
      const meta = this.sessions.get(sessionId);
      if (!meta) return;
      const baselines = await captureBaselines(this.rootsFor(meta));
      const state = this.live.get(sessionId);
      if (state) state.turnBaselines = baselines;
    } catch (err) {
      console.warn('[turnWindow]', err);
    }
  }

  /**
   * Close the window a turn opened and record what changed on disk inside it, as
   * one `files-changed` event. Same fire-and-forget class as summarizeTurn: never
   * awaited, so it can't delay a queue flush or a workflow advance.
   *
   * Skipped when the turn made no tool calls — a pure-conversation turn changed
   * nothing, and proving that would still cost two snapshots per repo.
   */
  private async recordFilesChanged(sessionId: string, resultSeq: number) {
    try {
      const state = this.live.get(sessionId);
      const start = state?.turnBaselines;
      if (state) state.turnBaselines = undefined; // one window per turn, closed here
      if (!start?.length) return;
      const meta = this.sessions.get(sessionId);
      if (!meta) return;

      const events = withoutCompactSpans(this.store.loadTranscript(sessionId));
      let lastUserIdx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].kind === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (!scanTurnActivity(events.slice(Math.max(lastUserIdx, 0))).toolCalls.length) return;

      const shared = await this.sharedRepos(sessionId);
      const repos: FilesChangedData['repos'] = [];
      for (const from of start) {
        const to: RepoBaseline = { repo: from.repo, ...(await captureBaseline(from.repo)) };
        const rels = await changedBetween(from.repo, from, to);
        if (!rels.length) continue;
        repos.push({ repo: from.repo, rels, ...(shared.has(from.repo) ? { ambiguous: true } : {}) });
      }
      if (repos.length) {
        this.emitEvent(sessionId, 'files-changed', { resultSeq, repos } satisfies FilesChangedData);
      }
    } catch (err) {
      console.warn('[filesChanged]', err);
    }
  }

  /**
   * Commit units this session shares with another session that was live during
   * the window. Sessions in their own worktrees can't collide; sessions sharing a
   * checkout can, and a write from one lands inside the other's snapshot window
   * too. Those paths are reported as unclear rather than claimed — guessing here
   * would be worse than saying so.
   *
   * Only sessions still active at settle are counted: nothing records when a turn
   * elsewhere *ended*, so a session that ran and finished entirely inside the
   * window is missed and its writes are attributed here.
   */
  private async sharedRepos(sessionId: string): Promise<Set<string>> {
    const meta = this.sessions.get(sessionId);
    const shared = new Set<string>();
    if (!meta) return shared;
    const mine = new Set((await groupByRepo(this.rootsFor(meta))).repos.map((r) => r.root));
    for (const other of this.sessions.values()) {
      if (other.id === sessionId || !isSessionActive(other.status)) continue;
      for (const repo of (await groupByRepo(this.rootsFor(other))).repos) {
        if (mine.has(repo.root)) shared.add(repo.root);
      }
    }
    return shared;
  }

  /**
   * The serializable half of the SDK query options. The worker splices in the
   * non-serializable callbacks (canUseTool, hooks, stderr) on its side.
   */
  private buildQueryOptions(meta: SessionMeta, accessToken: string | null): Record<string, unknown> {
    // Global, not per-session: read fresh on every push, so a Settings toggle
    // takes effect the next time this session's worker starts a query, with
    // nothing cached on the meta itself. On unless explicitly `false`.
    const appendParts: string[] = [];
    if (this.store.loadSettings()?.compressResponses !== false) appendParts.push(COMPRESS_RESPONSES_PROMPT);

    // cwd stays this session's own root so settingSources and CLAUDE.md
    // resolution keep pointing at it; the project's other roots ride along as
    // additionalDirectories. Filtered against `cwd` rather than sliced, because a
    // session created in an extra root has the *primary* among its siblings. The
    // key is absent (not `[]`) for a single-root project, so its serialized
    // options stay byte-identical to before.
    const extraRoots = this.rootsFor(meta).filter((root) => root !== meta.cwd);

    return {
      cwd: meta.cwd,
      ...(extraRoots.length ? { additionalDirectories: extraRoots } : {}),
      model: resolveModelId(meta.model),
      permissionMode: sdkPermissionMode(meta.permissionMode),
      // Only *permits* bypassPermissions to be selected — the bridge's own
      // permission handlers are the real gate, and they keep the always-ask
      // tools and Lines workflow writes prompting even under bypass. Set
      // unconditionally so a live setPermissionMode('bypassPermissions') on an
      // already-running query is accepted instead of rejected (worker.ts only
      // warns), which is what made a mid-session switch to Bypass do nothing.
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      resume: meta.claudeSessionId,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(appendParts.length > 0 ? { append: appendParts.join('\n\n') } : {}),
      },
      settingSources: ['user', 'project'],
      // App-managed login is the only credential path: pushTurn refuses the turn
      // unless it holds a token, so this is always set in the real app. Never
      // let a signed-in user inherit the ambient ~/.claude CLI login — that is a
      // separate store the app cannot refresh, so a stale one 401s forever.
      // Null only when no AuthManager is wired at all (tests / embedding).
      ...(accessToken ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: accessToken } } : {}),
      // Serialized bridge → worker and spread into the worker's own query(), so
      // this one line is what makes the packaged app use the machine's CLI.
      ...claudeExecutableOption(),
    };
  }

  /**
   * Restart queries that aren't mid-turn so their next prompt rebuilds options
   * with the current token (resume keeps context). Called on login/logout and
   * after token refresh; busy sessions finish their turn on the old token, and
   * pushTurn recycles them at their next push. After a logout the next push is
   * refused outright, so nothing respawns on ambient credentials.
   *
   * Gated on interruptible, not active: a session parked at 'waiting-approval'
   * has already settled its turn, so its query is as safe to drop as an idle
   * one — and skipping those was how a plan-mode session could sit on a dead
   * token across a re-login and keep 401ing.
   *
   * Second exemption: a settled session whose CLI process still owns background
   * tasks. Those outlive the turn, so "not interruptible" no longer means "no
   * work in flight" — see backgroundTasks below.
   */
  recycleIdleQueries() {
    for (const meta of this.sessions.values()) {
      if (isSessionInterruptible(meta.status)) continue;
      // Closing the query kills the CLI child, and with it every background task
      // it owns — silently, with no notification and no transcript trace.
      if (this.live.get(meta.id)?.backgroundTasks?.length) continue;
      this.closeQuery(meta.id);
    }
  }

  /**
   * Replace the session's live background-task set, mirroring it onto the meta.
   * The SDK's `background_tasks_changed` is a level signal with REPLACE
   * semantics and is the *only* thing that may put an id **into** the set.
   * Everything else — `init`, `closeQuery`, `handleWorkerEnded`,
   * `resetClaudeSession`, `task_notification` and `stopBackgroundTasks` — may
   * only take ids **out**, so membership is monotone toward empty between level
   * emissions.
   *
   * That keeps the original rule's intent (a missed bookend must not wedge a
   * stale running indicator) in a stronger form: every failure mode of a
   * removal-only edge is a *premature empty*, which the next level emission
   * repairs in one message. A non-empty wedge, by contrast, was only clearable
   * by restarting the CLI — observed lasting 661 events.
   *
   * Upserts only when membership actually changed — the level fires per
   * transition, and re-broadcasting the meta each time would re-render every
   * sidebar row for nothing.
   */
  private setBackgroundTasks(sessionId: string, list: BackgroundTaskInfo[]) {
    // Clearing a session that has no live state at all is a no-op — and materializing
    // one costs a transcript read per session, which recycleIdleQueries would pay
    // for the whole list on every token refresh.
    if (!list.length && !this.live.has(sessionId)) return;
    const state = this.liveState(sessionId);
    const before = state.backgroundTasks ?? [];
    const same =
      before.length === list.length && before.every((t, i) => t.id === list[i].id);
    state.backgroundTasks = list.length ? list : undefined;
    if (same) return;
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.backgroundTasks = list.length ? list : undefined;
    this.upsert(meta);
  }

  /**
   * Stop every background task this session's CLI process still owns, then clear
   * the set optimistically — this is the user's manual escape hatch.
   *
   * A task the CLI has already forgotten makes `stopTask` a no-op, so no level
   * signal ever comes and the strip, sidebar badge, Stop button and chime
   * suppression stay on with nothing the user can do about it. Clearing here can
   * at worst flicker an entry back on the next `background_tasks_changed` — which
   * is the level signal correctly reporting a task that really is still alive.
   * A recoverable flicker beats an unrecoverable wedge.
   */
  stopBackgroundTasks(sessionId: string) {
    for (const task of this.live.get(sessionId)?.backgroundTasks ?? []) {
      this.worker.stopTask(sessionId, task.id);
    }
    this.setBackgroundTasks(sessionId, []);
  }

  /** Close a session's worker query and forget the token it was spawned with. */
  private closeQuery(sessionId: string) {
    this.worker.close(sessionId);
    this.queryTokens.delete(sessionId);
    // The CLI child that owned them is gone.
    this.setBackgroundTasks(sessionId, []);
  }

  /**
   * Send a message to the session's worker query, dropping that query first
   * unless it is known to have been spawned with this same access token.
   *
   * The worker reuses a live query for a session and ignores the options of
   * later pushes, so the token handed over at spawn time is the one the CLI
   * child keeps using for its whole life. Without this, a session that was
   * mid-turn or awaiting approval when the token rotated would 401 forever, and
   * re-logging in would not help. Closing is cheap: `resume` rebuilds the query
   * with the current token and keeps the conversation.
   *
   * The token is resolved (refreshing if it is inside the refresh margin) before
   * the spawn, and a turn that cannot get one is refused rather than started on
   * the ambient CLI login. Awaiting the single-flight refresh also means a Retry
   * click landing mid-refresh queues on the same promise instead of re-pushing
   * on the stale token.
   *
   * Callers fire-and-forget through pushTurnSafely, never awaiting.
   *
   * `intoLiveTurn` (interjectQueued) short-circuits all of that: the message is
   * joining a query that is already running, so it reuses the token that query
   * was spawned with instead of resolving a fresh one. Going the normal way,
   * pushWithToken would see a rotated token and `closeQuery` — killing the very
   * turn the interjection is joining.
   */
  private async pushTurn(
    meta: SessionMeta,
    message: Record<string, unknown>,
    opts: { intoLiveTurn?: boolean } = {},
  ) {
    if (opts.intoLiveTurn) {
      this.worker.push(
        meta.id,
        message,
        this.buildQueryOptions(meta, this.queryTokens.get(meta.id) ?? null),
        LINES_TOOL_MANIFEST,
      );
      return;
    }

    // No AuthManager wired (tests / embedding): keep the pre-app-login
    // behaviour. Returns before any await, so that path stays synchronous.
    if (!this.auth) {
      this.pushWithToken(meta, message, null);
      return;
    }

    // No CLI, no turn. Checked before the token because it cannot be fixed by
    // retrying, and because the SDK reports a missing or too-old binary only as
    // `Claude Code process exited with code 1` — this is the one place a hosted
    // user can be told what to install. Cached, so it costs nothing per push.
    const cliRefusal = claudeCliRefusalMessage();
    if (cliRefusal) {
      this.failTurn(meta.id, cliRefusal);
      return;
    }

    let accessToken: string;
    try {
      accessToken = await this.auth.ensureFreshToken();
    } catch (err) {
      this.failTurn(meta.id, authRefusalMessage(err));
      // store.ts:898 force-opens the login modal on any logged-out authStatus,
      // so re-broadcasting the current state reopens a dismissed one. Not routed
      // through auth.onChange, which would also spin recycleIdleQueries() and
      // usage.refreshSoon() for a state that did not change.
      if (err instanceof AuthRequiredError) this.broadcast({ type: 'authStatus', auth: { loggedIn: false } });
      return;
    }
    this.pushWithToken(meta, message, accessToken);
  }

  /** pushTurn is fire-and-forget, so a throw past its own handling must not
   *  become an unhandled rejection. */
  private pushTurnSafely(
    meta: SessionMeta,
    message: Record<string, unknown>,
    opts: { intoLiveTurn?: boolean } = {},
  ) {
    void this.pushTurn(meta, message, opts).catch((err) => {
      console.error(`[session ${meta.id}] push failed:`, err);
      // An interjection has no turn of its own to fail: the turn it was joining is
      // still healthy, and synthesizing an error `result` over it would show a
      // Retry button on a session that is mid-run.
      if (opts.intoLiveTurn) return;
      // The turn never reached the worker, so no `result` and no `ended` is coming:
      // without a synthetic failure the session sits at 'running' forever.
      this.failTurn(meta.id, `Failed to start the turn: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Recycle the query unless it is *known* to have been spawned with this token,
   *  then push. Unknown is not safe: queryTokens lives in bridge memory only while
   *  the worker outlives the bridge, so after a bridge restart a still-live query
   *  can be pinned to a token that has since rotated — reusing it 401s that one
   *  session forever while every other session runs fine on the current token. */
  private pushWithToken(meta: SessionMeta, message: Record<string, unknown>, accessToken: string | null) {
    if (this.queryTokens.get(meta.id) !== accessToken) this.closeQuery(meta.id);
    this.queryTokens.set(meta.id, accessToken);
    // Every session gets the workflow tool surface; the manifest is static, and
    // the calls it produces are routed back to this user's context by the bridge.
    this.worker.push(meta.id, message, this.buildQueryOptions(meta, accessToken), LINES_TOOL_MANIFEST);
  }

  /** Show a turn as failed with a Retry button: synthetic result first (so it is
   *  the trailing transcript item), then the error status. The single funnel for
   *  every failure the SDK never reports as a `result` — a crashed query, a push
   *  that never left the bridge, a workflow step that failed before it could run
   *  (WorkflowEngine calls this too, hence public). */
  failTurn(sessionId: string, error: string) {
    this.emitEvent(sessionId, 'sdk', {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: error,
    });
    this.setStatus(sessionId, 'error', error);
    this.classifyFailure(sessionId, error);
  }

  /**
   * Turn the raw failure text into a banner that names what the user can do,
   * where we recognise the failure. Auth is tried first and wins outright: it is
   * the only kind that also *acts* (one token refresh), and its async rewrite
   * must not be raced by a second one. An unrecognised failure keeps its raw text
   * and its plain Retry, which is what every failure used to get.
   */
  private classifyFailure(sessionId: string, error: string) {
    this.dropFailedQuery(sessionId);
    if (this.recoverAuthFailure(sessionId, error)) return;
    const kind = classifyTurnFailure(error);
    if (!kind) return;
    const meta = this.sessions.get(sessionId);
    // Same don't-clobber guard as the auth path: only rewrite our own banner.
    if (!meta || meta.status !== 'error' || meta.errorMessage !== error) return;
    // Synchronous by design — there is nothing to await, so this lands before
    // onTurnComplete and therefore before WorkflowEngine parks a failed step. That
    // park persists the meta rather than re-setting the status, so the rewritten
    // message and kind survive it (see workflows.ts onWorkflowTurnComplete).
    this.setStatus(sessionId, 'error', turnFailureAdvice(kind, { inWorkflow: !!meta.workflow }), kind);
  }

  /**
   * Drop the query of a turn that just failed, so the *first* Retry re-spawns
   * instead of re-entering the child that failed.
   *
   * Unconditional by design. The CLI child keeps the token it was spawned with for
   * its whole life, so a child the API has started rejecting stays wedged: every
   * Retry reproduces the identical error. Gating this on recognising the error text
   * is what made that permanent once — `queryTokens` can legitimately match the
   * current token (a credential revoked server-side without the app rotating it),
   * and a wording we do not match classifies as nothing at all. Neither condition
   * is observable from here, so no failure is treated as safe to reuse.
   *
   * Costs one `resume` on the next push after a failed turn — the same thing
   * recycleIdleQueries already does on every login/logout/refresh, and cheap
   * against a turn that has already failed.
   */
  private dropFailedQuery(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    // Defensive: both callers settle the status before classifying, so this never
    // fires today. It is the invariant that matters — a query mid-turn is not a
    // failed turn's to close, whatever a later caller does.
    if (!meta || isSessionInterruptible(meta.status)) return;
    this.closeQuery(sessionId);
  }

  /**
   * A turn failed on what looks like a rejected token: attempt exactly one
   * recovery, then rewrite the banner to name the action the user must take. The
   * raw CLI text stays in the transcript as the durable record; only the banner
   * changes. Nothing is auto-resumed — Retry stays the user's call, and
   * dropFailedQuery has already made that one click enough.
   *
   * Returns whether this failure was an auth failure at all, so classifyFailure
   * knows not to look further.
   */
  private recoverAuthFailure(sessionId: string, error: string): boolean {
    if (!this.auth || !isAuthFailureMessage(error)) return false;
    void this.auth.handleTokenRejected().then((rejection) => {
      const meta = this.sessions.get(sessionId);
      // The session moved on while we refreshed (new turn, flushed queue, retry,
      // workflow advance): the banner is no longer ours to rewrite.
      if (!meta || meta.status !== 'error' || meta.errorMessage !== error) return;
      this.setStatus(
        sessionId,
        'error',
        authRecoveryMessage(rejection),
        rejection.outcome === 'signed-out' ? 'auth' : undefined,
      );
    });
    return true;
  }

  /** Persist attachments to disk and return the transcript/queue refs. */
  private stageAttachments(sessionId: string, attachments: PromptAttachment[]): Attachment[] {
    return attachments.map((att) => {
      const kind = attachmentKind(att.mediaType);
      const file = this.store.saveAttachment(sessionId, att.name, att.data);
      return { name: att.name, mediaType: att.mediaType, kind, url: `/attachments/${sessionId}/${file}` };
    });
  }

  private isBusy(meta: SessionMeta) {
    return isSessionActive(meta.status);
  }

  /**
   * User-facing prompt entry point. If the session is busy (or a queue already
   * exists, preserving FIFO after an interrupt), the prompt is staged and held;
   * otherwise it goes straight through. Internal callers (workflows, recovery)
   * keep calling prompt() directly and bypass the queue.
   */
  userPrompt(
    sessionId: string,
    text: string,
    attachments: PromptAttachment[] = [],
    mentions: PromptMention[] = [],
    /**
     * A guest whose grant carries `promptNeedsApproval`. Their prompt is staged
     * and the queue is left paused, so it waits for the owner to release it from
     * the queue UI they already have. No new state machine: this is the same
     * `queued` + `queuePaused` + `maybeFlush` path an interrupt leaves behind.
     */
    opts: { needsApproval?: boolean; actor?: Actor; draft?: MentionValue } = {},
  ) {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`unknown session ${sessionId}`);

    // A plan is up for review and the user typed a reply instead of clicking a
    // button: treat it as "keep planning" — deny ExitPlanMode through the same
    // per-request path the button uses, rather than silently queuing behind a
    // permission promise nothing will resolve.
    const planReply = planReplyDecision({
      status: meta.status,
      pendingPermissionTool: meta.pendingPermissionTool,
      text,
      hasAttachments: attachments.length > 0,
      livePendingIds: [...(this.live.get(sessionId)?.pendingPermissions.keys() ?? [])],
      events: this.store.loadTranscript(sessionId),
    });
    if (planReply) {
      this.resolvePermission(
        sessionId,
        planReply.requestId,
        false,
        undefined,
        undefined,
        planReply.denyMessage,
        undefined,
        'plan-reply',
      );
      // With attachments the deny only unblocks the query; fall through so the
      // queue branch stages text + attachments and maybeFlush delivers them as
      // a real user turn once the denied turn settles.
      if (!planReply.alsoQueue) return;
    }

    if (opts.needsApproval || meta.queued?.length || this.isBusy(meta)) {
      const staged = this.stageAttachments(sessionId, attachments);
      (meta.queued ??= []).push({
        id: randomUUID(),
        ts: Date.now(),
        text,
        attachments: staged.length ? staged : undefined,
        mentions: mentions.length ? mentions : undefined,
        // Only when it carries pills: with no mentions the expansion is a no-op
        // and `text` already *is* the draft, so storing one would duplicate the
        // prompt body on the synced session blob for nothing.
        draft: opts.draft?.ranges.length ? opts.draft : undefined,
      });
      // Stamped on the queued item so a released prompt is still attributed to
      // whoever wrote it, not to the owner who let it through.
      if (opts.actor) meta.queued.at(-1)!.actor = opts.actor;
      if (opts.needsApproval) {
        // Paused, not flushed: the whole point of the preset is that the owner
        // sees the prompt before it runs on their machine, on their plan.
        meta.queuePaused = true;
        this.upsert(meta);
        return;
      }
      // An explicit user send is the resume gesture after an interrupt/error.
      meta.queuePaused = undefined;
      this.upsert(meta);
      this.maybeFlush(sessionId);
      return;
    }

    this.prompt(sessionId, text, 'user', attachments, mentions, opts.actor);
  }

  /** Send the next queued prompt if the session is settled and not paused. */
  private maybeFlush(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.queued?.length || meta.queuePaused) return;
    if (meta.status !== 'idle' && meta.status !== 'done' && meta.status !== 'error') return;

    const item = meta.queued.shift()!;
    this.upsert(meta);

    const attachments = (item.attachments ?? [])
      .map((a) => {
        const file = a.url.split('/').pop()!;
        const data = this.store.loadAttachmentBase64(sessionId, file);
        return data ? { name: a.name, mediaType: a.mediaType, data } : null;
      })
      .filter((a): a is PromptAttachment => a !== null);

    // item.actor, not the releasing user: the owner clicking "send" on a guest's
    // queued prompt is not the author of it.
    this.prompt(sessionId, item.text, 'user', attachments, item.mentions ?? [], item.actor);
  }

  /**
   * Pull the next queued user prompt off the head of the queue so the workflow
   * engine can re-run the current step with it instead of stranding it at
   * waiting-approval. Returns undefined when nothing is queued or the queue is paused.
   */
  takeQueuedText(sessionId: string): { text: string; attachments: PromptAttachment[] } | undefined {
    const meta = this.sessions.get(sessionId);
    if (!meta?.queued?.length || meta.queuePaused) return undefined;
    const item = meta.queued.shift()!;
    this.upsert(meta);
    const attachments = (item.attachments ?? [])
      .map((a) => {
        const file = a.url.split('/').pop()!;
        const data = this.store.loadAttachmentBase64(sessionId, file);
        return data ? { name: a.name, mediaType: a.mediaType, data } : null;
      })
      .filter((a): a is PromptAttachment => a !== null);
    return { text: item.text, attachments };
  }

  /** Drop a queued prompt before it is sent. */
  cancelQueued(sessionId: string, queuedId: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.queued?.length) return;
    const item = meta.queued.find((q) => q.id === queuedId);
    if (!item) return;
    meta.queued = meta.queued.filter((q) => q.id !== queuedId);
    for (const a of item.attachments ?? []) {
      const file = a.url.split('/').pop();
      if (file) fs.rmSync(`${this.store.attachmentsRoot}/${sessionId}/${file}`, { force: true });
    }
    if (meta.queued.length === 0) meta.queuePaused = undefined;
    this.upsert(meta);
  }

  /**
   * May a queued prompt be delivered into the turn that is running right now?
   *
   * Narrower than either existing predicate on purpose. Not `isSessionActive`,
   * which folds in `waiting-approval` (a parked step, no live turn). Not
   * `isSessionInterruptible`, which folds in `waiting-permission` (the CLI is
   * parked inside canUseTool and may not be draining stdin at all — excluded in
   * v1, see the feature doc's arm D).
   */
  private canInterject(sessionId: string): boolean {
    const meta = this.sessions.get(sessionId);
    if (!meta || meta.status !== 'running') return false;
    // A compaction runs as a plain 'running' turn, but withoutCompactSpans drops
    // everything until the next 'user' event — an interjection would reach the
    // model and be invisible to collectTurns, lastAssistantText and
    // consolidateStepOutput. Silent, so it is refused rather than mitigated.
    if (this.compacting.has(sessionId)) return false;
    if (this.interrupting.has(sessionId)) return false; // a Stop is in flight
    if (this.rewinding.has(sessionId)) return false; // the transcript is moving under us
    if (meta.workflow?.advancing) return false; // mid-consolidateStepOutput; the turn is over
    // Only interject into a query this bridge knows it spawned.
    if (!this.queryTokens.has(sessionId)) return false;
    // `linkOpen`, not `status.connected`: WorkerClient buffers a send made while
    // the socket is down and replays it on the next `hello`, where ensureSession
    // builds a *fresh* query — the interjection would open an unattributed turn
    // with no 'user' event, while its queue row is already gone.
    return this.worker.linkOpen;
  }

  /**
   * "Send now": lift a queued prompt out of the queue and deliver it into the
   * running turn instead of waiting for the turn to settle.
   *
   * Synchronous from the status check through to the push — nothing is awaited in
   * between, so the turn cannot settle underneath a half-applied release.
   *
   * A lost race is `code: 'settled'`, not an error: the item is left queued and
   * maybeFlush is about to send it the ordinary way, which is exactly the product
   * behaviour that existed before this button. Only 'refused' is worth a message.
   *
   * What it deliberately does *not* touch (compare prompt()): turnSource,
   * turnStartedAt, turnActor, openTurnWindow (reopening resets the turn baselines,
   * so recordFilesChanged would lose the turn's earlier edits), maybeAutoName,
   * interruptedAt, the in-flight-interrupt flag, the workflow force-advance flag,
   * setStatus, archived/completed reactivation, and the 'user' emitEvent. It also
   * never calls maybeFlush: the rest of the queue keeps waiting for the turn.
   */
  interjectQueued(
    sessionId: string,
    queuedId: string,
    by: { actor?: Actor; needsApproval: boolean },
  ): { ok: true } | { ok: false; code: 'refused' | 'settled'; reason: string } {
    // First line, before anything is removed, emitted or pushed. This is the
    // owner gate MESSAGE_AUTHZ cannot express: a guest on the Can prompt preset
    // must not release their own held prompt onto the owner's machine.
    if (by.needsApproval) {
      return { ok: false, code: 'refused', reason: 'Your prompts need the owner to send them.' };
    }

    const meta = this.sessions.get(sessionId);
    const item = meta?.queued?.find((q) => q.id === queuedId);
    if (!meta || !item) {
      return { ok: false, code: 'refused', reason: 'That queued prompt is no longer in the queue.' };
    }
    // Refused in v1: the staged files would have to be re-read into a multi-block
    // content array mid-turn, and their only cleanup path is cancelQueued's rmSync.
    if (item.attachments?.length) {
      return { ok: false, code: 'refused', reason: 'Prompts with attachments send after this turn.' };
    }
    if (!this.canInterject(sessionId)) {
      return { ok: false, code: 'settled', reason: 'The turn is no longer running; it stays queued.' };
    }

    meta.queued = meta.queued!.filter((q) => q.id !== queuedId);
    // Same rule as cancelQueued: an empty queue has nothing left to hold back.
    // Otherwise `queuePaused` is left alone — mirroring editQueued, releasing one
    // item is not a release of the queue.
    if (meta.queued.length === 0) meta.queuePaused = undefined;
    // item.actor, not whoever pressed the button: the same attribution rule
    // maybeFlush follows when the owner releases a guest's prompt.
    this.emitEvent(sessionId, 'interject', {
      text: item.text,
      ...(item.mentions?.length ? { mentions: item.mentions } : {}),
      ...(item.actor ? { actor: item.actor } : {}),
    } satisfies InterjectData);
    this.upsert(meta);

    this.pushIntoLiveTurn(meta, item.text);
    return { ok: true };
  }

  /**
   * Deliver one user text into the turn that is already running, rather than
   * opening a turn for it.
   *
   * Two callers: "Send now" (a queued prompt lifted into the live turn) and an
   * approved plan carrying comments. Both have already established that
   * `canInterject` holds — this does the push and nothing else.
   */
  private pushIntoLiveTurn(meta: SessionMeta, text: string) {
    this.pushTurnSafely(
      meta,
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        // The SDK's streaming-input steering knob, undocumented outside sdk.d.ts.
        // Measured against CLI 2.1.260, 3 runs per arm (server/scripts/spike-interject.ts):
        //
        //   absent   1 result, model reads it inside the turn
        //   'next'   1 result, model reads it inside the turn
        //   'now'    2 results — the CLI ends the running turn at the next safe
        //            point and starts a fresh one for this message
        //
        // So NOT 'now', which is the opposite of what the button promises: it
        // synthesizes an `error_during_execution` over a healthy turn (the CLI's
        // own `[ede_diagnostic] result_type=user` — a turn whose last message is
        // a bare user text is not a legal turn ending) and parks a workflow step
        // as failed. 'next' rather than omitting the field because a CLI that
        // does not know it drops it and degrades to the identical default —
        // which is why this needs no MIN_INTERJECT_VERSION floor.
        //
        // Rides inside the opaque `push.message`, so worker.ts and
        // PROTOCOL_VERSION stay untouched.
        priority: 'next',
      },
      { intoLiveTurn: true },
    );
  }

  /**
   * Rewrite a queued prompt in place, before it is sent.
   *
   * Two things this deliberately does not do. It never clears `queuePaused`:
   * unlike userPrompt, where an explicit send is the resume gesture, an owner
   * *editing* a guest's pending-approval prompt must not silently approve and run
   * it. And it never reorders or restamps the item, so FIFO is preserved.
   *
   * The `prompt` cap gets you here (see MESSAGE_AUTHZ); this adds the item-level
   * check, because a flushed prompt is attributed to `item.actor` and rewriting a
   * peer's would put words in their mouth.
   */
  editQueued(
    sessionId: string,
    queuedId: string,
    patch: {
      text: string;
      mentions?: PromptMention[];
      draft?: MentionValue;
      addAttachments?: PromptAttachment[];
      removeAttachments?: string[];
    },
    // The full Actor, not just an id: an edit by somebody other than the author
    // is stamped on the item and has to render as a person.
    editor: { actor: Actor; isOwner: boolean },
  ): { ok: true } | { ok: false; reason: string } {
    const meta = this.sessions.get(sessionId);
    const item = meta?.queued?.find((q) => q.id === queuedId);
    // Covers the flush-while-editing race: the turn settled and the item went out
    // while its editor was open.
    if (!meta || !item) return { ok: false, reason: 'That queued prompt is no longer in the queue.' };

    // No actor means it predates attribution — treat it as the machine owner's.
    const isAuthor = !!item.actor && item.actor.userId === editor.actor.userId;
    if (!isAuthor && !editor.isOwner) {
      return { ok: false, reason: 'Only the person who wrote that prompt can edit it.' };
    }

    const removed = new Set(patch.removeAttachments ?? []);
    // Matched against the item's own refs, never used as a path: an arbitrary url
    // from the client must not become a delete primitive over another session.
    const kept = (item.attachments ?? []).filter((a) => !removed.has(a.url));
    const dropped = (item.attachments ?? []).filter((a) => removed.has(a.url));
    const text = patch.text.trim();
    if (!text && kept.length === 0 && !patch.addAttachments?.length) {
      return { ok: false, reason: 'An edited prompt needs text or an attachment.' };
    }

    for (const a of dropped) {
      const file = a.url.split('/').pop();
      if (file) fs.rmSync(`${this.store.attachmentsRoot}/${sessionId}/${file}`, { force: true });
    }
    const staged = patch.addAttachments?.length
      ? this.stageAttachments(sessionId, patch.addAttachments)
      : [];
    const attachments = [...kept, ...staged];

    item.text = text;
    item.attachments = attachments.length ? attachments : undefined;
    item.mentions = patch.mentions?.length ? patch.mentions : undefined;
    item.draft = patch.draft?.ranges.length ? patch.draft : undefined;
    // Recorded only when somebody else did it — an author fixing their own typo
    // is not something the queue needs to announce.
    if (!isAuthor) {
      item.editedAt = Date.now();
      item.editedBy = editor.actor;
    }

    this.upsert(meta);
    return { ok: true };
  }

  /**
   * Re-send the last user prompt after a failed turn (query crash or is_error
   * result). Goes through prompt() directly: the transcript shows the prompt
   * again and `resume` preserves context. Attachments are reloaded from disk
   * the same way queued prompts are (see maybeFlush).
   */
  retryTurn(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta || this.isBusy(meta)) return;
    const last = this.lastPromptForRetry(sessionId);
    if (!last) return;
    this.prompt(sessionId, last.text, last.source, last.attachments);
  }

  /** The last user prompt + attachments rehydrated from disk, for re-sending a
   *  failed turn. Also used by WorkflowEngine, which re-sends it as a step retry —
   *  so a hint added here reaches both retry paths, and only the re-sent prompt
   *  (the stored transcript event keeps what the user actually wrote). */
  lastPromptForRetry(
    sessionId: string,
  ): { text: string; source: 'user' | 'workflow'; attachments: PromptAttachment[] } | null {
    // A compaction emits no 'user' event, so stripping changes nothing here —
    // applied anyway so the invariant is "turn scans never see compact spans".
    const last = withoutCompactSpans(this.store.loadTranscript(sessionId))
      .filter((e) => e.kind === 'user')
      .at(-1);
    const data = last?.data as
      | { text?: string; source?: 'user' | 'workflow'; attachments?: Attachment[] }
      | undefined;
    if (!data || (!data.text && !data.attachments?.length)) return null;

    const attachments = this.reloadAttachments(sessionId, data.attachments);

    // For the failures where the phrasing is what failed, say so in the re-sent
    // prompt: an identical retry of a blocked or oversized turn just fails again.
    const hint = turnFailureRetryHint(this.sessions.get(sessionId)?.errorKind);
    const text = data.text ?? '';
    return {
      text: hint ? `${text}\n\n${hint}` : text,
      source: data.source ?? 'user',
      attachments,
    };
  }

  /**
   * Read a stored prompt's attachments back off disk as re-sendable base64. One
   * that has since been removed is dropped rather than failing the whole prompt.
   * Shared by lastPromptForRetry and rewindSession so both reload identically.
   */
  private reloadAttachments(sessionId: string, attachments: Attachment[] | undefined): PromptAttachment[] {
    return (attachments ?? [])
      .map((a) => {
        const file = a.url.split('/').pop()!;
        const b64 = this.store.loadAttachmentBase64(sessionId, file);
        return b64 ? { name: a.name, mediaType: a.mediaType, data: b64 } : null;
      })
      .filter((a): a is PromptAttachment => a !== null);
  }

  /**
   * Rewind the session to the `'user'` transcript event at `seq`: everything from
   * that event on is discarded. The escape hatch for a context overflow, where
   * Retry cannot help because the oversized prompt is still in the CLI's own
   * history.
   *
   * `opts.edit` decides the fate of the rewound prompt: it comes back in the
   * returned `prompt` for the composer to prefill, or is discarded with the rest
   * of the tail (`prompt: null`). Attachments are only reloaded for the edit case,
   * since that read is the expensive half.
   *
   * Ordered fork-then-truncate on purpose: `forkSession` copies the CLI transcript
   * up to the anchor into a new session file, so a fork that fails aborts with
   * Lines' transcript untouched. The next ordinary prompt() resumes the fork
   * through the existing `resume:` line in buildQueryOptions — no new query option
   * and no one-shot state to persist.
   *
   * Rewinding to the session's very first prompt has no assistant message to
   * anchor on; that degrades to resetClaudeSession, which is already exactly the
   * right thing there (no prior turns to keep).
   *
   * Cumulative spend (totalCostUsd/totalTokens) is deliberately NOT rewound —
   * that money was really spent, so the counter stays ahead of the visible
   * transcript.
   */
  async rewindSession(
    sessionId: string,
    seq: number,
    opts: { edit?: boolean } = {},
  ): Promise<{ ok: true; prompt: RewindPrompt | null } | ({ ok: false } & RewindBlockInfo)> {
    const meta = this.sessions.get(sessionId);
    if (!meta) {
      return { ok: false, code: 'no-session', reason: "Send a message first — there's nothing to rewind yet." };
    }
    const block = rewindBlock(meta);
    if (block) return { ok: false, ...block };
    // Claimed before the first await, so a double-click cannot get two rewinds
    // past the gate and fork twice off an already-stale claudeSessionId.
    if (this.rewinding.has(sessionId)) {
      return { ok: false, code: 'turn-running', reason: 'A rewind is already running.' };
    }

    const events = this.store.loadTranscript(sessionId);
    const index = events.findIndex((e) => e.seq === seq);
    const target = index >= 0 ? events[index] : undefined;
    if (!target || target.kind !== 'user') {
      return { ok: false, code: 'no-message', reason: 'That message can no longer be rewound to.' };
    }
    const data = target.data as { text?: string; mentions?: PromptMention[]; attachments?: Attachment[] };
    const prompt: RewindPrompt | null = opts.edit
      ? {
          // No turnFailureRetryHint here, unlike a retry: the user is about to edit
          // the text by hand, which is the very thing the hint exists to ask for.
          text: data.text ?? '',
          ...(data.mentions?.length ? { mentions: data.mentions } : {}),
          attachments: this.reloadAttachments(sessionId, data.attachments),
        }
      : null;

    // The CLI anchor: the nearest preceding assistant message, whose uuid is what
    // the SDK documents upToMessageId against. Already on disk — handleWorkerEvent
    // writes every non-stream SDK message verbatim.
    let anchor: string | undefined;
    for (let i = index - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind !== 'sdk') continue;
      const d = e.data as { type?: string; uuid?: string } | null;
      if (d?.type === 'assistant' && typeof d.uuid === 'string' && d.uuid) {
        anchor = d.uuid;
        break;
      }
    }

    this.rewinding.add(sessionId);
    try {
      if (anchor) {
        const fork = await this.forkSession(meta.claudeSessionId!, {
          upToMessageId: anchor,
          dir: meta.cwd,
        });
        // Re-read: the session can have been deleted while the fork ran.
        const live = this.sessions.get(sessionId);
        if (!live) {
          return { ok: false, code: 'no-session', reason: 'That session is gone.' };
        }
        live.claudeSessionId = fork.sessionId;
        this.closeQuery(sessionId);
      } else {
        // Nothing before this prompt to keep — the blunter reset is the honest
        // outcome, and the confirm dialog says so before we get here.
        this.resetClaudeSession(sessionId);
      }
    } catch (err) {
      console.warn('[rewind]', err);
      return {
        ok: false,
        code: 'fork-failed',
        reason: `Could not rewind this session's history (${err instanceof Error ? err.message : String(err)}).`,
      };
    } finally {
      this.rewinding.delete(sessionId);
    }

    this.store.truncateTranscript(sessionId, seq);
    // The next emitEvent picks the numbering back up where the discarded tail began.
    this.liveState(sessionId).seq = seq;
    // Broadcast from here, not from the WS handler: the listener below may emit
    // events of its own, and a truncation frame sent after them would tell every
    // client to drop exactly those (they carry seq >= this one).
    this.broadcast({ type: 'transcriptTruncated', sessionId, seq });
    // Reject the discarded query's callbacks without writing resolution events —
    // the events they would land in are exactly the ones just truncated away.
    this.flushPending(sessionId);

    // Derived state that outlives the transcript — a workflow's step bookkeeping —
    // is rolled back by its owner, which may also settle the session itself.
    const settled = this.onRewind?.(sessionId) ?? false;

    const after = this.sessions.get(sessionId);
    if (after) {
      // Same treatment resetClaudeSession applies, for the same reason: the
      // occupancy reading describes a conversation that is gone, and a new CLI
      // conversation is a new compaction verdict.
      after.contextResetAt = Date.now();
      after.contextCompact = undefined;
      // Clears errorMessage/errorKind too, which is the point — the failed turn
      // that prompted the rewind is no longer in the transcript. Skipped when the
      // listener parked the session: 'idle' would drop that park and leave a
      // workflow step with no way to be approved.
      if (settled) this.persistMeta(sessionId);
      else this.setStatus(sessionId, 'idle');
    }
    return { ok: true, prompt };
  }

  /**
   * Resume a session whose turn died with the app (see reconcileWithWorker).
   * Resumes via claudeSessionId with a synthetic nudge and releases the queue.
   */
  continueTurn(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.interruptedAt || this.isBusy(meta)) return;

    // Close permission cards orphaned by the dead turn so a later click on one
    // can't inject a recovery prompt into the now-running query.
    this.expireUnresolvedPermissions(sessionId);

    meta.queuePaused = undefined; // let queued follow-ups flow after this turn
    // Resume a mid-step workflow turn AS a workflow turn so its completion still
    // routes through onWorkflowTurnComplete and parks the step for approve/retry.
    const wfStepRunning =
      meta.workflow?.started &&
      meta.workflow.stepStatuses[meta.workflow.stepIndex] === 'running';
    this.prompt(
      sessionId,
      'You were interrupted mid-task (the app was closed while you were working). ' +
        'Review where you left off and continue the task from there.',
      wfStepRunning ? 'workflow' : 'user',
    );
  }

  /**
   * Emit an 'expired' resolution for every unresolved permission request, except
   * the human-only ones: a plan-approval or question card is deliberately
   * answerable long after its query died (resolvePermission routes a late click
   * to recoverOrphanedPermission), and expiring it would quietly discard the one
   * decision the server is not allowed to make for the user.
   */
  private expireUnresolvedPermissions(sessionId: string) {
    const events = this.store.loadTranscript(sessionId);
    for (const { requestId, toolName } of unresolvedPermissions(events)) {
      if (ALWAYS_ASK_TOOLS.has(toolName)) continue;
      this.emitEvent(sessionId, 'permission', {
        requestId,
        toolName: '',
        input: {},
        resolution: 'expired',
        resolvedBy: 'interrupt-expire',
      } satisfies PermissionRequestData);
      this.logResolution(sessionId, toolName, 'expired', 'interrupt-expire');
    }
  }

  /** Send a prompt into the session; the worker starts the SDK query if needed. */
  prompt(
    sessionId: string,
    text: string,
    source: 'user' | 'workflow' = 'user',
    attachments: PromptAttachment[] = [],
    mentions: PromptMention[] = [],
    /** Who sent it. Absent for the owner and for internal callers (workflows,
     *  recovery), which read as the session's host on the way out. */
    actor?: Actor,
  ) {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`unknown session ${sessionId}`);

    // Sending a message reactivates an archived/completed session.
    if (meta.archived) {
      meta.archived = false;
      meta.archivedAt = undefined;
      meta.completed = false;
    }

    // Persist attachments to disk (transcript refs) and build the SDK content blocks.
    const stored = this.stageAttachments(sessionId, attachments);
    const blocks: unknown[] = [];
    for (const att of attachments) {
      const kind = attachmentKind(att.mediaType);
      if (kind === 'image') {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.data } });
      } else if (kind === 'document') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: att.mediaType, data: att.data } });
      } else {
        const content = Buffer.from(att.data, 'base64').toString('utf8');
        blocks.push({ type: 'text', text: `Attached file "${att.name}":\n\`\`\`\n${content}\n\`\`\`` });
      }
    }

    this.emitEvent(sessionId, 'user', {
      text,
      source,
      ...(stored.length ? { attachments: stored } : {}),
      ...(mentions.length ? { mentions } : {}),
      // Persisted in the append-only JSONL, so attribution survives a restart.
      ...(actor ? { actor } : {}),
    });
    // One field on the synced blob, so the sidebar can say who is running the
    // turn. Cleared when nobody in particular sent it, rather than left stale.
    if (actor) meta.turnActor = actor;
    else delete meta.turnActor;

    // First real user prompt names the session from its topic. Guard flips
    // immediately so a slow title query can't fire twice or clobber a manual rename.
    if (source === 'user') this.maybeAutoName(sessionId, text);

    // Persisted (not just in-memory) so a bridge restart mid-turn still
    // attributes the eventual result to the right initiator, and the activity
    // row's elapsed time survives reloads.
    meta.turnSource = source;
    meta.turnStartedAt = Date.now();
    // Opens this turn's attribution window (see recordFilesChanged). Never
    // awaited — a slow `git stash create` must not delay the prompt reaching the
    // worker; a window that loses the race just isn't recorded.
    void this.openTurnWindow(sessionId);
    meta.interruptedAt = undefined; // any prompt clears the crash-interrupted flag
    this.interrupting.delete(sessionId); // a new turn supersedes any in-flight interrupt
    // A user prompt after a force-advance (before the interrupted turn settled)
    // means they want to keep working here — don't let the stale flag advance a
    // later turn. Only for 'user': continueTurn and recoverOrphanedPermission
    // deliberately re-prompt as 'workflow' and must keep a pending advance.
    if (source === 'user' && meta.workflow?.advanceOnComplete === 'interrupted') {
      meta.workflow.advanceOnComplete = undefined;
      meta.workflow.advanceOnCompleteStep = undefined;
    }
    this.setStatus(sessionId, 'running'); // upserts, persisting turnSource too

    const content = [...blocks, ...(text ? [{ type: 'text', text }] : [])];
    this.pushTurnSafely(meta, { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
  }

  /**
   * Compact this session's context now. Deliberately not routed through
   * prompt(): a compaction is not a user turn — it emits no 'user' event, so it
   * stays invisible to every turn scan (see withoutCompactSpans), and it must not
   * auto-name the session, clear the interrupted flag, or touch the queue.
   *
   * The mechanism is the CLI's own: `/compact` dispatches from ordinary prompt
   * text (`supportsNonInteractive` + `thinClientDispatch: "post-text"`), so the
   * push below is the same path a prompt takes. That is reverse-engineered, not a
   * published SDK contract — hence nothing here assumes it worked. Only an
   * explicit SDK `compact_result: 'failed'` records `ok: false`, which flips this
   * guard to `unsupported` for the rest of this CLI conversation; a turn that just
   * settles quietly is inconclusive and leaves the button clickable.
   */
  compactContext(sessionId: string): { ok: true } | ({ ok: false } & ContextCompactBlockInfo) {
    const meta = this.sessions.get(sessionId);
    if (!meta) {
      return { ok: false, code: 'no-session', reason: "Send a message first — there's nothing to compact yet." };
    }
    const block = contextCompactBlock(meta);
    if (block) return { ok: false, ...block };
    // Belt and braces: an in-flight compaction already shows as 'running' above.
    if (this.compacting.has(sessionId)) {
      return { ok: false, code: 'turn-running', reason: 'Finish the current turn first.' };
    }

    this.compacting.add(sessionId);
    this.emitEvent(sessionId, 'context-compact', {
      phase: 'requested',
      trigger: 'manual',
    } satisfies ContextCompactData);
    // A compaction must not move the step lifecycle. Remember what the 'running'
    // below is about to cover — a parked step, or a failed one with its red banner —
    // so the settle can put it back (see restoreCompactedStatus).
    if (meta.status === 'waiting-approval' || meta.status === 'error') {
      this.liveState(sessionId).compactResume = {
        status: meta.status,
        errorMessage: meta.errorMessage,
        errorKind: meta.errorKind,
      };
    }
    meta.turnSource = 'user';
    meta.turnStartedAt = Date.now();
    this.setStatus(sessionId, 'running');

    // Synchronous { ok: true } stands: an auth refusal after this point surfaces
    // through failTurn, not through the { ok: false, code, reason } union.
    this.pushTurnSafely(meta, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/compact' }] },
      parent_tool_use_id: null,
    });
    return { ok: true };
  }

  /**
   * Close an open compaction span without judging the mechanism: the user stopped
   * it, or the query died. Neither proves compaction is unavailable, so no
   * `contextCompact` record is written — only the transcript span is closed, so a
   * later turn scan isn't bounded by an orphan marker.
   *
   * Returns true when it put back a status the compaction had covered — the caller
   * must not then settle the session itself (see interrupt).
   */
  private abandonCompaction(sessionId: string, error: string): boolean {
    if (!this.compacting.delete(sessionId)) return false;
    this.liveState(sessionId).compactedInTurn = undefined;
    this.emitEvent(sessionId, 'context-compact', {
      phase: 'done',
      trigger: 'manual',
      ok: false,
      error,
    } satisfies ContextCompactData);
    // No `result` is coming on most of these paths (a dead query, a stop), so the
    // restore has to happen here rather than in the settle branch.
    const restored = this.restoreCompactedStatus(sessionId);
    if (restored) this.persistMeta(sessionId);
    return restored;
  }

  /**
   * Put back the status a manual compaction covered with its 'running' turn: a
   * parked step stays parked, a failed step keeps its red banner and Retry.
   *
   * Idempotent — the first caller consumes the record — so abandonCompaction and the
   * `result` settle branch can both call it. Persisting is the caller's job, so the
   * settle branch can fold it into the single upsert it already does.
   *
   * A compaction that *failed* is not reported here: that surfaces through the
   * context-compact transcript span and the `contextCompact` record (which flips the
   * button to `unsupported`). The session's own status is not repurposed for it.
   */
  private restoreCompactedStatus(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    const resume = live?.compactResume;
    if (!resume) return false;
    live.compactResume = undefined;
    const meta = this.sessions.get(sessionId);
    // Only undo our own 'running': anything else means the session moved on.
    if (!meta || !isSessionInterruptible(meta.status)) return false;
    meta.status = resume.status;
    meta.errorMessage = resume.errorMessage;
    meta.errorKind = resume.errorKind;
    return true;
  }

  /**
   * Drop the resumed CLI context so this session's next prompt starts a brand-new
   * Claude session (no memory of prior turns). Used by fresh-start workflow steps.
   * The next SDK message re-captures a fresh claudeSessionId (see handleSdkMessage).
   */
  resetClaudeSession(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.claudeSessionId = undefined;
    // The occupancy readings now describe a conversation that is gone; they stay
    // (a fresh step's overhead is close to the old floor) but render as stale.
    meta.contextResetAt = Date.now();
    // A fresh CLI conversation is a fresh verdict: whatever compaction did or
    // didn't do in the old one says nothing about this one.
    meta.contextCompact = undefined;
    this.worker.close(sessionId);
    // Same reason as closeQuery: the CLI child that owned them is gone.
    this.setBackgroundTasks(sessionId, []);
  }

  /**
   * The deliverable of the most recent turn ('' if none) — its plan when it ended
   * in plan mode, else its final assistant text block. Reused as the `{previous}`
   * hand-off when a fresh step needs the prior step's output (e.g. a plan).
   */
  lastAssistantText(sessionId: string): string {
    const events = withoutCompactSpans(this.store.loadTranscript(sessionId));
    let lastUserIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    return collectTurns(events, lastUserIdx, this.planRoots(sessionId)).at(-1)?.output ?? '';
  }

  /** Roots a plan-file read may resolve inside for this session (see collectTurns). */
  private planRoots(sessionId: string): string[] {
    const meta = this.get(sessionId);
    return meta ? this.rootsFor(meta) : [];
  }

  /**
   * Reconstruct the definitive output of the just-finished workflow step. When
   * the step ran a single turn its final text is the deliverable (returned as-is,
   * zero cost). But an iterated step (feedback retry / follow-up) usually ends on
   * a short delta reply ("fixed X"); passing that to the next step corrupts the
   * hand-off. So for multi-turn steps, run a one-shot Sonnet query (same
   * non-agentic shape as summarizeTurn) that folds every turn's output plus the
   * user's feedback into the single final deliverable. Falls back to
   * lastAssistantText on any failure — never blocks the workflow.
   *
   * "Never blocks" is enforced, not hoped for: the token refresh and the query drain
   * are raced against `consolidateTimeoutMs`. `advance` awaits this with `advancing`
   * already on the wire, so an unbounded stall here is a workflow that never reaches
   * its next step and a stepper stuck on "wrapping up its output…".
   */
  async consolidateStepOutput(sessionId: string, stepIndex?: number): Promise<string> {
    try {
      // Stripped before findStepStart, so the index it returns and the slice
      // collectTurns takes are cut from the same array.
      const events = withoutCompactSpans(this.store.loadTranscript(sessionId));
      // Slice from the marker that opened *this* step, not merely the newest
      // 'started' one: with a step queued while the previous one consolidates,
      // the newest marker can already belong to the next step.
      const startIdx = findStepStart(events, stepIndex);
      if (startIdx === -1) return this.lastAssistantText(sessionId);

      // Each 'user' event in the slice opens a turn (its text is the initial
      // prompt or the iteration feedback); its output is that turn's deliverable.
      const turns = collectTurns(events, startIdx, this.planRoots(sessionId));

      // Single-turn step: its final text is the deliverable — no query, no latency.
      if (turns.length <= 1) return turns[0]?.output ?? this.lastAssistantText(sessionId);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol('consolidate-timeout');
      const output = await Promise.race([
        this.consolidateQuery(turns),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), this.consolidateTimeoutMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      if (output === timedOut) {
        // The abandoned query keeps draining in the background; nothing reads it.
        console.warn(`[consolidateStepOutput] timed out after ${this.consolidateTimeoutMs}ms`);
        return this.lastAssistantText(sessionId);
      }
      return output || this.lastAssistantText(sessionId);
    } catch (err) {
      console.warn('[consolidateStepOutput]', err);
      return this.lastAssistantText(sessionId);
    }
  }

  /** The consolidation query itself — everything consolidateStepOutput has to bound. */
  private async consolidateQuery(turns: { user: string; output: string }[]): Promise<string | null> {
    try {
      const token = await this.ownerToken();
      if (!token) return null;

      const initialPrompt = turns[0].user.slice(0, 4000);
      const attempts = turns
        .map((t, n) => {
          const parts = [`### Attempt ${n + 1} output\n${t.output.slice(0, 8000)}`];
          // The feedback that produced attempt n+1 is the user text opening it.
          if (n > 0 && t.user) parts.unshift(`### User feedback ${n}\n${t.user.slice(0, 2000)}`);
          return parts.join('\n\n');
        })
        .join('\n\n');
      const prompt =
        `A workflow step was iterated across ${turns.length} attempts. Its initial ` +
        `instruction:\n\n<instruction>\n${initialPrompt}\n</instruction>\n\n` +
        `The attempts and the user's feedback between them, in order:\n\n${attempts}\n\n` +
        'Produce the single definitive final output of this step, incorporating every ' +
        'revision. Preserve the exact format and full detail the initial instruction ' +
        'requested. Where a later attempt only describes changes, apply them to the ' +
        'earlier full output. Output only the deliverable itself — no preamble, no ' +
        'commentary about what changed.';

      const q = query({
        prompt,
        options: baseQueryOptions(
          token,
          'claude-sonnet-5',
          'You consolidate an iterated workflow step into its single final ' +
            'deliverable. You never ask questions, never refuse, and never add ' +
            'commentary or preamble — you output only the deliverable.',
        ) as never,
      });
      let output: string | null = null;
      for await (const message of q) {
        const msg = message as { type: string; result?: string };
        if (msg.type === 'result' && typeof msg.result === 'string') {
          output = msg.result.trim();
        }
      }
      return output;
    } catch (err) {
      console.warn('[consolidateStepOutput]', err);
      return null;
    }
  }

  /**
   * Token for the bridge-side helper queries (autoName/summarizeTurn/
   * consolidateStepOutput): they run outside the worker, so they need the
   * owner's OAuth token explicitly. Refreshes like a real turn rather than
   * reading the sync cache, and returns null — never a fallback to the
   * ambient CLI login — when the app has no usable token.
   */
  private async ownerToken(): Promise<string | null> {
    if (!this.auth) return null;
    try {
      return await this.auth.ensureFreshToken();
    } catch {
      return null;
    }
  }

  /**
   * Title the session from `text` if it hasn't been auto-named yet. Guard flips
   * immediately so a slow title query can't fire twice or clobber a manual rename.
   * Workflow sessions call this with the task description (their prompts arrive
   * with source 'workflow', which skips the auto-name path in prompt()).
   */
  maybeAutoName(sessionId: string, text: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta?.nameAuto) return;
    meta.nameAuto = false;
    void this.autoName(sessionId, text);
  }

  /**
   * Generate a short session title from the first prompt via a one-shot Haiku
   * query (no tools, no session context). Fire-and-forget; failure keeps the
   * default name. upsert() broadcasts the rename to the UI. Runs in the
   * bridge on purpose — losing it to a restart only costs a title.
   */
  private async autoName(sessionId: string, prompt: string) {
    // Every exit from here reports what the title ended up being, so a caller that
    // is waiting on the name (the work-tree branch) is never left hanging.
    const settled = (title: string) => {
      const meta = this.sessions.get(sessionId);
      if (meta) this.onAutoNamed?.(meta, title);
    };
    try {
      const token = await this.ownerToken();
      if (!token) return settled('');

      const q = query({
        prompt:
          'Summarize the following task in a 3-6 word title. Output only the ' +
          'title itself: no quotes, no trailing punctuation, no preamble, no ' +
          'commentary. If the text is empty or unclear, do your best with ' +
          'whatever is given.\n\n<task>\n' +
          prompt.slice(0, 2000) +
          '\n</task>',
        options: baseQueryOptions(
          token,
          'claude-haiku-4-5-20251001',
          'You are a title generator. You receive a task description and ' +
            'reply with a single short title. You never ask questions, never ' +
            'refuse, and never add commentary — you only output the title.',
        ) as never,
      });
      let title: string | null = null;
      for await (const message of q) {
        const msg = message as { type: string; result?: string };
        if (msg.type === 'result' && typeof msg.result === 'string') {
          title = msg.result.trim().replace(/^["']|["']$/g, '').slice(0, 60);
        }
      }
      if (!title) return settled('');
      const meta = this.sessions.get(sessionId);
      if (!meta) return;
      meta.name = title;
      this.upsert(meta);
      settled(title);
    } catch (err) {
      console.warn('[autoName]', err);
      settled('');
    }
  }

  /**
   * Summarize a just-finished turn's tool activity in 1-2 sentences via a
   * one-shot Haiku query (same non-agentic shape as autoName), so the Compact
   * transcript view can show what the agent did instead of a bare tool tally.
   * Fire-and-forget; skipped entirely if the turn made no tool calls. Persisted
   * as a 'turn-summary' event keyed by the result event's seq, so it survives
   * reload via the normal transcript replay path.
   */
  private async summarizeTurn(sessionId: string, resultSeq: number) {
    try {
      const events = withoutCompactSpans(this.store.loadTranscript(sessionId));
      const lastUserIdx = (() => {
        for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === 'user') return i;
        return -1;
      })();
      const turnEvents = events.slice(Math.max(lastUserIdx, 0));

      const { toolCalls, toolErrors, finalText } = scanTurnActivity(turnEvents);
      if (toolCalls.length === 0) return; // plain text answer — nothing to summarize

      const token = await this.ownerToken();
      if (!token) return;

      const lines = toolCalls.map((t) => {
        const input = t.input.file_path ?? t.input.command ?? t.input.pattern ?? t.input.url ?? '';
        const failed = toolErrors.has(t.id) ? ' (failed)' : '';
        return `- ${t.name}${input ? `: ${String(input).slice(0, 150)}` : ''}${failed}`;
      });
      const prompt =
        `A coding agent just finished a turn. Tool calls made, in order:\n${lines.join('\n')}\n\n` +
        (finalText ? `Its final message to the user:\n${finalText.slice(0, 500)}\n\n` : '') +
        'Summarize what it did in 1-2 concise sentences, for a developer glancing at a ' +
        'collapsed activity card. Be specific about files/commands touched. No preamble.';

      const q = query({
        prompt,
        options: baseQueryOptions(
          token,
          'claude-haiku-4-5-20251001',
          'You summarize a coding agent\'s completed turn in 1-2 plain sentences. ' +
            'You never ask questions, never refuse, and never add commentary or preamble.',
        ) as never,
      });
      let summary: string | null = null;
      for await (const message of q) {
        const msg = message as { type: string; result?: string };
        if (msg.type === 'result' && typeof msg.result === 'string') {
          summary = msg.result.trim().slice(0, 400);
        }
      }
      if (!summary) return;
      this.emitEvent(sessionId, 'turn-summary', { resultSeq, summary });
    } catch (err) {
      console.warn('[summarizeTurn]', err);
    }
  }

  /**
   * Stop the live turn — nothing more. Deliberately intent-free: it never infers
   * "this step is done" from "stop". A stopped workflow step settles into
   * waiting-approval so the user can iterate; the only callers that want an
   * advance set `advanceOnComplete` themselves (see WorkflowEngine.forceAdvance).
   */
  interrupt(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    this.interrupting.add(sessionId);
    // A stopped compaction is a user decision, not a broken mechanism.
    const reparked = this.abandonCompaction(sessionId, 'interrupted');
    this.worker.interrupt(sessionId);
    // Deny anything waiting on the user so the query is not stuck; user
    // explicitly stopped, so close the cards too.
    this.flushPending(sessionId, { emitResolution: 'deny' });
    // Keep the queue but suspend auto-flush; the next user send resumes it.
    if (meta?.queued?.length) meta.queuePaused = true;
    if (meta) meta.turnStartedAt = undefined;
    // Stopping a compaction that ran over a parked/failed step settles nothing about
    // the step — abandonCompaction has already put that status back, and 'idle' here
    // would drop the park and leave the step with no way to be approved.
    if (reparked) this.persistMeta(sessionId);
    else this.setStatus(sessionId, 'idle');
  }

  /**
   * Resolve every pending permission promise as denied. By default the UI
   * cards are left open: an unresolved request can still be answered later —
   * the worker re-delivers open requests after a bridge restart, and the
   * resume-recovery path in resolvePermission() covers truly dead queries,
   * so the user never has to re-prompt.
   */
  private flushPending(sessionId: string, opts: { emitResolution?: 'deny' | 'expired' } = {}) {
    const state = this.live.get(sessionId);
    if (!state) return;
    for (const [requestId, resolve] of state.pendingPermissions) {
      if (opts.emitResolution) {
        this.emitEvent(sessionId, 'permission', {
          requestId,
          toolName: '',
          input: {},
          resolution: opts.emitResolution,
          resolvedBy: 'stop',
        } satisfies PermissionRequestData);
        this.logResolution(sessionId, '', opts.emitResolution, 'stop');
      }
      resolve({ allow: false });
    }
    state.pendingPermissions.clear();
  }

  /** Look up the original (unresolved) permission request in the transcript. */
  private findPermissionRequest(sessionId: string, requestId: string): PermissionRequestData | null {
    for (const event of this.store.loadTranscript(sessionId)) {
      if (event.kind !== 'permission') continue;
      const data = event.data as PermissionRequestData;
      if (data.requestId === requestId && data.toolName) return data;
    }
    return null;
  }

  /**
   * Look up a recorded resolution for a permission request in the transcript.
   * Scanned backwards — the newest resolution wins, matching exitPlanRequestId's
   * convention. Forwards, an early 'expired' or 'deny' would outrank the real
   * answer that followed it.
   */
  private findPermissionResolution(sessionId: string, requestId: string): PermissionRequestData | null {
    const events = this.store.loadTranscript(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.kind !== 'permission') continue;
      const data = event.data as PermissionRequestData;
      if (data.requestId === requestId && data.resolution) return data;
    }
    return null;
  }

  /**
   * The query that asked this permission is gone (worker crash, compression
   * toggle) — the CLI turn died with it. Recover by resuming the session and
   * telling Claude what the user decided, so no re-prompt is needed even
   * hours later.
   */
  private recoverOrphanedPermission(
    sessionId: string,
    requestId: string,
    allow: boolean,
    answers?: Record<string, string>,
    denyMessage?: string,
  ) {
    // Already answered — a second click, a second tab, or a stale card. Recovering
    // again would inject another "I approved your plan" prompt off one decision.
    if (this.findPermissionResolution(sessionId, requestId)) {
      console.log(`[permission] [session ${sessionId}] duplicate answer ignored (${requestId})`);
      return;
    }

    const meta = this.sessions.get(sessionId);
    const original = meta ? this.findPermissionRequest(sessionId, requestId) : null;
    if (!meta || !original) {
      this.emitEvent(sessionId, 'permission', {
        requestId,
        toolName: '',
        input: {},
        resolution: 'expired',
        resolvedBy: 'recovery',
      } satisfies PermissionRequestData);
      this.logResolution(sessionId, original?.toolName ?? '', 'expired', 'recovery');
      return;
    }

    this.emitEvent(sessionId, 'permission', {
      requestId,
      toolName: '',
      input: {},
      resolution: allow ? 'allow' : 'deny',
      resolvedBy: 'recovery',
      answers,
      denyMessage: allow ? undefined : denyMessage,
    } satisfies PermissionRequestData);
    this.logResolution(sessionId, original.toolName, allow ? 'allow' : 'deny', 'recovery');

    let text: string;
    if (original.toolName === 'ExitPlanMode' && allow) {
      const wf = meta.workflow;
      const stepRunning = !!wf && wf.stepStatuses[wf.stepIndex] === 'running';
      if (stepRunning && (wf!.stepPermissionMode ?? meta.permissionMode) === 'plan') {
        // Configured plan step: advance the workflow instead of implementing in place.
        wf!.advanceOnComplete = true;
        wf!.advanceOnCompleteStep = wf!.stepIndex; // only this step's settle may consume it
        this.upsert(meta);
        text =
          'I approved your plan (the session was interrupted before the approval reached you). ' +
          'Do not implement anything now — end your turn. The workflow will proceed to the next step.';
      } else {
        // Resume outside plan mode so the approved plan gets implemented in place.
        if (meta.permissionMode === 'plan') {
          meta.permissionMode =
            stepRunning && wf!.stepPermissionMode && wf!.stepPermissionMode !== 'plan'
              ? wf!.stepPermissionMode // manual override: resume in the step's configured mode
              : 'default';
          this.upsert(meta);
        }
        text =
          'I approved your plan (the session was interrupted before the approval reached you). ' +
          'Proceed with the implementation now.';
      }
    } else if (original.toolName === 'AskUserQuestion' && allow && answers) {
      const lines = Object.entries(answers).map(([q, a]) => `- ${q}\n  Answer: ${a}`);
      text =
        'You previously asked me these questions, but the session was interrupted before my answers reached you:\n' +
        `${lines.join('\n')}\n\nContinue the task using these answers. Do not re-ask them.`;
    } else if (allow) {
      const inputJson = JSON.stringify(original.input, null, 2);
      text =
        `Earlier you requested permission to use the ${original.toolName} tool with this input:\n` +
        '```json\n' +
        (inputJson.length > 4000 ? inputJson.slice(0, 4000) + '…' : inputJson) +
        '\n```\n' +
        'The session was interrupted before my approval reached you. I approve — retry that action now and continue the task.';
    } else {
      text =
        `Earlier you requested permission to use the ${original.toolName} tool, but the session was interrupted. ` +
        `I decline that request.${denyMessage ? ` ${denyMessage}` : ''} Adjust your approach and continue.`;
    }

    // Route through the workflow-aware turn source so a mid-step recovery
    // still advances the workflow when the turn completes.
    const wfRunning =
      meta.workflow && meta.workflow.stepStatuses[meta.workflow.stepIndex] === 'running';
    this.prompt(sessionId, text, wfRunning ? 'workflow' : 'user');
  }

  setModel(sessionId: string, model: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    const resolved = resolveModelId(model);
    if (resolved !== model) {
      console.warn(`legacy model "${model}" resolved to "${resolved}"`);
    }
    meta.model = resolved;
    this.upsert(meta);
    this.worker.setModel(sessionId, resolved);
  }

  setPermissionMode(sessionId: string, mode: PermissionMode) {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.permissionMode = mode;
    this.upsert(meta);
    this.worker.setPermissionMode(sessionId, sdkPermissionMode(mode));
  }

  /**
   * Record and deliver a decision on one permission request. `source` says who
   * decided: it defaults to 'user' because every wire-level caller is a click,
   * and internal callers pass their own so the transcript can tell a human answer
   * from one the server synthesized.
   */
  resolvePermission(
    sessionId: string,
    requestId: string,
    allow: boolean,
    updatedInput?: Record<string, unknown>,
    answers?: Record<string, string>,
    denyMessage?: string,
    alwaysAllow?: boolean,
    source: PermissionResolutionSource = 'user',
    /** Who clicked. Absent for the owner and for every internal caller. */
    actor?: Actor,
    /**
     * ExitPlanMode only: the notes the user left on passages of the plan.
     * Already normalized by the caller. On a deny they *are* the reason (the
     * passed `denyMessage` is ignored); on an allow they are delivered into the
     * turn the approval starts, since an SDK allow carries no text.
     */
    planComments?: PlanComment[],
  ) {
    // Persist the exception first so it also covers the recovery path.
    if (allow && alwaysAllow) {
      const original = this.findPermissionRequest(sessionId, requestId);
      if (original) {
        const entry = allowEntryFor(original.toolName, original.input);
        if (this.guard.add(entry).ok) {
          console.log('[guard] allowlisted:', entry.tool, entry.prefix ?? '');
        }
      }
    }
    const state = this.live.get(sessionId);
    const resolve = state?.pendingPermissions.get(requestId);
    if (!resolve) {
      // Already answered once: a double click, a second tab, or a card left open
      // by flushPending. Silently drop it rather than synthesizing a second
      // decision out of one gesture.
      if (this.findPermissionResolution(sessionId, requestId)) {
        console.log(`[permission] [session ${sessionId}] duplicate answer ignored (${requestId})`);
        return;
      }
      // The query that asked is gone — resume the session and deliver the
      // decision as a message instead of forcing the user to re-prompt.
      this.recoverOrphanedPermission(sessionId, requestId, allow, answers, denyMessage);
      return;
    }
    state!.pendingPermissions.delete(requestId);

    // Approving a plan inside a workflow plan step advances the workflow instead
    // of implementing in-place: deny ExitPlanMode so the step stays read-only and
    // ends its turn, then flag the workflow to advance when that turn completes.
    const original = this.findPermissionRequest(sessionId, requestId);
    const meta0 = this.sessions.get(sessionId);
    const planStepGate =
      allow &&
      original?.toolName === 'ExitPlanMode' &&
      !!meta0?.workflow &&
      meta0.workflow.stepStatuses[meta0.workflow.stepIndex] === 'running' &&
      (meta0.workflow.stepPermissionMode ?? meta0.permissionMode) === 'plan';

    // The recorded 'allow' of a gated plan step is the user's decision, not the
    // SDK's answer (the tool itself is denied below) — resolvedBy says which.
    const resolvedBy: PermissionResolutionSource = planStepGate ? 'workflow-advance' : source;

    // Comments belong to a plan review and nowhere else; anything attached to
    // another tool's card is dropped rather than smuggled into its reason.
    const comments = original?.toolName === 'ExitPlanMode' ? (planComments ?? []) : [];
    // The server owns the wording on a deny, so "Refine with comments" and the
    // typed composer reply read identically to the model — whatever the client
    // sent as `denyMessage` is discarded.
    if (!allow && comments.length) denyMessage = formatPlanComments(comments, 'refine');
    // updatedInput is recorded so a worker rpc re-send after a bridge restart
    // can be answered from the transcript with the exact approved input.
    this.emitEvent(sessionId, 'permission', {
      requestId,
      toolName: '',
      input: {},
      resolution: allow ? 'allow' : 'deny',
      resolvedBy,
      ...(actor ? { resolvedActor: actor } : {}),
      answers,
      updatedInput,
      denyMessage: allow ? undefined : denyMessage,
    } satisfies PermissionRequestData);
    this.logResolution(
      sessionId,
      original?.toolName ?? '',
      allow ? 'allow' : 'deny',
      resolvedBy,
      actor,
    );

    if (planStepGate) {
      meta0!.workflow!.advanceOnComplete = true;
      meta0!.workflow!.advanceOnCompleteStep = meta0!.workflow!.stepIndex;
      this.upsert(meta0!);
      resolve({
        allow: false,
        denyMessage:
          'The user approved this plan. Do not implement anything now — end your turn. ' +
          'The workflow will proceed to the next step.' +
          // Folded into the gate message rather than interjected: this turn is
          // ending so the workflow can advance, and a pushed message would land
          // in a turn with nothing left to steer. The next step reads them here.
          (comments.length ? `\n\n${formatPlanComments(comments, 'approve')}` : ''),
      });
      return;
    }

    resolve({ allow, updatedInput, denyMessage });

    // Approving a plan exits plan mode inside the CLI — mirror that in our
    // session meta so the composer's mode control stays truthful.
    if (allow) {
      const meta = this.sessions.get(sessionId);
      if (meta && original?.toolName === 'ExitPlanMode' && meta.permissionMode === 'plan') {
        const wf = meta.workflow;
        const stepMode =
          wf && wf.stepStatuses[wf.stepIndex] === 'running' ? wf.stepPermissionMode : undefined;
        if (stepMode && stepMode !== 'plan') {
          // Manual plan override mid-workflow-step: the CLI reverts to 'default' on
          // approval, so push the step's configured mode back to the worker too.
          this.setPermissionMode(sessionId, stepMode);
        } else {
          meta.permissionMode = 'default';
          this.upsert(meta);
        }
      }
    }

    // An approval carrying comments. The SDK's allow arm has no message field —
    // only deny carries text — so the approval stays a real allow and the notes
    // are delivered separately, into the turn the approval just started. The
    // push is synchronous with the resolve above, before the CLI has
    // round-tripped the model, so they land with the approval rather than after
    // the implementation is underway.
    if (allow && comments.length) {
      const meta = this.sessions.get(sessionId);
      const text = formatPlanComments(comments, 'approve');
      if (meta && this.canInterject(sessionId)) {
        this.emitEvent(sessionId, 'interject', {
          text,
          ...(actor ? { actor } : {}),
        } satisfies InterjectData);
        // No upsert: unlike "Send now" this removes nothing from the queue, so
        // there is no meta change for a broadcast to carry.
        this.pushIntoLiveTurn(meta, text);
      } else if (meta) {
        // The turn has already settled, or the worker link is down —
        // `canInterject` refuses either. Staged as an ordinary queued prompt (the
        // shape userPrompt uses) rather than dropped: the comments arrive as the
        // next turn instead of vanishing. `queuePaused` is left alone, so a
        // guest's held queue stays held.
        (meta.queued ??= []).push({
          id: randomUUID(),
          ts: Date.now(),
          text,
          ...(actor ? { actor } : {}),
        });
        this.upsert(meta);
        this.maybeFlush(sessionId);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Worker event handlers (wired from index.ts via WorkerClient callbacks)
  // ---------------------------------------------------------------------

  /**
   * The turn is demonstrably running in the worker while our status says it
   * isn't — a push queued past the worker's hello snapshot, a blind status
   * clear, a mis-attributed owner, or synced meta adopted from another
   * instance. Converge to 'running'; mutates meta, the caller upserts.
   *
   * Keep the workflow/user re-derivation in step with continueTurn(), which
   * decides a resumed turn's source with the same test.
   */
  private markTurnLive(meta: SessionMeta) {
    const wfStepRunning =
      meta.workflow?.started &&
      meta.workflow.stepStatuses[meta.workflow.stepIndex] === 'running';
    meta.status = 'running';
    meta.errorMessage = undefined;
    meta.turnSource = wfStepRunning ? 'workflow' : 'user';
    meta.turnStartedAt ??= Date.now(); // keep the real start if we still know it
    meta.interruptedAt = undefined; // not dead after all — no Continue banner
  }

  /**
   * On (re)connect: adopt the worker's view of what is live, in both
   * directions. A session the worker doesn't know (or knows as finished) isn't
   * running anywhere — its in-flight status is stale (both processes restarted,
   * or a push was lost mid-death). A session the worker reports busy is running
   * regardless of what our status says.
   *
   * `autoContinue: false` is for the "worker is known down" call (an empty
   * `live` fired from the disconnect deadline, not a real hello): flagging for
   * the Continue banner is still right, but firing `continueTurn()` would just
   * re-queue the push into `WorkerClient.pending` against a socket that isn't
   * there. The next real hello reconciles again with the default true and
   * resumes it.
   */
  reconcileWithWorker(live: LiveSessionInfo[], opts?: { autoContinue?: boolean }) {
    const liveById = new Map(live.map((l) => [l.sessionId, l]));
    const flagged: string[] = [];
    for (const meta of this.sessions.values()) {
      const info = liveById.get(meta.id);
      // A session adopted from another machine's storage sync has never executed
      // here: no live state, no local transcript. Demoting it, restamping it and
      // auto-continuing it would broadcast and cloud-push a turn this machine never
      // owned — and with a flapping worker that is a storm, once per reconcile.
      if (!info && !this.ranHere(meta.id)) continue;
      let changed = false;
      if (info?.claudeSessionId && meta.claudeSessionId !== info.claudeSessionId) {
        meta.claudeSessionId = info.claudeSessionId;
        changed = true;
      }
      if (info?.busy === true && !isSessionActive(meta.status)) {
        this.markTurnLive(meta);
        changed = true;
      }
      // The worker outlives the bridge, so its copy is the authority on which CLI
      // children are still running. `undefined` = a worker too old to say; leave
      // our own set alone, exactly as `busy: undefined` only demotes. Routed
      // through the helper, which upserts on its own when membership changed.
      if (info?.backgroundTasks) {
        this.setBackgroundTasks(
          meta.id,
          info.backgroundTasks.map((t) => ({
            id: t.task_id,
            type: t.task_type,
            description: t.description,
          })),
        );
      }
      // `busy: undefined` = a worker too old to report it; demote-only, as before.
      const noTurn = !info || info.busy === false;
      if (noTurn && (meta.status === 'running' || meta.status === 'waiting-permission')) {
        // A step that reads 'waiting-approval' with the session 'running' can only be
        // a manual compaction over the park (see compactContext) — nothing else runs a
        // turn on a parked step. Re-park rather than demote: `compactResume` is
        // per-process and died with the bridge, so the park is re-derived here. And no
        // Continue banner, because auto-continue's nudge ("continue the task from
        // there") would read as an approval nobody gave.
        const reparked =
          meta.workflow?.stepStatuses[meta.workflow.stepIndex] === 'waiting-approval';
        meta.status = reparked ? 'waiting-approval' : 'idle';
        meta.turnSource = undefined;
        meta.turnStartedAt = undefined;
        meta.pendingPermissionTool = undefined;
        const live = this.liveState(meta.id);
        live.permissionWaitMs = 0;
        live.compactResume = undefined;
        // The turn died with the worker; don't auto-fire followups.
        if (meta.queued?.length) meta.queuePaused = true;
        if (!reparked) {
          // Flag for the Continue banner. A workflow step left 'running' here is
          // kept 'running' (not false-parked at waiting-approval as if it had
          // finished) — Continue resumes it as a workflow turn, and its eventual
          // result parks the step for approve/retry the normal way.
          meta.interruptedAt = Date.now();
          // A plan-approval / question card still open is the user's to answer, and
          // auto-continue's nudge ("continue the task from there") would read as an
          // approval nobody gave. Keep the banner and the clickable card; park the
          // session instead — `flagged` is exactly the auto-continue list below.
          if (hasUnresolvedAlwaysAsk(this.store.loadTranscript(meta.id))) {
            console.log(
              `[permission] [session ${meta.id}] auto-continue skipped: an always-ask card is unanswered`,
            );
          } else {
            flagged.push(meta.id);
          }
        }
        changed = true;
      }
      if (changed) this.upsert(meta);
    }
    // A bridge that died between a turn's result and its flush leaves queued
    // prompts on a settled session; release them now.
    for (const meta of this.sessions.values()) this.maybeFlush(meta.id);
    // Resume what this pass just flagged, without waiting for a click. On unless
    // explicitly disabled, so a fresh install recovers with no configuration.
    // Scoped to `flagged` on purpose — a stale flag from an older crash keeps its
    // banner rather than firing an unattended turn on every boot. Per-session
    // try/catch: a meta that can't build query options must not take the bridge
    // down (nothing up the stack catches) or skip the sessions after it.
    if (
      flagged.length &&
      opts?.autoContinue !== false &&
      this.store.loadSettings()?.autoContinueInterrupted !== false
    ) {
      for (const id of flagged) {
        try {
          this.continueTurn(id);
        } catch (err) {
          console.error(`[session ${id}] auto-continue failed:`, err);
          // prompt() clears the flag and sets 'running' before it pushes, so a
          // throw there leaves the session mid-mutation: live-looking, with no
          // banner and no turn. Put it back the way reconcile left it.
          const failed = this.sessions.get(id);
          if (failed) {
            failed.status = 'idle';
            failed.turnSource = undefined;
            failed.turnStartedAt = undefined;
            failed.interruptedAt = Date.now();
            this.upsert(failed);
          }
        }
      }
    }
  }

  /**
   * Ask the session's live query for its `/context` breakdown — the same data the
   * CLI's `/context` command renders, and the authoritative occupancy reading.
   *
   * Best-effort: resolves null (never rejects) when there is no live query, the
   * worker is down, or the CLI doesn't know the control request; the
   * assistant-usage reading in `contextUsage` covers those cases. A successful
   * fetch also commits a small summary to the meta so the ring survives a
   * restart — skipped when nothing changed, which keeps hover-triggered
   * refreshes off the broadcast and storage-sync path.
   */
  fetchContextBreakdown(sessionId: string): Promise<ContextBreakdown | null> {
    const inFlight = this.contextFetches.get(sessionId);
    if (inFlight) return inFlight;

    const fetch = (async () => {
      try {
        const raw = await this.worker.contextUsage(sessionId);
        const full = normalizeContextBreakdown(raw, Date.now());
        if (!full) return null;
        const meta = this.sessions.get(sessionId);
        if (meta) {
          const summary = summarizeContextBreakdown(full);
          if (!sameContextSummary(meta.contextSummary, summary)) {
            meta.contextSummary = summary;
            this.upsert(meta);
          }
        }
        return full;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Expected states, not failures — don't log on every hover.
        if (message !== 'no-live-session' && message !== 'worker-unavailable') {
          console.warn(`[context ${sessionId.slice(0, 8)}]`, message);
        }
        return null;
      } finally {
        this.contextFetches.delete(sessionId);
      }
    })();

    this.contextFetches.set(sessionId, fetch);
    return fetch;
  }

  handleWorkerEvent(sessionId: string, msg: Record<string, unknown> & { type: string }) {
    // Capture the CLI session id for resume-after-restart.
    const claudeSessionId = msg.session_id as string | undefined;
    const meta = this.sessions.get(sessionId);
    let metaChanged = false;
    if (meta && claudeSessionId && meta.claudeSessionId !== claudeSessionId) {
      meta.claudeSessionId = claudeSessionId;
      metaChanged = true;
    }
    // Any message but the turn's own result proves a turn is live, so a status
    // that says otherwise is stale (see markTurnLive) — heal it. A `result` on
    // an inactive session means the turn is over; let it settle below instead.
    // `interrupting` is read live, not snapshotted: an event racing a Stop must
    // not resurrect the turn the user just killed.
    if (
      meta &&
      !isSessionActive(meta.status) &&
      msg.type !== 'result' &&
      !this.interrupting.has(sessionId)
    ) {
      this.markTurnLive(meta);
      metaChanged = true;
    }
    if (meta && metaChanged) this.upsert(meta);

    // The SDK reports a user interrupt as an ordinary error result, so `interrupting`
    // is the only record that the user asked for the stop. Stamp it here, before the
    // event is written: the store only appends, so a verdict decided in the result
    // branch below could never reach the durable record. A shallow copy, not a
    // mutation — everything downstream keeps reading the raw `msg`.
    const stopped = msg.type === 'result' && this.interrupting.has(sessionId);
    // Stream deltas are broadcast live but not written to disk;
    // the complete assistant message that follows is the durable record.
    // Same for the ephemeral system subtypes: nothing reads them back.
    const persist =
      msg.type !== 'stream_event' &&
      !(
        msg.type === 'system' &&
        EPHEMERAL_SYSTEM_SUBTYPES.has(String((msg as { subtype?: string }).subtype)) &&
        // A `status` carrying a compact verdict is the authoritative compaction outcome.
        (msg as { compact_result?: unknown }).compact_result === undefined
      );
    const resultSeq = this.emitEvent(
      sessionId,
      'sdk',
      stopped ? { ...msg, stopped: true } : msg,
      persist,
    );

    // Each assistant message overwrites the reading; the last one before the
    // result describes the turn's final prompt. Held live rather than upserted
    // per message, which would broadcast a sidebar re-render 10-20x a turn.
    // Subagent messages are skipped: their context is their own, and letting one
    // settle here shows the composer ring a subagent's tiny reading.
    if (
      msg.type === 'assistant' &&
      !subagentParentId(msg) &&
      meta &&
      !this.liveState(sessionId).compactedInTurn
    ) {
      const reading = extractContextUsage(msg, meta.model, Date.now());
      if (reading) this.liveState(sessionId).contextUsage = reading;
    }

    // Background tasks (backgrounded subagents / Bash commands) outlive the turn
    // that started them. The level signal names every live one, so the set is
    // replaced wholesale; `init` means the CLI process (re)started, which emits
    // nothing of its own, so the set resets there.
    if (msg.type === 'system') {
      const subtype = (msg as { subtype?: string }).subtype;
      if (subtype === 'background_tasks_changed') {
        const tasks = ((msg as { tasks?: unknown }).tasks ?? []) as {
          task_id?: unknown;
          task_type?: unknown;
          description?: unknown;
        }[];
        this.setBackgroundTasks(
          sessionId,
          tasks.map((t) => ({
            id: String(t.task_id ?? ''),
            type: String(t.task_type ?? ''),
            description: String(t.description ?? ''),
          })),
        );
      } else if (subtype === 'init') {
        this.setBackgroundTasks(sessionId, []);
      } else if (subtype === 'task_notification') {
        // Removal only — never an add. See setBackgroundTasks' contract.
        const id = String((msg as { task_id?: unknown }).task_id ?? '');
        const live = this.live.get(sessionId)?.backgroundTasks;
        if (id && live?.some((t) => t.id === id)) {
          this.setBackgroundTasks(
            sessionId,
            live.filter((t) => t.id !== id),
          );
        }
      }
    }

    // A compaction — ours or the CLI's own auto-compaction, which fires without
    // being asked (settingSources pulls in autoCompactEnabled). Recorded on the
    // meta so the ring self-corrects immediately instead of showing the
    // pre-compaction number until the next turn reports.
    const boundary = extractCompactBoundary(msg);
    if (boundary && meta) {
      const trigger = boundary.trigger ?? (this.compacting.has(sessionId) ? 'manual' : 'auto');
      meta.contextCompact = {
        at: Date.now(),
        trigger,
        preTokens: boundary.preTokens,
        postTokens: boundary.postTokens,
        ok: true,
      };
      this.upsert(meta);
      this.emitEvent(sessionId, 'context-compact', {
        phase: 'done',
        trigger,
        preTokens: boundary.preTokens,
        postTokens: boundary.postTokens,
        ok: true,
      } satisfies ContextCompactData);
      this.compacting.delete(sessionId);
      // Any reading from this turn describes the conversation that was just
      // summarized away, so none of them may settle onto the meta at the result.
      const state = this.liveState(sessionId);
      state.contextUsage = undefined;
      state.compactedInTurn = true;
    }

    // The SDK's own verdict on the compaction we asked for. Unlike a missing
    // boundary this is conclusive, so it is the only thing allowed to condemn the
    // mechanism. The boundary branch above already left `compacting`, so a turn
    // that produced a real boundary can't be handled twice.
    const status = extractCompactStatus(msg);
    if (status && meta && this.compacting.has(sessionId)) {
      const at = Date.now();
      const ok = status.result === 'success';
      meta.contextCompact = ok
        ? { at, trigger: 'manual', ok: true }
        : { at, trigger: 'manual', ok: false, error: status.error };
      this.upsert(meta);
      this.emitEvent(sessionId, 'context-compact', {
        phase: 'done',
        trigger: 'manual',
        ok,
        ...(status.error ? { error: status.error } : {}),
      } satisfies ContextCompactData);
      this.compacting.delete(sessionId);
      if (ok) {
        // Same reasoning as the boundary branch: this turn's readings describe the
        // conversation that was just summarized away.
        const state = this.liveState(sessionId);
        state.contextUsage = undefined;
        state.compactedInTurn = true;
      }
    }

    if (msg.type === 'result') {
      // No boundary and no status verdict: inconclusive, not unsupported. Close the
      // span so a later turn scan isn't bounded by an orphan marker, but write no
      // record — condemning the mechanism on silence is what wedged the button.
      // Whether this turn was a manual compaction over a parked/failed step. Read
      // before the calls below consume the record — a failed *compaction* must not
      // become the session's failure banner (it reports through its own channels).
      const compactionTurn = this.live.get(sessionId)?.compactResume !== undefined;
      this.abandonCompaction(sessionId, 'no-compact-boundary');
      // A compaction that reached a boundary or a verdict already left `compacting`,
      // so the call above was a no-op for it — restore the covered status here. The
      // status is then no longer 'running', so the settle branch below leaves it be.
      this.restoreCompactedStatus(sessionId);
      // The SDK can surface a rejected token as an error result instead of throwing;
      // Retry already renders for these, only the login prompt is missing.
      // A stopped turn is not a failed turn, though the SDK reports the interrupt in
      // exactly that shape: it needs no banner, no Retry, no classification — and
      // above all no dropFailedQuery, since an interrupt leaves the query healthy.
      const failed =
        !stopped && (msg.is_error === true || (msg.subtype != null && msg.subtype !== 'success'));
      // A failure result carries its reason in `errors[]`, not `result` — reading
      // only `result` degraded every one of them to 'The turn failed.'
      const resultText = resultErrorText(msg as { result?: unknown; errors?: unknown });

      const metaNow = this.sessions.get(sessionId);
      let source: 'user' | 'workflow' = 'user';
      if (metaNow) {
        const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
        if (typeof cost === 'number') {
          metaNow.lastCostUsd = cost;
          metaNow.totalCostUsd = (metaNow.totalCostUsd ?? 0) + cost;
        }
        const usage = (msg as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        }).usage;
        let turnTokens: number | undefined;
        if (usage) {
          turnTokens =
            (usage.input_tokens ?? 0) +
            (usage.output_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0);
          metaNow.lastTokens = turnTokens;
          metaNow.totalTokens = (metaNow.totalTokens ?? 0) + turnTokens;
        }
        // Same accumulate-on-result pass that owns totalCostUsd — keyed by the
        // model the turn ran on. resolveModelId keeps a retired stored id from
        // opening a second row for what is really one model. A result carrying
        // neither number opens no row at all.
        if (typeof cost === 'number' || turnTokens != null) {
          metaNow.costByModel ??= {};
          addSpend(metaNow.costByModel, resolveModelId(metaNow.model), cost ?? 0, turnTokens ?? 0);
        }
        // Occupancy settles here, from the turn's last assistant message —
        // never from the usage above, which is cumulative across API calls.
        const live = this.liveState(sessionId);
        if (live.contextUsage) {
          metaNow.contextUsage = live.contextUsage;
          live.contextUsage = undefined;
        }
        live.compactedInTurn = undefined; // the next turn measures normally again
        const rawDurationMs = (msg as { duration_ms?: number }).duration_ms;
        if (typeof rawDurationMs === 'number') {
          const state = this.liveState(sessionId);
          const durationMs = Math.max(0, rawDurationMs - state.permissionWaitMs);
          state.permissionWaitMs = 0;
          metaNow.lastDurationMs = durationMs;
          metaNow.totalDurationMs = (metaNow.totalDurationMs ?? 0) + durationMs;
        }
        if (metaNow.status === 'running' || metaNow.status === 'waiting-permission') {
          // A failed result is a failed turn: 'error' + a message is what puts the
          // red banner up and keeps Retry meaningful. Mutated directly (rather than
          // via setStatus) so the single upsert below still carries everything.
          metaNow.status = failed ? 'error' : 'done';
          metaNow.errorMessage = failed ? resultText || 'The turn failed.' : undefined;
          // Shares errorMessage's lifetime; classifyFailure re-sets it below if
          // this failure turns out to have a named next action.
          metaNow.errorKind = undefined;
        }
        // A result proves the turn reached its end, so any Continue banner we
        // stamped for it was wrong — a result buffered while the bridge was away
        // can land after the reconcile that flagged its session.
        metaNow.interruptedAt = undefined;
        source = metaNow.turnSource ?? 'user';
        metaNow.turnSource = undefined;
        metaNow.turnStartedAt = undefined;
        this.upsert(metaNow);
      }
      // After the upsert, so the revision guard can tell "still my banner" from
      // "the session moved on". This branch bypasses failTurn by design (the SDK
      // reported the result itself), so it classifies here instead.
      // Skipped for a compaction over a parked/failed step: it would overwrite the
      // status just restored with a banner about the compaction, not about the work.
      if (failed && !compactionTurn) this.classifyFailure(sessionId, resultText);
      const interrupted = this.interrupting.delete(sessionId); // turn settled normally
      this.onTurnComplete?.(sessionId, source, interrupted, failed);
      this.maybeFlush(sessionId);
      void this.summarizeTurn(sessionId, resultSeq);
      // Closes the attribution window this turn opened. Same class again.
      void this.recordFilesChanged(sessionId, resultSeq);
      // Same class as summarizeTurn: fire-and-forget once the turn has settled.
      // Never awaited — the queue flush and workflow advance above must not wait
      // on a CLI control request.
      void this.fetchContextBreakdown(sessionId);
    }
  }

  handleWorkerEnded(sessionId: string, error?: string) {
    // Cards stay open; answers recover via the resume path.
    this.flushPending(sessionId);
    // The query is gone, so every background task it owned went with it.
    this.setBackgroundTasks(sessionId, []);
    // A dead query says nothing about whether compaction is supported — close the
    // span, keep the button enabled.
    this.abandonCompaction(sessionId, error ? 'query-failed' : 'query-ended');
    if (error) {
      console.error(`[session ${sessionId}] query failed:`, error);
      // Don't auto-fire queued prompts into a broken session; a user send resumes.
      const meta = this.sessions.get(sessionId);
      if (meta?.queued?.length) meta.queuePaused = true;
      if (meta) meta.turnStartedAt = undefined;
      this.liveState(sessionId).permissionWaitMs = 0;
      // Cleared before failTurn so its broadcast already carries the settled turn.
      const source = meta?.turnSource;
      if (meta) meta.turnSource = undefined;
      const interrupted = this.interrupting.delete(sessionId);
      // A crashed query emits no SDK `result`, so the transcript would end on a
      // half-finished turn with no failure row and no Retry button. Synthesize one
      // — this is the "query crash" half of what retryTurn already documents
      // itself as covering.
      this.failTurn(sessionId, error);
      // The turn is over, so tell the listener: a workflow step would otherwise
      // dangle at 'running' with no settle ever coming. Listener only — the
      // synthetic result above deliberately bypasses handleWorkerEvent, so the
      // spend/token accumulation that lives in the result branch must not re-run.
      // failTurn's setStatus already ran maybeFlush, so no queue nudge is needed here.
      if (source) this.onTurnComplete?.(sessionId, source, interrupted, true);
      // A dead token surfacing as a query crash is recovered by failTurn above,
      // which is now the single classification point for every synthetic failure.
      return;
    }
    // An interrupted query sometimes dies without emitting a final `result`;
    // settle the turn here so a stopped workflow step doesn't dangle at
    // 'running'. Gated on the interrupt flag — routine `ended` events (e.g.
    // fresh-start step boundaries closing the old query) must not misfire.
    if (this.interrupting.delete(sessionId)) {
      const meta = this.sessions.get(sessionId);
      if (meta?.turnSource) {
        const source = meta.turnSource;
        meta.turnSource = undefined;
        meta.turnStartedAt = undefined;
        this.liveState(sessionId).permissionWaitMs = 0;
        this.upsert(meta);
        this.onTurnComplete?.(sessionId, source, true, false); // gated on the interrupt flag above
        this.maybeFlush(sessionId);
      }
    }
  }

  /** The CLI aborted a pending permission request (e.g. interrupt) — close the card. */
  handleRpcCancel(id: string) {
    for (const [sessionId, state] of this.live) {
      const resolve = state.pendingPermissions.get(id);
      if (!resolve) continue;
      state.pendingPermissions.delete(id);
      this.emitEvent(sessionId, 'permission', {
        requestId: id,
        toolName: '',
        input: {},
        resolution: 'expired',
        resolvedBy: 'cancel',
      } satisfies PermissionRequestData);
      this.logResolution(sessionId, '', 'expired', 'cancel');
      resolve({ allow: false });
    }
  }

  async handleWorkerRpc(rpc: WorkerRpc) {
    try {
      const result =
        rpc.kind === 'preToolUse'
          ? this.handlePreToolUse(rpc.sessionId, rpc.payload, rpc.resend)
          : await this.handleCanUseTool(rpc.sessionId, rpc.id, rpc.payload, rpc.resend);
      this.worker.rpcResult(rpc.id, result);
    } catch (err) {
      console.error('[rpc]', err);
      this.worker.rpcResult(
        rpc.id,
        rpc.kind === 'canUseTool'
          ? { behavior: 'deny', message: `Bridge error: ${err instanceof Error ? err.message : String(err)}` }
          : { continue: true },
      );
    }
  }

  /**
   * Record a tool call the bridge approved on its own. Every auto-allow branch
   * in both permission handlers goes through here so the transcript can never
   * end up with one of them silently unrecorded. A resend is already in the
   * transcript from the first delivery — re-emitting would double the event.
   */
  private recordAutoAllow(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    resend: boolean,
  ) {
    if (resend) return;
    this.emitEvent(sessionId, 'permission', {
      requestId: randomUUID(),
      toolName,
      input,
      resolution: 'allow',
      auto: true,
      resolvedBy: 'auto',
    } satisfies PermissionRequestData);
  }

  /**
   * PreToolUse hook body. The auto-mode guard lives here, NOT only in
   * canUseTool: allow rules from user settings resolve before canUseTool,
   * but hooks run before the whole permission flow — so this is the only
   * place that sees every tool call.
   */
  private handlePreToolUse(sessionId: string, hookInput: Record<string, unknown>, resend: boolean): unknown {
    if (!resend) this.captureFileSnapshot(sessionId, hookInput);

    const meta = this.sessions.get(sessionId);
    const toolName = String(hookInput.tool_name ?? '');
    const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;

    // Lines' own workflow tools are gated by what they do, not by the session's
    // mode: reads never prompt, writes always do. A workflow edit outlives the
    // session that made it and shows up in other users' shared views, so it is
    // not something auto mode should be rubber-stamping.
    if (isLinesMcpTool(toolName)) {
      if (!isReadOnlyLinesTool(toolName)) {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: 'Changes a saved workflow or step.',
          },
        };
      }
      this.recordAutoAllow(sessionId, toolName, toolInput, resend);
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    // The model asked to enter plan mode itself. That tool is invisible to us
    // otherwise, so meta.permissionMode would stay 'default' and any query
    // restart (worker restart, compression toggle) would respawn out of plan mode with
    // edits no longer gated. Mirror it, the inverse of the approval-side mirroring
    // in resolvePermission.
    if (toolName === 'EnterPlanMode' && meta && meta.permissionMode !== 'plan') {
      meta.permissionMode = 'plan';
      this.upsert(meta);
    }

    // Plan approval and clarifying questions are the user's call in every mode. A
    // bare `continue: true` here lets bypassPermissions and a settings.json
    // permissions.allow entry resolve before canUseTool ever runs, so force the
    // prompt rather than merely declining to auto-allow it below.
    if (ALWAYS_ASK_TOOLS.has(toolName)) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'This decision is always the user’s.',
        },
      };
    }

    // Bypass: allow everything the two carve-outs above didn't already claim.
    // The SDK's own bypass fast-path never applies here — worker.ts always
    // registers canUseTool — so without this branch Bypass behaved exactly like
    // Manual. Deliberately above the guard: bypass skips assessToolCall, so it
    // never pays for the roots/allowlist resolution below.
    if (meta?.permissionMode === 'bypassPermissions') {
      this.recordAutoAllow(sessionId, toolName, toolInput, resend);
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    // Resolved once per invocation: every guard call below wants the same list,
    // and rootsFor re-reads the projects file on each call.
    const roots = meta ? this.rootsFor(meta) : [];

    if (meta?.permissionMode === 'auto') {
      if (!ALWAYS_ASK_TOOLS.has(toolName)) {
        const verdict = assessToolCall(toolName, toolInput, roots, this.guard.list());
        if (verdict.dangerous) {
          // Route to a prompt (canUseTool) regardless of allowlists.
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: verdict.reason,
            },
          };
        }
        this.recordAutoAllow(sessionId, toolName, toolInput, resend);
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        };
      }
    } else if (
      meta &&
      (isSafeReadOnly(toolName, toolInput, roots, this.guard.list()) ||
        isSafePlanWrite(toolName, toolInput, roots))
    ) {
      // Outside auto mode every call reaches the user, including plain reads —
      // so an approved plan re-prompts on each Read/Grep. Let observation-only
      // calls and plan-file authoring through silently (still recorded);
      // Bash and edits to project files are untouched.
      this.recordAutoAllow(sessionId, toolName, toolInput, resend);
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }
    return { continue: true };
  }

  /** canUseTool body: guard verdicts, plan-step gating, then the user prompt. */
  private async handleCanUseTool(
    sessionId: string,
    requestId: string,
    payload: Record<string, unknown>,
    resend: boolean,
  ): Promise<PermissionResult> {
    const toolName = String(payload.toolName ?? 'unknown');
    const input = (payload.input ?? {}) as Record<string, unknown>;

    // Re-delivered after a bridge restart: if the user already answered (the
    // resolution is in the transcript), replay that answer instead of asking
    // again — no resume-recovery dance needed for plain bridge restarts.
    if (resend) {
      const resolved = this.findPermissionResolution(sessionId, requestId);
      // A human-only tool replays only a human answer. A synthesized 'allow'
      // (recovery, or the workflow plan-step gate, which records an allow and
      // denies the tool) must not be handed to the SDK as a real approval —
      // re-ask instead. Legacy resolutions carry no resolvedBy and predate every
      // synthesized source, so they count as the user's.
      const humanAnswered =
        !resolved?.resolvedBy || resolved.resolvedBy === 'user' || resolved.resolvedBy === 'plan-reply';
      if (resolved && (humanAnswered || !ALWAYS_ASK_TOOLS.has(toolName))) {
        return resolved.resolution === 'allow'
          ? { behavior: 'allow', updatedInput: resolved.updatedInput ?? input }
          : {
              behavior: 'deny',
              message: resolved.denyMessage || 'User denied this tool call in the UI.',
            };
      }
    }

    // In a workflow plan step the plan-review card is the gate: it surfaces via
    // askPermission below, and approving it advances the workflow (see
    // resolvePermission) rather than implementing in-place, so the step stays
    // read-only (SDK plan mode already blocks edits until ExitPlanMode).

    // Auto mode: our guard classifies the call. Safe -> approve silently
    // (recorded in the transcript); dangerous -> fall through to the prompt
    // with the guard's reason attached.
    let guardReason: string | undefined;
    // Lines' own workflow tools bypass the guard entirely (see handlePreToolUse):
    // reads auto-allow in every mode, writes always reach the card below.
    if (isLinesMcpTool(toolName)) {
      if (isReadOnlyLinesTool(toolName)) {
        this.recordAutoAllow(sessionId, toolName, input, resend);
        return { behavior: 'allow', updatedInput: input };
      }
    } else {
      const meta = this.sessions.get(sessionId);
      // One resolution for both guard branches — rootsFor re-reads the projects file.
      const roots = meta ? this.rootsFor(meta) : [];
      // Bypass allows every tool but the always-ask pair (and the Lines writes
      // handled above). Repeated here rather than left to the hook because the
      // PreToolUse hook fails closed into 'ask', which lands right here.
      if (meta?.permissionMode === 'bypassPermissions' && !ALWAYS_ASK_TOOLS.has(toolName)) {
        this.recordAutoAllow(sessionId, toolName, input, resend);
        return { behavior: 'allow', updatedInput: input };
      }
      if (meta?.permissionMode === 'auto' && !ALWAYS_ASK_TOOLS.has(toolName)) {
        const verdict = assessToolCall(toolName, input, roots, this.guard.list());
        if (!verdict.dangerous) {
          this.recordAutoAllow(sessionId, toolName, input, resend);
          return { behavior: 'allow', updatedInput: input };
        }
        guardReason = verdict.reason;
      } else if (
        meta &&
        (isSafeReadOnly(toolName, input, roots, this.guard.list()) ||
          isSafePlanWrite(toolName, input, roots))
      ) {
        // Other modes: observation-only calls and plan-file writes still
        // auto-approve (see handlePreToolUse) so post-plan reads don't ask again.
        this.recordAutoAllow(sessionId, toolName, input, resend);
        return { behavior: 'allow', updatedInput: input };
      }
    }

    // On a resend whose card is already in the transcript (unanswered), don't
    // emit a duplicate request — just re-register the resolver.
    const skipEmit = resend && this.findPermissionRequest(sessionId, requestId) !== null;
    const answer = await this.askPermission(sessionId, requestId, toolName, input, guardReason, skipEmit);
    const finalInput = answer.updatedInput ?? input;
    return answer.allow
      ? { behavior: 'allow', updatedInput: finalInput }
      : { behavior: 'deny', message: answer.denyMessage || 'User denied this tool call in the UI.' };
  }

  private askPermission(
    sessionId: string,
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
    guardReason?: string,
    skipEmit = false,
  ): Promise<PermissionAnswer> {
    const state = this.liveState(sessionId);
    if (!skipEmit) {
      this.emitEvent(sessionId, 'permission', {
        requestId,
        toolName,
        input,
        guardReason,
      } satisfies PermissionRequestData);
    }
    const pendingMeta = this.sessions.get(sessionId);
    if (pendingMeta) pendingMeta.pendingPermissionTool = toolName;
    this.setStatus(sessionId, 'waiting-permission');
    const waitStart = Date.now();
    return new Promise<PermissionAnswer>((resolve) => {
      state.pendingPermissions.set(requestId, (answer) => {
        state.permissionWaitMs += Date.now() - waitStart;
        const meta = this.sessions.get(sessionId);
        if (meta && meta.status === 'waiting-permission') this.setStatus(sessionId, 'running');
        resolve(answer);
      });
    });
  }

  private captureFileSnapshot(sessionId: string, hookInput: Record<string, unknown>) {
    try {
      const toolName = String(hookInput.tool_name ?? '');
      if (!EDIT_TOOLS.has(toolName)) return;
      const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
      const filePath = String(toolInput.file_path ?? toolInput.notebook_path ?? '');
      if (!filePath) return;
      const before = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
      this.emitEvent(sessionId, 'file-snapshot', {
        toolUseId: String(hookInput.tool_use_id ?? ''),
        toolName,
        filePath,
        before,
      } satisfies FileSnapshotData);
    } catch (err) {
      console.warn('[snapshot]', err);
    }
  }
}

/** Classify an attachment by media type for model presentation. */
function attachmentKind(mediaType: string): AttachmentKind {
  // The API's image blocks accept only png/jpeg/gif/webp. SVG is XML text —
  // send it as text so the model reads the markup instead of erroring the turn.
  if (mediaType === 'image/svg+xml') return 'text';
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType === 'application/pdf') return 'document';
  return 'text';
}
