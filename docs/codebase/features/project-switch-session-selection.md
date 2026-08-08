# Project switch session selection

## Purpose

Decide which session is shown when the active project changes (tab click, `hello`/reconnect,
or a `/session/<id>` deep link): keep an already-valid selection, or auto-select that project's
most recently created *non-archived* session. Never auto-open an archived session — those stay
reachable only via the sidebar's "Archived (N)" group.

## Entry points

- `web/src/components/ProjectTabs.tsx` — tab click
- `web/src/lib/ws.ts` — `openProject` (server-initiated project switch)
- `web/src/App.tsx` — URL deep-link effect

## Important files

- `web/src/store.ts` — `setActiveProject`, `latestSessionIn`, `sessionsInProject` (shared)

## Important symbols

- `setActiveProject(path)` — single entry point for changing the active project; all three
  entry points above call it
- `latestSessionIn(sessions, projectKeys, project)` — most recently created (`createdAt`)
  non-archived session in a project, or `undefined`
- `sessionsInProject(sessions, projectKeys, project)` — shared, key-aware project membership
  (see [project-tab-status-dot](project-tab-status-dot.md))

## Data flow

`setActiveProject` first checks whether the currently selected session already belongs to the
target project (via `sessionsInProject`, so a keyed project matches across machines with
different absolute paths). If so, the selection is left alone — including an archived session,
so a deep link to it survives a tab switch. Otherwise it auto-selects via `latestSessionIn`,
which falls back to `null` (empty state) when the project has no non-archived sessions.

## Dependencies

None beyond `sessionsInProject`.

## Tests

None. `web/` has no test runner; verified manually.

## Business rules

- Auto-selection (no valid current selection in the target project) always excludes archived
  sessions; `completed` needs no separate check since the server always archives alongside it.
- A project whose sessions are all archived auto-selects nothing (empty state) rather than
  opening an archived one.
- An explicit selection already in the target project — including an archived session opened
  via the sidebar's Archived group or a deep link — is never overridden by a tab switch.
- Sort key for "most recent" is `createdAt`, matching the sidebar list order (`SessionMeta` has
  no separate last-activity field).

## Architectural rules

- Membership check reuses `sessionsInProject` rather than an inline `cwd` comparison, so it
  stays key-aware like every other project-scoped scan (`reconcileSeenStatus`,
  `projectStatusMeta`, the sidebar list).

## Related decisions

- [project-tab-status-dot](project-tab-status-dot.md)
