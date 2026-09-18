# Agent memory sync

## Purpose

Let agent memory (`~/.claude/CLAUDE.md` and per-project auto-memory under `~/.claude/projects/<slug>/memory/`) be shared and edited across a user's machines, without breaking the Claude Agent SDK's ability to read it. The SDK reads memory only from disk, so disk stays the SDK-facing cache and the storage server (Postgres) becomes the cross-machine source of truth — the same relationship the existing flat-JSON store already has for workflows/steps/sessions/settings.

## Entry points

`MemoryReviewModal` — the accept/reject gate a pulled change raises. Mounted beside the login
modal rather than inside Settings: the requirement is that the user is *notified*, so the surface
cannot sit behind a gear click.

Otherwise sync is automatic — on turn completion and on websocket connect/reconnect (`syncNow`).

## Files

- `shared/types.ts` — `MemoryFileEntry`, `MemoryFileMap`
- `storage/prisma/schema.prisma` — `AgentMemory` model
- `storage/src/index.ts` — `GET /memory`, `PUT /memory`
- `server/src/store.ts` — `MemoryManifest`, `loadMemoryManifest`/`saveMemoryManifest`
- `server/src/memory.ts` — `MemorySyncer`, `slugForPath`, `planHash`
- `server/src/store.ts` — `MemorySyncState`, `loadMemorySync`/`saveMemorySync` (staged review +
  the last rejection, kept out of the manifest file)
- `web/src/components/MemoryReviewModal.tsx` — the review UI
- `shared/types.ts` — `MemoryReview`, `MemoryReviewEntry`, the `reviewMemory` client message
- `server/src/sync.ts` — `StorageSyncClient.pushMemory`, `PulledState.memory`
- `server/src/userContext.ts` — wiring: push on turn-result, pull/push in `syncNow`

## Symbols

- `MemorySyncer.collectChanged` — mtime-diff against the manifest; returns only changed/deleted files
- `MemorySyncer.collectAll` — full snapshot for a fresh sync, size-capped
- `MemorySyncer.reviewRemote` — *stages* what a pull would write; touches no file
- `MemorySyncer.acceptReview` / `rejectReview` — the only paths that write or discard
- `slugForPath` — reproduces the Claude CLI's path→slug derivation for `~/.claude/projects/<slug>/`
- `StorageSyncClient.pushMemory` — debounced, merges pending maps rather than replacing

## Data flow

On each SDK `result` message, `MemorySyncer.collectChanged()` mtime-diffs the allowlisted files against `memory-manifest.json` and pushes only what changed (`sync.pushMemory`); this also catches hand-edits made outside a turn, for free. On websocket connect/reconnect, `syncNow` pulls `GET /memory` and hands it to `reviewRemote` (after project-key merge/learn, so slug→key resolution is as complete as possible), which computes the writes it *would* make and stages them for the user. Nothing reaches disk until they accept. It then pushes a full `collectAll()` snapshot so a fresh storage server converges to this machine's state.

Server-side, `PUT /memory` merges the incoming map into the stored blob per-file, last-write-wins by each entry's `updatedAt` (sourced from file mtime) — never a whole-blob replace, since each machine only ever sees its own disk.

Project-scoped files are keyed by a machine-independent project key (`project/<projectKey>/memory/<rel>`), resolved via the existing `ProjectKeyRegistry`; a directory with no resolvable key falls back to `slug/<slug>/memory/<rel>` (restores only at the identical absolute path on another machine).

## Tests

- `server/src/memory.review.test.ts` — a remote blob with a far-future `updatedAt` stages a
  review and touches no file; accept writes it with the timestamp clamped; reject keeps disk and
  is not re-asked for the same content; identical content is not a divergence

## Business rules

- Only two locations are synced: `~/.claude/CLAUDE.md` and `~/.claude/projects/<slug>/memory/**`. `<cwd>/CLAUDE.md`, `<cwd>/.claude/`, `~/.claude/settings.json`, and credential files are never touched.
- Per-file entry cap 256 KB; entries over the cap are skipped, not truncated.
- Client-side full-snapshot push additionally caps total payload at ~1.5 MB, dropping the largest files first (logged via a one-time warning) if the cap is exceeded.
- Server prunes tombstones older than ~30 days so the stored blob doesn't grow unbounded.
- Conflict resolution is per-file last-write-wins by mtime; a losing side's edit is silently dropped (same trade-off already accepted for settings/project-keys sync).
- **A pulled change is never written without review.** These files are read into the prompt of every session on the machine — `~/.claude/CLAUDE.md` into all of them — so applying a remote blob silently makes whoever can write that Postgres row (or whoever holds the Clerk token the bridge forwards to storage) an author of every future turn here. The pull stages a diff; `acceptReview` is the only thing that touches disk. Modelled on the guard allowlist's `reviewRemote`/`acceptReview` pair, which is an established and tested mechanism in this codebase rather than a new one.
- On accept, each entry's `updatedAt` is clamped to `now` before it is stamped onto the file. The remote timestamp is attacker-controlled, and a far-future one would otherwise win every later newer-than-local comparison — permanently.
- Identical content is not a divergence, whatever the timestamps say: a re-push from another machine must not raise a question.
- A rejection is remembered by a hash of the staged content, so "keep mine" is not re-asked on every 30-second pull — but genuinely new content asks again.
- A project's extra roots (see [multi-root-projects](multi-root-projects.md)) need
  no change here: each is just another keyed cwd with its own project-key
  namespace, resolved the same way any other checkout is.

## Architectural rules

- Reuses the existing sync stack end-to-end: `StorageSyncClient` debounce-and-push pattern, the `syncNow` pull-then-push cycle, and a Prisma singleton-per-user model — no new sync mechanism introduced.
- Push is triggered from the `SessionManager` result-sniffing callback in `userContext.ts`, not from `sessions.ts` or `worker.ts` — keeps the worker thin and sync concerns out of session/turn logic.
- `MemorySyncer` takes an injectable `claudeDir` constructor argument so a scratch directory can stand in for `~/.claude` in future tests.
- The path→slug derivation (`slugForPath`) and the `~/.claude/projects/<slug>/memory/` layout are Claude CLI/SDK-internal details, not a published contract — re-verify on SDK upgrades.
- Like every other route on this client, a failed push/pull here feeds [storage-availability-banner](storage-availability-banner.md): the failure is classified, logged, and — for an expired-token 401 — held for a grace window before it raises the "cloud sync unavailable" banner at all, since a backgrounded browser tab throttling its auth-relay timer otherwise looks identical to a real outage.

## Related decisions

- [end-to-end-encryption](end-to-end-encryption.md) — why the review gate exists, and why memory
  cannot yet carry a signature (the endpoint merges a map per key in SQL, so there is nowhere to
  put one without a per-row column)
- [permissions-and-plan-mode](permissions-and-plan-mode.md) — the guard allowlist review this
  copies
- [multi-root-projects](multi-root-projects.md)
- [storage-availability-banner](storage-availability-banner.md)
