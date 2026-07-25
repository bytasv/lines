import {
  IconFile,
  IconPuzzle,
  type Icon,
} from '@tabler/icons-react';
import type { PromptMention } from '@lines/shared';
import { fetchTree, fileBase, searchFiles } from './files';
import { withAuthToken } from '../ws';

/**
 * A mention candidate as offered in the autocomplete popover. Extends the
 * display-only {@link PromptMention} with the agent-facing `expansion` text,
 * which the composer bakes into the prompt on send (never sent as sidecar data).
 */
export interface MentionCandidate extends PromptMention {
  expansion: string;
}

/**
 * A committed mention pinned to the `[start, end)` span of the prompt text it
 * renders as an inline pill for — the span covers the display token
 * (`@Model selector`), excluding the trailing space. The text stays
 * authoritative; ranges are a derived view {@link remapRanges} realigns on every
 * edit. Sorted and non-overlapping.
 */
export interface MentionRange extends MentionCandidate {
  start: number;
  end: number;
}

/** Prompt text plus the mention ranges painted over it — the composer's draft state. */
export interface MentionValue {
  text: string;
  ranges: MentionRange[];
}

/**
 * A source of mentionable entities for one `kind`. New kinds slot in by adding a
 * provider object to {@link mentionProviders} plus a {@link mentionKindMeta}
 * entry — there is no switch-over-kind anywhere else in the codebase.
 */
export interface MentionProvider {
  kind: string; // 'feature'
  kindLabel: string; // 'Feature'
  search(query: string, ctx: { cwd: string }): Promise<MentionCandidate[]>;
}

/** Per-kind display metadata for inline pills and transcript badges. */
export const mentionKindMeta: Record<string, { label: string; color: string; icon: Icon }> = {
  feature: { label: 'Feature', color: 'grape', icon: IconPuzzle },
  file: { label: 'File', color: 'blue', icon: IconFile },
};

const MAX_PER_KIND = 8;

// ---------------------------------------------------------------------------
// Token helpers (pure, DOM-free — a testable seam if a runner is added later)
// ---------------------------------------------------------------------------

/**
 * Find the `@mention` token the caret currently sits in, or null. Scans back
 * from the caret to the nearest `@` that starts a token (preceded by whitespace
 * or start-of-text, so emails like `a@b` don't trigger). The token body allows
 * word characters plus `/.-_` (paths, ids); whitespace ends it. Committed
 * mention ranges are inert — a caret inside one, or an `@` belonging to one,
 * never reopens the popover.
 */
export function findMentionToken(
  text: string,
  caret: number,
  ranges: MentionRange[] = [],
): { start: number; query: string } | null {
  if (ranges.some((r) => caret > r.start && caret < r.end)) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') {
      // The '@' of a committed pill (caret parked right after it) isn't a token.
      if (ranges.some((r) => i >= r.start && i < r.end)) return null;
      const before = i === 0 ? '' : text[i - 1];
      if (before === '' || /\s/.test(before)) {
        return { start: i, query: text.slice(i + 1, caret) };
      }
      return null; // '@' not at a token boundary (e.g. email)
    }
    if (/[\s]/.test(ch)) return null; // whitespace before any '@' — no token
    i--;
  }
  return null;
}

/**
 * Describe the single contiguous edit between two textarea values as
 * `{ start, removed, inserted }` (common-prefix / common-suffix diff). One input
 * event is always one contiguous edit, which is what makes {@link remapRanges}
 * sufficient — paste and cut go through the same path.
 */
export function diffEdit(
  prev: string,
  next: string,
): { start: number; removed: number; inserted: number } {
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  return { start, removed: endPrev - start, inserted: endNext - start };
}

/**
 * Shift mention ranges across one contiguous edit. Ranges wholly before the edit
 * are untouched, ranges after it slide by the length delta, and a range the edit
 * cuts into is dropped — its text stays but degrades to plain text, which is the
 * safe failure mode (never a range pointing at the wrong characters).
 */
export function remapRanges(
  ranges: MentionRange[],
  editStart: number,
  removed: number,
  inserted: number,
): MentionRange[] {
  const editEnd = editStart + removed;
  const delta = inserted - removed;
  const out: MentionRange[] = [];
  for (const r of ranges) {
    if (r.end <= editStart) out.push(r);
    else if (r.start >= editEnd) out.push({ ...r, start: r.start + delta, end: r.end + delta });
    // else: the edit intersects the token — dissolve it
  }
  return out;
}

/**
 * Push a collapsed caret out of any mention range — pills are atomic, so the caret
 * may rest at either edge but never between their glyphs. The previous caret gives
 * the direction of travel: leftward motion lands before the pill, rightward after
 * it, and a jump in from outside (a click) snaps to the nearer edge.
 */
export function snapCaretOut(caret: number, ranges: MentionRange[], prevCaret: number): number {
  const hit = ranges.find((r) => caret > r.start && caret < r.end);
  if (!hit) return caret;
  if (prevCaret >= hit.end) return hit.start;
  if (prevCaret <= hit.start) return hit.end;
  return caret - hit.start < hit.end - caret ? hit.start : hit.end;
}

/**
 * Collapse repeated mentions of the same entity (legal inline — the same pill can
 * appear twice in a sentence) to one entry, keeping first-seen order.
 */
export function uniqueMentions<T extends PromptMention>(mentions: T[]): T[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const key = `${m.kind}:${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Append the agent-facing expansion block for the given mentions to the prompt
 * text. Returns `text` unchanged when there are no mentions.
 */
export function buildExpandedPrompt(text: string, mentions: MentionCandidate[]): string {
  if (mentions.length === 0) return text;
  const body = uniqueMentions(mentions)
    .map((m) => m.expansion)
    .join('\n\n');
  const header =
    'Referenced by the user via @mentions (docs may be stale; source is authoritative):';
  return `${text}\n\n---\n${header}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Feature provider — sourced from docs/codebase/index.json
// ---------------------------------------------------------------------------

interface FeatureEntry {
  id: string;
  name: string;
  doc?: string;
  purpose?: string;
  entryPoints?: string[];
}

interface FeatureIndex {
  version?: number;
  features?: FeatureEntry[];
}

const FEATURE_TTL_MS = 30_000;
/** Per-cwd cache; a null value marks "no manifest here" so we don't refetch per keystroke. */
const featureCache = new Map<string, { at: number; features: FeatureEntry[] | null }>();

async function loadFeatures(cwd: string): Promise<FeatureEntry[] | null> {
  const cached = featureCache.get(cwd);
  if (cached && Date.now() - cached.at < FEATURE_TTL_MS) return cached.features;
  let features: FeatureEntry[] | null = null;
  try {
    const path = `${cwd}/docs/codebase/index.json`;
    const res = await fetch(withAuthToken(`${fileBase}/file?path=${encodeURIComponent(path)}`));
    if (res.ok) {
      const data = (await res.json()) as { content?: string };
      const parsed = JSON.parse(data.content ?? '') as FeatureIndex;
      features = Array.isArray(parsed.features) ? parsed.features : [];
    }
  } catch {
    features = null; // parse error / too large / offline — kind silently absent
  }
  featureCache.set(cwd, { at: Date.now(), features });
  return features;
}

function featureExpansion(f: FeatureEntry): string {
  const lines = [`- Feature "${f.name}" (${f.id})`];
  if (f.doc) lines.push(`  Doc: docs/codebase/${f.doc}`);
  if (f.purpose) lines.push(`  Purpose: ${f.purpose}`);
  if (f.entryPoints?.length) lines.push(`  Entry points: ${f.entryPoints.slice(0, 5).join(', ')}`);
  return lines.join('\n');
}

const featureProvider: MentionProvider = {
  kind: 'feature',
  kindLabel: 'Feature',
  async search(query, { cwd }) {
    const features = await loadFeatures(cwd);
    if (!features) return [];
    const q = query.toLowerCase();
    return features
      .filter(
        (f) =>
          !q ||
          f.name.toLowerCase().includes(q) ||
          f.id.toLowerCase().includes(q) ||
          (f.purpose ?? '').toLowerCase().includes(q),
      )
      .slice(0, MAX_PER_KIND)
      .map((f) => ({
        kind: 'feature',
        id: f.id,
        label: f.name,
        detail: f.purpose,
        expansion: featureExpansion(f),
      }));
  },
};

// ---------------------------------------------------------------------------
// File provider — browse one directory (/tree), or search the project (/find)
// ---------------------------------------------------------------------------

function fileCandidate(rel: string, isDir = false): MentionCandidate {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return {
    kind: 'file',
    id: rel,
    label: isDir ? `${name}/` : name,
    detail: rel,
    // A dir selection drills down (handled in MentionInput); its expansion is
    // unused because dirs are never committed as mentions.
    expansion: `- File: ${rel}`,
  };
}

/** List one directory relative to `cwd` — the browse mode behind `@` and `@dir/`. */
async function browseDir(cwd: string, dirPart: string): Promise<MentionCandidate[]> {
  try {
    const entries = await fetchTree(dirPart ? `${cwd}/${dirPart}` : cwd);
    return entries
      .slice(0, MAX_PER_KIND)
      .map((e) => fileCandidate(dirPart ? `${dirPart}/${e.name}` : e.name, e.type === 'dir'));
  } catch {
    return [];
  }
}

const fileProvider: MentionProvider = {
  kind: 'file',
  kindLabel: 'File',
  async search(query, { cwd }) {
    // A bare '@' or a trailing '/' means "show me what's in here" — keep browsing
    // by directory so drilling down still works. Anything else is a name search
    // across the whole project, so `@types` finds `shared/types.ts`.
    if (query === '' || query.endsWith('/')) return browseDir(cwd, query.replace(/\/$/, ''));
    try {
      const files = await searchFiles(cwd, query, MAX_PER_KIND);
      return files.map((rel) => fileCandidate(rel));
    } catch {
      return [];
    }
  },
};

export const mentionProviders: MentionProvider[] = [featureProvider, fileProvider];
