/**
 * Codex turn events, and their translation into the Claude SDK message shapes the
 * rest of the app already reads.
 *
 * Why normalize rather than add a `kind: 'codex'` transcript event: the bridge's
 * turn machinery — not just the renderer — is keyed to SDK message shapes. The
 * `msg.type === 'result'` settle pass alone drives status, token accounting,
 * spend, the queue flush, the workflow advance, the turn summary and the review
 * diff; `markTurnLive`, `collectTurns`, `scanTurnActivity`, `collectChangedPaths`
 * and the rewind anchor scan all read `assistant`/`user` content blocks. A distinct
 * event kind would silently no-op every one of them, leaving a codex session stuck
 * at 'running' with an empty diff.
 *
 * Normalization is also the established idiom here: `SessionManager.failTurn`
 * already writes a synthetic `{type:'result'}` under `kind:'sdk'` for failures no
 * SDK produced, and `TranscriptEvent` documents `kind: 'sdk'` as carrying
 * bridge-added fields.
 *
 * Every normalized message carries `_engine: 'codex'` and the raw codex item in
 * `_codex`, so nothing provider-specific is lost from the JSONL even though the
 * envelope is Claude-shaped.
 *
 * The codex event types below are declared here rather than imported from
 * `@openai/codex-sdk`: `shared/` is imported by the browser bundle and must not
 * take a server dependency. They are a narrow subset — only the fields that are
 * read.
 */

/* ------------------------------------------------------------------ *
 * Codex wire shapes (subset)
 * ------------------------------------------------------------------ */

export interface CodexAgentMessageItem {
  id: string;
  type: 'agent_message';
  text: string;
}

export interface CodexReasoningItem {
  id: string;
  type: 'reasoning';
  text: string;
}

export interface CodexCommandExecutionItem {
  id: string;
  type: 'command_execution';
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: 'in_progress' | 'completed' | 'failed';
}

export interface CodexFileChangeItem {
  id: string;
  type: 'file_change';
  changes: { path: string; kind: 'add' | 'delete' | 'update' }[];
  status: 'completed' | 'failed';
}

export interface CodexMcpToolCallItem {
  id: string;
  type: 'mcp_tool_call';
  server: string;
  tool: string;
  arguments: unknown;
  result?: unknown;
  error?: { message: string };
  status: 'in_progress' | 'completed' | 'failed';
}

export interface CodexWebSearchItem {
  id: string;
  type: 'web_search';
  query: string;
}

export interface CodexTodoListItem {
  id: string;
  type: 'todo_list';
  items: { text: string; completed: boolean }[];
}

export interface CodexErrorItem {
  id: string;
  type: 'error';
  message: string;
}

export type CodexItem =
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexTodoListItem
  | CodexErrorItem;

/** Token counts codex reports once per turn. No USD cost and no duration. */
export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export type CodexEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: CodexUsage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: CodexItem }
  | { type: 'item.updated'; item: CodexItem }
  | { type: 'item.completed'; item: CodexItem }
  | { type: 'error'; message: string };

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/** A Claude-SDK-shaped message, as the bridge and the renderer consume it. */
export type SdkShapedMessage = Record<string, unknown> & { type: string };

export interface CodexNormalizeDeps {
  /** Mints the `uuid` an assistant message needs (the rewind anchor scan reads it). */
  newId: () => string;
  /** The Lines model id this turn ran on, echoed into the message envelope. */
  model: string;
}

export interface CodexNormalized {
  /** Messages to feed through the ordinary SDK event path, in order. */
  messages: SdkShapedMessage[];
  /** Thread id captured from `thread.started`; the resume pointer. */
  threadId?: string;
  /** A fatal failure whose text must reach `failTurn` verbatim. */
  failure?: string;
}

const NOTHING: CodexNormalized = { messages: [] };

/**
 * `tool_use_id` for one codex item. Derived from the item id rather than minted,
 * so the `tool_use` and the `tool_result` this module emits from the *same* item
 * pair up in the renderer without any shared state.
 */
export function codexToolUseId(itemId: string): string {
  return `codex_${itemId}`;
}

/** Tool name a codex item renders under. `ApplyPatch` is deliberately not one of
 *  the Claude edit tools: codex reports no before/after, so pairing it into a
 *  diff card would promise a diff that does not exist. */
function toolNameFor(item: CodexItem): string {
  switch (item.type) {
    case 'command_execution':
      return 'Bash';
    case 'file_change':
      return 'ApplyPatch';
    case 'mcp_tool_call':
      return `mcp__${item.server}__${item.tool}`;
    case 'web_search':
      return 'WebSearch';
    default:
      return 'TodoWrite';
  }
}

function toolInputFor(item: CodexItem): Record<string, unknown> {
  switch (item.type) {
    case 'command_execution':
      return { command: item.command };
    case 'file_change':
      return { changes: item.changes };
    case 'mcp_tool_call':
      return { server: item.server, tool: item.tool, arguments: item.arguments };
    case 'web_search':
      return { query: item.query };
    case 'todo_list':
      return { todos: item.items };
    default:
      return {};
  }
}

/** Text the tool card shows as the call's output, and whether it failed. */
function toolResultFor(item: CodexItem): { text: string; isError: boolean } {
  switch (item.type) {
    case 'command_execution': {
      const failed = item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0);
      const code = item.exit_code != null ? `\nExit code: ${item.exit_code}` : '';
      return { text: `${item.aggregated_output ?? ''}${code}`, isError: failed };
    }
    case 'file_change': {
      const lines = item.changes.map((c) => `${c.kind} ${c.path}`).join('\n');
      return { text: lines, isError: item.status === 'failed' };
    }
    case 'mcp_tool_call': {
      if (item.error) return { text: item.error.message, isError: true };
      return {
        text: typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? null),
        isError: item.status === 'failed',
      };
    }
    case 'web_search':
      return { text: item.query, isError: false };
    case 'todo_list':
      return {
        text: item.items.map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n'),
        isError: false,
      };
    default:
      return { text: '', isError: false };
  }
}

function assistantMessage(
  deps: CodexNormalizeDeps,
  content: Record<string, unknown>[],
  raw: unknown,
): SdkShapedMessage {
  return {
    type: 'assistant',
    uuid: deps.newId(),
    parent_tool_use_id: null,
    message: {
      id: deps.newId(),
      type: 'message',
      role: 'assistant',
      model: deps.model,
      content,
      stop_reason: null,
      stop_sequence: null,
    },
    _engine: 'codex',
    _codex: raw,
  };
}

function toolResultMessage(
  deps: CodexNormalizeDeps,
  toolUseId: string,
  result: { text: string; isError: boolean },
  raw: unknown,
): SdkShapedMessage {
  return {
    type: 'user',
    uuid: deps.newId(),
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: result.text,
          ...(result.isError ? { is_error: true } : {}),
        },
      ],
    },
    _engine: 'codex',
    _codex: raw,
  };
}

/**
 * One codex event as SDK-shaped messages.
 *
 * `item.started` and `item.updated` map to nothing on purpose. Streaming them
 * would need them to be droppable, and the bridge's `isDroppable` plus the
 * client's supersede rule only understand `kind: 'sdk'` `stream_event` — so
 * undroppable partials would escalate the socket's backpressure handling and
 * pile up client-side. The consequence, stated in the UI: a codex turn's text
 * appears per completed message.
 */
export function normalizeCodexEvent(event: CodexEvent, deps: CodexNormalizeDeps): CodexNormalized {
  switch (event.type) {
    case 'thread.started':
      return { messages: [], threadId: event.thread_id };
    case 'turn.started':
    case 'item.started':
    case 'item.updated':
      return NOTHING;
    case 'turn.failed':
      return { messages: [], failure: event.error?.message ?? 'The turn failed.' };
    case 'error':
      return { messages: [], failure: event.message || 'The turn failed.' };
    case 'turn.completed': {
      const u = event.usage;
      return {
        messages: [
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            // No `total_cost_usd` and no `duration_ms`: codex reports neither, and
            // both are already optional downstream (the spend accumulator tolerates
            // a missing cost, the UI hides an unset duration).
            usage: {
              input_tokens: u?.input_tokens ?? 0,
              // Reasoning tokens are billed output tokens; folding them in here is
              // what keeps the session's spend from under-reporting.
              output_tokens: (u?.output_tokens ?? 0) + (u?.reasoning_output_tokens ?? 0),
              cache_read_input_tokens: u?.cached_input_tokens ?? 0,
              cache_creation_input_tokens: u?.cache_write_input_tokens ?? 0,
            },
            _engine: 'codex',
            _codex: event,
          },
        ],
      };
    }
    case 'item.completed': {
      const item = event.item;
      switch (item.type) {
        case 'agent_message':
          return item.text
            ? { messages: [assistantMessage(deps, [{ type: 'text', text: item.text }], item)] }
            : NOTHING;
        case 'reasoning':
          return item.text
            ? {
                messages: [
                  assistantMessage(deps, [{ type: 'thinking', thinking: item.text, signature: '' }], item),
                ],
              }
            : NOTHING;
        // An item-level error is not fatal to the turn (`turn.failed` is), so it
        // reads as the agent's own text rather than a failed result.
        case 'error':
          return { messages: [assistantMessage(deps, [{ type: 'text', text: item.message }], item)] };
        default: {
          const toolUseId = codexToolUseId(item.id);
          return {
            messages: [
              assistantMessage(
                deps,
                [{ type: 'tool_use', id: toolUseId, name: toolNameFor(item), input: toolInputFor(item) }],
                item,
              ),
              toolResultMessage(deps, toolUseId, toolResultFor(item), item),
            ],
          };
        }
      }
    }
    default:
      return NOTHING;
  }
}

/**
 * Every `type` a codex event can carry. An explicit set rather than a shape
 * guess: this is what routes a worker event to the codex normalizer instead of
 * the SDK path, and none of these collides with an SDK message type
 * (`assistant`, `user`, `result`, `system`, `stream_event`).
 */
const CODEX_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);

/** True when this worker event is a codex event, to be normalized rather than
 *  read as an SDK message. */
export function isCodexEvent(value: unknown): value is CodexEvent {
  const type = (value as { type?: unknown } | null)?.type;
  return typeof type === 'string' && CODEX_EVENT_TYPES.has(type);
}
