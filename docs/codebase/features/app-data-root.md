# App data root

## Purpose

Defines the machine-global directory that holds all server-side app state — per-user stores (sessions, transcripts, workflows, auth, settings).

## Entry points

- `server/src/store.ts` (`APP_ROOT` constant)

## Important files

- `server/src/store.ts` — root constant, `userStoreRoot`, `createStore`
- `server/src/index.ts` — picks the flat root for the implicit `local` user vs `userStoreRoot(userId)` for real users

## Important symbols

- `APP_ROOT` — `~/.lines-app`, the machine-global app root
- `userStoreRoot(userId)` — `~/.lines-app/users/{userId}`, one flat-JSON store per user
- `createStore(root)` — flat-JSON persistence rooted at the given directory
- `loadTranscriptRaw(sessionId)` — cached, unparsed JSONL lines for a transcript; used to build the wire frame without a parse/stringify round-trip
- `loadTranscript(sessionId)` — cached parsed events, lazily built from the same cache entry
- `loadProjects()`/`saveProjects()` — `projects.json`, sanitized to `Project[]` on
  every read (see [multi-root-projects](multi-root-projects.md))
- `server/src/worktrees.ts` — `WORKTREE_ROOT` (`~/.lines-app/worktrees`), where a
  Lines-managed git worktree's directory lives by default; see [git-worktrees](git-worktrees.md)

## Data flow

`index.ts` resolves each user's store root (`APP_ROOT` for `local`, `userStoreRoot(userId)` otherwise) → `createStore` reads/writes flat JSON files under that root.

## Dependencies

None.

## Tests

- `server/src/store.test.ts` — transcript cache hit/miss on mtime+size, cache extension on append, LRU eviction, torn-trailing-line tolerance, compact `sessions.json` write.

## Business rules

- The app data root is `~/.lines-app`.
- The `local` user uses the flat root directly (legacy single-tenant layout); real user ids live under `~/.lines-app/users/{id}`.
- No machine-wide asset lives under the root any more: response compression (see
  [turn-recovery](turn-recovery.md)) is a vendored constant in `server/src/caveman.ts`,
  not a runtime checkout. `~/.lines-app/plugins/` may still exist on a machine that ran
  an older build that git-cloned a plugin there; it is a legacy directory nothing
  reads or writes, left in place rather than deleted on upgrade.
- A git worktree Lines creates for a session or on request defaults to
  `~/.lines-app/worktrees/<repo>/<slug>` — app state, not a folder under the user's
  own checkout — grouped by repo name so two projects can reuse the same branch name.

## Architectural rules

- All persistent paths must derive from `APP_ROOT` / `userStoreRoot`; never hardcode the home-directory path elsewhere.
- `createStore` keeps an in-memory, per-user transcript cache (raw lines + lazily-parsed events), revalidated by `statSync` mtime/size and bounded by count and byte size (LRU eviction). It assumes this process is the sole writer of `transcripts/*.jsonl`; a second writer would go stale silently between stat checks.
- The sole-writer assumption is enforced, not just assumed: `~/.lines-app/bridge.lock` (`server/src/index.ts`) is claimed by every bridge unconditionally — relaying or not — so a second bridge process refuses to start rather than becoming that second writer. See [hosted-machine-access](hosted-machine-access.md#one-bridge-speaks-at-a-time) for the claim/preempt/refuse rules; `LINES_ALLOW_MULTIPLE_BRIDGES=1` is the documented way to run two anyway.
- `sessions.json` writes are not pretty-printed and are debounced (see `SessionManager.persist`/`flushPersist` in `server/src/sessions.ts`) — a status-transition burst coalesces into one write instead of one synchronous whole-file rewrite per transition. Broadcasts still fire immediately; only the disk write is delayed.
- `projects.json` migrates once at store construction, mirroring `GuardAllowlist`'s
  constructor migration: the pre-multi-root `string[]` form (or any junk an older
  build wrote) is sanitized to `Project[]` and rewritten only when the sanitized
  form actually differs, so a second `createStore` on an already-migrated file
  leaves its bytes untouched. `loadProjects()` itself never writes — only the
  one-shot migration does.

## Related decisions

- [multi-root-projects](multi-root-projects.md)
- [hosted-machine-access](hosted-machine-access.md) — `bridge.lock`, the mechanism enforcing the
  sole-writer rule above
- [git-worktrees](git-worktrees.md) — `WORKTREE_ROOT`
