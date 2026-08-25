import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileChange, FileChangeStatus } from '@lines/shared';

const pexec = promisify(execFile);
const MAX_BUFFER = 12 * 1024 * 1024;
/** Per repo, not per workflow — a multi-repo diff walks this many new files in each. */
const MAX_UNTRACKED = 50;
/** Ceiling on an injected step diff (~50k tokens) so one huge working tree can't
 *  push the hand-off prompt past the model's context window. Split across repos
 *  by multiRepoDiff, so N repos don't multiply it by N — the per-repo truncation
 *  markers and `# repo:` headers are the only bytes that ride above it. */
const MAX_DIFF_CHARS = 200_000;
/** A hung `git` would stall step entry once per root, so every call is bounded.
 *  Generous relative to projectKeys.ts (3s) because `git diff` on a large dirty
 *  tree is legitimately slower than a `rev-parse`. */
const GIT_TIMEOUT_MS = 10_000;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec('git', args, { cwd, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS });
    return stdout;
  } catch (err) {
    // `git diff --no-index` exits non-zero when files differ but still prints the
    // diff on stdout — recover it. Everything else (not a repo, git missing,
    // timed out) → ''.
    const stdout = (err as { stdout?: unknown })?.stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

/** `git worktree add` checks out a whole tree, which the 10s read budget can't cover. */
const GIT_WRITE_TIMEOUT_MS = 120_000;

/**
 * Run a *mutating* git command, throwing git's own stderr on failure.
 *
 * The counterpart to `git()` above, which swallows every failure to '' because
 * `diff --no-index` needs it. A write must fail loudly instead: its stderr *is*
 * the diagnostic the user has to read ("already checked out", "contains modified
 * files", "not fully merged"). Never route a read through here, or a write
 * through `git()`.
 */
export async function runGit(
  cwd: string,
  args: string[],
  timeout = GIT_WRITE_TIMEOUT_MS,
): Promise<string> {
  try {
    const { stdout } = await pexec('git', args, { cwd, maxBuffer: MAX_BUFFER, timeout });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : '';
    throw new Error((stderr || e.message || 'git failed').trim());
  }
}

/** A non-destructive snapshot of the working tree at workflow start, so step
 *  diffs show only what the workflow changed — not pre-existing dirty state. */
export interface DiffBaseline {
  /** Commit-ish to diff tracked changes against (a `git stash create` SHA, or 'HEAD'). */
  ref: string;
  /** Untracked files that already existed at start — excluded from step diffs. */
  untracked: string[];
}

/** A baseline tagged with the repo it was taken in — one entry per commit unit. */
export interface RepoBaseline extends DiffBaseline {
  /** Absolute work-tree root (`git rev-parse --show-toplevel`). */
  repo: string;
}

/** The work tree containing `dir`, or null when `dir` isn't inside one. */
export async function repoRoot(dir: string): Promise<string | null> {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim() || null;
}

/** Current branch, or null when detached or not a repo. */
export async function repoBranch(root: string): Promise<string | null> {
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return branch && branch !== 'HEAD' ? branch : null;
}

/** One commit unit: a work tree, plus the session roots that live inside it. */
export interface RepoGroup {
  /** Absolute work-tree root — one commit unit. */
  root: string;
  /** The session roots that live inside it, in project order. */
  roots: string[];
}

/**
 * Group session roots into commit units by work tree. Two roots in one monorepo
 * share a toplevel and so become ONE commit; two sibling checkouts become two.
 *
 * Deliberately not keyed off project keys: `resolveProjectKey` embeds
 * `--show-prefix` precisely so monorepo siblings stay *distinct* projects, which
 * is the opposite of what commit grouping needs.
 *
 * The group holding `roots[0]` comes first, so the primary root's repo leads
 * every rendering. Roots that aren't in a work tree are returned as `orphans` —
 * they are never a commit unit.
 */
export async function groupByRepo(roots: string[]): Promise<{ repos: RepoGroup[]; orphans: string[] }> {
  const repos: RepoGroup[] = [];
  const orphans: string[] = [];
  for (const root of roots) {
    const top = await repoRoot(root);
    if (!top) {
      orphans.push(root);
      continue;
    }
    const existing = repos.find((r) => r.root === top);
    if (existing) existing.roots.push(root);
    else repos.push({ root: top, roots: [root] });
  }
  return { repos, orphans };
}

async function listUntracked(cwd: string): Promise<string[]> {
  return (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Snapshot the current working tree without touching it. `git stash create`
 * records tracked modifications as a dangling commit (empty output when clean);
 * we fall back to HEAD. Untracked files are recorded so newly-created ones can be
 * told apart later. Safe on a non-repo (returns { ref: 'HEAD', untracked: [] }).
 */
export async function captureBaseline(cwd: string): Promise<DiffBaseline> {
  const created = (await git(cwd, ['stash', 'create'])).trim();
  return { ref: created || 'HEAD', untracked: await listUntracked(cwd) };
}

/** One baseline per commit unit the roots span; orphan roots get none. */
export async function captureBaselines(roots: string[]): Promise<RepoBaseline[]> {
  const { repos } = await groupByRepo(roots);
  const out: RepoBaseline[] = [];
  for (const repo of repos) {
    out.push({ repo: repo.root, ...(await captureBaseline(repo.root)) });
  }
  return out;
}

/**
 * Does `ref` still name a commit in `repo`?
 *
 * A `git stash create` snapshot is a *dangling* commit, so a `git gc` in a
 * long-lived session can prune it. `git()` swallows every failure to '', which
 * would turn a pruned baseline into a silent "nothing changed" — this is what
 * lets a caller fall back to HEAD and say so instead.
 */
export async function refExists(repo: string, ref: string): Promise<boolean> {
  return !!(await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
}

/** One changed file, as `git diff --name-status` sees it. */
export interface NameStatusEntry {
  rel: string;
  status: FileChangeStatus;
}

/**
 * Parse `git diff --name-status`. Pure, so it is testable without a repo — the
 * `parseWorktreeList` precedent in worktrees.ts.
 *
 * A rename becomes two rows (the old path deleted, the new one added) and a copy
 * becomes one add: the review list is a list of paths, and it has no rename row
 * to put a `R100` in. `T` (typechange) and `U` (unmerged) read as modifications.
 */
export function parseNameStatus(out: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    const code = (parts[0] ?? '').trim();
    if (!code) continue;
    if (code[0] === 'R' || code[0] === 'C') {
      const [, from, to] = parts;
      if (code[0] === 'R' && from) entries.push({ rel: from, status: 'D' });
      if (to) entries.push({ rel: to, status: 'A' });
      continue;
    }
    const rel = parts[1];
    if (!rel) continue;
    entries.push({ rel, status: code[0] === 'A' ? 'A' : code[0] === 'D' ? 'D' : 'M' });
  }
  return entries;
}

/**
 * `git diff --numstat` collapses a rename into one path spec: `old => new`, or
 * `dir/{a => b}.ts` when the paths share a prefix and a suffix. Only the new path
 * has a row in the review list, so that is what we key the counts on.
 */
function numstatPath(spec: string): string {
  const braced = spec.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  // `dir/{ => sub}/f.ts` leaves a doubled separator once the empty side is dropped.
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/\/+/g, '/');
  const arrow = spec.split(' => ');
  return arrow.length === 2 ? arrow[1] : spec;
}

/**
 * Parse `git diff --numstat` into per-path line counts. Pure, like
 * `parseNameStatus`. Binary files report `-`/`-` (git counts bytes, not lines)
 * and land as 0/0 rather than NaN.
 */
export function parseNumstat(out: string): Map<string, { added: number; removed: number }> {
  const stats = new Map<string, { added: number; removed: number }>();
  for (const line of out.split('\n')) {
    const [added, removed, ...rest] = line.split('\t');
    if (!rest.length || !rest.join('')) continue;
    stats.set(numstatPath(rest.join('\t')), {
      added: added === '-' ? 0 : Number(added) || 0,
      removed: removed === '-' ? 0 : Number(removed) || 0,
    });
  }
  return stats;
}

/**
 * Every file changed in `repo` since `baseline`, as a structured list rather than
 * diff text — the review UI loads contents one file at a time, so this response
 * stays bounded no matter how large the working tree is.
 *
 * `MAX_DIFF_CHARS` is deliberately not applied: that cap exists to protect a
 * model's context window, and nothing on this path reaches a model.
 */
export async function changedFiles(
  repo: string,
  baseline: DiffBaseline | undefined,
): Promise<{ files: FileChange[]; stale: boolean; untrackedOmitted: number }> {
  const wanted = baseline?.ref ?? 'HEAD';
  // Only a snapshot ref can go stale; HEAD is missing only in an empty repo,
  // which is the pre-existing gap repoDiff already has.
  const stale = wanted !== 'HEAD' && !(await refExists(repo, wanted));
  const ref = stale ? 'HEAD' : wanted;

  const stats = parseNumstat(await git(repo, ['diff', '--numstat', ref]));
  const files: FileChange[] = parseNameStatus(await git(repo, ['diff', '--name-status', ref])).map(
    (entry) => ({ ...entry, ...(stats.get(entry.rel) ?? { added: 0, removed: 0 }) }),
  );

  // A pruned ref cost us the tracked floor, not the untracked one — that list is
  // plain paths, so it still tells new files from pre-existing ones.
  const preexisting = new Set(baseline?.untracked ?? []);
  const untracked = (await listUntracked(repo)).filter((f) => !preexisting.has(f));
  for (const rel of untracked.slice(0, MAX_UNTRACKED)) {
    const counted = parseNumstat(
      await git(repo, ['diff', '--no-index', '--numstat', '--', '/dev/null', rel]),
    );
    files.push({ rel, status: 'A', added: [...counted.values()][0]?.added ?? 0, removed: 0 });
  }

  return { files, stale, untrackedOmitted: Math.max(0, untracked.length - MAX_UNTRACKED) };
}

/**
 * A file's contents at `ref`, or '' when it did not exist there (a file the
 * session created). The "after" side is the file on disk, which the caller reads
 * under its own size and binary rules.
 */
export async function showFile(repo: string, ref: string, rel: string): Promise<string> {
  return git(repo, ['show', `${ref}:${rel}`]);
}

/**
 * Paths that changed in `repo` between two snapshots of the same working tree —
 * the per-turn attribution window. Tracked files come from diffing the two
 * snapshot commits; new files are the set difference of their untracked listings.
 *
 * Because both ends are git snapshots, this catches every on-disk change the turn
 * produced regardless of what made it (a shell redirect, a script, an MCP tool),
 * and a file edited then restored cancels out to nothing.
 */
export async function changedBetween(
  repo: string,
  from: DiffBaseline,
  to: DiffBaseline,
): Promise<string[]> {
  const rels = new Set<string>();
  // A pruned or absent ref costs us the tracked half, not the untracked one.
  if (await refExists(repo, from.ref)) {
    for (const rel of (await git(repo, ['diff', '--name-only', from.ref, to.ref]))
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)) {
      rels.add(rel);
    }
  }
  const before = new Set(from.untracked);
  for (const rel of to.untracked) if (!before.has(rel)) rels.add(rel);
  return [...rels];
}

/**
 * One repo's working-tree diff, capped at `maxChars`. `fullLength` is the
 * untruncated size, which is what lets multiRepoDiff hand a repo's unused budget
 * to one that overflowed.
 */
async function repoDiff(
  cwd: string,
  baseline: DiffBaseline | undefined,
  maxChars: number,
): Promise<{ text: string; fullLength: number }> {
  const parts: string[] = [];

  const tracked = (await git(cwd, ['diff', baseline?.ref ?? 'HEAD'])).trim();
  if (tracked) parts.push(tracked);

  const preexisting = new Set(baseline?.untracked ?? []);
  const untracked = (await listUntracked(cwd)).filter((f) => !preexisting.has(f));

  for (const file of untracked.slice(0, MAX_UNTRACKED)) {
    const d = (await git(cwd, ['diff', '--no-index', '--', '/dev/null', file])).trim();
    if (d) parts.push(d);
  }
  if (untracked.length > MAX_UNTRACKED) {
    parts.push(`# … ${untracked.length - MAX_UNTRACKED} more untracked files omitted from the diff`);
  }

  const diff = parts.join('\n');
  if (diff.length <= maxChars) return { text: diff, fullLength: diff.length };
  return {
    text: `${diff.slice(0, maxChars)}\n# … diff truncated at ${maxChars} chars (${diff.length} total)`,
    fullLength: diff.length,
  };
}

/**
 * Working-tree diff used to seed a fresh workflow step: tracked changes since
 * `baseline` (or HEAD) plus files created since it. Returns '' when nothing
 * changed, `cwd` is not a git repo, or git is unavailable.
 */
export async function workingTreeDiff(cwd: string, baseline?: DiffBaseline): Promise<string> {
  return (await repoDiff(cwd, baseline, MAX_DIFF_CHARS)).text;
}

/**
 * One diff per commit unit, sharing a single MAX_DIFF_CHARS budget so N repos
 * can't multiply the hand-off prompt by N. Two passes: every repo gets an equal
 * share, then whatever the repos under their share didn't use is redistributed to
 * the ones that overflowed.
 *
 * A single repo emits no `# repo:` header, keeping existing single-root prompts
 * byte-identical to what workingTreeDiff produced.
 */
export async function multiRepoDiff(baselines: RepoBaseline[]): Promise<string> {
  if (!baselines.length) return '';
  if (baselines.length === 1) {
    return (await repoDiff(baselines[0].repo, baselines[0], MAX_DIFF_CHARS)).text;
  }

  const share = Math.floor(MAX_DIFF_CHARS / baselines.length);
  const first = await Promise.all(
    baselines.map((b) => repoDiff(b.repo, b, share).then((d) => ({ baseline: b, ...d }))),
  );

  // Repos that fit leave their share behind; split the remainder evenly among
  // those that didn't, then re-diff only those (a second pass is cheaper than
  // holding every full diff in memory to begin with).
  const over = first.filter((d) => d.fullLength > share);
  const unused = first
    .filter((d) => d.fullLength <= share)
    .reduce((sum, d) => sum + (share - d.fullLength), 0);
  const bonus = over.length ? Math.floor(unused / over.length) : 0;

  const sections: string[] = [];
  for (const entry of first) {
    const text =
      bonus && entry.fullLength > share
        ? (await repoDiff(entry.baseline.repo, entry.baseline, share + bonus)).text
        : entry.text;
    if (!text) continue;
    sections.push(`# repo: ${entry.baseline.repo}\n${text}`);
  }
  return sections.join('\n\n');
}
