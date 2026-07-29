# Workflow stop parks

## Purpose

Pressing Stop while a workflow step is running only interrupts the turn — it never advances the workflow. The step parks at `waiting-approval` once the interrupted turn settles, so the user can iterate with a follow-up prompt or explicitly move on via Approve or the stepper's "Mark as completed" checkmark.

## Entry points

- `web/src/components/Composer.tsx` (stop button, sends `interrupt`)
- `server/src/index.ts` (`case 'interrupt'`)
- `server/src/sessions.ts` (`SessionManager.interrupt`)
- `server/src/workflows.ts` (`WorkflowEngine.forceAdvance`, `WorkflowEngine.onWorkflowTurnComplete`)

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
- `WorkflowEngine.forceAdvance`
- `WorkflowEngine.onWorkflowTurnComplete`

## Data flow

`interrupt()` is intent-free: it stops the worker, denies pending permissions, pauses the queue, and sets status `idle` — nothing else. It never reads or writes `advanceOnComplete`.

The only caller that wants an advance out of a running step is `WorkflowEngine.forceAdvance` (the stepper's "Mark as completed" checkmark). It sets `advanceOnComplete = 'interrupted'` and stamps `advanceOnCompleteStep = i` *before* calling `interrupt()`, then arms a settle watchdog — see [workflow-force-advance](workflow-force-advance.md) for the stamp/watchdog mechanics. The engine never advances synchronously — it waits for the turn to settle (SDK `result`, or `ended` without `result` via the `interrupting`-gated fallback in `handleWorkerEnded`, or the watchdog if neither ever arrives), then `onWorkflowTurnComplete` consumes the flag, emits an `'interrupted'` transcript marker, and calls `advance()`. If `advanceOnComplete` is unset — or set but stamped for a different step index — when the turn settles, the step parks at `waiting-approval` instead. A plain Stop (no force-advance) never sets the flag at all, so it always parks; only an explicit force-advance ever arms the watchdog.

## Tests

- `server/src/workflows.advance.test.ts` — Stop does not flag an advance (and does not arm the watchdog); a stopped step parks on the SDK result and on `ended`-without-result; a queued follow-up survives the park; force-advance still advances a running step; force-advance advances even when the live turn isn't the step's own; a user prompt clears a pending force-advance flag and its stamp; a flag stamped for an earlier step is not honored; the watchdog advances when the interrupted turn never settles; a late result after the watchdog does not touch the next step.
- Manual verification via the `verify` skill for the end-to-end UI path.

## Business rules

- Plain Stop during a running workflow step always parks it at `waiting-approval`; it never advances. Advancing requires an explicit action: Approve (once parked) or the stepper's "Mark as completed" checkmark (while still running).
- A user prompt sent after a force-advance but before the interrupted turn settles clears the `'interrupted'` flag and its step stamp (the user chose to keep working on the step).
- The step's output hand-off after a force-advance (`{previous}`, `outputName`) goes through the same (now-bounded) consolidation as a normal advance (see [workflow-step-output-consolidation](workflow-step-output-consolidation.md)) — only a single-turn interrupted step still hands off the raw last-said text verbatim, since consolidation is a no-op there.
- Deny-pending-permissions and queue-pause semantics of interrupt are unchanged; queued messages stay held until the next explicit user send or an `iterateIfWaiting` follow-up.
- A workflow step configured with `autoAdvance: true` still advances after Stop — that is the step's own configuration, not Stop semantics.

## Architectural rules

- `interrupt()` stays intent-free — no caller may infer "advance" from "stop". Only `forceAdvance` sets `advanceOnComplete` (+ its step stamp); a plain Stop leaves it unset and arms no watchdog.
- Whether a settle may consume `advanceOnComplete` is decided by the `advanceOnCompleteStep` stamp matching the current step index — no longer by `turnSource`, which previously left a step stranded at `running` forever if a user-source turn happened to be live when force-advance fired.
- Never advance a workflow synchronously under a live turn — always flag-and-wait via `advanceOnComplete`, with the watchdog as the only fallback if nothing ever settles it.
- The `handleWorkerEnded` settle fallback must stay gated on the `interrupting` set: non-error `ended` events are routine (fresh-start step boundaries close the old query).

## Related decisions

None.
