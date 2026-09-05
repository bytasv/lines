# Workflow step lifecycle

Covers: `workflow-step-advance`, `workflow-stop-parks`, `workflow-force-advance`,
`workflow-stalled-step-start`, `workflow-approve-loader`,
`workflow-step-output-consolidation`, `workflow-done-session-indicator`.

## Purpose

How a running workflow step's turn settles into advance, park, or stall; how its output is
consolidated and handed to the next step; how a human recovers a stuck one; and how a
fully-finished workflow reads in the sidebar.

Pressing Stop while a workflow step is running only interrupts the turn — it never advances
the workflow. The step parks at `waiting-approval` once the interrupted turn settles, so the
user can iterate with a follow-up prompt or explicitly move on via Approve or the stepper's
"Mark as completed" checkmark. This holds even for a step configured with `autoAdvance: true`,
and even when a plan-approval advance was already pending when Stop was pressed — Stop is
explicit intent to halt, and overrides both.

The stepper's checkmark is the manual escape hatch for a step that's otherwise stuck (bad
implementation, stalled turn, no natural way to reach `waiting-approval`): hovering the
current step's icon shows a checkmark; clicking it confirms, then marks the step done and
moves on — one click always ends with the workflow on the next step (or done), either
immediately, once the interrupted turn settles, or via a watchdog if it never does.

If an advance itself dies mid-flight (bridge restart, crash), the stepper offers two further
recoveries — starting a step left `pending` with nothing running, or resuming one left `done`
at the current index before `stepIndex` was bumped. Every click that kicks off a background
consolidation (Approve, or a force-advance) shows a loader and disables itself instantly,
across every connected tab, for the whole consolidation window.

The output handed to the next step (`{previous}`, `outputName`) is the step's full definitive
deliverable, not a short delta reply left over from iterating on the step.

Once every step is done, the sidebar row shows a filled checkmark so a fully-run workflow
reads as "done" without opening the session.

## Entry points

- `web/src/components/Composer.tsx` (stop button, sends `interrupt`)
- `web/src/components/WorkflowStepper.tsx` (`StepIcon` hover affordances — checkmark,
  play-icon, "Continue → next step" — confirmation modal, Approve button, waiting/advancing
  status card)
- `server/src/index.ts` (`case 'interrupt'`, `case 'workflowForceAdvance'`,
  `case 'workflowStartStep'`)
- `server/src/sessions.ts` (`SessionManager.interrupt`)
- `server/src/workflows.ts` (`WorkflowEngine.forceAdvance`, `WorkflowEngine.startStep`,
  `WorkflowEngine.advance`, `WorkflowEngine.runStep`,
  `WorkflowEngine.onWorkflowTurnComplete`)
- Sidebar session row status icon

## Files

- `shared/types.ts` (`WorkflowState.advanceOnComplete`, `WorkflowState.advanceOnCompleteStep`,
  `WorkflowState.advancing`, `WorkflowState.lastStepOutput`, `WorkflowState.diffBaselines`,
  `WorkflowMarkerData.event`, `ClientMessage` variants
  `workflowForceAdvance`/`workflowStartStep`)
- `server/src/sessions.ts` (`consolidateStepOutput` and its timeout, plan-approval stamp
  sites, user-prompt clear, constructor load loop, `adoptSynced`, `reconcileWithWorker`,
  `compactContext`/`abandonCompaction`/`restoreCompactedStatus` — see
  [context-window](context-window.md#compaction))
- `server/src/workflows.ts`
- `server/src/index.ts`
- `server/src/git.ts` (`workingTreeDiff`/`multiRepoDiff`, `MAX_DIFF_CHARS` — see
  [multi-repo-commits](multi-repo-commits.md), which owns the per-repo diff and the
  `{roots}` token in detail)
- `web/src/components/Transcript.tsx` (`WorkflowMarker`)
- `web/src/components/Composer.tsx`
- `web/src/components/WorkflowStepper.tsx`
- `web/src/components/ConfirmModal.tsx` (reused, not modified)
- `web/src/lib/format.ts` (`isWorkflowFinished`)
- `web/src/components/Sidebar.tsx` (`SessionRow` icon branch order)
- `server/src/workflows.advance.test.ts`
- `server/src/sessions.compact.test.ts`
- `server/src/sessions.reconcile.test.ts`

## Symbols

- `SessionManager.interrupt`
- `SessionManager.interrupting` (in-flight interrupt set)
- `SessionManager.handleWorkerEnded` (ended-without-result fallback)
- `SessionManager.TurnCompleteListener` (`interrupted` third argument)
- `SessionManager.consolidateStepOutput`
- `SessionManager.consolidateQuery`
- `SessionManager.consolidateTimeoutMs`
- `SessionManager.lastAssistantText`
- `SessionManager.collectTurns`
- `SessionManager.findStepStart`
- `SessionManager.persistMeta`
- `SessionManager.adoptSynced`
- `WorkflowState.advanceOnComplete` (`boolean | 'interrupted'`)
- `WorkflowState.advanceOnCompleteStep`
- `WorkflowState.advancing`
- `WorkflowState.lastStepOutput`
- `WorkflowEngine.forceAdvance`
- `WorkflowEngine.approve`
- `WorkflowEngine.startStep`
- `WorkflowEngine.advance`
- `WorkflowEngine.runStep`
- `WorkflowEngine.onWorkflowTurnComplete`
- `WorkflowEngine.armSettleWatchdog` / `clearSettleWatchdog`
- `WorkflowEngine.forceAdvanceSettleMs`
- `WorkflowEngine.iterateIfWaiting`
- `SessionManager.compactContext` / `abandonCompaction` / `restoreCompactedStatus`
- `LiveState.compactResume` — see [context-window](context-window.md) for the compaction side
- `substituteTokens`
- `usesHandoffTokens`
- `isWorkflowFinished(session)` — true when `session.workflow` is present, `started`,
  `stepStatuses` is non-empty, and every entry is `'done'`. Mirrors `advance()`
  (`server/src/workflows.ts`): the final step is set `'done'` with no further `stepIndex`
  bump and no dedicated "finished" flag, so all-`'done'` is the only reliable signal.

## Data flow

### Stop parks the step

`interrupt()` is intent-free: it stops the worker, denies pending permissions, pauses the
queue, and sets status `idle` — nothing else. It never reads or writes `advanceOnComplete`.

The only caller that wants an advance out of a running step is `WorkflowEngine.forceAdvance`
(the stepper's "Mark as completed" checkmark, see "Force-advance" below). It sets
`advanceOnComplete = 'interrupted'` and stamps `advanceOnCompleteStep = i` *before* calling
`interrupt()`, then arms a settle watchdog. The engine never advances synchronously — it
waits for the turn to settle (SDK `result`, or `ended` without `result` via the
`interrupting`-gated fallback in `handleWorkerEnded`, or the watchdog if neither ever
arrives).

`SessionManager` tracks every in-flight interrupt in its `interrupting` set and, at both
settle sites, reports whether *this* settle consumed that set's entry back to the caller as
the `interrupted` boolean on `TurnCompleteListener(sessionId, source, interrupted, failed)`.
`WorkflowEngine.onWorkflowTurnComplete` reads that flag: when `interrupted` is true and the
settle isn't a `forceAdvance` ("Mark as completed" always sets
`advanceOnComplete = 'interrupted'` with a stamp for the current step, which is the one
exception), it discards any pending `advanceOnComplete`/`advanceOnCompleteStep` — including a
plan-approval advance that was already flagged before Stop was pressed — and falls through to
park. Only when the settle is *not* interrupted does the engine honor a pending plan-approval
advance or the step's `autoAdvance: true` toggle. Either way `onWorkflowTurnComplete` emits
the matching transcript marker (`'interrupted'`, `'approved'`, or `'waiting-approval'`) and,
on advance, calls `advance()`.

A settle can also carry `failed = true` (the turn ended in an `is_error` result or a crashed
query, not a Stop). That park is a distinct variant — see [turn-recovery](turn-recovery.md) —
which skips `setStatus('waiting-approval')` so the `'error'` status and `errorMessage` a
failure already wrote stay live for Retry, and stamps `WorkflowState.stepFailure = 'turn'`
instead. A stamped force-advance still wins over a failure the same way it wins over an
interrupt.

### Compacting a parked step

A step parked `waiting-approval` (or, for a failed step, `error`) can run one more turn without
leaving that state: a manual context compaction — see
[context-window](context-window.md#compaction). `SessionManager.compactContext` moves the
session to `running` for the duration and snapshots what it covered
(`LiveState.compactResume`); the same status comes back once the compaction settles, and
`stepStatuses[i]` never changes. This is safe because a compaction touches no step hand-off —
`{previous}`/`{outputs.*}` and every other consolidation read the on-disk transcript, never the
CLI's live context.

For the duration, every gate that would otherwise trigger on the step's `stepStatuses[i] ===
'waiting-approval'` alone also checks the session status, and refuses while it reads `running`:
`WorkflowEngine.approve`, `forceAdvance`'s `waiting-approval` branch, `retryIfFailed`, and
`iterateIfWaiting` (a typed prompt). A prompt sent during the compaction therefore falls through
to `SessionManager.userPrompt` and queues instead of iterating; `onWorkflowTurnComplete` drains
it into the same step (`iterateStep`, same as the ordinary "queued follow-up survives the park"
path) the moment the compaction settles and finds the step still parked with nothing else
running. The stepper mirrors this: `WorkflowStepper` derives `compacting = waiting &&
isSessionInterruptible(session.status)` and disables the Approve/checkmark affordance for the
duration, so the button never offers a click the server would refuse.

### Force-advance: manual escape hatch

The stepper only shows the checkmark affordance on the *current* step
(`i === state.stepIndex`), never on pending/done/other steps. Hovering swaps the icon's glyph
to a checkmark without changing the circle's status color; clicking opens `ConfirmModal`
before sending anything. On confirm, the client sends
`{type: 'workflowForceAdvance', sessionId, stepIndex}`.

`WorkflowEngine.forceAdvance` branches on the step's current status:

- `waiting-approval` — delegates to `approve()` (identical to clicking the existing Approve
  button). `approve()` itself now has two senders of the same `{ type: 'workflowApprove',
  sessionId, stepIndex }` message: the stepper's Approve button, and a **Skip step** button on
  the failure banner when the step is parked as failed — see
  [turn-recovery](turn-recovery.md#non-auth-failure-classification).
- `done` at the current index with `advancing` cleared — a previous advance marked the step
  done and then died before bumping `stepIndex`. Re-enters `advance()` to finish the job.
  Declines when `advancing` is set (a real advance owns it) or when this is the last step (a
  finished workflow, not a stall). See "Stalled-step recovery" below.
- `running` with the session actively querying — sets `advanceOnComplete = 'interrupted'`
  **and** `advanceOnCompleteStep = i`, regardless of `turnSource` (a user-source turn can be
  live while the step still reads `running` — a worker error skipped the settle, then the
  user typed — and previously that left the step stranded forever). Then calls
  `SessionManager.interrupt()` and arms a settle watchdog (`armSettleWatchdog`,
  `forceAdvanceSettleMs = 5_000` by default, a field so tests can shrink it). The engine
  advances once the interrupted turn settles (see "Stop parks the step" above) — a `result`,
  or an `ended` without one — via `onWorkflowTurnComplete`, which checks the step stamp
  (`advanceOnCompleteStep === i`) rather than `turnSource` to decide whether to consume the
  flag. If neither ever arrives (a wedged worker), the watchdog fires instead: it re-checks
  the flag/stamp/step/status are all unchanged, clears `turnSource` (so a very late result
  from the abandoned turn settles source-less and stamp-consumed — a no-op), and calls
  `advance()` itself.
- `running` with no active query (e.g. the worker died mid-step) — advances immediately;
  there is no in-flight turn whose late result could clobber the next step.

A stale `stepIndex` (duplicate click, or a second tab showing an older stepper) is ignored
the same way `approve()` ignores one. The stamp (`advanceOnCompleteStep`) is what actually
enforces "this flag only counts for the step it was raised for" — a settle or watchdog fire
for any other index is a no-op, which matters once a later step could itself be `running` by
the time a very old turn or timer resolves.

`SessionManager.consolidateStepOutput` (called from `advance()`, see "Step output
consolidation" below) is bounded by `consolidateTimeoutMs` (60s default) so a hung token
refresh or query drain can no longer leave `advance()` parked forever with `advancing`
already broadcast — this was the original reported symptom ("step marked completed, no other
actions available").

`runStep`'s two silent early returns (unresolved workflow/session, and step index out of
range) call `SessionManager.persistMeta` before returning, so a bumped `stepIndex` and a
cleared `advancing` always reach the client instead of riding on a broadcast that never comes
(see "Approve loader" below).

When a step is `pending` (never started — an advance died mid-flight before queuing its first
turn) the stepper instead shows a play-icon affordance and sends `workflowStartStep`, handled
by `WorkflowEngine.startStep`. When it is `done` at the current index (an advance that died
inside the consolidation, before bumping `stepIndex`) the stepper shows a
**Continue → next step** affordance that reuses `workflowForceAdvance` and lands in the
`done` branch above. Both cases are covered in "Stalled-step recovery" below.

### Stalled-step recovery

An advance that dies mid-flight leaves the run with no natural affordance, in two shapes
depending on how far `advance()` got:

- **`pending` with nothing running** — the advance bumped `stepIndex` but never queued the
  step's first turn. The previous step shows done, the current step shows its plain number,
  nothing moves it.
- **`done` at the current index** — the advance marked the step done and then died *inside*
  `consolidateStepOutput`, before bumping `stepIndex`. This is the nastier one: the durable
  on-disk state has `stepStatuses[i] === 'done'` while `stepIndex` is still `i`, and every
  existing gate refuses exactly that shape — `approve`/`retry` want `waiting-approval`,
  `forceAdvance` wants `running`, `startStep` wants `pending`. Observed in the wild after a
  consolidation hung ~50 minutes and the bridge restarted under it.

Both are stalls the engine created; a human presses a button to nudge past either.

**`pending` — start the step.** The stepper derives
`stalled = state.started && currentStep.status === 'pending' && !advancing && !stopping && !isSessionActive(session.status)`
— true only for the workflow's *current* step, and only when nothing else (a live turn, an
in-flight advance, a settling force-advance) is already on its way to starting it. When
`stalled`, `StepIcon` shows a play glyph instead of a checkmark on hover, and the status card
renders with a **Start step** button; both route through `ConfirmModal` (retitled "Start this
step?") before sending `{type: 'workflowStartStep', sessionId, stepIndex}`.

`WorkflowEngine.startStep` re-validates all the same conditions server-side (the client's
derived `stalled` is a hint, not authority) before calling `runStep(sessionId, undefined, true)`
— the same normal step-entry path an advance uses, so the fresh-start reset and
`{previous}`/`{diff}` hand-off behave exactly as they would have if the advance had completed
normally.

**`done` at the current index — resume the advance.** The stepper derives
`resumable = state.started && currentStatus === 'done' && state.stepIndex + 1 < workflow.steps.length && !advancing && !stopping`.
Deliberately **not** gated on `isSessionActive(session.status)`: `advance()` never sets a
session status, so the status is still whatever preceded the approve — usually the stale
`waiting-approval` from the park, which `isSessionActive` counts as active. That gate is
exactly what silenced the `stalled` derivation for this shape. `advancing` is the only honest
marker of a live advance.

When `resumable`, the card reads *"… is done but the next step never started — continue to
resume the hand-off."* with a **Continue → next step** button, and `StepIcon` gets the same
play glyph. Both send `{type: 'workflowForceAdvance', …}` — not `workflowStartStep`, since
the step is already done and `startStep` would refuse it — and both skip `ConfirmModal`:
there is nothing to confirm overriding, unlike the running-step and pending-step paths.

`WorkflowEngine.forceAdvance`'s `done` branch re-enters `advance()`, which re-runs the
consolidation (publishing the `{outputs.<name>}` entry the dead advance never wrote), bumps
`stepIndex` and starts the next step. It declines three lookalikes: `advancing === true` (a
real advance owns the step), the last step being `done` (a finished workflow, not a stall),
and a stale `stepIndex` from another tab.

**Preventing the `done` shape.** `advance()` calls `SessionManager.persistMeta` immediately
after `stepIndex = i + 1`, instead of leaving the bump to ride `runStep`'s own `setStatus`
broadcast. Previously the bump was in-memory only for the whole consolidation window, so the
*durable* state throughout it was the unrecoverable `done`-at-current-index shape. Note the
write itself is debounced (`PERSIST_DEBOUNCE_MS`, 250ms) like every other status write — this
closes the multi-second consolidation window, not the sub-250ms one.

### Approve loader

Clicking **Approve → next step** kicks off a real background consolidation of the finished
step's output (a Sonnet query for an iterated step, which can take seconds); the button shows
a loader and disables itself the instant the click lands, and the card explains what's
happening, across every connected tab.

`advance()` sets `stepStatuses[i] = 'done'`, then sets `workflow.advancing = true` and calls
`SessionManager.persistMeta()` — a plain persist + `sessionUpsert` broadcast with no status
change — **before** awaiting `consolidateStepOutput()`. Everything from the WS handler
through this point is synchronous, so every connected tab sees the flag in the same tick as
the click.

The next-step branch persists its `stepIndex` bump immediately (`persistMeta` right after
`stepIndex = i + 1`) rather than letting the bump ride `runStep`'s later broadcast — see
"Preventing the `done` shape" above.

`workflow.advancing` is cleared right before the branch that either starts the next step or
finishes the workflow, with no broadcast of its own: both branches broadcast next regardless
(`runStep`'s `setStatus('running')`, its unresolved-ref `setStatus('error')`, or the last-step
`setStatus('idle')`), so the clear rides that message and the client never sees a flicker back
to a live-looking button. A failure during consolidation is caught and logged; the flag still
clears via the same fall-through so the loader can never hang. `runStep`'s two silent
early-return paths (unresolved workflow/session, and a step index past the end of the list)
also call `SessionManager.persistMeta` before returning, so the cleared flag and bumped
`stepIndex` reach the client even when neither branch above runs — previously those returns
broadcast nothing and the loader could hang forever.

The client derives `advancing` and `waiting` straight from `session.workflow`, same as every
other status-driven affordance in the app — no local optimistic state. The card shows while
either is true; the button shows a `Loader` and disables while advancing, and also disables
while disconnected (`connectionStatus !== 'connected'`) so a click can't be silently dropped
by the socket layer.

The flag is in-flight-only and lives in one bridge process's memory, so two boundaries clear
it explicitly rather than trusting it across a restart or hand-off:

- `SessionManager`'s constructor load loop clears `advancing` on every loaded session —
  nothing is consolidating right after a fresh boot.
- `adoptSynced()` clears it alongside its existing `isSessionActive` reset, for the same
  reason: an in-flight status belongs to whichever instance is actually running the turn.

`reconcileWithWorker()` deliberately does **not** touch the flag — it runs on every worker
liveness report, and clearing there would kill the loader mid-consolidation on a perfectly
healthy bridge.

### Step output consolidation

`advance()` calls `consolidateStepOutput(sessionId, stepIndex)` before moving to the next
step, passing the index of the step that just finished. It locates *that step's* entry marker
via `findStepStart` (the last `workflow` transcript event with `event === 'started'` and a
matching `stepIndex`, scanning backwards so a re-entered step resolves to its latest pass),
then slices the transcript from there and groups it into turns with `collectTurns` (each
`user` event opens a turn). A turn's output is its `ExitPlanMode` deliverable when it produced
one (the plan mode harness puts the plan in the `ExitPlanMode` tool input, or — in the current
harness shape, which takes no `plan` argument — in the plan file the turn wrote under
`~/.claude/plans/`), else its last assistant text block. `collectTurns` takes an optional
`roots` list (default `[]`); when a plan-mode turn's write is an `Edit` (which carries no
`content` argument, only the tracked `file_path`) or when the file was revised again after the
last `Write`, it re-reads that file's current text from disk — gated by
`isPlanPath(filePath, roots)` and a size cap — and prefers it over whatever `content` was
captured in the transcript. `SessionManager` supplies `roots` from the session's own project
roots (`rootsFor`) at both call sites; a read that fails for any reason (deleted file, outside
every root) degrades to the captured `content`, matching the prior, purely transcript-local
behavior.

A single-turn step returns that output directly — no query, no added latency. A multi-turn
step (iterated via feedback retry or a follow-up) runs a one-shot Sonnet query
(`consolidateQuery`, non-agentic: `maxTurns: 1`, no tools), given the step's initial
instruction plus every attempt's output and the feedback between them, and asks it to produce
one consolidated deliverable. That query — including the owner-token refresh it needs — is
raced against `consolidateTimeoutMs` (60s default, a field so tests can shrink it); on timeout
the race is abandoned (the query keeps draining in the background, unread) and
`consolidateStepOutput` warns and falls through to the same `lastAssistantText` fallback used
on any other failure. `advance()` awaits this whole call with `advancing` already broadcast,
so an unbounded stall here used to leave the stepper showing a finished step with no next
action — this bound is what actually enforces the method's "never blocks the workflow"
contract.

An empty consolidated output is not published: it leaves `meta.workflow.lastStepOutput` and
`outputs[outputName]` untouched rather than clobbering a previous non-empty value. A non-empty
capture is persisted immediately (`SessionManager.persistMeta`) before the next step is
queued, so a bridge crash between capture and the next transition can't lose it. `runStep()`'s
fresh-start hand-off reads `lastStepOutput ?? lastAssistantText(...)`.

Before a step's prompt is sent, `runStep` resolves the hand-off values it will need (`{task}`
from the workflow, `{feedback}` from a retry, and — only when entering a fresh-start step that
has predecessors — `{previous}` from `lastStepOutput ?? lastAssistantText(...)` and `{diff}`
from `multiRepoDiff`, one per-repo section per commit unit the session's roots span — see
[multi-repo-commits](multi-repo-commits.md)), then calls `substituteTokens` **once** on the
raw template. That single `String.replace` fills `{task}`, `{feedback}`, `{previous}`,
`{diff}`, `{roots}`, and every `{outputs.<name>}` from `meta.workflow.outputs` (per-session,
never shared across sessions) in one pass, so text pulled in by one token is never rescanned
for another. An `{outputs.<name>}` that is absent or resolves to blank/whitespace is reported
as missing; if any are missing the step parks at `waiting-approval` via
`SessionManager.failTurn` (so the transcript gets a Retry-able failure row,
`WorkflowState.stepFailure = 'pre-run'`) plus a marker carrying `missingOutputs`, and the
prompt is never sent — see [turn-recovery](turn-recovery.md). `usesHandoffTokens(template)`
(tested against the **template**, before substitution) gates the fresh-start auto-prepend so a
template that already references `{previous}`, `{diff}`, or any `{outputs.*}` is not also
handed the same context a second time under a `## Context from the previous step` heading.
`{roots}` is deliberately **not** one of the tokens `usesHandoffTokens` looks for — it is
static workspace shape (which folders, which git repos, which branches), not hand-off content,
so a template using only `{roots}` still gets the normal auto-prepend, and `{roots}` itself is
resolved independent of `handoff` (it also works in a step that inherits the conversation).

### Sidebar checkmark for a finished workflow

There is no stored "workflow finished" flag; the state is derived client-side from the
workflow's step statuses. `SessionRow` computes
`finished = !session.completed && !status.actionable && isWorkflowFinished(session)` from the
same `SessionMeta` already used for `sessionRowMeta`. No new message type, no server or store
change — purely a render-time derivation from `session.workflow.stepStatuses`.

## Dependencies

`@tabler/icons-react` `IconCircleCheckFilled` for the sidebar finished icon (already an
installed icon, no new package). No other new dependencies.

## Tests

- `server/src/workflows.advance.test.ts` — Stop does not flag an advance (and does not arm
  the watchdog); a stopped step parks on the SDK result and on `ended`-without-result; Stop
  parks an `autoAdvance: true` step on both settle paths; Stop discards a pending
  plan-approval advance (flag and stamp both cleared); `autoAdvance` still advances on a
  normal (non-interrupted) settle; a plan-approval advance still fires on a normal settle; a
  queued follow-up survives the park; force-advance still advances a running step;
  force-advance advances even when the live turn isn't the step's own; a user prompt clears a
  pending force-advance flag and its stamp; a flag stamped for an earlier step is not
  honored; the watchdog advances when the interrupted turn never settles; a late result after
  the watchdog does not touch the next step; a consolidation that hangs still advances (via
  the bounded timeout); `advancing` clears on the wire when the workflow vanishes
  mid-advance; force-advance resumes an advance that died before bumping, and declines the
  three `done` lookalikes; `startStep` runs a step an advance left pending; is a no-op when
  the step is `running` (force-advance's territory), when a turn is already live, when an
  advance is mid-consolidation (`advancing`), and on a stale `stepIndex`; does not run step 0
  before the task description (first prompt) has arrived; the bumped `stepIndex` reaches both
  the client and disk on its own; flag raised synchronously before the consolidation await;
  cleared on successful advance (both non-last and last step); cleared on a consolidation
  failure; cleared by the constructor load loop after a simulated crash; cleared by
  `adoptSynced()`; left alone by `reconcileWithWorker()`; approve/force-advance are refused and
  a typed prompt queues (instead of iterating) while a parked step compacts; a prompt queued
  during that compaction drains into the same step on settle.
- `server/src/sessions.compact.test.ts` — status restore around a compaction over a parked or
  failed step: settles back to the same status (not `done`), a stopped or dead-query compaction
  restores it too, and a compaction that itself fails does not overwrite it.
- `server/src/sessions.reconcile.test.ts` — a bridge death mid-compaction re-parks a
  `waiting-approval` step instead of demoting it to `idle` with a Continue banner.
- `server/src/sessions.turns.test.ts` — `collectTurns` (plan-mode capture, both harness
  shapes; plans-file write with no `ExitPlanMode`; revised plan; plain-text turn; a plan
  revised by `Edit` resolving from disk; an unreadable plan file degrading to the captured
  `Write` content; a plan file outside every root not being read) and `findStepStart`
  (per-step scoping, re-entry, fallback).
- `server/src/workflows.substitution.test.ts` — `usesHandoffTokens` and `substituteTokens`
  (fill, missing/blank detection, no-token no-op, the regression that tokens occurring inside
  substituted text are left literal, and that `{roots}` fills but is not itself a hand-off
  token).
- Run via `npm test` (root) or `npm run test -w server`; `tsx --test`, no new dependencies.
- No test infrastructure covers `Sidebar.tsx`/`format.ts`; web has no test infra beyond
  typecheck, so the button/card/icon behavior is manual-verified via the `verify` skill.

## Business rules

- Plain Stop during a running workflow step always parks it at `waiting-approval`; it never
  advances. Advancing requires an explicit action: Approve (once parked) or the stepper's
  "Mark as completed" checkmark (while still running).
- A step configured with `autoAdvance: true` still parks after Stop — Stop overrides the
  step's own auto-advance configuration, since Stop is explicit intent to halt. A failed turn
  (`failed = true`) overrides `autoAdvance` the same way, for the same reason: there's no
  deliverable to hand on.
- A plan-approval advance already pending when Stop is pressed is discarded, not merely
  delayed: `advanceOnComplete` and `advanceOnCompleteStep` are both cleared, so no later
  settle can replay it.
- A user prompt sent after a force-advance but before the interrupted turn settles clears the
  `'interrupted'` flag and its step stamp (the user chose to keep working on the step).
- Deny-pending-permissions and queue-pause semantics of interrupt are unchanged; queued
  messages stay held until the next explicit user send or an `iterateIfWaiting` follow-up.
- A parked step's status (`waiting-approval`, or `error` for a failed step) survives a manual
  compaction turn — approve/force-advance/retry/prompt are all held while it runs, and a
  typed prompt queues instead of iterating, draining into the same step (never advancing) once
  the compaction settles. See "Compacting a parked step" above and
  [context-window](context-window.md).
- The force-advance affordance, and both stall-recovery affordances, only ever target the
  workflow's current step — other steps show no hover state — and each applies only while the
  step is genuinely running/stalled, never to skip ahead or re-run a step that already
  started.
- Confirmation copy differs by state: a running step warns that its turn is stopped and
  whatever it last said becomes the step's output; the last step's copy says the workflow
  finishes instead of naming a next step.
- One click on "Mark as completed" always ends with the workflow on the next step (or done) —
  via a normal settle, or the watchdog if the turn never settles at all.
- Starting a stalled `pending` step runs it exactly as a normal advance would: same
  fresh-start behavior, same `{previous}`/`{diff}` hand-off.
- Resuming a stalled `done` step re-runs its consolidation, so the `{outputs.<name>}` entry
  the dead advance never published is filled in before the next step starts.
- Resuming needs no confirmation dialog — the step is already done, so nothing is being
  overridden. Starting a `pending` step and force-advancing a `running` one both still
  confirm.
- The last step reading `done` is a finished workflow, never a stall; it gets no affordance.
- The Approve button shows a loader and is disabled for the entire consolidation window, not
  just until the next step's status arrives.
- The button is also disabled while the client is disconnected, since a dropped WS message
  would otherwise leave the click looking like it did nothing.
- The card's copy switches to an in-progress message ("approved — wrapping up its output…")
  while advancing, then reverts to normal once the next step's card (or the workflow-done
  state) replaces it.
- The consolidation window is bounded: even a hung Sonnet query or token refresh cannot hold
  `advancing` (and thus this loader) open forever.
- Consolidation only fires when a step ran more than one turn; a single-turn step incurs no
  extra query or latency.
- On query failure, an empty result, or a timeout (`consolidateTimeoutMs`), consolidation
  falls back to `lastAssistantText` (per-step-scoped) rather than blocking the workflow.
- An empty consolidated output is never published — it can't overwrite a previously captured
  value.
- Consolidation runs on both a normal advance and a force-advance of a running step, and is
  scoped to the step index that finished, not merely "the newest started marker" — relevant
  once a step can be queued while an earlier step's consolidation is still in flight. Only a
  single-turn interrupted step hands off the raw last-said text verbatim, since consolidation
  is a no-op there.
- A step whose template references an `{outputs.<name>}` that is absent or blank never runs —
  it parks at `waiting-approval` with an error marker instead of silently substituting `''`
  and running blind.
- Tokens are only honoured where the step author wrote them: a token appearing inside
  substituted content (a step output, the diff, the task text) stays literal. Staged
  substitution used to re-expand them, so a plan that merely discussed `{previous}`/`{diff}`
  was pasted once per literal `{previous}` and the working-tree diff once per literal
  `{diff}` — one step produced a 3.8 MB prompt from a 13 KB plan and a 105 KB diff, and the
  turn failed for exceeding the context window.
- The working-tree diff handed to a fresh-start step is capped (`MAX_DIFF_CHARS` in
  `server/src/git.ts`) with a truncation marker, so a large dirty tree degrades the hand-off
  instead of failing the turn; when the session's roots span more than one commit unit, that
  one budget is shared across every repo's section rather than multiplied by the repo count
  (see [multi-repo-commits](multi-repo-commits.md)).
- A step's deliverable during plan mode is its `ExitPlanMode` plan (inline argument or written
  plan file), not the turn's trailing chat text — the prior behavior captured the latter and
  produced near-empty outputs.
- A plan revised by `Edit` after the deliverable-producing `Write` still contributes its
  current, on-disk text to the hand-off — not the last captured `Write` content or the turn's
  trailing chat text — since `collectTurns` reads the plan file from disk (gated by
  `isPlanPath`) whenever the turn saw `ExitPlanMode` and the write's path is known.
- `outputs` remain strictly per-session (`WorkflowState.outputs`); there is no cross-session
  write path. Perceived "leaking between sessions" was actually every session's
  `outputs.plan` being captured as the same short trailing-chatter string, then an
  implementation step improvising from `~/.claude/plans/` — a directory shared across all
  sessions on the machine.
- Sidebar row icon precedence, first match wins:
  1. `session.completed` → green **outline** `IconCircleCheck`, 14px (manual "Mark completed")
  2. `session.status === 'running'` → `Loader`
  3. `status.actionable` (needs permission / needs answer / needs approval / interrupted /
     error) → pulsing `.status-dot` — always wins over the checkmark, so a session needing the
     user is never masked as "done"
  4. `isWorkflowFinished(session)` → green **filled** `IconCircleCheckFilled`, 14px
  5. otherwise → plain `.status-dot`
- Clicking a step in the stepper still jumps the transcript to that step's start marker, but
  the marker may not be mounted — `Transcript.tsx` windows a long transcript to its tail (see
  [transcript-performance](transcript-performance.md)). The click asks `revealWorkflowStep()`
  (`web/src/lib/workflowReveal.ts`) to scroll directly if the marker exists, otherwise it fires
  `REVEAL_STEP_EVENT`, which the transcript handles by dropping its window and scrolling once
  the marker mounts.

## Architectural rules

- `interrupt()` stays intent-free — no caller may infer "advance" from "stop". Only
  `forceAdvance` sets `advanceOnComplete` (+ its step stamp); a plain Stop leaves it unset and
  arms no watchdog.
- Whether a settle (or the watchdog) may consume a pending `advanceOnComplete` is decided by
  the `advanceOnCompleteStep` stamp matching the current step index — not by `turnSource`,
  which previously left a step stranded at `running` forever if a user-source turn happened to
  be live when force-advance fired. The turn source only gates the (unrelated)
  cost/token/duration accumulation.
- An interrupted settle (`interrupted === true`) always parks unless it is also the `forced`
  (stamped force-advance) exception — this overrides both the `autoAdvance` toggle and a
  pending plan-approval advance, so Stop's park behavior can never be reintroduced as a leak
  through either path.
- Never advance a workflow synchronously under a live turn — always flag-and-wait via
  `advanceOnComplete`, with the watchdog as the only fallback if nothing ever settles it.
  Never call `advance()` directly on a `running` step while its turn is still active; set the
  flag then call `SessionManager.interrupt()`.
- The `handleWorkerEnded` settle fallback must stay gated on the `interrupting` set:
  non-error `ended` events are routine (fresh-start step boundaries close the old query).
- The watchdog must clear `turnSource` when it fires, so a late arrival from the abandoned
  turn is unambiguously ignored by the stamp check rather than racing the next step's own
  turn.
- Both stall recoveries are guarded no-ops the user must trigger — the workflow engine does
  not self-heal a stalled step; a human always presses the button. They reuse `runStep`'s
  existing step-entry behavior (for `pending`) and `advance()`'s (for `done`) rather than
  duplicating hand-off or consolidation logic.
- A `done`-at-current-index recovery must key off `advancing`, never
  `isSessionActive(meta.status)`: `advance()` sets no session status, so the status left over
  from before the approve says nothing about whether an advance is live.
- `advance()` must persist the `stepIndex` bump itself, immediately after setting it, rather
  than letting it ride a later broadcast — leaving it to `runStep`'s own broadcast makes the
  unrecoverable `done`-at-current-index shape the durable state for the whole consolidation
  window.
- The in-flight `advancing` flag is server-owned broadcast state only — never a local
  `useState` on the button. Local optimistic state would spin forever on `approve()`'s
  stale-index / wrong-status guards, or on a `send()` a closed socket silently drops.
- The clear-before-branch design assumes no `await` is ever inserted between clearing the
  `advancing` flag and the next broadcast (`runStep`'s `setStatus`, or the terminal
  `setStatus('idle')`); adding one would reopen a window where a client briefly sees
  `advancing: false` with a stale status.
- Clearing `advancing` on restart belongs in the constructor load loop, and clearing on
  hand-off belongs in `adoptSynced()` — never in `reconcileWithWorker()`, which runs far more
  often and would falsely clear a live advance.
- `runStep`'s silent early-return paths must call `SessionManager.persistMeta` before
  returning, so a cleared flag and bumped `stepIndex` always reach the client instead of
  relying on a broadcast that never comes.
- Consolidation reuses the transcript-walking pattern from `lastAssistantText`/`summarizeTurn`
  and the one-shot non-agentic query shape from `summarizeTurn`/`autoName`, rather than
  introducing a new query pattern.
- `advance()` is `async`; callers fire it with `void this.advance(sessionId)` since nothing
  downstream awaits its completion.
- `findStepStart`, `substituteTokens`, and `usesHandoffTokens` are pure functions (no
  `this.store`/network), enabling direct unit tests with synthetic transcript events.
  `collectTurns` is the one exception: it optionally reads a plan file from disk (`roots`
  defaults to `[]`, so existing callers that pass none keep the old transcript-only
  behavior), still with no `this.store` dependency — tests exercise the disk read by passing
  a real temp directory as `roots`.
- All prompt tokens are filled in one pass over the template rather than by chained
  `replaceAll` calls. Staged passes rescan what earlier passes inserted, which makes
  substituted content executable as template — any new token must be added to
  `substituteTokens`, not appended as another pass.
- Shipped step templates (`DEFAULT_WORKFLOW`'s "Implement MVP") tell the model to work only
  from the plan text supplied in the prompt and never read `~/.claude/plans/`; user-authored
  shared steps need the same edit made by hand in the UI, since they live in per-user
  storage, not the repo.
- `isWorkflowFinished` is kept separate from `sessionRowMeta`'s
  `{ color, label, actionable }` return rather than folded in: `projectStatusMeta` (project
  tab dot) and `alerts.ts` (notifications) both consume that shape, and workflow-done is not
  an actionable state, so folding it in would leak a checkmark into places that only care
  about things needing the user's attention.

## Related decisions

- [turn-recovery](turn-recovery.md) — the failed-turn variant of this park (`stepFailure`,
  the skipped `setStatus`, `autoAdvance` no longer firing on failure), and the failure row
  and Retry the missing-`{outputs.*}` park gets via `failTurn`.
- [multi-repo-commits](multi-repo-commits.md) — owns `{roots}`, `multiRepoDiff`, and the
  per-repo diff split budget in detail.
- [session-and-project-ui](session-and-project-ui.md) — the sidebar status badge and project
  tab dot the finished-workflow icon shares its precedence chain with.
- [transcript-performance](transcript-performance.md) — the tail-windowed transcript the
  stepper's jump-to-step has to cooperate with.
- [session-rewind](session-rewind.md) — a rewind mid-workflow parks the current step at
  `waiting-approval` the same way as here, but re-derives `stepIndex`/`stepStatuses` from the
  surviving transcript's markers rather than from a live turn settling.
