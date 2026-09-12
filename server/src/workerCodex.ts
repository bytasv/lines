/**
 * The worker's Codex half: every `codex exec` child, and nothing else.
 *
 * Lives in the worker for the reason the worker exists — a bridge hot-reload
 * must not kill a live turn — and in its own module for the reason workerMcp.ts
 * has one: it holds no domain knowledge. Thread options, the sandbox mapping and
 * the normalization of codex events into SDK shapes are all bridge-side; this
 * file spawns, streams and aborts.
 *
 * A separate session map from the Claude one, deliberately. worker.ts reaches
 * into that map as `sessions.get(id)?.query.foo(...)`, where the `?.` guards only
 * the lookup — a codex entry there would throw a synchronous TypeError past the
 * attached `.catch()`, inside the one process whose job is to survive.
 */
import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk';
import { z } from 'zod';

/**
 * What a `push` carries when `engine: 'codex'`. Validated rather than trusted:
 * a mis-shaped push has to fail here, with a message, instead of deep inside the
 * child process.
 */
const CodexPushOptions = z.object({
  model: z.string().optional(),
  workingDirectory: z.string(),
  additionalDirectories: z.array(z.string()).optional(),
  skipGitRepoCheck: z.boolean().optional(),
  sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  approvalPolicy: z.enum(['never', 'on-request', 'on-failure', 'untrusted']),
  networkAccessEnabled: z.boolean().optional(),
  /** `$CODEX_HOME` for this app user — where codex reads auth.json and keeps threads. */
  codexHome: z.string(),
  /** Discovered `codex` binary. Absent lets the SDK resolve its own, which the
   *  bridge's refusal check makes unreachable in the real app. */
  codexPath: z.string().optional(),
  /** Resume pointer (`codex exec resume <id>`); absent starts a fresh thread. */
  threadId: z.string().optional(),
});

export type CodexPushOptions = z.infer<typeof CodexPushOptions>;

/** The prompt shape a codex push carries. No content blocks: `codex exec` takes
 *  text (plus image *paths*, which Lines stages as base64 and so cannot pass). */
const CodexPushMessage = z.object({ text: z.string() });

interface CodexSessionState {
  codex: Codex;
  thread: Thread;
  abort: AbortController;
  /** A turn is in flight. Reported in `hello` exactly as the Claude side's is. */
  busy: boolean;
  /** Last id seen on `thread.started`, so a bridge restart can repair its pointer. */
  threadId?: string;
}

const codexSessions = new Map<string, CodexSessionState>();

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

/**
 * Abort the session's in-flight turn. A `codex exec` child produces no `result`
 * of its own when it is killed, so the bridge synthesizes the settling result
 * from the `ended` this eventually causes.
 */
export function interruptCodex(sessionId: string): void {
  codexSessions.get(sessionId)?.abort.abort();
}

/** Drop the session's state; the next push rebuilds it (resume keeps the thread). */
export function closeCodex(sessionId: string): void {
  const state = codexSessions.get(sessionId);
  if (!state) return;
  codexSessions.delete(sessionId);
  state.abort.abort();
}

export interface CodexSink {
  event: (sessionId: string, message: Record<string, unknown>) => void;
  ended: (sessionId: string, error?: string) => void;
}

/**
 * Run one turn. Each turn is its own `codex exec` child — continuity is
 * `codex exec resume <threadId>`, the same delegation `resume: claudeSessionId`
 * already relies on — so a session's state here is rebuilt per push, and the
 * `threadId` carried on the push is what makes the second turn a continuation.
 */
export function pushCodex(
  sessionId: string,
  rawOptions: unknown,
  rawMessage: unknown,
  sink: CodexSink,
): void {
  let options: CodexPushOptions;
  let input: string;
  try {
    options = CodexPushOptions.parse(rawOptions);
    input = CodexPushMessage.parse(rawMessage).text;
  } catch (err) {
    // Never silently: the bridge is holding a session at 'running' waiting for
    // this stream, and `ended` with an error is what settles it as failed.
    sink.ended(sessionId, `Malformed codex push: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // A previous turn's child must not outlive the push that supersedes it.
  closeCodex(sessionId);

  const threadOptions: ThreadOptions = {
    ...(options.model ? { model: options.model } : {}),
    sandboxMode: options.sandboxMode,
    approvalPolicy: options.approvalPolicy,
    workingDirectory: options.workingDirectory,
    ...(options.additionalDirectories?.length
      ? { additionalDirectories: options.additionalDirectories }
      : {}),
    ...(options.skipGitRepoCheck ? { skipGitRepoCheck: true } : {}),
    ...(options.networkAccessEnabled !== undefined
      ? { networkAccessEnabled: options.networkAccessEnabled }
      : {}),
  };

  const codex = new Codex({
    ...(options.codexPath ? { codexPathOverride: options.codexPath } : {}),
    // Passing `env` means the SDK does NOT inherit process.env, so it is spread
    // here — the same trap buildQueryOptions already works around for the Claude
    // side. Without PATH and HOME the child cannot find git, node or a shell.
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      CODEX_HOME: options.codexHome,
    },
  });

  const thread = options.threadId
    ? codex.resumeThread(options.threadId, threadOptions)
    : codex.startThread(threadOptions);

  const state: CodexSessionState = {
    codex,
    thread,
    abort: new AbortController(),
    busy: true,
    ...(options.threadId ? { threadId: options.threadId } : {}),
  };
  codexSessions.set(sessionId, state);
  void pumpCodex(sessionId, state, input, sink);
}

async function pumpCodex(
  sessionId: string,
  state: CodexSessionState,
  input: string,
  sink: CodexSink,
) {
  try {
    const { events } = await state.thread.runStreamed(input, { signal: state.abort.signal });
    for await (const event of events) {
      const msg = event as unknown as Record<string, unknown> & { type?: unknown };
      // Recorded here as well as forwarded: the bridge repairs its persisted
      // pointer from `hello`, which is read off this state, not off the stream.
      if (msg.type === 'thread.started' && typeof msg.thread_id === 'string') {
        state.threadId = msg.thread_id;
      }
      sink.event(sessionId, msg);
    }
    sink.ended(sessionId);
  } catch (err) {
    // An abort is a Stop, not a failure: the child is killed with a signal, which
    // the SDK reports as a throw. Reporting it as an error would put a red banner
    // and a Retry on a turn the user deliberately stopped.
    if (state.abort.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
      sink.ended(sessionId);
    } else {
      console.error(`[worker] codex session ${sessionId} failed:`, err);
      sink.ended(sessionId, err instanceof Error ? err.message : String(err));
    }
  } finally {
    state.busy = false;
    // One child per turn: the state stays only to answer `hello` with the thread
    // id, and the next push replaces it wholesale.
  }
}
