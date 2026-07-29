# Workflow force-advance

## Purpose

Manual escape hatch for a workflow step that is stuck (bad implementation, stalled turn, no natural way to reach `waiting-approval`): hovering the current step's icon in the stepper shows a checkmark; clicking it confirms, then marks the step done and moves on. One click always ends with the workflow on the next step (or done) — either immediately, once the interrupted turn settles, or via a watchdog if it never does.

## Entry points

- `web/src/components/WorkflowStepper.tsx` (`StepIcon` hover affordance, confirmation modal)
- `server/src/index.ts` (`case 'workflowForceAdvance'`)
- `server/src/workflows.ts` (`WorkflowEngine.forceAdvance`)

## Files

- `shared/types.ts` (`ClientMessage` variant `workflowForceAdvance`, `WorkflowState.advanceOnCompleteStep`)
- `server/src/index.ts`
- `server/src/workflows.ts`
- `server/src/sessions.ts` (`consolidateStepOutput` timeout, plan-approval stamp sites, user-prompt clear)
- `web/src/components/WorkflowStepper.tsx`
- `web/src/components/ConfirmModal.tsx` (reused, not modified)

## Symbols

- `WorkflowEngine.forceAdvance`
- `WorkflowEngine.approve`
- `WorkflowEngine.onWorkflowTurnComplete`
- `WorkflowEngine.armSettleWatchdog` / `clearSettleWatchdog`
- `WorkflowEngine.forceAdvanceSettleMs`
- `SessionManager.interrupt`
- `SessionManager.consolidateTimeoutMs`
- `WorkflowState.advanceOnCompleteStep`

## Data flow

The stepper only shows the affordance on the *current* step (`i === state.stepIndex`), never on pending/done/other steps. Hovering swaps the icon's glyph to a checkmark without changing the circle's status color; clicking opens `ConfirmModal` before sending anything. On confirm, the client sends `{type: 'workflowForceAdvance', sessionId, stepIndex}`.

`WorkflowEngine.forceAdvance` branches on the step's current status:

- `waiting-approval` — delegates to `approve()` (identical to clicking the existing Approve button).
- `running` with the session actively querying — sets `advanceOnComplete = 'interrupted'` **and** `advanceOnCompleteStep = i`, regardless of `turnSource` (a user-source turn can be live while the step still reads `running` — a worker error skipped the settle, then the user typed — and previously that left the step stranded forever). Then calls `SessionManager.interrupt()` and arms a settle watchdog (`armSettleWatchdog`, `forceAdvanceSettleMs = 5_000` by default, a field so tests can shrink it). The engine advances once the interrupted turn settles (see [workflow-stop-parks](workflow-stop-parks.md)) — a `result`, or an `ended` without one — via `onWorkflowTurnComplete`, which now checks the step stamp (`advanceOnCompleteStep === i`) rather than `turnSource` to decide whether to consume the flag. If neither ever arrives (a wedged worker), the watchdog fires instead: it re-checks the flag/stamp/step/status are all unchanged, clears `turnSource` (so a very late result from the abandoned turn settles source-less and stamp-consumed — a no-op), and calls `advance()` itself.
- `running` with no active query (e.g. the worker died mid-step) — advances immediately; there is no in-flight turn whose late result could clobber the next step.

A stale `stepIndex` (duplicate click, or a second tab showing an older stepper) is ignored the same way `approve()` ignores one. The stamp (`advanceOnCompleteStep`) is what actually enforces "this flag only counts for the step it was raised for" — a settle or watchdog fire for any other index is a no-op, which matters once a later step could itself be `running` by the time a very old turn or timer resolves.

`SessionManager.consolidateStepOutput` (called from `advance()`, see [workflow-step-output-consolidation](workflow-step-output-consolidation.md)) is now bounded by `consolidateTimeoutMs` (60s default) so a hung token refresh or query drain can no longer leave `advance()` parked forever with `advancing` already broadcast — this was the original reported symptom ("step marked completed, no other actions available").

`runStep`'s two silent early returns (unresolved workflow/session, and step index out of range) now call `SessionManager.persistMeta` before returning, so a bumped `stepIndex` and a cleared `advancing` always reach the client instead of riding on a broadcast that never comes (see [workflow-approve-loader](workflow-approve-loader.md)).

When a step is `pending` (never started — an advance died mid-flight before queuing its first turn) the stepper instead shows a play-icon affordance and sends `workflowStartStep`, handled by `WorkflowEngine.startStep`; see [workflow-stalled-step-start](workflow-stalled-step-start.md).

## Tests

- `server/src/workflows.advance.test.ts` — force-advance still advances a running step; force-advance advances even when the live turn isn't the step's own; a user prompt clears the pending flag and its stamp; a flag stamped for an earlier step is not honored; the watchdog advances when the interrupted turn never settles; a late result after the watchdog does not touch the next step; a consolidation that hangs still advances (via the bounded timeout); `advancing` clears on the wire when the workflow vanishes mid-advance.
- Manual verification via the `verify` skill.

## Business rules

- The force-advance affordance only ever targets the workflow's current step; other steps show no hover state.
- Confirmation copy differs by state: a running step warns that its turn is stopped and whatever it last said becomes the step's output; the last step's copy says the workflow finishes instead of naming a next step.
- One click on "Mark as completed" always ends with the workflow on the next step (or done) — via a normal settle, or the watchdog if the turn never settles at all.

## Architectural rules

- Never call `advance()` directly on a `running` step while its turn is still active — set `advanceOnComplete` (+ `advanceOnCompleteStep`) then call `SessionManager.interrupt()`; `interrupt()` no longer implies an advance, per [workflow-stop-parks](workflow-stop-parks.md).
- Whether a settle (or the watchdog) is allowed to consume a pending flag is decided by the `advanceOnCompleteStep` stamp matching the current step index, not by `turnSource` — the turn source only gates the (unrelated) cost/token/duration accumulation.
- The watchdog must clear `turnSource` when it fires, so a late arrival from the abandoned turn is unambiguously ignored by the stamp check rather than racing the next step's own turn.

## Related decisions

- [workflow-stalled-step-start](workflow-stalled-step-start.md)
