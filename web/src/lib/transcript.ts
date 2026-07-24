import type {
  Attachment,
  FileSnapshotData,
  PermissionRequestData,
  TranscriptEvent,
  TurnSummaryData,
  WorkflowMarkerData,
} from '@lines/shared';

export interface ToolBlock {
  type: 'tool';
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  snapshot?: FileSnapshotData;
}

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string };

export interface ToolGroupItem {
  kind: 'tool-group';
  key: string; // `g${firstToolUseId}` — stable across rebuilds
  tools: ToolBlock[];
  labelText?: string; // preceding text block, trimmed
}

export interface AgentTurnItem {
  kind: 'agent-turn';
  key: string; // `t${firstChild.key}` — stable
  items: TranscriptItem[]; // the agent's assistant/tool-group/permission/result items
}

export interface ResultItem {
  kind: 'result';
  key: string;
  costUsd?: number;
  durationMs?: number;
  isError: boolean;
  /** 1-2 sentence summary of the turn's tool activity, filled in async by the server. */
  summary?: string;
}

/** What the agent is doing right now, derived from unconsumed stream events. */
export interface LiveActivity {
  phase: 'responding' | 'thinking' | 'writing' | 'tool-prep';
  /** Tool being prepared (tool-prep). */
  toolName?: string;
  /** Bounded tail (~200 chars) of streamed thinking. */
  thinkingPreview?: string;
  /** Accumulated input_json_delta length — proxy for tool-arg size (e.g. a plan). */
  inputBytes?: number;
  /** The activity belongs to a subagent (parent_tool_use_id set). */
  subagent?: boolean;
}

export type TranscriptItem =
  | { kind: 'user'; key: string; text: string; source: 'user' | 'workflow'; attachments?: Attachment[] }
  | { kind: 'assistant'; key: string; blocks: AssistantBlock[]; isAnswer?: boolean }
  | ToolGroupItem
  | AgentTurnItem
  | { kind: 'streaming'; key: string; text: string }
  | { kind: 'system-init'; key: string; model: string }
  | ResultItem
  | { kind: 'permission'; key: string; data: PermissionRequestData; resolution?: 'allow' | 'deny' | 'expired' }
  | { kind: 'workflow'; key: string; data: WorkflowMarkerData };

interface SdkContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: SdkContentBlock) => (b?.type === 'text' ? (b.text ?? '') : ''))
      .join('');
  }
  return content == null ? '' : JSON.stringify(content, null, 2);
}

/**
 * Single pass over the event log:
 * - complete assistant messages become items with text/thinking/tool blocks
 * - tool_result blocks (arriving as SDK user messages) attach to their tool blocks
 * - file snapshots attach to their tool blocks by tool_use_id / file path
 * - stream_event deltas build a live "streaming" tail item, dropped once the
 *   complete assistant message lands
 * - stream events also drive `live`, the agent's current phase (thinking,
 *   preparing a tool, writing) for the standalone activity row
 */
export function buildTranscript(
  events: TranscriptEvent[],
  groupTools = true,
): { items: TranscriptItem[]; live: LiveActivity | null } {
  const items: TranscriptItem[] = [];
  const toolBlocks = new Map<string, ToolBlock>();
  const snapshots: FileSnapshotData[] = [];
  const permissionItems = new Map<string, { kind: 'permission' } & TranscriptItem>();
  const resultItems = new Map<number, ResultItem>();
  let streamingText = '';
  let streamingActive = false;
  let live: LiveActivity | null = null;
  // Live-phase accumulators, reset when a new content block starts.
  let liveThinking = '';
  let liveInputBytes = 0;
  let liveToolName: string | undefined;
  let openGroup: ToolGroupItem | null = null;
  let lastText = '';

  const attachSnapshot = (tool: ToolBlock) => {
    // Prefer exact tool_use_id match, fall back to file path (hook input ids can be absent).
    let snap = snapshots.find((s) => s.toolUseId && s.toolUseId === tool.id);
    if (!snap) {
      const file = String(tool.input.file_path ?? tool.input.notebook_path ?? '');
      snap = [...snapshots].reverse().find((s) => s.filePath === file && !s.toolUseId);
      if (!snap) snap = [...snapshots].reverse().find((s) => s.filePath === file);
    }
    if (snap) tool.snapshot = snap;
  };

  for (const event of events) {
    switch (event.kind) {
      case 'user': {
        openGroup = null;
        lastText = '';
        const data = event.data as { text: string; source?: 'user' | 'workflow'; attachments?: Attachment[] };
        items.push({
          kind: 'user',
          key: `u${event.seq}`,
          text: data.text,
          source: data.source ?? 'user',
          attachments: data.attachments,
        });
        break;
      }
      case 'file-snapshot': {
        const snap = event.data as FileSnapshotData;
        snapshots.push(snap);
        // The assistant message with this tool_use may already be rendered.
        const tool = snap.toolUseId ? toolBlocks.get(snap.toolUseId) : undefined;
        if (tool) tool.snapshot = snap;
        break;
      }
      case 'permission': {
        const data = event.data as PermissionRequestData;
        const existing = permissionItems.get(data.requestId);
        if (existing) {
          existing.resolution = data.resolution;
          if (data.answers) existing.data = { ...existing.data, answers: data.answers };
        } else {
          const item: TranscriptItem = {
            kind: 'permission',
            key: `p${event.seq}`,
            data,
            resolution: data.resolution,
          };
          permissionItems.set(data.requestId, item as never);
          items.push(item);
        }
        break;
      }
      case 'turn-summary': {
        const data = event.data as TurnSummaryData;
        const item = resultItems.get(data.resultSeq);
        if (item) item.summary = data.summary;
        break;
      }
      case 'workflow':
        openGroup = null;
        lastText = '';
        items.push({ kind: 'workflow', key: `w${event.seq}`, data: event.data as WorkflowMarkerData });
        break;
      case 'sdk': {
        const msg = event.data as Record<string, unknown> & { type: string };
        switch (msg.type) {
          case 'system': {
            if ((msg as { subtype?: string }).subtype === 'init') {
              items.push({
                kind: 'system-init',
                key: `s${event.seq}`,
                model: String((msg as { model?: string }).model ?? ''),
              });
            }
            break;
          }
          case 'assistant': {
            streamingText = '';
            streamingActive = false;
            live = null;
            const message = (msg as { message?: { content?: SdkContentBlock[] } }).message;
            let pending: AssistantBlock[] = [];
            let flushCount = 0;
            const flush = () => {
              if (pending.length === 0) return;
              const key = flushCount === 0 ? `a${event.seq}` : `a${event.seq}.${flushCount}`;
              items.push({ kind: 'assistant', key, blocks: pending });
              pending = [];
              flushCount++;
            };
            for (const block of message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                pending.push({ type: 'text', text: block.text });
                lastText = block.text;
                openGroup = null;
              } else if (block.type === 'thinking' && block.thinking) {
                pending.push({ type: 'thinking', text: block.thinking });
                lastText = '';
                openGroup = null;
              } else if (block.type === 'tool_use' && block.id && block.name) {
                flush();
                const tool: ToolBlock = {
                  type: 'tool',
                  id: block.id,
                  name: block.name,
                  input: block.input ?? {},
                };
                toolBlocks.set(block.id, tool);
                attachSnapshot(tool);
                // Full level (groupTools=false): each tool is its own 1-tool group,
                // which ToolGroup renders as a bare card — i.e. ungrouped.
                if (!groupTools) openGroup = null;
                if (!openGroup) {
                  openGroup = {
                    kind: 'tool-group',
                    key: `g${block.id}`,
                    tools: [],
                    labelText: lastText ? lastText.slice(0, 100) : undefined,
                  };
                  items.push(openGroup);
                }
                openGroup.tools.push(tool);
                if (!groupTools) openGroup = null;
              }
            }
            flush();
            break;
          }
          case 'user': {
            // SDK-generated user messages carry tool results.
            const message = (msg as { message?: { content?: unknown } }).message;
            const content = message?.content;
            if (Array.isArray(content)) {
              for (const block of content as SdkContentBlock[]) {
                if (block.type === 'tool_result' && block.tool_use_id) {
                  const tool = toolBlocks.get(block.tool_use_id);
                  if (tool) {
                    tool.result = contentToString(block.content);
                    tool.isError = Boolean(block.is_error);
                  }
                }
              }
            }
            break;
          }
          case 'result': {
            streamingText = '';
            streamingActive = false;
            live = null;
            openGroup = null;
            lastText = '';
            const r = msg as { total_cost_usd?: number; duration_ms?: number; is_error?: boolean; subtype?: string };
            const resultItem: ResultItem = {
              kind: 'result',
              key: `r${event.seq}`,
              costUsd: r.total_cost_usd,
              durationMs: r.duration_ms,
              isError: Boolean(r.is_error) || (r.subtype != null && r.subtype !== 'success'),
            };
            resultItems.set(event.seq, resultItem);
            items.push(resultItem);
            break;
          }
          case 'stream_event': {
            // Subagent deltas (parent_tool_use_id set) drive `live` but must not
            // clobber the main agent's streaming tail.
            const subagent = ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null) !== null;
            const streamEvent = (
              msg as {
                event?: {
                  type?: string;
                  content_block?: { type?: string; name?: string };
                  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
                };
              }
            ).event;
            if (streamEvent?.type === 'message_start') {
              if (!subagent) {
                streamingText = '';
                streamingActive = true;
              }
              liveThinking = '';
              liveInputBytes = 0;
              liveToolName = undefined;
              live = { phase: 'responding', subagent };
            } else if (streamEvent?.type === 'content_block_start') {
              const block = streamEvent.content_block;
              liveThinking = '';
              liveInputBytes = 0;
              liveToolName = undefined;
              if (block?.type === 'thinking') live = { phase: 'thinking', subagent };
              else if (block?.type === 'tool_use') {
                liveToolName = block.name;
                live = { phase: 'tool-prep', toolName: liveToolName, subagent };
              } else if (block?.type === 'text') live = { phase: 'writing', subagent };
            } else if (streamEvent?.type === 'content_block_delta') {
              const delta = streamEvent.delta;
              if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                if (!subagent) {
                  streamingText += delta.text;
                  streamingActive = true;
                }
                live = { phase: 'writing', subagent };
              } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                liveThinking = (liveThinking + delta.thinking).slice(-200);
                live = { phase: 'thinking', thinkingPreview: liveThinking, subagent };
              } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                liveInputBytes += delta.partial_json.length;
                live = { phase: 'tool-prep', toolName: liveToolName, inputBytes: liveInputBytes, subagent };
              }
            }
            break;
          }
        }
        break;
      }
    }
  }

  if (streamingActive && streamingText) {
    items.push({ kind: 'streaming', key: 'streaming', text: streamingText });
  }

  return { items, live };
}

/**
 * Compact level: fold each agent turn (everything the agent produced between one
 * user prompt and the next boundary) into a single collapsible `agent-turn` item.
 * User prompts, session-init, and workflow dividers are boundaries that stay visible.
 * A lone agent item passes through un-wrapped (avoids chrome around a single answer).
 * The plan-review card is also a boundary so a pending plan is always presented
 * as its own item — exploration folds away, the plan stays visible.
 */
export function foldAgentTurns(items: TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  let buf: TranscriptItem[] = [];
  const emitFolded = (turn: TranscriptItem[]) => {
    if (turn.length === 0) return;
    if (turn.length === 1) out.push(turn[0]);
    else out.push({ kind: 'agent-turn', key: `t${turn[0].key}`, items: turn });
  };
  const flush = () => {
    if (buf.length === 0) return;
    // A turn's terminal answer (last assistant text not followed by a tool call) always shows
    // standalone — folding it away hides the analysis/conclusion. Scan from the end, skipping
    // trailing non-text items (e.g. result); stop at the first tool-group (then no answer).
    let splitIdx = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
      const it = buf[i];
      if (it.kind === 'tool-group') break;
      if (it.kind === 'assistant' && hasText(it)) {
        splitIdx = i;
        break;
      }
    }
    if (splitIdx >= 0) {
      const answer = buf[splitIdx] as Extract<TranscriptItem, { kind: 'assistant' }>;
      emitFolded(buf.filter((_, i) => i !== splitIdx));
      out.push({ ...answer, isAnswer: true });
    } else {
      emitFolded(buf);
    }
    buf = [];
  };
  for (const it of items) {
    const isBoundary =
      it.kind === 'user' ||
      it.kind === 'system-init' ||
      it.kind === 'workflow' ||
      (it.kind === 'permission' && it.data.toolName === 'ExitPlanMode');
    if (isBoundary) {
      flush();
      out.push(it);
    } else {
      buf.push(it);
    }
  }
  flush();
  return out;
}

/** True when an assistant item carries a non-empty text block (not thinking-only). */
function hasText(item: Extract<TranscriptItem, { kind: 'assistant' }>): boolean {
  return item.blocks.some((b) => b.type === 'text' && b.text.trim().length > 0);
}

/** The agent's own text, in order, across a folded turn — free (no LLM call). */
function turnNarration(items: TranscriptItem[]): string | null {
  const text = items
    .filter((i): i is Extract<TranscriptItem, { kind: 'assistant' }> => i.kind === 'assistant')
    .flatMap((a) => a.blocks)
    .filter((b): b is Extract<AssistantBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
  return text ? (text.length > 200 ? text.slice(0, 200) + '…' : text) : null;
}

/** Aggregate summary of what an agent did in a folded turn, for the collapsed header. */
export function turnToolStats(items: TranscriptItem[]): {
  /** 1-2 sentence LLM summary, once the server has produced it; null until then. */
  narrative: string | null;
  /** The agent's own text from the turn — free fallback when summaries are disabled/pending. */
  narration: string | null;
  /** Tool tally fallback, e.g. "8 actions · Read ×3, Edit ×2" — shown when neither is available. */
  summary: string | null;
  totals: { added: number; removed: number } | null;
  result?: { durationMs?: number; costUsd?: number };
} {
  const tools = items
    .filter((i): i is ToolGroupItem => i.kind === 'tool-group')
    .flatMap((g) => g.tools);
  const result = items.find((i): i is ResultItem => i.kind === 'result');
  const narrative = result?.summary ?? null;
  return {
    narrative,
    narration: turnNarration(items),
    summary: tools.length > 0 ? groupSummary(tools) : null,
    totals: groupDiffTotals(tools),
    result: result ? { durationMs: result.durationMs, costUsd: result.costUsd } : undefined,
  };
}

/** Compute before/after file contents for an edit-type tool call, for the Monaco diff. */
export function computeDiff(tool: ToolBlock): { filePath: string; before: string; after: string } | null {
  const input = tool.input;
  const filePath = String(input.file_path ?? input.notebook_path ?? '');

  if (tool.name === 'Write') {
    return {
      filePath,
      before: tool.snapshot?.before ?? '',
      after: String(input.content ?? ''),
    };
  }

  if (tool.name === 'Edit') {
    const oldStr = String(input.old_string ?? '');
    const newStr = String(input.new_string ?? '');
    const before = tool.snapshot?.before;
    if (before != null && before.includes(oldStr)) {
      const after = input.replace_all
        ? before.split(oldStr).join(newStr)
        : before.replace(oldStr, newStr);
      return { filePath, before, after };
    }
    // No snapshot — show the fragment-level diff.
    return { filePath, before: oldStr, after: newStr };
  }

  if (tool.name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
    let before = tool.snapshot?.before;
    if (before != null) {
      let after = before;
      for (const edit of edits) {
        const oldStr = String(edit.old_string ?? '');
        const newStr = String(edit.new_string ?? '');
        after = edit.replace_all ? after.split(oldStr).join(newStr) : after.replace(oldStr, newStr);
      }
      return { filePath, before, after };
    }
    return {
      filePath,
      before: edits.map((e) => String(e.old_string ?? '')).join('\n\n/* ... */\n\n'),
      after: edits.map((e) => String(e.new_string ?? '')).join('\n\n/* ... */\n\n'),
    };
  }

  return null;
}

export function isEditTool(name: string): boolean {
  return name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit';
}

/** Collapsed group header, e.g. "8 actions · Read ×3, Edit ×2, Bash ×3" (first-seen order). */
export function groupSummary(tools: ToolBlock[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const parts = [...counts.entries()].map(([name, n]) => `${name} ×${n}`);
  return `${tools.length} action${tools.length === 1 ? '' : 's'} · ${parts.join(', ')}`;
}

/** Aggregate +N/−N over edit tools in a group, or null if none. */
export function groupDiffTotals(tools: ToolBlock[]): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  let any = false;
  for (const t of tools) {
    if (!isEditTool(t.name)) continue;
    const d = computeDiff(t);
    if (!d) continue;
    const s = diffStats(d.before, d.after);
    added += s.added;
    removed += s.removed;
    any = true;
  }
  return any ? { added, removed } : null;
}

/** Rough +N/−N line stats for the compact diff card. */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  const beforeLines = new Set(before.split('\n'));
  const afterLines = new Set(after.split('\n'));
  let added = 0;
  let removed = 0;
  for (const line of afterLines) if (!beforeLines.has(line)) added++;
  for (const line of beforeLines) if (!afterLines.has(line)) removed++;
  return { added, removed };
}
