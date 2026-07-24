# App data root

## Purpose

Defines the machine-global directory that holds all server-side app state — per-user stores (sessions, transcripts, workflows, auth, settings) and machine-wide assets (vendored plugins).

## Entry points

- `server/src/store.ts` (`APP_ROOT` constant)

## Important files

- `server/src/store.ts` — root constant, `userStoreRoot`, `createStore`
- `server/src/index.ts` — picks the flat root for the implicit `local` user vs `userStoreRoot(userId)` for real users
- `server/src/caveman.ts` — vendored plugin checkout stored directly under the root (machine-wide, shared by all users)

## Important symbols

- `APP_ROOT` — `~/.lines-app`, the machine-global app root
- `userStoreRoot(userId)` — `~/.lines-app/users/{userId}`, one flat-JSON store per user
- `createStore(root)` — flat-JSON persistence rooted at the given directory

## Data flow

`index.ts` resolves each user's store root (`APP_ROOT` for `local`, `userStoreRoot(userId)` otherwise) → `createStore` reads/writes flat JSON files under that root.

## Dependencies

None.

## Tests

None. No test infrastructure covers the store layer at time of writing.

## Business rules

- The app data root is `~/.lines-app`.
- The `local` user uses the flat root directly (legacy single-tenant layout); real user ids live under `~/.lines-app/users/{id}`.
- Machine-wide assets (vendored plugins) live directly under the root and are shared across users.

## Architectural rules

- All persistent paths must derive from `APP_ROOT` / `userStoreRoot`; never hardcode the home-directory path elsewhere.

## Related decisions

None.
