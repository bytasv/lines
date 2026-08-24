import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Actor,
  Attachment,
  AttachmentKind,
  CavemanConfig,
  ContextBreakdown,
  ContextCompactBlockInfo,
  ContextCompactData,
  ContextUsage,
  FileSnapshotData,
  PermissionMode,
  PermissionRequestData,
  PermissionResolutionSource,
  PromptAttachment,
  PromptMention,
  ServerMessage,
  SessionErrorKind,
  SessionMeta,
  SessionStatus,
  TranscriptEvent,
} from '@lines/shared';
import {
  addSpend,
  contextCompactBlock,
  isPlanFilePath,
  isSessionActive,
  isSessionInterruptible,
  KEEP_PLANNING_MESSAGE,
  resolveModelId,
  resultErrorText,
  rootsForCwd,
  subagentParentId,
} from '@lines/shared';
import type { Store } from './store.ts';
import { cavemanPromptFallback, getCavemanPluginPath } from './caveman.ts';
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
function authRecoveryMessage(rejection: TokenRejection): string {
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
}

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
  /** Access token each live worker query was spawned with (see pushTurn). */
  private queryTokens = new Map<string, string | null>();
  private onTurnComplete: TurnCompleteListener | null = null;
  private worker!: WorkerClient;
  /** In-flight `/context` fetches, so a hover during the post-turn refresh reuses
   *  it instead of issuing a second control request. */
  private contextFetches = new Map<string, Promise<ContextBreakdown | null>>();
  /** Pending debounced sessions.json write, if any (see persist/flushPersist). */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long consolidateStepOutput waits on its query before falling back to the
   *  last assistant text. A field so tests can shrink it. */
  consolidateTimeoutMs = 60_000;
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
    caveman: CavemanConfig;
  }): SessionMeta {
    const meta: SessionMeta = {
      id: randomUUID(),
      name: params.name,
      cwd: params.cwd,
      model: params.model,
      permissionMode: params.permissionMode,
      caveman: params.caveman,
      status: 'idle',
      createdAt: Date.now(),
      nameAuto: true,
    };
    this.store.addRecentDir(params.cwd);
    this.upsert(meta);
    return meta;
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
   * The serializable half of the SDK query options. The worker splices in the
   * non-serializable callbacks (canUseTool, hooks, stderr) on its side.
   */
  private buildQueryOptions(meta: SessionMeta, accessToken: string | null): Record<string, unknown> {
    // Optional-chained throughout: a meta written before `caveman` existed, or
    // adopted wholesale from storage by adoptSynced, has no such object.
    const pluginPath = meta.caveman?.enabled ? getCavemanPluginPath() : null;
    const appendParts: string[] = [];
    if (meta.caveman?.enabled && !pluginPath) {
      appendParts.push(cavemanPromptFallback(meta.caveman.level));
    } else if (meta.caveman?.enabled && meta.caveman.level !== 'full') {
      appendParts.push(`Caveman level: ${meta.caveman.level}. Apply /caveman ${meta.caveman.level} intensity.`);
    }

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
      includePartialMessages: true,
      resume: meta.claudeSessionId,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(appendParts.length > 0 ? { append: appendParts.join('\n\n') } : {}),
      },
      settingSources: ['user', 'project'],
      ...(pluginPath ? { plugins: [{ type: 'local', path: pluginPath }] } : {}),
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
   */
  recycleIdleQueries() {
    for (const meta of this.sessions.values()) {
      if (!isSessionInterruptible(meta.status)) this.closeQuery(meta.id);
    }
  }

  /** Close a session's worker query and forget the token it was spawned with. */
  private closeQuery(sessionId: string) {
    this.worker.close(sessionId);
    this.queryTokens.delete(sessionId);
  }

  /**
   * Send a message to the session's worker query, dropping that query first if
   * it was spawned with a different access token.
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
   */
  private async pushTurn(meta: SessionMeta, message: Record<string, unknown>) {
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
  private pushTurnSafely(meta: SessionMeta, message: Record<string, unknown>) {
    void this.pushTurn(meta, message).catch((err) => {
      console.error(`[session ${meta.id}] push failed:`, err);
      // The turn never reached the worker, so no `result` and no `ended` is coming:
      // without a synthetic failure the session sits at 'running' forever.
      this.failTurn(meta.id, `Failed to start the turn: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Recycle the query if it was spawned with a different token, then push. */
  private pushWithToken(meta: SessionMeta, message: Record<string, unknown>, accessToken: string | null) {
    const spawnedWith = this.queryTokens.get(meta.id);
    if (spawnedWith !== undefined && spawnedWith !== accessToken) this.closeQuery(meta.id);
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
   * A turn failed on what looks like a rejected token: attempt exactly one
   * recovery, then rewrite the banner to name the action the user must take. The
   * raw CLI text stays in the transcript as the durable record; only the banner
   * changes. Nothing is auto-resumed — Retry stays the user's call.
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
    opts: { needsApproval?: boolean; actor?: Actor } = {},
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

    const attachments = (data.attachments ?? [])
      .map((a) => {
        const file = a.url.split('/').pop()!;
        const b64 = this.store.loadAttachmentBase64(sessionId, file);
        return b64 ? { name: a.name, mediaType: a.mediaType, data: b64 } : null;
      })
      .filter((a): a is PromptAttachment => a !== null);

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
   */
  private abandonCompaction(sessionId: string, error: string) {
    if (!this.compacting.delete(sessionId)) return;
    this.liveState(sessionId).compactedInTurn = undefined;
    this.emitEvent(sessionId, 'context-compact', {
      phase: 'done',
      trigger: 'manual',
      ok: false,
      error,
    } satisfies ContextCompactData);
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
    this.abandonCompaction(sessionId, 'interrupted');
    this.worker.interrupt(sessionId);
    // Deny anything waiting on the user so the query is not stuck; user
    // explicitly stopped, so close the cards too.
    this.flushPending(sessionId, { emitResolution: 'deny' });
    // Keep the queue but suspend auto-flush; the next user send resumes it.
    if (meta?.queued?.length) meta.queuePaused = true;
    if (meta) meta.turnStartedAt = undefined;
    this.setStatus(sessionId, 'idle');
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
   * The query that asked this permission is gone (worker crash, caveman
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

  /** Caveman toggling requires new query options; restart the query (resume keeps context). */
  setCaveman(sessionId: string, caveman: CavemanConfig) {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.caveman = caveman;
    this.upsert(meta);
    this.flushPending(sessionId); // cards stay open; answers recover via resume
    this.worker.close(sessionId);
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
          'The workflow will proceed to the next step.',
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
      // `busy: undefined` = a worker too old to report it; demote-only, as before.
      const noTurn = !info || info.busy === false;
      if (noTurn && (meta.status === 'running' || meta.status === 'waiting-permission')) {
        meta.status = 'idle';
        meta.turnSource = undefined;
        meta.turnStartedAt = undefined;
        meta.pendingPermissionTool = undefined;
        this.liveState(meta.id).permissionWaitMs = 0;
        // The turn died with the worker; don't auto-fire followups.
        if (meta.queued?.length) meta.queuePaused = true;
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

    // Stream deltas are broadcast live but not written to disk;
    // the complete assistant message that follows is the durable record.
    const persist = msg.type !== 'stream_event';
    const resultSeq = this.emitEvent(sessionId, 'sdk', msg, persist);

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
      this.abandonCompaction(sessionId, 'no-compact-boundary');
      // The SDK can surface a rejected token as an error result instead of throwing;
      // Retry already renders for these, only the login prompt is missing.
      const failed = msg.is_error === true || (msg.subtype != null && msg.subtype !== 'success');
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
      if (failed) this.classifyFailure(sessionId, resultText);
      const interrupted = this.interrupting.delete(sessionId); // turn settled normally
      this.onTurnComplete?.(sessionId, source, interrupted, failed);
      this.maybeFlush(sessionId);
      void this.summarizeTurn(sessionId, resultSeq);
      // Same class as summarizeTurn: fire-and-forget once the turn has settled.
      // Never awaited — the queue flush and workflow advance above must not wait
      // on a CLI control request.
      void this.fetchContextBreakdown(sessionId);
    }
  }

  handleWorkerEnded(sessionId: string, error?: string) {
    // Cards stay open; answers recover via the resume path.
    this.flushPending(sessionId);
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
      if (!resend) {
        this.emitEvent(sessionId, 'permission', {
          requestId: randomUUID(),
          toolName,
          input: toolInput,
          resolution: 'allow',
          auto: true,
          resolvedBy: 'auto',
        } satisfies PermissionRequestData);
      }
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    // The model asked to enter plan mode itself. That tool is invisible to us
    // otherwise, so meta.permissionMode would stay 'default' and any query
    // restart (worker restart, caveman toggle) would respawn out of plan mode with
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
        if (!resend) {
          this.emitEvent(sessionId, 'permission', {
            requestId: randomUUID(),
            toolName,
            input: toolInput,
            resolution: 'allow',
            auto: true,
            resolvedBy: 'auto',
          } satisfies PermissionRequestData);
        }
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
      if (!resend) {
        this.emitEvent(sessionId, 'permission', {
          requestId: randomUUID(),
          toolName,
          input: toolInput,
          resolution: 'allow',
          auto: true,
          resolvedBy: 'auto',
        } satisfies PermissionRequestData);
      }
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
        if (!resend) {
          this.emitEvent(sessionId, 'permission', {
            requestId: randomUUID(),
            toolName,
            input,
            resolution: 'allow',
            auto: true,
            resolvedBy: 'auto',
          } satisfies PermissionRequestData);
        }
        return { behavior: 'allow', updatedInput: input };
      }
    } else {
      const meta = this.sessions.get(sessionId);
      // One resolution for both guard branches — rootsFor re-reads the projects file.
      const roots = meta ? this.rootsFor(meta) : [];
      if (meta?.permissionMode === 'auto' && !ALWAYS_ASK_TOOLS.has(toolName)) {
        const verdict = assessToolCall(toolName, input, roots, this.guard.list());
        if (!verdict.dangerous) {
          if (!resend) {
            this.emitEvent(sessionId, 'permission', {
              requestId: randomUUID(),
              toolName,
              input,
              resolution: 'allow',
              auto: true,
              resolvedBy: 'auto',
            } satisfies PermissionRequestData);
          }
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
        if (!resend) {
          this.emitEvent(sessionId, 'permission', {
            requestId: randomUUID(),
            toolName,
            input,
            resolution: 'allow',
            auto: true,
            resolvedBy: 'auto',
          } satisfies PermissionRequestData);
        }
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
