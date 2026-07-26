# Workflow step cost

## Purpose

Shows per-step USD spend, token spend, and active-turn duration in the workflow stepper, so users can see which step of a running workflow is expensive or slow without opening the transcript.

## Entry points

- `web/src/components/WorkflowStepper.tsx` (cost label, token icon, and duration label in a metrics row below each step name)

## Important files

- `shared/types.ts` — `WorkflowState.stepCostsUsd`, `WorkflowState.stepTokens`, `WorkflowState.stepDurationsMs`
- `server/src/sessions.ts` — sets `SessionMeta.lastTokens` / `SessionMeta.lastDurationMs` per turn
- `server/src/workflows.ts` — `WorkflowEngine.onWorkflowTurnComplete` (accumulates all three)
- `web/src/components/WorkflowStepper.tsx` — renders the amount, the token tooltip, and the duration
- `web/src/lib/format.ts` — `formatDuration`

## Important symbols

- `WorkflowState.stepCostsUsd` — `number[]` indexed by step position, cumulative across retries
- `WorkflowState.stepTokens` — `number[]` indexed by step position, cumulative across retries
- `WorkflowState.stepDurationsMs` — `number[]` indexed by step position, cumulative active-turn duration across retries; excludes idle wait between turns
- `SessionMeta.lastTokens` — tokens spent by the most recent turn (input + output + cache), same composition as `totalTokens`
- `SessionMeta.lastDurationMs` — active-turn duration of the most recent turn: the SDK `result` message's `duration_ms` minus that turn's accumulated `LiveState.permissionWaitMs` (so plan-mode / tool-approval waits don't count as step time)
- `WorkflowEngine.onWorkflowTurnComplete` — adds `meta.lastCostUsd` onto `stepCostsUsd[stepIndex]`, `meta.lastTokens` onto `stepTokens[stepIndex]`, and `meta.lastDurationMs` onto `stepDurationsMs[stepIndex]` each time a workflow turn completes
- `formatDuration` — renders ms as `Xs` / `Xm Ys` / `Xh Ym`

## Data flow

SDK `result` message → `SessionMeta.lastCostUsd` / `SessionMeta.lastTokens` / `SessionMeta.lastDurationMs` (existing accumulation in `server/src/sessions.ts`) → read by `onWorkflowTurnComplete` and added onto `WorkflowState.stepCostsUsd[stepIndex]` / `stepTokens[stepIndex]` / `stepDurationsMs[stepIndex]` → persisted on `SessionMeta` upsert → `WorkflowStepper` renders `stepCostsUsd[i]` as a `$X.XX` label, `stepTokens[i]` as a coin icon with a "N tokens spent" tooltip, and `stepDurationsMs[i]` via `formatDuration`, all in a metrics row below the step name.

## Dependencies

None beyond the existing `SessionMeta.lastCostUsd` / `totalTokens` / `totalDurationMs` accumulation ([[session-sidebar-usage]] uses the sibling `totalCostUsd`/`totalTokens`/`totalDurationMs` fields the same way).

## Tests

None. No test infrastructure covers `WorkflowStepper` rendering at time of writing.

## Business rules

- Cost, tokens, and duration render in a metrics row below the step name (not inline with it), so the name has the full column width to itself.
- Cost shown as `$X.XX` (2 decimals); hidden (rendered invisible, not removed) for a step whose accumulated cost is zero or unset, so the metrics row keeps a fixed height and other steps' rows don't jump when a value later appears.
- Token icon (coin) shown with a "N tokens spent" tooltip (locale-formatted); hidden under the same zero/unset rule as cost.
- Duration shown via `formatDuration`; hidden under the same zero/unset rule as cost. Counts only active SDK turn time: excludes idle wait between turns AND permission-prompt approval wait within a turn (e.g. a plan-mode review card left open) — so a step blocked on a slow approval doesn't read as an expensive step.
- Retries and auto-advance turns on the same step add onto the same array slot rather than overwriting it, for cost, tokens, and duration.

## Architectural rules

- Reuses the existing per-turn `lastCostUsd` accumulation on `SessionMeta` (same source `onWorkflowTurnComplete` already reads for step logic) instead of adding a new cost-tracking path.
- Tokens and duration follow the identical pattern via `SessionMeta.lastTokens` / `lastDurationMs`, mirroring `lastCostUsd` rather than introducing a separate tracking mechanism.
- Duration is sourced from the SDK `result` event's `duration_ms`, not clock math against `turnStartedAt`, so it excludes idle time by construction; permission-wait time is deducted via `LiveState.permissionWaitMs` (see [[session-sidebar-usage]]) rather than switching to the SDK's `duration_api_ms`, since that would also strip genuine tool-execution time, not just approval wait.

## Related decisions

None.
