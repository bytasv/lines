// SPDX-License-Identifier: AGPL-3.0-only
// Additional permission under GNU AGPL v3 section 7 — see LICENSE-EXCEPTION.

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
 * So provider selection lives here, once, rather than at four call sites. It is a
 * preference with a fallback, never a hard route:
 *
 *  - `prefer` is tried first when that provider is connected. A session-scoped
 *    helper passes the session's own provider, so a codex session's title is
 *    written by codex rather than by Claude — the title is about that session's
 *    work, and a user holding both logins should not see one provider quietly
 *    doing the other's chores.
 *  - The other provider is tried when the preferred one is absent or answers
 *    null (a stale CLI probe, a helper model the account cannot reach). A
 *    degraded title beats no title.
 *  - With no preference, Claude first and codex second — the older order, and
 *    the cheaper path, since the CLI is already warm and the models are small.
 *  - Null when neither is connected, which every caller already handles.
 *
 * Both paths are tool-free and single-turn, and that is a security property, not
 * thrift: the MCP judge must not be able to fetch the page it is judging, or the
 * page could talk it into trusting itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import type { ModelProvider } from '@lines/shared';
import { claudeCliStatus } from './claudeCli.ts';
import { codexCliStatus } from './codexCli.ts';

/**
 * The Codex model helper queries run on: the cheapest and fastest one Lines
 * offers, which is the same reason the Claude path uses Haiku. Deliberately not
 * the session's own model — a helper is Lines' cost, not the user's choice.
 */
export const CODEX_HELPER_MODEL = 'gpt-6-luna';

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
  /**
   * Which provider to consult first. A session-scoped helper passes the
   * session's own provider; the other one is still tried when this one is
   * absent or answers null. Omitted means "no preference" — Claude first.
   */
  prefer?: ModelProvider;
}

/**
 * A directory with nothing in it, which is the point.
 *
 * Both CLIs pull ambient context from wherever they are started — Claude's
 * auto-memory defaults to `~/.claude/projects/<sanitized-cwd>/memory/`, and codex
 * reads `AGENTS.md` from its cwd. A helper is asked to summarize the text it was
 * handed and nothing else, so it is started somewhere that has no text of its
 * own. Measured, not theoretical: a provider-switch summary of a two-line
 * conversation came back reciting this repo's MEMORY.md entries.
 *
 * One directory per process, created lazily and left behind — it is empty, and
 * cleaning it up would mean owning a lifecycle for nothing.
 */
let neutralDir: string | null = null;
function helperCwd(): string {
  neutralDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lines-helper-'));
  return neutralDir;
}

/**
 * The serializable shape of a Claude helper query: non-agentic, no tools, no
 * setting sources, no ambient memory, the owner's OAuth token, and this
 * machine's CLI. One place, so the call sites cannot drift on any of it.
 */
function claudeOptions(token: string, model: string, systemPrompt: string): Record<string, unknown> {
  const cli = claudeCliStatus();
  return {
    model,
    maxTurns: 1,
    allowedTools: [],
    settingSources: [],
    // Not merely tidiness: this is what keeps the project's auto-memory out of
    // an answer that is supposed to describe one conversation. See helperCwd.
    cwd: helperCwd(),
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
    // Same reason as the Claude path's `cwd`: away from the project, so no
    // AGENTS.md joins the summary it was asked for.
    workingDirectory: helperCwd(),
  });
  const turn = await thread.run(`${request.systemPrompt}\n\n${request.prompt}`);
  const text = turn.finalResponse?.trim();
  return text ? text : null;
}

/**
 * Run one helper query on the preferred provider, falling back to the other, or
 * answer null.
 *
 * Never throws: every caller treats null as "no answer" and has a fallback
 * (a default session name, no summary, an `UNCHECKED` verdict), so a helper
 * failure must not become the caller's failure.
 */
export async function runHelperQuery(
  deps: HelperQueryDeps,
  request: HelperQueryRequest,
): Promise<string | null> {
  /** Null means "not this one" — either not connected, or it had no answer. */
  const viaClaude = async (): Promise<string | null> => {
    const token = await deps.claudeToken();
    return token ? runClaudeHelper(token, request) : null;
  };
  const viaCodex = async (): Promise<string | null> => {
    const home = deps.codexHome();
    return home ? runCodexHelper(home, request) : null;
  };
  const attempt = async (): Promise<string | null> => {
    const [first, second] =
      request.prefer === 'openai' ? [viaCodex, viaClaude] : [viaClaude, viaCodex];
    // The fallback is the whole point: a codex session whose CLI probe is stale
    // or whose helper model the account cannot reach still gets a title, rather
    // than being stranded because its own provider was picked.
    return (await first()) ?? (await second());
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
