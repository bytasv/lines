# Auth-failure recovery

## Purpose

When the app-managed OAuth token is rejected during a turn, recover in the same turn:
refresh the token if the refresh token is still good, or log out — which opens the
browser's login modal immediately. The recovery outcome is then made **visible**: the
failed turn's banner is rewritten to name the action the user must actually take, and
when a sign-in is genuinely required a **Sign in** button appears next to Retry.

Before this, the raw CLI text (`Failed to authenticate. API Error: 401 OAuth access
token has expired. Re-authenticate to continue.`) was shown with only a bare Retry
button, even when the token had already been silently refreshed (Retry would have
worked) or the refresh itself had failed with no visible reason.

## Entry points

- A turn failing: `SessionManager.handleWorkerEnded` (query crash, via `failTurn`) and
  the `msg.type === 'result'` branch of `SessionManager.handleWorkerEvent` (error
  result).

## Important files

- `shared/types.ts` — `SessionErrorKind`, `SessionMeta.errorKind`, `resultErrorText`
- `server/src/auth.ts` — `isAuthFailureMessage`, `AuthManager.handleTokenRejected`,
  `TokenRejection`
- `server/src/sessions.ts` — `failTurn`, `recoverAuthFailure`, `authRecoveryMessage`,
  `setStatus`, `handleWorkerEvent`
- `web/src/lib/transcript.ts` — builds the `ResultItem` the Retry button keys off, via
  `resultErrorText`
- `web/src/components/SessionView.tsx` — Sign in button in the session-level error alert
- `web/src/components/Transcript.tsx` — `FailedTurnActions` (Sign in + Retry) on the
  trailing failed-result row
- `web/src/store.ts` — `authStatus` handler that opens the login modal (unchanged)

## Important symbols

- `isAuthFailureMessage(message)` — narrow regex match over SDK/CLI error text
  (`invalid_grant`, `authentication_error`, `invalid bearer token`, `401 Unauthorized`,
  `oauth … token … expired`, `oauth authentication failed`, `please run /login`,
  `re-authenticate to continue`)
- `AuthManager.handleTokenRejected(): Promise<TokenRejection>` — no-op-but-reports when
  already logged out (`{ outcome: 'signed-out' }`), else one `forceRefresh()`; success is
  `{ outcome: 'refreshed' }`, a dead refresh token is `{ outcome: 'signed-out' }`, any
  other failure (5xx, offline) is `{ outcome: 'refresh-failed', error }` and leaves the
  session signed in.
- `resultErrorText(msg)` — the error text of an SDK `result` message: prefers
  `msg.result`, falls back to `msg.errors[]` joined with `\n` (an `SDKResultError`
  carries no `result` at all). Shared between server and web so both read a failure the
  same way.
- `SessionManager.recoverAuthFailure(sessionId, error)` — if the error is
  auth-classified, awaits `handleTokenRejected()` and then rewrites the failed turn's
  `errorMessage`/`errorKind` via `setStatus` — but only if the session is still showing
  that exact error (see business rules).
- `authRecoveryMessage(rejection)` — the three actionable strings ("…has been renewed.
  Retry to continue.", "…could not be renewed. Sign in to Claude, then Retry.", or the
  shared `authRefusalMessage` text for a transient failure).
- `SessionMeta.errorKind?: 'auth'` — set alongside `errorMessage` only when Retry alone
  cannot clear the failure (a sign-in is required); drives the Sign in button. Same
  lifetime as `errorMessage`.
- `SessionManager.failTurn(sessionId, error)` — the single funnel for every failure the
  SDK never reports as a `result`; now also the single classification point, calling
  `recoverAuthFailure` after `setStatus`. See [turn-failure-retry](turn-failure-retry.md)
  for its other callers.

## Data flow

Turn fails → the failure is classified in exactly two places: `failTurn` (query crash, a
push that never reached the worker, workflow pre-run failures) and the `result` branch
of `handleWorkerEvent` (an `is_error`/non-`success` SDK result, which bypasses `failTurn`
by design). Both call `recoverAuthFailure(sessionId, resultErrorText(msg))`:

- not auth-classified, or no `AuthManager` wired (ambient-token mode) → no-op; today's
  raw-text-plus-Retry behavior, unchanged.
- auth-classified → `auth.handleTokenRejected()` → `AuthManager.refresh()`:
  - `{ outcome: 'refreshed' }` → banner becomes "The Claude login expired mid-turn and
    has been renewed. Retry to continue."; no `errorKind`; no modal.
  - `{ outcome: 'signed-out' }` (already logged out, or the refresh token was dead) →
    banner becomes "…could not be renewed. Sign in to Claude, then Retry."; `errorKind:
    'auth'` — this also `logout()`s when it was a live refresh token dying, which
    broadcasts `{ type: 'authStatus', auth: { loggedIn: false } }` and force-opens the
    login modal independently of the banner rewrite.
  - `{ outcome: 'refresh-failed', error } }` (5xx, offline) → banner becomes the shared
    `authRefusalMessage(error)` text; no `errorKind`; the user stays signed in.

The revision only lands if the session is still showing the exact failure that triggered
it (`status === 'error' && errorMessage === error`) — a flushed queue, a Retry click, or
a workflow advance that happened while the refresh was in flight all skip the rewrite,
since the banner is no longer this recovery's to own. Recovery itself (the refresh
attempt) always runs regardless.

On the client, `SessionView`'s alert and `Transcript`'s `FailedTurnActions` both render a
Sign in button only when `session.errorKind === 'auth'` **and** `auth.loggedIn === false`
— the second half is what retires a stale Sign in button after a re-login with no server
sweep needed.

Independently, `failTurn` still emits a synthetic SDK-shaped event (`{ type: 'result',
subtype: 'error_during_execution', is_error: true, result: <error> }`) before flipping
the status to `error`, so `transcript.ts` builds a `ResultItem` and the transcript keeps
the raw CLI text as the durable diagnostic record — only the banner changes, never the
transcript row.

## Dependencies

Reuses the existing single-flight `AuthManager.refresh()`, the existing `authStatus`
broadcast, the existing `emitEvent` transcript writer, the existing `setStatus` /
`sessionUpsert` path, and the existing `LoginModal` + `openLoginModal()`. One new wire
field (`SessionMeta.errorKind`), one new shared pure function (`resultErrorText`). No new
message type, no new modal, no new client state, no DB migration.

## Tests

- `server/src/auth.failure.test.ts`
- `server/src/sessions.ended.test.ts`

## Business rules

- An auth-classified turn failure attempts exactly one token refresh, then always
  rewrites the banner to name the next action — Retry, Sign in, or "check your
  connection" — instead of leaving the raw CLI text up with only a Retry button.
- `errorKind: 'auth'` is set only for `'signed-out'`; a `'refreshed'` or
  `'refresh-failed'` outcome clears it (Retry alone is enough there).
- The login modal opens off the existing `authStatus` broadcast, not a new message type.
  Unlike the `hello` auto-open, it is not deduped — a repeat failure reopens a dismissed
  modal, which is intended.
- Retry stays entirely manual — nothing auto-resumes a failed turn, even after a
  successful silent refresh or a fresh sign-in. This matters most for a login completed
  later or from another device: it must not fire N queued turns across every session
  that failed while signed out.
- `errorKind` is never set when no `AuthManager` is wired (ambient-token mode has no
  login flow to offer); the raw message and plain Retry are unchanged there.
- Every query crash (auth-related or not) still writes a synthetic `result` event, so
  the transcript shows "turn failed" and a Retry button, and that raw text is preserved
  verbatim as the durable record even after the banner is revised.
- A clean `ended` (no error) writes no synthetic result.

## Architectural rules

- Classification lives in `auth.ts` (pattern matching, refresh outcome) and `sessions.ts`
  (`recoverAuthFailure`, banner text); `worker.ts` stays thin and does no error
  interpretation.
- Classification now happens at exactly two points: `failTurn` (covers every caller that
  funnels through it, including `pushTurnSafely` and the `workflows.ts` pre-run sites)
  and the `result` branch of `handleWorkerEvent`, which bypasses `failTurn` by design
  since the SDK already reported the result itself.
- `handleTokenRejected` goes through the single-flight `refresh()` rather than `logout()`
  directly, so N simultaneous failures cause one token request; concurrent callers all
  resolve `'refreshed'`.
- The revision guard (`status === 'error' && errorMessage === error`) is the entire
  don't-clobber mechanism — no extra in-flight state. It relies on the workflow
  failed-park path using `persistMeta`, not `setStatus`, so a park leaves the message
  (and thus the guard's identity check) intact.
- The banner strings in `authRecoveryMessage` deliberately avoid every word
  `AUTH_FAILURE_PATTERNS` matches (`oauth`/`401`/`re-authenticate`/`/login`), so a
  re-failure showing one of them cannot re-classify itself into a recovery loop.
- A successful `refresh()` still does not call `emitChange()` — the visible signal for a
  silent recovery is the revised banner, not an auth-status broadcast; adding one would
  also spin `recycleIdleQueries()`/`usage.refreshSoon()` on every proactive refresh.
- The synthetic result is still emitted via `emitEvent` directly, never routed through
  `handleWorkerEvent`, so it cannot re-run turn-settle bookkeeping (cost/token
  accumulation, `onTurnComplete`, workflow advance).
- SDK/CLI error wording is not a published contract; `isAuthFailureMessage` can silently
  stop matching after an upstream change — the fallback is today's raw-text-plus-Retry
  behavior, never worse.
- **Known limitation:** in Compact view the failed row sits inside a collapsed
  `AgentTurn`, so `SessionView`'s alert is the always-visible affordance; this is
  pre-existing and out of scope for this feature.

## Related decisions

- [app-managed-login-only](app-managed-login-only.md) — this feature recovers a token
  rejected *during* a turn; that one guarantees a turn never *starts* on the ambient
  `~/.claude` login, and shares `authRefusalMessage` with `authRecoveryMessage`.
- [turn-failure-retry](turn-failure-retry.md) — generalizes `failTurn` into the single
  funnel for every recoverable turn failure; this feature adds the auth-specific
  revision on top of that funnel.
