# Auth-failure recovery

## Purpose

When the app-managed OAuth token is rejected during a turn, recover in the same turn:
refresh the token if the refresh token is still good, otherwise log out — which opens the
browser's login modal immediately — and leave the failed turn showing the ordinary
"turn failed" row with a Retry button.

Before this, a dead token only surfaced when `UsagePoller` happened to hit its own 401
(up to 5 minutes later), and a crashed query wrote no `result` event at all, so the
transcript ended on a half-finished turn with no Retry affordance.

## Entry points

- A turn failing: `SessionManager.handleWorkerEnded` (query crash) and the
  `msg.type === 'result'` branch of `SessionManager.handleWorkerEvent` (error result).

## Important files

- `server/src/auth.ts` — `isAuthFailureMessage`, `AuthManager.handleTokenRejected`
- `server/src/sessions.ts` — `handleWorkerEnded`, `handleWorkerEvent`, `retryTurn`
- `web/src/lib/transcript.ts` — builds the `ResultItem` the Retry button keys off
- `web/src/components/Transcript.tsx` — `retryKey` / Retry button (unchanged)
- `web/src/store.ts` — `authStatus` handler that opens the login modal (unchanged)

## Important symbols

- `isAuthFailureMessage(message)` — narrow regex match over SDK/CLI error text
  (`invalid_grant`, `authentication_error`, `invalid bearer token`, `401 Unauthorized`,
  `oauth token … expired`, `oauth authentication failed`, `please run /login`)
- `AuthManager.handleTokenRejected()` — no-op when logged out, else one `forceRefresh()`

## Data flow

Turn fails → `isAuthFailureMessage(errorText)` → `auth.handleTokenRejected()` →
`AuthManager.refresh()`:

- refresh succeeds → `onRefresh` → `SessionManager.recycleIdleQueries()`; no modal, and the
  next prompt (or Retry) runs on the new token.
- refresh returns 400/401 → `logout()` → `emitChange()` → `userContext.ts` broadcasts
  `{ type: 'authStatus', auth: { loggedIn: false } }` → `store.ts` sets
  `loginModalOpen: true`.

Independently, `handleWorkerEnded`'s error branch emits a synthetic SDK-shaped event
(`{ type: 'result', subtype: 'error_during_execution', is_error: true, result: <error> }`)
before flipping the status to `error`, so `transcript.ts` builds a `ResultItem` with
`isError` and `Transcript`'s existing `retryKey` renders Retry.

## Dependencies

Reuses the existing single-flight `AuthManager.refresh()`, the existing `authStatus`
broadcast, the existing `emitEvent` transcript writer, and the existing `retryTurn` /
Retry-button pair. No new message type, no client changes.

## Tests

- `server/src/auth.failure.test.ts`
- `server/src/sessions.ended.test.ts`

## Business rules

- An auth-classified turn failure attempts exactly one token refresh before logging out;
  a successful refresh means no login prompt at all.
- The login modal opens off the existing `authStatus` broadcast, not a new message type.
  Unlike the `hello` auto-open, it is not deduped — a repeat failure reopens a dismissed
  modal, which is intended.
- Every query crash (auth-related or not) now writes a synthetic `result` event, so the
  transcript shows "turn failed" and a Retry button. This is what `retryTurn` always
  documented itself as covering ("query crash or `is_error` result").
- Retry after re-login is manual; nothing auto-resumes the failed turn.
- A clean `ended` (no error) writes no synthetic result.

## Architectural rules

- Classification lives in `auth.ts` and is called from `sessions.ts`; `worker.ts` stays
  thin and does no error interpretation.
- `handleTokenRejected` deliberately goes through `refresh()` rather than calling
  `logout()` directly, so N sessions failing at once cause one token request and a
  merely-expired token recovers without bothering the user.
- The pattern list is kept narrow and biased toward false negatives: a missed match
  degrades to the old behaviour (no prompt until the poller notices), whereas a false
  positive would force a refresh on a healthy session.
- The synthetic result is emitted via `emitEvent` directly, not routed through
  `handleWorkerEvent`, so it cannot re-run the turn-settle bookkeeping (cost/token
  accumulation, `onTurnComplete`, workflow advance).
- SDK/CLI error wording is not a published contract; `isAuthFailureMessage` can silently
  stop matching after an upstream change.

## Related decisions

None recorded.
