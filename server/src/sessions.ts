import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  CavemanConfig,
  FileSnapshotData,
  PermissionMode,
  PermissionRequestData,
  ServerMessage,
  SessionMeta,
  SessionStatus,
  TranscriptEvent,
} from '@claude-ui/shared';
import { store } from './store.ts';
import { cavemanPromptFallback, getCavemanPluginPath } from './caveman.ts';
import {
  ALWAYS_ASK_TOOLS,
  allowEntryFor,
  assessToolCall,
  getGuardAllowlist,
  setGuardAllowlist,
} from './autoGuard.ts';

setGuardAllowlist(store.loadGuardAllowlist([]));

/** 'auto' is our guard layer on top of the SDK's acceptEdits mode. */
function sdkPermissionMode(mode: PermissionMode): string {
  return mode === 'auto' ? 'acceptEdits' : mode;
}

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

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface PermissionAnswer {
  allow: boolean;
  updatedInput?: Record<string, unknown>;
  denyMessage?: string;
}

interface LiveState {
  queue: AsyncQueue<SDKUserMessage> | null;
  query: Query | null;
  seq: number;
  pendingPermissions: Map<string, (answer: PermissionAnswer) => void>;
  /** Who initiated the turn currently in flight — drives workflow advancement. */
  turnSource: 'user' | 'workflow' | null;
}

export type TurnCompleteListener = (sessionId: string, source: 'user' | 'workflow') => void;

export class SessionManager {
  private sessions = new Map<string, SessionMeta>();
  private live = new Map<string, LiveState>();
  private onTurnComplete: TurnCompleteListener | null = null;

  constructor(private broadcast: (msg: ServerMessage) => void) {
    for (const meta of store.loadSessions()) this.sessions.set(meta.id, meta);
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
    store.saveSessions([...this.sessions.values()]);
  }

  private upsert(meta: SessionMeta) {
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
  }

  private liveState(id: string): LiveState {
    let state = this.live.get(id);
    if (!state) {
      state = { queue: null, query: null, seq: this.nextSeqFromDisk(id), pendingPermissions: new Map(), turnSource: null };
      this.live.set(id, state);
    }
    return state;
  }

  private nextSeqFromDisk(id: string): number {
    const events = store.loadTranscript(id);
    return events.length > 0 ? events[events.length - 1].seq + 1 : 0;
  }

  emitEvent(sessionId: string, kind: TranscriptEvent['kind'], data: unknown, persistToDisk = true) {
    const state = this.liveState(sessionId);
    const event: TranscriptEvent = { seq: state.seq++, ts: Date.now(), kind, data };
    if (persistToDisk) store.appendTranscript(sessionId, event);
    this.broadcast({ type: 'event', sessionId, event });
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
    store.addRecentDir(params.cwd);
    this.upsert(meta);
    return meta;
  }

  async deleteSession(id: string) {
    await this.shutdownQuery(id);
    this.sessions.delete(id);
    this.live.delete(id);
    store.deleteTranscript(id);
    this.persist();
    this.broadcast({ type: 'sessionDeleted', sessionId: id });
  }

  /** Send a prompt into the session, starting the SDK query if needed. */
  prompt(sessionId: string, text: string, source: 'user' | 'workflow' = 'user') {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`unknown session ${sessionId}`);
    const state = this.liveState(sessionId);

    this.emitEvent(sessionId, 'user', { text, source });

    // First real user prompt names the session from its topic. Guard flips
    // immediately so a slow title query can't fire twice or clobber a manual rename.
    if (source === 'user' && meta.nameAuto) {
      meta.nameAuto = false;
      void this.autoName(sessionId, text);
    }

    this.ensureQuery(meta, state);
    state.turnSource = source;
    this.setStatus(sessionId, 'running');

    state.queue!.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: meta.claudeSessionId ?? '',
    } as SDKUserMessage);
  }

  /**
   * Generate a short session title from the first prompt via a one-shot Haiku
   * query (no tools, no session context). Fire-and-forget; failure keeps the
   * default name. upsert() broadcasts the rename to the UI.
   */
  private async autoName(sessionId: string, prompt: string) {
    try {
      const q = query({
        prompt:
          'Write a 3-6 word title summarizing this task. Only output the title: ' +
          'no quotes, no trailing punctuation, no preamble.\n\n' +
          prompt.slice(0, 2000),
        options: {
          model: 'claude-haiku-4-5-20251001',
          maxTurns: 1,
          allowedTools: [],
          settingSources: [],
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

  async interrupt(sessionId: string) {
    const state = this.live.get(sessionId);
    try {
      await state?.query?.interrupt();
    } catch (err) {
      console.warn('[interrupt]', err);
    }
    // Deny anything waiting on the user so the query is not stuck; user
    // explicitly stopped, so close the cards too.
    this.flushPending(sessionId, { emitResolution: 'deny' });
    this.setStatus(sessionId, 'idle');
  }

  /**
   * Resolve every pending permission promise as denied so the dying query is
   * not stuck. By default the UI cards are left open: an unresolved request
   * can still be answered later via the resume-recovery path in
   * resolvePermission(), so the user never has to re-prompt.
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
    for (const event of store.loadTranscript(sessionId)) {
      if (event.kind !== 'permission') continue;
      const data = event.data as PermissionRequestData;
      if (data.requestId === requestId && data.toolName) return data;
    }
    return null;
  }

  /**
   * The query that asked this permission is gone (server restart, caveman
   * toggle, crash) — the CLI turn died with it. Recover by resuming the
   * session and telling Claude what the user decided, so no re-prompt is
   * needed even hours later.
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
      // Resume outside plan mode so the approved plan gets implemented.
      if (meta.permissionMode === 'plan') {
        meta.permissionMode = 'default';
        this.upsert(meta);
      }
      text =
        'I approved your plan (the session was interrupted before the approval reached you). ' +
        'Proceed with the implementation now.';
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

  async setModel(sessionId: string, model: string) {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.model = model;
    this.upsert(meta);
    const state = this.live.get(sessionId);
    if (state?.query) {
      try {
        await state.query.setModel(model);
      } catch (err) {
        console.warn('[setModel]', err);
      }
    }
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode) {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.permissionMode = mode;
    this.upsert(meta);
    const state = this.live.get(sessionId);
    if (state?.query) {
      try {
        await (state.query as { setPermissionMode: (m: string) => Promise<void> }).setPermissionMode(
          sdkPermissionMode(mode),
        );
      } catch (err) {
        console.warn('[setPermissionMode]', err);
      }
    }
  }

  /** Caveman toggling requires new query options; restart the query (resume keeps context). */
  async setCaveman(sessionId: string, caveman: CavemanConfig) {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.caveman = caveman;
    this.upsert(meta);
    await this.shutdownQuery(sessionId);
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
        const list = getGuardAllowlist();
        const exists = list.some((e) => e.tool === entry.tool && e.prefix === entry.prefix);
        if (!exists) {
          const next = [...list, entry];
          setGuardAllowlist(next);
          store.saveGuardAllowlist(next);
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
    this.emitEvent(sessionId, 'permission', {
      requestId,
      toolName: '',
      input: {},
      resolution: allow ? 'allow' : 'deny',
      answers,
    } satisfies PermissionRequestData);
    resolve({ allow, updatedInput, denyMessage });

    // Approving a plan exits plan mode inside the CLI — mirror that in our
    // session meta so the composer's mode control stays truthful.
    if (allow) {
      const original = this.findPermissionRequest(sessionId, requestId);
      const meta = this.sessions.get(sessionId);
      if (meta && original?.toolName === 'ExitPlanMode' && meta.permissionMode === 'plan') {
        meta.permissionMode = 'default';
        this.upsert(meta);
      }
    }
  }

  private async shutdownQuery(sessionId: string) {
    const state = this.live.get(sessionId);
    if (!state?.queue) return;
    this.flushPending(sessionId); // cards stay open; answers recover via resume
    state.queue.close();
    state.queue = null;
    state.query = null;
  }

  private ensureQuery(meta: SessionMeta, state: LiveState) {
    if (state.query) return;

    const queue = new AsyncQueue<SDKUserMessage>();
    state.queue = queue;

    const pluginPath = meta.caveman.enabled ? getCavemanPluginPath() : null;
    const appendParts: string[] = [];
    if (meta.caveman.enabled && !pluginPath) {
      appendParts.push(cavemanPromptFallback(meta.caveman.level));
    } else if (meta.caveman.enabled && meta.caveman.level !== 'full') {
      appendParts.push(`Caveman level: ${meta.caveman.level}. Apply /caveman ${meta.caveman.level} intensity.`);
    }

    const options: Record<string, unknown> = {
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
      stderr: (data: string) => {
        if (data.trim()) console.error(`[claude:${meta.id.slice(0, 8)}]`, data.trim());
      },
      canUseTool: this.makeCanUseTool(meta.id),
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input: Record<string, unknown>) => {
                this.captureFileSnapshot(meta.id, input);
                // Auto-mode guard lives here, NOT only in canUseTool: allow
                // rules from user settings resolve before canUseTool, but
                // hooks run before the whole permission flow — so this is the
                // only place that sees every tool call.
                const metaNow = this.sessions.get(meta.id);
                if (metaNow?.permissionMode === 'auto') {
                  const toolName = String(input.tool_name ?? '');
                  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
                  if (!ALWAYS_ASK_TOOLS.has(toolName)) {
                    const verdict = assessToolCall(toolName, toolInput, metaNow.cwd);
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
                    this.emitEvent(meta.id, 'permission', {
                      requestId: randomUUID(),
                      toolName,
                      input: toolInput,
                      resolution: 'allow',
                      auto: true,
                    } satisfies PermissionRequestData);
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
              },
            ],
          },
        ],
      },
    };

    const q = query({ prompt: queue as AsyncIterable<SDKUserMessage>, options: options as never });
    state.query = q;
    void this.pump(meta.id, q, state);
  }

  /** canUseTool adapter tolerating both known SDK callback signatures. */
  private makeCanUseTool(sessionId: string) {
    return async (...args: unknown[]): Promise<unknown> => {
      let toolName = 'unknown';
      let input: Record<string, unknown> = {};
      let legacySignature = false;
      const first = args[0];
      if (typeof first === 'string') {
        // (toolName, input, {signal}) => {behavior: 'allow'|'deny'}
        legacySignature = true;
        toolName = first;
        input = (args[1] as Record<string, unknown>) ?? {};
      } else if (first && typeof first === 'object') {
        // ({tool_name, tool_use_id, input}, {signal}) => {permitted: boolean}
        const req = first as { tool_name?: string; input?: Record<string, unknown> };
        toolName = req.tool_name ?? 'unknown';
        input = req.input ?? {};
      }

      // Planning-only workflow steps: capture the plan but never implement in
      // this step. Auto-deny ExitPlanMode so the CLI stays read-only; the
      // workflow's own approval gate decides what happens next.
      if (toolName === 'ExitPlanMode') {
        const meta = this.sessions.get(sessionId);
        const wf = meta?.workflow;
        const inPlanStep =
          wf && wf.stepStatuses[wf.stepIndex] === 'running' && meta.permissionMode === 'plan';
        if (inPlanStep) {
          const message =
            'This is a planning-only workflow step — do not implement anything now. ' +
            'Write out the final plan as your response and end your turn. ' +
            'The user will review it, and implementation happens in a later workflow step.';
          return legacySignature
            ? { behavior: 'deny', message }
            : { permitted: false, reason: message };
        }
      }

      // Auto mode: our guard classifies the call. Safe -> approve silently
      // (recorded in the transcript); dangerous -> fall through to the prompt
      // with the guard's reason attached.
      let guardReason: string | undefined;
      {
        const meta = this.sessions.get(sessionId);
        if (meta?.permissionMode === 'auto' && !ALWAYS_ASK_TOOLS.has(toolName)) {
          const verdict = assessToolCall(toolName, input, meta.cwd);
          if (!verdict.dangerous) {
            this.emitEvent(sessionId, 'permission', {
              requestId: randomUUID(),
              toolName,
              input,
              resolution: 'allow',
              auto: true,
            } satisfies PermissionRequestData);
            return legacySignature ? { behavior: 'allow', updatedInput: input } : { permitted: true };
          }
          guardReason = verdict.reason;
        }
      }

      const answer = await this.askPermission(sessionId, toolName, input, guardReason);
      const finalInput = answer.updatedInput ?? input;
      const denyMessage = answer.denyMessage || 'User denied this tool call in the UI.';
      if (legacySignature) {
        return answer.allow
          ? { behavior: 'allow', updatedInput: finalInput }
          : { behavior: 'deny', message: denyMessage };
      }
      return answer.allow ? { permitted: true } : { permitted: false, reason: denyMessage };
    };
  }

  private askPermission(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    guardReason?: string,
  ): Promise<PermissionAnswer> {
    const state = this.liveState(sessionId);
    const requestId = randomUUID();
    this.emitEvent(sessionId, 'permission', {
      requestId,
      toolName,
      input,
      guardReason,
    } satisfies PermissionRequestData);
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

  private async pump(sessionId: string, q: Query, state: LiveState) {
    try {
      for await (const message of q) {
        const msg = message as Record<string, unknown> & { type: string };

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
        this.emitEvent(sessionId, 'sdk', msg, persist);

        if (msg.type === 'result') {
          const metaNow = this.sessions.get(sessionId);
          if (metaNow) {
            const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
            if (typeof cost === 'number') {
              metaNow.lastCostUsd = cost;
              metaNow.totalCostUsd = (metaNow.totalCostUsd ?? 0) + cost;
            }
            if (metaNow.status === 'running' || metaNow.status === 'waiting-permission') {
              metaNow.status = 'idle';
            }
            this.upsert(metaNow);
          }
          const source = state.turnSource ?? 'user';
          state.turnSource = null;
          this.onTurnComplete?.(sessionId, source);
        }
      }
    } catch (err) {
      console.error(`[session ${sessionId}] query failed:`, err);
      this.setStatus(sessionId, 'error', err instanceof Error ? err.message : String(err));
    } finally {
      if (state.query === q) {
        this.flushPending(sessionId); // cards stay open; answers recover via resume
        state.query = null;
        state.queue = null;
      }
    }
  }
}
