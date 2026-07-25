import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Project-wide file-name search backing the composer's `@mention` file provider.
 * The candidate list is built once per root and cached briefly, because the
 * autocomplete re-queries on every keystroke.
 */

/** Never worth walking (or offering) for a mention search. */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
]);

/** Hard ceiling on the candidate list, so a huge tree can't stall the bridge. */
const MAX_FILES = 20_000;
const CACHE_TTL_MS = 10_000;

const cache = new Map<string, { at: number; files: string[] }>();

/** Tracked + untracked-but-not-ignored paths, or null when `root` isn't a git repo. */
function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, maxBuffer: 32 << 20 },
    );
    return out.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

/** Depth-first walk used when the root isn't a repo; bounded by {@link MAX_FILES}. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (d.name.startsWith('.') || IGNORE_DIRS.has(d.name)) continue;
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) stack.push(child);
      else if (d.isFile()) out.push(child);
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}

function candidates(root: string): string[] {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.files;
  const files = (gitFiles(root) ?? walkFiles(root))
    .filter((f) => !f.split('/').some((seg) => IGNORE_DIRS.has(seg)))
    .slice(0, MAX_FILES);
  cache.set(root, { at: Date.now(), files });
  return files;
}

/** Do the query's characters appear in order in `text`? (fuzzy fallback, e.g. `mntinpt`). */
function isSubsequence(text: string, query: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === query[i] && ++i === query.length) return true;
  }
  return false;
}

/**
 * Lower is better; null means no match. Basename prefix beats basename substring
 * beats a hit anywhere in the path, with a loose subsequence match last — so
 * `@types` puts `shared/types.ts` above `web/src/lib/prettyTypes.ts`.
 */
function score(rel: string, query: string): number | null {
  const lower = rel.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  const inBase = base.indexOf(query);
  if (inBase === 0) return 0;
  if (inBase > 0) return 1;
  if (lower.includes(query)) return 2;
  return isSubsequence(lower, query) ? 3 : null;
}

/** The best `limit` matches for `query`, as paths relative to `root`. */
export function searchFiles(root: string, query: string, limit: number): string[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const scored: { rel: string; rank: number }[] = [];
  for (const rel of candidates(root)) {
    const rank = score(rel, q);
    if (rank !== null) scored.push({ rel, rank });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel),
  );
  return scored.slice(0, limit).map((s) => s.rel);
}
