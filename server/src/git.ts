import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const MAX_BUFFER = 12 * 1024 * 1024;
/** A hung `git` would stall step entry once per root, so every call is bounded. */
const GIT_TIMEOUT_MS = 10_000;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec('git', args, { cwd, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS });
    return stdout;
  } catch (err) {
    // Recover whatever stdout a non-zero exit still printed. Everything else
    // (not a repo, git missing, timed out) → ''.
    const stdout = (err as { stdout?: unknown })?.stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

/** `git worktree add` checks out a whole tree, which the 10s read budget can't cover. */
const GIT_WRITE_TIMEOUT_MS = 120_000;

/**
 * Run a *mutating* git command, throwing git's own stderr on failure.
 *
 * The counterpart to `git()` above, which swallows every failure to ''. A write
 * must fail loudly instead: its stderr *is* the diagnostic the user has to read
 * ("already checked out", "contains modified files", "not fully merged"). Never
 * route a read through here, or a write through `git()`.
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
