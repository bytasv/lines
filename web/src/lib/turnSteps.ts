import type { ToolBlock, ToolGroupItem, TranscriptItem } from './transcript.ts';
import { groupSummary } from './transcript.ts';
import { toolSummary } from './toolFields.ts';
import { humanizeToolName, mcpProvider, parseMcpToolName } from './mcpTools.ts';

/**
 * One row of a folded turn's checklist (Compact level): a stretch of the turn
 * that began with a piece of narration, or with a tool call when the agent said
 * nothing first. Inferred from the turn's own structure — agents here don't
 * write todo lists by default — so there are no pending future steps, only
 * what happened. A turn where the agent did keep a task list (TaskCreate /
 * TaskUpdate) shows those tasks instead, planned ones included.
 */
export interface TurnStep {
  kind: 'step';
  /** The step's first item's key: stable while later items are appended. */
  key: string;
  label: string;
  /** `pending` only for a task the agent has listed but not finished. */
  status: 'done' | 'active' | 'failed' | 'pending';
  /** The step's detail, rendered when the row is expanded. */
  items: TranscriptItem[];
  /** Top-level tool calls in the step, for the tally and the diff totals. */
  tools: ToolBlock[];
  /** The MCP server of the step's first tool, when the label names that call: its logo leads the label. */
  mcpServer?: string;
}

/**
 * An item that never hides inside a step: something the user has to act on (a
 * pending permission), or the record of a turn that ended badly — the only
 * mount point for Retry.
 */
export interface TurnPassthrough {
  kind: 'passthrough';
  item: TranscriptItem;
}

export type TurnEntry = TurnStep | TurnPassthrough;

/** Label cap, in characters. */
const LABEL_CAP = 80;
/** A narration label shorter than this (in words) loses to the tool summary. */
const MIN_LABEL_WORDS = 3;

/** Openers that carry no information about the step ("Now let me check…"). */
const LEAD_IN = /^(?:(?:now|next|then|ok(?:ay)?|great|good|first|alright|so)\b[,:]?\s*|(?:let me|let's|i'll|i will|i'm going to|i need to|i am going to)\s+)/i;

function isPassthrough(item: TranscriptItem): boolean {
  // Live text is never folded away (foldAgentTurns normally keeps it out of the card).
  if (item.kind === 'interject' || item.kind === 'streaming') return true;
  if (item.kind === 'permission') return !item.resolution;
  if (item.kind === 'result') return true;
  return false;
}

/**
 * A successful result: it renders nothing inside a turn card (the last row
 * carries its cost and time), so it gets no entry at all — not a step of its
 * own, and not an empty passthrough slot that would add a gap as the turn ends.
 */
function isQuietResult(item: TranscriptItem): boolean {
  return item.kind === 'result' && !item.isError && !item.stopped && !item.recovering;
}

function assistantText(item: Extract<TranscriptItem, { kind: 'assistant' }>): string {
  return item.blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Inline markdown reduced to its visible text. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]*?\S)\1/g, '$2')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '');
}

/**
 * A step label from narration: the first sentence, markdown stripped, lead-ins
 * dropped, capped. Null when what remains is too thin to say anything.
 */
export function narrationLabel(text: string): string | null {
  const plain = stripMarkdown(text);
  const firstLine = plain.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  // Sentence end: punctuation followed by whitespace, so `foo.ts` stays whole.
  let sentence = firstLine.split(/(?<=[.!?:])\s+/, 1)[0].trim();
  let prev: string;
  do {
    prev = sentence;
    sentence = sentence.replace(LEAD_IN, '');
  } while (sentence !== prev);
  sentence = sentence.replace(/[.:]+$/, '').trim();
  if (sentence.split(/\s+/).filter(Boolean).length < MIN_LABEL_WORDS) return null;
  sentence = sentence[0].toUpperCase() + sentence.slice(1);
  return sentence.length > LABEL_CAP ? sentence.slice(0, LABEL_CAP - 1).trimEnd() + '…' : sentence;
}

/** The spawn tool; mirrors `isAgentTool` in agents.ts, which pulls in JSX and so
 *  can't be imported where this module is unit-tested (the server's node runner). */
function isSpawnTool(name: string): boolean {
  return name === 'Agent' || name === 'Task';
}

/** A subagent spawn's title: its `description`, else its prompt's first line. */
function spawnLabel(tool: ToolBlock): string | null {
  const { description, prompt } = tool.input ?? {};
  if (typeof description === 'string' && description.trim()) return description.trim();
  if (typeof prompt === 'string') {
    const first = prompt.split('\n').find((l) => l.trim() !== '')?.trim();
    if (first) return first.length > LABEL_CAP ? first.slice(0, LABEL_CAP - 1) + '…' : first;
  }
  return null;
}

/** Verb for a tool whose input names a file or a pattern, so the label reads as a phrase. */
const TOOL_VERBS: Record<string, string> = {
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  Grep: 'Search for',
  Glob: 'Find',
  WebFetch: 'Fetch',
  WebSearch: 'Search the web for',
};

function capped(text: string): string {
  return text.length > LABEL_CAP ? text.slice(0, LABEL_CAP - 1).trimEnd() + '…' : text;
}

function toolLabel(tools: ToolBlock[]): string | null {
  const first = tools[0];
  if (!first) return null;
  if (isSpawnTool(first.name)) {
    const label = spawnLabel(first);
    if (label) return label;
  }
  // The agent's own words for the call (Bash's `description`) beat any rendering of its input.
  const description = str(first.input?.description);
  if (description) return capped(description[0].toUpperCase() + description.slice(1));
  const path = str(first.input?.file_path) ?? str(first.input?.notebook_path);
  const verb = TOOL_VERBS[first.name];
  if (verb && path) return `${verb} ${path.split('/').pop()}`;
  const target = str(first.input?.pattern) ?? str(first.input?.query) ?? str(first.input?.url);
  if (verb && target) return capped(`${verb} ${target}`);
  // `cd <repo> && …` is how agents open most shell calls; the rest says what it does.
  const summary = toolSummary(first).replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '');
  // An MCP call reads `Linear · Create issue <summary>`, not its raw `mcp__linear__create_issue`.
  const mcp = parseMcpToolName(first.name);
  if (mcp) {
    const title = `${mcpProvider(mcp.server).label} · ${humanizeToolName(mcp.tool)}`;
    return capped(summary ? `${title} ${summary}` : title);
  }
  return summary ? `${first.name} ${summary}` : groupSummary(tools);
}

/**
 * The MCP server whose logo leads a step's label: set only when the label is
 * the first tool's own (no narration), and that tool is an MCP call.
 */
function labelServer(tools: ToolBlock[]): string | undefined {
  const first = tools[0];
  if (!first || str(first.input?.description)) return undefined;
  return parseMcpToolName(first.name)?.server;
}

interface Draft {
  items: TranscriptItem[];
  tools: ToolBlock[];
  narration: string | null;
  /** The raw narration, for when neither it nor a tool makes a good label. */
  rawNarration: string | null;
  /** Opened by narration, so it takes every tool call until the next narration. */
  narrated: boolean;
}

/**
 * Sub-groups cut from a merged group, cached on their first tool so a rebuild
 * that didn't touch the run hands back the same object and the memoized
 * ToolGroup underneath skips re-rendering. Tool blocks keep their identity
 * across rebuilds (reconcileItems), so the cache survives them too.
 */
const runCache = new WeakMap<ToolBlock, ToolGroupItem>();

/** `group` split into runs of consecutive calls to the same tool. */
function toolRuns(group: ToolGroupItem): ToolGroupItem[] {
  const runs: ToolBlock[][] = [];
  for (const t of group.tools) {
    const last = runs[runs.length - 1];
    if (last && last[0].name === t.name) last.push(t);
    else runs.push([t]);
  }
  if (runs.length <= 1) return [group];
  return runs.map((tools) => {
    const cached = runCache.get(tools[0]);
    if (cached && cached.tools.length === tools.length && cached.tools.every((t, i) => t === tools[i])) {
      return cached;
    }
    // Keyed like buildTranscript keys a group, by its first tool-use id.
    const run: ToolGroupItem = { kind: 'tool-group', key: `g${tools[0].id}`, tools };
    runCache.set(tools[0], run);
    return run;
  });
}

/** A step a following tool call joins: one opened by narration, or one with no tools yet. */
function takesTools(d: Draft | null): d is Draft {
  return !!d && (d.narrated || d.tools.length === 0);
}

/**
 * Steps inferred from a run of turn items, with passthrough items interleaved
 * where they occurred. `live`: the run is the live end of a running turn, so its
 * last step can be `active`.
 */
function inferSteps(items: TranscriptItem[], live: boolean): TurnEntry[] {
  const out: (Draft | TurnPassthrough)[] = [];
  let cur: Draft | null = null;
  const open = (): Draft => {
    const d: Draft = { items: [], tools: [], narration: null, rawNarration: null, narrated: false };
    out.push(d);
    return d;
  };

  for (const item of items) {
    if (isQuietResult(item)) continue;
    if (isPassthrough(item)) {
      out.push({ kind: 'passthrough', item });
      continue;
    }
    if (item.kind === 'assistant') {
      const text = assistantText(item);
      if (text) {
        const d = (cur = open());
        d.items.push(item);
        d.narration = narrationLabel(text);
        d.rawNarration = text;
        d.narrated = true;
        continue;
      }
      // Thinking-only: leads into the next silent call, else part of the current step.
      (cur = takesTools(cur) ? cur : open()).items.push(item);
      continue;
    }
    if (item.kind === 'tool-group') {
      if (cur?.narrated) {
        cur.items.push(item);
        cur.tools.push(...item.tools);
        continue;
      }
      // Silent calls (no narration since the last step): buildTranscript has already
      // merged them into one group, so a turn that never narrates would be a single
      // row. Each run of the same tool is a step of its own instead.
      for (const run of toolRuns(item)) {
        const d = (cur = takesTools(cur) ? cur : open());
        d.items.push(run);
        d.tools.push(...run.tools);
      }
      continue;
    }
    (cur ??= open()).items.push(item);
  }

  let lastStep = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (!('kind' in out[i])) {
      lastStep = i;
      break;
    }
  }

  return out.map((entry, i): TurnEntry => {
    if ('kind' in entry) return entry;
    const failed = entry.tools.some((t) => t.isError);
    // The last step of a live turn stays active even between tool calls: the next
    // call usually lands in it, and a done→active flicker per call reads as noise.
    const status = failed ? 'failed' : live && i === lastStep ? 'active' : 'done';
    const fromTool = entry.narration ? null : toolLabel(entry.tools);
    const label =
      entry.narration ??
      fromTool ??
      (entry.rawNarration ? stripMarkdown(entry.rawNarration).trim().slice(0, LABEL_CAP) : null) ??
      'Thinking';
    const mcpServer = fromTool ? labelServer(entry.tools) : undefined;
    return {
      kind: 'step',
      key: entry.items[0].key,
      label,
      status,
      items: entry.items,
      tools: entry.tools,
      ...(mcpServer ? { mcpServer } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// The agent's own task list (TaskCreate / TaskUpdate)

/** One task in the agent's list, as of some point in the transcript. */
export interface TaskState {
  /** The CLI's task id (`Task #3 created…`), or `?<tool id>` until the create call returns. */
  id: string;
  /** Tool-use id of the TaskCreate call: stable even while `id` is provisional. */
  createdBy: string;
  subject: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);

function isTaskTool(name: string): boolean {
  return TASK_TOOLS.has(name);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Applies one task-tool call to `tasks` (mutated; ordered by creation).
 * Returns the task an update moved, if any.
 */
function applyTaskCall(tasks: TaskState[], tool: ToolBlock): { id: string; status?: string } | null {
  if (tool.isError) return null;
  if (tool.name === 'TaskCreate') {
    const subject = str(tool.input.subject);
    if (!subject) return null;
    const id = /^Task #(\S+) created/.exec(tool.result ?? '')?.[1] ?? `?${tool.id}`;
    tasks.push({ id, createdBy: tool.id, subject, activeForm: str(tool.input.activeForm), status: 'pending' });
    return null;
  }
  if (tool.name !== 'TaskUpdate') return null;
  const id = str(tool.input.taskId)?.replace(/^#/, '');
  const i = id ? tasks.findIndex((t) => t.id === id) : -1;
  if (i < 0) return null;
  const status = tool.input.status;
  if (status === 'deleted') {
    tasks.splice(i, 1);
    return { id: id!, status: 'deleted' };
  }
  const prev = tasks[i];
  tasks[i] = {
    ...prev,
    subject: str(tool.input.subject) ?? prev.subject,
    activeForm: str(tool.input.activeForm) ?? prev.activeForm,
    status: status === 'pending' || status === 'in_progress' || status === 'completed' ? status : prev.status,
  };
  return { id: id!, status: typeof status === 'string' ? status : undefined };
}

function taskCalls(item: TranscriptItem): ToolBlock[] {
  return item.kind === 'tool-group' ? item.tools.filter((t) => isTaskTool(t.name)) : [];
}

function sameTasks(a: readonly TaskState[], b: readonly TaskState[]): boolean {
  return (
    a.length === b.length &&
    a.every((t, i) => {
      const u = b[i];
      return (
        t.id === u.id &&
        t.createdBy === u.createdBy &&
        t.subject === u.subject &&
        t.activeForm === u.activeForm &&
        t.status === u.status
      );
    })
  );
}

/**
 * The open tasks (not completed) each folded turn starts with, keyed by the
 * turn's key — the list carries across turns, so a turn can finish what an
 * earlier one planned. Turns that start with none are absent. An entry equal
 * to the one in `prev` is handed back as-is, so a memoized row sees no change.
 */
export function taskCarries(
  items: TranscriptItem[],
  prev?: ReadonlyMap<string, readonly TaskState[]>,
): Map<string, readonly TaskState[]> {
  const out = new Map<string, readonly TaskState[]>();
  const tasks: TaskState[] = [];
  const apply = (item: TranscriptItem) => {
    for (const t of taskCalls(item)) applyTaskCall(tasks, t);
  };
  for (const item of items) {
    if (item.kind !== 'agent-turn') {
      apply(item);
      continue;
    }
    const open = tasks.filter((t) => t.status !== 'completed');
    if (open.length > 0) {
      const old = prev?.get(item.key);
      out.set(item.key, old && sameTasks(old, open) ? old : open);
    }
    for (const child of item.items) apply(child);
    // Completed tasks never carry; dropping them keeps the walk short.
    for (let i = tasks.length - 1; i >= 0; i--) if (tasks[i].status === 'completed') tasks.splice(i, 1);
  }
  return out;
}

interface Bucket {
  items: TranscriptItem[];
  tools: ToolBlock[];
}

/**
 * A turn the agent kept a task list in: one row per task (open ones carried in
 * from earlier turns, then the ones created here), each holding the work done
 * while it was in progress. Work before the first task starts, and after the
 * last one ends, keeps its inferred steps above and below the list. Passthrough
 * items follow the list.
 */
function taskSteps(items: TranscriptItem[], live: boolean, carry: readonly TaskState[]): TurnEntry[] {
  const tasks: TaskState[] = carry.map((t) => ({ ...t }));
  const buckets = new Map<string, Bucket>();
  const before: TranscriptItem[] = [];
  const after: TranscriptItem[] = [];
  const passthrough: TranscriptItem[] = [];
  let owner: string | null = tasks.find((t) => t.status === 'in_progress')?.createdBy ?? null;
  let started = owner !== null;

  const push = (item: TranscriptItem, tools: ToolBlock[]) => {
    if (owner) {
      let b = buckets.get(owner);
      if (!b) buckets.set(owner, (b = { items: [], tools: [] }));
      b.items.push(item);
      b.tools.push(...tools);
    } else {
      (started ? after : before).push(item);
    }
  };

  for (const item of items) {
    if (isQuietResult(item)) continue;
    if (isPassthrough(item)) {
      passthrough.push(item);
      continue;
    }
    if (item.kind !== 'tool-group') {
      push(item, []);
      continue;
    }
    for (const run of toolRuns(item)) {
      if (!isTaskTool(run.tools[0].name)) {
        push(run, run.tools);
        continue;
      }
      // The bookkeeping calls themselves are the list; they get no row of their own.
      for (const t of run.tools) {
        const moved = applyTaskCall(tasks, t);
        if (!moved) continue;
        const task = tasks.find((x) => x.id === moved.id);
        if (moved.status === 'in_progress' && task) {
          owner = task.createdBy;
          started = true;
        } else if (owner && (!task || task.createdBy === owner) && moved.status !== 'pending') {
          owner = null;
        }
      }
    }
  }

  const out: TurnEntry[] = [];
  // Work before any task started is still live only while no task has.
  out.push(...inferSteps(before, live && !started));
  for (const task of tasks) {
    const b = buckets.get(task.createdBy) ?? { items: [], tools: [] };
    const status: TurnStep['status'] =
      task.status === 'completed' ? 'done' : task.status === 'in_progress' && live ? 'active' : 'pending';
    out.push({
      kind: 'step',
      key: `k${task.createdBy}`,
      label: status === 'active' && task.activeForm ? task.activeForm : task.subject,
      status,
      items: b.items,
      tools: b.tools,
    });
  }
  out.push(...inferSteps(after, live && owner === null));
  for (const item of passthrough) out.push({ kind: 'passthrough', item });
  return out;
}

/**
 * Splits a folded turn's items into checklist entries. `live` is whether the
 * turn is still running: only then can a step be `active`. `carry` is the task
 * list the turn started with ({@link taskCarries}); when the turn itself makes a
 * task call, the rows are those tasks, otherwise steps are inferred.
 */
export function turnSteps(items: TranscriptItem[], live: boolean, carry: readonly TaskState[] = []): TurnEntry[] {
  return items.some((i) => taskCalls(i).length > 0) ? taskSteps(items, live, carry) : inferSteps(items, live);
}
