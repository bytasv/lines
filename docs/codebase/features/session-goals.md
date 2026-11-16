# Session goals

## Purpose

A goal is a completion condition the bridge checks after every settled turn. While the
condition is unmet, the bridge sends the agent another turn automatically, up to a turn
cap. Plain sessions carry one goal each; a workflow step can carry its own goal, which
decides whether the step iterates, advances or parks (see
[workflow-step-lifecycle](workflow-step-lifecycle.md)).

## Entry points

- `web/src/components/Composer.tsx`: goal button; mounts the chip and the modal.
- `web/src/components/GoalModal.tsx`: set, edit or resume a goal (session or current step).
- `web/src/components/GoalChip.tsx`: status chip above the composer.
- `web/src/components/WorkflowStepper.tsx`: "Set goal" beside Approve on a parked step.
- `web/src/components/workflow/WorkflowRunModal.tsx`: per-step goal rows at launch and in the
  pending-steps modal.
- `server/src/index.ts`: `setGoal` / `clearGoal` routing.

## Files

- `server/src/goals.ts`: `GoalEngine` (session goals), the judge prompt and verdict parser.
- `server/src/workflows.ts`: step goal seeding, settle path, judging, pause and park rules.
- `server/src/sessions.ts`: turn-complete listener fan-out, busy gate, restart pause, sync rule.
- `server/src/userContext.ts`: wires the judge into the workflow engine.
- `shared/types.ts`: `GoalState`, `StepGoal`, `StepGoalSpec`, `GoalMarkerData`, constants.
- `shared/workflowValidation.ts`: `sanitizeStepGoal`, goal-aware `sanitizeStepOverrides`.

## Data flow

1. A turn settles and the turn-complete listeners fire.
2. For a plain session, `GoalEngine` judges the goal; for a workflow step, the step's goal
   takes the settle instead of autoAdvance or park.
3. The judge is a small model call on the session's last reply, returning strict JSON
   `{met, reason}`. Anything else counts as a failed judge.
4. Met, unmet under cap, or cap/judge failure decides the next state. Unmet sends a
   continuation prompt with source `goal`.
5. Every transition emits a `goal` transcript marker and persists the goal on the session.

## Business rules

- Stop never auto-continues: a Stop on a goal turn marks the goal `stopped`.
- A failed turn pauses the goal (`turn-failed`) with no retry loop.
- A judge failure pauses the goal (`judge-failed`), so a broken judge cannot loop.
- The turn cap pauses the goal (`cap`). Setting the goal again resumes it with a fresh budget;
  the cap defaults to 10 and is clamped to 1..50.
- A prompt the user queues while the judge runs goes first; the goal is judged again when
  that turn settles.
- A bridge restart returns any `active` or `evaluating` goal paused (`restart`). Nothing runs
  on its own after a restart.
- A synced session row can never create or change a goal: the condition is prompt text, so
  the local goal is kept.
- A session with an unfinished workflow has no session goal; its goals are per step. A step
  goal is dropped on advance, approve, force-advance and rewind.
- A planned step goal from the run picker is seeded when that step starts. Without a planned
  goal, a step behaves as before.
- A plan-approval or force-advance advance still wins over a live step goal.

## Architectural rules

- Judging goes through the existing helper query, not a second model client.
- `GoalEngine` and `WorkflowEngine` both listen to turn settles; a session with an unfinished
  workflow is left to the workflow engine.
- Goal state lives on the session metadata and is broadcast like the workflow state.
- Native Codex goals are not used. Codex sessions reach the judge through the helper's
  provider fallback.

## Tests

- `server/src/goals.test.ts`: session goal verdicts, clamp, cap, Stop, failures, queue race,
  restart pause, sync, listener fan-out.
- `server/src/workflows.goal.test.ts`: step goal seeding, continuation, met (advance and wait),
  cap, judge failure, Stop, failed turn, queued prompt, restart, sync.

## Related decisions

- None recorded yet.
