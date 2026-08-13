/**
 * Git work-tree plumbing: naming, porcelain parsing, and the exact argv every
 * mutation uses. No project records, no broadcasts, no validation that needs to
 * see the projects list — that is worktreeCommands.ts.
 *
 * Every git-touching function takes an injectable `GitRun`, which is what makes
 * this testable without a real repo (and without git on the box).
 */
import path from 'node:path';
import { runGit } from './git.ts';
import { APP_ROOT } from './workerProtocol.ts';

/**
 * Where Lines keeps the work trees it creates: `~/.lines-app/worktrees/<repo>/<slug>`.
 *
 * App state, not the user's project folder. These are short-lived and agent-owned —
 * the agent commits to the branch and the tree is removed — so the deciding factor
 * is that they must not litter the directory the user browses, and must never be
 * mistaken for a project. Imported from workerProtocol.ts rather than store.ts for
 * the same reason the worker does: this module has no business pulling the store
 * graph in.
 */
export const WORKTREE_ROOT = path.join(APP_ROOT, 'worktrees');

/** How a git command is run. Injected so tests can assert argv instead of effects. */
export type GitRun = (cwd: string, args: string[]) => Promise<string>;

/** One entry from `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  /** Absolute work-tree path, as git reports it. */
  path: string;
  /** Short branch name; absent when the work tree is detached. */
  branch?: string;
}

/**
 * A branch name reduced to one path segment. Slashes go too: a `feature/x` branch
 * must not turn the default work-tree path into a nested directory the scheme did
 * not intend.
 */
export function slugifyBranch(branch: string): string {
  return (
    branch
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'worktree'
  );
}

/**
 * Where a work tree for `branch` goes by default: `<WORKTREE_ROOT>/<repo>/<slug>`.
 *
 * Grouped by repo name so two projects can hold the same branch name, and outside
 * the checkout entirely — a work tree nested in the repo would double every
 * `/tree`, `@mention` and `/find` hit under the overlap and show up as untracked in
 * the parent's `git status`.
 *
 * Two repos that share a basename land in one directory; the caller's uniquifier
 * settles that, since a `-2` suffix is cheaper than encoding the whole path here.
 */
export function defaultWorktreePath(repoRoot: string, branch: string, base = WORKTREE_ROOT): string {
  const repo = path.basename(repoRoot.replace(/\/+$/, '')) || 'repo';
  return path.join(base, repo, slugifyBranch(branch));
}

/**
 * `base`, or `base-2`, `base-3`… — the first candidate `taken` rejects.
 *
 * A predicate rather than a list: "taken" means both *registered by a project*
 * and *already occupied on disk*, and only the caller can answer the second.
 */
export function uniqueWorktreePath(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * Namespace every branch Lines creates on its own initiative, so `git branch` says
 * who made it — and so a stray one is recognisable months later, when the session
 * that owned it is long gone. Never applied to a branch the user typed: that name is
 * theirs.
 */
export const LINES_BRANCH_PREFIX = 'lines/';

/**
 * Branch name for a work tree the user didn't name (the per-session opt-in).
 * `now` is a parameter so the name is assertable.
 */
export function autoBranchName(now = Date.now()): string {
  return `${LINES_BRANCH_PREFIX}wt-${now.toString(36)}`;
}

/** The branch a session's auto-title earns: `lines/fix-auth-token-expiry`. */
export function titleBranchName(title: string): string {
  return `${LINES_BRANCH_PREFIX}${slugifyBranch(title)}`;
}

/**
 * Parse `git worktree list --porcelain` into the *linked* work trees only.
 *
 * The first block is always the main checkout, which is the project's own path
 * and not a work tree record; a `bare` entry has no working files at all. Both
 * are dropped, as are the `locked`/`prunable` annotation lines.
 */
export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const blocks = porcelain.split(/\n\s*\n/);
  const out: WorktreeListEntry[] = [];
  blocks.forEach((block, index) => {
    let entryPath = '';
    let branch: string | undefined;
    let bare = false;
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('worktree ')) entryPath = line.slice('worktree '.length).trim();
      else if (line === 'bare') bare = true;
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
    // index 0 is the main checkout — a real path, deliberately not a record.
    if (!entryPath || bare || index === 0) return;
    out.push(branch ? { path: entryPath, branch } : { path: entryPath });
  });
  return out;
}

/** The repo's linked work trees, as git sees them right now. */
export async function listWorktrees(repo: string, run: GitRun = runGit): Promise<WorktreeListEntry[]> {
  return parseWorktreeList(await run(repo, ['worktree', 'list', '--porcelain']));
}

/**
 * `git worktree add -b <branch> <path> [<baseRef>]`, or `--detach` when no branch
 * is named yet.
 *
 * Detached is how a per-session work tree starts: the path is the session's cwd and
 * so is fixed forever, but the branch can wait for a name worth having — see
 * {@link switchToNewBranch}.
 *
 * A killed or failed add can leave files plus an administrative
 * `.git/worktrees` entry behind, so the failure path prunes before re-throwing —
 * otherwise the path is permanently "already registered" with no record of it
 * anywhere in Lines.
 */
export async function addWorktree(
  opts: { repo: string; path: string; branch?: string; baseRef?: string },
  run: GitRun = runGit,
): Promise<void> {
  try {
    await run(opts.repo, [
      'worktree',
      'add',
      ...(opts.branch ? ['-b', opts.branch] : ['--detach']),
      opts.path,
      ...(opts.baseRef ? [opts.baseRef] : []),
    ]);
  } catch (err) {
    try {
      await run(opts.repo, ['worktree', 'prune']);
    } catch {
      // Best-effort cleanup; the add's own error is the one worth reporting.
    }
    throw err;
  }
}

/**
 * `git switch -c <branch>` *inside* the work tree, so a detached one gets its branch
 * once there is a name worth using.
 *
 * Nothing is renamed and nothing is lost: the new branch starts at the work tree's
 * current HEAD, so commits the agent already made on detached HEAD come along. Run
 * with `cwd` = the work tree, not the repo — in the repo it would move the *main*
 * checkout's branch.
 *
 * Throws git's own message when the name is taken ("already exists"), which is what
 * lets the caller try another.
 */
export async function switchToNewBranch(
  worktreePath: string,
  branch: string,
  run: GitRun = runGit,
): Promise<void> {
  await run(worktreePath, ['switch', '-c', branch]);
}

/**
 * `git worktree remove <path>`, then `git branch -d <branch>` only when asked.
 *
 * Ordered so nothing else happens if git refuses the removal — a dirty work tree
 * must keep both its files and its branch. Never `-D`: an unmerged branch has to
 * surface git's refusal rather than being force-deleted behind a checkbox.
 */
export async function removeWorktree(
  opts: { repo: string; path: string; branch?: string; deleteBranch?: boolean; force?: boolean },
  run: GitRun = runGit,
): Promise<void> {
  await run(opts.repo, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), opts.path]);
  if (opts.deleteBranch && opts.branch) await run(opts.repo, ['branch', '-d', opts.branch]);
}
