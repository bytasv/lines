import type {
  FileSnapshotData,
  PermissionRequestData,
  TranscriptEvent,
  WorkflowMarkerData,
} from '@claude-ui/shared';

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
  | { type: 'thinking'; text: string }
  | ToolBlock;

export type TranscriptItem =
  | { kind: 'user'; key: string; text: string; source: 'user' | 'workflow' }
  | { kind: 'assistant'; key: string; blocks: AssistantBlock[] }
  | { kind: 'streaming'; key: string; text: string }
  | { kind: 'system-init'; key: string; model: string }
  | { kind: 'result'; key: string; costUsd?: number; durationMs?: number; isError: boolean }
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
 */
export function buildTranscript(events: TranscriptEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolBlocks = new Map<string, ToolBlock>();
  const snapshots: FileSnapshotData[] = [];
  const permissionItems = new Map<string, { kind: 'permission' } & TranscriptItem>();
  let streamingText = '';
  let streamingActive = false;

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
        const data = event.data as { text: string; source?: 'user' | 'workflow' };
        items.push({
          kind: 'user',
          key: `u${event.seq}`,
          text: data.text,
          source: data.source ?? 'user',
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
      case 'workflow':
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
            const message = (msg as { message?: { content?: SdkContentBlock[] } }).message;
            const blocks: AssistantBlock[] = [];
            for (const block of message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                blocks.push({ type: 'text', text: block.text });
              } else if (block.type === 'thinking' && block.thinking) {
                blocks.push({ type: 'thinking', text: block.thinking });
              } else if (block.type === 'tool_use' && block.id && block.name) {
                const tool: ToolBlock = {
                  type: 'tool',
                  id: block.id,
                  name: block.name,
                  input: block.input ?? {},
                };
                toolBlocks.set(block.id, tool);
                attachSnapshot(tool);
                blocks.push(tool);
              }
            }
            if (blocks.length > 0) {
              items.push({ kind: 'assistant', key: `a${event.seq}`, blocks });
            }
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
            const r = msg as { total_cost_usd?: number; duration_ms?: number; is_error?: boolean; subtype?: string };
            items.push({
              kind: 'result',
              key: `r${event.seq}`,
              costUsd: r.total_cost_usd,
              durationMs: r.duration_ms,
              isError: Boolean(r.is_error) || (r.subtype != null && r.subtype !== 'success'),
            });
            break;
          }
          case 'stream_event': {
            const streamEvent = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
            if (streamEvent?.type === 'message_start') {
              streamingText = '';
              streamingActive = true;
            } else if (
              streamEvent?.type === 'content_block_delta' &&
              streamEvent.delta?.type === 'text_delta' &&
              typeof streamEvent.delta.text === 'string'
            ) {
              streamingText += streamEvent.delta.text;
              streamingActive = true;
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

  return items;
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
