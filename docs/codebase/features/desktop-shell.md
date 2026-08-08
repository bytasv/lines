# Desktop shell

## Purpose

A menu-bar app that supervises the bridge and worker as local child processes
and serves the web UI, so Lines can be installed rather than run from a terminal
via Tilt. It owns process lifecycle only — no session state, no agent logic.

The bridge and worker stay two separate children, same as under Tilt: the
worker holds every live Claude query, so a bridge crash or restart must not take
a turn with it.

## Entry points

- `desktop/src/main.ts` — the Electron main process
- `server/src/updates.ts` — the bridge-side half of update state

## Important files

- `desktop/src/main.ts` — spawn, supervise, serve the UI, tray
- `server/src/updates.ts` — `UpdateManager`
- `shared/types.ts` — `UpdateStatus`, `installUpdate`, `updateStatus`

## Important symbols

- `spawnChild`, `childEnv`, `loginShellPath` — child process supervision and
  environment
- `startUiServer` — serves `web/dist` plus `/__bridge`
- `UpdateManager.requestRestart` / `.busy` / `.current`

## Data flow

On boot the shell spawns the worker, then the bridge (with an IPC channel),
starts a local static server for `web/dist`, and opens a window against it. The
`/__bridge` endpoint on that server answers the same shape as the Vite dev
plugin, so the web client needs no change to run under either.

Update state flows bridge → shell → bridge: the shell pushes `updateStatus` over
`process.send`; `UpdateManager` folds in the live `busy` flag and broadcasts it
to the browser. A client's `installUpdate` calls `UpdateManager.requestRestart()`,
which asks the shell over the same channel — or refuses outright if any session
is active.

## Dependencies

`UpdateManager` needs nothing from the shell to exist: `supervised` is false
whenever `process.send` is absent, which is every Tilt and `npm run dev` run.

## Tests

- `server/src/updates.test.ts` — restart refusal while a session is active or
  waiting on the user; complete inertness with no supervisor; the shell's status
  broadcast

## Business rules

- A restart is refused while any session is `running`, `waiting-permission`, or
  `waiting-approval` — a restart always kills bridge and worker together, and an
  atomic update means there is no bridge-only hot-patch path yet.
- Closing the window does not quit the app; that is the point of a menu-bar app,
  and it must not kill an in-flight turn.
- The bridge's actual install/restart mechanism (`restartForUpdate` in
  `desktop/src/main.ts`) is a deliberate no-op today: `electron-updater`'s
  install step needs a signed, notarized build, which does not exist yet. It is
  left obviously inert rather than faked.

## Architectural rules

- A GUI-launched macOS app inherits a minimal PATH (no Homebrew, often no `git`
  or `rg`). `loginShellPath()` resolves the login shell's PATH once and hands it
  to both children; without it the agent's shell-outs silently fail only when
  launched from the dock.
- Inside Electron, `process.execPath` is the Electron binary, not node —
  children are spawned with `ELECTRON_RUN_AS_NODE=1` so they run as plain node
  instead of relaunching the app.
- The worker is never auto-restarted on crash: its live queries are gone, and a
  silent respawn would look like a healthy session that lost its turn. The
  bridge is restarted freely, matching Tilt's own asymmetry between the two.
- The desktop app and Tilt both read the same `LINES_INSTANCE`/port-discovery
  contract (see [local-port-discovery](local-port-discovery.md)), so a dev
  checkout and an installed app never collide.

## Related decisions

- [local-port-discovery](local-port-discovery.md) — how the shell's children
  find and announce their ports
- [browser-bridge-link](browser-bridge-link.md) — `hello`'s protocol version,
  which the update flow exists to keep from drifting too far
