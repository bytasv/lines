# Cloud sync: session push budgeting

## Purpose

Push a user's `SessionMeta` list to the storage server without re-sending rows it already has and without exceeding the storage server's request body limit. A bulk push (every reconnect) previously re-sent every session unconditionally and, once the local session store grew large (mainly from `WorkflowState.outputs`/`lastStepOutput`), could exceed the body-parser limit and 500 with an HTML page instead of a legible error.

## Entry points

None UI-facing — sync only. Fires on `syncNow` (websocket connect/reconnect) via `pushSessions`, and per-turn/per-status-change via `pushSession`.

## Files

- `shared/types.ts` — `SessionMeta.updatedAt`/`createdAt`
- `server/src/store.ts` — `SyncWatermarks.sessionsPushed`
- `server/src/sync.ts` — `StorageSyncClient.pushSessions`/`pushSession`/`flushSessions`/`chunkSessions`
- `server/src/userContext.ts` — `syncNow` call site (unchanged; still hands the full list to `pushSessions`)
- `storage/src/index.ts` — body-parser `entity.too.large` handling in `onError`

## Symbols

- `StorageSyncClient.pushSessions` — filters a bulk list to metas newer than `marks.sessionsPushed` before queuing them
- `StorageSyncClient.pushSession` — per-session queue + debounce timer, unfiltered (already a delta)
- `StorageSyncClient.flushSessions` — sends the debounced batch as sequential chunks; advances the watermark only if every chunk succeeded
- `StorageSyncClient.chunkSessions` — splits a batch into bodies under `SESSIONS_PUSH_MAX_BYTES`; drops (and warns on) a single meta that alone exceeds the budget
- `SyncWatermarks.sessionsPushed` — newest pushed `SessionMeta.updatedAt`/`createdAt` accepted by storage

## Data flow

`pushSessions(list)` compares each meta's `updatedAt` (falling back to `createdAt`) against `marks.sessionsPushed` and only queues the newer ones via `pushSession`. The shared debounce timer eventually calls `flushSessions`, which splits the queued batch into JSON bodies under `SESSIONS_PUSH_MAX_BYTES` and `PUT`s them to `/sessions` one at a time, awaiting each before sending the next. If a chunk's request fails, its metas are merged back into `pendingSessions` (never overwriting a newer meta that arrived meanwhile) and the watermark is not advanced, so the next flush retries them. Once every chunk in a flush succeeds, `sessionsPushed` is set to the batch's newest timestamp and persisted via the existing `marksDirty`/`commitCursors()` path.

A cursor-less `/sessions` pull (no `marks.sessions` stored — a fresh or migrated install) also clears `sessionsPushed`, so the next bulk push against that storage server is treated as complete rather than assuming it already has rows it has never seen.

Storage-side, a body over the `express.json({ limit: '2mb' })` cap now answers `413 { error: 'payload too large' }` instead of falling through to the generic 500 HTML error page, so `StorageSyncClient.req()` can parse the reason instead of raising the generic "cloud sync unavailable" banner.

## Tests

- `server/src/sync.sessions.test.ts` — chunking under budget, no re-push of unchanged metas, only-the-changed-meta re-push, requeue-and-no-watermark-advance on a rejected chunk, single over-budget meta skipped without blocking siblings
- `server/src/sync.credentials.test.ts` — unaffected by chunking for small batches (still asserts one `/sessions` request)

## Business rules

- Storage rows are LWW upserts; a session whose `updatedAt`/`createdAt` is not newer than the last accepted push is not re-sent in a bulk push.
- A meta with neither `updatedAt` nor `createdAt` is always pushed (correct but not free).
- A single session whose own JSON exceeds the push budget is dropped from the cloud push (with a one-time warning naming its id) rather than failing the whole batch; its local copy and UI are unaffected.
- A rejected chunk's sessions are retried on the next flush, not dropped.

## Architectural rules

- `SESSIONS_PUSH_MAX_BYTES` (1.5 MB) mirrors the same headroom-under-2mb constant style as `TOTAL_MAX_BYTES` in `server/src/memory.ts`.
- Chunk sends are sequential (`await`ed) inside the debounce timer callback, not parallel, so one failure doesn't strand the rest silently.
- `pushSessions` owns the dedup filter; `userContext.ts`'s `syncNow` still calls it with the full session list — `sync.ts` keeps sole ownership of what actually goes on the wire.
- The real growth driver (`WorkflowState.outputs`/`lastStepOutput` written unbounded in `server/src/workflows.ts`) is not capped by this change — deferred as a follow-up since truncating it changes `{outputs.<name>}`/`{previous}` hand-off semantics.

## Related decisions

- [agent-memory-sync](agent-memory-sync.md)
