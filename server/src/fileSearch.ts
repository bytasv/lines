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

/** One root's candidate paths, plus which of them git would ignore. */
export interface Candidates {
  files: string[];
  ignored: Set<string>;
}

const cache = new Map<string, { at: number } & Candidates>();

function run(root: string, args: string[]): string[] {
  const out = execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
    maxBuffer: 32 << 20,
  });
  return out.split('\n').filter(Boolean);
}

/**
 * Every path git knows about under `root` — tracked and untracked alike — or
 * null when `root` isn't a git repo.
 *
 * Deliberately *not* `--exclude-standard`: a gitignored file is still a file you
 * open, and `.env` or `.claude/settings.local.json` being unfindable was the
 * whole complaint. {@link IGNORE_DIRS} is what keeps the flood out, and it is
 * also what the non-repo walk uses, so both paths offer the same set.
 *
 * It is pushed down into git as pathspecs rather than left to the filter below
 * purely for speed: without it this repo streams 66k paths (~0.4s) to keep a few
 * hundred, and the autocomplete re-queries on every keystroke.
 *
 * Which of them are ignored is the same listing run again *with* the flag: what
 * the unfiltered pass has and the filtered one doesn't is exactly the ignored
 * set. Two cheap spawns beat one `check-ignore` round trip per candidate.
 */
function gitFiles(root: string): Candidates | null {
  const excludes = [...IGNORE_DIRS].map((dir) => `:(exclude,glob)**/${dir}/**`);
  try {
    const files = run(root, ['ls-files', '--cached', '--others', '--', ...excludes]);
    const kept = new Set(
      run(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...excludes]),
    );
    return { files, ignored: new Set(files.filter((f) => !kept.has(f))) };
  } catch {
    return null;
  }
}

/**
 * Depth-first walk used when the root isn't a repo; bounded by {@link MAX_FILES}.
 *
 * Dot-files and dot-directories are candidates like any other — an editor shows
 * `.github/` and `.env.example`, and the git path here has always listed them,
 * so hiding them only outside a repo was an inconsistency, not a policy.
 * {@link IGNORE_DIRS} (which covers `.git`) is the whole exclusion list.
 */
function walkFiles(root: string): Candidates {
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
      if (IGNORE_DIRS.has(d.name)) continue;
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) stack.push(child);
      else if (d.isFile()) out.push(child);
      if (out.length >= MAX_FILES) break;
    }
  }
  // Outside a repo there is no ignore file to consult, so nothing is ignored.
  return { files: out, ignored: new Set() };
}

/**
 * Every file worth searching under `root`, cached briefly. Shared with the
 * content search (contentSearch.ts), so find-in-files and quick-open agree on
 * what a project's files are and on which of them are ignored.
 */
export function candidates(root: string): Candidates {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  const found = gitFiles(root) ?? walkFiles(root);
  const usable = found.files.filter((f) => !f.split('/').some((seg) => IGNORE_DIRS.has(seg)));
  // The cap keeps the files people actually work in: non-ignored first, ignored
  // after. Git lists paths sorted, so an ignored `.cache/` holding a few hundred
  // thousand paths sorts ahead of `src/` and used to fill the whole cap on its own
  // — and with "Hide ignored" on, quick-open and find-in-files then found nothing.
  const files = [
    ...usable.filter((f) => !found.ignored.has(f)),
    ...usable.filter((f) => found.ignored.has(f)),
  ].slice(0, MAX_FILES);
  const result = { files, ignored: found.ignored };
  cache.set(root, { at: Date.now(), ...result });
  return result;
}

/**
 * A typed query is normalized before it is matched: spaces are how people type a
 * name they remember as two words (`mention input`), and a backslash is how they
 * type a path on Windows. Neither ever appears in a candidate, so keeping them
 * would just mean "no results".
 */
function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\\/g, '/').replace(/\s+/g, '');
}

/** Does the match at `i` start a word — a path/name segment, or a camelCase hump? */
function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (prev === '/' || prev === '-' || prev === '_' || prev === '.' || prev === ' ') return true;
  return text[i] !== text[i].toLowerCase() && prev === prev.toLowerCase();
}

/**
 * Where the query's characters appear in order in `lower` (e.g. `mntinpt`), and
 * how good that match is. Null means no match.
 *
 * Two greedy passes: forward to find the end of the earliest full match, then
 * backward from that end to pull the start as far right as it goes, which is
 * what makes the reported span tight rather than merely leftmost. `original` is
 * the same text with its case intact, needed to see camelCase humps.
 *
 * Quality is lower-is-better: one point per character skipped inside the span,
 * two per match that lands mid-word. So a tight match wins, and among similar
 * spans the one aligned to word starts wins.
 */
function subsequenceMatch(
  lower: string,
  original: string,
  query: string,
): { first: number; quality: number } | null {
  let qi = 0;
  let end = -1;
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === query[qi] && ++qi === query.length) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let qj = query.length - 1;
  let start = end;
  let boundaries = 0;
  for (let i = end; i >= 0; i--) {
    if (lower[i] !== query[qj]) continue;
    start = i;
    if (isBoundary(original, i)) boundaries++;
    if (qj-- === 0) break;
  }
  const gap = end - start + 1 - query.length;
  return { first: start, quality: gap + (query.length - boundaries) * 2 };
}

type Score = { rank: number; quality: number; first: number };

/**
 * Lower is better; null means no match. Basename prefix beats basename substring
 * beats a hit anywhere in the path — so `@types` puts `shared/types.ts` above
 * `web/src/lib/prettyTypes.ts`. Below those, a subsequence match in the basename
 * beats one smeared across the whole path, so `mntinpt` prefers a file actually
 * named that over one whose *directories* happen to spell it.
 *
 * The three substring tiers stay flat (quality and first pinned to 0): their
 * order is the documented path-length one and must not shift.
 */
function score(rel: string, query: string): Score | null {
  const lower = rel.toLowerCase();
  const cut = lower.lastIndexOf('/') + 1;
  const base = lower.slice(cut);
  const inBase = base.indexOf(query);
  if (inBase === 0) return { rank: 0, quality: 0, first: 0 };
  if (inBase > 0) return { rank: 1, quality: 0, first: 0 };
  if (lower.includes(query)) return { rank: 2, quality: 0, first: 0 };
  const inBaseFuzzy = subsequenceMatch(base, rel.slice(cut), query);
  if (inBaseFuzzy) return { rank: 3, ...inBaseFuzzy };
  const inPathFuzzy = subsequenceMatch(lower, rel, query);
  return inPathFuzzy ? { rank: 4, ...inPathFuzzy } : null;
}

/**
 * The best `limit` matches for `query` across every root, each hit carrying the
 * root it was found under. Ranking is global, not per-root, so a strong match in
 * the second project still outranks a weak one in the first. When roots nest,
 * the same file can surface under both — the first (better-ranked) hit wins.
 *
 * Gitignored files are left out unless `includeIgnored` says otherwise: `.env`
 * and build output are noise in the `@mention` menu, and the file palette's
 * "Hide ignored" toggle is the one caller that ever asks for them.
 */
export function searchFilesAcross(
  roots: string[],
  query: string,
  limit: number,
  includeIgnored = false,
): { root: string; rel: string }[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const scored: (Score & { root: string; rel: string; rootIndex: number })[] = [];
  roots.forEach((root, rootIndex) => {
    const { files, ignored } = candidates(root);
    for (const rel of files) {
      if (!includeIgnored && ignored.has(rel)) continue;
      const hit = score(rel, q);
      if (hit !== null) scored.push({ root, rel, rootIndex, ...hit });
    }
  });
  // Root order is an explicit tiebreak, not a side effect of sort stability: the
  // primary root has to win an otherwise-equal match every time.
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.quality - b.quality ||
      a.first - b.first ||
      a.rel.length - b.rel.length ||
      a.rootIndex - b.rootIndex ||
      a.rel.localeCompare(b.rel),
  );
  const seen = new Set<string>();
  const out: { root: string; rel: string }[] = [];
  for (const s of scored) {
    const abs = path.resolve(s.root, s.rel);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ root: s.root, rel: s.rel });
    if (out.length >= limit) break;
  }
  return out;
}
