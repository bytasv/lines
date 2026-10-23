# Storage availability and sync status

## Purpose

Tell a user, without alarming them, whether their work is reaching the cloud, and what is still
waiting for it. A bridge-to-storage outage is not an error the user has to act on: the machine keeps
working, so nothing says "offline" and nothing raises a banner. Instead a quiet header dot shows
the cloud state and a count of pending writes, and a popover lists them.

The bridge still does the diagnosis a developer needs without a console: it classifies every failed
storage request, waits out a routine expired Clerk token instead of flipping the state, re-probes
once down so recovery is noticed within seconds, and persists a bounded failure log the user can
read from Settings. Pending writes are held in a durable outbox (see
[cloud-sync-sessions](cloud-sync-sessions.md)) and flushed when the link recovers.

## Entry points

- `web/src/components/SyncIndicator.tsx` — the header dot and its popover: cloud state, last synced
  time, pending counts by kind, the writes that failed during this outage, "Sync now", a link to
  Settings → Sync and, in the local window, "Reconnect to Lines Cloud"
- `web/src/components/SyncSection.tsx` — the Settings Sync pane: status, pending breakdown, the
  failure log and Copy log
- `web/src/components/ConnectionBanner.tsx` — the only banner that remains for this area, and only in
  the local window, when the loopback link to the bridge itself is lost

## Files

- `shared/types.ts` — `StorageErrorKind`, `StorageStatus`, `SyncPending`, `SyncOutbox`,
  `SyncLogEntry`, `FileRequestKind`, the `syncNow` client message
- `server/src/sync.ts` — `classifyStatus`/`classifyError`, failure and outage bookkeeping, auth grace,
  recovery probe, `retryNow`, `cloudState`, `pending()`, debounced status broadcast
- `server/src/store.ts` — `appendSyncLog`/`readSyncLog` on `sync-log.jsonl`
- `server/src/userContext.ts` — injects the log sink, and `onRecovered` → `syncNow({ force: true })`
- `server/src/fileRoutes.ts` — `syncLog` route
- `server/src/index.ts` — `auth` and `syncNow` message handlers, the relay's `onToken`
- `web/src/ws.ts` — `relayAuth`, `retryStorage`, relay-on-wake
- `web/src/store.ts` — `syncIndicator()`, the derived reading the dot is drawn from
- `web/src/lib/machineHealth.ts` — storage outages no longer colour a machine
- `desktop/src/main.ts` — main window `backgroundThrottling: false`, so the token relay keeps
  firing while the window is hidden

## Symbols

- `StorageErrorKind` — `'auth' | 'network' | 'timeout' | 'server' | 'client'`
- `classifyStatus(status)` / `classifyError(err)` — pure, unit-tested without a client
- `StorageStatus.cloud` — `'ok' | 'unreachable' | 'signedOut'`; `signedOut` is no token, or an auth
  failure past the grace; an outage never reaches it on its own
- `StorageStatus.pending` / `lastSyncedAt` — per-kind pending counts and the last accepted request
- `StorageStatus.kind`/`since`/`failures` — additive fields alongside `available`/`reason`
- `SyncLogEntry` — one JSONL row (`fail` | `down` | `up`)
- `StorageSyncClient.recordFailure`/`recordSuccess` — the two paths every `req()` outcome funnels
  through
- `StorageSyncClient.startProbe`/`stopProbe` — the down-only re-probe timer
- `StorageSyncClient.retryNow` — probes `/settings` immediately if down (no-op if up)
- `StorageSyncClient.pending()` — the counts the indicator shows
- `syncIndicator(status)` (`web/src/store.ts`) — reads `cloud`/`pending` into one of four dot states,
  falling back to `available` for a bridge that predates them
- `relayAuth(link)` / `retryStorage()` (`web/src/ws.ts`) — mint and relay a fresh Clerk token; the
  indicator's Retry and the auth-relay interval both use them

## Data flow

Every `StorageSyncClient.req()` outcome calls `recordSuccess()` (2xx/304) or `recordFailure()`
(transport throw or non-2xx). `recordFailure` always logs a `fail` row through the injected
`appendLog` callback; whether it also flips `available` depends on `kind` and the auth-grace state.
A flip appends a `down` or `up` row, and fires `onStatusChange`. Pending-count changes fire the same
callback, debounced to about a second, so the broadcast `storageStatus` carries the counts without a
broadcast per edit.

On the `up` transition, `onRecovered` runs `syncNow({ force: true })`: queued deletes go first, then
the pull, then the pushes. A token arriving while writes are pending does the same. The popover's
"Sync now" sends `syncNow`, which does the same flush.

The `syncLog` file request reuses the authenticated `fileRequest` plumbing
([file-routes-over-ws](file-routes-over-ws.md)). Retry needs no new message: the existing `auth`
message is the retry, and the bridge's handler calls `retryNow()` after setting the token.

## Tests

- `server/src/sync.availability.test.ts` — classification, fail/down/up row shape, the auth-grace
  window, the recovery probe, `appendLog` defaulting to a no-op
- `server/src/sync.outbox.test.ts` — pending counts, the recovery flush firing once per outage,
  dirty marks clearing only on success
- `server/src/store.sync-log.test.ts` — append/read round-trip, tolerant parse of a torn trailing
  line, the size cap trimming to the newer half

## Business rules

- A single `auth` failure (401/403) does not change the cloud state; only `AUTH_GRACE_MS` (90s) of
  continuous auth failures does. Any 2xx/304 resets the grace clock. `signedOut` is reported for a
  missing token or for that persisted auth failure, never for a plain outage.
- While down, a `GET /settings` probe fires every `PROBE_INTERVAL_MS` (15s). The probe is `/settings`,
  not `/health`, which sits above storage's Clerk gate.
- Nothing in the cloud-down path raises a visible "offline" banner or a modal or toast on a state
  change. The header dot is grey when the cloud is unreachable or signed out, and never red or amber.
- A machine whose storage link is down stays green in the machine switcher: turns still run, only the
  cloud lags.
- The local window's `ConnectionBanner` is the one exception: it shows only when the loopback link to
  the bridge is lost, because then the user really cannot work.
- `sync-log.jsonl` only grows on a failed request or an availability transition, capped at ~256 KB and
  trimmed to its newer half on overflow.
- A soft-error request still marks the link available and never touches the auth-grace clock.
- A relayed token while down triggers an immediate probe (owner connections only).
- Only a refused signature verdict appends a `fail` row and warns. An unsigned blob accepted under
  `LINES_E2EE_STRICT=0` applies silently.

## Architectural rules

- `classifyStatus`/`classifyError` are pure exported functions, unit-testable without a client.
- `appendLog`, `persistOutbox`, `onRecovered` and `localSessions` are injected, so `sync.ts` still
  imports no `fs`.
- The probe timer is `unref()`'d like every other `StorageSyncClient` timer, started only on the down
  transition and stopped only on the up transition.
- No storage-server change: no Prisma migration, no `storage/` deploy coupling.

## Related decisions

- [cloud-sync-sessions](cloud-sync-sessions.md)
- [agent-memory-sync](agent-memory-sync.md)
- [file-routes-over-ws](file-routes-over-ws.md)
- [desktop-app](desktop-app.md) — the local fallback window that keeps the machine usable while the
  cloud is down
