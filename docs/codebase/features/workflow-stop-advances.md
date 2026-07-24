# Workflow stop advances

## Purpose

Pressing Stop while a workflow step is running marks the step done and automatically advances to the next step, instead of parking at `waiting-approval` and requiring a manual Approve.

## Entry points

- `web/src/components/Composer.tsx` (stop button, sends `interrupt`)
- `server/src/sessions.ts` (`SessionManager.interrupt`)
- `server/src/workflows.ts` (`WorkflowEngine.onWorkflowTurnComplete`)

## Files

- `shared/types.ts` (`WorkflowState.advanceOnComplete`, `WorkflowMarkerData.event`)
- `server/src/sessions.ts`
- `server/src/workflows.ts`
- `web/src/components/Transcript.tsx` (`WorkflowMarker`)
- `web/src/components/Composer.tsx`

## Symbols

- `SessionManager.interrupt`
- `SessionManager.interrupting` (in-flight interrupt set)
- `SessionManager.handleWorkerEnded` (ended-without-result fallback)
- `WorkflowState.advanceOnComplete` (`boolean | 'interrupted'`)
- `WorkflowEngine.onWorkflowTurnComplete`

## Data flow

`interrupt()` detects a live workflow step (`stepStatuses[stepIndex] === 'running'` and `turnSource === 'workflow'`) and sets `advanceOnComplete = 'interrupted'` before interrupting the worker. The engine never advances synchronously — it waits for the turn to settle (SDK `result`, or `ended` without `result` via the `interrupting`-gated fallback in `handleWorkerEnded`), then `onWorkflowTurnComplete` consumes the flag, emits an `'interrupted'` transcript marker, and calls `advance()`.

## Tests

None (repo has typecheck only). Manual verification via the `verify` skill.

## Business rules

- Plain Stop during a running workflow step always advances; there is no toggle or separate button.
- A user prompt sent after Stop but before the interrupted turn settles clears the `'interrupted'` flag (the user chose to keep working on the step).
- The step's output hand-off (`{previous}`, `outputName`) goes through the same consolidation as a normal advance (see [workflow-step-output-consolidation](workflow-step-output-consolidation.md)) — only a single-turn interrupted step still hands off the raw last-said text verbatim, since consolidation is a no-op there.
- Deny-pending-permissions and queue-pause semantics of interrupt are unchanged; queued messages stay held until the next explicit user send.

## Architectural rules

- Never advance a workflow synchronously on interrupt — the old query's late `result` would clobber the next step's turn. Always flag-and-wait via `advanceOnComplete`.
- The `handleWorkerEnded` settle fallback must stay gated on the `interrupting` set: non-error `ended` events are routine (fresh-start step boundaries close the old query).

## Related decisions

None.
