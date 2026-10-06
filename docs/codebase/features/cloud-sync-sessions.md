# Cloud sync: session push budgeting and delete tombstones

## Purpose

Push a user's `SessionMeta` list to the storage server without re-sending rows it already has and without exceeding the storage server's request body limit, and make a session delete stick across every machine syncing that account.

A bulk push (every reconnect) previously re-sent every session unconditionally and, once the local session store grew large (mainly from `WorkflowState.outputs`/`lastStepOutput`), could exceed the body-parser limit and 500 with an HTML page instead of a legible error.

Separately, a delete used to be only an absence: storage hard-deleted the row, and any peer that still held a copy — because it hadn't pulled yet, or a delete raced an in-flight push — simply pushed it back on its next sync. Storage now soft-deletes (`Session.deletedAt`), keeps serving the tombstoned row inside the ordinary delta window, and refuses to let a stale write resurrect it; the bridge mirrors this with its own local tombstone map so `adoptSynced` has something to compare a re-arriving session against.

## Entry points

None UI-facing — sync only. Fires on `syncNow` (websocket connect/reconnect) via `pushSessions`, per-turn/per-status-change via `pushSession`, and on `deleteSession`/the storage pull's tombstoned rows.

## Files

- `shared/types.ts` — `SessionMeta.updatedAt`/`createdAt`, `SessionMeta.permissionCeiling` (local-only)
- `server/src/store.ts` — `SyncWatermarks.sessionsPushed`, `loadDeletedSessions`/`saveDeletedSessions`
- `server/src/sync.ts` — `StorageSyncClient.pushSessions`/`pushSession`/`flushSessions`/`chunkSessions`/`deleteSession`/`drainDeletes`; `sessionForSync` (strips local-only fields from what is sent)
- `server/src/sessions.ts` — `SessionManager.adoptSynced`/`adoptSyncedWorkflow`/`applyRemoteDelete`, the tombstone map
- `server/src/workflows.ts` — `runStep`'s refusal of a session whose own workflow snapshot is marked (`unverifiedRefusal`)
- `server/src/syncSignature.ts` — `runnableDigest`, which `adoptSyncedWorkflow` compares an embedded workflow by
- `server/src/userContext.ts` — `syncNow` call site: routes a pulled tombstoned row to `applyRemoteDelete` instead of `adoptSynced`
- `storage/prisma/schema.prisma` — `Session.deletedAt`
- `storage/src/index.ts` — the three `/sessions` routes (now thin wrappers), body-parser `entity.too.large` handling in `onError`
- `storage/src/sessionRows.ts` — the actual row rules: LWW upsert, soft delete, resurrect guard, wire shape

## Symbols

- `StorageSyncClient.pushSessions` — filters a bulk list to metas newer than `marks.sessionsPushed`, drops any id with an unconfirmed delete, and drains `pendingDeletes` before queuing the rest
- `StorageSyncClient.pushSession` — per-session queue + debounce timer, unfiltered (already a delta); skips an id whose delete is still pending
- `StorageSyncClient.flushSessions` — sends the debounced batch as sequential chunks, re-filtering `pendingDeletes` per chunk (not just once up front); advances the watermark only if every chunk succeeded; drains deletes again afterward
- `StorageSyncClient.chunkSessions` — splits a batch into bodies under `SESSIONS_PUSH_MAX_BYTES`; drops (and warns on) a single meta that alone exceeds the budget
- `StorageSyncClient.deleteSession` — queues the id in `pendingDeletes` immediately, then sends the `DELETE` right away if the client is enabled and not mid-`applying`; otherwise the id waits for the next `pushSessions`/`pushSession` call to retry it
- `StorageSyncClient.drainDeletes` — retries every unconfirmed delete; storage's soft delete is idempotent, so a retry is free
- `SyncWatermarks.sessionsPushed` — newest pushed `SessionMeta.updatedAt`/`createdAt` accepted by storage
- `SessionManager.adoptSynced` — LWW-adopts a pulled session, now returning early when a local tombstone's timestamp is not beaten by the pulled row (the branch the plain "no local copy" case never reached before); keeps `queued`, `permissionMode` and `permissionCeiling` at what this machine already had
- `SessionManager.adoptSyncedWorkflow` — the part of a pulled `workflow` state that becomes prompt text here: keeps an embedded `def` only if it is the exact workflow this machine already holds for the session, otherwise keeps it for display with an `unsigned` mark; for the run this machine already holds, keeps its own `task`/`outputs`/`lastStepOutput`
- `sessionForSync` (`server/src/sync.ts`) — the copy of a meta a push sends, without `permissionCeiling`; the live meta keeps it
- `SessionManager.applyRemoteDelete(id, deletedAt)` — records a tombstone (keeping the newer of any existing one), tears down local state if present, and broadcasts `sessionDeleted` — even for a session this machine never held
- `Store.loadDeletedSessions` / `saveDeletedSessions` — the bridge's own tombstone map, persisted beside `sessions.json` and pruned past ~30 days on load
- `listSessions` / `putSessions` / `putSession` / `softDeleteSession` / `toWire` (`storage/src/sessionRows.ts`) — the row-level implementation the `/sessions` routes call through to

## Data flow

`pushSessions(list)` compares each meta's `updatedAt` (falling back to `createdAt`) against `marks.sessionsPushed` and only queues the newer ones via `pushSession`, after first draining any pending deletes and dropping any id whose delete has not yet been confirmed. The shared debounce timer eventually calls `flushSessions`, which splits the queued batch into JSON bodies under `SESSIONS_PUSH_MAX_BYTES`, re-checks `pendingDeletes` **per chunk** (a delete issued while an earlier chunk was in flight must not be undone by a later one), and `PUT`s the survivors to `/sessions` one at a time, awaiting each before sending the next. If a chunk's request fails, its metas are merged back into `pendingSessions` (never overwriting a newer meta that arrived meanwhile) and the watermark is not advanced, so the next flush retries them. Once every chunk in a flush succeeds, `sessionsPushed` is set to the batch's newest timestamp and persisted via the existing `marksDirty`/`commitCursors()` path.

A cursor-less `/sessions` pull (no `marks.sessions` stored — a fresh or migrated install) also clears `sessionsPushed`, so the next bulk push against that storage server is treated as complete rather than assuming it already has rows it has never seen.

Storage-side, a body over the `express.json({ limit: '2mb' })` cap now answers `413 { error: 'payload too large' }` instead of falling through to the generic 500 HTML error page, so `StorageSyncClient.req()` can parse the reason instead of raising the generic "cloud sync unavailable" banner.

`req()`'s failure/success outcomes (including these) now also drive [storage-availability-banner](storage-availability-banner.md): each is classified into a `StorageErrorKind`, logged to `sync-log.jsonl`, and — for a 401/403 — held for `AUTH_GRACE_MS` before raising the banner at all, since an expired-token push looks identical to a real outage otherwise.

### Delete: local

`SessionManager.deleteSession` records a tombstone (`deletedAt = Date.now()`) alongside forgetting the session's live state, transcript and queue, then broadcasts `sessionDeleted` as before. `sync.ts`'s broadcast observer routes that into `StorageSyncClient.deleteSession`, which queues the id in `pendingDeletes` and, if the client is enabled and not mid-pull, fires the `DELETE` immediately. If it can't fire yet — no token, or `applying` — the id simply waits: every later `pushSessions`/`pushSession` call drains `pendingDeletes` first.

### Delete: remote

On pull, `userContext.ts`'s `syncNow` checks each row's `deletedAt`: present means it's a tombstone, routed to `SessionManager.applyRemoteDelete(id, deletedAt)` rather than `adoptSynced`. `applyRemoteDelete` records the tombstone (only advancing it, never regressing), tears down any local copy, and broadcasts `sessionDeleted` — deliberately independent of whether this machine ever held the row, so a *third*, slower machine's later push still can't resurrect it here.

A row with no `deletedAt` goes through `adoptSynced` as before, except it now checks the local tombstone map first: if one exists and the pulled row's stamp doesn't beat it, the pull is dropped. This is the fix for the "undeletable session" — the previous LWW guard (`cur && meta.updatedAt <= cur.updatedAt`) only ever ran when a local copy of the session still existed, so a session that had already been deleted locally (no `cur`) was re-adopted unconditionally from any peer that hadn't pulled the delete yet.

### Storage-side

`GET /sessions` serves tombstoned rows inside the ordinary delta window — the field that was previously filtered out (`toWire` maps a `deletedAt` row to `{...data, deletedAt: ms}`) is what lets a peer learn about a delete at all. Both `PUT /sessions` (batch, raw SQL with a `WHERE` guard) and `PUT /sessions/:id` (single, a `findUnique` read before the upsert) refuse to clear or overwrite a tombstone unless the incoming `updatedAt` is strictly newer than `deletedAt`. `DELETE /sessions/:id` only ever stamps a *null* `deletedAt` (`WHERE deleted_at IS NULL`), so a retried delete — the bridge retries until storage confirms — keeps the original stamp instead of advancing it and re-notifying every peer on every retry.

### Adopt: what a pulled row cannot carry

A session row is never signed (see [end-to-end-encryption](end-to-end-encryption.md)), so `adoptSynced` keeps every field that would become an instruction to this machine at this machine's own value. Beyond `queued`/`permissionMode` (see Business rules), `permissionCeiling` — the limit a foreign recipe run puts on what an approved plan resumes in (see [recipes](recipes.md)) — is always the local one, and `sessionForSync` keeps it off the wire in the first place.

`adoptSyncedWorkflow` handles the workflow state. An embedded `workflow.def` (the snapshot a session runs from instead of a library workflow — a guest's inline workflow, for one) is kept as-is only when its `runnableDigest` matches the def this machine already holds for that session; otherwise it is kept for display with an `unsigned` mark. `runStep` refuses every step of a marked snapshot — strict sync or not, since there is no signature a recovery switch could vouch for and no library copy to review it from — parking the step `pre-run` with a failure that says to start a new session from the library; nor does such a snapshot get to seed the session's model or permission mode. For the run this machine already holds (same `workflowId`), its own `task`, `outputs` and `lastStepOutput` — the values substituted into later steps' prompts — stand over the row's, and a row without a `def` for that run keeps the local one rather than falling through to whichever library workflow shares its id.

## Tests

- `server/src/sync.sessions.test.ts` — chunking under budget, no re-push of unchanged metas, only-the-changed-meta re-push, requeue-and-no-watermark-advance on a rejected chunk, single over-budget meta skipped without blocking siblings, a delete issued mid-flight is not undone by that push, a delete queued while `applying`/disabled rides the next sync, a bulk push never carries a session whose delete is still unconfirmed, a local-only field (`permissionCeiling`) never leaves the machine while the live meta keeps it
- `server/src/sync.credentials.test.ts` — unaffected by chunking for small batches (still asserts one `/sessions` request)
- `server/src/workflows.trust.test.ts` — a synced session carrying its own workflow keeps it marked, parks the first step `pre-run` and sends nothing to the worker; a synced row cannot rewrite the `task`/`outputs`/`lastStepOutput` a run already here substitutes into its prompts
- `server/src/recipes.run.test.ts` — a pulled row neither lifts nor brings `permissionCeiling`
- `server/src/sessions.delete.test.ts` — a tombstone blocks `adoptSynced` from resurrecting a session; a write genuinely newer than the delete still brings it back; a remote delete for a session never held here is recorded anyway; tombstones survive a reload; a session left in `sessions.json` despite a tombstone (an older build's leftover) does not resurrect on load; pruning drops tombstones past the retention window
- `storage/src/sessions.softDelete.test.ts` — drives `sessionRows.ts` directly (not over HTTP, since `/sessions` is Clerk-gated and a test cannot mint a token): `DELETE` stamps `deletedAt` rather than removing the row; the tombstone rides the delta window; a stale push (both batch and single-row routes) does not resurrect; a write newer than the delete does; a repeated delete keeps its original stamp; deleting one session leaves a sibling untouched. **Opt-in**, same as `devices.unpair.test.ts`: needs `STORAGE_TEST_DATABASE_URL`.

## Business rules

- Storage rows are LWW upserts; a session whose `updatedAt`/`createdAt` is not newer than the last accepted push is not re-sent in a bulk push.
- A meta with neither `updatedAt` nor `createdAt` is always pushed (correct but not free).
- A single session whose own JSON exceeds the push budget is dropped from the cloud push (with a one-time warning naming its id) rather than failing the whole batch; its local copy and UI are unaffected.
- A rejected chunk's sessions are retried on the next flush, not dropped.
- A session delete is a **soft** delete in storage (`Session.deletedAt`), never a hard delete — a hard delete leaves peers nothing to adopt, so whichever machine still holds the row pushes it right back on its next sync.
- `DELETE` is idempotent: a repeat keeps the original `deletedAt` stamp rather than advancing it.
- `GET /sessions` serves tombstoned rows too, inside the normal delta window — filtering them out is exactly what breaks delete propagation.
- Both `PUT` routes refuse to resurrect a row whose `deletedAt` is at or after the pushed `updatedAt`; a write genuinely newer than the delete does bring the row back and clears the tombstone.
- The bridge keeps its own tombstone map (`id -> deletedAt` ms), persisted alongside `sessions.json` and pruned past ~30 days on load.
- `adoptSynced` now has the tombstone branch the plain LWW check never reached: a pulled session that doesn't beat an existing local tombstone is dropped, even with no local copy of the session itself.
- `applyRemoteDelete` records a tombstone even for a session this machine never held, so a slower third machine's later push can't resurrect it here either.
- **A synced session is a display artifact plus resumable history — not a work order.** `adoptSynced` never takes `queued` from a pulled row, and never lets one raise `permissionMode`; a session first seen here arrives with `bypassPermissions` clamped to `default`. The local queue survives a pull rather than being replaced by whatever the row carried.
- `permissionCeiling` is never synced: stripped from every push (on the copy sent — the live meta keeps it) and ignored on pull, so a row can neither lift a ceiling a foreign recipe run set here nor bring one.
- An embedded workflow (`workflow.def`) pulled from storage is display-only unless it is exactly the def this machine already holds for that session: otherwise it is marked and `runStep` refuses every step of it, whatever `LINES_E2EE_STRICT` says. For a run this machine holds, its own `task`/`outputs`/`lastStepOutput` stand over the row's.
- The queue flush that follows `reconcileWithWorker` is scoped by the same `ranHere` rule as the demotion loop above it. Without that scope it ran over *every* session, adopted ones included — and a synced row supplies everything `maybeFlush` asks for (non-empty `queued`, unpaused queue, idle status), so a row written into Postgres started a turn on this machine, unattended, at the next worker hello. That was a live path, not a theoretical one; `sessions.reconcile.test.ts` covers it and the test was written before the fix.
- A delete issued while pulled state is being applied, or before there's a token to send it with, is queued (`pendingDeletes`) rather than dropped, and rides the next flush/sync instead of being lost.
- A bulk push (reconnect) filters out any session whose delete is still unconfirmed, so the whole-list push can't undo a delete that raced it.
- A guest connection (see [session-collaboration](session-collaboration.md)) never sets
  `ctx.clerkToken` and never calls `syncNow()` — every push above is keyed to the *host's*
  `UserContext`, and a guest's token reaching it would push the host's sessions to Postgres under
  the guest's own account.

## Architectural rules

- `SESSIONS_PUSH_MAX_BYTES` (1.5 MB) mirrors the same headroom-under-2mb constant style as `TOTAL_MAX_BYTES` in `server/src/memory.ts`.
- Chunk sends are sequential (`await`ed) inside the debounce timer callback, not parallel, so one failure doesn't strand the rest silently.
- `pushSessions` owns the dedup filter; `userContext.ts`'s `syncNow` still calls it with the full session list — `sync.ts` keeps sole ownership of what actually goes on the wire.
- The real growth driver (`WorkflowState.outputs`/`lastStepOutput` written unbounded in `server/src/workflows.ts`) is not capped by this change — deferred as a follow-up since truncating it changes `{outputs.<name>}`/`{previous}` hand-off semantics.
- The row-level rules (LWW upsert, soft delete, resurrect guard, wire shape) live in `storage/src/sessionRows.ts` rather than inline in the `/sessions` routes, so they're unit-testable without a Clerk token — `/sessions` itself stays Clerk-gated and just calls through.
- `SessionManager`'s sessions map and tombstone map are always written together (a single `writeState`), so they can never desync on disk.
- `deleteSession` and `applyRemoteDelete` share a private `forget()` that only tears down live state that actually exists, so a remote tombstone for a session this machine never ran costs nothing.
- `flushSessions` re-checks `pendingDeletes` per chunk rather than once before the loop, because the batch was captured before the first `await` and a delete can land in the gap between chunks.

## Related decisions

- [end-to-end-encryption](end-to-end-encryption.md) — why session rows cannot yet carry a
  signature (they travel as an array, with nowhere to put one short of a per-row column — unlike
  workflows, steps and recipes, which are now signed per item), and why the field stripping and
  workflow marking above are what stand in for it

- [agent-memory-sync](agent-memory-sync.md)
- [hosted-machine-access](hosted-machine-access.md) — the relay/bridge-supersede half of the same
  underlying bug report (a stuck, undeletable session on a hosted deployment), fixed
  independently of the tombstones here.
- [storage-availability-banner](storage-availability-banner.md) — what the "cloud sync unavailable"
  banner this feature's failures can raise actually means, and why an expired token no longer
  raises it immediately.
