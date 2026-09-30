# Storage availability banner

## Purpose

Turn "cloud sync unavailable" from an unexplained pill into something a user can act on and a
developer can diagnose without a bridge console (unreachable on a desktop or VPS install): classify
every failed storage request, wait out a routine expired Clerk token instead of flipping the
banner, actively re-probe once down so recovery is noticed within seconds instead of minutes, and
persist a bounded failure log the user can read (and copy) from Settings.

Two causes previously looked identical to the same amber pill. A hidden/backgrounded browser tab
throttles its 50s auth-relay `setInterval` (see [cloud-sync-sessions](cloud-sync-sessions.md) and
[agent-memory-sync](agent-memory-sync.md), which share this same `StorageSyncClient`), so the
bridge routinely holds a stale Clerk token and gets a 401 that is indistinguishable from a genuine
outage. And once storage did recover, nothing repolled it — `pullAll` is spaced 30s and pushes only
fire on local change — so the banner could outlive the real outage by minutes.

The auth case previously needed a reload to clear: nothing made the browser relay a fresh token
outside the 50s interval, so a returning tab (or a manual click) waited out the full interval plus
the next probe tick. `relayAuth`/`retryNow` close that gap — a relayed token, while down, now
triggers an immediate `/settings` probe.

## Entry points

- `web/src/components/StorageBanner.tsx` — the pill; click opens Settings → Sync, plus Retry and
  Dismiss controls
- `web/src/components/SettingsModal.tsx` — `SyncLogSection` (`diagnostics` tab)

## Files

- `shared/types.ts` — `StorageErrorKind`, `StorageStatus`, `SyncLogEntry`, `FileRequestKind`
- `server/src/sync.ts` — `classifyStatus`/`classifyError`, failure/outage bookkeeping, auth grace,
  recovery probe, `retryNow`
- `server/src/store.ts` — `appendSyncLog`/`readSyncLog` on `sync-log.jsonl`
- `server/src/userContext.ts` — injects `appendSyncLog` into `StorageSyncClient`
- `server/src/fileRoutes.ts` — `syncLog` route
- `server/src/index.ts` — `auth` message handler and the relay's `onToken` both call
  `ctx.sync.retryNow()`
- `web/src/ws.ts` — `relayAuth`, `retryStorage`, relay-on-wake
- `web/src/components/StorageBanner.tsx`, `web/src/components/SettingsModal.tsx`
- `desktop/src/main.ts` — main window `backgroundThrottling: false`, so the token relay keeps
  firing while the window is hidden

## Symbols

- `StorageErrorKind` — `'auth' | 'network' | 'timeout' | 'server' | 'client'`
- `classifyStatus(status)` / `classifyError(err)` — pure, unit-tested without a client
- `StorageStatus.kind`/`since`/`failures` — additive fields alongside the existing
  `available`/`reason`
- `SyncLogEntry` — one JSONL row (`fail` | `down` | `up`)
- `StorageSyncClient.recordFailure`/`recordSuccess` — the two paths every `req()` outcome funnels
  through
- `StorageSyncClient.startProbe`/`stopProbe` — the down-only re-probe timer
- `StorageSyncClient.retryNow` — probes `/settings` immediately if down (no-op if up); shares its
  request body with the periodic probe
- `Store.appendSyncLog`/`readSyncLog`
- `relayAuth(link)` (`web/src/ws.ts`) — mints a fresh Clerk token and relays it over one link; used
  by the periodic auth-relay interval, `retryStorage()`, and wake handling
- `retryStorage()` (`web/src/ws.ts`) — the banner's Retry action; relays a fresh token to the
  primary link

## Data flow

Every `StorageSyncClient.req()` outcome now calls `recordSuccess()` (2xx/304) or `recordFailure()`
(transport throw or non-2xx), instead of `setAvailable()` directly. `recordFailure` always logs a
`fail` row via the injected `appendLog` callback (same DI shape as `persistMarks`, so `sync.ts`
still imports no `fs`); whether it also flips `available` depends on `kind` and the auth-grace
state described below. A flip either way appends a `down` or `up` row and fires the existing
`onStatusChange` broadcast, so `StorageStatus`'s new fields reach every browser for free — no new
`ClientMessage`/`ServerMessage`.

The `syncLog` file-request kind reuses the existing authenticated `fileRequest` plumbing
([file-routes-over-ws](file-routes-over-ws.md)) rather than a new socket message: `SyncLogSection`
calls `fileRequest('syncLog', {})` and renders `{ entries, status }` from `store.readSyncLog(200)`
and `sync.status`.

Retry needs no new `ClientMessage`/`ServerMessage`: the existing `auth` message *is* the retry.
`retryStorage()` calls `relayAuth` on the primary link, which relays a fresh Clerk token; the
bridge's `auth` handler (`server/src/index.ts`) sets `ctx.clerkToken` and then calls
`ctx.sync.retryNow()` for the owning connection, which probes `/settings` at once. On success the
existing `recordSuccess` → `setAvailable(true)` → `onStatusChange` path clears the banner through
the ordinary `storageStatus` broadcast. `handleWake` (`web/src/ws.ts`) also calls `relayAuth` for
every open link, so a tab returning from background heals a stale-token outage without a reload.
The desktop relay's `onToken` (a separate token source from the in-channel `auth` message, driven
by the browser's own 50s relay) follows the identical set-token-then-`retryNow()` shape.

## Tests

- `server/src/sync.availability.test.ts` — classification, fail/down/up row shape, the auth-grace
  window (including a success resetting it), the recovery probe (fires, clears its timer, is not
  double-scheduled), `appendLog` defaulting to a no-op
- `server/src/store.sync-log.test.ts` — append/read round-trip, tolerant parse of a torn trailing
  line, the size cap trimming to the newer half

## Business rules

- A single `auth` failure (401/403) does not raise the banner; only `AUTH_GRACE_MS` (90s) of
  continuous auth failures does. Any 2xx/304 resets the grace clock. 90s comfortably exceeds the
  50s auth-relay interval plus a throttled tab's slip, so routine token turnover never surfaces as
  an outage, while a genuinely revoked/misconfigured session still shows within ~90s.
- While down, a `GET /settings` probe fires every `PROBE_INTERVAL_MS` (15s) so recovery is
  reflected within seconds instead of waiting for the next incidental pull/push. The probe is
  `/settings`, deliberately not `/health`: `/health` sits above storage's Clerk gate and would
  clear an auth-caused outage that is still real.
- `sync-log.jsonl` only grows on a failed request or an availability transition — the happy path
  costs no IO — and is capped at ~256 KB, trimmed to its newer half on overflow.
- A soft-error request (`opts.softErrors`, e.g. a "nothing runnable" 404) still marks the link
  available; it never touches the auth-grace clock either, since a soft 401 is not evidence the
  token is good.
- A relayed token while down triggers an immediate probe, owner connections only: the in-channel
  `auth` handler calls `ctx.sync.retryNow()` after setting `ctx.clerkToken`, but only when
  `conn.owner`. The relay's `onToken` (desktop's own auth path) calls the same `retryNow()` after
  setting `ctx.clerkToken`, gated the same way — `registry.peek` never mints a context, so a guest
  token can't reach it.
- `retryNow` is a no-op while the link is up, so the periodic 50s auth relay never adds storage
  traffic on the happy path.
- The desktop main window runs with `backgroundThrottling: false`, so the 50s token-relay timer
  keeps firing while the window is minimized or covered instead of being throttled toward the
  token's ~60s lifetime.
- Only a refused signature verdict (forged, rolled back, or unsigned, unless `LINES_E2EE_STRICT=0`)
  appends a `fail` row and logs a `console.warn`. An unsigned blob accepted under
  `LINES_E2EE_STRICT=0` applies silently — it is not a failure the user can act on.
- The banner's Retry button is client-side feedback only ("Retrying…" for up to 5s, or until
  `storageStatus` changes) — it has no request/response of its own; the banner disappears when
  `storageStatus.available` flips.
- Dismiss is per-tab component state keyed by the outage's `status.since`, not persisted: the same
  outage stays hidden, but a new outage (a new `since`) shows the banner again.

## Architectural rules

- `classifyStatus`/`classifyError` are pure exported functions, kept unit-testable without
  constructing a client.
- `appendLog` is injected with the same shape and default (`() => {}`) as the existing
  `persistMarks` parameter, so `sync.ts` still imports no `fs` and existing tests that don't pass
  one are unaffected.
- The probe timer is `unref()`'d like every other timer in `StorageSyncClient`, and is started only
  on the down transition / stopped only on the up transition — never re-armed by a second failure
  while already down.
- No storage-server change: no Prisma migration, no `storage/` deploy coupling — everything here is
  bridge-local.

## Related decisions

- [cloud-sync-sessions](cloud-sync-sessions.md)
- [agent-memory-sync](agent-memory-sync.md)
- [file-routes-over-ws](file-routes-over-ws.md)
