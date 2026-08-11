# Desktop shell

## Purpose

A menu-bar app that supervises the bridge and worker as local child processes,
so Lines can be installed and run without a repo checkout or Tilt. It owns
process lifecycle, this machine's pairing state, and the tray UI only — no
session state, no agent logic.

Hosted is the default: an installed app serves no UI of its own and exists to
run the agent locally and keep an outbound relay connection open, with the
pairing code and connection state surfaced from the menu bar. The purely local
app (own web server, own window) is now an explicit dev-only path.

The bridge and worker stay two separate children, same as under Tilt: the
worker holds every live Claude query, so a bridge crash or restart must not take
a turn with it.

## Entry points

- `desktop/src/main.ts` — the Electron main process
- `desktop/src/config.ts` — resolved URLs and local-mode switch
- `server/src/updates.ts` — the bridge-side half of update state

## Important files

- `desktop/src/main.ts` — spawn, supervise, tray, pairing, relay status
- `desktop/src/config.ts` — `loadConfig`, `isLocalMode`
- `server/src/updates.ts` — `UpdateManager`, `reportRelayStatus`
- `server/src/relayClient.ts` — `RelayClient.onStatus`, the raw open/close the
  tray's connection state is derived from
- `shared/types.ts` — `UpdateStatus`, `installUpdate`, `updateStatus`

See [desktop-packaging](desktop-packaging.md) for how `main.ts` runs as a
standalone bundle, where the Claude CLI it hands to every query comes from, and
why the app is ad-hoc signed.

## Important symbols

- `spawnChild`, `childEnv`, `loginShellPath` — child process supervision and
  environment; packaged, `spawnChild` runs the esbuild bundles under Electron's
  own node, in a checkout it runs `tsx` against `server/src` unchanged
- `RELAY_MODE` — `!isLocalMode()`; hosted unless `LINES_LOCAL_MODE=1`
- `startUiServer` / `openWindow` — local-mode only; not shipped in the DMG
- `applyRelayStatus` / `onRelayVerified` / `RELAY_SETTLE_MS` — turns the relay's
  raw open/close into "Connected" only once a link survives long enough to prove
  the pairing claim landed, since the relay accepts a socket *before* checking
  whether the device is claimed
- `refreshPairingCode` / `schedulePairingRefresh` — re-registers (idempotently)
  on a timer and on demand, so a code never needs an app restart to replace
- `claudeCliStatus` / `refreshClaudeCli` — the tray's Claude Code row and "Check
  again"; see [desktop-packaging](desktop-packaging.md)
- `CAN_SELF_INSTALL` — gates `restartForUpdate`'s real `quitAndInstall()` call
  behind a signed build existing
- `openPairingWindow` — the data-URL window showing a pairing code
- `UpdateManager.requestRestart` / `.busy` / `.current`

## Data flow

On boot the shell resolves `desktop/src/config.ts` (defaults, then a shipped
`config.json`, then `LINES_*` env overrides) and decides local vs. hosted from
`LINES_LOCAL_MODE`.

**Local mode** (dev only — set by the `dev` script): the shell spawns the
worker, then the bridge (with an IPC channel), starts a local static server for
`web/dist`, and opens a window against it. The `/__bridge` endpoint on that
server answers the same shape as the Vite dev plugin, so the web client needs
no change to run under either.

**Hosted mode** (the default, and the only path in a packaged build): the shell
loads or mints this machine's identity (`server/src/device.ts`), registers it
with the hosted storage server, and spawns the bridge with the relay URL,
storage URL, and device credential in its env. It serves no local UI — the tray
menu opens the hosted web app instead of a local window. If registration
returns a pairing code, a small `BrowserWindow` shows it as a data URL,
independent of `web/dist` even existing. The code auto-refreshes every ~14
minutes while unpaired, and "Get a new code" in the tray does the same on
demand — both rely on `registerDevice` re-issuing a code for an unclaimed device
rather than 409ing, so neither needs a restart. The bridge relays its
`RelayClient`'s raw connect/close over IPC as `relayStatus`; the shell treats a
link that survives `RELAY_SETTLE_MS` as proof the claim landed (clearing the
code, closing the pairing window, firing a native notification) and a `1008`
close as "Not paired" rather than "Connecting…".

The tray also shows this machine's `Claude Code` status (from
`claudeCliStatus()`) and a login-item toggle (`app.setLoginItemSettings`), and
enforces a single instance (`requestSingleInstanceLock`) so a second launch
cannot double-register this machine's device identity.

Update state flows bridge → shell → bridge: the shell pushes `updateStatus` over
`process.send`; `UpdateManager` folds in the live `busy` flag and broadcasts it
to the browser. A client's `installUpdate` calls `UpdateManager.requestRestart()`,
which asks the shell over the same channel — or refuses outright if any session
is active. `electron-updater` only *checks* (`autoDownload: false`); an available
update surfaces in the tray as a link to the download page rather than an
in-place install, since `CAN_SELF_INSTALL` is false until the build is signed.

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
- `restartForUpdate` never installs on an unsigned build: `CAN_SELF_INSTALL` is
  false until real code signing exists (Squirrel.Mac verifies the replacement
  app's signature, and macOS quarantine compounds it for an ad-hoc bundle), so
  it opens the download page instead of pretending to update in place.
- Device registration failing at boot (storage unreachable) is not fatal: the
  bridge's own `RelayClient` retries the relay forever, so a machine that
  registers late still comes up once storage is reachable again.
- A relay `open` alone is not proof of pairing — the relay accepts the socket
  before asking storage whether the device is claimed, and refuses with `1008`
  only after. The tray's "Connected" therefore lags the raw socket by
  `RELAY_SETTLE_MS`, and "Not paired" is a real, actionable state rather than an
  indefinite "Connecting…".
- A pairing code never requires an app restart to refresh, on a timer or on
  demand — see `refreshPairingCode` above.

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
- Device identity lives in `server/src/device.ts`, not duplicated here, so the
  shell and `npm run pair -w server` (used by Tilt) cannot drift on the
  credential format.
- `ROOT` resolves to `process.resourcesPath` when packaged, the repo root
  otherwise — the one branch that lets a dev checkout and an installed app share
  this file with no other change.

## Related decisions

- [desktop-packaging](desktop-packaging.md) — how this shell is built, signed,
  and released; where the Claude CLI it hands to every query is resolved from
- [local-port-discovery](local-port-discovery.md) — how the shell's children
  find and announce their ports
- [browser-bridge-link](browser-bridge-link.md) — `hello`'s protocol version,
  which the update flow exists to keep from drifting too far
- [device-pairing](device-pairing.md) — the identity and registration this
  shell performs in hosted mode
- [remote-relay-bridge](remote-relay-bridge.md) — what `RELAY_URL` connects to
