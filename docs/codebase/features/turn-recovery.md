# Turn recovery

Covers: `interrupted-turn-recovery`, `turn-failure-retry`, `auth-failure-recovery`,
`app-managed-login-only`.

## Purpose

Everything that gets a turn back on its feet after it dies: a turn that died with the app, a
turn that failed, a turn whose credential was rejected, and the rule that a turn never starts
on a credential the app cannot refresh.

A turn that died with the app (bridge and worker both gone) is detected on reconnect, shown as
a yellow Continue banner, and resumed on click — or automatically, if
`autoContinueInterrupted` is on. Sessions the worker is still running are healed in the other
direction instead, so a bridge restart never mistakes a live turn for a dead one. The same
machinery covers a worker that never comes back at all — past a deadline the bridge stops
waiting for a `hello` that may never arrive and reconciles as if the worker had reported an
empty live list, and a global banner tells the user their agent process is gone rather than
leaving a silent spinner.

Every recoverable turn failure — a crashed query, an `is_error` SDK result, a workflow step
that never got a prompt (unresolved step ref, missing `{outputs.*}`), or a push that never
reached the worker — ends on a failure row with a working single-click Retry, in both a plain
session and a workflow session. Before this, a failure inside a workflow step left no Retry
(the trailing transcript item was a park marker, not the failed result, and the session's
`waiting-approval` status made `retryTurn`'s busy guard refuse the click even if one had
rendered), and some pre-run failures wrote no failure row at all.

Beyond auth, four more failure shapes get the same actionable-banner treatment: a
content-filter refusal, a context-length overflow, a malformed/invalid request, and an
overloaded/rate-limited API. Each rewrites the raw CLI text into a banner naming what's
available in-session — Retry, a rephrased retry, a model switch, or (inside a workflow)
**Skip step** — instead of leaving a bare Retry under text like "output blocked by content
filtering policy". Auth is tried first and always wins if the text matches both; unlike auth,
none of these four *do* anything (no refresh, no retry) — only the banner and, for two of the
four, the re-sent prompt change.

When the app-managed OAuth token is rejected during a turn, recovery happens in the same turn:
refresh the token if the refresh token is still good, or log out — which opens the browser's
login modal immediately. The outcome is made **visible**: the failed turn's banner is
rewritten to name the action the user must actually take, and when a sign-in is genuinely
required a **Sign in** button appears next to Retry. Before this, the raw CLI text (`Failed to
authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.`)
was shown with only a bare Retry button, even when the token had already been silently
refreshed (Retry would have worked) or the refresh itself had failed with no visible reason.

Underneath all of it: the app's own OAuth login (`~/.lines-app/users/<id>/auth.json`) is the
sole credential any Claude query runs on. The ambient Claude Code CLI login (`~/.claude`) is
never a fallback — it is a separate token store this app cannot refresh, so inheriting a stale
one makes every turn 401 forever with no login prompt. Three paths could previously fall
through to ambient credentials: a turn pushed while the app token was missing or inside its
refresh margin spawned the CLI child with no `CLAUDE_CODE_OAUTH_TOKEN` at all; the
bridge-side helper queries (`autoName`, `summarizeTurn`, `consolidateStepOutput`) read a sync
token cache and omitted the env key when it was null; and a proactive refresh that failed
transiently (offline at wake, 5xx) was never retried, so the token rotted until a turn hit a
401.

## Entry points

- `server/src/workerClient.ts` (`onHello` → `withQueuedPushes`; `checkWorkerLost`,
  `WorkerClient.status`)
- `server/src/sessions.ts` (`SessionManager.reconcileWithWorker`, `continueTurn`,
  `markTurnLive`)
- `server/src/userRegistry.ts` (`UserRegistry.onWorkerLost`)
- `web/src/components/SessionView.tsx` (Continue banner, sends `continueTurn`; Sign in and
  Skip step buttons in the session-level error alert)
- `web/src/components/WorkerBanner.tsx` (global "worker not responding" / protocol-mismatch
  strip)
- `web/src/components/SettingsModal.tsx` (Sessions pane, "Recovery" subgroup)
- `web/src/components/Sidebar.tsx` (session row indicator)
- Retry button click: `web/src/components/Transcript.tsx` → `retryTurn` client message →
  `server/src/index.ts` (`case 'retryTurn'`)
- A turn failing: `SessionManager.handleWorkerEnded` (query crash, via `failTurn`) and the
  `msg.type === 'result'` branch of `SessionManager.handleWorkerEvent` (error result)
- Any turn start: `SessionManager.prompt` and `SessionManager.compactContext`, both via
  `pushTurnSafely`
- Session rename / turn summary / workflow step consolidation: the three bridge-side one-shot
  `query()` calls in `sessions.ts`
- `AuthManager` construction and every `persistTokens`, which (re)arm the proactive timer

## Files

- `server/src/workerProtocol.ts` (`LiveSessionInfo.busy`)
- `server/src/worker.ts` (`SessionState.busy`, `hello` live list)
- `server/src/workerClient.ts` (`WORKER_LOST_MS`, `onWorkerLost`, `onStatusChange`,
  `WorkerClient.status`)
- `server/src/userRegistry.ts` (`onWorkerLive` → per-user `sliceFor`; `onWorkerLost`)
- `server/src/index.ts` (blind-clear timer, `continueTurn` handler, `case 'retryTurn'`,
  wiring `onStatusChange` to every context's broadcast)
- `server/src/userContext.ts` (field-merge of sync-pulled settings)
- `server/src/sessions.ts` (`SessionManager.failTurn` (public), `lastPromptForRetry`,
  `pushTurn`, `pushTurnSafely`, `pushWithToken`, `ownerToken`, `buildQueryOptions`,
  `authRefusalMessage`, `recoverAuthFailure`, `authRecoveryMessage`, `setStatus`, the
  `result`-branch status/errorMessage assignment, `handleWorkerEnded`'s error branch,
  `TurnCompleteListener`)
- `server/src/workflows.ts` (`WorkflowEngine.retryIfFailed`, `runStepSafely`,
  `onWorkflowTurnComplete`, the two pre-run failure sites in `runStep`)
- `server/src/auth.ts` (`ensureFreshToken`, `scheduleProactiveRefresh` backoff,
  `AUTH_FAILURE_PATTERNS`, `isAuthFailureMessage`, `AuthManager.handleTokenRejected`,
  `TokenRejection`)
- `server/src/turnFailure.ts` (`classifyTurnFailure`, `turnFailureAdvice`,
  `turnFailureRetryHint`, the four `TURN_FAILURE_PATTERNS` groups)
- `server/src/autoGuard.ts` (`isSelfWorkerSource` — always-ask on edits to the worker's own
  source)
- `shared/types.ts` (`SessionMeta.interruptedAt`, `UserUiSettings.autoContinueInterrupted`,
  `WorkerStatus`, `WorkflowState.stepFailure`, `WorkflowMarkerData.failed`,
  `SessionErrorKind`, `SessionMeta.errorKind`, `resultErrorText`, `TurnFailureKind`)
- `web/src/store.ts` (`autoContinueInterrupted`, `pushSettings`/`applySettings`,
  `workerStatus`, `authStatus` handler that opens/force-opens the login modal — unchanged)
- `web/src/components/SessionView.tsx`, `web/src/components/SettingsModal.tsx`
- `web/src/components/Sidebar.tsx`, `web/src/lib/format.ts` (`sessionRowMeta`)
- `web/src/components/WorkerBanner.tsx`, `web/src/components/StorageBanner.tsx` (pill
  precedence)
- `web/src/components/Transcript.tsx` (the backward scan for `retryKey`, `WorkflowMarker`'s
  failed label, `FailedTurnActions` — Sign in + Skip step + Retry)
- `web/src/lib/transcript.ts` (`isFailedResult`, `resultErrorText`, the compaction-span
  escape; builds the `ResultItem` the Retry button keys off)
- `web/src/components/LoginModal.tsx` (the modal a refusal reopens)

## Symbols

- `LiveSessionInfo.busy` (`true` = turn in flight, `false` = query open but settled,
  `undefined` = worker too old to say)
- `SessionManager.reconcileWithWorker` — takes `{ autoContinue?: boolean }`; the worker-lost
  path passes `autoContinue: false` so sessions are flagged for the banner without also firing
  a resume that would just re-queue into `WorkerClient.pending`
- `SessionManager.markTurnLive` (promote a stale-idle session back to running)
- `SessionManager.continueTurn`
- `hasUnresolvedAlwaysAsk` (`server/src/sessions.ts`) — gates both auto-continue's `flagged`
  list and `expireUnresolvedPermissions`
- `SessionMeta.interruptedAt` (the banner flag)
- `sessionRowMeta` (`web/src/lib/format.ts`) — sidebar row equivalent of the banner
- `withQueuedPushes` (bridge-side: a queued `push` counts as live)
- `UserUiSettings.autoContinueInterrupted`
- `WORKER_LOST_MS` (`server/src/workerClient.ts`) — how long the socket may be down before the
  outage is treated as real
- `WorkerClient.status` / `onStatusChange` — derived `WorkerStatus` (`connected`, `since`,
  `mismatch`), published only on a transition
- `UserRegistry.onWorkerLost` — reconciles every context's sessions with an empty live list,
  `autoContinue: false`
- `WorkerStatus` (`shared/types.ts`) — the `hello.worker` / `workerStatus` broadcast payload
- `WorkerBanner` — the global pill rendering `WorkerStatus`
- `isSelfWorkerSource` (`server/src/autoGuard.ts`) — true for
  `worker.ts`/`workerProtocol.ts`/`workerMcp.ts` under this bridge's own `server/src`
- `SessionManager.failTurn(sessionId, error)` — the single funnel that shows a turn as failed:
  emits a synthetic `result` event, then sets status `'error'` + `errorMessage`; also one of
  the two classification points, calling `classifyFailure` after `setStatus`
- `SessionManager.classifyFailure(sessionId, error)` (private) — tries `recoverAuthFailure`
  first (auth wins outright); if that reports no match, tries `classifyTurnFailure` and, on a
  hit, rewrites the banner via `turnFailureAdvice`. Synchronous, unlike the auth path — no
  refresh to await — so it always lands before `WorkflowEngine`'s failed-park
- `classifyTurnFailure(message): TurnFailureKind | null` (`turnFailure.ts`) — first matching
  kind wins, checked in order `'filtered'` → `'context'` → `'invalid'` → `'overloaded'`; `null`
  leaves the raw text and plain Retry, same as before this feature existed
- `turnFailureAdvice(kind, { inWorkflow }): string` (`turnFailure.ts`) — the banner text for a
  kind; appends a "…or approve the step to skip it" sentence only when `inWorkflow` is true
- `turnFailureRetryHint(kind): string | null` (`turnFailure.ts`) — non-null only for
  `'filtered'`/`'context'`, the two kinds where rephrasing the prompt changes the outcome;
  `null` for `'invalid'`/`'overloaded'`/`'auth'`/undefined
- `SessionManager.lastPromptForRetry(sessionId)` — the last user prompt + attachments
  rehydrated from disk, extracted out of `retryTurn` so `WorkflowEngine.retryIfFailed` can
  reuse it
- `WorkflowEngine.retryIfFailed(sessionId): boolean` — consumes a Retry click for a workflow
  session whose current step failed; returns `false` for a plain session or a step that parked
  normally, so the caller falls through to `SessionManager.retryTurn`
- `WorkflowState.stepFailure?: 'pre-run' | 'turn'` — set on the step that is currently
  parked-as-failed; `'pre-run'` means it never got a prompt (re-render via `runStep`),
  `'turn'` means its turn failed (re-send the prompt via `iterateStep`)
- `WorkflowMarkerData.failed` — set on a `'waiting-approval'` marker whose park was a failure,
  so the divider reads "failed, retry or approve to skip"
- `isAuthFailureMessage(message)` — narrow regex match over SDK/CLI error text
  (`invalid_grant`, `authentication_error`, `invalid bearer token`, `401 Unauthorized`,
  `oauth … token … expired`, `oauth authentication failed`, `please run /login`,
  `re-authenticate to continue`)
- `AuthManager.handleTokenRejected(): Promise<TokenRejection>` — no-op-but-reports when
  already logged out (`{ outcome: 'signed-out' }`), else one `forceRefresh()`; success is
  `{ outcome: 'refreshed' }`, a dead refresh token is `{ outcome: 'signed-out' }`, any other
  failure (5xx, offline) is `{ outcome: 'refresh-failed', error }` and leaves the session
  signed in
- `resultErrorText(msg)` — the error text of an SDK `result` message: prefers `msg.result`,
  falls back to `msg.errors[]` joined with `\n` (an `SDKResultError` carries no `result` at
  all). Shared between server and web so both read a failure the same way
- `SessionManager.recoverAuthFailure(sessionId, error): boolean` — returns `false` immediately
  for a non-auth-classified message (or no `AuthManager`), which is what lets `classifyFailure`
  fall through to `classifyTurnFailure`. Otherwise returns `true` and, async, awaits
  `handleTokenRejected()` and rewrites the failed turn's `errorMessage`/`errorKind` via
  `setStatus` — but only if the session is still showing that exact error
- `authRecoveryMessage(rejection)` — the three actionable strings ("…has been renewed. Retry to
  continue.", "…could not be renewed. Sign in to Claude, then Retry.", or the shared
  `authRefusalMessage` text for a transient failure)
- `SessionMeta.errorKind?: SessionErrorKind` (`'auth' | 'filtered' | 'context' | 'invalid' |
  'overloaded'`) — set alongside `errorMessage` whenever the failure has a named next action;
  `'auth'` drives the Sign in button specifically, the other four drive the rewritten banner
  copy and (inside a workflow) the Skip step button. Same lifetime as `errorMessage`
- `skippableFailedStep(session): number | null` (`web/src/lib/format.ts`) — the step index a
  Skip step button may target, or `null`. Mirrors `WorkflowEngine.retryIfFailed`'s own gate
  (`stepFailure` set, no advance in flight, that step parked at `waiting-approval`) so the
  button never appears for a click the server would refuse
- `SessionManager.pushTurn(meta, message)` — async; resolves a token via `ensureFreshToken()`
  before the spawn, and refuses the turn if it cannot get one
- `SessionManager.pushTurnSafely(meta, message)` — the fire-and-forget wrapper both call sites
  use, so a throw past `pushTurn`'s own handling cannot become an unhandled rejection
- `authRefusalMessage(err)` — the two user-facing refusal strings (not signed in vs. refresh
  failed) in one place; also reused by `authRecoveryMessage` for its `'refresh-failed'` outcome
- `SessionManager.ownerToken()` — async token for the bridge-side helper queries; returns
  `null` rather than falling back, and each caller skips its query entirely on `null`
- `PROACTIVE_RETRY_MS` / `PROACTIVE_RETRY_CAP_MS` — 60s first rung, 15min ceiling for the
  proactive-refresh retry ladder
- `SessionManager.ranHere(id)` (private) — true when this instance has live state for the
  session or a non-empty local transcript; the scope guard for `reconcileWithWorker`'s skip below

## Data flow

### Interrupted-turn detection and resume

The worker tracks `busy` per session (`true` on `push`, `false` on the turn's `result`) and
reports it in `hello.live`. `WorkerClient` folds in the sessions whose `push` is still queued
locally — the snapshot predates that flush — and hands the merged list to
`reconcileWithWorker`, per user via `UserRegistry.sliceFor`.

Reconcile first skips any session with neither a worker report (`info` undefined) **nor**
`ranHere(id)` — no live state and no local transcript. Such a session exists on this instance
only because storage sync (`adoptSynced`) pulled it from another machine; it never ran here, so
promoting, demoting, restamping or auto-continuing it would broadcast and cloud-push a turn this
machine has no business touching. A session with an actual worker report for this pass is still
fully reconciled even with an empty local transcript, since a live report is itself evidence this
instance is the one running it now.

Reconcile then moves in both directions for every session that passes that check. `busy: true` on
a session we believe is idle calls `markTurnLive` (status back to `running`, keep a known
`turnStartedAt`, clear `interruptedAt`). Absent from the list, or `busy: false`, on a session we
believe is `running`/`waiting-permission` demotes it to `idle`, pauses any queue, and stamps
`interruptedAt`. `busy: undefined` demotes only.

`continueTurn` expires the dead turn's orphaned permission cards, releases `queuePaused`, and
re-prompts with a synthetic nudge, resuming through `claudeSessionId`. A turn interrupted
mid-workflow-step resumes with source `'workflow'` so its result still parks the step for
approve/retry. A card for an `ALWAYS_ASK_TOOLS` request (`ExitPlanMode`, `AskUserQuestion`) is
skipped by this expiry — see [permissions-and-plan-mode](permissions-and-plan-mode.md).

Unless `autoContinueInterrupted` is `false`, reconcile then calls `continueTurn` for the
sessions **that pass flagged**, after the `maybeFlush` sweep, each inside its own try/catch. A
session demoted with an unresolved `ALWAYS_ASK_TOOLS` card is stamped `interruptedAt` (banner
still shows) but never added to `flagged`, so auto-continue cannot resume it — its nudge text
("continue the task from there") would otherwise read as an approval the user never gave.

### Failing a turn and retrying it

**Router.** `server/src/index.ts`'s `case 'retryTurn'` mirrors `case 'prompt'`'s workflow-first
idiom: `workflows.retryIfFailed(sessionId)` runs first and short-circuits on `true`; otherwise
`sessions.retryTurn(sessionId)` handles it (a plain session, or a workflow session whose step
didn't fail).

**Producing a failure.** Every failure funnels through one of two writers:

- `SessionManager.failTurn` — for a crashed query (`handleWorkerEnded`'s error branch), a push
  that never reached the worker (`pushTurnSafely`'s catch), and a workflow pre-run failure
  (unresolved step ref, missing `{outputs.*}`) inside `runStep` and its `runStepSafely` wrapper.
- The `result` branch of `handleWorkerEvent` — for an `is_error` SDK result. Sets
  `status: 'error'` + `errorMessage` (previously always `'done'`, so a failed non-workflow
  turn's `SessionView` banner never showed). The error text comes from `resultErrorText(msg)`,
  which falls back to `msg.errors[]` when the SDK reported no `result` at all (an
  `SDKResultError`) — reading `result` alone degraded those to the generic `'The turn failed.'`.
  This branch also calls `SessionManager.recoverAuthFailure` after its upsert, since it
  bypasses `failTurn` by design.

Both paths report the failure to `WorkflowEngine` via a fourth `failed` argument on
`TurnCompleteListener`. `handleWorkerEnded`'s error branch fires the listener itself (with the
`turnSource` it captured before clearing it) so a workflow step doesn't dangle at `'running'`
forever with no settle ever coming — listener call only, since `failTurn`'s synthetic result
deliberately bypasses `handleWorkerEvent` and must not re-run spend/token accumulation a
second time.

**Parking as failed.** `WorkflowEngine.onWorkflowTurnComplete` skips `autoAdvance` when
`failed` is true (an explicit force-advance still wins) and, at the park, sets
`stepFailure = 'turn'` instead of calling `setStatus('waiting-approval')` — `setStatus` is what
clears `errorMessage` on every transition, so skipping it here is what keeps the banner and the
Retry button alive while the step still shows `waiting-approval` (Approve can still skip it).
The marker gets `failed: true`. A pre-run failure sets `stepFailure = 'pre-run'` directly at
the failure site, before the corresponding `failTurn` call.

**Consuming a Retry.** `WorkflowEngine.retryIfFailed` bails (returns `false`, so the
plain-session path handles it) when there's no workflow, no `stepFailure`, the step isn't
parked at `waiting-approval`, an advance is in flight (`advancing`), or the session is
otherwise busy. Otherwise: `'pre-run'` re-enters `runStep` (via `runStepSafely`) as a normal
step entry, hand-off included; `'turn'` looks up the last prompt via `lastPromptForRetry` and
re-sends it through `iterateStep` (same conversation, `'retried'` marker, no advance).
`stepFailure` is cleared the moment the step runs again (`runStep`, `iterateStep`) or the
workflow moves on (`advance`), so the next park is judged on its own.

**Client-side.** `Transcript.tsx` scans `built` backward from the end for `retryKey`, skipping
over `'workflow'` (a park marker) and `'context-compact'` items — either can land after a
failed result without meaning the turn moved on — and stopping at anything else (a live
permission card, or any content belonging to a new turn). `transcript.ts` lets a failed
`result` close an already-open compaction span instead of being dropped by it, sharing the
`isFailedResult` predicate with the item builder — the server has already abandoned the span by
the time that result is emitted, so the client must not swallow the only failure row Retry can
key off.

### Auth-failure recovery

Turn fails → the failure is classified in exactly two places: `failTurn` (query crash, a push
that never reached the worker, workflow pre-run failures) and the `result` branch of
`handleWorkerEvent` (an `is_error`/non-`success` SDK result, which bypasses `failTurn` by
design). Both call `recoverAuthFailure(sessionId, resultErrorText(msg))`:

- not auth-classified, or no `AuthManager` wired (ambient-token mode) → no-op; the raw
  text-plus-Retry behavior, unchanged.
- auth-classified → `auth.handleTokenRejected()` → `AuthManager.refresh()`:
  - `{ outcome: 'refreshed' }` → banner becomes "The Claude login expired mid-turn and has been
    renewed. Retry to continue."; no `errorKind`; no modal.
  - `{ outcome: 'signed-out' }` (already logged out, or the refresh token was dead) → banner
    becomes "…could not be renewed. Sign in to Claude, then Retry."; `errorKind: 'auth'` — this
    also `logout()`s when it was a live refresh token dying, which broadcasts
    `{ type: 'authStatus', auth: { loggedIn: false } }` and force-opens the login modal
    independently of the banner rewrite.
  - `{ outcome: 'refresh-failed', error }` (5xx, offline) → banner becomes the shared
    `authRefusalMessage(error)` text; no `errorKind`; the user stays signed in.

The revision only lands if the session is still showing the exact failure that triggered it
(`status === 'error' && errorMessage === error`) — a flushed queue, a Retry click, or a
workflow advance that happened while the refresh was in flight all skip the rewrite, since the
banner is no longer this recovery's to own. Recovery itself (the refresh attempt) always runs
regardless.

On the client, `SessionView`'s alert and `Transcript`'s `FailedTurnActions` both render a Sign
in button only when `session.errorKind === 'auth'` **and** `auth.loggedIn === false` — the
second half is what retires a stale Sign in button after a re-login with no server sweep
needed.

Independently, `failTurn` still emits a synthetic SDK-shaped event
(`{ type: 'result', subtype: 'error_during_execution', is_error: true, result: <error> }`)
before flipping the status to `error`, so `transcript.ts` builds a `ResultItem` and the
transcript keeps the raw CLI text as the durable diagnostic record — only the banner changes,
never the transcript row.

### Non-auth failure classification

`classifyFailure(sessionId, error)` is the single dispatch point at both existing
classification sites (`failTurn`, and the `result` branch of `handleWorkerEvent`) — it replaces
the direct `recoverAuthFailure` calls those sites used to make. It tries `recoverAuthFailure`
first; a `true` return means the message was auth-shaped and that path owns the (async)
rewrite, so `classifyFailure` returns immediately. Only a `false` — not auth-shaped, or no
`AuthManager` wired — moves on to `classifyTurnFailure(error)`.

`classifyTurnFailure` matches one of four kinds, or `null`:

- `'filtered'` — a content-filter/usage-policy refusal (e.g. "output blocked by content
  filtering policy", a `refusal` stop reason). Usually a large verbatim text block triggered
  it, not the task itself.
- `'context'` — the prompt exceeded the model's context window (`prompt is too long`,
  `context_length_exceeded`).
- `'invalid'` — the API rejected the request as malformed (`invalid_request_error`, a plain 400
  not otherwise explained).
- `'overloaded'` — the API is overloaded or rate-limited (`overloaded_error`, `rate_limit_error`,
  a 429/529 whose surrounding text says so).

On a hit, `classifyFailure` re-checks the same don't-clobber guard the auth path uses
(`status === 'error' && errorMessage === error`) and, if it still holds, calls `setStatus` with
`turnFailureAdvice(kind, { inWorkflow: !!meta.workflow })` and the kind. Unlike the auth path
this whole branch is synchronous — there is no refresh to await — so it always completes before
`onTurnComplete` fires and therefore before `WorkflowEngine` parks a failed step. That park
writes through `persistMeta`, not `setStatus` (see "Parking as failed" above), which is what
lets the rewritten message and `errorKind` survive it.

The rewritten banner rides the same synthetic-result-then-error-status shape every failure
gets: the raw CLI text stays in the transcript as the durable record, and only `errorMessage`
changes.

**Retry hint.** `SessionManager.lastPromptForRetry` — already the single source both
`retryTurn` and `WorkflowEngine.retryIfFailed` read from — appends
`turnFailureRetryHint(meta.errorKind)` to the re-sent prompt text when it's non-null (only for
`'filtered'`/`'context'`; `'invalid'`/`'overloaded'`/`'auth'`/undefined add nothing). The hint
rides only the re-sent prompt, which is what appears in the transcript as a new `'user'` event
— the original failed turn's stored prompt is untouched. A workflow step parked with
`stepFailure: 'pre-run'` never reaches this function (no prompt was ever sent for it), so it
never gets a hint either — expected, since `retryIfFailed` re-enters the step via `runStep`
instead.

**Skip step.** A workflow session parked as failed (`stepFailure` set, current step at
`waiting-approval`, no advance in flight) can skip the step instead of retrying it: both
`SessionView`'s alert and `Transcript`'s `FailedTurnActions` show a **Skip step** button
(gated by `skippableFailedStep`) that sends the *existing* `{ type: 'workflowApprove',
sessionId, stepIndex }` — the same message `WorkflowStepper`'s Approve button already sends, so
no new `ClientMessage` variant and no server change were needed. See
[workflow-step-lifecycle](workflow-step-lifecycle.md) for what `approve()` does with it.

### App-managed login is the only credential path

A turn push resolves its own credential before spawning:

`prompt`/`compactContext` → `pushTurnSafely` → `pushTurn` → `auth.ensureFreshToken()`

- token resolved (refreshing in-margin) → `pushWithToken` → recycle the query if it was spawned
  with a different token → `worker.push` with
  `env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token }`.
- `AuthRequiredError` (logged out) → `failTurn` with "Not signed in to Claude. Sign in, then
  Retry." **and** a re-broadcast of `{ type: 'authStatus', auth: { loggedIn: false } }`, which
  `store.ts` force-opens the login modal on — reopening a dismissed one.
- any other refresh error (offline, 5xx) → `failTurn` with the refresh reason; the user stays
  signed in and can Retry once connectivity returns.

The bridge-side helpers take the same path through `ownerToken()`, but a `null` simply skips the
query: `autoName` keeps the default session name, `summarizeTurn` writes no summary,
`consolidateStepOutput` falls back to `lastAssistantText`. None of them ever spawn a CLI child
without an explicit app token.

Independently, a failed proactive refresh reschedules itself on a doubling backoff (60s → 15min
cap) instead of leaving the token to rot; `persistTokens` resets the ladder, and `logout()`
clears both the timer and the ladder.

## Dependencies

Reuses the existing single-flight `AuthManager.refresh()`, the existing `authStatus` broadcast
and its force-open behavior in `store.ts`, the existing `emitEvent` transcript writer, the
existing `setStatus` / `sessionUpsert` path, and the existing `LoginModal` + `openLoginModal()`.
One wire field (`SessionMeta.errorKind`), one shared pure function (`resultErrorText`). No new
message type, no new modal, no new client state, no DB migration.

## Tests

- `server/src/sessions.reconcile.test.ts` — promote/demote/old-worker matrix, event-based
  healing, stop-ordering, `withQueuedPushes`, the auto-continue cases (fresh flag resumes,
  absent setting resumes, explicit `false` does not, stale flag does not, workflow source
  preserved, a meta with no `caveman` resumes, one failing session doesn't stop the others,
  `result`/archive clear the flag, an unresolved `ExitPlanMode` card blocks auto-continue and
  is not expired by `continueTurn`, an ordinary tool's card still expires), the worker-lost
  case (reconciled with an empty live list, `autoContinue: false`, never auto-resumed), and the
  no-local-history skip (a session with no live state and no transcript on this instance is left
  alone; a session with an actual worker report is still fully reconciled even with no local
  transcript).
- `server/src/workerClient.test.ts` — `onWorkerLost` fires once at the deadline and not on a
  reconnect inside it; `onStatusChange` publishes a disconnected status once per outage, a
  connected status once on recovery, nothing on an in-deadline reconnect, and a `mismatch`
  status for a worker that only ever answers on the wrong protocol version (without
  `everConnected` ever becoming true).
- `server/src/autoGuard.worker.test.ts` — `isSelfWorkerSource`/`assessToolCall` treat edits to
  this bridge's own `worker.ts`/`workerProtocol.ts`/`workerMcp.ts` as always-ask, leave a
  same-named file elsewhere untouched, leave reads untouched, and confirm a blanket
  `{ tool: 'Edit' }` allowlist entry cannot disarm the rule.
- `server/src/sessions.ended.test.ts` — a failed result marks the session errored with a
  Retry-able banner and still settles the turn's spend/listener; a crashed query settles the
  turn so a workflow step doesn't dangle; a push rejection fails the turn instead of wedging
  the session at `running`; the no-`AuthManager` path still pushes. Also: each of the four
  non-auth kinds rewrites the banner and sets `errorKind`; an unrecognised failure keeps its
  raw text and `errorKind: undefined`; an auth-shaped message wins over a coincidental 400 in
  the same text; `failTurn` classifies non-auth failures the same way as a `result`; a Retry
  after a `'filtered'` failure appends the hint to the re-sent prompt, and a Retry after
  `'overloaded'`/an unrecognised failure re-sends the prompt untouched.
- `server/src/turnFailure.test.ts` — each kind matches representative CLI/SDK error text; an
  unrelated failure and a filter-vs-generic-400 precedence case both resolve correctly; every
  string returned by `turnFailureAdvice` and `turnFailureRetryHint` is rejected by both
  `classifyTurnFailure` and `isAuthFailureMessage` (the anti-reclassification rule);
  `inWorkflow: false` omits the skip sentence; no kind's advice implies an automatic retry.
- `server/src/workflows.advance.test.ts` — a failed result parks the step, keeps the error
  status, and does not `autoAdvance`; spend still accumulates onto the step slot; a normal park
  carries no `stepFailure`. Also: a classified (non-auth) failure's rewritten banner and
  `errorKind` survive the failed-park, proving the `persistMeta`-not-`setStatus` invariant this
  feature leans on.
- The claimed `server/src/workflows.retry.test.ts` from an earlier revision of this doc does
  not exist in the repo; its coverage (`retryIfFailed` re-sends the last prompt for a `'turn'`
  failure, re-runs the step for a `'pre-run'` failure, ignores a normally-parked step and a
  plain session, and clears `stepFailure` on retry) lives in `workflows.advance.test.ts`
  instead. No web test infra beyond typecheck exists yet — the Skip step button and the
  Sign-in gate are manual-verified via the `verify` skill.
- `server/src/auth.failure.test.ts` — auth classification and recovery outcomes;
  proactive-refresh retry scheduling and the widened failure patterns.
- `server/src/sessions.spawn.test.ts` — a turn while logged out is refused instead of falling
  back to ambient credentials; a stale token is refreshed before the query spawns.
- The settings field-merge in `userContext.ts` is uncovered — `buildUserContext` wires sync,
  stores and a worker together with no seam. Verified by hand.

## Business rules

- Auto-continue only fires for sessions flagged by the reconcile that is running. A flag left
  from an earlier crash keeps its banner, so a restart can't fan out into a pile of unattended
  turns.
- Auto-continue never fires while a session holds an unresolved
  `ExitPlanMode`/`AskUserQuestion` card (`hasUnresolvedAlwaysAsk`) — that decision is the
  user's alone. The session still gets the banner and its sidebar dot; the card stays open and
  clickable, and a later click recovers it via `recoverOrphanedPermission` rather than the
  server nudging the turn forward on its own.
- `continueTurn`'s card expiry skips those same `ALWAYS_ASK_TOOLS` requests for the same reason
  — see [permissions-and-plan-mode](permissions-and-plan-mode.md).
- Auto-continue is on unless `autoContinueInterrupted` is explicitly `false`. Absent —
  including no `settings.json` at all — means enabled, so a fresh install recovers without
  configuration.
- A resume that throws is contained per session: the failure is logged, the session is put back
  into the flagged state so its banner returns, and the sessions after it still resume.
- Settings pulled from the storage server are merged field-wise, not replaced wholesale, so a
  client that predates a setting cannot erase it by omitting it from its payload.
- `interruptedAt` is cleared by a new prompt, by a `result` (the turn had in fact finished), by
  `markTurnLive`, and by archive/complete. It is deliberately **not** cleared by `ackSession` —
  viewing a session must not hide the banner before it can be read.
- The sidebar row shows the same yellow "interrupted" dot/badge as the banner, via
  `sessionRowMeta`, which reuses the banner's exact guard
  (`interruptedAt && !isSessionActive(status) && status !== 'error'`). It persists across
  switching to the session and back, for the same `ackSession` reason as the banner.
- The blind-clear timer in `index.ts` fires only when no worker ever answered *and* it never saw
  an incompatible protocol version; a worker that answered on an incompatible version is alive
  and possibly mid-turn, so its statuses are left alone (`WorkerClient.sawIncompatibleWorker`).
  A cold-start protocol mismatch is instead surfaced immediately through `WorkerStatus.mismatch`
  rather than waiting on this timer or the lost deadline.
- The socket may be down for `WORKER_LOST_MS` (20s) before the bridge treats it as a real
  outage rather than an ordinary tsx-watch restart, which reconnects in roughly 1-2s (retry
  loop plus the runtime-file watch). Only an outage past that deadline reconciles and shows the
  banner.
- The worker-lost path flags every in-flight session (banner, paused queue, `interruptedAt`)
  but never auto-continues them, even when `autoContinueInterrupted` is on — resuming would
  just re-queue the push into `WorkerClient.pending` against a worker that isn't there. The
  next real `hello` reconciles normally and, if flagged, resumes them then.
- `reconcileWithWorker` skips a session that has neither live state nor a local on-disk
  transcript (`ranHere`) — it only exists here because storage sync (`adoptSynced`) adopted it
  from another machine, and demoting/restamping/auto-continuing it would broadcast and
  cloud-push a turn this machine never ran. A session with an actual worker report for this pass
  is still fully reconciled even with no local transcript, since a live report is itself
  evidence.
- A cold-start protocol mismatch (a worker that has never once answered compatibly) cannot be
  caught by the lost deadline: `everConnected` never becomes `true`, so the outage clock never
  starts. It is instead surfaced the moment the mismatched `hello` is seen, via
  `WorkerStatus.mismatch`, independent of `WORKER_LOST_MS`.
- Exactly one of `ConnectionBanner`, `WorkerBanner`, `StorageBanner` renders at a time — all
  three share the same fixed position. `ConnectionBanner` (browser↔bridge down) outranks both;
  `WorkerBanner` (agent worker down) outranks `StorageBanner` (cloud sync paused), since a dead
  agent is worse than paused sync.
- Every recoverable failure (crashed query, `is_error` result, workflow pre-run failure, a push
  that never left the bridge) ends on a failure row with a working Retry button — in a plain
  session and inside a running workflow alike.
- A failed turn never `autoAdvance`s; it parks the step as failed instead. An explicit
  force-advance (`advanceOnComplete === 'interrupted'`, stamped for the step) still takes
  priority over the failure, honoring the user's own advance request.
- Retry re-runs the right thing: a step that never got a prompt is re-rendered from
  `WorkflowState`; a step whose turn failed is re-sent as a follow-up on the same conversation.
- No auto-retry or backoff — a transient failure (e.g. a 529) is an ordinary failed turn with a
  manual button, not a special transient-error class.
- `stepFailure` is persisted (part of `WorkflowState`), so a reload while parked in the failed
  state still shows Retry.
- An auth-classified turn failure attempts exactly one token refresh, then always rewrites the
  banner to name the next action — Retry, Sign in, or "check your connection" — instead of
  leaving the raw CLI text up with only a Retry button.
- `errorKind: 'auth'` is set only for `'signed-out'`; a `'refreshed'` or `'refresh-failed'`
  outcome clears it (Retry alone is enough there).
- The login modal opens off the existing `authStatus` broadcast, not a new message type. Unlike
  the `hello` auto-open, it is not deduped — a repeat failure reopens a dismissed modal, which
  is intended.
- Retry stays entirely manual — nothing auto-resumes a failed turn, even after a successful
  silent refresh or a fresh sign-in. This matters most for a login completed later or from
  another device: it must not fire N queued turns across every session that failed while signed
  out.
- `errorKind` is never set when no `AuthManager` is wired (ambient-token mode has no login flow
  to offer); the raw message and plain Retry are unchanged there.
- Every query crash (auth-related or not) still writes a synthetic `result` event, so the
  transcript shows "turn failed" and a Retry button, and that raw text is preserved verbatim as
  the durable record even after the banner is revised.
- A clean `ended` (no error) writes no synthetic result.
- A signed-in user's turn never runs on ambient `~/.claude` credentials. If no app token can be
  produced, the turn is refused — a visible failure with Retry is strictly better than a silent
  401 loop.
- A refusal from being logged out re-broadcasts the logged-out `authStatus` so a dismissed login
  modal reopens; a refusal from a transient refresh failure does not (the user is still signed
  in, and a modal would be the wrong ask).
- The bridge-side helper queries are best-effort: no token means skip, never fall back and never
  fail the surrounding turn.
- `compactContext` still returns a synchronous `{ ok: true }`; an auth refusal after that point
  surfaces through `failTurn`, not through the `{ ok: false, code, reason }` union.
- A proactive refresh that fails transiently retries on a 60s-doubling ladder capped at 15
  minutes; a dead refresh token instead logs out, which stops the chain.
- Logins are tracked per OAuth `state`, so two started at once (two tabs today, two paired
  devices once the app is hosted) each keep their own PKCE verifier and either paste completes.
  Completing one clears the rest; unfinished ones expire after 30 minutes. A paste carrying no
  `#state` falls back to the newest in-flight login.
- `accessToken: null` in `buildQueryOptions` is reachable only when no `AuthManager` is wired at
  all (tests / embedding), not for any real signed-in user.
- A content-filter, context-overflow, invalid-request or overloaded failure never implies an
  automatic retry, backoff, or step advance — same rule as every other failure in this feature.
  The banner only ever names an action for the user to take by hand.
- Auth wins outright when a failure text matches both an auth pattern and a `turnFailureKind`
  pattern (e.g. a 401 wrapped in a 400 envelope) — `classifyFailure` tries `recoverAuthFailure`
  first and only falls through to `classifyTurnFailure` on a `false`.
- The retry hint (`turnFailureRetryHint`) rides only the re-sent prompt text, never the stored
  transcript event for the original failed turn — the user sees exactly what was (re-)sent, and
  the original prompt's record is untouched.
- Skip step and the stepper's own Approve are two senders of the identical
  `{ type: 'workflowApprove', sessionId, stepIndex }` message, gated by the same conditions
  (`skippableFailedStep` mirrors `retryIfFailed`'s gate) — there is no separate skip code path
  to keep in sync.

## Architectural rules

- Adding a field to `LiveSessionInfo` is not a protocol bump; adding a message type is. `busy`
  was added as an optional field on purpose, so an old worker keeps working (demote-only)
  instead of having its socket closed with turns in flight.
- Reconcile must stay the only place that stamps `interruptedAt`. The banner means "your turn
  died", not "something looked odd".
- A `result` arriving for a session with `interruptedAt` set means the flag was wrong — a result
  buffered while the bridge was away lands after reconcile. Clear it there rather than adding
  ordering machinery to the handshake.
- `onStatusChange` (bridge health, for the UI) is kept separate from `onWorkerLost` (the
  session-reconcile trigger) rather than merged into one callback — one publishes health, the
  other drives a state transition, and coupling them would tie the banner to reconcile timing.
- `isSelfWorkerSource`'s check runs before the guard's blanket `{ tool: 'Edit' }`/
  `{ tool: 'Write' }` allowlist short-circuit, not after — a standing allowlist entry must not
  silently disarm the one write that kills the turn making it.
- `isSelfWorkerSource` is self-locating (resolves `worker.ts`/`workerProtocol.ts`/`workerMcp.ts`
  under this bridge's own `import.meta.dirname`) rather than threading session/bridge identity
  into `assessToolCall`, which otherwise knows only `roots: string[]`. A packaged build that
  doesn't run from `server/src` matches nothing, so the rule silently no-ops there (fails safe)
  rather than protecting a shipped app.
- `SessionManager.failTurn` is the single funnel for every failure the SDK never reports as a
  `result` — public specifically so `WorkflowEngine` can call it for pre-run failures instead
  of duplicating the synthetic-result-then-error-status shape.
- The retry router idiom mirrors `case 'prompt'`: the workflow engine gets first refusal
  (`retryIfFailed`), and only a `false` falls through to `SessionManager.retryTurn`. No new
  `ClientMessage` type — the client keeps sending `retryTurn`.
- `lastPromptForRetry` is the single source both `retryTurn` and `retryIfFailed` read from, so
  a workflow retry and a plain retry rehydrate attachments identically.
- `stepFailure` and `WorkflowMarkerData.failed` are additive optional fields — a failed park vs
  a normal `'waiting-approval'` park is otherwise indistinguishable to a consumer that predates
  this feature (e.g. `WorkflowStepper.tsx`, which keys off `stepStatuses`, not session status or
  `stepFailure`).
- `errorMessage`'s lifetime is deliberately widened: `'error'` status can coexist with
  `stepStatuses[i] === 'waiting-approval'`. Any future code path that calls `setStatus` inside
  the failed-park branch would silently kill the banner — `onWorkflowTurnComplete`'s failed
  branch calls `persistMeta`, never `setStatus`, for exactly this reason. `SessionMeta.errorKind`
  shares `errorMessage`'s lifetime and the same constraint: it must ride `persistMeta` on that
  branch too, never `setStatus`.
- The client's backward scan may only skip `'workflow'` and `'context-compact'` items; every
  other kind ends the scan, since it means a new turn (or a live permission request) started.
- Classification lives in `auth.ts` and `turnFailure.ts` (pattern matching, and for
  `turnFailure.ts` also the banner/hint text); `sessions.ts` owns dispatch (`classifyFailure`)
  and the actual `setStatus` call, never pattern matching itself. `worker.ts` stays thin and
  does no error interpretation.
- Classification happens at exactly two points: `failTurn` (covers every caller that funnels
  through it, including `pushTurnSafely` and the `workflows.ts` pre-run sites) and the `result`
  branch of `handleWorkerEvent`, which bypasses `failTurn` by design since the SDK already
  reported the result itself. Both now call `classifyFailure`, which is auth-first
  (`recoverAuthFailure`) then the four non-auth kinds (`classifyTurnFailure`).
- `turnFailureAdvice`'s and `turnFailureRetryHint`'s strings must not contain any word matched
  by `classifyTurnFailure`'s own patterns or by `AUTH_FAILURE_PATTERNS` — otherwise a rewritten
  banner would re-classify itself the next time this session fails. Same constraint as
  `authRecoveryMessage`, enforced by a dedicated test in `turnFailure.test.ts` rather than by
  review alone.
- `SessionMeta.errorKind`'s widened lifetime (see the `errorMessage`/`persistMeta` rule above)
  now covers five values instead of one; the failed-park branch must keep calling `persistMeta`,
  never `setStatus`, or every one of them stops surviving the park, not just `'auth'`.
- `handleTokenRejected` goes through the single-flight `refresh()` rather than `logout()`
  directly, so N simultaneous failures cause one token request; concurrent callers all resolve
  `'refreshed'`.
- The revision guard (`status === 'error' && errorMessage === error`) is the entire
  don't-clobber mechanism — no extra in-flight state. It relies on the workflow failed-park path
  using `persistMeta`, not `setStatus`, so a park leaves the message (and thus the guard's
  identity check) intact.
- The banner strings in `authRecoveryMessage` deliberately avoid every word
  `AUTH_FAILURE_PATTERNS` matches (`oauth`/`401`/`re-authenticate`/`/login`), so a re-failure
  showing one of them cannot re-classify itself into a recovery loop.
- A successful `refresh()` still does not call `emitChange()` — the visible signal for a silent
  recovery is the revised banner, not an auth-status broadcast; adding one would also spin
  `recycleIdleQueries()`/`usage.refreshSoon()` on every proactive refresh.
- The synthetic result is emitted via `emitEvent` directly, never routed through
  `handleWorkerEvent`, so it cannot re-run turn-settle bookkeeping (cost/token accumulation,
  `onTurnComplete`, workflow advance).
- SDK/CLI error wording is not a published contract; `isAuthFailureMessage` can silently stop
  matching after an upstream change — the fallback is the raw-text-plus-Retry behavior, never
  worse.
- The "never fall back for a signed-in user" guarantee lives in `pushTurn`, which refuses before
  reaching `buildQueryOptions` — there is deliberately no second options builder, since a
  builder-level split would duplicate the whole option set for one differing key.
- Both turn-start call sites go through `pushTurnSafely` rather than `void this.pushTurn(...)`,
  so there is one place guaranteeing no unhandled rejection.
- `ownerToken()` awaits `ensureFreshToken()` rather than reading `getAccessTokenSync()`: the
  helper queries deserve the same refresh-on-margin treatment as a real turn.
- The no-`AuthManager` branch of `pushTurn` returns before the first `await`, keeping that path
  synchronous so existing tests that assert an immediate push still hold.
- The proactive backoff computes its first rung explicitly (`null ? RETRY : min(x*2, CAP)`)
  rather than doubling a default, which would have skipped the 60s rung.
- `getAccessTokenSync()` remains on `AuthManager` but no longer has a production caller; it is
  kept for the sync-status shape tests rely on.
- The no-local-history skip is narrow and scoped to `reconcileWithWorker` only — it does not
  change `adoptSynced` or what counts as this instance owning a session. It exists because a
  flapping worker or a duplicate bridge process (see
  [hosted-machine-access](hosted-machine-access.md)) turned every reconcile pass into a
  broadcast/cloud-push storm across sessions this machine never actually ran, which is an
  amplifier for exactly the kind of loop this feature exists to break, not feed.
- **Known limitation:** in Compact view the failed row sits inside a collapsed `AgentTurn`, so
  `SessionView`'s alert is the always-visible affordance; this is pre-existing.

## Related decisions

- [session-and-project-ui](session-and-project-ui.md) — how these statuses render in the
  sidebar.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — the same park mechanism, reachable by
  a Stop as well as a failure; and the pre-run "missing `{outputs.*}`" park that now goes
  through `failTurn`.
- [permissions-and-plan-mode](permissions-and-plan-mode.md) — why auto-continue and expiry both
  defer to an open `ALWAYS_ASK_TOOLS` card.
- [context-window](context-window.md) — the compaction-span escape for a failed result that
  lands while a span is still open.
- [hosted-machine-access](hosted-machine-access.md) — the duplicate-bridge scenario the
  no-local-history reconcile skip guards against.
