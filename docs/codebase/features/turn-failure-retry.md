# Turn failure retry

## Purpose

Every recoverable turn failure — a crashed query, an `is_error` SDK result, a workflow
step that never got a prompt (unresolved step ref, missing `{outputs.*}`), or a push
that never reached the worker — ends on a failure row with a working single-click
Retry, in both a plain session and a workflow session. Before this, a failure inside a
workflow step left no Retry (the trailing transcript item was a park marker, not the
failed result, and the session's `waiting-approval` status made `retryTurn`'s busy
guard refuse the click even if one had rendered), and some pre-run failures wrote no
failure row at all.

## Entry points

- Retry button click: `web/src/components/Transcript.tsx` → `retryTurn` client message
  → `server/src/index.ts` (`case 'retryTurn'`)

## Files

- `server/src/sessions.ts` — `SessionManager.failTurn` (public), `lastPromptForRetry`,
  `pushTurnSafely`, the `result`-branch status/errorMessage assignment,
  `handleWorkerEnded`'s error branch, `TurnCompleteListener`
- `server/src/workflows.ts` — `WorkflowEngine.retryIfFailed`, `runStepSafely`,
  `onWorkflowTurnComplete`, the two pre-run failure sites in `runStep`
- `server/src/index.ts` — `case 'retryTurn'`
- `shared/types.ts` — `WorkflowState.stepFailure`, `WorkflowMarkerData.failed`
- `web/src/components/Transcript.tsx` — the backward scan for `retryKey`,
  `WorkflowMarker`'s failed label, `FailedTurnActions`
- `web/src/lib/transcript.ts` — `isFailedResult`, `resultErrorText`, the
  compaction-span escape

## Symbols

- `SessionManager.failTurn(sessionId, error)` — the single funnel that shows a turn as
  failed: emits a synthetic `result` event, then sets status `'error'` + `errorMessage`.
- `SessionManager.lastPromptForRetry(sessionId)` — the last user prompt + attachments
  rehydrated from disk, extracted out of `retryTurn` so `WorkflowEngine.retryIfFailed`
  can reuse it.
- `WorkflowEngine.retryIfFailed(sessionId): boolean` — consumes a Retry click for a
  workflow session whose current step failed; returns `false` for a plain session or a
  step that parked normally, so the caller falls through to `SessionManager.retryTurn`.
- `WorkflowState.stepFailure?: 'pre-run' | 'turn'` — set on the step that is currently
  parked-as-failed; `'pre-run'` means it never got a prompt (re-render via `runStep`),
  `'turn'` means its turn failed (re-send the prompt via `iterateStep`).
- `WorkflowMarkerData.failed` — set on a `'waiting-approval'` marker whose park was a
  failure, so the divider reads "failed, retry or approve to skip".

## Data flow

**Router.** `server/src/index.ts`'s `case 'retryTurn'` mirrors `case 'prompt'`'s
workflow-first idiom: `workflows.retryIfFailed(sessionId)` runs first and short-circuits
on `true`; otherwise `sessions.retryTurn(sessionId)` handles it (a plain session, or a
workflow session whose step didn't fail).

**Producing a failure.** Every failure funnels through one of two writers:

- `SessionManager.failTurn` — for a crashed query (`handleWorkerEnded`'s error branch),
  a push that never reached the worker (`pushTurnSafely`'s catch), and a workflow
  pre-run failure (unresolved step ref, missing `{outputs.*}`) inside `runStep` and its
  `runStepSafely` wrapper.
- The `result` branch of `handleWorkerEvent` — for an `is_error` SDK result. Sets
  `status: 'error'` + `errorMessage` (previously always `'done'`, so a failed non-workflow
  turn's `SessionView` banner never showed). The error text comes from
  `resultErrorText(msg)`, which falls back to `msg.errors[]` when the SDK reported no
  `result` at all (an `SDKResultError`) — reading `result` alone degraded those to the
  generic `'The turn failed.'`. This branch also calls `SessionManager.recoverAuthFailure`
  after its upsert, since it bypasses `failTurn` by design — see
  [auth-failure-recovery](auth-failure-recovery.md).

Both paths report the failure to `WorkflowEngine` via a fourth `failed` argument on
`TurnCompleteListener`. `handleWorkerEnded`'s error branch fires the listener itself
(with the `turnSource` it captured before clearing it) so a workflow step doesn't dangle
at `'running'` forever with no settle ever coming — listener call only, since `failTurn`'s
synthetic result deliberately bypasses `handleWorkerEvent` and must not re-run
spend/token accumulation a second time.

**Parking as failed.** `WorkflowEngine.onWorkflowTurnComplete` skips `autoAdvance` when
`failed` is true (an explicit force-advance still wins) and, at the park, sets
`stepFailure = 'turn'` instead of calling `setStatus('waiting-approval')` — `setStatus`
is what clears `errorMessage` on every transition, so skipping it here is what keeps the
banner and the Retry button alive while the step still shows `waiting-approval` (Approve
can still skip it). The marker gets `failed: true`. A pre-run failure sets
`stepFailure = 'pre-run'` directly at the failure site, before the corresponding
`failTurn` call.

**Consuming a Retry.** `WorkflowEngine.retryIfFailed` bails (returns `false`, so the
plain-session path handles it) when there's no workflow, no `stepFailure`, the step
isn't parked at `waiting-approval`, an advance is in flight (`advancing`), or the session
is otherwise busy. Otherwise: `'pre-run'` re-enters `runStep` (via `runStepSafely`) as a
normal step entry, hand-off included; `'turn'` looks up the last prompt via
`lastPromptForRetry` and re-sends it through `iterateStep` (same conversation, `'retried'`
marker, no advance). `stepFailure` is cleared the moment the step runs again
(`runStep`, `iterateStep`) or the workflow moves on (`advance`), so the next park is
judged on its own.

**Client-side.** `Transcript.tsx` scans `built` backward from the end for `retryKey`,
skipping over `'workflow'` (a park marker) and `'context-compact'` items — either can
land after a failed result without meaning the turn moved on — and stopping at anything
else (a live permission card, or any content belonging to a new turn). `transcript.ts`
lets a failed `result` close an already-open compaction span instead of being dropped by
it, sharing the `isFailedResult` predicate with the item builder — the server has already
abandoned the span by the time that result is emitted, so the client must not swallow the
only failure row Retry can key off.

## Tests

- `server/src/sessions.ended.test.ts` — a failed result marks the session errored with a
  Retry-able banner and still settles the turn's spend/listener; a crashed query settles
  the turn so a workflow step doesn't dangle; a push rejection fails the turn instead of
  wedging the session at `running`.
- `server/src/workflows.advance.test.ts` — a failed result parks the step, keeps the
  error status, and does not `autoAdvance`; spend still accumulates onto the step slot; a
  normal park carries no `stepFailure`.
- `server/src/workflows.retry.test.ts` — `retryIfFailed` re-sends the last prompt for a
  `'turn'` failure, re-runs the step for a `'pre-run'` failure, ignores a normally-parked
  step and a plain session, and clears `stepFailure` on retry; an unresolved step ref and
  missing step outputs both fail the turn with a message.

## Business rules

- Every recoverable failure (crashed query, `is_error` result, workflow pre-run failure,
  a push that never left the bridge) ends on a failure row with a working Retry button —
  in a plain session and inside a running workflow alike.
- A failed turn never `autoAdvance`s; it parks the step as failed instead. An explicit
  force-advance (`advanceOnComplete === 'interrupted'`, stamped for the step) still takes
  priority over the failure, honoring the user's own advance request.
- Retry re-runs the right thing: a step that never got a prompt is re-rendered from
  `WorkflowState`; a step whose turn failed is re-sent as a follow-up on the same
  conversation.
- No auto-retry or backoff — a transient failure (e.g. a 529) is an ordinary failed turn
  with a manual button, not a special transient-error class.
- `stepFailure` is persisted (part of `WorkflowState`), so a reload while parked in the
  failed state still shows Retry.

## Architectural rules

- `SessionManager.failTurn` is the single funnel for every failure the SDK never reports
  as a `result` — public specifically so `WorkflowEngine` can call it for pre-run
  failures instead of duplicating the synthetic-result-then-error-status shape.
- The retry router idiom mirrors `case 'prompt'`: the workflow engine gets first refusal
  (`retryIfFailed`), and only a `false` falls through to `SessionManager.retryTurn`. No
  new `ClientMessage` type — the client keeps sending `retryTurn`.
- `lastPromptForRetry` is the single source both `retryTurn` and `retryIfFailed` read
  from, so a workflow retry and a plain retry rehydrate attachments identically.
- `stepFailure` and `WorkflowMarkerData.failed` are additive optional fields — `'pending'`
  vs a normal `'waiting-approval'` park is otherwise indistinguishable to a consumer that
  predates this feature (e.g. `WorkflowStepper.tsx`, which keys off `stepStatuses`, not
  session status or `stepFailure`).
- `errorMessage`'s lifetime is deliberately widened: `'error'` status can now coexist
  with `stepStatuses[i] === 'waiting-approval'`. Any future code path that calls
  `setStatus` inside the failed-park branch would silently kill the banner —
  `onWorkflowTurnComplete`'s failed branch calls `persistMeta`, never `setStatus`, for
  exactly this reason. `SessionMeta.errorKind` (see
  [auth-failure-recovery](auth-failure-recovery.md)) shares `errorMessage`'s lifetime and
  the same constraint: it must ride `persistMeta` on that branch too, never `setStatus`.
- The client's backward scan may only skip `'workflow'` and `'context-compact'` items;
  every other kind ends the scan, since it means a new turn (or a live permission
  request) started.

## Related decisions

- [workflow-stop-parks](workflow-stop-parks.md) — the same park mechanism, now also
  reachable by a failure, not only a Stop.
- [auth-failure-recovery](auth-failure-recovery.md) — the pre-existing `failTurn` /
  `retryTurn` pair this feature extends to workflow sessions and to `is_error` results
  on plain sessions.
- [workflow-step-output-consolidation](workflow-step-output-consolidation.md) — the
  pre-run "missing `{outputs.*}`" park now goes through `failTurn` instead of a bare
  `setStatus('error')`.
- [context-compaction](context-compaction.md) — the compaction-span escape for a failed
  result that lands while a span is still open.
