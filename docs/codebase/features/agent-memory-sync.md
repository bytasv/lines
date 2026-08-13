# Agent memory sync

## Purpose

Let agent memory (`~/.claude/CLAUDE.md` and per-project auto-memory under `~/.claude/projects/<slug>/memory/`) be shared and edited across a user's machines, without breaking the Claude Agent SDK's ability to read it. The SDK reads memory only from disk, so disk stays the SDK-facing cache and the storage server (Postgres) becomes the cross-machine source of truth — the same relationship the existing flat-JSON store already has for workflows/steps/sessions/settings.

## Entry points

None UI-facing in this stage — sync only. Fires automatically on turn completion and on websocket connect/reconnect (`syncNow`).

## Files

- `shared/types.ts` — `MemoryFileEntry`, `MemoryFileMap`
- `storage/prisma/schema.prisma` — `AgentMemory` model
- `storage/src/index.ts` — `GET /memory`, `PUT /memory`
- `server/src/store.ts` — `MemoryManifest`, `loadMemoryManifest`/`saveMemoryManifest`
- `server/src/memory.ts` — `MemorySyncer`, `slugForPath`
- `server/src/sync.ts` — `StorageSyncClient.pushMemory`, `PulledState.memory`
- `server/src/userContext.ts` — wiring: push on turn-result, pull/push in `syncNow`

## Symbols

- `MemorySyncer.collectChanged` — mtime-diff against the manifest; returns only changed/deleted files
- `MemorySyncer.collectAll` — full snapshot for a fresh sync, size-capped
- `MemorySyncer.applyRemote` — writes newer remote files / deletes on newer tombstones
- `slugForPath` — reproduces the Claude CLI's path→slug derivation for `~/.claude/projects/<slug>/`
- `StorageSyncClient.pushMemory` — debounced, merges pending maps rather than replacing

## Data flow

On each SDK `result` message, `MemorySyncer.collectChanged()` mtime-diffs the allowlisted files against `memory-manifest.json` and pushes only what changed (`sync.pushMemory`); this also catches hand-edits made outside a turn, for free. On websocket connect/reconnect, `syncNow` pulls `GET /memory`, applies it via `applyRemote` (after project-key merge/learn, so slug→key resolution is as complete as possible), then pushes a full `collectAll()` snapshot so a fresh storage server converges to this machine's state.

Server-side, `PUT /memory` merges the incoming map into the stored blob per-file, last-write-wins by each entry's `updatedAt` (sourced from file mtime) — never a whole-blob replace, since each machine only ever sees its own disk.

Project-scoped files are keyed by a machine-independent project key (`project/<projectKey>/memory/<rel>`), resolved via the existing `ProjectKeyRegistry`; a directory with no resolvable key falls back to `slug/<slug>/memory/<rel>` (restores only at the identical absolute path on another machine).

## Tests

None (repo has typecheck only, no test runner configured).

## Business rules

- Only two locations are synced: `~/.claude/CLAUDE.md` and `~/.claude/projects/<slug>/memory/**`. `<cwd>/CLAUDE.md`, `<cwd>/.claude/`, `~/.claude/settings.json`, and credential files are never touched.
- Per-file entry cap 256 KB; entries over the cap are skipped, not truncated.
- Client-side full-snapshot push additionally caps total payload at ~1.5 MB, dropping the largest files first (logged via a one-time warning) if the cap is exceeded.
- Server prunes tombstones older than ~30 days so the stored blob doesn't grow unbounded.
- Conflict resolution is per-file last-write-wins by mtime; a losing side's edit is silently dropped (same trade-off already accepted for settings/project-keys sync).
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

- [multi-root-projects](multi-root-projects.md)
- [storage-availability-banner](storage-availability-banner.md)
