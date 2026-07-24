# Workflow step cost

## Purpose

Shows per-step USD spend in the workflow stepper, so users can see which step of a running workflow is expensive without opening the transcript.

## Entry points

- `web/src/components/WorkflowStepper.tsx` (cost label next to each step name)

## Important files

- `shared/types.ts` — `WorkflowState.stepCostsUsd`
- `server/src/workflows.ts` — `WorkflowEngine.onWorkflowTurnComplete` (accumulates)
- `web/src/components/WorkflowStepper.tsx` — renders the amount

## Important symbols

- `WorkflowState.stepCostsUsd` — `number[]` indexed by step position, cumulative across retries
- `WorkflowEngine.onWorkflowTurnComplete` — adds `meta.lastCostUsd` onto `stepCostsUsd[stepIndex]` each time a workflow turn completes

## Data flow

SDK `result` message → `SessionMeta.lastCostUsd` (existing accumulation in `server/src/sessions.ts`) → read by `onWorkflowTurnComplete` and added onto `WorkflowState.stepCostsUsd[stepIndex]` → persisted on `SessionMeta` upsert → `WorkflowStepper` renders `stepCostsUsd[i]`.

## Dependencies

None beyond the existing `SessionMeta.lastCostUsd` accumulation ([[session-sidebar-usage]] uses the sibling `totalCostUsd` field the same way).

## Tests

None. No test infrastructure covers `WorkflowStepper` rendering at time of writing.

## Business rules

- Cost shown as `$X.XX` (2 decimals) next to the step name; hidden entirely for a step whose accumulated cost is zero or unset.
- Retries and auto-advance turns on the same step add onto the same array slot rather than overwriting it.

## Architectural rules

- Reuses the existing per-turn `lastCostUsd` accumulation on `SessionMeta` (same source `onWorkflowTurnComplete` already reads for step logic) instead of adding a new cost-tracking path.

## Related decisions

None.
