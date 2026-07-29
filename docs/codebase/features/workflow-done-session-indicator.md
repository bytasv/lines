# Sidebar checkmark for fully-completed workflows

## Purpose

Lets a fully-run workflow read as "done" in the sidebar without opening the session. Before
this, a session whose workflow finished every step looked identical to an untouched idle
session — both showed a plain gray `.status-dot`. There is no stored "workflow finished" flag;
the state is derived client-side from the workflow's step statuses.

## Entry points

- Sidebar session row status icon

## Important files

- `web/src/lib/format.ts` — `isWorkflowFinished`
- `web/src/components/Sidebar.tsx` — `SessionRow` icon branch order

## Important symbols

- `isWorkflowFinished(session)` — true when `session.workflow` is present, `started`,
  `stepStatuses` is non-empty, and every entry is `'done'`. Mirrors `advance()`
  (`server/src/workflows.ts`): the final step is set `'done'` with no further `stepIndex`
  bump and no dedicated "finished" flag, so all-`'done'` is the only reliable signal.

## Data flow

`SessionRow` computes `finished = !session.completed && !status.actionable &&
isWorkflowFinished(session)` from the same `SessionMeta` already used for `sessionRowMeta`.
No new message type, no server or store change — purely a render-time derivation from
`session.workflow.stepStatuses`.

## Dependencies

`@tabler/icons-react` `IconCircleCheckFilled` (already an installed icon, no new package).

## Tests

None. No test infrastructure covers `Sidebar.tsx`/`format.ts` at time of writing (see
[session-status-badge](session-status-badge.md)).

## Business rules

Sidebar row icon precedence, first match wins:

1. `session.completed` → green **outline** `IconCircleCheck`, 14px (manual "Mark completed")
2. `session.status === 'running'` → `Loader`
3. `status.actionable` (needs permission / needs answer / needs approval / interrupted /
   error) → pulsing `.status-dot` — always wins over the checkmark, so a session needing the
   user is never masked as "done"
4. `isWorkflowFinished(session)` → green **filled** `IconCircleCheckFilled`, 14px
5. otherwise → plain `.status-dot`

A force-advance ("Mark as completed" on the last running step) also sets the last step
`'done'`, so a force-finished workflow shows the filled check too — intended, not a special
case.

## Architectural rules

`isWorkflowFinished` is kept separate from `sessionRowMeta`'s `{ color, label, actionable }`
return rather than folded in: `projectStatusMeta` (project tab dot) and `alerts.ts`
(notifications) both consume that shape, and workflow-done is not an actionable state, so
folding it in would leak a checkmark into places that only care about things needing the
user's attention.

## Related decisions

- [session-status-badge](session-status-badge.md)
- [project-tab-status-dot](project-tab-status-dot.md)
