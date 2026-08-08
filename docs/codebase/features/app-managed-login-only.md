# App-managed login is the only credential path

## Purpose

The app's own OAuth login (`~/.lines-app/users/<id>/auth.json`) is the sole credential
any Claude query runs on. The ambient Claude Code CLI login (`~/.claude`) is never a
fallback: it is a separate token store this app cannot refresh, so inheriting a stale one
makes every turn 401 forever with no login prompt — the user sees repeated
`401 OAuth access token has expired` failures while the app still reports them as signed
in.

Before this, three paths could silently fall through to ambient credentials:

- a turn pushed while the app token was missing or inside its refresh margin spawned the
  CLI child with no `CLAUDE_CODE_OAUTH_TOKEN` at all,
- the bridge-side helper queries (`autoName`, `summarizeTurn`, `consolidateStepOutput`)
  read a sync token cache and omitted the env key when it was null,
- a proactive refresh that failed transiently (offline at wake, 5xx) was never retried, so
  the token rotted until a turn hit a 401.

## Entry points

- Any turn start: `SessionManager.prompt` and `SessionManager.compactContext`, both via
  `pushTurnSafely`
- Session rename / turn summary / workflow step consolidation: the three bridge-side
  one-shot `query()` calls in `sessions.ts`
- `AuthManager` construction and every `persistTokens`, which (re)arm the proactive timer

## Important files

- `server/src/auth.ts` — `ensureFreshToken`, `scheduleProactiveRefresh` backoff,
  `AUTH_FAILURE_PATTERNS`
- `server/src/sessions.ts` — `pushTurn`, `pushTurnSafely`, `pushWithToken`, `failTurn`,
  `authRefusalMessage`, `ownerToken`, `buildQueryOptions`
- `web/src/store.ts` — `authStatus` handler that force-opens the login modal (unchanged)
- `web/src/components/LoginModal.tsx` — the modal the refusal reopens

## Important symbols

- `SessionManager.pushTurn(meta, message)` — async; resolves a token via
  `ensureFreshToken()` before the spawn, and refuses the turn if it cannot get one
- `SessionManager.pushTurnSafely(meta, message)` — the fire-and-forget wrapper both call
  sites use, so a throw past `pushTurn`'s own handling cannot become an unhandled rejection
- `SessionManager.failTurn(sessionId, error)` — synthetic `result` event then `error`
  status, so a refusal renders as an ordinary failed turn with Retry
- `authRefusalMessage(err)` — the two user-facing refusal strings (not signed in vs.
  refresh failed) in one place
- `SessionManager.ownerToken()` — async token for the bridge-side helper queries; returns
  `null` rather than falling back, and each caller skips its query entirely on `null`
- `PROACTIVE_RETRY_MS` / `PROACTIVE_RETRY_CAP_MS` — 60s first rung, 15min ceiling for the
  proactive-refresh retry ladder

## Data flow

A turn push resolves its own credential before spawning:

`prompt`/`compactContext` → `pushTurnSafely` → `pushTurn` → `auth.ensureFreshToken()`

- token resolved (refreshing in-margin) → `pushWithToken` → recycle the query if it was
  spawned with a different token → `worker.push` with
  `env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token }`.
- `AuthRequiredError` (logged out) → `failTurn` with "Not signed in to Claude. Sign in,
  then Retry." **and** a re-broadcast of `{ type: 'authStatus', auth: { loggedIn: false } }`,
  which `store.ts` force-opens the login modal on — reopening a dismissed one.
- any other refresh error (offline, 5xx) → `failTurn` with the refresh reason; the user
  stays signed in and can Retry once connectivity returns.

The bridge-side helpers take the same path through `ownerToken()`, but a `null` simply
skips the query: `autoName` keeps the default session name, `summarizeTurn` writes no
summary, `consolidateStepOutput` falls back to `lastAssistantText`. None of them ever
spawn a CLI child without an explicit app token.

Independently, a failed proactive refresh reschedules itself on a doubling backoff
(60s → 15min cap) instead of leaving the token to rot; `persistTokens` resets the ladder,
and `logout()` clears both the timer and the ladder.

## Dependencies

Reuses the existing single-flight `AuthManager.refresh()`, the existing `authStatus`
broadcast and its force-open behavior in `store.ts`, and the existing synthetic-result /
Retry-button pair from [auth-failure-recovery](auth-failure-recovery.md). No new message
type and no new client state.

## Tests

- `server/src/sessions.spawn.test.ts` — a turn while logged out is refused instead of
  falling back to ambient credentials; a stale token is refreshed before the query spawns
- `server/src/auth.failure.test.ts` — proactive-refresh retry scheduling and the widened
  failure patterns
- `server/src/sessions.ended.test.ts` — the no-`AuthManager` path still pushes

## Business rules

- A signed-in user's turn never runs on ambient `~/.claude` credentials. If no app token
  can be produced, the turn is refused — a visible failure with Retry is strictly better
  than a silent 401 loop.
- A refusal from being logged out re-broadcasts the logged-out `authStatus` so a dismissed
  login modal reopens; a refusal from a transient refresh failure does not (the user is
  still signed in, and a modal would be the wrong ask).
- The bridge-side helper queries are best-effort: no token means skip, never fall back and
  never fail the surrounding turn.
- `compactContext` still returns a synchronous `{ ok: true }`; an auth refusal after that
  point surfaces through `failTurn`, not through the `{ ok: false, code, reason }` union.
- A proactive refresh that fails transiently retries on a 60s-doubling ladder capped at
  15 minutes; a dead refresh token instead logs out, which stops the chain.
- Logins are tracked per OAuth `state`, so two started at once (two tabs today, two
  paired devices once the app is hosted) each keep their own PKCE verifier and either
  paste completes. Completing one clears the rest; unfinished ones expire after 30
  minutes. A paste carrying no `#state` falls back to the newest in-flight login.
- `accessToken: null` in `buildQueryOptions` is reachable only when no `AuthManager` is
  wired at all (tests / embedding), not for any real signed-in user.

## Architectural rules

- The "never fall back for a signed-in user" guarantee lives in `pushTurn`, which refuses
  before reaching `buildQueryOptions` — there is deliberately no second options builder,
  since a builder-level split would duplicate the whole option set for one differing key.
- Both turn-start call sites go through `pushTurnSafely` rather than `void this.pushTurn(...)`,
  so there is one place guaranteeing no unhandled rejection.
- `ownerToken()` awaits `ensureFreshToken()` rather than reading `getAccessTokenSync()`:
  the helper queries deserve the same refresh-on-margin treatment as a real turn.
- The no-`AuthManager` branch of `pushTurn` returns before the first `await`, keeping that
  path synchronous so existing tests that assert an immediate push still hold.
- The proactive backoff computes its first rung explicitly (`null ? RETRY : min(x*2, CAP)`)
  rather than doubling a default, which would have skipped the 60s rung.
- `getAccessTokenSync()` remains on `AuthManager` but no longer has a production caller;
  it is kept for the sync-status shape tests rely on.

## Related decisions

None recorded.
