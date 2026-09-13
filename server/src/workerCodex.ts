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
import { CODEX_PLAN_FALLBACK_EFFORT, type CodexCollaborationMode } from './codexPlanMode.ts';
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
  approvalPolicy: z.enum(['never', 'on-request', 'untrusted']),
  /** Appended to the thread's instructions — how the global "compress responses"
   *  setting reaches a codex session. */
  developerInstructions: z.string().optional(),
  /** Codex's own Plan/Default preset for this turn, built by the bridge. An
   *  experimental-API field, so it is absent from the generated protocol types;
   *  passed through as-is. */
  collaborationMode: z
    .object({
      mode: z.enum(['plan', 'default']),
      settings: z.object({
        model: z.string(),
        reasoning_effort: z.string().nullable(),
        developer_instructions: z.string().nullable(),
      }),
    })
    .optional(),
  /** `$CODEX_HOME` for this app user. */
  codexHome: z.string(),
  codexPath: z.string(),
  /** Resume pointer; absent starts a fresh thread. */
  threadId: z.string().optional(),
  /** The user's enabled MCP connections, already in codex's `config.toml`
   *  shape — the bridge translates, because that is where the secrets live. */
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  /** Bearer tokens keyed by the env var name `mcpServers` points at. The
   *  app-server child is spawned with these; they never reach `config.toml`. */
  mcpEnv: z.record(z.string(), z.string()).optional(),
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
/** Bearer-token env the live child was spawned with; see `ensureServer`. */
let serverEnv: string | null = null;
/** The `mcp_servers` table the live child has already been given, so a push
 *  that changes nothing does not rewrite its config. Cleared with the child. */
let appliedMcpServers: string | null = null;

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
  ) => Promise<{
    behavior?: string;
    message?: string;
    updatedInput?: Record<string, unknown>;
    /** Question text -> chosen label(s), for `AskUserQuestion` only. */
    answers?: Record<string, string>;
  }>;
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
 * Codex's own collaboration-mode presets, cached per app-server child.
 *
 * `collaborationMode/list` answers e.g.
 *   [{name:'Plan', mode:'plan', model:null, reasoning_effort:'medium'},
 *    {name:'Default', mode:'default', model:null, reasoning_effort:null}]
 *
 * Asked for rather than hardcoded so the reasoning effort a plan runs at stays
 * OpenAI's choice. Experimental-API-only, which is why it is absent from the
 * generated protocol types.
 */
let modePresets: Map<string, string | null> | null = null;

/** Drop the cache. The presets belong to one app-server child, so a test that
 *  serves a different `collaborationMode/list` has to start from nothing. */
export function resetModePresets() {
  modePresets = null;
}

async function loadModePresets(app: CodexAppServer): Promise<Map<string, string | null>> {
  if (modePresets) return modePresets;
  const presets = new Map<string, string | null>();
  try {
    const answer = (await app.request('collaborationMode/list', {})) as {
      data?: { mode?: unknown; reasoning_effort?: unknown }[];
    };
    for (const row of answer?.data ?? []) {
      if (typeof row.mode === 'string') {
        presets.set(row.mode, typeof row.reasoning_effort === 'string' ? row.reasoning_effort : null);
      }
    }
  } catch (err) {
    console.warn('[worker] collaborationMode/list failed:', String(err));
  }
  modePresets = presets;
  return presets;
}

/**
 * Fill the mode's reasoning effort from codex's preset.
 *
 * Not cosmetic: `reasoning_effort: null` is taken literally, not as "use the
 * preset". Measured, a plan turn sent with null asked no questions and emitted no
 * plan item — plan mode in name only — while the preset's value produced both.
 *
 * A non-null value is the user's own choice and passes through untouched, which
 * is what lets the bridge carry a chosen effort through this seam without a
 * second channel. Exported for its tests.
 */
export async function applyModePreset(
  app: CodexAppServer,
  mode: CodexCollaborationMode,
): Promise<CodexCollaborationMode> {
  if (mode.settings.reasoning_effort !== null) return mode;
  const presets = await loadModePresets(app);
  const effort = presets.has(mode.mode)
    ? presets.get(mode.mode)!
    : mode.mode === 'plan'
      ? CODEX_PLAN_FALLBACK_EFFORT
      : null;
  return { ...mode, settings: { ...mode.settings, reasoning_effort: effort } };
}

/** Stable identity of a set of MCP bearer tokens — a child's env is fixed at
 *  spawn, so a change to these is the one thing that forces a respawn. */
function envFingerprint(env: Record<string, string> | undefined): string {
  return JSON.stringify(Object.entries(env ?? {}).sort());
}

/**
 * Bring up the app-server if it is not running. One child serves every codex
 * session, so this is idempotent and cheap after the first call.
 */
function ensureServer(options: CodexPushOptions): CodexAppServer {
  // A different CODEX_HOME means a different app user; drop the old child rather
  // than serve two accounts from one process. A changed bearer-token set is the
  // same story for a different reason: the child read those at spawn, so the
  // running one is holding credentials the user has since changed.
  const fingerprint = envFingerprint(options.mcpEnv);
  // One child serves every codex session, so closing it is never free: a turn
  // running for some *other* session dies with it. A changed account is worth
  // that (the old child holds the wrong credentials outright); a changed bearer
  // token is not, so it waits for the first push that finds the child idle.
  const busy = [...codexSessions.values()].some((state) => state.busy);
  const stale =
    server &&
    (!server.running ||
      serverHome !== options.codexHome ||
      (serverEnv !== fingerprint && !busy));
  if (stale) {
    server!.close();
    server = null;
    // The config the dead child was given died with it.
    appliedMcpServers = null;
    modePresets = null;
  }
  if (server) return server;
  serverHome = options.codexHome;
  serverEnv = fingerprint;
  server = new CodexAppServer({
    codexPath: options.codexPath,
    codexHome: options.codexHome,
    ...(options.mcpEnv && Object.keys(options.mcpEnv).length ? { extraEnv: options.mcpEnv } : {}),
    onNotification: handleNotification,
    onServerRequest: handleServerRequest,
    onExit: handleServerExit,
  });
  return server;
}

/**
 * Hand codex the user's MCP servers, through codex's own config writer.
 *
 * Lines never writes `config.toml` itself. `config/batchWrite` keeps codex the
 * single writer of its own file — the same single-writer rule `auth.json`
 * follows, and for the same reason: two processes editing one file is how a
 * half-written config or a clobbered credential happens.
 *
 * The whole `mcp_servers` table is replaced rather than upserted, so a removed
 * or disabled connection actually goes away. That is safe because this
 * `CODEX_HOME` is Lines' own, not the user's `~/.codex` — nothing else has put
 * a server in it.
 *
 * Applied at most once per distinct table per child: it is a file write plus a
 * reload, and every turn push carries the connection list.
 */
async function applyMcpServers(app: CodexAppServer, options: CodexPushOptions): Promise<void> {
  const servers = options.mcpServers ?? {};
  const desired = JSON.stringify(Object.entries(servers).sort());
  if (appliedMcpServers === desired) return;
  try {
    await app.request('config/batchWrite', {
      edits: [{ keyPath: 'mcp_servers', value: servers, mergeStrategy: 'replace' }],
      // Reach the threads already loaded in this child, not just the next one.
      reloadUserConfig: true,
    });
    appliedMcpServers = desired;
  } catch (err) {
    // A turn with no MCP servers is worth far more than no turn at all, so this
    // never fails the push — the tools are simply absent, and the reason is in
    // the log rather than swallowed.
    console.warn('[worker] codex mcp config write failed:', String(err));
  }
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
    // Codex asking the user a question mid-turn — its `request_user_input` tool.
    // Mapped onto `AskUserQuestion` because that is the *same question*, and the
    // card, the multi-select UI, the "Other" free-text option and the recovery
    // path for an unanswered one are all already built around that name.
    case 'item/tool/requestUserInput':
      return { toolName: 'AskUserQuestion', input: askUserQuestionInput(params) };
    default:
      return null;
  }
}

/** One codex question as the card's shape. Codex's `options` may be null, which
 *  means a free-text answer and no choices to render. Exported for its test:
 *  the mapping is the feature, and it is pure. */
export function askUserQuestionInput(params: Record<string, unknown>): Record<string, unknown> {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return {
    questions: questions.map((raw) => {
      const q = raw as {
        header?: unknown;
        question?: unknown;
        options?: unknown;
      };
      const options = Array.isArray(q.options) ? q.options : [];
      return {
        header: String(q.header ?? ''),
        question: String(q.question ?? ''),
        options: options.map((opt) => {
          const o = opt as { label?: unknown; description?: unknown };
          return {
            label: String(o.label ?? ''),
            ...(o.description ? { description: String(o.description) } : {}),
          };
        }),
      };
    }),
  };
}

/**
 * The user's answers in the shape codex expects: keyed by *question id*, each a
 * list of chosen labels.
 *
 * Lines keys its answers by question **text**, because that is what the Claude
 * tool returns and what the transcript records. The ids never leave this module,
 * so the match is made here against the questions codex just sent.
 *
 * An unmatched or unanswered question is simply absent rather than sent empty:
 * codex's own guidance is "If `request_user_input` returns no answers, continue
 * with best judgment", so silence is a defined outcome and a fabricated empty
 * answer is not.
 */
export function userInputResponse(
  params: Record<string, unknown>,
  answers: Record<string, string> | undefined,
): { answers: Record<string, { answers: string[] }> } {
  const out: Record<string, { answers: string[] }> = {};
  const questions = Array.isArray(params.questions) ? params.questions : [];
  for (const raw of questions) {
    const q = raw as { id?: unknown; question?: unknown };
    const id = typeof q.id === 'string' ? q.id : '';
    const answer = answers?.[String(q.question ?? '')];
    if (!id || !answer) continue;
    // The card joins a multi-select with ', '; codex wants them apart again.
    out[id] = { answers: answer.split(', ').map((a) => a.trim()).filter(Boolean) };
  }
  return { answers: out };
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
  // A question is not an approval: codex wants the answers back, not a verdict,
  // so this one request answers in its own shape.
  const asking = method === 'item/tool/requestUserInput';
  void sink
    ?.approve(sessionId, request.toolName, request.input)
    .then((answer) => {
      if (asking) {
        // Dismissing the card answers nothing, which is a defined outcome —
        // codex's own guidance is to continue with best judgment when
        // `request_user_input` returns no answers.
        server?.respond(id, userInputResponse(params, answer?.behavior === 'allow' ? answer.answers : undefined));
        return;
      }
      // `acceptForSession` is deliberately never sent. Lines keeps its own
      // allowlist — the user's "always allow" is recorded there, and asking codex
      // to remember a second copy would split one decision across two stores that
      // cannot be kept in step (and that the user can only see one of).
      const decision = answer?.behavior === 'allow' ? 'accept' : 'decline';
      server?.respond(id, { decision });
    })
    .catch((err) => {
      console.warn('[worker] codex approval failed:', String(err));
      // Answering nothing lets the turn continue; declining a *question* would be
      // answering one it did not ask.
      if (asking) server?.respond(id, { answers: {} });
      // Decline, never accept: a bridge that could not answer has not approved.
      else server?.respond(id, { decision: 'decline' });
    });
}

/** The child died: every in-flight turn died with it. */
function handleServerExit(reason: string) {
  server = null;
  serverHome = null;
  serverEnv = null;
  // The next child starts with codex's config as it found it, so the table has
  // to be written again rather than assumed still applied.
  appliedMcpServers = null;
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

/**
 * Fork this session's thread at `lastTurnId` and re-bind the session to the new
 * one. Answers the new thread id, or null when there is nothing to fork.
 *
 * The old thread is left intact on disk: codex forks rather than truncates, so a
 * rewind is non-destructive on its side even though the Lines transcript is
 * truncated.
 */
/**
 * The app-server's own view of its MCP servers.
 *
 * The codex twin of the Claude path's `mcpStatus`, and it reads a different
 * thing: not a live `Query`, but codex's `mcpServerStatus/list`. Answers for the
 * whole `CODEX_HOME` rather than for one thread, which is why it takes no session
 * — and why it can answer at all for a session that has never run a turn, the
 * case Settings actually asks in.
 *
 * Null when no app-server is up: the bridge turns that into "not read yet"
 * rather than into an empty list, which would render as every server missing.
 */
export async function codexMcpStatus(): Promise<unknown[] | null> {
  if (!server?.running) return null;
  try {
    const answer = (await server.request('mcpServerStatus/list', {
      // The catalog, not the full tool schemas: the bridge only needs names,
      // connection state and auth state.
      detail: 'toolsAndAuthOnly',
    })) as { data?: unknown };
    return Array.isArray(answer?.data) ? answer.data : [];
  } catch (err) {
    console.warn('[worker] codex mcp status failed:', String(err));
    return null;
  }
}

export async function forkCodex(sessionId: string, lastTurnId: string): Promise<string | null> {
  const state = codexSessions.get(sessionId);
  if (!state?.threadId || !server) return null;
  try {
    const forked = (await server.request('thread/fork', {
      threadId: state.threadId,
      lastTurnId,
    })) as { thread?: { id?: unknown } };
    const id = forked?.thread?.id;
    if (typeof id !== 'string' || !id) return null;
    threadOwners.delete(state.threadId);
    state.threadId = id;
    threadOwners.set(id, sessionId);
    return id;
  } catch (err) {
    console.warn('[worker] codex fork failed:', String(err));
    return null;
  }
}

/** Release the app-server when its owning worker shuts down. */
export function shutdownCodex(): void {
  server?.close();
  server = null;
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
    await applyMcpServers(app, options);
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
    await applyMcpServers(app, options);
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
      // Per turn, not per thread: a resumed thread carries whatever mode it last
      // ran in, so leaving this off would strand a session in Plan mode.
      ...(options.collaborationMode
        ? {
            collaborationMode: await applyModePreset(
              app,
              options.collaborationMode as CodexCollaborationMode,
            ),
          }
        : {}),
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
