# Tool-aware waiting-permission status badge

## Purpose

Distinguishes what kind of pause a `waiting-permission` session is actually in — a plan
awaiting approval, a question awaiting an answer, or a plain tool permission ask — via the
sidebar badge label/color and the OS/browser notification body, instead of a single generic
"needs permission" for all three.

## Entry points

- Sidebar session row status badge
- OS/browser notification fired for a session that enters `waiting-permission`

## Important files

- `shared/types.ts` — `SessionMeta.pendingPermissionTool`
- `server/src/sessions.ts` — `askPermission`, `setStatus`, `reconcileWithWorker`, `adoptSynced`
- `web/src/lib/format.ts` — `waitingPermissionMeta`
- `web/src/components/Sidebar.tsx` — badge label/color lookup
- `web/src/lib/alerts.ts` — notification body text

## Important symbols

- `SessionMeta.pendingPermissionTool` — name of the tool that triggered the current
  `waiting-permission` pause (e.g. `ExitPlanMode`, `AskUserQuestion`); undefined for any other
  status
- `waitingPermissionMeta(tool)` — maps a pending tool name to `{ label, color }`

## Data flow

`askPermission` stamps `SessionMeta.pendingPermissionTool` with the triggering tool name before
calling `setStatus(id, 'waiting-permission')` → persisted/broadcast via the existing
`sessionUpsert` path → `Sidebar` and `alerts.ts` both call `waitingPermissionMeta` to derive the
label/color or notification body from it.

## Dependencies

None beyond existing Mantine `Badge` color props.

## Tests

None. No test infrastructure covers Sidebar/alerts status logic at time of writing.

## Business rules

- `ExitPlanMode` → label "plan ready", violet badge.
- `AskUserQuestion` → label "needs answer", teal badge.
- Any other tool (or no tool recorded) → label "needs permission", yellow badge (unchanged
  default).
- Notification body mirrors the sidebar label (capitalized) for `waiting-permission` sessions.

## Architectural rules

`pendingPermissionTool` rides the existing `sessionUpsert` broadcast — no new message type. It
is cleared centrally in `setStatus` whenever the status leaves `waiting-permission`, plus on the
worker-reconcile and sync-adopt paths that can force a `waiting-permission` session back to
`idle` out from under a live turn, so a stale tool name can never linger into an unrelated
future pause. Concurrent permission asks on the same session: the last `askPermission` call
wins the label/color, consistent with pre-existing status-overwrite behavior — no new race was
introduced.

## Related decisions

None recorded.
