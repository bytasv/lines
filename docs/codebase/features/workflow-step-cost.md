# Workflow step cost

## Purpose

Shows per-step USD spend and token spend in the workflow stepper, so users can see which step of a running workflow is expensive without opening the transcript.

## Entry points

- `web/src/components/WorkflowStepper.tsx` (cost label and token icon next to each step name)

## Important files

- `shared/types.ts` — `WorkflowState.stepCostsUsd`, `WorkflowState.stepTokens`
- `server/src/sessions.ts` — sets `SessionMeta.lastTokens` per turn
- `server/src/workflows.ts` — `WorkflowEngine.onWorkflowTurnComplete` (accumulates both)
- `web/src/components/WorkflowStepper.tsx` — renders the amount and the token tooltip

## Important symbols

- `WorkflowState.stepCostsUsd` — `number[]` indexed by step position, cumulative across retries
- `WorkflowState.stepTokens` — `number[]` indexed by step position, cumulative across retries
- `SessionMeta.lastTokens` — tokens spent by the most recent turn (input + output + cache), same composition as `totalTokens`
- `WorkflowEngine.onWorkflowTurnComplete` — adds `meta.lastCostUsd` onto `stepCostsUsd[stepIndex]` and `meta.lastTokens` onto `stepTokens[stepIndex]` each time a workflow turn completes

## Data flow

SDK `result` message → `SessionMeta.lastCostUsd` / `SessionMeta.lastTokens` (existing accumulation in `server/src/sessions.ts`) → read by `onWorkflowTurnComplete` and added onto `WorkflowState.stepCostsUsd[stepIndex]` / `WorkflowState.stepTokens[stepIndex]` → persisted on `SessionMeta` upsert → `WorkflowStepper` renders `stepCostsUsd[i]` as a `$X.XX` label and `stepTokens[i]` as a coin icon with a "N tokens spent" tooltip.

## Dependencies

None beyond the existing `SessionMeta.lastCostUsd` / `totalTokens` accumulation ([[session-sidebar-usage]] uses the sibling `totalCostUsd`/`totalTokens` fields the same way).

## Tests

None. No test infrastructure covers `WorkflowStepper` rendering at time of writing.

## Business rules

- Cost shown as `$X.XX` (2 decimals) next to the step name; hidden entirely for a step whose accumulated cost is zero or unset.
- Token icon (coin) shown next to the cost label with a "N tokens spent" tooltip (locale-formatted); hidden entirely for a step whose accumulated tokens are zero or unset.
- Retries and auto-advance turns on the same step add onto the same array slot rather than overwriting it, for both cost and tokens.

## Architectural rules

- Reuses the existing per-turn `lastCostUsd` accumulation on `SessionMeta` (same source `onWorkflowTurnComplete` already reads for step logic) instead of adding a new cost-tracking path.
- Tokens follow the identical pattern via a new `SessionMeta.lastTokens` field, mirroring `lastCostUsd` rather than introducing a separate tracking mechanism.

## Related decisions

None.
