import type { ToolBlock } from './transcript';

/**
 * Cap on any single rendered value. Tool inputs are unbounded — a Task prompt is
 * routinely multi-kB — and an uncapped Code block is a first-paint stall.
 */
export const BODY_CAP = 6000;

/** Strings longer than this, or spanning lines, get their own code block. */
const INLINE_CAP = 200;

export type FieldKind = 'primary' | 'code' | 'path' | 'text' | 'json';

/** One renderable line of a tool call's input. */
export interface ToolField {
  /** The input key, unchanged — also the React key. */
  key: string;
  label: string;
  value: string;
  kind: FieldKind;
}

/**
 * The key that names the call, in priority order — the same priority the
 * collapsed row's one-liner uses, so the expanded body leads with the text the
 * row already showed.
 */
const PRIMARY_KEYS = ['command', 'file_path', 'pattern', 'url', 'description'];

/** Keys whose value is a filesystem path: monospace, never prose. */
const PATH_KEY = /(^|_)(path|cwd|dir)$/;

function cap(value: string): string {
  return value.length > BODY_CAP ? value.slice(0, BODY_CAP) + '\n…(truncated)' : value;
}

function humanize(key: string): string {
  return key.replace(/_/g, ' ');
}

function classify(key: string, raw: unknown): ToolField | null {
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null;
    const kind: FieldKind =
      raw.includes('\n') || raw.length > INLINE_CAP ? 'code' : PATH_KEY.test(key) ? 'path' : 'text';
    return { key, label: humanize(key), value: cap(raw), kind };
  }
  if (typeof raw === 'boolean' || typeof raw === 'number') {
    return { key, label: humanize(key), value: String(raw), kind: 'text' };
  }
  // Objects and arrays collapse to a single JSON field rather than expanding into
  // a nested list — an MCP tool's input can be arbitrarily deep.
  if (raw !== null && typeof raw === 'object') {
    const json = JSON.stringify(raw, null, 2);
    if (!json || json === '{}' || json === '[]') return null;
    return { key, label: humanize(key), value: cap(json), kind: 'json' };
  }
  return null;
}

/**
 * An opaque tool input as an ordered, renderable field list — the structured
 * replacement for dumping `JSON.stringify(input)` into the card body. Input
 * shapes are free-form (they reach the web verbatim from the SDK), so every
 * field is typeof-guarded and anything unclassifiable degrades to `json`.
 */
export function toolFields(tool: ToolBlock): ToolField[] {
  const input = tool.input ?? {};
  const fields: ToolField[] = [];
  let primaryKey: string | undefined;

  for (const key of PRIMARY_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      primaryKey = key;
      fields.push({ key, label: humanize(key), value: cap(value), kind: 'primary' });
      break;
    }
  }

  for (const [key, raw] of Object.entries(input)) {
    if (key === primaryKey) continue;
    const field = classify(key, raw);
    if (field) fields.push(field);
  }

  return fields;
}

/** Chars of the collapsed row's one-liner. */
const SUMMARY_CAP = 120;

function truncate(text: string): string {
  return text.length > SUMMARY_CAP ? text.slice(0, SUMMARY_CAP) + '…' : text;
}

/** An `AskUserQuestion` call is named by what it asked, not by its input shape. */
function questionSummary(input: Record<string, unknown>): string | null {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const first = questions.find(
    (q): q is { question: string } =>
      typeof (q as { question?: unknown })?.question === 'string' &&
      (q as { question: string }).question.trim() !== '',
  )?.question;
  if (!first) return null;
  return questions.length > 1 ? `${first} (+${questions.length - 1} more)` : first;
}

/**
 * The one-liner beside a collapsed row's badge. Built from the first field rather
 * than falling back to `JSON.stringify(input)`: plenty of tools have none of the
 * primary keys (`ToolSearch`, every MCP tool), and a serialized input in a
 * prose-width row is unreadable noise. Empty is better than braces — the badge
 * still names the call.
 */
export function toolSummary(tool: ToolBlock): string {
  const asked = tool.name === 'AskUserQuestion' ? questionSummary(tool.input) : null;
  if (asked) return truncate(asked);
  // Never a serialized object here — that is the noise this replaces. When every
  // field is structured (most MCP tools), the key names alone say more.
  const first = toolFields(tool).find((f) => f.kind !== 'json');
  if (!first) {
    const keys = Object.keys(tool.input ?? {});
    return keys.length > 0 ? truncate(keys.join(', ')) : '';
  }
  const text = (first.kind === 'primary' ? first.value : `${first.label}: ${first.value}`).trim();
  // Multi-line values (a heredoc command, a Write body) only ever show their first
  // line here; the expanded body carries the rest.
  const line = text.split('\n', 1)[0].trim();
  return truncate(line.length < text.length ? `${line} …` : line);
}

/**
 * The answers an `AskUserQuestion` call came back with, in question order.
 *
 * Its result is prose, not JSON — `Your questions have been answered: "Q"="A", …` —
 * and a question's own text can contain unescaped quotes, so only the answer side of
 * each `"…"="…"` pair is matched. Multi-select answers arrive comma-joined.
 */
export function parseQuestionAnswers(result?: string): string[] {
  if (!result) return [];
  return [...result.matchAll(/="([^"]*)"/g)].map((m) => m[1]);
}

/**
 * Which option labels an answer picked. A multi-select answer is comma-joined, but a
 * single label can itself contain a comma ("Restyle all tools, not just Task") — so
 * splitting on the separator is wrong. Labels are matched longest-first and removed
 * as they hit; whatever text survives was typed into "Other…".
 */
export function matchAnswerToOptions(
  answer: string,
  labels: string[],
): { picked: string[]; custom: string[] } {
  let rest = answer;
  const picked: string[] = [];
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    if (!label) continue;
    const at = rest.indexOf(label);
    if (at === -1) continue;
    picked.push(label);
    rest = rest.slice(0, at) + rest.slice(at + label.length);
  }
  const leftover = rest.replace(/[,\s]+/g, ' ').trim();
  return { picked, custom: leftover ? [leftover] : [] };
}
