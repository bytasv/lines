/**
 * The work-tree command layer: validation, record mutation, key learning and the
 * broadcast — everything that needs to see both the projects list and the live
 * sessions.
 *
 * Extracted from index.ts for the same reason recipeCommands.ts is: index.ts
 * starts listening on import, so a test can't import it. `UserContext` is
 * imported type-only to avoid the same cycle those modules avoid.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ClientMessage, Project, ServerMessage, WorktreeInfo } from '@lines/shared';
import { findProject, findWorktree, normalizeRootPath, projectPaths, projectRoots } from '@lines/shared';
import { repoRoot } from './git.ts';
import * as worktrees from './worktrees.ts';
import type { GitRun } from './worktrees.ts';
import type { UserContext } from './userContext.ts';

type CreateMsg = Extract<ClientMessage, { type: 'createWorktree' }>;
type RemoveMsg = Extract<ClientMessage, { type: 'removeWorktree' }>;

/**
 * The two impure seams every command here goes through, injectable for the same
 * reason `GitRun` is: the validation, record and broadcast behaviour is what these
 * functions own, and a test of it should need neither git nor a checkout.
 * Production callers pass nothing.
 */
export interface WorktreeDeps {
  run?: GitRun;
  repoRoot?: (dir: string) => Promise<string | null>;
  /** Creates the managed parent directory; injected so a test writes nothing. */
  ensureParent?: (dir: string) => void;
}

/** A directory that would make `git worktree add` refuse: it exists and isn't empty. */
function occupied(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    // A file, or unreadable — either way git can't check a work tree out there.
    return true;
  }
}

/**
 * Create the `<WORKTREE_ROOT>/<repo>` level, which nothing else owns — a first-ever
 * work tree would otherwise depend on git creating leading directories. Only inside
 * our managed area: a path the user typed is their own, and git handles it.
 */
function ensureManagedParent(dir: string): void {
  if (dir !== worktrees.WORKTREE_ROOT && !dir.startsWith(worktrees.WORKTREE_ROOT + path.sep)) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
}

/** `cwd` is the work tree at `root`, or lives underneath it. */
function inside(root: string, cwd: string): boolean {
  return cwd === root || cwd.startsWith(root + path.sep);
}

/**
 * The rules `addProjectRoot` applies, applied to a work-tree path. One path one
 * owner (a `/tree` hit or a project key must not be ambiguous about its tab), and
 * no nesting with a root of this project (nesting doubles every tree/find hit
 * under the overlap).
 */
function assertPathFree(projects: Project[], project: Project, target: string): void {
  const owner = projects.find((p) => projectPaths(p).includes(target));
  if (owner) throw new Error(`Already a folder of ${owner.path}`);
  const nested = projectRoots(project).find(
    (existing) =>
      target === existing ||
      target.startsWith(existing + path.sep) ||
      existing.startsWith(target + path.sep),
  );
  if (nested) throw new Error(`Overlaps an existing folder: ${nested}`);
}

/** The repo `dir` sits in, or a thrown explanation. */
async function repoFor(dir: string, deps: WorktreeDeps): Promise<string> {
  const repo = await (deps.repoRoot ?? repoRoot)(dir);
  if (!repo) throw new Error(`Not a git repository: ${dir}`);
  return repo;
}

/**
 * Register a freshly created work tree: persist it, learn its key, broadcast.
 *
 * The learned key resolves to the *parent's* key — a work tree shares its repo's
 * origin remote and `--show-prefix` — and that is the point: it is what makes a
 * work-tree session group into the parent's tab, on this machine and on any other.
 *
 * Two things `addProjectRoot` does are deliberately skipped. No `addRecentDir`: a
 * managed work tree under `WORKTREE_ROOT` is app state, and offering it in "Recent"
 * would invite opening it as its own tab — which double-counts every session in it,
 * since it resolves to the parent's key. And no `recycleIdleQueries()`: unlike a new
 * root, nothing about an existing session's roots or `additionalDirectories` changed.
 */
function register(ctx: UserContext, projects: Project[], project: Project, info: WorktreeInfo): void {
  project.worktrees = [...(project.worktrees ?? []), info];
  ctx.store.saveProjects(projects);
  ctx.projectKeys.learn(info.path);
  ctx.broadcast({ type: 'projects', projects } satisfies ServerMessage);
}

/**
 * Cut a work tree the user named. Explicit names are never adjusted: a taken path
 * or branch throws, because silently creating something other than what was asked
 * for is worse than failing.
 */
export async function createWorktree(
  ctx: UserContext,
  msg: CreateMsg,
  deps: WorktreeDeps = {},
): Promise<WorktreeInfo> {
  const target = normalizeRootPath(msg.project) || '/';
  const branch = msg.branch.trim();
  if (!branch) throw new Error('A branch name is required');
  const projects = ctx.store.loadProjects();
  const project = projects.find((p) => p.path === target);
  if (!project) throw new Error(`Not an open project: ${target}`);
  const repo = await repoFor(project.path, deps);

  const dir = normalizeRootPath(msg.path ?? '') || worktrees.defaultWorktreePath(repo, branch);
  assertPathFree(projects, project, dir);
  if (occupied(dir)) throw new Error(`Already exists and is not empty: ${dir}`);

  (deps.ensureParent ?? ensureManagedParent)(dir);
  // git's own refusal ("already exists", "already checked out") is the diagnostic
  // for a taken branch, so no branch bookkeeping is duplicated here.
  await worktrees.addWorktree(
    { repo, path: dir, branch, baseRef: msg.baseRef?.trim() || undefined },
    deps.run,
  );

  const info: WorktreeInfo = {
    path: dir,
    branch,
    ...(msg.baseRef?.trim() ? { baseRef: msg.baseRef.trim() } : {}),
    createdAt: Date.now(),
    createdByLines: true,
  };
  register(ctx, projects, project, info);
  return info;
}

/**
 * Cut a work tree for a session that is about to be created, off `cwd`'s project.
 *
 * Deliberately **detached**: the path is about to become the session's cwd and so is
 * fixed forever, but a branch cut now could only be named `lines/wt-<id>` — there is
 * no prompt yet to name it after. {@link nameWorktreeBranch} names it seconds later,
 * off the session's auto-title. The path keeps the id either way; it is app state
 * under `WORKTREE_ROOT` that nobody reads.
 *
 * The mirror image of `createWorktree` on naming: the user named nothing, so a
 * collision is uniquified (`-2`, `-3`…) rather than thrown — failing would leave
 * them with no session and nothing to correct.
 */
export async function worktreeForNewSession(
  ctx: UserContext,
  cwd: string,
  req: { branch?: string; baseRef?: string },
  deps: WorktreeDeps = {},
): Promise<WorktreeInfo> {
  const dir = normalizeRootPath(cwd) || '/';
  const projects = ctx.store.loadProjects();
  const project = findProject(projects, dir);
  if (!project) throw new Error(`Not an open project: ${dir}`);
  // `cwd`'s own repo, not the primary's: a session started in an extra root that
  // is a different checkout must get a work tree of *that* repo.
  const repo = await repoFor(dir, deps);

  // An explicit branch is honoured (a caller that already knows the name); otherwise
  // the id only names the *directory*, and the work tree starts detached.
  const requested = req.branch?.trim();
  const base = worktrees.defaultWorktreePath(repo, requested || worktrees.autoBranchName());
  const registered = new Set(projects.flatMap(projectPaths));
  const resolved = worktrees.uniqueWorktreePath(base, (p) => registered.has(p) || occupied(p));
  // The path's own suffix names the branch too, so the two never disagree about
  // which attempt this is.
  const branch = requested && resolved !== base ? `${requested}${resolved.slice(base.length)}` : requested;

  assertPathFree(projects, project, resolved);
  (deps.ensureParent ?? ensureManagedParent)(resolved);
  await worktrees.addWorktree(
    { repo, path: resolved, branch, baseRef: req.baseRef?.trim() || undefined },
    deps.run,
  );

  const info: WorktreeInfo = {
    path: resolved,
    ...(branch ? { branch } : {}),
    ...(req.baseRef?.trim() ? { baseRef: req.baseRef.trim() } : {}),
    createdAt: Date.now(),
    createdByLines: true,
  };
  register(ctx, projects, project, info);
  return info;
}

/** How many taken names to step past before falling back to the reserved id. */
const BRANCH_NAME_ATTEMPTS = 3;

/**
 * Give a detached work tree its branch, named after the session's auto-title.
 *
 * Called when the titler resolves, a second or two into the first turn. Cutting the
 * branch now rather than at creation is what buys a readable name without renaming
 * anything: `git switch -c` starts the branch at the work tree's current HEAD, so
 * even a commit the agent already made on detached HEAD comes along.
 *
 * A no-op once the record has a branch, so a second title, a manual create, or a
 * reconcile-adopted work tree is never touched. An empty `title` (the titler failed,
 * or had no token) still names the branch — off the directory id — because leaving a
 * session on detached HEAD indefinitely is worse than an ugly name.
 */
export async function nameWorktreeBranch(
  ctx: UserContext,
  worktreePath: string,
  title: string,
  deps: WorktreeDeps = {},
): Promise<void> {
  const dir = normalizeRootPath(worktreePath) || '/';
  const projects = ctx.store.loadProjects();
  const found = findWorktree(projects, dir);
  if (!found || found.worktree.branch) return;
  // Only a work tree Lines cut. One adopted from git (an agent's own `worktree add`)
  // is deliberately detached by whoever made it, and cutting a branch in someone
  // else's checkout is not ours to do.
  if (!found.worktree.createdByLines) return;

  // The directory id, which is unique by construction — the last resort that is
  // still guaranteed free.
  const reserved = `${worktrees.LINES_BRANCH_PREFIX}${path.basename(dir)}`;
  const wanted = worktrees.titleBranchName(title.trim());
  const candidates = title.trim()
    ? [wanted, ...Array.from({ length: BRANCH_NAME_ATTEMPTS - 1 }, (_, i) => `${wanted}-${i + 2}`), reserved]
    : [reserved];

  for (const branch of candidates) {
    try {
      await worktrees.switchToNewBranch(dir, branch, deps.run);
    } catch (err) {
      // "already exists" is the expected one; anything else fails the same way, and
      // the last candidate's failure leaves the work tree detached but usable.
      if (branch === candidates[candidates.length - 1]) {
        console.warn('[worktrees] could not name the branch:', err);
        return;
      }
      continue;
    }
    found.worktree.branch = branch;
    ctx.store.saveProjects(projects);
    ctx.broadcast({ type: 'projects', projects } satisfies ServerMessage);
    return;
  }
}

/**
 * Name the session a work tree was cut for. Separate from creation because the
 * session id only exists after `createSession`, and the work tree has to exist
 * before it (cwd is identity).
 *
 * Purely a label: it is what lets the UI mark a record "orphaned" once its
 * session is gone. Nothing on disk depends on it, so a failure to match is a
 * silent no-op rather than an error.
 */
export function attachSession(ctx: UserContext, worktreePath: string, sessionId: string): void {
  const projects = ctx.store.loadProjects();
  const found = projects
    .flatMap((p) => p.worktrees ?? [])
    .find((w) => w.path === normalizeRootPath(worktreePath));
  if (!found) return;
  found.sessionId = sessionId;
  ctx.store.saveProjects(projects);
  ctx.broadcast({ type: 'projects', projects } satisfies ServerMessage);
}

/**
 * Remove a work tree and, only when asked, its branch.
 *
 * Ordered so nothing is destroyed before every refusal has had its chance: an
 * unknown record is dropped, a live session inside it refuses, and only then does
 * git get to weigh in on the dirty state it alone can see.
 */
export async function removeWorktree(
  ctx: UserContext,
  msg: RemoveMsg,
  deps: WorktreeDeps = {},
): Promise<void> {
  const target = normalizeRootPath(msg.project) || '/';
  const dir = normalizeRootPath(msg.path) || '/';
  const projects = ctx.store.loadProjects();
  const project = projects.find((p) => p.path === target);
  if (!project) return;
  const info = (project.worktrees ?? []).find((w) => w.path === dir);
  if (!info) {
    // Idempotent, mirroring removeProjectRoot: a second click, or a record another
    // tab already removed, is answered with the current truth rather than an error.
    ctx.broadcast({ type: 'projects', projects } satisfies ServerMessage);
    return;
  }

  // Only this layer can see both facts. Removing the directory under an idle
  // session leaves it spawning in a path that no longer exists, with roots that
  // escalate every file call.
  if (!msg.force) {
    const live = ctx.sessions.list().filter((s) => !s.archived && inside(dir, s.cwd)).length;
    if (live > 0) {
      throw new Error(
        `${live} session${live === 1 ? '' : 's'} still run in this worktree — remove them, or remove it anyway`,
      );
    }
  }

  const repo = await repoFor(project.path, deps);
  // git's refusal ("contains modified or untracked files", "not fully merged")
  // propagates verbatim: it is the only description of what would be lost.
  await worktrees.removeWorktree(
    {
      repo,
      path: dir,
      branch: info.branch,
      // A branch Lines didn't create is never offered for deletion, so never deleted.
      deleteBranch: msg.deleteBranch && info.createdByLines === true,
      force: msg.force,
    },
    deps.run,
  );

  project.worktrees = (project.worktrees ?? []).filter((w) => w.path !== dir);
  if (!project.worktrees.length) delete project.worktrees;
  ctx.store.saveProjects(projects);
  // The learned project key stays: the registry deliberately never forgets a
  // path's identity, and the sessions that ran there still group by it.
  ctx.broadcast({ type: 'projects', projects } satisfies ServerMessage);
}

/**
 * Reconcile a project's records against git, which is the source of truth: drop
 * records whose directory is gone, and adopt work trees git knows about but we
 * don't.
 *
 * An adopted record never gets `createdByLines`, so removal will not offer to
 * delete a branch Lines didn't create. Broadcasts only when something changed,
 * so the `openProject` call site stays a fire-and-forget no-op in the common case.
 */
export async function reconcileWorktrees(
  ctx: UserContext,
  projectPath: string,
  deps: WorktreeDeps = {},
): Promise<void> {
  const target = normalizeRootPath(projectPath) || '/';
  const projects = ctx.store.loadProjects();
  const project = projects.find((p) => p.path === target);
  if (!project) return;
  const repo = await (deps.repoRoot ?? repoRoot)(project.path);
  if (!repo) return;

  let live: worktrees.WorktreeListEntry[];
  try {
    live = await worktrees.listWorktrees(repo, deps.run);
  } catch {
    // A transient git failure must not prune records that are perfectly fine.
    return;
  }
  const byPath = new Map(live.map((e) => [normalizeRootPath(e.path), e]));
  // Both halves of "gone": git no longer registers it, or the directory itself was
  // deleted (git still lists that one, as prunable, until someone prunes).
  const kept = (project.worktrees ?? []).filter((w) => byPath.has(w.path) && fs.existsSync(w.path));
  const known = new Set(kept.map((w) => w.path));
  const owned = new Set(projects.flatMap(projectPaths));
  const adopted: WorktreeInfo[] = [];
  for (const [dir, entry] of byPath) {
    if (known.has(dir) || owned.has(dir) || !fs.existsSync(dir)) continue;
    adopted.push(entry.branch ? { path: dir, branch: entry.branch } : { path: dir });
  }

  const next = [...kept, ...adopted];
  const unchanged =
    next.length === (project.worktrees ?? []).length &&
    next.every((w, i) => w.path === (project.worktrees ?? [])[i]?.path);
  if (unchanged) return;

  if (next.length) project.worktrees = next;
  else delete project.worktrees;
  ctx.store.saveProjects(projects);
  for (const w of adopted) ctx.projectKeys.learn(w.path);
  ctx.broadcast({ type: 'projects', projects } satisfies ServerMessage);
}
