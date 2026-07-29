# Project tab status dot

## Purpose

Each project tab in the header shows the single most important actionable status across that
project's sessions as a colored pulsing dot in place of the folder icon, so a background
project working across multiple repos can signal it needs attention without opening it. The
open (active) project's tab always shows the plain folder icon — its sessions are already
listed in the sidebar.

## Entry points

- `web/src/components/ProjectTabs.tsx` — the tab row shown in the app header

## Important files

- `web/src/lib/format.ts` — `projectStatusMeta`, `PROJECT_STATUS_ORDER`/`PROJECT_STATUS_RANK`,
  `sessionRowMeta` (reused, see [session-status-badge](session-status-badge.md))
- `web/src/components/ProjectTabs.tsx` — `ProjectTab` folder/dot swap and tooltip
- `web/src/store.ts` — `sessionsInProject`, `seenSessionStatus`, `reconcileSeenStatus`

## Important symbols

- `projectStatusMeta(sessions, seen)` — scans a project's sessions, skips archived and
  non-actionable ones and any `(sessionId, label)` pair already in `seen`, and returns the
  highest-priority remaining `{ color, label }`, or `null` if nothing qualifies
- `PROJECT_STATUS_ORDER` / `PROJECT_STATUS_RANK` — cross-status priority table built from the
  same `waitingPermissionMeta`/`STATUS_META` entries `sessionRowMeta` uses, so a tab dot can
  never drift from the sidebar dot it points at
- `sessionsInProject(sessions, projectKeys, project)` — sessions belonging to a given project
  (by project key, falling back to exact cwd match); shared with the sidebar
- `seenSessionStatus` (store field) — session id to the `sessionRowMeta` label the user has
  already acknowledged for that session
- `reconcileSeenStatus` — recomputes `seenSessionStatus` whenever sessions, project keys, or
  the active project change

## Data flow

`ProjectTab` reads `sessions`, `projectKeys`, and `seenSessionStatus` from the store and, for
every non-active tab, calls `projectStatusMeta(sessionsInProject(...), seenSessionStatus)` in
its render body to decide folder icon vs. status dot. A `useStore.subscribe` listener
recomputes `seenSessionStatus` on any relevant state change via `reconcileSeenStatus`: every
actionable session belonging to the currently active project is marked seen; any other
session's entry is dropped the instant it stops being actionable, so a later relapse to the
same status reads as new again.

## Dependencies

None beyond the existing `.status-dot` CSS (`web/src/index.css`) and Mantine theme colors
(`sandstone`, `violet`, `teal`, `yellow`, `red`).

## Tests

None. `web/` has no test runner; `sessionRowMeta` itself is untested (see
[session-status-badge](session-status-badge.md)).

## Business rules

- Priority, highest first: plan ready (violet) > needs answer (teal) > needs approval
  (sandstone) > needs permission (yellow) > interrupted (yellow) > error (red).
- `running` / `done` / `idle` never show a dot (not actionable) — folder icon.
- A finished workflow (see [workflow-done-session-indicator](workflow-done-session-indicator.md))
  never surfaces on a project tab: it is not actionable, so it never reaches
  `projectStatusMeta`. Only the sidebar row shows the filled checkmark.
- Archived sessions are excluded.
- A session status not in the priority table is skipped rather than guessed at.
- The active project's tab always shows the plain folder icon (render-time suppression, no
  extra state for this rule alone).
- Opening a project marks every actionable session in it "seen"; its tab stays quiet after
  leaving unless a session reaches an actionable status it hasn't already been seen in. A
  session that resolves and later relapses to the same status counts as new again.
- `seenSessionStatus` is in-memory only — a page reload clears it, so already-acknowledged
  dots can reappear once after a reload.

## Architectural rules

- `format.ts` never imports `store.ts`; `projectStatusMeta` takes plain `SessionMeta[]` and a
  seen map so the existing one-way dependency (`store.ts` importing `lib/alerts`, `lib/format`)
  is preserved.
- `seenSessionStatus` is maintained in one place (a single store subscription), not scattered
  across every mutation site that could change what counts as seen.
- `completed` needs no separate guard in `projectStatusMeta`: the server always sets
  `completed` and `archived` together, so excluding `archived` already excludes it.

## Related decisions

- [session-status-badge](session-status-badge.md)
- [interrupted-turn-recovery](interrupted-turn-recovery.md)
- [workflow-done-session-indicator](workflow-done-session-indicator.md)
