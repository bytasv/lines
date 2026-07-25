# Plan usage indicator

## Purpose

Shows the logged-in user's Claude-plan usage (5-hour / weekly windows, same data as Claude
Code's `/usage`) as a ring-progress chip with a hover-card breakdown.

## Entry points

- Top-bar `UsageIndicator` chip

## Important files

- `server/src/usage.ts` — `UsagePoller`
- `web/src/store.ts` — `hello` and `usage` message handling
- `web/src/components/UsageIndicator.tsx`

## Important symbols

- `UsagePoller` — polls `api.anthropic.com/api/oauth/usage`, broadcasts `{type: 'usage', ...}`
- `UsageSnapshot`, `UsageWindow` (`shared/types.ts`)
- `UsageIndicator` — renders the chip, gated on `auth.loggedIn`

## Data flow

`UsagePoller.start()` fetches on an interval and after turn completion (debounced via
`refreshSoon`), broadcasting snapshots to all clients. `hello` also carries the current
snapshot for newly connecting clients. The store merges both into `state.usage`;
`UsageIndicator` renders from it.

## Dependencies

Shared `AuthManager` for the OAuth access token used to call the usage endpoint.

## Tests

None. No test infrastructure covers this at time of writing; natural first targets are
`UsagePoller` (mocked `fetch`/`AuthManager`) and `parseSnapshot`.

## Business rules

- No login → no chip. Enforced both server-side (poller never fetches without a session,
  logout nulls the snapshot) and client-side (`UsageIndicator` gates on `auth.loggedIn`).
- `{type: 'usage', usage: null}` means auth is gone (logout or a revoked/expired OAuth
  session) — nothing else.
- A stale snapshot survives transient fetch failures (network blips, non-2xx responses);
  staleness is communicated to the user via "Updated Xm ago" in the hover card, never by
  hiding the chip.
- `hello` may arrive with `usage: null` before the poller's first fetch completes (e.g. right
  after a server restart); if the client is still logged in, the previously held snapshot is
  kept rather than cleared, so the chip does not flicker away on reconnect.

## Architectural rules

None beyond existing `sessionUpsert`-style broadcast conventions — no new message types were
introduced for this feature.

## Related decisions

None recorded.
