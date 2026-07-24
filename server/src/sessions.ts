import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attachment,
  AttachmentKind,
  CavemanConfig,
  FileSnapshotData,
  PermissionMode,
  PermissionRequestData,
  PromptAttachment,
  ServerMessage,
  SessionMeta,
  SessionStatus,
  TranscriptEvent,
} from '@claude-ui/shared';
import { isSessionActive } from '@claude-ui/shared';
import type { Store } from './store.ts';
import { cavemanPromptFallback, getCavemanPluginPath } from './caveman.ts';
import { ALWAYS_ASK_TOOLS, allowEntryFor, assessToolCall, type GuardAllowlist } from './autoGuard.ts';
import type { WorkerClient, WorkerRpc } from './workerClient.ts';
import type { LiveSessionInfo } from './workerProtocol.ts';
import type { AuthManager } from './auth.ts';

/** 'auto' is our guard layer on top of the SDK's acceptEdits mode. */
function sdkPermissionMode(mode: PermissionMode): string {
  return mode === 'auto' ? 'acceptEdits' : mode;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface PermissionAnswer {
  allow: boolean;
  updatedInput?: Record<string, unknown>;
  denyMessage?: string;
}

/** SDK PermissionResult shape returned to the worker's canUseTool rpc. */
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

interface LiveState {
  seq: number;
  pendingPermissions: Map<string, (answer: PermissionAnswer) => void>;
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

  private persist() {
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
    this.sessions.set(meta.id, meta);
    this.persist();
    this.broadcast({ type: 'sessionUpsert', session: meta });
  }

  setStatus(id: string, status: SessionStatus, errorMessage?: string) {
    const meta = this.sessions.get(id);
    if (!meta) return;
    meta.status = status;
    meta.errorMessage = errorMessage;
    this.upsert(meta);
    // A settled status may release a queued prompt (e.g. workflow-done -> idle).
    if (!this.isBusy(meta)) this.maybeFlush(id);
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
    this.upsert(meta);
  }

  /** Mark done by the user: adds the completed indicator and archives. */
  completeSession(id: string) {
    const meta = this.sessions.get(id);
    if (!meta) return;
    meta.completed = true;
    meta.archived = true;
    meta.archivedAt = Date.now();
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
      state = { seq: this.nextSeqFromDisk(id), pendingPermissions: new Map() };
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
    const pluginPath = meta.caveman.enabled ? getCavemanPluginPath() : null;
    const appendParts: string[] = [];
    if (meta.caveman.enabled && !pluginPath) {
      appendParts.push(cavemanPromptFallback(meta.caveman.level));
    } else if (meta.caveman.enabled && meta.caveman.level !== 'full') {
      appendParts.push(`Caveman level: ${meta.caveman.level}. Apply /caveman ${meta.caveman.level} intensity.`);
    }

    return {
      cwd: meta.cwd,
      model: meta.model,
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
  userPrompt(sessionId: string, text: string, attachments: PromptAttachment[] = []) {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`unknown session ${sessionId}`);

    if (meta.queued?.length || this.isBusy(meta)) {
      const staged = this.stageAttachments(sessionId, attachments);
      (meta.queued ??= []).push({
        id: randomUUID(),
        ts: Date.now(),
        text,
        attachments: staged.length ? staged : undefined,
      });
      // An explicit user send is the resume gesture after an interrupt/error.
      meta.queuePaused = undefined;
      this.upsert(meta);
      this.maybeFlush(sessionId);
      return;
    }

    this.prompt(sessionId, text, 'user', attachments);
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

    this.prompt(sessionId, item.text, 'user', attachments);
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
    const seen = new Set<string>();
    for (const event of this.store.loadTranscript(sessionId)) {
      if (event.kind !== 'permission') continue;
      const data = event.data as PermissionRequestData;
      if (data.toolName && data.requestId) seen.add(data.requestId);
    }
    for (const requestId of seen) {
      if (this.findPermissionResolution(sessionId, requestId)) continue;
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

    this.emitEvent(sessionId, 'user', stored.length ? { text, source, attachments: stored } : { text, source });

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
   * The final assistant text block of the most recent turn ('' if none). Reused
   * as the `{previous}` hand-off when a fresh step needs the prior step's output
   * (e.g. a plan). Same transcript walk as {@link summarizeTurn}.
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
    let finalText = '';
    for (const ev of events.slice(Math.max(lastUserIdx, 0))) {
      if (ev.kind !== 'sdk') continue;
      const msg = ev.data as { type?: string; message?: { content?: unknown } };
      if (msg.type !== 'assistant') continue;
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') finalText = block.text;
        }
      }
    }
    return finalText;
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
  async consolidateStepOutput(sessionId: string): Promise<string> {
    try {
      const events = this.store.loadTranscript(sessionId);
      // Find this step's entry marker: the last 'workflow' event with
      // event === 'started' (retried/approved markers come after it in-step).
      let startIdx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev.kind !== 'workflow') continue;
        const data = ev.data as { event?: string };
        if (data.event === 'started') {
          startIdx = i;
          break;
        }
      }
      if (startIdx === -1) return this.lastAssistantText(sessionId);

      // Walk the slice: each 'user' event opens a turn (its text is the initial
      // prompt or iteration feedback); capture that turn's final assistant text.
      const turns: { user: string; output: string }[] = [];
      for (const ev of events.slice(startIdx)) {
        if (ev.kind === 'user') {
          const text = (ev.data as { text?: string }).text ?? '';
          turns.push({ user: text, output: '' });
        } else if (ev.kind === 'sdk' && turns.length) {
          const msg = ev.data as { type?: string; message?: { content?: unknown } };
          if (msg.type !== 'assistant') continue;
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content as Record<string, unknown>[]) {
              if (block.type === 'text' && typeof block.text === 'string') {
                turns[turns.length - 1].output = block.text;
              }
            }
          }
        }
      }

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
    meta.model = model;
    this.upsert(meta);
    this.worker.setModel(sessionId, model);
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
   * On (re)connect: adopt the worker's view of what is live. A session the
   * worker doesn't know isn't running anywhere — its in-flight status is
   * stale (both processes restarted, or a push was lost mid-death).
   */
  reconcileWithWorker(live: LiveSessionInfo[]) {
    const liveById = new Map(live.map((l) => [l.sessionId, l]));
    for (const meta of this.sessions.values()) {
      const info = liveById.get(meta.id);
      let changed = false;
      if (info?.claudeSessionId && meta.claudeSessionId !== info.claudeSessionId) {
        meta.claudeSessionId = info.claudeSessionId;
        changed = true;
      }
      if (!info && (meta.status === 'running' || meta.status === 'waiting-permission')) {
        meta.status = 'idle';
        meta.turnSource = undefined;
        meta.turnStartedAt = undefined;
        // The turn died with the worker; don't auto-fire followups.
        if (meta.queued?.length) meta.queuePaused = true;
        // Flag for the Continue banner. A workflow step left 'running' here is
        // kept 'running' (not false-parked at waiting-approval as if it had
        // finished) — Continue resumes it as a workflow turn, and its eventual
        // result parks the step for approve/retry the normal way.
        meta.interruptedAt = Date.now();
        changed = true;
      }
      if (changed) this.upsert(meta);
    }
    // A bridge that died between a turn's result and its flush leaves queued
    // prompts on a settled session; release them now.
    for (const meta of this.sessions.values()) this.maybeFlush(meta.id);
  }

  handleWorkerEvent(sessionId: string, msg: Record<string, unknown> & { type: string }) {
    // Capture the CLI session id for resume-after-restart.
    const claudeSessionId = msg.session_id as string | undefined;
    const meta = this.sessions.get(sessionId);
    if (meta && claudeSessionId && meta.claudeSessionId !== claudeSessionId) {
      meta.claudeSessionId = claudeSessionId;
      this.upsert(meta);
    }

    // Stream deltas are broadcast live but not written to disk;
    // the complete assistant message that follows is the durable record.
    const persist = msg.type !== 'stream_event';
    const resultSeq = this.emitEvent(sessionId, 'sdk', msg, persist);

    if (msg.type === 'result') {
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
        const durationMs = (msg as { duration_ms?: number }).duration_ms;
        if (typeof durationMs === 'number') {
          metaNow.lastDurationMs = durationMs;
          metaNow.totalDurationMs = (metaNow.totalDurationMs ?? 0) + durationMs;
        }
        if (metaNow.status === 'running' || metaNow.status === 'waiting-permission') {
          metaNow.status = 'done';
        }
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
      this.setStatus(sessionId, 'error', error);
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
    if (meta?.permissionMode === 'auto') {
      const toolName = String(hookInput.tool_name ?? '');
      const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
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
          : { behavior: 'deny', message: 'User denied this tool call in the UI.' };
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
    this.setStatus(sessionId, 'waiting-permission');
    return new Promise<PermissionAnswer>((resolve) => {
      state.pendingPermissions.set(requestId, (answer) => {
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
