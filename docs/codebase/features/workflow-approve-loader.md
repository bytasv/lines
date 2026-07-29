# Workflow approve loader

## Purpose

Give instant feedback when the user clicks **Approve → next step**: the click kicks off a real background consolidation of the finished step's output (a Sonnet query for an iterated step, which can take seconds), but until this feature the button and card gave no sign anything had happened. The button now shows a loader and disables itself the instant the click lands, and the card explains what's happening, across every connected tab.

## Entry points

- `web/src/components/WorkflowStepper.tsx` (Approve button, waiting/advancing card)
- `server/src/workflows.ts` (`WorkflowEngine.advance`)

## Files

- `shared/types.ts` (`WorkflowState.advancing`)
- `server/src/workflows.ts`
- `server/src/sessions.ts` (`SessionManager` constructor load loop, `adoptSynced`)
- `web/src/components/WorkflowStepper.tsx`
- `server/src/workflows.advance.test.ts`

## Symbols

- `WorkflowState.advancing`
- `WorkflowEngine.advance`
- `SessionManager.persistMeta`
- `SessionManager.adoptSynced`

## Data flow

`advance()` sets `stepStatuses[i] = 'done'`, then sets `workflow.advancing = true` and calls `SessionManager.persistMeta()` — a plain persist + `sessionUpsert` broadcast with no status change — **before** awaiting `consolidateStepOutput()`. Everything from the WS handler through this point is synchronous, so every connected tab sees the flag in the same tick as the click.

`workflow.advancing` is cleared right before the branch that either starts the next step or finishes the workflow, with no broadcast of its own: both branches broadcast next regardless (`runStep`'s `setStatus('running')`, its unresolved-ref `setStatus('error')`, or the last-step `setStatus('idle')`), so the clear rides that message and the client never sees a flicker back to a live-looking button. A failure during consolidation is caught and logged; the flag still clears via the same fall-through so the loader can never hang. `runStep`'s two silent early-return paths (unresolved workflow/session, and a step index past the end of the list) now also call `SessionManager.persistMeta` before returning, so the cleared flag and bumped `stepIndex` reach the client even when neither branch above runs — previously those returns broadcast nothing and the loader could hang forever.

The consolidation itself (`SessionManager.consolidateStepOutput`, awaited inside this window) is bounded by `consolidateTimeoutMs` (60s default, overridable in tests) so a hung token refresh or an unbounded query drain can no longer keep this window open indefinitely — see [workflow-step-output-consolidation](workflow-step-output-consolidation.md).

The client derives `advancing` and `waiting` straight from `session.workflow`, same as every other status-driven affordance in the app — no local optimistic state. The card shows while either is true; the button shows a `Loader` and disables while advancing, and also disables while disconnected (`connectionStatus !== 'connected'`) so a click can't be silently dropped by the socket layer.

The flag is in-flight-only and lives in one bridge process's memory, so two boundaries clear it explicitly rather than trusting it across a restart or hand-off:

- `SessionManager`'s constructor load loop clears `advancing` on every loaded session — nothing is consolidating right after a fresh boot.
- `adoptSynced()` clears it alongside its existing `isSessionActive` reset, for the same reason: an in-flight status belongs to whichever instance is actually running the turn.

`reconcileWithWorker()` deliberately does **not** touch the flag — it runs on every worker liveness report, and clearing there would kill the loader mid-consolidation on a perfectly healthy bridge.

## Tests

- `server/src/workflows.advance.test.ts` — flag raised synchronously before the consolidation await; cleared on successful advance (both non-last and last step); cleared on a consolidation failure; cleared by the constructor load loop after a simulated crash; cleared by `adoptSynced()`; left alone by `reconcileWithWorker()`.
- Web has no test infra beyond typecheck; the button/card behavior is manual-verified.

## Business rules

- The Approve button shows a loader and is disabled for the entire consolidation window, not just until the next step's status arrives.
- The button is also disabled while the client is disconnected, since a dropped WS message would otherwise leave the click looking like it did nothing.
- The card's copy switches to an in-progress message ("approved — wrapping up its output…") while advancing, then reverts to normal once the next step's card (or the workflow-done state) replaces it.
- The consolidation window is bounded: even a hung Sonnet query or token refresh cannot hold `advancing` (and thus this loader) open forever.

## Architectural rules

- The flag is server-owned and broadcast state only — never a local `useState` on the button. Local optimistic state would spin forever on `approve()`'s stale-index / wrong-status guards, or on a `send()` a closed socket silently drops.
- The clear-before-branch design assumes no `await` is ever inserted between clearing the flag and the next broadcast (`runStep`'s `setStatus`, or the terminal `setStatus('idle')`); adding one would reopen a window where a client briefly sees `advancing: false` with a stale status.
- Clearing on restart belongs in the constructor load loop, and clearing on hand-off belongs in `adoptSynced()` — never in `reconcileWithWorker()`, which runs far more often and would falsely clear a live advance.

## Related decisions

None.
