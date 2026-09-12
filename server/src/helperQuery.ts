/**
 * The bridge's own one-shot helper queries, on whichever provider is connected.
 *
 * These are the small, non-agentic calls Lines makes for itself rather than for
 * the user: naming a session from its first prompt, summarizing a finished turn,
 * consolidating an iterated workflow step, and judging an MCP URL before it is
 * trusted. They are not sessions — they run on the bridge, hold no conversation,
 * and their failure costs a title or a summary, never a turn.
 *
 * They used to be Claude-only, which quietly made an OpenAI-only user a
 * second-class one: every session stayed untitled, no turn ever got a summary,
 * every workflow step skipped consolidation, and — the one that matters — every
 * MCP connection went un-vetted (`UNCHECKED`, never "allowed", so the failure was
 * safe but the protection was absent).
 *
 * So provider selection lives here, once, rather than at four call sites:
 *
 *  - Claude when the app holds a Claude token. Unchanged behaviour, and the
 *    cheaper path — the CLI is already warm and the models are small.
 *  - Codex when it is not, via a one-shot `codex exec` on a fast model.
 *  - Null when neither is connected, which every caller already handles.
 *
 * Both paths are tool-free and single-turn, and that is a security property, not
 * thrift: the MCP judge must not be able to fetch the page it is judging, or the
 * page could talk it into trusting itself.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { claudeCliStatus } from './claudeCli.ts';
import { codexCliStatus } from './codexCli.ts';

/**
 * The Codex model helper queries run on: the cheapest and fastest one Lines
 * offers, which is the same reason the Claude path uses Haiku. Deliberately not
 * the session's own model — a helper is Lines' cost, not the user's choice.
 */
export const CODEX_HELPER_MODEL = 'gpt-5.6-luna';

/** How long a helper may run before its caller gives up and uses its fallback. */
const HELPER_TIMEOUT_MS = 60_000;

export interface HelperQueryDeps {
  /** The owner's Claude access token, or null when the app holds none. */
  claudeToken: () => Promise<string | null>;
  /** `$CODEX_HOME` when an OpenAI account is connected; null when it is not. */
  codexHome: () => string | null;
}

export interface HelperQueryRequest {
  prompt: string;
  systemPrompt: string;
  /** Which Claude model to use when that is the provider chosen. */
  claudeModel: string;
  /** Working directory for the codex child. Only used to give it somewhere to
   *  start; helpers read no files. */
  cwd?: string;
}

/**
 * The serializable shape of a Claude helper query: non-agentic, no tools, no
 * setting sources, the owner's OAuth token, and this machine's CLI. One place, so
 * the call sites cannot drift on any of it.
 */
function claudeOptions(token: string, model: string, systemPrompt: string): Record<string, unknown> {
  const cli = claudeCliStatus();
  return {
    model,
    maxTurns: 1,
    allowedTools: [],
    settingSources: [],
    systemPrompt,
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
    ...(cli.path ? { pathToClaudeCodeExecutable: cli.path } : {}),
  };
}

async function runClaudeHelper(
  token: string,
  request: HelperQueryRequest,
): Promise<string | null> {
  const q = query({
    prompt: request.prompt,
    options: claudeOptions(token, request.claudeModel, request.systemPrompt) as never,
  });
  let answer: string | null = null;
  for await (const message of q) {
    const msg = message as { type: string; result?: string };
    if (msg.type === 'result' && typeof msg.result === 'string') answer = msg.result.trim();
  }
  return answer;
}

/**
 * The codex equivalent, over `codex exec` rather than the app-server the worker
 * now uses for sessions.
 *
 * Deliberate: a helper is genuinely one-shot and non-interactive, which is
 * exactly what `exec` is for. Routing it through the app-server would mean
 * standing up a long-lived child on the *bridge* just to title a session, and
 * would buy nothing — no streaming to show, no approvals to answer, no turn to
 * steer.
 *
 * `codex exec` takes no system prompt, so the instruction is folded into the
 * message — acceptable for a single-turn helper, where there is no later turn
 * for the model to drift across.
 *
 * `read-only` and `approvalPolicy: 'never'` together are what keep this as
 * tool-free as the Claude path: the model may look, never act, and nothing can
 * block waiting for a human who is not watching.
 */
async function runCodexHelper(
  codexHome: string,
  request: HelperQueryRequest,
): Promise<string | null> {
  const cli = codexCliStatus();
  if (cli.state !== 'ok') return null;
  const codex = new Codex({
    ...(cli.path ? { codexPathOverride: cli.path } : {}),
    // Spreading process.env is required: passing `env` at all stops the SDK
    // inheriting it, and without PATH/HOME the child cannot start.
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      CODEX_HOME: codexHome,
    },
  });
  const thread = codex.startThread({
    model: CODEX_HELPER_MODEL,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    ...(request.cwd ? { workingDirectory: request.cwd } : {}),
  });
  const turn = await thread.run(`${request.systemPrompt}\n\n${request.prompt}`);
  const text = turn.finalResponse?.trim();
  return text ? text : null;
}

/**
 * Run one helper query on whichever provider is available, or answer null.
 *
 * Never throws: every caller treats null as "no answer" and has a fallback
 * (a default session name, no summary, an `UNCHECKED` verdict), so a helper
 * failure must not become the caller's failure.
 */
export async function runHelperQuery(
  deps: HelperQueryDeps,
  request: HelperQueryRequest,
): Promise<string | null> {
  const attempt = async (): Promise<string | null> => {
    const token = await deps.claudeToken();
    if (token) return runClaudeHelper(token, request);
    const home = deps.codexHome();
    if (home) return runCodexHelper(home, request);
    return null;
  };
  try {
    // A helper that hangs must not hold up the thing that asked for it — a
    // workflow advance waits on consolidation, and the MCP judge blocks a
    // connection the user is trying to add.
    return await Promise.race([
      attempt(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HELPER_TIMEOUT_MS).unref()),
    ]);
  } catch (err) {
    console.warn('[helper]', err instanceof Error ? err.message : String(err));
    return null;
  }
}
