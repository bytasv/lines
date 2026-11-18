// SPDX-License-Identifier: AGPL-3.0-only
// Additional permission under GNU AGPL v3 section 7 — see LICENSE-EXCEPTION.

/**
 * Plan side-chat: answer a question about a pending plan card from a forked,
 * read-only copy of the session's conversation — read-only except for the card's
 * own plan file, which the fork may Write or Edit when the user asks for a change.
 *
 * Runs on the bridge, the way `helperQuery.ts` does, and never through the
 * worker. The worker holds one query per session id, and its events feed
 * `handleWorkerEvent` — turns, the resume pointer, cost lineage. A side question
 * must touch none of that: the live turn is still blocked on the card, and the
 * answer belongs on the card, not in the conversation.
 *
 * Kept to four pieces: where to fork (`planChatAnchor`), which plan file it may
 * edit (`planChatPlanFile`), what the fork may do (`planChatToolDecision`), and
 * the one SDK query that asks it (`runPlanChatTurn`). The session bookkeeping lives in `SessionManager.askPlanChat`.
 */
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { isPlanFilePath, type GuardAllowEntry, type TranscriptEvent } from '@lines/shared';
import { isPlanPath, isSafePlanModeRead } from './autoGuard.ts';
import { claudeCliStatus } from './claudeCli.ts';

/** Appended to the fork's system prompt when there is no plan file to edit. */
export const PLAN_CHAT_SYSTEM_APPEND =
  'The user is reviewing the plan you proposed and asking side questions. Answer only; ' +
  'do not edit files, do not re-propose or exit plan mode. Read files if needed.';

/**
 * The fork's system prompt append: answer-only without a plan file; with one,
 * answer, and edit that one file only when the user asks for a change.
 */
export function planChatSystemAppend(planPath?: string): string {
  if (!planPath) return PLAN_CHAT_SYSTEM_APPEND;
  return (
    'The user is reviewing the plan you proposed and asking side questions. Answer questions. ' +
    `Only when the user asks you to change the plan, edit the plan file at ${planPath} ` +
    '(Read it first, change only what was asked, keep the rest intact). ' +
    'Never edit any other file, never exit or re-propose plan mode. Read files if needed. ' +
    'After editing, say briefly what changed.'
  );
}

/** The fixed deny reason for every call the side chat may not make. */
export const PLAN_CHAT_DENY_MESSAGE =
  'This is a read-only side conversation about the plan. Only read-only tools are available, ' +
  'plus Write or Edit of the plan file itself when the user asks for a change — answer the question instead.';

/** Turns one side question may take, tool round-trips included. */
const PLAN_CHAT_MAX_TURNS = 15;

/**
 * Tools isSafePlanModeRead passes that the side chat still refuses: subagents
 * and background tasks outlive the answer and run outside this policy, and a
 * skill can do anything.
 */
const PLAN_CHAT_DENIED_READS = new Set([
  'Agent', 'Task', 'SendMessage', 'ListAgents', 'Skill', 'Monitor',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
]);

/**
 * Write tools named to the CLI as disallowed, so a `permissions.allow` rule in
 * the user's or project's settings cannot pre-empt `canUseTool` for them. Bash
 * cannot be listed (its reads are allowed); the PreToolUse hook covers it.
 */
const PLAN_CHAT_DISALLOWED_TOOLS = [
  'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion',
  ...PLAN_CHAT_DENIED_READS,
];

/** The tools the plan file may be changed with, and only when there is a plan file. */
const PLAN_CHAT_PLAN_EDIT_TOOLS = new Set(['Write', 'Edit']);

/**
 * The disallowed list for one side question. With a plan file, Write and Edit
 * come off it so the fork can revise that file; the PreToolUse hook still runs
 * before any settings allow rule, so a broad `Edit` allow rule cannot widen
 * them past `planChatToolDecision` — the same reasoning Bash relies on.
 */
export function planChatDisallowedTools(planPath?: string): string[] {
  return planPath
    ? PLAN_CHAT_DISALLOWED_TOOLS.filter((tool) => !PLAN_CHAT_PLAN_EDIT_TOOLS.has(tool))
    : [...PLAN_CHAT_DISALLOWED_TOOLS];
}

/**
 * Where to fork the conversation for a side chat about `requestId`'s plan: the
 * uuid of the last main-thread assistant message *before* the one carrying the
 * pending ExitPlanMode tool_use. `upToMessageId` is inclusive, so this keeps the
 * dangling tool call — which the CLI never got a result for — out of the fork.
 *
 * Scans backwards from the permission request, the same shape rewind's anchor
 * scan has, and stops at a provider switch: anything older belongs to a
 * conversation the session's current Claude session id has never seen.
 *
 * Null when the request is not in the transcript or nothing precedes it.
 */
export function planChatAnchor(events: TranscriptEvent[], requestId: string): string | null {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'permission') continue;
    const d = e.data as { requestId?: string; toolName?: string } | null;
    if (d?.requestId === requestId && d.toolName === 'ExitPlanMode') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  let passedToolUse = false;
  for (let i = start - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'provider-switch') return null;
    if (e.kind !== 'sdk') continue;
    const d = e.data as {
      type?: string;
      uuid?: string;
      parent_tool_use_id?: string | null;
      message?: { content?: unknown };
    } | null;
    // Subagent messages live in their own sidechain file, never in the session
    // file a fork copies, so their uuids cannot anchor one.
    if (d?.type !== 'assistant' || d.parent_tool_use_id) continue;
    if (typeof d.uuid !== 'string' || !d.uuid) continue;
    if (!passedToolUse && carriesExitPlan(d.message?.content)) {
      passedToolUse = true;
      continue;
    }
    // Either the message before the tool_use, or — when the tool_use message was
    // never recorded — the newest assistant message before the card.
    return d.uuid;
  }
  return null;
}

/**
 * The plan file behind `requestId`'s card: the `file_path` of the newest Write or
 * Edit into a plans directory before the ExitPlanMode permission request.
 * Subagent writes count (a Plan subagent may write the plan the main agent then
 * proposes), the same rule the web's card uses. Stops at a provider switch.
 *
 * Only a candidate: the caller still checks it with `isPlanPath` against the
 * session's roots before letting the fork touch it.
 */
export function planChatPlanFile(events: TranscriptEvent[], requestId: string): string | null {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'permission') continue;
    const d = e.data as { requestId?: string; toolName?: string } | null;
    if (d?.requestId === requestId && d.toolName === 'ExitPlanMode') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  for (let i = start - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'provider-switch') return null;
    if (e.kind !== 'sdk') continue;
    const d = e.data as { type?: string; message?: { content?: unknown } } | null;
    if (d?.type !== 'assistant' || !Array.isArray(d.message?.content)) continue;
    const content = d.message.content as unknown[];
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j] as { type?: unknown; name?: unknown; input?: { file_path?: unknown } } | null;
      if (b?.type !== 'tool_use' || typeof b.name !== 'string' || !PLAN_CHAT_PLAN_EDIT_TOOLS.has(b.name)) continue;
      const filePath = b.input?.file_path;
      if (typeof filePath === 'string' && filePath && isPlanFilePath(filePath)) return filePath;
    }
  }
  return null;
}

function carriesExitPlan(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (b) =>
        !!b &&
        typeof b === 'object' &&
        (b as { type?: unknown }).type === 'tool_use' &&
        (b as { name?: unknown }).name === 'ExitPlanMode',
    )
  );
}

/**
 * A short, human label for the tool calls in one assistant message — "Reading
 * sessions.ts", "Running `git log`" — shown while the side chat works. The last
 * call wins: it is the one running when the label is shown.
 */
export function describeToolCalls(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  let label: string | undefined;
  for (const block of content) {
    const b = block as { type?: unknown; name?: unknown; input?: unknown } | null;
    if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
    label = describeToolCall(b.name, (b.input ?? {}) as Record<string, unknown>);
  }
  return label;
}

function describeToolCall(name: string, input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const base = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;
  switch (name) {
    case 'Read':
      return str(input.file_path) ? `Reading ${base(str(input.file_path))}` : 'Reading a file';
    case 'Edit':
    case 'Write':
      return 'Editing the plan';
    case 'Grep':
      return str(input.pattern) ? `Searching for \`${clip(str(input.pattern), 40)}\`` : 'Searching';
    case 'Glob':
      return str(input.pattern) ? `Finding \`${clip(str(input.pattern), 40)}\`` : 'Finding files';
    case 'Bash':
      return str(input.command) ? `Running \`${clip(str(input.command).split('\n')[0])}\`` : 'Running a command';
    case 'WebFetch':
      return 'Fetching a page';
    case 'WebSearch':
      return str(input.query) ? `Searching the web for “${clip(str(input.query), 40)}”` : 'Searching the web';
    default:
      return `Using ${name}`;
  }
}

export type PlanChatToolVerdict = { allow: true } | { allow: false; message: string };

/**
 * What the side chat may do: observe, and revise its own plan file. Allowed when
 * plan mode would auto-approve the call as a read (`isSafePlanModeRead`) and it
 * is not one of the reads that spawn work of their own — or when it is a Write
 * or Edit of exactly `planPath`, which must itself be a real plan path under
 * `roots`. Everything else is denied with a fixed message — never escalated to
 * a card, because there is no turn for a card to belong to.
 */
export function planChatToolDecision(
  toolName: string,
  input: Record<string, unknown>,
  roots: string[],
  allowlist: GuardAllowEntry[],
  planPath?: string,
): PlanChatToolVerdict {
  if (PLAN_CHAT_DENIED_READS.has(toolName)) return { allow: false, message: PLAN_CHAT_DENY_MESSAGE };
  if (PLAN_CHAT_PLAN_EDIT_TOOLS.has(toolName)) {
    const filePath = input.file_path;
    const isOwnPlan =
      !!planPath &&
      typeof filePath === 'string' &&
      !!filePath &&
      path.resolve(filePath) === path.resolve(planPath) &&
      isPlanPath(planPath, roots);
    return isOwnPlan ? { allow: true } : { allow: false, message: PLAN_CHAT_DENY_MESSAGE };
  }
  // Lines' own tools are never mounted here; refuse them by name anyway, so a
  // read-verb name like `mcp__lines__get_workflow` is not the one exception.
  if (toolName.startsWith('mcp__lines__')) return { allow: false, message: PLAN_CHAT_DENY_MESSAGE };
  if (isSafePlanModeRead(toolName, input, roots, allowlist)) return { allow: true };
  return { allow: false, message: PLAN_CHAT_DENY_MESSAGE };
}

export interface PlanChatTurnRequest {
  /** The forked CLI session to resume. */
  forkSessionId: string;
  prompt: string;
  cwd: string;
  /** Project roots; the ones other than `cwd` ride as additionalDirectories. */
  roots: string[];
  /** Resolved model id. */
  model: string;
  token: string | null;
  allowlist: () => GuardAllowEntry[];
  /**
   * The card's plan file, already checked with `isPlanPath`. When set, the fork
   * may Write or Edit this one file; when absent, the chat is answer-only.
   */
  planPath?: string;
  signal: AbortSignal;
  /**
   * The answer so far, as it streams: the current assistant message's whole
   * text, and the tool being used when there is one. Called often; the caller
   * throttles.
   */
  onPartial?: (partial: { text: string; activity?: string }) => void;
}

export interface PlanChatTurnResult {
  text: string;
  /** The session the answer was written to — the fork, unless the CLI moved it. */
  sessionId: string;
  costUsd?: number;
}

/** The runner's shape, so SessionManager can take a stand-in in tests. */
export type PlanChatRunner = (request: PlanChatTurnRequest) => Promise<PlanChatTurnResult>;

/**
 * One side question: a single SDK query resuming the fork, read-only (bar the
 * card's plan file) by two independent gates — a PreToolUse hook (which runs before any settings allow
 * rule) and `canUseTool` (for anything that still reaches a prompt), both
 * calling `planChatToolDecision`. No Lines MCP server, no user MCP servers.
 *
 * Throws on failure or abort; the caller turns that into an error entry.
 */
export const runPlanChatTurn: PlanChatRunner = async (request) => {
  const decide = (toolName: string, input: Record<string, unknown>) =>
    planChatToolDecision(toolName, input, request.roots, request.allowlist(), request.planPath);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener('abort', onAbort, { once: true });

  const cli = claudeCliStatus();
  const extraRoots = request.roots.filter((root) => root !== request.cwd);
  const options = {
    resume: request.forkSessionId,
    cwd: request.cwd,
    ...(extraRoots.length ? { additionalDirectories: extraRoots } : {}),
    model: request.model,
    maxTurns: PLAN_CHAT_MAX_TURNS,
    // Token deltas, so the card can show the answer as it is written.
    includePartialMessages: true,
    settingSources: ['user', 'project'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: planChatSystemAppend(request.planPath) },
    permissionMode: 'default',
    disallowedTools: planChatDisallowedTools(request.planPath),
    mcpServers: {},
    abortController: abort,
    canUseTool: async (toolName: string, input: Record<string, unknown>) => {
      const verdict = decide(toolName, input);
      return verdict.allow
        ? { behavior: 'allow' as const, updatedInput: input }
        : { behavior: 'deny' as const, message: verdict.message };
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input: unknown) => {
              const hook = input as { tool_name?: string; tool_input?: Record<string, unknown> };
              const verdict = decide(String(hook.tool_name ?? ''), hook.tool_input ?? {});
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: verdict.allow ? 'allow' : 'deny',
                  ...(verdict.allow ? {} : { permissionDecisionReason: verdict.message }),
                },
              };
            },
          ],
        },
      ],
    },
    ...(request.token
      ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: request.token } }
      : {}),
    ...(cli.path ? { pathToClaudeCodeExecutable: cli.path } : {}),
  };

  try {
    const q = query({ prompt: request.prompt, options: options as never });
    let text: string | null = null;
    let sessionId = request.forkSessionId;
    let costUsd: number | undefined;
    let failure: string | null = null;
    // The streamed view: the text of the assistant message being written now.
    // Reset per message, because the final `result` is the last message's text,
    // not every message's — what streams should end as what lands.
    let streamed = '';
    let activity: string | undefined;
    for await (const message of q) {
      const msg = message as {
        type: string;
        subtype?: string;
        result?: string;
        session_id?: string;
        total_cost_usd?: number;
        errors?: string[];
        event?: {
          type?: string;
          content_block?: { type?: string; name?: string };
          delta?: { type?: string; text?: string };
        };
        message?: { content?: unknown };
      };
      if (typeof msg.session_id === 'string' && msg.session_id) sessionId = msg.session_id;
      if (!request.onPartial) {
        if (msg.type !== 'result') continue;
      } else if (msg.type === 'stream_event') {
        const event = msg.event;
        if (event?.type === 'message_start') {
          streamed = '';
          activity = 'Thinking';
        } else if (event?.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'tool_use') activity = `Using ${block.name ?? 'a tool'}`;
          else if (block?.type === 'thinking') activity = 'Thinking';
          else continue;
          request.onPartial({ text: streamed, activity });
        } else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          streamed += event.delta.text ?? '';
          activity = undefined;
          request.onPartial({ text: streamed });
        }
        continue;
      } else if (msg.type === 'assistant') {
        // The complete message names what each tool call is for, which the
        // stream's content_block_start cannot (its input is still arriving).
        const label = describeToolCalls(msg.message?.content);
        if (label) {
          activity = label;
          request.onPartial({ text: streamed, activity });
        }
        continue;
      } else if (msg.type === 'user') {
        // A tool result went back to the model; it is reading it.
        activity = 'Thinking';
        request.onPartial({ text: streamed, activity });
        continue;
      }
      if (msg.type !== 'result') continue;
      if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd;
      if (msg.subtype === 'success' && typeof msg.result === 'string') text = msg.result.trim();
      else failure = msg.errors?.join('; ') || msg.subtype || 'failed';
    }
    if (request.signal.aborted) throw new Error('Cancelled.');
    if (!text) throw new Error(failure ? `No answer (${failure}).` : 'No answer.');
    return { text, sessionId, ...(costUsd !== undefined ? { costUsd } : {}) };
  } finally {
    request.signal.removeEventListener('abort', onAbort);
  }
};
