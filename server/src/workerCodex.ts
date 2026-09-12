/**
 * The worker's Codex half: the `codex app-server` child, and the threads running
 * on it.
 *
 * Lives in the worker for the reason the worker exists — a bridge hot-reload must
 * not kill a live turn — and in its own module for the reason workerMcp.ts has
 * one: it holds no domain knowledge. Thread options, the sandbox mapping and the
 * normalization of notifications into SDK shapes are all bridge-side; this file
 * spawns, routes and aborts.
 *
 * It forwards notifications **verbatim**, wrapped in `CodexNotificationEnvelope`.
 * That is deliberate: normalizing here would put the mapping inside the worker's
 * restart trigger, so changing how a codex tool call renders would kill every
 * live turn on save.
 *
 * A separate session map from the Claude one. worker.ts reaches into that map as
 * `sessions.get(id)?.query.foo(...)`, where the `?.` guards only the lookup — a
 * codex session reaching one of those would throw a synchronous TypeError past
 * the attached `.catch()`, in the one process whose job is to survive.
 */
import { z } from 'zod';
import { CodexAppServer } from './codexAppServer.ts';
import { CODEX_NOTIFICATION } from '@lines/shared';

/**
 * What a `push` carries when `engine: 'codex'`. Validated rather than trusted: a
 * mis-shaped push has to fail here, with a message, instead of deep inside the
 * child process.
 */
const CodexPushOptions = z.object({
  model: z.string().optional(),
  workingDirectory: z.string(),
  additionalDirectories: z.array(z.string()).optional(),
  sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  approvalPolicy: z.enum(['never', 'on-request', 'on-failure', 'untrusted']),
  /** Appended to the thread's instructions — how the global "compress responses"
   *  setting reaches a codex session. */
  developerInstructions: z.string().optional(),
  /** `$CODEX_HOME` for this app user. */
  codexHome: z.string(),
  codexPath: z.string(),
  /** Resume pointer; absent starts a fresh thread. */
  threadId: z.string().optional(),
});

export type CodexPushOptions = z.infer<typeof CodexPushOptions>;

const CodexPushMessage = z.object({
  text: z.string(),
  /** Deliver into the turn already running (`turn/steer`) instead of starting a
   *  new one. The bridge sets it for an interjection. */
  steer: z.boolean().optional(),
  /** Compact the thread instead of prompting it. Codex has a real RPC for this,
   *  unlike the Claude path's `/compact` prompt. */
  compact: z.boolean().optional(),
});

interface CodexSessionState {
  /** Codex thread this Lines session is bound to; set once `thread/started` lands. */
  threadId?: string;
  /** Turn currently in flight, for `turn/interrupt`. */
  turnId?: string;
  busy: boolean;
}

const codexSessions = new Map<string, CodexSessionState>();
/** threadId -> Lines sessionId, so an inbound notification can be routed. */
const threadOwners = new Map<string, string>();

/** One app-server per `$CODEX_HOME`. Threads multiplex over it. */
let server: CodexAppServer | null = null;
let serverHome: string | null = null;

export interface CodexSink {
  event: (sessionId: string, message: Record<string, unknown>) => void;
  ended: (sessionId: string, error?: string) => void;
  /**
   * Ask the bridge to decide one tool call, exactly as a Claude `canUseTool`
   * callback does.
   *
   * Codex approvals ride the RPC channel the worker already has rather than a
   * channel of their own, which is what lets them land in the existing permission
   * card with the existing auto-guard, allowlist and provenance — none of which
   * was ever Claude-specific. Only the transport differed.
   */
  approve: (
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ behavior?: string; message?: string; updatedInput?: Record<string, unknown> }>;
}

let sink: CodexSink | null = null;

export function hasCodexSession(sessionId: string): boolean {
  return codexSessions.has(sessionId);
}

/** Live codex sessions for the `hello` snapshot. */
export function codexLiveInfo(): { sessionId: string; codexThreadId?: string; busy: boolean }[] {
  return [...codexSessions].map(([sessionId, s]) => ({
    sessionId,
    codexThreadId: s.threadId,
    busy: s.busy,
  }));
}

/** Which Lines session a notification belongs to, or null when we do not own it. */
function ownerOf(params: Record<string, unknown>): string | null {
  const threadId = params.threadId ?? (params.thread as { id?: unknown } | undefined)?.id;
  return typeof threadId === 'string' ? (threadOwners.get(threadId) ?? null) : null;
}

/**
 * Bring up the app-server if it is not running. One child serves every codex
 * session, so this is idempotent and cheap after the first call.
 */
function ensureServer(options: CodexPushOptions): CodexAppServer {
  // A different CODEX_HOME means a different app user; drop the old child rather
  // than serve two accounts from one process.
  if (server && (!server.running || serverHome !== options.codexHome)) {
    server.close();
    server = null;
  }
  if (server) return server;
  serverHome = options.codexHome;
  server = new CodexAppServer({
    codexPath: options.codexPath,
    codexHome: options.codexHome,
    onNotification: handleNotification,
    onServerRequest: handleServerRequest,
    onExit: handleServerExit,
  });
  return server;
}

/**
 * Route one notification to its session and forward it verbatim.
 *
 * `thread/started` is the one that establishes ownership: it is answered by the
 * `thread/start` call that is still awaiting, so the mapping is installed there
 * rather than here.
 */
function handleNotification(method: string, params: Record<string, unknown>) {
  const sessionId = ownerOf(params);
  if (!sessionId) return; // a thread we do not own, or one already closed
  const state = codexSessions.get(sessionId);
  if (state) {
    if (method === 'turn/started') {
      const turn = params.turn as { id?: unknown } | undefined;
      if (typeof turn?.id === 'string') state.turnId = turn.id;
    } else if (method === 'turn/completed') {
      state.turnId = undefined;
      state.busy = false;
    }
  }
  sink?.event(sessionId, { type: CODEX_NOTIFICATION, method, params });
  // A settled turn ends the stream for this push, exactly as the exec transport's
  // child exit did — the bridge's settle pass keys off the normalized `result`.
  if (method === 'turn/completed') sink?.ended(sessionId);
}

/**
 * How one approval request is described to the bridge's permission machinery.
 *
 * The tool names are the same ones the normalizer gives completed items, so a
 * card and the transcript row it gates name the same thing — and an allowlist
 * entry the user creates from the card matches the call that produced it.
 */
function approvalRequest(
  method: string,
  params: Record<string, unknown>,
): { toolName: string; input: Record<string, unknown> } | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return {
        toolName: 'Bash',
        input: {
          command: String(params.command ?? ''),
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        },
      };
    case 'item/fileChange/requestApproval':
      return {
        toolName: 'ApplyPatch',
        input: {
          ...(params.reason ? { reason: params.reason } : {}),
          ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
        },
      };
    default:
      return null;
  }
}

/**
 * A request *from* codex: an approval, an elicitation, or a tool call.
 *
 * Approvals are routed into the bridge's existing permission path. Anything else
 * is refused explicitly rather than by silence — an unanswered request parks the
 * turn forever, which is strictly worse than a refusal the model can route
 * around.
 */
function handleServerRequest(id: unknown, method: string, params: Record<string, unknown>) {
  const sessionId = ownerOf(params);
  const request = sessionId ? approvalRequest(method, params) : null;
  if (!sessionId || !request) {
    console.warn(`[worker] codex asked for '${method}', which Lines cannot answer yet — refusing`);
    server?.respondError(id, `Lines does not support '${method}' yet.`);
    return;
  }
  void sink
    ?.approve(sessionId, request.toolName, request.input)
    .then((answer) => {
      // `acceptForSession` is deliberately never sent. Lines keeps its own
      // allowlist — the user's "always allow" is recorded there, and asking codex
      // to remember a second copy would split one decision across two stores that
      // cannot be kept in step (and that the user can only see one of).
      const decision = answer?.behavior === 'allow' ? 'accept' : 'decline';
      server?.respond(id, { decision });
    })
    .catch((err) => {
      console.warn('[worker] codex approval failed:', String(err));
      // Decline, never accept: a bridge that could not answer has not approved.
      server?.respond(id, { decision: 'decline' });
    });
}

/** The child died: every in-flight turn died with it. */
function handleServerExit(reason: string) {
  server = null;
  serverHome = null;
  const owned = [...codexSessions];
  codexSessions.clear();
  threadOwners.clear();
  for (const [sessionId, state] of owned) {
    // Only a session mid-turn has a turn to fail; an idle one simply loses its
    // thread binding and re-resumes on its next push.
    if (state.busy) sink?.ended(sessionId, `codex app-server ${reason}`);
  }
}

/** Abort the session's in-flight turn. */
export function interruptCodex(sessionId: string): void {
  const state = codexSessions.get(sessionId);
  if (!state?.threadId || !state.turnId || !server) return;
  void server
    .request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId })
    .catch((err) => console.warn('[worker] codex interrupt', String(err)));
}

/** Drop the session's binding; the next push resumes the thread. */
export function closeCodex(sessionId: string): void {
  const state = codexSessions.get(sessionId);
  if (!state) return;
  codexSessions.delete(sessionId);
  if (state.threadId) threadOwners.delete(state.threadId);
}

/**
 * Run one turn: bind the session to a thread (starting or resuming one), then
 * start the turn on it. Unlike the `codex exec` transport this replaces, the
 * thread outlives the turn — which is what makes steering and approvals
 * reachable at all.
 */
export function pushCodex(
  sessionId: string,
  rawOptions: unknown,
  rawMessage: unknown,
  turnSink: CodexSink,
): void {
  sink = turnSink;
  let options: CodexPushOptions;
  let message: z.infer<typeof CodexPushMessage>;
  try {
    options = CodexPushOptions.parse(rawOptions);
    message = CodexPushMessage.parse(rawMessage);
  } catch (err) {
    // Never silently: the bridge is holding the session at 'running' waiting for
    // this stream, and `ended` with an error is what settles it as failed.
    turnSink.ended(sessionId, `Malformed codex push: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (message.compact === true) {
    void runCompaction(sessionId, options, turnSink);
    return;
  }
  void runTurn(sessionId, options, message.text, turnSink, message.steer === true);
}

/**
 * Compact the session's thread.
 *
 * `thread/compact/start` runs a *real turn* — measured: it emits `turn/started`,
 * its own items, and finally `turn/completed`. So this must not settle anything
 * itself; the ordinary notification path ends the turn, exactly as it does for a
 * prompt. Settling here instead released the session before the compaction had
 * happened, and the compaction's own events then landed on a session that had
 * already moved on.
 */
async function runCompaction(sessionId: string, options: CodexPushOptions, turnSink: CodexSink) {
  try {
    const app = ensureServer(options);
    const state = codexSessions.get(sessionId) ?? { busy: false };
    codexSessions.set(sessionId, state);
    const threadId = state.threadId ?? options.threadId;
    if (!threadId) {
      turnSink.ended(sessionId, 'This session has no codex conversation to compact yet.');
      return;
    }
    state.threadId = threadId;
    threadOwners.set(threadId, sessionId);
    state.busy = true;
    await app.request('thread/compact/start', { threadId });
    // No `ended` here: `turn/completed` sends it.
  } catch (err) {
    const state = codexSessions.get(sessionId);
    if (state) state.busy = false;
    turnSink.ended(sessionId, err instanceof Error ? err.message : String(err));
  }
}

async function runTurn(
  sessionId: string,
  options: CodexPushOptions,
  input: string,
  turnSink: CodexSink,
  steer: boolean,
) {
  try {
    const app = ensureServer(options);
    const state = codexSessions.get(sessionId) ?? { busy: false };
    codexSessions.set(sessionId, state);

    // An interjection joins the turn that is already running: it must not clear
    // `busy`, must not start a second turn, and has nothing to settle of its own.
    if (steer) {
      if (!state.threadId || !state.turnId) {
        // The turn ended between the click and here. Nothing to steer into, and
        // starting a turn instead would silently turn Send now into an ordinary
        // send — the bridge's own gate already refuses that case, so this is only
        // the race.
        console.warn('[worker] codex steer with no live turn — dropped');
        return;
      }
      await app.request('turn/steer', {
        threadId: state.threadId,
        expectedTurnId: state.turnId,
        input: [{ type: 'text', text: input, text_elements: [] }],
      });
      return;
    }

    state.busy = true;
    if (!state.threadId) {
      const threadId = await bindThread(app, options);
      state.threadId = threadId;
      threadOwners.set(threadId, sessionId);
    }

    await app.request('turn/start', {
      threadId: state.threadId,
      input: [{ type: 'text', text: input, text_elements: [] }],
    });
    // The turn's own events arrive as notifications; `ended` is sent when
    // `turn/completed` lands (see handleNotification).
  } catch (err) {
    // An interjection has no turn of its own to fail — the turn it was joining is
    // still healthy, and settling it here would put a Retry on a live session.
    if (steer) {
      console.warn('[worker] codex steer failed:', String(err));
      return;
    }
    const state = codexSessions.get(sessionId);
    if (state) state.busy = false;
    turnSink.ended(sessionId, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Start or resume this session's thread and return its id.
 *
 * A resume that fails falls back to a fresh thread rather than failing the turn:
 * storage sync carries session meta but not codex's thread store, so a session
 * opened on a second machine legitimately holds a pointer that machine has never
 * seen. The bridge rewrites that into a sentence for the user.
 */
async function bindThread(app: CodexAppServer, options: CodexPushOptions): Promise<string> {
  const common = {
    cwd: options.workingDirectory,
    sandbox: options.sandboxMode,
    approvalPolicy: options.approvalPolicy,
    ...(options.model ? { model: options.model } : {}),
    ...(options.developerInstructions
      ? { developerInstructions: options.developerInstructions }
      : {}),
  };
  if (options.threadId) {
    try {
      const resumed = (await app.request('thread/resume', {
        threadId: options.threadId,
        ...common,
      })) as { thread?: { id?: unknown } };
      if (typeof resumed?.thread?.id === 'string') return resumed.thread.id;
    } catch (err) {
      console.warn('[worker] codex resume failed, starting a fresh thread:', String(err));
    }
  }
  const started = (await app.request('thread/start', common)) as { thread?: { id?: unknown } };
  const id = started?.thread?.id;
  if (typeof id !== 'string') throw new Error('codex thread/start returned no thread id');
  return id;
}
