import fs from 'node:fs';
import path from 'node:path';
import type { DocFile } from '@lines/shared';

/**
 * Collect a project's `docs/**` markdown into one bundle, which is what the
 * documentation reader fetches on mount: the tree, the feature cards, search and
 * doc-to-doc navigation all run off this single payload.
 */

/** Never worth walking for docs; mirrors the file tree's and mention search's ignores. */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

const DEFAULT_MAX_FILES = 400;
/** Per-file cap, deliberately not the /file preview cap — the bundle has its own budget. */
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 8;

export interface CollectDocsLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
}

/**
 * Every `.md` file under `root`, POSIX-relative and sorted. Symlinks — files and
 * directories alike — are skipped: that kills walk cycles, and stops a link like
 * `docs/key.md -> ~/.ssh/id_rsa` from smuggling a file out of the docs tree,
 * which the containment check (a prefix test) would otherwise wave through.
 * Unreadable directories are skipped rather than thrown; any limit hit sets
 * `truncated` so the reader can say the view is partial.
 */
export function collectDocs(
  root: string,
  limits: CollectDocsLimits = {},
): { docs: DocFile[]; truncated: boolean } {
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;

  const docs: DocFile[] = [];
  let truncated = false;
  let total = 0;

  const walk = (rel: string, depth: number) => {
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (docs.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (d.name.startsWith('.') || IGNORE_DIRS.has(d.name)) continue;
      const child = rel ? `${rel}/${d.name}` : d.name;
      // isFile/isDirectory are false for symlinks (readdir does not follow them).
      if (d.isDirectory()) {
        walk(child, depth + 1);
        continue;
      }
      if (!d.isFile() || !/\.md$/i.test(d.name)) continue;
      const abs = path.join(root, child);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes || total + stat.size > maxTotalBytes) {
        truncated = true;
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      total += stat.size;
      docs.push({ path: child, content, bytes: stat.size, mtime: stat.mtimeMs });
    }
  };

  walk('', 0);
  // Code-unit order, not locale collation: the payload must not shift with the
  // server's ICU locale, and '/' has to keep directory groups intact.
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { docs, truncated };
}
