import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { GrepHit, GrepResponse, MatchOptions } from '@lines/shared';
import { buildMatcher, clipAround } from '@lines/shared';
import { candidates } from './fileSearch.ts';
import { isRealInside, realPathOf } from './autoGuard.ts';

/**
 * Find-in-files: content search across a project's roots, backing the sidebar's
 * Search mode. The file list is quick-open's (`candidates`), so the two agree on
 * what a project's files are and which of them are gitignored.
 *
 * Runs on the bridge's only thread, so it is bounded three ways — files with
 * hits, total matches, and wall-clock — and yields to the event loop between
 * batches of files so a big repo cannot stall every other session's stream.
 */

/** Larger files are skipped: minified bundles and data dumps, not source. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES_WITH_HITS = 200;
const MAX_MATCHES = 2000;
const TIME_BUDGET_MS = 3000;
/** Files read between yields to the event loop. */
const YIELD_EVERY = 50;
const LINE_CHARS = 200;

export interface GrepOptions extends MatchOptions {
  includeIgnored?: boolean;
  /** Overrides for tests. */
  maxFiles?: number;
  maxMatches?: number;
  timeBudgetMs?: number;
}

/**
 * Every line matching `query` in every candidate file of every root, grouped by
 * file in candidate order. Throws a `SyntaxError` for an invalid regex — the
 * route turns that into a 400. When roots nest, a file is reported once, under
 * the first root that lists it.
 */
export async function grepFilesAcross(
  roots: string[],
  query: string,
  opts: GrepOptions = {},
): Promise<GrepResponse> {
  const match = buildMatcher(query, opts);
  if (!query) return { files: [] };
  const maxFiles = opts.maxFiles ?? MAX_FILES_WITH_HITS;
  const maxMatches = opts.maxMatches ?? MAX_MATCHES;
  const deadline = Date.now() + (opts.timeBudgetMs ?? TIME_BUDGET_MS);
  const files: GrepHit[] = [];
  const seen = new Set<string>();
  let total = 0;
  let read = 0;
  for (const root of roots) {
    const { files: rels, ignored } = candidates(root);
    // Resolved once per root rather than per file: it is the same answer each time.
    const realRoot = [realPathOf(root)];
    const linkedDir = linkedDirs(root);
    for (const rel of rels) {
      if (!opts.includeIgnored && ignored.has(rel)) continue;
      const abs = path.resolve(root, rel);
      if (seen.has(abs)) continue;
      seen.add(abs);
      // git lists a symlink by its own path — and a tracked file whose directory
      // has since been swapped for one — and reading either reads wherever the
      // link points, which may be anywhere on the machine. Only those few pay for
      // a realpath; only what really lives under this root is searched.
      if ((linkedDir(path.posix.dirname(rel)) || isLink(abs)) && !isRealInside([root], abs, realRoot)) continue;
      if (++read % YIELD_EVERY === 0) {
        await yieldToLoop();
        if (Date.now() > deadline) return { files, truncated: true };
      }
      const content = readText(abs);
      if (content === null) continue;
      const matches: GrepHit['matches'] = [];
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
        const ranges = match(line);
        if (!ranges.length) continue;
        const [start, end] = ranges[0];
        matches.push({ line: i + 1, col: start + 1, text: clipAround(line, start, end, LINE_CHARS).text });
        if (++total >= maxMatches) break;
      }
      if (!matches.length) continue;
      files.push({ root, rel, matches });
      if (total >= maxMatches || files.length >= maxFiles) return { files, truncated: true };
    }
  }
  return { files };
}

/** True when `p` is itself a symlink — not whatever it points to. */
function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Whether a directory under `root` (POSIX-relative, as candidates lists it) is a
 * symlink or sits below one. Memoized for the root's whole candidate list:
 * files share their directories, so this costs one lstat per directory. The
 * non-repo walk never descends through a link, but git's index can still name a
 * file under a directory that has since become one.
 */
function linkedDirs(root: string): (dir: string) => boolean {
  const memo = new Map<string, boolean>();
  const linked = (dir: string): boolean => {
    if (dir === '.' || dir === '' || dir === '/') return false;
    let hit = memo.get(dir);
    if (hit === undefined) {
      hit = linked(path.posix.dirname(dir)) || isLink(path.join(root, dir));
      memo.set(dir, hit);
    }
    return hit;
  };
  return linked;
}

/** A file's text, or null when it is missing, too large, or binary. */
function readText(abs: string): string | null {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const buf = fs.readFileSync(abs);
    // Same binary probe the preview uses: a NUL byte in the first 8KB.
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}
