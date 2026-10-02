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

For the one failure Retry cannot fix — a context-length overflow where the oversized prompt
that caused it is still in the CLI's own history, so an identical re-send just overflows again —
there is a third recovery path: [session-rewind](session-rewind.md) truncates the session's
transcript from a chosen sent message on and re-points the CLI conversation at the truncated
history, in place.

Beyond auth, four more failure shapes get the same actionable-banner treatment: a
content-filter refusal, a context-length overflow, a malformed/invalid request, and an
overloaded/rate-limited API. Each rewrites the raw CLI text into a banner naming what's
available in-session — Retry, a rephrased retry, a model switch, or (inside a workflow)
**Skip step** — instead of leaving a bare Retry under text like "output blocked by content
filtering policy". Auth is tried first and always wins if the text matches both; unlike auth,
none of these four *do* anything (no refresh, no retry) — only the banner and, for two of the
four, the re-sent prompt change.

When the app-managed OAuth token is rejected during a turn's `result` — the SDK surfacing the
rejection as an ordinary error result rather than a query crash — or that `result` reports an
overload/rate-limit, the turn is no longer settled at all: it is **transparently re-driven**. The
failed attempt is never shown to the user as a failure — the turn stays `running`, a fresh query
is spawned underneath it (a refreshed token, or after a short backoff), and the same prompt is
silently re-sent. The transcript keeps the failed attempt as a dimmed one-liner (same treatment as
a stopped turn), never a red banner. Only two things still end on a manual banner: a stored
credential that genuinely needs re-authentication (the refresh token itself is dead), and a
recovery that has exhausted its attempt budget (2 total for auth, 3 for overloaded) or a
connectivity hold that outlasted 5 minutes offline — see "Transparent turn recovery" below. This
reverses two of this feature's own former rules (no auto-retry, Retry stays manual); the reason
those rules existed — a login completing later, or on another device, must not fire N queued
turns across every session that failed while signed out — still holds, because a recovery is
anchored to one in-flight turn on one session, never to a login event.

**Two providers, one recovery path — except for auth.** Everything above applies to a session on
an OpenAI model too: the same banners, the same Retry, the same transparent re-drive for an
overload. The exception is auth recovery, which is Claude-only *by design*. The action it takes
is a Claude token refresh, so it cannot be the recovery for a codex turn, and running it would
light up the Claude Sign in button over a session that does not use that account. A codex turn
that cannot start is refused with its own message naming the Connect button instead. See
[openai-codex-sessions](openai-codex-sessions.md).

`app-managed-login-only` now spans both providers, but means something different on each: for
Claude it is "the app holds and refreshes its own OAuth token, and a turn that cannot resolve
one is refused"; for OpenAI it is "codex holds the credential and Lines never carries one into a
turn at all".

A query that crashes outright (`handleWorkerEnded`'s error branch) is unaffected by any of this:
there is no turn left in flight to re-drive into, so it still settles immediately and still ends
on the post-hoc banner rewrite described next. Before this feature, the raw CLI text (`Failed to
authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.`) was
shown there with only a bare Retry button, even when the token had already been silently refreshed
(Retry would have worked) or the refresh itself had failed with no visible reason.

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
- `web/src/components/SessionsSection.tsx` (Sessions pane, "Recovery" group)
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

- `server/src/workerProtocol.ts` (`LiveSessionInfo.busy`, `LiveSessionInfo.backgroundTasks` — see
  [background-tasks](background-tasks.md))
- `server/src/worker.ts` (`SessionState.busy`, `hello` live list)
- `server/src/workerClient.ts` (`WORKER_LOST_MS`, `onWorkerLost`, `onStatusChange`,
  `WorkerClient.status`)
- `server/src/userRegistry.ts` (`onWorkerLive` → per-user `sliceFor`; `onWorkerLost`)
- `server/src/index.ts` (blind-clear timer, `continueTurn` handler, `case 'retryTurn'`,
  wiring `onStatusChange` to every context's broadcast)
- `server/src/userContext.ts` (field-merge of sync-pulled settings)
- `server/src/sessions.ts` (`SessionManager.failTurn` (public), `lastPromptForRetry`,
  `pushTurn`, `pushTurnSafely`, `pushWithToken`, `dropFailedQuery`, `ownerToken`,
  `buildQueryOptions`, `authRefusalMessage`, `recoverAuthFailure`, `authRecoveryMessage`,
  `setStatus`, the `result`-branch status/errorMessage assignment, `handleWorkerEnded`'s
  error branch, `TurnCompleteListener`)
- `server/src/workflows.ts` (`WorkflowEngine.retryIfFailed`, `runStepSafely`,
  `onWorkflowTurnComplete`, the two pre-run failure sites in `runStep`)
- `server/src/auth.ts` (`ensureFreshToken`, `scheduleProactiveRefresh` backoff,
  `AUTH_FAILURE_PATTERNS`, `isAuthFailureMessage`, `AuthManager.handleTokenRejected`,
  `TokenRejection`)
- `server/src/turnFailure.ts` (`classifyTurnFailure`, `turnFailureAdvice`,
  `turnFailureRetryHint`, the four `TURN_FAILURE_PATTERNS` groups)
- `server/src/autoGuard.ts` (`isSelfWorkerSource` — always-ask on edits to the worker's own
  source)
- `server/src/caveman.ts` (`COMPRESS_RESPONSES_PROMPT` — vendored response-compression
  ruleset, appended to `systemPrompt.append` by `buildQueryOptions` when
  `UserUiSettings.compressResponses` is on; a plain constant, no I/O)
- `shared/types.ts` (`SessionMeta.interruptedAt`, `UserUiSettings.autoContinueInterrupted`,
  `UserUiSettings.compressResponses`, `WorkerStatus`, `WorkflowState.stepFailure`,
  `WorkflowMarkerData.failed`, `SessionErrorKind`, `SessionMeta.errorKind`,
  `resultErrorText`, `TurnFailureKind`)
- `web/src/store.ts` (`autoContinueInterrupted`, `compressResponses`,
  `pushSettings`/`applySettings`,
  `workerStatus`, `authStatus` handler that opens/force-opens the login modal — unchanged)
- `web/src/components/SessionView.tsx`, `web/src/components/SessionsSection.tsx`
- `web/src/components/Sidebar.tsx`, `web/src/lib/format.ts` (`sessionRowMeta`)
- `web/src/components/SkewBanner.tsx`, `web/src/components/WorkerBanner.tsx`,
  `web/src/components/StorageBanner.tsx`, `web/src/components/UpdateBanner.tsx` (pill precedence)
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
- `SkewBanner` — the global pill rendering `protocolSkew`; outranks `WorkerBanner` in the
  precedence chain (see [hosted-machine-access](hosted-machine-access.md))
- `isSelfWorkerSource` (`server/src/autoGuard.ts`) — true for
  `worker.ts`/`workerProtocol.ts`/`workerMcp.ts` under this bridge's own `server/src`
- `SessionManager.failTurn(sessionId, error)` — the single funnel that shows a turn as failed:
  emits a synthetic `result` event, then sets status `'error'` + `errorMessage`; also one of
  the two classification points, calling `classifyFailure` after `setStatus`
- `SessionManager.classifyFailure(sessionId, error)` (private) — first calls
  `dropFailedQuery(sessionId)` unconditionally, then tries `recoverAuthFailure` (auth wins
  outright); if that reports no match, tries `classifyTurnFailure` and, on a hit, rewrites the
  banner via `turnFailureAdvice`. The classification half is synchronous, unlike the auth
  refresh — no refresh to await — so it always lands before `WorkflowEngine`'s failed-park
- `SessionManager.dropFailedQuery(sessionId)` (private) — closes the session's worker query for
  any failed turn, recognised or not, unless the session is mid-turn
  (`isSessionInterruptible`), which never happens from this call site today. Runs before
  classification so the very next push — a plain Retry, no second click needed — cannot reuse
  the child that just failed, regardless of whether `queryTokens` says it matches or the error
  text was ever recognised as auth
- `classifyTurnFailure(message): TurnFailureKind | null` (`turnFailure.ts`) — first matching
  kind wins, checked in order `'filtered'` → `'context'` → `'invalid'` → `'overloaded'`; `null`
  leaves the raw text and plain Retry, same as before this feature existed
- `turnFailureAdvice(kind, { inWorkflow }): string` (`turnFailure.ts`) — the banner text for a
  kind; appends a "…or approve the step to skip it" sentence only when `inWorkflow` is true
- `turnFailureRetryHint(kind): string | null` (`turnFailure.ts`) — non-null only for
  `'filtered'`/`'context'`, the two kinds where rephrasing the prompt changes the outcome;
  `null` for `'invalid'`/`'overloaded'`/`'auth'`/undefined
- `SessionManager.lastPromptForRetry(sessionId)` — the user's newest input for the failed turn
  + attachments rehydrated from disk, extracted out of `retryTurn` so `WorkflowEngine.retryIfFailed`
  can reuse it. Prefers a mid-turn human gesture (`lastHumanGesture`) over the prompt that opened
  the turn — see "Retry re-sends the newest human input" below
- `lastHumanGesture(events): string | null` — the newest human mid-turn gesture (a plan
  deny/refine message, `AskUserQuestion` answers, or a plan-approve interject) recorded after the
  last `'user'` event, framed for re-sending; `null` when there is none
- `isHumanResolution(d): boolean` — a permission resolution a person actually made
  (`resolvedBy` absent, `'user'`, or `'plan-reply'`; never `'expired'` or `auto: true`); the
  safety gate that keeps a server-synthesized resolution (`'recovery'`, `'workflow-advance'`, …)
  out of retry text
- `retryGestureText(toolName, d): string | null` — model-directed prose for one stored human
  answer; `null` for a plain allow (its content lives in the CLI's own resumed session, not ours)
  and for a deny with no `denyMessage`
- `WorkflowEngine.retryIfFailed(sessionId): boolean` — consumes a Retry click for a workflow
  session whose current step failed; returns `false` for a plain session or a step that parked
  normally, so the caller falls through to `SessionManager.retryTurn`
- `WorkflowState.stepFailure?: 'pre-run' | 'turn'` — set on the step that is currently
  parked-as-failed; `'pre-run'` means it never got a prompt (re-render via `runStep`),
  `'turn'` means its turn failed (re-send the prompt via `iterateStep`)
- `WorkflowMarkerData.failed` — set on a `'waiting-approval'` marker whose park was a failure,
  so the divider reads "failed, retry or approve to skip". Since the transcript's
  workflow-marker allowlist (see [transcript-rendering](transcript-rendering.md#noise-reduction))
  only renders `started`/failure/`workflow-done`, a rendered `waiting-approval` marker
  now *always* means this — a clean park is invisible in the transcript, discoverable
  only via the stepper and the approve card
- `isAuthFailureMessage(message)` — narrow regex match over SDK/CLI error text
  (`invalid_grant`, `authentication_error`, `authentication_failed`, `invalid bearer token`,
  `401 Unauthorized`, `403 Forbidden`, `oauth … token … expired`, `oauth … token … revoked`,
  `oauth … session … expired`, `oauth authentication failed`, `please run /login`,
  `please login again`, `re-authenticate to continue`)
- `AuthManager.handleTokenRejected(): Promise<TokenRejection>` — no-op-but-reports when
  already logged out (`{ outcome: 'signed-out' }`), else one `forceRefresh()`; success is
  `{ outcome: 'refreshed' }`, a dead refresh token is `{ outcome: 'signed-out' }`, any other
  failure (5xx, offline) is `{ outcome: 'refresh-failed', error }` and leaves the session
  signed in
- `resultErrorText(msg)` — the error text of an SDK `result` message: prefers `msg.result`,
  falls back to `msg.errors[]` joined with `\n` (an `SDKResultError` carries no `result` at
  all). Shared between server and web so both read a failure the same way
- `isStoppedResult(r)` (`shared/types.ts`) — reads the bridge-added `stopped` field a `result`
  event is stamped with when it settles a turn the user interrupted. Not an SDK field: the SDK
  reports an interrupt as an ordinary `is_error` result, indistinguishable from a real failure
  without this stamp. `ResultItem.stopped` carries the same reading into the rendered item
- `SessionManager.recoverAuthFailure(sessionId, error): boolean` — returns `false` immediately
  for a non-auth-classified message (or no `AuthManager`), which is what lets `classifyFailure`
  fall through to `classifyTurnFailure`. Otherwise returns `true` and, async, awaits
  `handleTokenRejected()` and rewrites the failed turn's `errorMessage`/`errorKind` via
  `setStatus` — but only if the session is still showing that exact error. No longer closes the
  query itself; `dropFailedQuery` in `classifyFailure` already did that for every failure, auth
  or not
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
- `AuthManager.ensureFreshToken()` — joins an already-in-flight refresh (from
  `handleTokenRejected`) rather than reading `expiresAt` against the margin, so a Retry that
  lands mid-recovery gets the token the refresh is producing, not the one being replaced; a
  failed join (5xx, offline) falls back to the token in hand, unless that refresh was itself a
  self-logout, which raises `AuthRequiredError`
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
- `SessionManager.recycleIdleQueries()` — restarts every query that isn't mid-turn, on login/
  logout/token-refresh and project-root changes; skips a session whose `LiveState.backgroundTasks`
  is non-empty (see [background-tasks](background-tasks.md)), since closing that query would kill
  the CLI child and every task it owns
- `SessionManager.recoveryKindFor(sessionId, msg, stopped): 'auth' | 'overloaded' | null`
  (private) — the transparent-recovery verdict, decided synchronously alongside the `stopped`
  stamp; see "Transparent turn recovery" in Data flow
- `LiveState.recovery?: { kind, attempts, epoch, timer? }` — live-only record of a turn being
  re-driven; `attempts` is per kind (`TURN_ATTEMPTS`), `epoch` invalidates stale in-flight work
- `TURN_ATTEMPTS: Record<'auth' | 'overloaded', number>` (`sessions.ts`) — total attempts allowed
  per kind, original attempt included (`auth: 2`, `overloaded: 3`)
- `SessionManager.beginRecovery(sessionId, kind, resultText)` (private) — closes the query and
  starts either the auth-refresh race or the overloaded backoff
- `SessionManager.repushTurnSilently(sessionId, ctx)` (private) — re-sends
  `lastPromptForRetry`'s text/attachments via `promptContent`, with no `'user'` event and no
  status transition
- `SessionManager.promptContent(text, attachments): unknown[]` (private) — the SDK content-block
  builder extracted out of `prompt()`; side-effect-free (no `stageAttachments`, no events), shared
  by `prompt()` and `repushTurnSilently`
- `SessionManager.accumulateResultSpend(meta, msg)` (private) — the cost/token/`costByModel`
  accumulation extracted out of the `result` branch, shared by the deferred-settle and real-settle
  paths
- `SessionManager.settleTurnFailed(sessionId, text, kind?)` (private) — performs the failure a
  deferred settle never did; modeled on `handleWorkerEnded`'s error branch, not `failTurn`
- `SessionManager.cancelRecovery(sessionId)` (private) — clears a recovery's timer and record;
  called from `interrupt`, `prompt`, `rewindSession`, session archive/delete, and `failTurn`
- `SessionManager.recoveryStillOwns(sessionId, ctx): boolean` (private) — the ownership check a
  recovery re-runs before every re-push: session exists, still `running`, not `interrupting`,
  `turnStartedAt` and `epoch` unchanged
- `isOfflineError(err)` (`auth.ts`) — `TypeError` whose `cause.code` is one of
  `ENOTFOUND`/`EAI_AGAIN`/`ECONNREFUSED`/`ENETUNREACH`; distinguishes "no route to the network"
  from an ordinary refresh failure for the connectivity hold
- `AuthManager.lastRefreshAt` (private) + `RECENT_REFRESH_MS` (5s) — a rejection arriving just
  after a refresh landed reports `{ outcome: 'refreshed' }` without a second network call,
  collapsing concurrent sessions recovering off one rotated token into one refresh
- `isRecoveringResult(r)` (`shared/types.ts`) — reads the bridge-added `recovering` stamp, same
  shape as `isStoppedResult`
- `ResultItem.recovering` (`web/src/lib/transcript.ts`) — carries the stamp into the rendered
  item; `isFailedResult` returns `false` when it is set, same as `isStoppedResult`

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
believe is `running`/`waiting-permission` demotes it — to `idle`, pausing any queue and stamping
`interruptedAt`, *unless* its current workflow step already reads `waiting-approval`: the only
turn that runs on an already-parked step is a manual context compaction (see
[context-window](context-window.md#compaction)), so that case re-parks at `waiting-approval`
instead and stamps no `interruptedAt` — no Continue banner, and nothing added to `flagged`,
since auto-continue's nudge would read as an approval nobody gave. `busy: undefined` demotes
only.

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

### Retry re-sends the newest human input, not just the turn's opening prompt

A permission card answered mid-turn (a plan approved/denied, `AskUserQuestion` answered) is
delivered to the SDK through the still-running query's `canUseTool` answer — it never produces a
`'user'` transcript event, only a `kind: 'permission'` resolution (or, for a plan approved with
comments, a separate `kind: 'interject'` event). Before this, `lastPromptForRetry` took the last
`'user'` event unconditionally, so a Retry after e.g. answering questions, getting a plan, and
"Refine with comments" on it re-sent the *step's opening prompt* — the model replayed the whole
planning step instead of seeing the refine notes.

`lastPromptForRetry` now calls `lastHumanGesture(events)` first: it walks backward from the end
of the transcript to the last `'user'` event, then scans everything after it for the newest
human-authored gesture — an `interject` event's text, or a `permission` resolution that passes
`isHumanResolution` and yields non-null prose from `retryGestureText`. A gesture wins over the
opening prompt whenever one exists, unless its text is still staged on `meta.queued` (a
plan-approve interject that could not interject mid-turn is held there until the queue is
released, not lost — synthesizing it into a Retry would double-send it).

This is a read-side fix only: no `'user'` event is written when a card is answered. Doing so
would open a new turn boundary and corrupt turn-scoped bookkeeping (`collectTurns`,
`permissionWaitMs`) — see
[permissions-and-plan-mode](permissions-and-plan-mode.md#plan-review-and-comments). "Belongs to
the failed turn" is approximated by "after the last `'user'` event", the same approximation
`collectTurns` and `summarizeTurn` already make for permission events, which carry no turn
correlation of their own.

Scope is deliberately narrow: a plain tool **allow** still falls back to the opening prompt,
because an allow that reached `resolvePermission` was handed to the SDK and lives in the CLI's
own resumed session — re-sending it would only repeat context the CLI already has (and, for a
plan approval, risk re-triggering its advance/permission-mode side effects). The one allow whose
content exists solely in our transcript is `AskUserQuestion`'s answer set, which `retryGestureText`
does render.

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
design). Both go through `classifyFailure`, which first calls `dropFailedQuery` — closing the
session's worker query regardless of what the failure text says, so the child that just failed
cannot be reused — then calls `recoverAuthFailure(sessionId, resultErrorText(msg))`:

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

### Transparent turn recovery

Scoped to exactly one place: the `msg.type === 'result'` branch of `handleWorkerEvent`. A crashed
query (`handleWorkerEnded`) is never re-driven — there is no turn left in flight to resume.

**Detection, before persist.** `SessionManager.recoveryKindFor(sessionId, msg, stopped)` is
computed alongside the existing `stopped` stamp, for the same reason: the transcript store only
appends, so a verdict decided after the event is written could never reach the durable record.
It returns `'auth' | 'overloaded' | null`, requiring: `msg.type === 'result'`, not `stopped`, the
same `is_error`/non-`success` predicate the settle path uses, not mid-compaction
(`LiveState.compactResume` unset — a compaction reports through its own channel), the session
still `running`/`waiting-permission`, and that kind's attempt budget (`TURN_ATTEMPTS`: `auth` 2,
`overloaded` 3, original attempt included) not yet spent. Auth wins outright when the text matches
both an auth pattern and `'overloaded'`, mirroring `classifyFailure`'s existing precedence. A
non-null verdict stamps `{ ...msg, recovering: true }` at the same `emitEvent` call that stamps
`stopped` — see `isRecoveringResult`.

**Deferring the settle.** When the verdict is non-null, the `result` branch does **not** run any
of its usual settle: no `status`/`errorMessage`/`errorKind` assignment, no clearing
`turnSource`/`turnStartedAt`, no `classifyFailure`, no `onTurnComplete`, no `maybeFlush`, no
`summarizeTurn`/`recordFilesChanged`/`fetchContextBreakdown` (those run once the turn really
settles, keyed off that attempt's own `resultSeq`). It **does** still run
`accumulateResultSpend` (the failed attempt burned real tokens) and reset
`LiveState.permissionWaitMs` (or the same wait is subtracted twice from the next attempt's
`duration_ms`), then calls `beginRecovery` and returns. `LiveState.turnBaselines` is left open on
purpose — closing it would drop the first attempt's file attribution.

**Re-driving.** `SessionManager.beginRecovery(sessionId, kind, resultText)` bumps a per-session
`epoch`, increments that kind's attempt counter, closes the query (the child holds the rejected
token, or is dead weight either way), and:

- `'auth'` → `auth.handleTokenRejected()` raced against a 20s timeout. `refreshed` →
  `repushTurnSilently`. `signed-out` → `settleTurnFailed` with the Sign-in banner — the one case
  still surfaced to the user, since `logout()` has already broadcast `authStatus` and opened the
  login modal. `refresh-failed` → the connectivity hold below, and this attempt is **not**
  charged against the budget (no turn was ever re-sent).
- `'overloaded'` → wait on a backoff (2s → 8s → 30s indexed by attempt), then
  `repushTurnSilently`.

**Connectivity hold.** A `refresh-failed` outcome is re-probed on a 5s-doubling backoff capped at
60s, for a total budget of 5 minutes. `auth.ts`'s `isOfflineError(err)` distinguishes "no route to
the network" (`TypeError` whose `cause.code` is `ENOTFOUND`/`EAI_AGAIN`/`ECONNREFUSED`/
`ENETUNREACH`) from an ordinary refresh failure, but the hold's behavior is identical either way —
a refresh that finally succeeds *is* the came-back-online signal, so there is nothing else to
watch for. Budget exhausted → `settleTurnFailed` with the plain `authRefusalMessage` banner
(no `errorKind`, no Sign in button — the stored credential itself is fine).

**Re-sending without a second `'user'` event.** `repushTurnSilently` reads
`lastPromptForRetry(sessionId)` — the same source a manual Retry uses, so a mid-turn plan refine
or `AskUserQuestion` answer is re-sent instead of the stale opening prompt — builds the content via
`promptContent` (extracted out of `prompt()`, deliberately free of `stageAttachments`: the
original `'user'` event already owns the on-disk attachment refs) and pushes it directly. No
`'user'` event is written and no status transition happens — `turnSource`, `turnStartedAt` and
`status: 'running'` are already correct, because the turn was never settled. Every turn-scoped
scan (`collectTurns`, `summarizeTurn`, `lastHumanGesture`) therefore reads a multi-attempt turn as
one turn, the same way it already reads a mid-turn permission answer as belonging to the turn
before it.

**Ownership.** Before re-pushing (and at the top of the connectivity hold's loop),
`recoveryStillOwns(sessionId, ctx)` re-checks that the session still exists, is still `running`,
is not in `this.interrupting`, and that both `turnStartedAt` and the recovery's `epoch` are
unchanged from when this attempt started. Any mismatch — a Stop, a new prompt, a rewind, session
delete/archive — returns silently; whoever took the session over now owns it, and
`cancelRecovery` (called from `interrupt`, `prompt`, `rewindSession`, archive/delete, and
`failTurn`) has already cleared the timer.

**Giving up.** `settleTurnFailed(sessionId, text, kind?)` performs the failure the deferred settle
never did: pause the queue, reset `permissionWaitMs`, cancel the recovery record, capture
`turnSource` before clearing it, emit a second (unstamped) `result` event — the first stays
neutral forever; append-only storage cannot un-stamp it — `dropFailedQuery`, `setStatus('error',
text, kind)`, and fire `onTurnComplete` if a source was captured. This mirrors
`handleWorkerEnded`'s error branch rather than reusing `failTurn`, which would re-enter
`recoverAuthFailure` and lose the already-decided `errorKind: 'auth'`. `WorkflowEngine` then parks
the step exactly as it does for any other failed turn — same banner, same `stepFailure: 'turn'`,
same Retry/Skip step.

**Reconcile.** `reconcileWithWorker` treats "no worker report" as a dead turn (demote to `idle`,
stamp `interruptedAt`), but a recovery deliberately holds no query for the length of its backoff —
so the check adds `&& !this.live.get(meta.id)?.recovery`, and a `hello` landing mid-recovery
leaves the session alone rather than demoting it and possibly firing an auto-continue nudge on top
of a turn that is about to resume on its own.

**Live-only.** `LiveState.recovery` is never persisted. A bridge restart mid-recovery drops it, so
the surviving turn is picked up by the ordinary interrupted-turn path instead (Continue banner,
resume on click or auto-continue) — it does not need its own crash-recovery story.

**Refresh-token rotation.** `AuthManager` memoizes `lastRefreshAt`; a rejection arriving within 5s
of a refresh that just landed reports `{ outcome: 'refreshed' }` without a second network call.
Without this, N sessions recovering off the same rotated token would each call
`handleTokenRejected()` and rotate the refresh token again — and a lost race there is fatal (the
old refresh token no longer works, and the new one was just replaced out from under it).

### A stopped turn is not a failed turn

The SDK reports a user-initiated interrupt as an ordinary error `result`
(`subtype: 'error_during_execution'`, `is_error: true`, no `result` field — only `errors[]`) —
the same shape as a genuine failure. The SDK's own `terminal_reason` field is unpublished, so
it is never consulted; the only trustworthy record that the user actually asked for the stop is
`SessionManager.interrupting`, the set `interrupt()` adds to. `handleWorkerEvent` reads it at
the moment it persists the `result` event: `stopped = msg.type === 'result' &&
this.interrupting.has(sessionId)`, and stamps `{ ...msg, stopped: true }` onto the durable
record before it is written — the transcript store only appends, so the stamp must happen
before persistence, not decided afterward. `failed` is then gated on `!stopped`, so a stopped
turn skips `classifyFailure` entirely: no `dropFailedQuery` (the interrupted query is healthy,
so dropping it only cost the next prompt a `resume` respawn), no `recoverAuthFailure`, no
banner. `status` settles to `'idle'` (already set synchronously by `interrupt()`), not
`'error'`, and `errorMessage`/`errorKind` stay unset. `WorkflowEngine.onWorkflowTurnComplete`
still receives `failed: false` for this turn, so it parks the step the same way an ordinary
Stop does (see [workflow-step-lifecycle](workflow-step-lifecycle.md)), not as a failed step.

On the client, `isFailedResult` checks `isStoppedResult` first and returns `false` immediately
when it is set, so `ResultItem.isError` is `false` and the row reads "turn stopped" (dimmed)
instead of "turn failed" (red) — `Transcript.tsx`'s retry affordance keys off `isError`, so it
disappears with no extra logic. The stamp is written into the persisted event, not computed
only for the live broadcast, so a page reload renders the same neutral row.

### A worker query outlives the bridge, so a failed turn always drops it

The worker is a separate long-lived process; the bridge (tsx watch, crash, deploy) restarts
independently of it. `queryTokens` — which access token each live query was spawned with — lives
only in bridge memory, so a restart empties it while the worker's live queries survive. A query
whose entry the bridge cannot vouch for is `undefined`, not a known mismatch, and `pushWithToken`
treats only a *known* match as safe to reuse — so an unvouched-for query is recycled on its next
push, the same as one wired to a genuinely different token.

That covers the next push, but not the turn that is failing right now: a query already live when
the token it holds gets rejected (proactively refreshed, revoked server-side, or rejected by
`handleTokenRejected`) is not touched by that guard until something pushes to it again. So
`dropFailedQuery` runs unconditionally inside `classifyFailure`, before either classification
branch: it closes the query for **every failed turn** — but not a stopped one (see "A stopped
turn is not a failed turn" above) — whether or not the error text is recognised and whether or
not `queryTokens` believes the current token matches. A single Retry click after any failure
therefore always spawns a fresh child (`resume` keeps the conversation), rather than depending
on the failure being classified correctly first.

`AuthManager.ensureFreshToken` closes the other half of the same race: a Retry that lands while
`handleTokenRejected`'s recovery refresh is still in flight now joins that refresh instead of
reading the token it is in the process of replacing (the margin check on `expiresAt` alone would
hand the newly-spawned child the very token being rotated out, since a server-side revocation
does not change `expiresAt`).

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
`turnFailureRetryHint(meta.errorKind)` to the re-sent text when it's non-null (only for
`'filtered'`/`'context'`; `'invalid'`/`'overloaded'`/`'auth'`/undefined add nothing). This holds
whether the re-sent text is the opening prompt or a mid-turn human gesture (see "Retry re-sends
the newest human input" above) — the hint rides only whatever text is actually re-sent, which is
what appears in the transcript as a new `'user'` event; the original failed turn's stored prompt
(and any card it answered) is untouched. A workflow step parked with `stepFailure: 'pre-run'`
never reaches this function (no prompt was ever sent for it), so it never gets a hint either —
expected, since `retryIfFailed` re-enters the step via `runStep` instead.

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

- token resolved (refreshing in-margin, or joining an in-flight recovery refresh — see
  `ensureFreshToken` above) → `pushWithToken` → recycle the query **unless** `queryTokens`
  is known to hold this exact token → `worker.push` with
  `env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token }`. `queryTokens` lives in bridge
  memory only, while the worker's live queries survive a bridge restart — so an entry this
  bridge cannot vouch for (`undefined`, after a restart) is treated as unsafe, not as a match.
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

- `server/src/caveman.test.ts` — the ruleset carries its safety carve-outs (security
  warnings, irreversible actions, multi-step ambiguity, clarify-on-request), the
  code/commits/PRs-normal boundary, and the persistence clause, so a future trim can't
  silently drop any of them.
- `server/src/sessions.reconcile.test.ts` — promote/demote/old-worker matrix, event-based
  healing, stop-ordering, `withQueuedPushes`, the auto-continue cases (fresh flag resumes,
  absent setting resumes, explicit `false` does not, stale flag does not, workflow source
  preserved, one failing session doesn't stop the others,
  `result`/archive clear the flag, an unresolved `ExitPlanMode` card blocks auto-continue and
  is not expired by `continueTurn`, an ordinary tool's card still expires), the worker-lost
  case (reconciled with an empty live list, `autoContinue: false`, never auto-resumed), the
  no-local-history skip (a session with no live state and no transcript on this instance is left
  alone; a session with an actual worker report is still fully reconciled even with no local
  transcript), and a bridge death mid-compaction re-parking a `waiting-approval` step instead of
  demoting it (no `interruptedAt`, not auto-continued) — see
  [workflow-step-lifecycle](workflow-step-lifecycle.md#compacting-a-parked-step). Also: a turn
  being transparently re-driven (`LiveState.recovery` set) survives a worker report of no live
  query — no demotion, no `interruptedAt`, no auto-continue nudge.
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
  the session at `running`; the no-`AuthManager` path still pushes. Also: a turn settled by
  `interrupt()` followed by the SDK's own `is_error` interrupt result is stamped `stopped` and
  reads `status: 'idle'` with no `errorMessage`/`errorKind` and its query kept open (not
  dropped); the identical result with no preceding `interrupt()` is still a genuine failure
  (`status: 'error'`, query dropped); the `stopped` stamp is consumed by the one `result` it
  was computed for and cannot bleed into a later, unrelated failure on the same session. Also: each of the four
  non-auth kinds rewrites the banner and sets `errorKind`; an unrecognised failure keeps its
  raw text and `errorKind: undefined`; an auth-shaped message wins over a coincidental 400 in
  the same text; `failTurn` classifies non-auth failures the same way as a `result`; a Retry
  after a `'filtered'` failure appends the hint to the re-sent prompt, and a Retry after
  `'overloaded'`/an unrecognised failure re-sends the prompt untouched. Also: a revoked-token
  message (401 or the CLI's 403 wording) is recognised as auth, not left raw; any failed
  turn — recognised or not — closes the session's query (`dropFailedQuery`, asserted via the
  fake `WorkerClient.close`). Also: a Retry after refining a plan with comments re-sends the
  refine notes (with the retry preamble), not the prompt that opened the turn, and the hint
  still rides that text; an auto-approved or otherwise server-synthesized resolution
  (`auto: true`, `resolvedBy: 'workflow-advance'`/`'recovery'`) is never mistaken for a human
  gesture and falls back to the opening prompt, and neither does a plain human allow; answered
  `AskUserQuestion` questions replay as answers with an instruction not to re-ask; the newest
  gesture wins when an interject follows a resolution; a gesture still staged on `meta.queued`
  is held, not double-sent. Also (transparent recovery): a refreshed token re-sends the same
  turn instead of settling it, with no second `'user'` event, a `recovering`-stamped result row,
  and the query dropped; a second auth failure on the same turn settles for real with today's
  banner; a `signed-out` outcome is the one failure still surfaced (`errorKind: 'auth'`, no
  re-push); giving up fires `onTurnComplete` so a workflow step can park, while a turn still being
  re-driven fires no completion; a failed attempt still bills its spend; an overloaded turn is
  re-sent after its backoff and a third failure settles with the `'overloaded'` banner; Stop
  during a recovery abandons it and leaves the session `idle`; a new prompt supersedes the
  recovery of the turn before it; an offline refresh holds the turn (no attempt spent, no banner)
  until a later refresh succeeds; a hold that never reconnects settles with the refusal banner.
- `server/src/turnFailure.test.ts` — each kind matches representative CLI/SDK error text; an
  unrelated failure and a filter-vs-generic-400 precedence case both resolve correctly; every
  string returned by `turnFailureAdvice`, `turnFailureRetryHint`, and (exported for this test)
  `authRecoveryMessage` is rejected by both `classifyTurnFailure` and `isAuthFailureMessage`
  (the anti-reclassification rule); `inWorkflow: false` omits the skip sentence; every kind names
  an action the user can take next — by the time any of these banners renders, the app has
  already stopped acting on its own (see "Transparent turn recovery" in Data flow).
- `server/src/workflows.advance.test.ts` — a failed result parks the step, keeps the error
  status, and does not `autoAdvance`; spend still accumulates onto the step slot; a normal park
  carries no `stepFailure`. Also: a classified (non-auth) failure's rewritten banner and
  `errorKind` survive the failed-park, proving the `persistMeta`-not-`setStatus` invariant this
  feature leans on; a step `Retry` after a mid-turn plan refine re-sends the refine notes through
  `iterateStep`, not the step's rendered prompt template. Also (transparent recovery): a step
  whose turn is being re-driven neither parks nor `autoAdvance`s while the recovery is in flight;
  once it gives up, the step parks with `stepFailure: 'turn'` exactly as before this feature.
- `server/src/sessions.permission.test.ts` — a Retry after "Refine with comments", exercised
  through the real `resolvePermission` emit path (not a hand-built transcript), returns the
  refine prose from `lastPromptForRetry`.
- The claimed `server/src/workflows.retry.test.ts` from an earlier revision of this doc does
  not exist in the repo; its coverage (`retryIfFailed` re-sends the last prompt for a `'turn'`
  failure, re-runs the step for a `'pre-run'` failure, ignores a normally-parked step and a
  plain session, and clears `stepFailure` on retry) lives in `workflows.advance.test.ts`
  instead. No web test infra beyond typecheck exists yet — the Skip step button and the
  Sign-in gate are manual-verified via the `verify` skill.
- `server/src/auth.failure.test.ts` — auth classification and recovery outcomes;
  proactive-refresh retry scheduling and the widened failure patterns (the reported
  401-revoked wording, the CLI's 403 form, `authentication_failed`, "OAuth session expired",
  "please login again", with negative cases guarding each against a false-positive tool
  output). Also: `ensureFreshToken` joins an in-flight recovery refresh and returns its result
  rather than the stale token; a failed (5xx) recovery refresh still yields the token already
  in hand instead of blocking the turn. Also: `isOfflineError` classifies each offline `cause.code`
  positively and an ordinary refusal/non-fetch-error negatively; a second rejection landing within
  `RECENT_REFRESH_MS` of a refresh reuses it instead of rotating the refresh token again.
- `server/src/sessions.spawn.test.ts` — a turn while logged out is refused instead of falling
  back to ambient credentials; a stale token is refreshed before the query spawns; a query the
  bridge cannot vouch for (no `queryTokens` entry, simulating a bridge restart) is recycled
  before its next push; a query known to hold the current token is not recycled (no-churn
  case); a rotated token recycles the query it no longer matches; an absent
  `settings.json` still puts `COMPRESS_RESPONSES_PROMPT` in the spawned query's
  `systemPrompt.append` (on by default), `compressResponses: false` sends neither the
  ruleset nor a `plugins` key, and flipping the setting between two turns changes only the
  second query's options.
- The settings field-merge in `userContext.ts` is uncovered — `buildUserContext` wires sync,
  stores and a worker together with no seam. Verified by hand.

## Business rules

- A turn the user stopped is never classified as a failure: the row reads "turn stopped"
  (neutral) rather than "turn failed" (red), gets no Retry button, and the interrupted query is
  not dropped. Cost, tokens, duration, and any files the turn changed before the Stop are still
  recorded — the turn genuinely ran and may have edited files.
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
- A session demoted by `reconcileWithWorker` whose current workflow step already reads
  `waiting-approval` re-parks at `waiting-approval` instead of `idle` — that shape can only be a
  manual compaction the dead bridge was running over the park (`LiveState.compactResume` itself
  is lost with the process, so the park is re-derived from `WorkflowState.stepStatuses`, not
  trusted from state that died with the bridge). No `interruptedAt` is stamped and the session is
  not added to `flagged`, for the same "auto-continue would read as an unwanted approval" reason
  as an unresolved `ALWAYS_ASK_TOOLS` card — see
  [workflow-step-lifecycle](workflow-step-lifecycle.md#compacting-a-parked-step).
- A cold-start protocol mismatch (a worker that has never once answered compatibly) cannot be
  caught by the lost deadline: `everConnected` never becomes `true`, so the outage clock never
  starts. It is instead surfaced the moment the mismatched `hello` is seen, via
  `WorkerStatus.mismatch`, independent of `WORKER_LOST_MS`.
- Exactly one of `ConnectionBanner`, `SkewBanner`, `WorkerBanner`, `StorageBanner`, `UpdateBanner`
  renders at a time — all five share the same fixed position. `ConnectionBanner` (browser↔bridge
  down) outranks the rest; `SkewBanner` (this client and the bridge disagree on
  `APP_PROTOCOL_VERSION`, i.e. `protocolSkew`) outranks everything below it, since every claim those
  make is read off messages this client may be misreading; `WorkerBanner` (agent worker down)
  outranks `StorageBanner` (cloud sync paused), since a dead agent is worse than paused sync;
  `UpdateBanner` (a desktop update is available) is the lowest rank — it is news, not an outage, and
  is also hidden for a guest connection (not their machine to update). See
  [Multi-machine](#multi-machine) below — this rule is now scoped to the primary machine.
- Every recoverable failure (crashed query, `is_error` result, workflow pre-run failure, a push
  that never left the bridge) ends on a failure row with a working Retry button — in a plain
  session and inside a running workflow alike.
- A failed turn never `autoAdvance`s; it parks the step as failed instead. An explicit
  force-advance (`advanceOnComplete === 'interrupted'`, stamped for the step) still takes
  priority over the failure, honoring the user's own advance request.
- Retry re-runs the right thing: a step that never got a prompt is re-rendered from
  `WorkflowState`; a step whose turn failed is re-sent as a follow-up on the same conversation.
- Retry prefers the user's newest mid-turn gesture (a plan refine/deny message,
  `AskUserQuestion` answers, or a plan-approve interject) over the prompt that opened the turn,
  since answering a card never writes a `'user'` event. A plain tool allow is the one exception —
  it falls back to the opening prompt because its content already reached the CLI's own resumed
  session.
- No bulk resume on a login event: a sign-in completing later, or from another device, must never
  fire N queued turns across every session that failed while signed out. Transparent turn
  recovery (see the data-flow section above) does not violate this — it is anchored to a single
  in-flight turn on one session, decided from that turn's own `result`, never from an `authStatus`
  broadcast or any other event that could fan out across sessions.
- Only two failure kinds are ever transparently re-driven — a rejected auth token and an
  overloaded/rate-limited API — and only within a fixed attempt budget (`auth`: 2 attempts total,
  `overloaded`: 3) or, for auth, a 5-minute connectivity hold. `filtered`, `context` and `invalid`
  are deterministic: re-sending them verbatim reproduces them, so they keep today's manual Retry
  unconditionally.
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
- Retry stays manual for every failure a turn's `result` can settle on directly — a query crash
  still ends on today's post-hoc banner rewrite with no auto-resume. Only a `result`-branch
  auth/overloaded failure is transparently re-driven (see "Transparent turn recovery" above), and
  only up to its attempt budget; past that, it settles exactly like any other failure, banner and
  all.
- `errorKind` is never set when no `AuthManager` is wired (ambient-token mode has no login flow
  to offer); the raw message and plain Retry are unchanged there.
- A failed attempt inside a transparent recovery still bills its spend (`totalCostUsd`,
  `totalTokens`, `costByModel`) — the tokens were genuinely spent, even though the attempt is
  invisible to the user as a failure. See [usage-and-cost](usage-and-cost.md).
- A recovery's re-drive never appends a `'user'` transcript event — the original one already
  represents the human's input for this turn, and a second one would split one turn's bookkeeping
  (`collectTurns`, `summarizeTurn`, `lastHumanGesture`) into two.
- A transparent recovery holds no query for the length of its backoff/refresh; `reconcileWithWorker`
  must not read that absence as a dead turn (see "Transparent turn recovery" above) or it would
  stamp a Continue banner and possibly auto-continue a turn already resuming on its own.
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
- `UserUiSettings.compressResponses` gates `COMPRESS_RESPONSES_PROMPT` directly in
  `buildQueryOptions`: on means the ruleset is in `systemPrompt.append`, off means neither it
  nor a `plugins` key is present. One user-level setting, not a per-session one — read from
  the store on every push, so a Settings flip lands on each session's next query with
  nothing cached on the meta and nothing to restart. On unless explicitly `false`, so a
  fresh install and an install predating the setting both compress.
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
- A query the bridge cannot vouch for is recycled, not reused: `pushWithToken` only skips the
  recycle when `queryTokens` is known to hold this exact token; an absent entry (e.g. after a
  bridge restart, while the worker's query is still live) is treated as unsafe, never as a
  match.
- Any failed turn drops that session's query, whether or not the failure was recognised and
  whether or not `queryTokens` believed the current token matched — so a Retry after any
  failure re-spawns instead of risking a repeat of the same failure on the same child.

## Architectural rules

- `SessionManager.interrupting` is the only authoritative signal that a `result` settling a turn
  was a user-initiated Stop. The SDK's `terminal_reason` (`'aborted_streaming'` /
  `'aborted_tools'`) is unpublished and deliberately not consulted — `interrupting` is set by
  this bridge's own `interrupt()` call, not inferred from SDK output.
- The `stopped` stamp is computed and applied at the point `handleWorkerEvent` persists the
  `result` event (a shallow copy, never a mutation of `msg`), because the transcript store only
  appends — a verdict decided later in the same function's `result` branch could never reach the
  already-written durable record.
- `stopped` is additive and reset-free: it does not require the `interrupting` entry to survive
  past the one `result` it stamps, so a leftover flag can never neutralise a later genuine
  failure on the same session.
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
- `queryTokens` is bridge-memory only and is never persisted, while the worker's live queries
  outlive a bridge restart — this asymmetry (the same one already documented for interrupted-turn
  recovery: the worker keeps running turns the bridge no longer remembers) is why
  `pushWithToken`'s recycle guard must fail closed on an unknown entry rather than treat
  "unknown" as "safe".
- `dropFailedQuery` is unconditional and sits in `classifyFailure`, ahead of both
  `recoverAuthFailure` and `classifyTurnFailure`, specifically because it must not depend on
  either classifier being right: SDK/CLI wording drifting out of `AUTH_FAILURE_PATTERNS` (as it
  already has once) or `queryTokens` happening to hold a match despite a server-side revocation
  must never leave a wedged query alive for a second Retry to hit again.
- `ensureFreshToken` joining `refreshInFlight` (rather than only checking `expiresAt`) is what
  makes a single Retry enough: `handleTokenRejected`'s recovery refresh and a Retry's own
  `ensureFreshToken` call can race, and `expiresAt` alone cannot tell a merely-unexpired token
  from one that was just revoked server-side.
- A query owning live background tasks is never recycled, even when its session reads as fully
  settled — see [background-tasks](background-tasks.md). This is a second, independent exemption
  from `recycleIdleQueries()`'s existing interruptible-status gate, not a change to it: a session
  can be both "not interruptible" (turn over) and "not safe to recycle" (background work still
  running) at once, and the two checks stay separate for that reason.
- The recovery verdict (`recoveryKindFor`) is decided and stamped (`recovering: true`) at the same
  point and for the same reason as the `stopped` stamp: the transcript store only appends, so a
  verdict computed after `emitEvent` persists the event could never reach the durable record. Both
  stamps are shallow copies of `msg`, never mutations.
- `LiveState.recovery` is live-only by design, exactly like `LiveState.compactResume` and
  `turnBaselines` — a bridge restart mid-recovery is meant to fall through to the ordinary
  interrupted-turn path (Continue banner), not grow its own crash-recovery mechanism.
- `settleTurnFailed` is modeled on `handleWorkerEnded`'s error branch, not on `failTurn`:
  `failTurn` re-enters `classifyFailure` → `recoverAuthFailure`, which would attempt a second,
  redundant token refresh and could overwrite an already-decided `errorKind: 'auth'`.
  `settleTurnFailed` sets `errorKind` directly, from the outcome recovery itself already knows.
- `cancelRecovery` is called from every path that can take a session's turn away from a recovery
  in flight (`interrupt`, `prompt`, `rewindSession`, session archive/delete, and `failTurn` as the
  real-failure funnel) rather than relying solely on the `epoch`/`turnStartedAt` ownership check —
  the check is the backstop for work already in flight (an awaited refresh, a sleeping backoff);
  the explicit calls stop new timers from ever being scheduled.
- `promptContent` (the SDK content-block builder extracted out of `prompt()`) is deliberately free
  of `stageAttachments` and of any transcript/event write — it exists so `repushTurnSilently` can
  build the identical content for attachments the original `'user'` event already staged, without
  re-staging (and duplicating) the files on disk.
- `accumulateResultSpend` is extracted so both the deferred-settle path and the real-settle path
  call the identical cost/token/`costByModel` accumulation — a failed attempt's spend must not
  silently differ from a settled turn's.
- `AuthManager.lastRefreshAt` is a plain timestamp memo, not a promise cache: it exists only to
  answer "did a refresh land in roughly the last 5 seconds", which is what lets a second
  concurrent `handleTokenRejected()` skip a redundant refresh-token rotation without joining
  `refreshInFlight` (that promise is already gone by the time a *second* session's turn fails on
  the token the first one just replaced).

### Multi-machine

A browser can hold live links to more than one machine at once (see
[multi-machine-client](multi-machine-client.md)). The five banners above read only the
**primary** machine's `connectionStatus`/`protocolSkew`/`workerStatus`/`storageStatus`/
`updateStatus` — a non-primary machine going offline, speaking a different protocol version, its
worker dying, or it offering an update never triggers `ConnectionBanner`/`SkewBanner`/
`WorkerBanner`/`UpdateBanner` for a user looking at their own, healthy, in-sync machine. That
health surfaces on the affected session's row and header instead. The precedence rule itself
(`ConnectionBanner` > `SkewBanner` > `WorkerBanner` > `StorageBanner` > `UpdateBanner`) is
unchanged — it now simply always describes the primary.

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
- [multi-machine-client](multi-machine-client.md) — holding several machines' links at once, and
  why the banner precedence above is scoped to the primary.
- [session-rewind](session-rewind.md) — the third recovery path, for a context overflow Retry
  cannot fix because the oversized prompt is still in the CLI's history.
- [background-tasks](background-tasks.md) — the second `recycleIdleQueries()` exemption, the
  `LiveSessionInfo.backgroundTasks` field, and the `hello`-driven hydration path that reuses the
  same worker-survives-a-bridge-restart asymmetry documented above.
