import type {
  Actor,
  Attachment,
  ContextCompactData,
  FileSnapshotData,
  PermissionRequestData,
  PromptMention,
  ProviderSwitchData,
  TranscriptEvent,
  TurnSummaryData,
  WorkflowMarkerData,
} from '@lines/shared';
import {
  isPlanFilePath,
  isRecoveringResult,
  isStoppedResult,
  resultErrorText,
  resultSpend,
  subagentParentId,
} from '@lines/shared';
import type { ResultSpendPayload } from '@lines/shared';

export interface ToolBlock {
  type: 'tool';
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  snapshot?: FileSnapshotData;
  /** Items built from messages whose `parent_tool_use_id` is this block's id — i.e.
   *  the transcript of the subagent this `Task` call spawned. */
  children?: TranscriptItem[];
  /** This call was backgrounded: its `system/task_started` / `task_notification`,
   *  matched to this block by `tool_use_id`. The card owns the state — no separate
   *  row is pushed when this is set. The tool's own `result` says nothing here: a
   *  backgrounded Agent gets "Async agent launched successfully" the instant it starts. */
  background?: { taskId: string; status: 'running' | 'completed' | 'failed' | 'stopped' };
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
  /** This turn's own cost: the billed delta, not the raw cumulative
   *  `total_cost_usd` the result carries (see shared/resultSpend.ts). */
  costUsd?: number;
  durationMs?: number;
  isError: boolean;
  /** The user stopped this turn. Mutually exclusive with `isError`: a stop arrives in
   *  the same shape as a failure, and the row reads neutrally rather than red. */
  stopped: boolean;
  /** This turn failed recoverably and the bridge is re-sending it. Same treatment
   *  as `stopped` — neutral row, no error body, no Retry — because the turn is
   *  still running; the row is only the durable record that an attempt was lost. */
  recovering: boolean;
  /** Why the turn failed, kept only for failures so the row can say so — from the
   *  result text, or from `errors[]` when the SDK carried no `result` at all. */
  error?: string;
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
  /** The subagent's type (`Task` input `subagent_type`), when its Task call is known. */
  subagentType?: string;
}

export type TranscriptItem =
  | {
      kind: 'user';
      key: string;
      text: string;
      source: 'user' | 'workflow';
      attachments?: Attachment[];
      mentions?: PromptMention[];
      /** Who sent it. Absent on every row written before sharing existed, and on
       *  the owner's own prompts — both read as the session's host. */
      actor?: Actor;
      /** ms epoch, for the hover detail on an authored bubble. */
      ts: number;
    }
  /** A queued prompt released into the running turn ("Send now"). Human-authored
   *  like `user`, but it opens no turn and is not a rewind anchor. */
  | {
      kind: 'interject';
      key: string;
      text: string;
      mentions?: PromptMention[];
      actor?: Actor;
      ts: number;
    }
  | { kind: 'assistant'; key: string; blocks: AssistantBlock[]; isAnswer?: boolean }
  | ToolGroupItem
  | AgentTurnItem
  | { kind: 'streaming'; key: string; text: string }
  /** Only pushed when the model differs from the previous init (see buildTranscript):
   *  the CLI restarts per turn, so an undeduped row would repeat every turn.
   *  `changed` marks a later one — a mid-session model switch, not a session start. */
  | { kind: 'system-init'; key: string; model: string; changed?: boolean }
  | ResultItem
  | { kind: 'permission'; key: string; data: PermissionRequestData; resolution?: 'allow' | 'deny' | 'expired' }
  | { kind: 'workflow'; key: string; data: WorkflowMarkerData }
  | ContextCompactItem
  | ProviderSwitchItem
  | TaskItem;

/**
 * One provider switch, with the hand-off prompt it seeded folded in.
 *
 * The seed really is a user turn on the wire — it is what the new model was
 * asked — but rendering it as one put a wall of generated summary in the middle
 * of the transcript, above the reply, as if the person had typed it. So the row
 * is the marker, and the text is behind a disclosure on it.
 */
export interface ProviderSwitchItem {
  kind: 'provider-switch';
  key: string;
  data: ProviderSwitchData;
  /** The seed prompt, when it has arrived. Absent for the moment between the
   *  marker and the prompt, and on a switch whose seed never landed. */
  handoff?: string;
}

/**
 * One background task (a backgrounded subagent or Bash command). `task_started`
 * opens it and `task_notification` resolves it in place — same idiom as the
 * compaction span above, so a task is one row rather than two.
 */
export interface TaskItem {
  kind: 'task';
  key: string;
  taskId: string;
  description: string;
  subagentType?: string;
  /** Set by the task's `task_notification`; absent while it is still running. */
  outcome?: { status: 'completed' | 'failed' | 'stopped'; summary: string };
}

/** One compaction. A 'requested' marker renders as "Compacting…" and is upgraded
 *  in place when its 'done' arrives, so a span is one line, not two. */
export interface ContextCompactItem {
  kind: 'context-compact';
  key: string;
  data: ContextCompactData;
}

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

/**
 * Tool-result strings, memoized per content object. buildTranscript re-runs from
 * scratch on every rebuild and a long session's results are most of its bytes,
 * so re-serializing them per pass was the bulk of the churn. Keyed on the SDK
 * content object, which lives in the event log and is never mutated.
 */
const contentStringCache = new WeakMap<object, string>();

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (typeof content !== 'object') return JSON.stringify(content, null, 2);
  const cached = contentStringCache.get(content);
  if (cached !== undefined) return cached;
  const out = Array.isArray(content)
    ? content.map((b: SdkContentBlock) => (b?.type === 'text' ? (b.text ?? '') : '')).join('')
    : JSON.stringify(content, null, 2);
  contentStringCache.set(content, out);
  return out;
}

/**
 * An ExitPlanMode request with no inline `plan` argument gets the text of the turn's
 * last plan-file write, resolved through computeDiff so an Edit-revised plan
 * reconstructs from its snapshot. A real inline plan always wins.
 *
 * The write's path also rides along as `planPath` whenever one is known — even when
 * the inline plan won the text — so the card can re-read the file and show the plan
 * as it stands now, not as it was captured.
 */
function withPlanFileText(
  data: PermissionRequestData,
  planWrite: ToolBlock | null,
): PermissionRequestData {
  if (data.toolName !== 'ExitPlanMode' || !planWrite) return data;
  const planPath = String(planWrite.input.file_path ?? planWrite.input.notebook_path ?? '');
  const input = planPath ? { ...data.input, planPath } : { ...data.input };
  if (String(data.input.plan ?? '').trim()) return { ...data, input };
  const text = computeDiff(planWrite)?.after ?? '';
  if (!text.trim()) return { ...data, input };
  return { ...data, input: { ...input, plan: text } };
}

/** A `result` that ended its turn in failure — the shape both the rendered result
 *  item and the compaction-span escape key off. A turn the user stopped is reported
 *  by the SDK in the same shape but is not a failure; the bridge's `stopped` stamp
 *  is what tells the two apart. A `recovering` stamp says the same thing for a
 *  different reason: the bridge is re-driving the turn, so it did not end here. */
function isFailedResult(r: {
  is_error?: boolean;
  subtype?: string;
  stopped?: unknown;
  recovering?: unknown;
}): boolean {
  if (isStoppedResult(r)) return false;
  if (isRecoveringResult(r)) return false;
  return Boolean(r.is_error) || (r.subtype != null && r.subtype !== 'success');
}

/** Where one agent's assistant output accumulates: the main transcript, or a
 *  subagent's slice of its parent Task block. */
interface Sink {
  items: TranscriptItem[];
  openGroup: ToolGroupItem | null;
  lastText: string;
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
 *
 * Subagent messages (`parent_tool_use_id` set) are routed into their `Task` block's
 * `children` instead of the top-level list, each parent getting its own item/group/text
 * state so parallel subagents can't merge into one group.
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
  // Last cumulative `total_cost_usd` read in this query lifetime. The field is
  // cumulative over the lifetime, so each card shows its delta against this —
  // the same rule `accumulateResultSpend` bills by (shared/resultSpend.ts).
  let costCumulative: number | undefined;
  let streamingText = '';
  let streamingActive = false;
  let live: LiveActivity | null = null;
  // Live-phase accumulators, reset when a new content block starts.
  let liveThinking = '';
  let liveInputBytes = 0;
  let liveToolName: string | undefined;
  // Per-agent assistant state. The main agent owns the top-level list; each subagent
  // gets its own sink writing into its Task block's children.
  const main: Sink = { items, openGroup: null, lastText: '' };
  const sinks = new Map<string, Sink>();
  const sinkFor = (parentId: string | null): Sink => {
    if (!parentId) return main;
    let sink = sinks.get(parentId);
    if (!sink) {
      const parent = toolBlocks.get(parentId);
      // Unknown parent (truncated transcript, compaction dropped the Task call):
      // fall back to the main list rather than lose the item.
      if (!parent) return main;
      parent.children ??= [];
      sink = { items: parent.children, openGroup: null, lastText: '' };
      sinks.set(parentId, sink);
    }
    return sink;
  };
  // The current harness passes no `plan` argument to ExitPlanMode — it writes the plan
  // to a file under .claude/plans/ instead. Keep the turn's last such write (the block,
  // not its text: its file snapshot can still be arriving) to stitch onto the card.
  let lastPlanWrite: ToolBlock | null = null;
  // Same tracking, never reset on a turn boundary: an ExitPlanMode that lands in a
  // later turn than the write still resolves to the session's plan instead of
  // rendering an empty card. Only consulted when the turn-scoped write is absent.
  let sessionPlanWrite: ToolBlock | null = null;
  /** Compaction whose 'done' hasn't landed yet, so it can be upgraded in place. */
  let openCompact: ContextCompactItem | null = null;
  /** A provider switch whose seed prompt has not arrived yet (see the case below). */
  let openSwitch: ProviderSwitchItem | null = null;
  /** The model the last `system`/`init` reported. The CLI process restarts for every
   *  turn (resumed by session id) and emits a fresh init each time, so an undeduped
   *  row says "session started" once per turn. Only a model change is news. */
  let lastInitModel: string | null = null;
  /** Unresolved background tasks by task_id — a map, not a single slot like
   *  openCompact, because tasks can overlap. The value is the launching tool card
   *  whenever the task named one (the common case), and a standalone `TaskItem`
   *  only for a genuine orphan. */
  const openTasks = new Map<string, TaskItem | ToolBlock>();

  /** Last snapshot of `file`, scanning back — no array copy per lookup. */
  const lastSnapshotFor = (file: string, unclaimedOnly: boolean): FileSnapshotData | undefined => {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const s = snapshots[i];
      if (s.filePath === file && (!unclaimedOnly || !s.toolUseId)) return s;
    }
    return undefined;
  };

  const attachSnapshot = (tool: ToolBlock) => {
    // Prefer exact tool_use_id match, fall back to file path (hook input ids can be absent).
    let snap = snapshots.find((s) => s.toolUseId && s.toolUseId === tool.id);
    if (!snap) {
      const file = String(tool.input.file_path ?? tool.input.notebook_path ?? '');
      snap = lastSnapshotFor(file, true) ?? lastSnapshotFor(file, false);
    }
    if (snap) tool.snapshot = snap;
  };

  for (const event of events) {
    // Every result advances the lifetime's cost reading, including one a
    // compaction span hides below — skipping it would fold the compaction's cost
    // into the next card's delta.
    let resultCostUsd: number | undefined;
    if (event.kind === 'sdk' && (event.data as { type?: string }).type === 'result') {
      const spend = resultSpend(event.data as ResultSpendPayload, costCumulative);
      if (spend) costCumulative = spend.cumulative;
      resultCostUsd = spend?.billed;
    }
    // Everything between a compaction's 'requested' and its 'done' belongs to the
    // compaction, not to the conversation: `/compact` rides ordinary prompt text,
    // so a CLI that doesn't dispatch it lets the model answer the literal string.
    // Mirrors the server's withoutCompactSpans, including its bound — the next
    // 'user' event closes an orphan span, so a crash mid-compaction can't swallow
    // the rest of the transcript.
    if (openCompact && event.kind !== 'context-compact') {
      // A failed `result` is the turn dying mid-compaction — the server has already
      // abandoned the span (the result is emitted before the abandon event that
      // would close it), so let it through rather than swallowing the only failure
      // row the Retry button can key off.
      const failed =
        event.kind === 'sdk' &&
        (event.data as { type?: string }).type === 'result' &&
        isFailedResult(event.data as { is_error?: boolean; subtype?: string });
      // Only 'user' closes an orphan span, never 'interject': the server refuses
      // to interject while `compacting` (see canInterject), so one cannot appear
      // inside a span in the first place. Do not "fix" this by adding it here.
      if (event.kind !== 'user' && !failed) continue;
      openCompact = null;
    }
    switch (event.kind) {
      case 'user': {
        if (openSwitch) {
          // Folded into the marker above instead of becoming a bubble of its own.
          openSwitch.handoff = (event.data as { text?: string }).text ?? '';
          openSwitch = null;
          break;
        }
        main.openGroup = null;
        main.lastText = '';
        sinks.clear();
        lastPlanWrite = null;
        const data = event.data as {
          text: string;
          source?: 'user' | 'workflow';
          attachments?: Attachment[];
          mentions?: PromptMention[];
          actor?: Actor;
        };
        items.push({
          kind: 'user',
          key: `u${event.seq}`,
          text: data.text,
          source: data.source ?? 'user',
          attachments: data.attachments,
          mentions: data.mentions,
          actor: data.actor,
          ts: event.ts,
        });
        break;
      }
      case 'interject': {
        // Written fresh, deliberately not a copy of the 'user' case's four resets.
        // The group is closed so the row lands between tool cards rather than
        // inside one — but the sinks stay open (clearing them would strand a live
        // subagent's remaining output inline instead of under its Task card, and
        // long subagent-heavy turns are exactly the ones people hurry along),
        // `main.lastText` stays (it is the next group's labelText), and
        // `lastPlanWrite` stays (an earlier plan write must still stitch onto a
        // later ExitPlanMode card).
        main.openGroup = null;
        const data = event.data as {
          text: string;
          mentions?: PromptMention[];
          actor?: Actor;
        };
        items.push({
          kind: 'interject',
          key: `i${event.seq}`,
          text: data.text,
          mentions: data.mentions,
          actor: data.actor,
          ts: event.ts,
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
          // Provenance rides the resolution event, not the request.
          if (data.resolvedBy) existing.data = { ...existing.data, resolvedBy: data.resolvedBy };
          if (data.answers) existing.data = { ...existing.data, answers: data.answers };
          // The deny reason arrives on the resolution event, not the request.
          if (data.denyMessage) existing.data = { ...existing.data, denyMessage: data.denyMessage };
        } else {
          const item: TranscriptItem = {
            kind: 'permission',
            key: `p${event.seq}`,
            data: withPlanFileText(data, lastPlanWrite ?? sessionPlanWrite),
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
        main.openGroup = null;
        main.lastText = '';
        sinks.clear();
        lastPlanWrite = null;
        items.push({ kind: 'workflow', key: `w${event.seq}`, data: event.data as WorkflowMarkerData });
        break;
      case 'context-compact': {
        const data = event.data as ContextCompactData;
        // An auto-compaction only ever emits 'done', so a 'done' with nothing open
        // stands on its own.
        if (data.phase === 'done' && openCompact) {
          openCompact.data = data;
          openCompact = null;
          break;
        }
        const item: ContextCompactItem = { kind: 'context-compact', key: `c${event.seq}`, data };
        openCompact = data.phase === 'requested' ? item : null;
        items.push(item);
        break;
      }
      case 'provider-switch': {
        // The same four resets a 'workflow' marker does: everything above this
        // line belongs to a conversation the model below it cannot see, so no
        // group, text or plan write may stitch across it.
        main.openGroup = null;
        main.lastText = '';
        sinks.clear();
        lastPlanWrite = null;
        const item: ProviderSwitchItem = {
          kind: 'provider-switch',
          key: `ps${event.seq}`,
          data: event.data as ProviderSwitchData,
        };
        // The next 'user' event is this switch's seed, and belongs to the marker
        // rather than to the conversation — the same span the server strips from
        // its turn scans (withoutProviderSwitchSpans).
        openSwitch = item;
        items.push(item);
        break;
      }
      case 'sdk': {
        const msg = event.data as Record<string, unknown> & { type: string };
        switch (msg.type) {
          case 'system': {
            const subtype = (msg as { subtype?: string }).subtype;
            if (subtype === 'init') {
              const model = String((msg as { model?: string }).model ?? '');
              // The first init opens the session; a later one is only worth a row
              // when the model actually moved (a same-provider setModel — a
              // cross-provider switch has its own marker).
              if (model !== lastInitModel) {
                items.push({
                  kind: 'system-init',
                  key: `s${event.seq}`,
                  model,
                  ...(lastInitModel !== null ? { changed: true } : {}),
                });
              }
              lastInitModel = model;
              break;
            }
            // Ambient/housekeeping tasks are hidden from the inline transcript on
            // the SDK's own instruction.
            if ((msg as { skip_transcript?: boolean }).skip_transcript) break;
            if (subtype === 'task_started') {
              const t = msg as {
                task_id?: string;
                description?: string;
                subagent_type?: string;
                tool_use_id?: string;
              };
              const taskId = String(t.task_id ?? '');
              // The launching `tool_use` block always precedes its task, so the card
              // is already built and can own the state — no second surface for the
              // same fact. A miss degrades to the standalone row below.
              const card = toolBlocks.get(String(t.tool_use_id ?? ''));
              if (card) {
                card.background = { taskId, status: 'running' };
                openTasks.set(taskId, card);
                break;
              }
              const item: TaskItem = {
                kind: 'task',
                key: `t${event.seq}`,
                taskId,
                description: String(t.description ?? ''),
                subagentType: t.subagent_type,
              };
              openTasks.set(taskId, item);
              items.push(item);
              break;
            }
            if (subtype === 'task_notification') {
              const t = msg as {
                task_id?: string;
                status?: 'completed' | 'failed' | 'stopped';
                summary?: string;
                tool_use_id?: string;
              };
              const taskId = String(t.task_id ?? '');
              const outcome = {
                status: t.status ?? 'completed',
                summary: String(t.summary ?? ''),
              } as const;
              // The second lookup matters: a backgrounded Bash can send a
              // notification with no `task_started` of its own.
              const open = openTasks.get(taskId) ?? toolBlocks.get(String(t.tool_use_id ?? ''));
              if (open) {
                if ('kind' in open) open.outcome = outcome;
                // The summary is deliberately dropped: it is either the verbatim
                // script the card already shows or its own description.
                else open.background = { taskId, status: outcome.status };
                openTasks.delete(taskId);
                break;
              }
              // Its `task_started` was skipped or truncated away and no tool block
              // claims it — a standalone resolved row beats dropping the only trace
              // the task left.
              items.push({
                kind: 'task',
                key: `t${event.seq}`,
                taskId,
                description: '',
                outcome,
              });
            }
            // task_progress / task_updated are too chatty for the inline transcript.
            break;
          }
          case 'assistant': {
            const sink = sinkFor(subagentParentId(msg));
            // A subagent's completed message says nothing about the main agent's
            // streaming tail, which is parked inside the Task tool.
            if (sink === main) {
              streamingText = '';
              streamingActive = false;
            }
            live = null;
            const message = (msg as { message?: { content?: SdkContentBlock[] } }).message;
            let pending: AssistantBlock[] = [];
            let flushCount = 0;
            const flush = () => {
              if (pending.length === 0) return;
              const key = flushCount === 0 ? `a${event.seq}` : `a${event.seq}.${flushCount}`;
              sink.items.push({ kind: 'assistant', key, blocks: pending });
              pending = [];
              flushCount++;
            };
            for (const block of message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                pending.push({ type: 'text', text: block.text });
                sink.lastText = block.text;
                sink.openGroup = null;
              } else if (block.type === 'thinking' && block.thinking) {
                pending.push({ type: 'thinking', text: block.thinking });
                sink.lastText = '';
                sink.openGroup = null;
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
                if (
                  isEditTool(tool.name) &&
                  isPlanFilePath(String(tool.input.file_path ?? tool.input.notebook_path ?? ''))
                ) {
                  // A revised plan resolves to the final write, matching the server's turn scan.
                  // Unscoped by agent: a Plan subagent's write must still stitch onto the
                  // main agent's ExitPlanMode card.
                  lastPlanWrite = tool;
                  sessionPlanWrite = tool;
                }
                // Full level (groupTools=false): each tool is its own 1-tool group,
                // which ToolGroup renders as a bare card — i.e. ungrouped. A question
                // takes the same path at every level: never buried in a group.
                const isolated = !groupTools || isQuestionTool(tool.name);
                if (isolated) sink.openGroup = null;
                if (!sink.openGroup) {
                  sink.openGroup = {
                    kind: 'tool-group',
                    key: `g${block.id}`,
                    tools: [],
                    labelText: sink.lastText ? sink.lastText.slice(0, 100) : undefined,
                  };
                  sink.items.push(sink.openGroup);
                }
                sink.openGroup.tools.push(tool);
                if (isolated) sink.openGroup = null;
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
            main.openGroup = null;
            main.lastText = '';
            sinks.clear();
            const r = msg as {
              duration_ms?: number;
              is_error?: boolean;
              subtype?: string;
              result?: unknown;
              errors?: unknown;
              stopped?: unknown;
              recovering?: unknown;
            };
            const isError = isFailedResult(r);
            const errorText = resultErrorText(r);
            const resultItem: ResultItem = {
              kind: 'result',
              key: `r${event.seq}`,
              costUsd: resultCostUsd,
              durationMs: r.duration_ms,
              isError,
              stopped: isStoppedResult(r),
              recovering: isRecoveringResult(r),
              // Only on failures: a successful turn's `result` is the assistant's
              // own final text, already rendered above.
              ...(isError && errorText ? { error: errorText } : {}),
            };
            resultItems.set(event.seq, resultItem);
            items.push(resultItem);
            break;
          }
          case 'stream_event': {
            // Subagent deltas (parent_tool_use_id set) drive `live` but must not
            // clobber the main agent's streaming tail.
            const parentId = subagentParentId(msg);
            const subagent = parentId !== null;
            // A backgrounded subagent's phase is not the foreground turn's phase. Letting it
            // drive `live` clobbers the main agent's row, and two background agents flip
            // between each other. Their progress lives in their own Task cards and in the
            // strip above the composer. If `task_started` hasn't landed yet this degrades to
            // today's behaviour, which is safe.
            if (parentId && toolBlocks.get(parentId)?.background) break;
            // The Task call names which agent this is, so the row can say "Explore: …".
            const type = parentId ? toolBlocks.get(parentId)?.input.subagent_type : undefined;
            const who = {
              subagent,
              subagentType: typeof type === 'string' && type ? type : undefined,
            };
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
              live = { phase: 'responding', ...who };
            } else if (streamEvent?.type === 'content_block_start') {
              const block = streamEvent.content_block;
              liveThinking = '';
              liveInputBytes = 0;
              liveToolName = undefined;
              if (block?.type === 'thinking') live = { phase: 'thinking', ...who };
              else if (block?.type === 'tool_use') {
                liveToolName = block.name;
                live = { phase: 'tool-prep', toolName: liveToolName, ...who };
              } else if (block?.type === 'text') live = { phase: 'writing', ...who };
            } else if (streamEvent?.type === 'content_block_delta') {
              const delta = streamEvent.delta;
              if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                if (!subagent) {
                  streamingText += delta.text;
                  streamingActive = true;
                }
                live = { phase: 'writing', ...who };
              } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                liveThinking = (liveThinking + delta.thinking).slice(-200);
                live = { phase: 'thinking', thinkingPreview: liveThinking, ...who };
              } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                liveInputBytes += delta.partial_json.length;
                live = { phase: 'tool-prep', toolName: liveToolName, inputBytes: liveInputBytes, ...who };
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
 * Structural sharing across rebuilds: every item in `next` that is content-equal
 * to its `prev` twin is replaced by the `prev` object, so an unchanged row keeps
 * its identity. Two things depend on that identity:
 *
 * - the memoized row components (`Item`, `AgentTurn`, `ToolGroup`, `ToolCallCard`)
 *   can only skip a subtree whose props are referentially equal;
 * - {@link toolDiffCache} is a WeakMap on `ToolBlock` objects, so a reused block
 *   keeps its computed diff instead of recomputing a whole-file diff per event.
 *
 * Neither can serve stale content: the equality checks below cover every field
 * buildTranscript writes *after* creating an item (tool `result`/`isError`/
 * `snapshot`/`children`, permission `resolution`/`data`, result `summary`,
 * streaming/assistant text), so a changed item is never reused.
 *
 * Returns `prev` itself when nothing moved, keeping the caller's memo stable too.
 */
export function reconcileItems(prev: TranscriptItem[], next: TranscriptItem[]): TranscriptItem[] {
  if (prev === next || prev.length === 0) return next;
  const byKey = new Map<string, TranscriptItem>();
  for (const it of prev) byKey.set(it.key, it);
  let unchanged = prev.length === next.length;
  const out = next.map((item, i) => {
    const old = byKey.get(item.key);
    const reused = old ? reuseItem(old, item) : item;
    if (reused !== prev[i]) unchanged = false;
    return reused;
  });
  return unchanged ? prev : out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Permission data is respread whenever a resolution lands (and for ExitPlanMode,
 * when the plan text is stitched in), so referential equality alone would never
 * reuse those rows. One level, plus `input` — a false negative here only costs a
 * re-render.
 */
function samePermissionData(a: PermissionRequestData, b: PermissionRequestData): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  for (const k of keys) {
    if (ra[k] === rb[k]) continue;
    if (k === 'input' && isRecord(ra[k]) && isRecord(rb[k]) && shallowEqual(ra[k], rb[k])) continue;
    return false;
  }
  return true;
}

/** The previous object when content-equal, else the fresh one (nested reuse applied). */
function reuseItem(old: TranscriptItem, next: TranscriptItem): TranscriptItem {
  if (old === next) return old;
  if (old.kind !== next.kind) return next;
  switch (next.kind) {
    case 'user': {
      const o = old as typeof next;
      // attachments/mentions/actor come straight off the event data, so they keep
      // their identity across rebuilds.
      return o.text === next.text &&
        o.source === next.source &&
        o.ts === next.ts &&
        o.attachments === next.attachments &&
        o.mentions === next.mentions &&
        o.actor === next.actor
        ? o
        : next;
    }
    case 'interject': {
      const o = old as typeof next;
      return o.text === next.text &&
        o.ts === next.ts &&
        o.mentions === next.mentions &&
        o.actor === next.actor
        ? o
        : next;
    }
    case 'assistant': {
      const o = old as typeof next;
      if (o.isAnswer !== next.isAnswer || o.blocks.length !== next.blocks.length) return next;
      for (let i = 0; i < next.blocks.length; i++) {
        if (o.blocks[i].type !== next.blocks[i].type || o.blocks[i].text !== next.blocks[i].text) {
          return next;
        }
      }
      return o;
    }
    case 'streaming':
      return (old as typeof next).text === next.text ? old : next;
    case 'system-init': {
      const o = old as typeof next;
      return o.model === next.model && o.changed === next.changed ? o : next;
    }
    case 'result': {
      const o = old as ResultItem;
      return o.costUsd === next.costUsd &&
        o.durationMs === next.durationMs &&
        o.isError === next.isError &&
        o.stopped === next.stopped &&
        o.recovering === next.recovering &&
        o.error === next.error &&
        o.summary === next.summary
        ? o
        : next;
    }
    case 'permission': {
      const o = old as typeof next;
      return o.resolution === next.resolution && samePermissionData(o.data, next.data) ? o : next;
    }
    case 'workflow':
      return (old as typeof next).data === next.data ? old : next;
    case 'context-compact':
      return (old as ContextCompactItem).data === next.data ? old : next;
    case 'provider-switch': {
      const o = old as ProviderSwitchItem;
      return o.data === next.data && o.handoff === next.handoff ? o : next;
    }
    case 'task': {
      const o = old as TaskItem;
      return o.description === next.description &&
        o.outcome?.status === next.outcome?.status &&
        o.outcome?.summary === next.outcome?.summary
        ? o
        : next;
    }
    case 'tool-group': {
      const o = old as ToolGroupItem;
      if (o.labelText !== next.labelText) return next;
      const tools = reuseTools(o.tools, next.tools);
      return tools === o.tools ? o : { ...next, tools };
    }
    case 'agent-turn': {
      const o = old as AgentTurnItem;
      const items = reconcileItems(o.items, next.items);
      return items === o.items ? o : { ...next, items };
    }
  }
}

function reuseTools(prev: ToolBlock[], next: ToolBlock[]): ToolBlock[] {
  const byId = new Map<string, ToolBlock>();
  for (const t of prev) byId.set(t.id, t);
  let unchanged = prev.length === next.length;
  const out = next.map((tool, i) => {
    const old = byId.get(tool.id);
    const reused = old ? reuseTool(old, tool) : tool;
    if (reused !== prev[i]) unchanged = false;
    return reused;
  });
  return unchanged ? prev : out;
}

function reuseTool(old: ToolBlock, next: ToolBlock): ToolBlock {
  if (old === next) return old;
  if (
    old.name !== next.name ||
    old.result !== next.result ||
    old.isError !== next.isError ||
    old.snapshot !== next.snapshot ||
    // A backgrounded call's status is the only field that moves once its result
    // has landed — without this the card would never leave `running` on a live
    // session, while reading correctly after a reload.
    old.background?.status !== next.background?.status ||
    old.background?.taskId !== next.background?.taskId
  ) {
    return next;
  }
  // Normally the same SDK block object; the shallow compare covers a tool_use with
  // no input at all, where buildTranscript substitutes a fresh `{}` each pass.
  if (old.input !== next.input && !shallowEqual(old.input, next.input)) return next;
  if (!old.children && !next.children) return old;
  if (!old.children || !next.children) return next;
  const children = reconcileItems(old.children, next.children);
  return children === old.children ? old : { ...next, children };
}

/**
 * Compact level: fold each agent turn (everything the agent produced between one
 * user prompt and the next boundary) into a single collapsible `agent-turn` item.
 * User prompts, session-init, and workflow dividers are boundaries that stay visible.
 * A lone agent item passes through un-wrapped (avoids chrome around a single answer).
 * The plan-review card is also a boundary so a pending plan is always presented
 * as its own item — exploration folds away, the plan stays visible. An
 * AskUserQuestion card gets the same treatment: the question and the answer are a
 * decision the reader comes back to, not a step inside a turn.
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
      // Not a turn boundary, but a rendering one: an interjection folded into the
      // agent-turn card above it would appear to have happened before itself.
      it.kind === 'interject' ||
      it.kind === 'system-init' ||
      it.kind === 'workflow' ||
      it.kind === 'context-compact' ||
      it.kind === 'provider-switch' ||
      (it.kind === 'permission' && it.data.toolName === 'ExitPlanMode') ||
      // An MCP authorization request is the same kind of thing: the turn cannot
      // continue until the user acts on it, so it must not fold away.
      (it.kind === 'permission' && !!it.data.elicitation && !it.resolution) ||
      (it.kind === 'tool-group' && it.tools.length === 1 && isQuestionTool(it.tools[0].name));
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

/**
 * Index of the top-level item that renders the transcript event at `seq`, or -1.
 *
 * Read off the keys buildTranscript already derives from seqs (`u12`, `a12`,
 * `a12.1`, `i12`, `r12`, `p12`) rather than a seq field on every item: a new
 * field would have to be threaded through reconcileItems' equality checks to
 * keep rows referentially stable. Tool cards are keyed by tool-use id instead,
 * so a hit inside a tool call carries `toolUseId`. Nested items — a folded
 * turn's children, a subagent's transcript under its Task card — count as the
 * top-level item that contains them, since that is what is on screen.
 */
export function findItemIndexForSeq(items: TranscriptItem[], seq: number, toolUseId?: string): number {
  const direct = new Set([`u${seq}`, `i${seq}`, `a${seq}`, `r${seq}`, `p${seq}`]);
  const assistantPrefix = `a${seq}.`;
  const contains = (item: TranscriptItem): boolean => {
    if (direct.has(item.key) || item.key.startsWith(assistantPrefix)) return true;
    if (item.kind === 'agent-turn') return item.items.some(contains);
    if (item.kind === 'tool-group') {
      return item.tools.some(
        (tool) => (toolUseId !== undefined && tool.id === toolUseId) || !!tool.children?.some(contains),
      );
    }
    return false;
  };
  return items.findIndex(contains);
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

/** Its own card, its own turn boundary — a question is a decision, not a step. */
export function isQuestionTool(name: string): boolean {
  return name === 'AskUserQuestion';
}

export interface ToolDiff {
  diff: { filePath: string; before: string; after: string };
  stats: { added: number; removed: number };
}

/**
 * Diff + line stats for one edit tool call, memoized per ToolBlock. The same
 * block is asked for its diff several times per commit — the card, its group's
 * +N/−N total, and the folded turn's total — and every one of those recomputes
 * a whole-file diff. Keyed on the object: {@link reconcileItems} hands an
 * unchanged block back across rebuilds so the entry survives, and a block whose
 * `input` or `snapshot` moved is never reused — so this can't serve a stale diff.
 */
const toolDiffCache = new WeakMap<ToolBlock, ToolDiff | null>();

export function toolDiff(tool: ToolBlock): ToolDiff | null {
  const cached = toolDiffCache.get(tool);
  if (cached !== undefined) return cached;
  const diff = isEditTool(tool.name) ? computeDiff(tool) : null;
  const entry = diff ? { diff, stats: diffStats(diff.before, diff.after) } : null;
  toolDiffCache.set(tool, entry);
  return entry;
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
    const entry = toolDiff(t);
    if (!entry) continue;
    added += entry.stats.added;
    removed += entry.stats.removed;
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
