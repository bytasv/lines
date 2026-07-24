# App data root

## Purpose

Defines the machine-global directory that holds all server-side app state — per-user stores (sessions, transcripts, workflows, auth, settings) and machine-wide assets (vendored plugins) — and carries existing installs across the `claude-ui` → `lines` rename.

## Entry points

- `server/src/store.ts` (`APP_ROOT` constant, legacy-directory adoption on module load)

## Important files

- `server/src/store.ts` — root constant, one-time legacy migration, `userStoreRoot`, `createStore`
- `server/src/index.ts` — picks the flat root for the implicit `local` user vs `userStoreRoot(userId)` for real users
- `server/src/caveman.ts` — vendored plugin checkout stored directly under the root (machine-wide, shared by all users)

## Important symbols

- `APP_ROOT` — `~/.lines-app`, the machine-global app root
- `userStoreRoot(userId)` — `~/.lines-app/users/{userId}`, one flat-JSON store per user
- `createStore(root)` — flat-JSON persistence rooted at the given directory

## Data flow

First import of `store.ts` → if `~/.lines-app` is missing and legacy `~/.claude-ui` exists, the legacy directory is renamed to `~/.lines-app` (one-time adoption) → `index.ts` resolves each user's store root (`APP_ROOT` for `local`, `userStoreRoot(userId)` otherwise) → `createStore` reads/writes flat JSON files under that root.

## Dependencies

None.

## Tests

None. No test infrastructure covers the store layer at time of writing.

## Business rules

- The app data root is `~/.lines-app`.
- One-time migration: an existing `~/.claude-ui` directory is adopted (renamed) as `~/.lines-app` when the new root does not exist yet, so installs keep sessions, auth, and settings across the rename. If both directories exist, the legacy one is left untouched.
- The `local` user uses the flat root directly (legacy single-tenant layout); real user ids live under `~/.lines-app/users/{id}`.
- Machine-wide assets (vendored plugins) live directly under the root and are shared across users.

## Architectural rules

- All persistent paths must derive from `APP_ROOT` / `userStoreRoot`; never hardcode the home-directory path elsewhere.

## Related decisions

None.
