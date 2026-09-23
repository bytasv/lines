# Git worktrees

## Purpose

Let a session run in its own linked git worktree — a second checkout of the same
repo, on its own branch — instead of sharing one checkout (and one dirty state,
one branch) with every other session in the project. A worktree shows up in its
project's tab (attribution) without ever widening what sessions in that tab may
read or write (capability): `projectRoots`/`rootsForCwd` never returns a worktree
path, and a worktree session's own roots are confined to `[worktree path]`.

A per-session worktree starts **detached**: the directory (the session's `cwd`)
is fixed the instant it's created, but there is no branch worth naming yet. Once
the session's auto-title resolves — a few seconds into the first turn — the
worktree gets a branch cut from that title (`git switch -c`, run inside the
worktree), carrying along any commit the agent already made on detached HEAD.
Nothing is ever renamed: the directory keeps its opaque id forever, and the
branch is created once, not adjusted later.

## Entry points

- `web/src/components/ProjectTabs.tsx` — per-tab "New worktree…" and the
  per-worktree manage/remove row
- `web/src/components/Sidebar.tsx` — the new-session dropdown's "Run in a new
  worktree" switch

## Important files

- `shared/types.ts` — `WorktreeInfo`, `Project.worktrees`, `worktreePaths`,
  `projectPaths`, `findWorktree`, the worktree branch in `rootsForCwd`, the
  `createWorktree`/`removeWorktree` client messages, `createSession.worktree`
- `server/src/git.ts` — `runGit`, the throwing counterpart to the read-only
  `git()` helper; mutating git must fail loudly, since its stderr is the only
  description of what a removal would destroy
- `server/src/worktrees.ts` — pure naming/parsing (`slugifyBranch`,
  `defaultWorktreePath`, `uniqueWorktreePath`, `autoBranchName`,
  `titleBranchName`, `LINES_BRANCH_PREFIX`, `parseWorktreeList`,
  `WORKTREE_ROOT`) and the git-touching primitives (`listWorktrees`,
  `addWorktree`, `switchToNewBranch`, `removeWorktree`), all taking an
  injectable `GitRun`
- `server/src/worktreeCommands.ts` — validation, record mutation, key
  learning and the broadcast: `createWorktree`, `worktreeForNewSession`,
  `nameWorktreeBranch`, `attachSession`, `removeWorktree`,
  `reconcileWorktrees`. Extracted from `index.ts` for the same reason
  `recipeCommands.ts` is (`index.ts` starts listening on import, so a test
  can't import it)
- `server/src/index.ts` — the `createWorktree`/`removeWorktree` cases;
  `createSession` cuts the worktree before creating the session; `openProject`
  reconciles a project's worktree records against git
- `server/src/sessions.ts` — `SessionManager.onAutoNamed`, fired on every exit
  from the auto-titler (including failure) so a worktree waiting to be named
  is never left hanging
- `server/src/userContext.ts` — wires `onAutoNamed` to `nameWorktreeBranch`
- `server/src/store.ts` — `sanitizeProjects` handles `worktrees`, omitted from
  the written JSON when empty
- `server/src/autoGuard.ts` — two `BASH_RULES` entries escalating
  `git worktree remove`/`prune` and `git branch -d`/`--delete` for the agent
  running git directly; Lines' own worktree actions go through
  `worktreeCommands`, never Bash, so they never hit this guard at all
- `web/src/store.ts` — `worktreePending`, the `case 'error'` → `actionError`
  fix, `sessionsInProject` using `projectPaths`
- `web/src/components/WorktreeModal.tsx` — create form and manage/remove view
- `web/src/components/SessionView.tsx` — copy-path icon and branch label next
  to the session name

## Important symbols

- `WorktreeInfo { path, branch?, baseRef?, createdAt?, sessionId?, createdByLines? }`
  — a cache of git truth, not the source of it; a record whose directory is gone
  is dropped on reconcile rather than repaired. `branch` is absent while detached.
- `projectPaths(project)` vs `projectRoots(project)` — attribution vs capability;
  see [multi-root-projects](multi-root-projects.md#important-symbols)
- `findWorktree(projects, cwd)` — `{ project, worktree } | null`; the attribution
  lookup `findProject` deliberately does not perform
- `worktreeForNewSession(ctx, cwd, req, deps?)` — cuts a **detached** worktree for
  a session about to be created; uniquifies the path/branch id on collision
  rather than throwing (the user named nothing)
- `nameWorktreeBranch(ctx, worktreePath, title, deps?)` — gives a detached
  worktree its branch once a title exists; no-op if the worktree already has a
  branch or was adopted rather than created by Lines; walks title → `-2` → `-3`
  → the reserved directory-id name on a collision; an empty title still names
  the branch off the reserved id rather than leaving it detached forever
- `createWorktree(ctx, msg, deps?)` — the explicit, user-named path (tab menu);
  throws on a taken path/branch instead of adjusting it
- `removeWorktree(ctx, msg, deps?)` — refuses while a non-archived session's
  `cwd` is inside the worktree, unless `force`; git's own refusal (dirty tree,
  unmerged branch) propagates verbatim
- `reconcileWorktrees(ctx, projectPath, deps?)` — called fire-and-forget from
  `openProject`; drops records whose directory git no longer lists, adopts ones
  git knows about that Lines doesn't (never with `createdByLines`)
- `WorktreeDeps { run?, repoRoot?, ensureParent? }` — the impure seams every
  command function takes, so a test needs neither git nor a real checkout

## Data flow

**Per-session (the toggle):** `createSession { worktree: {} }` → the server cuts
a detached worktree at `WORKTREE_ROOT/<repo>/<lines/wt-id>` *before* the session
exists (`cwd` is identity — project-key anchor, roots, attribution — and is
never rewritten; it is deliberately kept **out** of `recentDirs`, see Business
rules) → `sessions.createSession({ cwd: worktree.path, ... })`
→ the first prompt starts a turn immediately and, in parallel, the auto-titler
runs → once it settles, `onAutoNamed` fires → `nameWorktreeBranch` runs
`git switch -c <title-slug>` inside the worktree, carrying over anything the
agent already committed on detached HEAD → the record gains `branch`, broadcast.
A failed worktree cut creates **no session at all** — one `error` message, no
half state.

**Explicit (the tab menu):** `createWorktree { project, branch, baseRef?, path? }`
→ validated against the same one-owner/no-nesting rules `addProjectRoot` applies
→ `git worktree add -b <branch> <path> [<baseRef>]` → registered and broadcast.

**Removal:** `removeWorktree { project, path, deleteBranch?, force? }` → an
unknown record is dropped idempotently; a live non-archived session inside
refuses (named count) unless `force`; then `git worktree remove`, then
`git branch -d` only when asked and only for a branch Lines created — never `-D`.

## Dependencies

- `git worktree add/remove/list/prune`, `git switch -c`, `git branch -d`.
- The SDK's per-session `cwd`/`additionalDirectories` split — a worktree session
  gets `cwd = worktree path` and no `additionalDirectories` at all (see
  [multi-root-projects](multi-root-projects.md)).
- `resolveProjectKey` (`server/src/projectKeys.ts`) — a worktree shares its
  repo's origin remote and `--show-prefix`, so it resolves to the **parent's**
  key. That's what makes a worktree session group into the parent's tab, and it
  cannot be changed to encode the worktree in the key.
- The auto-titler (`SessionManager.autoName`) — the source of the branch name.

## Tests

- `server/src/worktrees.test.ts` — porcelain parsing, slug/path naming,
  `--detach` vs `-b` argv, `switchToNewBranch`'s cwd, the prune-on-failed-add
  path, `removeWorktree`'s ordering and never-`-D` rule
- `server/src/worktreeCommands.test.ts` — create/remove/reconcile validation,
  registration side effects, the detached-then-named flow, the collision walk
  to the reserved branch name, the never-branch-an-adopted-worktree rule
- `server/src/projectWorktrees.test.ts` — the shared helpers (`rootsForCwd`,
  `projectRoots` unchanged, `projectPaths`, `findWorktree`)
- `server/src/store.test.ts` — `sanitizeProjects`'s worktree handling,
  byte-identical JSON when a project has none; `addRecentDir` ignoring a
  `WORKTREE_ROOT` path and an adopted worktree a project records;
  `loadRecentDirs` filtering both kinds out of a file written before the
  filter existed, without rewriting it
- `server/src/autoGuard.worktree.test.ts` — the two new `BASH_RULES` entries
- `server/src/sessions.worktree.test.ts` — a worktree session spawns with
  `cwd` = the worktree path and no `additionalDirectories` key at all

## Business rules

- Attribution, not capability: a worktree session's project tab widens (it now
  shows in the parent's tab), but its roots never do — `projectRoots` must never
  return a worktree path.
- A worktree path never appears in the "+" menu's Recent list, on write or on
  read. `worktreeCommands.register` skips `addRecentDir` for a Lines-created
  worktree; `server/src/store.ts`'s `addRecentDir`/`loadRecentDirs` filter every
  path under `WORKTREE_ROOT` plus every worktree path any project records —
  which also catches one adopted from outside Lines — so a `recent-dirs.json`
  written before this filter existed cleans itself up on the next read, with no
  migration. Opening a worktree as its own tab would double-count every session
  in it, since it resolves to the parent's project key.
- One path, one owner, and no nesting, extending the rule
  [multi-root-projects](multi-root-projects.md) already applies to roots.
- A per-session worktree starts detached; its branch is cut once the session's
  auto-title resolves, never renamed after. A worktree the user named explicitly
  (the tab menu) gets its branch immediately — there's no title to wait for.
- Every branch Lines mints on its own initiative is namespaced `lines/…`
  (`LINES_BRANCH_PREFIX`), so `git branch` says who made it. A branch the user
  typed into the create form is untouched.
- Removal is always explicit; `git branch -d` only when asked, and only for a
  branch `createdByLines`. Never `-D` — an unmerged branch must surface git's
  refusal rather than being force-deleted behind a checkbox.
- Removal is refused while any non-archived session's `cwd` is inside the
  worktree, unless `force`.
- Deleting or archiving a session never touches its worktree — the record just
  renders "orphaned" in the tab menu, one click from Remove.
- Git is the source of truth; `Project.worktrees` is a cache reconciled on
  `openProject`. A worktree created outside Lines (an agent's own
  `git worktree add`) is adopted without `createdByLines`, so removal never
  offers to delete a branch Lines didn't create.
- Explicit create fails on a taken path/branch; the per-session auto path
  uniquifies (`-2`, `-3`…) instead, since the user named nothing to fail on.
- A managed worktree (under `WORKTREE_ROOT`) is never added to the recent-
  directories list — offering it there would invite opening it as its own
  project tab, which double-counts every session in it (it resolves to the
  parent's project key, not its own).

## Architectural rules

- `runGit` (throws, stderr in the message) is for mutating git only; the
  existing `git()` (swallows every failure to `''`, needed by `diff --no-index`)
  stays read-only. Never route a read through `runGit` or a write through `git()`.
- Lines' own worktree operations go through `worktreeCommands`, never Bash, so
  `assessToolCall` never sees them — the two new `BASH_RULES` entries govern only
  an agent running git itself.
- `WorktreeDeps` (`run`, `repoRoot`, `ensureParent`) is the one seam every
  command function takes, mirroring `GitRun` in `worktrees.ts` — a test needs
  neither a real repo nor to touch `~/.lines-app`.
- `defaultWorktreePath` groups by repo basename under `WORKTREE_ROOT`, not by
  full repo path, so a collision (two repos sharing a name) is resolved by the
  existing uniquifier rather than a second naming scheme.
- `SessionManager.onAutoNamed` is a callback, not a direct call from
  `sessions.ts` into `worktreeCommands.ts` — that layer needs a whole
  `UserContext`, which `SessionManager` is only a part of; wired in
  `userContext.ts` exactly as `GuardAllowlist.onChange` is.

## Related decisions

- [multi-root-projects](multi-root-projects.md) — the root/attribution model a
  worktree extends without widening
- [multi-repo-commits](multi-repo-commits.md) — `--show-toplevel` inside a
  linked worktree returns the worktree itself, so a worktree session is exactly
  one commit unit
- [permissions-and-plan-mode](permissions-and-plan-mode.md) — the auto-mode
  guard the two new `BASH_RULES` entries extend
- [app-data-root](app-data-root.md) — `WORKTREE_ROOT`
- [session-and-project-ui](session-and-project-ui.md) — `worktreePending`, the
  `pendingCreate` re-arm, and the `actionError` fix for server-side refusals
