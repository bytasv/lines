# Workflow stalled-step start

## Purpose

Give the stepper a way out when an advance dies mid-flight and leaves the run with no affordance at all. Two shapes, depending on how far `advance()` got before the process went away:

- **`pending` with nothing running** — the advance bumped `stepIndex` but never queued the step's first turn. The previous step shows done, the current step shows its plain number, nothing moves it.
- **`done` at the current index** — the advance marked the step done and then died *inside* `consolidateStepOutput`, before bumping `stepIndex`. This is the nastier one: the durable on-disk state has `stepStatuses[i] === 'done'` while `stepIndex` is still `i`, and every existing gate refuses exactly that shape — `approve`/`retry` want `waiting-approval`, `forceAdvance` wants `running`, `startStep` wants `pending`. Observed in the wild after a consolidation hung ~50 minutes and the bridge restarted under it.

Both are stalls the engine created; a human presses a button to nudge past either.

## Entry points

- `web/src/components/WorkflowStepper.tsx` (`StepIcon` play-icon hover affordance, confirmation modal, status card)
- `server/src/index.ts` (`case 'workflowStartStep'`)
- `server/src/workflows.ts` (`WorkflowEngine.startStep`, `WorkflowEngine.forceAdvance`'s `done` branch)

## Files

- `shared/types.ts` (`ClientMessage` variant `workflowStartStep`)
- `server/src/index.ts`
- `server/src/workflows.ts`
- `web/src/components/WorkflowStepper.tsx`
- `web/src/components/ConfirmModal.tsx` (reused, not modified)

## Symbols

- `WorkflowEngine.startStep`
- `WorkflowEngine.forceAdvance`
- `WorkflowEngine.advance`
- `WorkflowEngine.runStep`

## Data flow

### `pending` — start the step

The stepper derives `stalled = state.started && currentStep.status === 'pending' && !advancing && !stopping && !isSessionActive(session.status)` — true only for the workflow's *current* step, and only when nothing else (a live turn, an in-flight advance, a settling force-advance) is already on its way to starting it. When `stalled`, `StepIcon` shows a play glyph instead of a checkmark on hover, and the status card renders with a **Start step** button; both route through `ConfirmModal` (retitled "Start this step?") before sending `{type: 'workflowStartStep', sessionId, stepIndex}`.

`WorkflowEngine.startStep` re-validates all the same conditions server-side (the client's derived `stalled` is a hint, not authority) before calling `runStep(sessionId, undefined, true)` — the same normal step-entry path an advance uses, so the fresh-start reset and `{previous}`/`{diff}` hand-off behave exactly as they would have if the advance had completed normally.

### `done` at the current index — resume the advance

The stepper derives `resumable = state.started && currentStatus === 'done' && state.stepIndex + 1 < workflow.steps.length && !advancing && !stopping`. Deliberately **not** gated on `isSessionActive(session.status)`: `advance()` never sets a session status, so the status is still whatever preceded the approve — usually the stale `waiting-approval` from the park, which `isSessionActive` counts as active. That gate is exactly what silenced the `stalled` derivation for this shape. `advancing` is the only honest marker of a live advance.

When `resumable`, the card reads *"… is done but the next step never started — continue to resume the hand-off."* with a **Continue → next step** button, and `StepIcon` gets the same play glyph. Both send `{type: 'workflowForceAdvance', …}` — not `workflowStartStep`, since the step is already done and `startStep` would refuse it — and both skip `ConfirmModal`: there is nothing to confirm overriding, unlike the running-step and pending-step paths.

`WorkflowEngine.forceAdvance`'s `done` branch re-enters `advance()`, which re-runs the consolidation (publishing the `{outputs.<name>}` entry the dead advance never wrote), bumps `stepIndex` and starts the next step. It declines three lookalikes: `advancing === true` (a real advance owns the step), the last step being `done` (a finished workflow, not a stall), and a stale `stepIndex` from another tab.

### Preventing the `done` shape

`advance()` now calls `SessionManager.persistMeta` immediately after `stepIndex = i + 1`, instead of leaving the bump to ride `runStep`'s own `setStatus` broadcast. Previously the bump was in-memory only for the whole consolidation window, so the *durable* state throughout it was the unrecoverable `done`-at-current-index shape. Note the write itself is debounced (`PERSIST_DEBOUNCE_MS`, 250ms) like every other status write — this closes the multi-second consolidation window, not the sub-250ms one.

## Tests

- `server/src/workflows.advance.test.ts` — `startStep` runs a step an advance left pending; is a no-op when the step is `running` (force-advance's territory), when a turn is already live, when an advance is mid-consolidation (`advancing`), and on a stale `stepIndex`; does not run step 0 before the task description (first prompt) has arrived.
- `server/src/workflows.advance.test.ts` — the bumped `stepIndex` reaches both the client and disk on its own; force-advance resumes an advance that died before bumping; force-advance leaves a `done` step alone when it is a live advance, a finished workflow, or a stale click.
- Manual verification via the `verify` skill.

## Business rules

- Each affordance only ever targets the workflow's current step, and only while it is genuinely stalled — it can never be used to skip ahead or re-run a step that already started.
- Starting a stalled `pending` step runs it exactly as a normal advance would: same fresh-start behavior, same `{previous}`/`{diff}` hand-off.
- Resuming a stalled `done` step re-runs its consolidation, so the `{outputs.<name>}` entry the dead advance never published is filled in before the next step starts.
- Resuming needs no confirmation dialog — the step is already done, so nothing is being overridden. Starting a `pending` step and force-advancing a `running` one both still confirm.
- The last step reading `done` is a finished workflow, never a stall; it gets no affordance.

## Architectural rules

- Both recoveries are guarded no-ops the user must trigger — the workflow engine does not self-heal a stalled step; a human always presses the button.
- Reuses `runStep`'s existing step-entry behavior (for `pending`) and `advance()`'s (for `done`) rather than duplicating hand-off or consolidation logic.
- A `done`-at-current-index recovery must key off `advancing`, never `isSessionActive(meta.status)`: `advance()` sets no session status, so the status left over from before the approve says nothing about whether an advance is live.
- `advance()` must persist the `stepIndex` bump itself. Leaving it to a later broadcast makes the unrecoverable `done`-at-current-index shape the durable state for the whole consolidation window.

## Related decisions

- [workflow-force-advance](workflow-force-advance.md)
