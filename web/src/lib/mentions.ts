import {
  IconFile,
  IconPuzzle,
  type Icon,
} from '@tabler/icons-react';
import type { MentionCandidate, MentionRange, PromptMention } from '@lines/shared';
import { fetchTree, searchFiles } from './files';
import { loadFeatures, type FeatureEntry } from './features';

// The draft types live in shared/types.ts — a queued prompt persists a
// MentionValue so it stays re-editable, so they cross the wire. Re-exported here
// because this module is where every composer already imports them from.
export type { MentionCandidate, MentionRange, MentionValue } from '@lines/shared';

/**
 * A source of mentionable entities for one `kind`. New kinds slot in by adding a
 * provider object to {@link mentionProviders} plus a {@link mentionKindMeta}
 * entry — there is no switch-over-kind anywhere else in the codebase.
 */
export interface MentionProvider {
  kind: string; // 'feature'
  kindLabel: string; // 'Feature'
  /** `cwd` is the session's directory (the project's primary root); `roots` is every root it spans, primary first. */
  search(query: string, ctx: { cwd: string; roots: string[] }): Promise<MentionCandidate[]>;
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

/**
 * List one directory relative to `cwd` — the browse mode behind `@` and `@dir/`.
 * An absolute `dirPart` is used as-is, which is what makes drilling into an extra
 * root (offered as an absolute candidate below) work.
 */
async function browseDir(cwd: string, dirPart: string): Promise<MentionCandidate[]> {
  try {
    const base = dirPart.startsWith('/') ? dirPart : dirPart ? `${cwd}/${dirPart}` : cwd;
    const entries = await fetchTree(base);
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
  async search(query, { cwd, roots }) {
    // A bare '@' or a trailing '/' means "show me what's in here" — keep browsing
    // by directory so drilling down still works. Anything else is a name search
    // across every root, so `@types` finds `shared/types.ts`.
    if (query === '' || query.endsWith('/')) {
      const dirPart = query.replace(/\/$/, '');
      const entries = await browseDir(cwd, dirPart);
      // Top level of a multi-root project: lead with the extra roots as drill-in
      // dirs, since browsing only ever shows the cwd's own children otherwise.
      const extras =
        dirPart === '' && roots.length > 1 ? roots.slice(1).map((r) => fileCandidate(r, true)) : [];
      return [...extras, ...entries];
    }
    try {
      const files = await searchFiles(roots, query, MAX_PER_KIND);
      // The agent's cwd is the primary root, so a hit anywhere else needs an
      // absolute reference to be unambiguous; primary hits keep the bare relative
      // path, leaving single-root output exactly as it was.
      return files.map(({ root, rel }) => fileCandidate(root === roots[0] ? rel : `${root}/${rel}`));
    } catch {
      return [];
    }
  },
};

export const mentionProviders: MentionProvider[] = [featureProvider, fileProvider];
