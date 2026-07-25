import {
  IconFile,
  IconPuzzle,
  type Icon,
} from '@tabler/icons-react';
import type { PromptMention } from '@lines/shared';
import { fetchTree, fileBase } from './files';
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
 * A source of mentionable entities for one `kind`. New kinds slot in by adding a
 * provider object to {@link mentionProviders} plus a {@link mentionKindMeta}
 * entry — there is no switch-over-kind anywhere else in the codebase.
 */
export interface MentionProvider {
  kind: string; // 'feature'
  kindLabel: string; // 'Feature'
  search(query: string, ctx: { cwd: string }): Promise<MentionCandidate[]>;
}

/** Per-kind display metadata for chips and transcript badges. */
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
 * word characters plus `/.-_` (paths, ids); whitespace ends it.
 */
export function findMentionToken(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') {
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
 * Append the agent-facing expansion block for the given mentions to the prompt
 * text. Returns `text` unchanged when there are no mentions.
 */
export function buildExpandedPrompt(text: string, mentions: MentionCandidate[]): string {
  if (mentions.length === 0) return text;
  const body = mentions.map((m) => m.expansion).join('\n\n');
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
// File provider — path-segment completion via the /tree endpoint
// ---------------------------------------------------------------------------

const fileProvider: MentionProvider = {
  kind: 'file',
  kindLabel: 'File',
  async search(query, { cwd }) {
    // Split the query at the last '/': everything before it is the directory to
    // list (relative to cwd), the remainder filters that dir's entries.
    const slash = query.lastIndexOf('/');
    const dirPart = slash >= 0 ? query.slice(0, slash) : '';
    const namePart = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase();
    const dir = dirPart ? `${cwd}/${dirPart}` : cwd;
    let entries;
    try {
      entries = await fetchTree(dir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.name.toLowerCase().includes(namePart))
      .slice(0, MAX_PER_KIND)
      .map((e) => {
        const rel = dirPart ? `${dirPart}/${e.name}` : e.name;
        const isDir = e.type === 'dir';
        return {
          kind: 'file',
          id: rel,
          label: isDir ? `${e.name}/` : e.name,
          detail: rel,
          // A dir selection drills down (handled in the composer); its expansion
          // is unused because dirs aren't committed as mentions.
          expansion: `- File: ${rel}`,
        };
      });
  },
};

export const mentionProviders: MentionProvider[] = [featureProvider, fileProvider];
