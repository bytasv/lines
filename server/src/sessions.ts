import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attachment,
  AttachmentKind,
  CavemanConfig,
  ContextUsage,
  FileSnapshotData,
  PermissionMode,
  PermissionRequestData,
  PromptAttachment,
  PromptMention,
  ServerMessage,
  SessionMeta,
  SessionStatus,
  TranscriptEvent,
} from '@lines/shared';
import {
  isPlanFilePath,
  isSessionActive,
  KEEP_PLANNING_MESSAGE,
  resolveModelId,
} from '@lines/shared';
import type { Store } from './store.ts';
import { cavemanPromptFallback, getCavemanPluginPath } from './caveman.ts';
import {
  ALWAYS_ASK_TOOLS,
  allowEntryFor,
  assessToolCall,
  isSafePlanWrite,
  isSafeReadOnly,
  type GuardAllowlist,
} from './autoGuard.ts';
import type { WorkerClient, WorkerRpc } from './workerClient.ts';
import type { LiveSessionInfo } from './workerProtocol.ts';
import { isAuthFailureMessage, type AuthManager } from './auth.ts';

/** 'auto' is our guard layer on top of the SDK's acceptEdits mode. */
function sdkPermissionMode(mode: PermissionMode): string {
  return mode === 'auto' ? 'acceptEdits' : mode;
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

interface TurnScan {
  user: string;
  lastText: string;
  /** ExitPlanMode's inline `plan` argument (older harness shape). */
  planArg?: string;
  /** Content of a plan file written in this turn (current harness shape). */
  planFileText?: string;
  sawExitPlan: boolean;
}

/**
 * Split a transcript slice into turns: each `user` event opens one. A turn's output
 * is the plan it exited plan mode with, when it produced one — plan mode puts the
 * deliverable in the `ExitPlanMode` tool input (or in the plan file it wrote, since
 * the current harness passes no `plan` argument), and the turn's last *text* block is
 * then only trailing chatter. Otherwise the last text block, as before.
 *
 * Pure and transcript-local: nothing here reads the filesystem, so a plan file's
 * content only counts when the `Write` that produced it is in this slice.
 */
export function collectTurns(events: TranscriptEvent[], from: number): { user: string; output: string }[] {
  const turns: TurnScan[] = [];
  for (const ev of events.slice(Math.max(from, 0))) {
    if (ev.kind === 'user') {
      turns.push({ user: (ev.data as { text?: string }).text ?? '', lastText: '', sawExitPlan: false });
      continue;
    }
    if (ev.kind !== 'sdk') continue;
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
        isPlanFilePath(input.file_path) &&
        typeof input.content === 'string' &&
        input.content.trim()
      ) {
        turn.planFileText = input.content;
      }
    }
  }
  // Later blocks overwrite earlier ones, so a revised plan resolves to the final one.
  // The plan file only counts when the turn actually exited plan mode — an ordinary
  // step that happens to write into the plans directory keeps its text output.
  return turns.map((t) => ({
    user: t.user,
    output: t.planArg ?? (t.sawExitPlan ? t.planFileText : undefined) ?? t.lastText,
  }));
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
 * Request ids that have a permission request recorded but no resolution. One
 * pass: a busy session can hold hundreds of permission events, and resolving
 * each one against its own scan of the transcript was quadratic.
 */
export function unresolvedPermissionIds(events: TranscriptEvent[]): string[] {
  const requested = new Set<string>();
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'permission') continue;
    const data = event.data as PermissionRequestData;
    if (!data.requestId) continue;
    if (data.resolution) resolved.add(data.requestId);
    else if (data.toolName) requested.add(data.requestId);
  }
  return [...requested].filter((id) => !resolved.has(id));
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
}

export type TurnCompleteListener = (sessionId: string, source: 'user' | 'workflow') => void;

export class SessionManager {
  private sessions = new Map<string, SessionMeta>();
  private live = new Map<string, LiveState>();
  /** Sessions with a manual interrupt in flight — lets an `ended` without a
   *  `result` still settle the turn (see handleWorkerEnded). */
  private interrupting = new Set<string>();
  private onTurnComplete: TurnCompleteListener | null = null;
  private worker!: WorkerClient;
  /** Pending debounced sessions.json write, if any (see persist/flushPersist). */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private store: Store,
    private guard: GuardAllowlist,
    private broadcast: (msg: ServerMessage) => void,
    private auth?: AuthManager,
  ) {
    for (const meta of this.store.loadSessions()) this.sessions.set(meta.id, meta);
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
      this.store.saveSessions([...this.sessions.values()]);
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Write pending session state out now. Called on shutdown — the debounce
   *  must never be the reason a status transition is lost. */
  flushPersist() {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.store.saveSessions([...this.sessions.values()]);
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
    const cur = this.sessions.get(meta.id);
    if (cur && (meta.updatedAt ?? 0) <= (cur.updatedAt ?? 0)) return;
    if (isSessionActive(meta.status)) meta.status = 'idle';
    // In-flight statuses were just reset, so no pause is owned by this instance.
    meta.pendingPermissionTool = undefined;
    this.sessions.set(meta.id, meta);
    this.persist();
    this.broadcast({ type: 'sessionUpsert', session: meta });
  }

  setStatus(id: string, status: SessionStatus, errorMessage?: string) {
    const meta = this.sessions.get(id);
    if (!meta) return;
    meta.status = status;
    meta.errorMessage = errorMessage;
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
    this.worker.close(id);
    this.flushPending(id); // the session is gone with its cards
    this.sessions.delete(id);
    this.live.delete(id);
    this.store.deleteTranscript(id);
    this.persist();
    this.broadcast({ type: 'sessionDeleted', sessionId: id });
  }

  /**
   * The serializable half of the SDK query options. The worker splices in the
   * non-serializable callbacks (canUseTool, hooks, stderr) on its side.
   */
  private buildQueryOptions(meta: SessionMeta): Record<string, unknown> {
    const accessToken = this.auth?.getAccessTokenSync() ?? null;
    // Optional-chained throughout: a meta written before `caveman` existed, or
    // adopted wholesale from storage by adoptSynced, has no such object.
    const pluginPath = meta.caveman?.enabled ? getCavemanPluginPath() : null;
    const appendParts: string[] = [];
    if (meta.caveman?.enabled && !pluginPath) {
      appendParts.push(cavemanPromptFallback(meta.caveman.level));
    } else if (meta.caveman?.enabled && meta.caveman.level !== 'full') {
      appendParts.push(`Caveman level: ${meta.caveman.level}. Apply /caveman ${meta.caveman.level} intensity.`);
    }

    return {
      cwd: meta.cwd,
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
      // App-managed login: hand the OAuth token to the CLI child. Absent (logged
      // out or mid-refresh), the CLI falls back to its ambient credentials.
      ...(accessToken ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: accessToken } } : {}),
    };
  }

  /**
   * Restart queries that aren't mid-turn so their next prompt rebuilds options
   * with the current token (resume keeps context). Called on login/logout and
   * after token refresh; busy sessions finish their turn on the old token.
   */
  recycleIdleQueries() {
    for (const meta of this.sessions.values()) {
      if (!isSessionActive(meta.status)) this.worker.close(meta.id);
    }
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
      );
      // With attachments the deny only unblocks the query; fall through so the
      // queue branch stages text + attachments and maybeFlush delivers them as
      // a real user turn once the denied turn settles.
      if (!planReply.alsoQueue) return;
    }

    if (meta.queued?.length || this.isBusy(meta)) {
      const staged = this.stageAttachments(sessionId, attachments);
      (meta.queued ??= []).push({
        id: randomUUID(),
        ts: Date.now(),
        text,
        attachments: staged.length ? staged : undefined,
        mentions: mentions.length ? mentions : undefined,
      });
      // An explicit user send is the resume gesture after an interrupt/error.
      meta.queuePaused = undefined;
      this.upsert(meta);
      this.maybeFlush(sessionId);
      return;
    }

    this.prompt(sessionId, text, 'user', attachments, mentions);
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

    this.prompt(sessionId, item.text, 'user', attachments, item.mentions ?? []);
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

    const last = this.store
      .loadTranscript(sessionId)
      .filter((e) => e.kind === 'user')
      .at(-1);
    const data = last?.data as
      | { text?: string; source?: 'user' | 'workflow'; attachments?: Attachment[] }
      | undefined;
    if (!data || (!data.text && !data.attachments?.length)) return;

    const attachments = (data.attachments ?? [])
      .map((a) => {
        const file = a.url.split('/').pop()!;
        const b64 = this.store.loadAttachmentBase64(sessionId, file);
        return b64 ? { name: a.name, mediaType: a.mediaType, data: b64 } : null;
      })
      .filter((a): a is PromptAttachment => a !== null);

    this.prompt(sessionId, data.text ?? '', data.source ?? 'user', attachments);
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

  /** Emit an 'expired' resolution for every unresolved permission request. */
  private expireUnresolvedPermissions(sessionId: string) {
    const events = this.store.loadTranscript(sessionId);
    for (const requestId of unresolvedPermissionIds(events)) {
      this.emitEvent(sessionId, 'permission', {
        requestId,
        toolName: '',
        input: {},
        resolution: 'expired',
      } satisfies PermissionRequestData);
    }
  }

  /** Send a prompt into the session; the worker starts the SDK query if needed. */
  prompt(
    sessionId: string,
    text: string,
    source: 'user' | 'workflow' = 'user',
    attachments: PromptAttachment[] = [],
    mentions: PromptMention[] = [],
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
    });

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
    // A user prompt after Stop (before the interrupted turn settled) means they
    // want to keep working here — don't let the stale flag advance a later turn.
    if (source === 'user' && meta.workflow?.advanceOnComplete === 'interrupted') {
      meta.workflow.advanceOnComplete = undefined;
    }
    this.setStatus(sessionId, 'running'); // upserts, persisting turnSource too

    const content = [...blocks, ...(text ? [{ type: 'text', text }] : [])];
    this.worker.push(
      sessionId,
      { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null },
      this.buildQueryOptions(meta),
    );
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
    this.worker.close(sessionId);
  }

  /**
   * The deliverable of the most recent turn ('' if none) — its plan when it ended
   * in plan mode, else its final assistant text block. Reused as the `{previous}`
   * hand-off when a fresh step needs the prior step's output (e.g. a plan).
   */
  lastAssistantText(sessionId: string): string {
    const events = this.store.loadTranscript(sessionId);
    let lastUserIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    return collectTurns(events, lastUserIdx).at(-1)?.output ?? '';
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
   */
  async consolidateStepOutput(sessionId: string, stepIndex?: number): Promise<string> {
    try {
      const events = this.store.loadTranscript(sessionId);
      // Slice from the marker that opened *this* step, not merely the newest
      // 'started' one: with a step queued while the previous one consolidates,
      // the newest marker can already belong to the next step.
      const startIdx = findStepStart(events, stepIndex);
      if (startIdx === -1) return this.lastAssistantText(sessionId);

      // Each 'user' event in the slice opens a turn (its text is the initial
      // prompt or the iteration feedback); its output is that turn's deliverable.
      const turns = collectTurns(events, startIdx);

      // Single-turn step: its final text is the deliverable — no query, no latency.
      if (turns.length <= 1) return turns[0]?.output ?? this.lastAssistantText(sessionId);

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
        options: {
          model: 'claude-sonnet-5',
          maxTurns: 1,
          allowedTools: [],
          settingSources: [],
          systemPrompt:
            'You consolidate an iterated workflow step into its single final ' +
            'deliverable. You never ask questions, never refuse, and never add ' +
            'commentary or preamble — you output only the deliverable.',
          ...this.ownerTokenEnv(),
        } as never,
      });
      let output: string | null = null;
      for await (const message of q) {
        const msg = message as { type: string; result?: string };
        if (msg.type === 'result' && typeof msg.result === 'string') {
          output = msg.result.trim();
        }
      }
      return output || this.lastAssistantText(sessionId);
    } catch (err) {
      console.warn('[consolidateStepOutput]', err);
      return this.lastAssistantText(sessionId);
    }
  }

  /**
   * Env for the bridge-side helper queries (autoName/summarizeTurn): they run
   * outside the worker, so hand them the owner's OAuth token explicitly — a
   * remote multi-user host has no ambient CLI login to fall back on.
   */
  private ownerTokenEnv(): { env?: Record<string, string | undefined> } {
    const token = this.auth?.getAccessTokenSync() ?? null;
    return token ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } } : {};
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
    try {
      const q = query({
        prompt:
          'Summarize the following task in a 3-6 word title. Output only the ' +
          'title itself: no quotes, no trailing punctuation, no preamble, no ' +
          'commentary. If the text is empty or unclear, do your best with ' +
          'whatever is given.\n\n<task>\n' +
          prompt.slice(0, 2000) +
          '\n</task>',
        options: {
          model: 'claude-haiku-4-5-20251001',
          maxTurns: 1,
          allowedTools: [],
          settingSources: [],
          systemPrompt:
            'You are a title generator. You receive a task description and ' +
            'reply with a single short title. You never ask questions, never ' +
            'refuse, and never add commentary — you only output the title.',
          ...this.ownerTokenEnv(),
        } as never,
      });
      let title: string | null = null;
      for await (const message of q) {
        const msg = message as { type: string; result?: string };
        if (msg.type === 'result' && typeof msg.result === 'string') {
          title = msg.result.trim().replace(/^["']|["']$/g, '').slice(0, 60);
        }
      }
      if (!title) return;
      const meta = this.sessions.get(sessionId);
      if (!meta) return;
      meta.name = title;
      this.upsert(meta);
    } catch (err) {
      console.warn('[autoName]', err);
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
      const events = this.store.loadTranscript(sessionId);
      const lastUserIdx = (() => {
        for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === 'user') return i;
        return -1;
      })();
      const turnEvents = events.slice(Math.max(lastUserIdx, 0));

      const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
      const toolErrors = new Set<string>();
      let finalText = '';
      for (const ev of turnEvents) {
        if (ev.kind !== 'sdk') continue;
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
      if (toolCalls.length === 0) return; // plain text answer — nothing to summarize

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
        options: {
          model: 'claude-haiku-4-5-20251001',
          maxTurns: 1,
          allowedTools: [],
          settingSources: [],
          systemPrompt:
            'You summarize a coding agent\'s completed turn in 1-2 plain sentences. ' +
            'You never ask questions, never refuse, and never add commentary or preamble.',
          ...this.ownerTokenEnv(),
        } as never,
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

  interrupt(sessionId: string) {
    const meta = this.sessions.get(sessionId);
    // Stopping a running workflow step means "done with this step, move on":
    // advance once the interrupted turn settles (result or ended). The step's
    // output hand-off is whatever the model last said — the user cut it short.
    const wf = meta?.workflow;
    if (wf?.started && wf.stepStatuses[wf.stepIndex] === 'running' && meta?.turnSource === 'workflow') {
      wf.advanceOnComplete = 'interrupted';
    }
    this.interrupting.add(sessionId);
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
        } satisfies PermissionRequestData);
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

  /** Look up a recorded resolution for a permission request in the transcript. */
  private findPermissionResolution(sessionId: string, requestId: string): PermissionRequestData | null {
    for (const event of this.store.loadTranscript(sessionId)) {
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
    const meta = this.sessions.get(sessionId);
    const original = meta ? this.findPermissionRequest(sessionId, requestId) : null;
    if (!meta || !original) {
      this.emitEvent(sessionId, 'permission', {
        requestId,
        toolName: '',
        input: {},
        resolution: 'expired',
      } satisfies PermissionRequestData);
      return;
    }

    this.emitEvent(sessionId, 'permission', {
      requestId,
      toolName: '',
      input: {},
      resolution: allow ? 'allow' : 'deny',
      answers,
      denyMessage: allow ? undefined : denyMessage,
    } satisfies PermissionRequestData);

    let text: string;
    if (original.toolName === 'ExitPlanMode' && allow) {
      const wf = meta.workflow;
      const stepRunning = !!wf && wf.stepStatuses[wf.stepIndex] === 'running';
      if (stepRunning && (wf!.stepPermissionMode ?? meta.permissionMode) === 'plan') {
        // Configured plan step: advance the workflow instead of implementing in place.
        wf!.advanceOnComplete = true;
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

  resolvePermission(
    sessionId: string,
    requestId: string,
    allow: boolean,
    updatedInput?: Record<string, unknown>,
    answers?: Record<string, string>,
    denyMessage?: string,
    alwaysAllow?: boolean,
  ) {
    // Persist the exception first so it also covers the recovery path.
    if (allow && alwaysAllow) {
      const original = this.findPermissionRequest(sessionId, requestId);
      if (original) {
        const entry = allowEntryFor(original.toolName, original.input);
        if (this.guard.add(entry)) {
          console.log('[guard] allowlisted:', entry.tool, entry.prefix ?? '');
        }
      }
    }
    const state = this.live.get(sessionId);
    const resolve = state?.pendingPermissions.get(requestId);
    if (!resolve) {
      // The query that asked is gone — resume the session and deliver the
      // decision as a message instead of forcing the user to re-prompt.
      this.recoverOrphanedPermission(sessionId, requestId, allow, answers, denyMessage);
      return;
    }
    state!.pendingPermissions.delete(requestId);
    // updatedInput is recorded so a worker rpc re-send after a bridge restart
    // can be answered from the transcript with the exact approved input.
    this.emitEvent(sessionId, 'permission', {
      requestId,
      toolName: '',
      input: {},
      resolution: allow ? 'allow' : 'deny',
      answers,
      updatedInput,
      denyMessage: allow ? undefined : denyMessage,
    } satisfies PermissionRequestData);

    // Approving a plan inside a workflow plan step advances the workflow instead
    // of implementing in-place: deny ExitPlanMode so the step stays read-only and
    // ends its turn, then flag the workflow to advance when that turn completes.
    const original = this.findPermissionRequest(sessionId, requestId);
    const meta0 = this.sessions.get(sessionId);
    if (
      allow &&
      original?.toolName === 'ExitPlanMode' &&
      meta0?.workflow &&
      meta0.workflow.stepStatuses[meta0.workflow.stepIndex] === 'running' &&
      (meta0.workflow.stepPermissionMode ?? meta0.permissionMode) === 'plan'
    ) {
      meta0.workflow.advanceOnComplete = true;
      this.upsert(meta0);
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
      const original = this.findPermissionRequest(sessionId, requestId);
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
   */
  reconcileWithWorker(live: LiveSessionInfo[]) {
    const liveById = new Map(live.map((l) => [l.sessionId, l]));
    const flagged: string[] = [];
    for (const meta of this.sessions.values()) {
      const info = liveById.get(meta.id);
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
        flagged.push(meta.id);
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
    if (flagged.length && this.store.loadSettings()?.autoContinueInterrupted !== false) {
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
    if (msg.type === 'assistant' && meta) {
      const reading = extractContextUsage(msg, meta.model, Date.now());
      if (reading) this.liveState(sessionId).contextUsage = reading;
    }

    if (msg.type === 'result') {
      // The SDK can surface a rejected token as an error result instead of throwing;
      // Retry already renders for these, only the login prompt is missing.
      const failed = msg.is_error === true || (msg.subtype != null && msg.subtype !== 'success');
      const resultText = typeof msg.result === 'string' ? msg.result : '';
      if (failed && isAuthFailureMessage(resultText)) void this.auth?.handleTokenRejected();

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
        if (usage) {
          const turnTokens =
            (usage.input_tokens ?? 0) +
            (usage.output_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0);
          metaNow.lastTokens = turnTokens;
          metaNow.totalTokens = (metaNow.totalTokens ?? 0) + turnTokens;
        }
        // Occupancy settles here, from the turn's last assistant message —
        // never from the usage above, which is cumulative across API calls.
        const live = this.liveState(sessionId);
        if (live.contextUsage) {
          metaNow.contextUsage = live.contextUsage;
          live.contextUsage = undefined;
        }
        const rawDurationMs = (msg as { duration_ms?: number }).duration_ms;
        if (typeof rawDurationMs === 'number') {
          const state = this.liveState(sessionId);
          const durationMs = Math.max(0, rawDurationMs - state.permissionWaitMs);
          state.permissionWaitMs = 0;
          metaNow.lastDurationMs = durationMs;
          metaNow.totalDurationMs = (metaNow.totalDurationMs ?? 0) + durationMs;
        }
        if (metaNow.status === 'running' || metaNow.status === 'waiting-permission') {
          metaNow.status = 'done';
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
      this.interrupting.delete(sessionId); // turn settled normally
      this.onTurnComplete?.(sessionId, source);
      this.maybeFlush(sessionId);
      void this.summarizeTurn(sessionId, resultSeq);
    }
  }

  handleWorkerEnded(sessionId: string, error?: string) {
    // Cards stay open; answers recover via the resume path.
    this.flushPending(sessionId);
    if (error) {
      console.error(`[session ${sessionId}] query failed:`, error);
      // Don't auto-fire queued prompts into a broken session; a user send resumes.
      const meta = this.sessions.get(sessionId);
      if (meta?.queued?.length) meta.queuePaused = true;
      if (meta) meta.turnStartedAt = undefined;
      this.liveState(sessionId).permissionWaitMs = 0;
      // A crashed query emits no SDK `result`, so the transcript would end on a
      // half-finished turn with no failure row and no Retry button. Synthesize one
      // (before the status flip, so it is the trailing item) — this is the "query
      // crash" half of what retryTurn already documents itself as covering.
      this.emitEvent(sessionId, 'sdk', {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: error,
      });
      this.setStatus(sessionId, 'error', error);
      // A dead token surfaces here as a query crash; recover (or log out, which
      // opens the login modal) now rather than waiting for the usage poller.
      if (isAuthFailureMessage(error)) void this.auth?.handleTokenRejected();
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
        this.onTurnComplete?.(sessionId, source);
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
      } satisfies PermissionRequestData);
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
    if (meta?.permissionMode === 'auto') {
      if (!ALWAYS_ASK_TOOLS.has(toolName)) {
        const verdict = assessToolCall(toolName, toolInput, meta.cwd, this.guard.list());
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
      (isSafeReadOnly(toolName, toolInput, meta.cwd, this.guard.list()) ||
        isSafePlanWrite(toolName, toolInput, meta.cwd))
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
      if (resolved) {
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
    {
      const meta = this.sessions.get(sessionId);
      if (meta?.permissionMode === 'auto' && !ALWAYS_ASK_TOOLS.has(toolName)) {
        const verdict = assessToolCall(toolName, input, meta.cwd, this.guard.list());
        if (!verdict.dangerous) {
          if (!resend) {
            this.emitEvent(sessionId, 'permission', {
              requestId: randomUUID(),
              toolName,
              input,
              resolution: 'allow',
              auto: true,
            } satisfies PermissionRequestData);
          }
          return { behavior: 'allow', updatedInput: input };
        }
        guardReason = verdict.reason;
      } else if (
        meta &&
        (isSafeReadOnly(toolName, input, meta.cwd, this.guard.list()) ||
          isSafePlanWrite(toolName, input, meta.cwd))
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
