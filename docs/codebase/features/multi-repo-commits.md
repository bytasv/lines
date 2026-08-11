# Multi-repo commits

## Purpose

Make a workflow step's git hand-off correct once a project spans more than one
folder: group the session's roots into commit units by work tree (not by
project), give a step's `{diff}` a per-repo section, and add a `{roots}` token
so a step's own instructions (e.g. a commit step) can learn the workspace shape
and scope every `git` call with `-C <repo root>` — because
`additionalDirectories` (see [multi-root-projects](multi-root-projects.md))
grants file-tool access but never moves the Bash shell out of the session's
primary `cwd`.

## Entry points

- `server/src/workflows.ts` (`WorkflowEngine.runStep`, `captureDiffBaseline`)
- A step's own prompt template — `{roots}` and per-repo `{diff}` are visible only
  to whatever the template does with them (e.g. the user-authored `Commit Agent`
  step)

## Important files

- `server/src/git.ts` — `repoRoot`, `repoBranch`, `groupByRepo`, `RepoGroup`,
  `captureBaseline`/`captureBaselines`, `workingTreeDiff`, `multiRepoDiff`
- `server/src/workflows.ts` — `rootsFor`, `baselinesFor`, `renderWorkspace`,
  `renderRoots`, `TOKEN_RE`, `USES_ROOTS_RE`, `usesHandoffTokens`,
  `substituteTokens`
- `shared/types.ts` — `WorkflowState.diffBaselines` (per-repo), the deprecated
  single `WorkflowState.diffBaseline`

## Important symbols

- `groupByRepo(roots)` — groups session roots into commit units by
  `git rev-parse --show-toplevel`: two roots inside one work tree collapse to
  one `RepoGroup`; two separate checkouts become two; a non-repo root is
  returned in `orphans`, never as a commit unit. The group holding `roots[0]`
  (the primary) comes first.
- `captureBaselines(roots)` — one `DiffBaseline` per commit unit (`repo` field
  added), taken via the same non-destructive `git stash create` snapshot as the
  single-root path
- `multiRepoDiff(baselines)` — per-repo `{diff}`: a single repo emits no
  `# repo:` header (byte-identical to `workingTreeDiff`); two or more repos share
  one `MAX_DIFF_CHARS` budget across a two-pass split (see Business rules)
- `renderRoots(repos, orphans, branches, cwd)` — formats the `{roots}` block:
  every root, which repo (and branch) it belongs to or "not a git repository",
  and an explicit `git -C <repo root>` instruction
- `usesHandoffTokens(template)` — still tests only `{previous}`/`{diff}`/
  `{outputs.*}`; `{roots}` is deliberately excluded, since it is static workspace
  shape, not hand-off content

## Data flow

`captureDiffBaseline` (fired once, fire-and-forget, from `startIfPending`) calls
`groupByRepo(rootsFor(meta.cwd))` and takes one baseline per commit unit into
`meta.workflow.diffBaselines`.

On entering a fresh-start step with a predecessor, `runStep` resolves `{diff}`
via `multiRepoDiff(baselinesFor(meta))`. `{roots}` is resolved independently —
`groupByRepo` plus a `repoBranch` lookup per commit unit — and only when the
step's template actually contains the token (a cheap regex test gates the extra
git calls); unlike `{diff}` it is **not** gated on `handoff`, so it also works in
a step that inherits the conversation rather than resetting it.

`baselinesFor(meta)` prefers `diffBaselines`; if absent it wraps a legacy single
`diffBaseline` as one unit rooted at the session's own `cwd` (exactly what it was
captured against), so a workflow already in flight across a deploy keeps a
correct diff instead of silently falling back to `HEAD`.

## Dependencies

- `git rev-parse --show-toplevel` / `--abbrev-ref HEAD`, both new primitives in
  this repo (`server/src/git.ts`), timeboxed by the shared `git()` helper's
  timeout.
- [Multi-root projects](multi-root-projects.md) for `rootsFor`/`rootsForCwd`.
- The guard's Bash branch (`autoGuard.ts`) never inspects `cwd`/`roots` at all —
  `git -C <other-repo-root> commit`/`add` already auto-approve in `auto` mode
  with no change needed here. Only `git push --force`/a deploy-branch push are
  gated; a plain `git push` to any repo still auto-approves (see Risks below).

## Tests

None yet for this pass; static (`tsc --noEmit`) verified. Behavior spot-checked
manually: two roots in one repo collapse to one commit unit and two roots in
separate repos yield two; a single-repo `{diff}` is byte-identical to
`workingTreeDiff` with no `# repo:` header; an untracked file created after the
baseline lands only in its own repo's section; the split budget redistributes an
unused share to a repo that overflowed its equal share, and marks each
truncation.

## Business rules

- Commit units come from `git rev-parse --show-toplevel`, never from
  `resolveProjectKey` — that key's `--show-prefix` component deliberately keeps
  monorepo siblings apart, the opposite of grouping them into one commit.
- Two roots that resolve to the same work tree are one commit unit; two separate
  work trees are two.
- A root that isn't inside any git work tree is never a commit unit (surfaced as
  an orphan in `{roots}` — "not a git repository" — with no baseline captured).
- `{roots}` is not a hand-off token: a template using only `{roots}` (with
  `freshStart` on) still gets the normal `{previous}`/`{diff}` auto-prepend.
- A single repo produces no `# repo:` header in `{diff}` — existing single-root
  workflows see byte-identical prompts.
- The `MAX_DIFF_CHARS` budget for `{diff}` is shared across every commit unit,
  not multiplied by the repo count: each repo first gets an equal share; any
  share left unused by a repo that fit is redistributed evenly to repos that
  overflowed theirs, and each still-truncated repo keeps its own
  `# … truncated at N chars` marker.

## Architectural rules

- Repo-grouping/diff logic (`git.ts`) stays pure git, with no prompt formatting;
  `{roots}`'s Markdown rendering (`renderRoots`) lives in `workflows.ts`.
- The shared `git()` helper in `git.ts` now has a timeout — a hung `git` call
  would otherwise stall step entry once per root, on the same path the user
  waits through at every approval gap.
- `diffBaselines` is additive alongside the deprecated `diffBaseline` (both live
  inside `WorkflowState`, which rides inside the synced `SessionMeta`): writers
  only ever set `diffBaselines`; the legacy field is read-only, kept solely so a
  workflow already running across the deploy doesn't regress to a `HEAD` diff.
- `MAX_UNTRACKED` (new-file cap per diff) is per repo, not per workflow.

## Related decisions

- [multi-root-projects](multi-root-projects.md)
- [workflow-step-lifecycle](workflow-step-lifecycle.md) —
  owns the rest of `substituteTokens`/`usesHandoffTokens`

## Risks / open items

Deliberately not addressed in this pass (see the corresponding plan review):

- `git push` still auto-approves for any repo in reach; only force-push and a
  deploy-branch push are gated. A wrong-repo commit is recoverable, a wrong-repo
  push is not — left as separate hardening since it would change guard behavior
  for every existing single-root session too.
- An empty repo (no commits yet) still falls back to diffing against `HEAD`,
  which doesn't exist, and yields `''` for tracked changes (untracked files still
  show via `--no-index`). Pre-existing gap, more repos make it more likely to be
  hit; the empty-tree hash is the known fix, not yet applied.
