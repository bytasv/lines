# Workflow step output consolidation

## Purpose

Ensure the output handed to the next workflow step ({previous}, outputName) is the step's full definitive deliverable, not a short delta reply left over from iterating on the step (feedback retry or follow-up).

## Entry points

- `server/src/workflows.ts` (`WorkflowEngine.advance`, `WorkflowEngine.runStep`)

## Files

- `shared/types.ts` (`WorkflowState.lastStepOutput`)
- `server/src/sessions.ts` (`SessionManager.consolidateStepOutput`)
- `server/src/workflows.ts`

## Symbols

- `WorkflowState.lastStepOutput`
- `SessionManager.consolidateStepOutput`
- `SessionManager.lastAssistantText`
- `WorkflowEngine.advance`

## Data flow

`advance()` calls `consolidateStepOutput(sessionId)` before moving to the next step. It locates the step's entry marker (last `workflow` transcript event with `event === 'started'`), slices the transcript from there, and groups it into turns (each `user` event opens a turn; that turn's final assistant text block is its output). A single-turn step returns that text directly — no query, no added latency. A multi-turn step (iterated via feedback retry or a follow-up) runs a one-shot Sonnet query, non-agentic (`maxTurns: 1`, no tools), given the step's initial instruction plus every attempt's output and the feedback between them, and asks it to produce one consolidated deliverable. The result is stored on `meta.workflow.lastStepOutput` and, if the step has an `outputName`, also in `outputs[outputName]`. `runStep()`'s fresh-start hand-off reads `lastStepOutput ?? lastAssistantText(...)`.

## Tests

None (repo has typecheck only). Manual verification via the `verify` skill.

## Business rules

- Consolidation only fires when a step ran more than one turn; a single-turn step incurs no extra query or latency.
- On query failure or an empty result, falls back to `lastAssistantText` (today's pre-existing behavior) rather than blocking the workflow.
- Consolidation runs on both a normal advance and an interrupted-step advance (see [workflow-stop-advances](workflow-stop-advances.md)).

## Architectural rules

- Reuses the transcript-walking pattern from `lastAssistantText`/`summarizeTurn` and the one-shot non-agentic query shape from `summarizeTurn`/`autoName`, rather than introducing a new query pattern.
- `advance()` is `async`; callers fire it with `void this.advance(sessionId)` since nothing downstream awaits its completion.

## Related decisions

None.
