# Multi-repo commits

## Purpose

Let a workflow step work out the git shape of a session whose project spans more
than one folder: group the session's roots into commit units by work tree (not by
project), and expose that shape to the step through a `{roots}` prompt token. The
step can then scope every `git` call with `-C <repo root>` — because
`additionalDirectories` (see [multi-root-projects](multi-root-projects.md))
grants file-tool access but never moves the Bash shell out of the session's
primary `cwd`.

## Entry points

- `server/src/workflows.ts` (`WorkflowEngine.renderWorkspace`, `runStep`)
- A step's own prompt template — `{roots}` is visible only to whatever the
  template does with it (e.g. the user-authored `Commit Agent` step)

## Important files

- `server/src/git.ts` — `repoRoot`, `repoBranch`, `groupByRepo`, `RepoGroup`
- `server/src/workflows.ts` — `rootsFor`, `renderWorkspace`, `renderRoots`,
  `TOKEN_RE`, `USES_ROOTS_RE`, `usesHandoffTokens`, `substituteTokens`
- `shared/types.ts` — `StepContent`, which documents the hand-off tokens

## Important symbols

- `groupByRepo(roots)` — groups session roots into commit units by
  `git rev-parse --show-toplevel`: two roots inside one work tree collapse to
  one `RepoGroup`; two separate checkouts become two; a non-repo root is
  returned in `orphans`, never as a commit unit. The group holding `roots[0]`
  (the primary) comes first.
- `renderRoots(repos, orphans, branches, cwd)` — formats the `{roots}` block:
  every root, which repo (and branch) it belongs to or "not a git repository",
  and an explicit `git -C <repo root>` instruction
- `usesHandoffTokens(template)` — tests only `{previous}` and `{outputs.*}`;
  `{roots}` is deliberately excluded, since it is static workspace shape, not
  hand-off content

## Data flow

`runStep` checks whether the template contains `{roots}` (a cheap regex test).
Only then does `renderWorkspace` call `groupByRepo(rootsFor(meta.cwd))` plus a
`repoBranch` lookup per commit unit. The block is resolved independently of the
fresh-start hand-off, so it also works in a step that inherits the conversation
rather than resetting it.

## Dependencies

- `git rev-parse --show-toplevel` / `--abbrev-ref HEAD`, run through the shared
  `git()` helper in `git.ts`, bounded by its timeout.
- [Multi-root projects](multi-root-projects.md) for `rootsFor`/`rootsForCwd`.
- The guard's Bash branch (`autoGuard.ts`) never inspects `cwd`/`roots` at all —
  `git -C <other-repo-root> commit`/`add` already auto-approve in `auto` mode
  with no change needed here. Only `git push --force`/a deploy-branch push are
  gated; a plain `git push` to any repo still auto-approves (see Risks below).

## Tests

None yet.

## Business rules

- Commit units come from `git rev-parse --show-toplevel`, never from
  `resolveProjectKey` — that key's `--show-prefix` component deliberately keeps
  monorepo siblings apart, the opposite of grouping them into one commit.
- Two roots that resolve to the same work tree are one commit unit; two separate
  work trees are two.
- A root that isn't inside any git work tree is never a commit unit (surfaced as
  an orphan in `{roots}` — "not a git repository").
- `{roots}` is not a hand-off token: a template using only `{roots}` (with
  `freshStart` on) still gets the normal `{previous}` auto-prepend.

## Architectural rules

- Repo-grouping logic (`git.ts`) stays pure git, with no prompt formatting;
  `{roots}`'s Markdown rendering (`renderRoots`) lives in `workflows.ts`.
- The shared `git()` helper has a timeout — a hung `git` call would otherwise
  stall step entry once per root, on the path the user waits through at every
  approval gap.

## Related decisions

- [multi-root-projects](multi-root-projects.md)
- [workflow-step-lifecycle](workflow-step-lifecycle.md) —
  owns the rest of `substituteTokens`/`usesHandoffTokens`

## Risks / open items

- `git push` still auto-approves for any repo in reach; only force-push and a
  deploy-branch push are gated. A wrong-repo commit is recoverable, a wrong-repo
  push is not — left as separate hardening since it would change guard behavior
  for every existing single-root session too.
