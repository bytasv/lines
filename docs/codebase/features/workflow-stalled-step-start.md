# Workflow stalled-step start

## Purpose

Give the stepper a way out when a step is left `pending` with nothing running to start it — an advance that died before queuing the step's first turn (a bridge restart mid-advance, an early `runStep` bailout). Without this, the run just sat dead: the previous step showed done, the current step showed its plain number, and nothing in the UI could move it forward.

## Entry points

- `web/src/components/WorkflowStepper.tsx` (`StepIcon` play-icon hover affordance, confirmation modal, status card)
- `server/src/index.ts` (`case 'workflowStartStep'`)
- `server/src/workflows.ts` (`WorkflowEngine.startStep`)

## Files

- `shared/types.ts` (`ClientMessage` variant `workflowStartStep`)
- `server/src/index.ts`
- `server/src/workflows.ts`
- `web/src/components/WorkflowStepper.tsx`
- `web/src/components/ConfirmModal.tsx` (reused, not modified)

## Symbols

- `WorkflowEngine.startStep`
- `WorkflowEngine.runStep`

## Data flow

The stepper derives `stalled = state.started && currentStep.status === 'pending' && !advancing && !stopping && !isSessionActive(session.status)` — true only for the workflow's *current* step, and only when nothing else (a live turn, an in-flight advance, a settling force-advance) is already on its way to starting it. When `stalled`, `StepIcon` shows a play glyph instead of a checkmark on hover, and the status card renders with a **Start step** button; both route through `ConfirmModal` (retitled "Start this step?") before sending `{type: 'workflowStartStep', sessionId, stepIndex}`.

`WorkflowEngine.startStep` re-validates all the same conditions server-side (the client's derived `stalled` is a hint, not authority) before calling `runStep(sessionId, undefined, true)` — the same normal step-entry path an advance uses, so the fresh-start reset and `{previous}`/`{diff}` hand-off behave exactly as they would have if the advance had completed normally.

## Tests

- `server/src/workflows.advance.test.ts` — `startStep` runs a step an advance left pending; is a no-op when the step is `running` (force-advance's territory), when a turn is already live, when an advance is mid-consolidation (`advancing`), and on a stale `stepIndex`; does not run step 0 before the task description (first prompt) has arrived.
- Manual verification via the `verify` skill.

## Business rules

- The affordance only ever targets the workflow's current step, and only while it is genuinely stalled (`pending`, no live turn, no in-flight advance) — it can never be used to skip ahead or re-run a step that already started.
- Starting a stalled step runs it exactly as a normal advance would: same fresh-start behavior, same `{previous}`/`{diff}` hand-off.

## Architectural rules

- `startStep` is a guarded no-op, never a fallback path invoked automatically — the workflow engine does not self-heal a stalled step; a human always presses the button.
- Reuses `runStep`'s existing step-entry behavior rather than duplicating hand-off logic.

## Related decisions

- [workflow-force-advance](workflow-force-advance.md)
