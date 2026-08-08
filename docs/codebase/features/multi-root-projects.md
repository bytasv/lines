# Multi-root projects

## Purpose

Let one project tab span more than one folder — e.g. two sibling checkouts, or a
checkout plus a scratch directory — so every session created in that tab can
read and write in all of them with the same auto-approve behavior it already has
in the primary folder, and so the file tree, `@mention`, and `/find` all see
every root.

## Entry points

- `web/src/components/ProjectTabs.tsx` — per-tab "Add folder…" / remove-folder menu
- `web/src/components/Sidebar.tsx` — one file tree per root

## Important files

- `shared/types.ts` — `Project`, `normalizeRootPath`, `projectRoots`, `findProject`,
  `rootsForCwd`; the `hello.projects` / `{type:'projects'}` wire shape;
  `addProjectRoot` / `removeProjectRoot` client messages
- `server/src/store.ts` — `sanitizeProjects`, the one-shot `projects.json`
  migration from the pre-multi-root `string[]` form (see
  [app-data-root](app-data-root.md))
- `server/src/autoGuard.ts` — `assessToolCall`/`isSafeReadOnly`/`isSafePlanWrite`
  take `roots: string[]` instead of a single `cwd`; `isInsideAny`, `isPlanPath`
- `server/src/sessions.ts` — `SessionManager.rootsFor`, `additionalDirectories` in
  `buildQueryOptions`
- `server/src/index.ts` — `workspaceRoots`, `resolveWorkspacePath`,
  `resolveWorkspaceParam`, the `addProjectRoot`/`removeProjectRoot` handlers,
  multi-root `/find`
- `server/src/fileSearch.ts` — `searchFilesAcross`, `FileHit`
- `server/src/recipeCommands.ts`, `server/src/userContext.ts` — root-aware cwd
  membership checks
- `web/src/store.ts` — `projects: Project[]`, `sessionsInProject`, `projectAt`,
  `latestSessionIn`, `folderPickTarget`
- `web/src/lib/files.ts`, `web/src/lib/mentions.ts` — multi-root `@mention`/`/find`
- `web/src/components/MentionAutocomplete.tsx`, `MentionInput.tsx`,
  `Composer.tsx`, `MonacoPreviewModal.tsx`

## Important symbols

- `Project { path, extraRoots? }` — `path` is the project's identity (tab key,
  `activeProject`, every session's `cwd`, the project-key anchor); `extraRoots`
  never contains `path`
- `rootsForCwd(projects, cwd)` — every root a session at `cwd` may touch: its
  project's roots (primary first) if `cwd` belongs to one, else `[cwd]`; never
  empty
- `SessionManager.rootsFor(meta)` — resolves roots at use time from the live
  projects list, never snapshotted onto `SessionMeta`, so adding a root applies
  to a session's existing (already-spawned) query
- `searchFilesAcross(roots, query, limit)` — one global ranking pass across every
  root instead of per-root searches merged afterwards, so a strong hit in a
  non-primary root still outranks a weak hit in the primary one; root order is an
  explicit tiebreak

## Data flow

The SDK's own `additionalDirectories` option carries the extra roots:
`buildQueryOptions` keeps `cwd` as the session's own root (so `settingSources`
and `CLAUDE.md` resolution stay anchored there) and adds
`additionalDirectories: roots.filter(r => r !== cwd)` — but only grants *file-tool*
access; it does not move the Bash shell (see
[multi-repo-commits](multi-repo-commits.md)).

The guard resolves `roots` fresh on every `PreToolUse`/`canUseTool` call via
`rootsFor(meta)`, so a root added mid-turn is honored by the very next tool call
— no session restart needed. `recycleIdleQueries()` still restarts non-busy
queries so their next push actually carries the new `additionalDirectories`.

`addProjectRoot` (`{project, path}`) validates the new root exists, rejects it if
it already belongs to any project (including as another project's primary), and
rejects nesting with an existing root of the same project, before appending to
`extraRoots` and broadcasting the updated `projects` list.

## Dependencies

- The SDK's `additionalDirectories` query option.
- `git rev-parse --show-toplevel` grouping for commits — see
  [multi-repo-commits](multi-repo-commits.md), a separate concern from root
  membership.
- Deliberately does **not** reuse `resolveProjectKey`
  (`server/src/projectKeys.ts`) for root membership: that key embeds
  `--show-prefix` precisely so sibling packages in one monorepo stay *distinct*
  projects across machines, the opposite of what one workspace tab needs.

## Tests

None yet for this pass; static (`tsc --noEmit`) verified across `server`, `web`,
`storage`.

## Business rules

- The primary path (`path`) is the project's sole identity; extra roots widen
  what its sessions may read/write, but every session's `cwd` stays the primary.
- Writes in an extra root auto-approve in `auto` mode exactly like the primary;
  the sensitive-path override (`~/.ssh`, `~/.aws`, `.env`) still wins regardless
  of which root a path resolves under.
- One root belongs to exactly one project; roots may not nest within a project.
- An empty roots list escalates every file tool — the guard fails toward
  prompting, never toward silently trusting nothing.
- `@mention`'s feature provider stays primary-root-only (`docs/codebase/index.json`
  is read from the primary checkout); only the file provider is multi-root.
- Removing a root only narrows what the project's sessions may reach; nothing on
  disk is touched, and the learned project key for that path is kept (the
  registry never forgets a resolved identity).

## Architectural rules

- Roots are resolved at use time from the project record (`rootsForCwd`), never
  snapshotted onto `SessionMeta` — `SessionMeta` is synced (Prisma `Session.data`
  JSON) and must keep its existing shape.
- `additionalDirectories` is omitted (not `[]`) for a single-root project, so a
  single-root session's serialized query options stay byte-identical to before
  this feature.
- The guard's three exported functions take `roots: string[]`, not an optional
  5th parameter after `cwd` — an optional param would leave two sources of truth
  and a silently-narrow default for any caller that forgot it.
- `projects.json` stays local-only (never synced); only the resolved project-key
  map is synced, so a machine that can't see a given root still groups its
  sessions correctly once it has learned the key.

## Related decisions

- [multi-repo-commits](multi-repo-commits.md)
- [prompt-mentions](prompt-mentions.md)
- [plan-file-auto-approve](plan-file-auto-approve.md)
- [app-data-root](app-data-root.md)
- [project-tab-status-dot](project-tab-status-dot.md)
- [project-switch-session-selection](project-switch-session-selection.md)
