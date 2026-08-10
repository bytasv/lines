import {
  IconClockPlay,
  IconCloud,
  IconFilePencil,
  IconGitBranch,
  IconGitFork,
  IconMessageChatbot,
  IconRobot,
  IconRoute,
  IconSearch,
  IconSettings,
  IconShieldQuestion,
  type Icon,
} from '@tabler/icons-react';
import { permissionModeLabel } from './permissionModes';

/**
 * The tool that spawns a subagent. The harness names it `Agent`; the SDK's own
 * types and docs call it `Task`, and persisted transcripts contain both — so
 * every consumer matches on this, never on one literal.
 */
export function isAgentTool(name: string): boolean {
  return name === 'Agent' || name === 'Task';
}

/** An `Agent`/`Task` tool input, parsed. Every optional field is absent when malformed. */
export interface TaskCall {
  description: string;
  prompt: string;
  subagentType?: string;
  model?: string;
  background: boolean;
  name?: string;
  mode?: string;
  isolation?: string;
}

/** Chars of the prompt's first line used when `description` is missing. */
const FALLBACK_DESCRIPTION_CAP = 80;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Parses a `Task` input defensively. Tool inputs reach the web verbatim — the
 * SDK's `AgentInput` field set drifts (the live `effort` flag isn't in the typed
 * shape yet), and a persisted event can be malformed — so nothing is coerced:
 * a non-string `description` is dropped rather than stringified into
 * `[object Object]`. Never throws.
 */
export function parseTaskInput(input: Record<string, unknown>): TaskCall {
  const prompt = str(input.prompt) ?? '';
  let description = str(input.description)?.trim() ?? '';
  // Compacted transcripts can lose `description`; the prompt's first line is the
  // closest thing to a title, and an empty header row is worse than a truncated one.
  if (!description && prompt) {
    const first = prompt.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
    description =
      first.length > FALLBACK_DESCRIPTION_CAP
        ? first.slice(0, FALLBACK_DESCRIPTION_CAP) + '…'
        : first;
  }
  return {
    description,
    prompt,
    subagentType: str(input.subagent_type),
    model: str(input.model),
    background: input.run_in_background === true,
    name: str(input.name),
    mode: str(input.mode),
    isolation: str(input.isolation),
  };
}

/** Badge identity for a subagent type. */
export interface AgentMeta {
  label: string;
  color: string;
  icon: Icon;
}

/**
 * The one colour an agent badge ever uses. The transcript's palette is semantic —
 * blue is a plain tool, teal an edit, red an error — so violet belongs to agents
 * alone: a Task row is identifiable as a subagent run by colour before any text is
 * read, and it matches the `.tx-task` container accent. Agent *types* are told apart
 * by icon, never by colour.
 */
const AGENT_COLOR = 'violet';

/** Unmapped and missing types both land here. */
const DEFAULT_META: AgentMeta = { label: 'Agent', color: AGENT_COLOR, icon: IconRobot };

/**
 * The session's own agent. Same glyph as a subagent, its own colour — depth reads by
 * colour: blue is the agent you are talking to, violet is one it spawned.
 */
export const MAIN_AGENT_META: AgentMeta = { label: 'Claude', color: 'blue', icon: IconRobot };

/**
 * Known agent types, keyed lowercase. Deliberately small: `subagent_type` is a
 * free-form, user- and plugin-defined string, so this map can never be complete —
 * {@link agentMeta} degrades gracefully instead.
 */
const AGENT_META: Record<string, AgentMeta> = {
  explore: { label: 'Explore', color: AGENT_COLOR, icon: IconSearch },
  plan: { label: 'Plan', color: AGENT_COLOR, icon: IconRoute },
  'general-purpose': { label: 'General purpose', color: AGENT_COLOR, icon: IconMessageChatbot },
  'statusline-setup': { label: 'Statusline', color: AGENT_COLOR, icon: IconSettings },
  'output-style-setup': { label: 'Output style', color: AGENT_COLOR, icon: IconSettings },
  fork: { label: 'Fork', color: AGENT_COLOR, icon: IconGitFork },
};

/** Chars of an unmapped type kept as the badge label. */
const LABEL_CAP = 24;

/**
 * The single source of truth for how an agent is named and coloured — used by both
 * the settled Task card and the live `ActivityRow`, so a running agent and the card
 * that replaces it read identically.
 */
export function agentMeta(subagentType?: string): AgentMeta {
  const raw = typeof subagentType === 'string' ? subagentType.trim() : '';
  if (!raw) return DEFAULT_META;
  const hit = AGENT_META[raw.toLowerCase()];
  if (hit) return hit;
  // Plugin-scoped types (`caveman:cavecrew-builder`): retry on the segment after the
  // last colon, and keep that segment as the label — the plugin prefix is noise in a
  // narrow row. Identifiers are shown as written, never title-cased.
  const segment = raw.slice(raw.lastIndexOf(':') + 1).trim() || raw;
  const segmentHit = AGENT_META[segment.toLowerCase()];
  if (segmentHit) return segmentHit;
  return {
    ...DEFAULT_META,
    label: segment.length > LABEL_CAP ? segment.slice(0, LABEL_CAP) + '…' : segment,
  };
}

/** A glanceable option on a Task call, rendered as a tooltipped icon. */
export interface TaskFlag {
  key: string;
  icon: Icon;
  label: string;
  color?: string;
}

function modeIcon(mode: string): Icon {
  switch (mode) {
    case 'plan':
      return IconRoute;
    case 'acceptEdits':
      return IconFilePencil;
    case 'bypassPermissions':
      return IconShieldQuestion;
    default:
      return IconSettings;
  }
}

/**
 * The non-default options on a Task call. Only present flags are emitted, so a
 * plain `Task(description, prompt, subagent_type)` adds no row density at all.
 * `model` and `name` are deliberately absent — they carry a value no icon can
 * convey and render as text chips instead.
 */
export function taskFlags(call: TaskCall): TaskFlag[] {
  const flags: TaskFlag[] = [];
  if (call.background) {
    flags.push({ key: 'background', icon: IconClockPlay, label: 'Runs in the background' });
  }
  if (call.isolation === 'worktree') {
    flags.push({
      key: 'isolation',
      icon: IconGitBranch,
      label: 'Isolated in a temporary git worktree',
    });
  } else if (call.isolation === 'remote') {
    flags.push({ key: 'isolation', icon: IconCloud, label: 'Runs in a remote environment' });
  }
  if (call.mode && call.mode !== 'default') {
    flags.push({
      key: 'mode',
      icon: modeIcon(call.mode),
      label: `Permission mode: ${permissionModeLabel(call.mode)}`,
      color: call.mode === 'bypassPermissions' ? 'red' : undefined,
    });
  }
  return flags;
}
