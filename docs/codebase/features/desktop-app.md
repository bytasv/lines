# Desktop app

Covers: `desktop-shell`, `desktop-packaging`.

## Purpose

A menu-bar app that supervises the bridge and worker as local child processes, so Lines can be
installed and run without a repo checkout or Tilt — and the packaging that turns it into a `.dmg`
a non-developer installs from the hosted app.

The shell owns process lifecycle, this machine's pairing state, and the tray UI only — no session
state, no agent logic. Hosted is the default: an installed app serves no UI of its own and exists
to run the agent locally and keep an outbound relay connection open, with the pairing code and
connection state surfaced from the menu bar. The purely local app (own web server, own window) is
an explicit dev-only path.

The bridge and worker stay two separate children, same as under Tilt: the worker holds every live
Claude query, so a bridge crash or restart must not take a turn with it.

Packaging adds the ability to run **away from a repo checkout** — no `tsx`, no repo-root `.env`,
no `node_modules`. Three decisions shape it, each a recorded trade: the build is ad-hoc signed
(no Apple Developer ID), the Claude Code CLI is *not* bundled, and the agent SDK is shipped
unbundled next to the code.

## Entry points

- `desktop/src/main.ts` — the Electron main process
- `desktop/src/config.ts` — resolved URLs and local-mode switch
- `server/src/updates.ts` — the bridge-side half of update state
- `desktop/scripts/build.mjs` — the three esbuild bundles, the pruned SDK tree, `config.json`
- `desktop/scripts/afterPack.mjs` — ad-hoc signs the packed bundle
- `desktop/scripts/release.mjs` — uploads artifacts to the public R2 bucket
- `desktop/package.json` — the `build` block (electron-builder config) and `package`/`release`
  scripts

## Files

- `desktop/src/main.ts` — spawn, supervise, tray, pairing, relay status
- `desktop/src/config.ts` — `loadConfig`, `isLocalMode`; reads `Resources/config.json`, env vars
  override
- `server/src/updates.ts` — `UpdateManager`, `reportRelayStatus`
- `server/src/relayClient.ts` — `RelayClient.onStatus`, the raw open/close the tray's connection
  state is derived from
- `shared/types.ts` — `UpdateStatus`, `installUpdate`, `updateStatus`
- `server/src/claudeCli.ts` — finds the machine's `claude`, with a version floor
- `desktop/assets/` — `trayTemplate.png` (+`@2x`), `icon.icns`, `icon.png`
- `deploy/README.md` — the release procedure and the two-bucket rule

## Symbols

- `spawnChild`, `childEnv`, `loginShellPath` — child process supervision and environment;
  packaged, `spawnChild` runs the esbuild bundles under Electron's own node, in a checkout it
  runs `tsx` against `server/src` unchanged
- `RELAY_MODE` — `!isLocalMode()`; hosted unless `LINES_LOCAL_MODE=1`
- `startUiServer` / `openWindow` — local-mode only; not shipped in the DMG
- `applyRelayStatus` / `onRelayVerified` / `RELAY_SETTLE_MS` — turns the relay's raw open/close
  into "Connected" only once a link survives long enough to prove the pairing claim landed, since
  the relay accepts a socket *before* checking whether the device is claimed
- `refreshPairingCode` / `schedulePairingRefresh` — re-registers (idempotently) on a timer and on
  demand, so a code never needs an app restart to replace
- `claudeCliStatus` / `refreshClaudeCli` — cached discovery; the tray's Claude Code row and
  "Check again" refreshes it
- `claudeCliRefusalMessage()` — the sentence a hosted user sees when the CLI is missing or old
- `MIN_CLAUDE_VERSION` (`claudeCli.ts`) — the CLI version the pinned SDK wrapper ships
- `CAN_SELF_INSTALL` — gates `restartForUpdate`'s real `quitAndInstall()` call behind a signed
  build existing; false until a Developer ID exists
- `openPairingWindow` — the data-URL window showing a pairing code
- `UpdateManager.requestRestart` / `.busy` / `.current`
- `loadConfig()` / `isLocalMode()` (`desktop/src/config.ts`)

## Data flow

### Boot and modes

On boot the shell resolves `desktop/src/config.ts` (defaults, then a shipped `config.json`, then
`LINES_*` env overrides) and decides local vs. hosted from `LINES_LOCAL_MODE`.

**Local mode** (dev only — set by the `dev` script): the shell spawns the worker, then the bridge
(with an IPC channel), starts a local static server for `web/dist`, and opens a window against
it. The `/__bridge` endpoint on that server answers the same shape as the Vite dev plugin, so the
web client needs no change to run under either.

**Hosted mode** (the default, and the only path in a packaged build): the shell loads or mints
this machine's identity (`server/src/device.ts`), registers it with the hosted storage server, and
spawns the bridge with the relay URL, storage URL, and device credential in its env. It serves no
local UI — the tray menu opens the hosted web app instead of a local window. If registration
returns a pairing code, a small `BrowserWindow` shows it as a data URL, independent of `web/dist`
even existing. The code auto-refreshes every ~14 minutes while unpaired, and "Get a new code" in
the tray does the same on demand — both rely on `registerDevice` re-issuing a code for an
unclaimed device rather than 409ing, so neither needs a restart. The bridge relays its
`RelayClient`'s raw connect/close over IPC as `relayStatus`; the shell treats a link that survives
`RELAY_SETTLE_MS` as proof the claim landed (clearing the code, closing the pairing window, firing
a native notification) and a `1008` close as "Not paired" rather than "Connecting…".

The tray also shows this machine's `Claude Code` status (from `claudeCliStatus()`) and a
login-item toggle (`app.setLoginItemSettings`), and enforces a single instance
(`requestSingleInstanceLock`) so a second launch cannot double-register this machine's device
identity.

### Updates

Update state flows bridge → shell → bridge: the shell pushes `updateStatus` over `process.send`;
`UpdateManager` folds in the live `busy` flag and broadcasts it to the browser. A client's
`installUpdate` calls `UpdateManager.requestRestart()`, which asks the shell over the same channel
— or refuses outright if any session is active. `electron-updater` only *checks*
(`autoDownload: false`); an available update surfaces in the tray as a link to the download page
rather than an in-place install, since `CAN_SELF_INSTALL` is false until the build is signed.

### Packaging

`npm run package -w desktop` runs `build.mjs`, then electron-builder.

`build.mjs` emits `dist/main.cjs` (CJS, the Electron main process) plus `dist/server/bridge.mjs`
and `dist/server/worker.mjs` (ESM). It copies `@anthropic-ai/claude-agent-sdk` and its dependency
walk into `dist/server/node_modules`, and writes `dist/config.json` from any `LINES_*` env vars
set at build time.

electron-builder packs `dist/main.cjs` into the asar, copies `dist/server`, `dist/config.json`
and the tray assets to `Resources/`, runs `afterPack.mjs`, then builds the DMG and the zip.

At runtime `main.ts` resolves `ROOT` to `process.resourcesPath` when packaged (the repo root
otherwise) and spawns `Resources/server/{bridge,worker}.mjs` with Electron's own node via
`ELECTRON_RUN_AS_NODE=1`. Every `query()` is handed `pathToClaudeCodeExecutable` from
`claudeCliStatus()`.

## Dependencies

- `UpdateManager` needs nothing from the shell to exist: `supervised` is false whenever
  `process.send` is absent, which is every Tilt and `npm run dev` run.
- `electron-builder` (DMG/zip, `latest-mac.yml`), `electron-updater` (checks only).
- `esbuild` — already used for the shell bundle.
- The R2 credentials that `storage/src/r2.ts` uses, plus a second bucket.

## Tests

- `server/src/updates.test.ts` — restart refusal while a session is active or waiting on the
  user; complete inertness with no supervisor; the shell's status broadcast.
- `server/src/claudeCli.test.ts` — discovery order, the exclusive env override, `--version`
  parsing against real executables, the version floor.
- `server/src/sessions.claudeCli.test.ts` — a push carries `pathToClaudeCodeExecutable`; a
  missing CLI refuses the turn with the install message.
- No harness covers the packaging scripts or the shell itself — verified by building and
  installing.

## Business rules

- A restart is refused while any session is `running`, `waiting-permission`, or
  `waiting-approval` — a restart always kills bridge and worker together, and an atomic update
  means there is no bridge-only hot-patch path yet.
- Closing the window does not quit the app; that is the point of a menu-bar app, and it must not
  kill an in-flight turn.
- `restartForUpdate` never installs on an unsigned build: `CAN_SELF_INSTALL` is false until real
  code signing exists (Squirrel.Mac verifies the replacement app's signature, and macOS
  quarantine compounds it for an ad-hoc bundle), so it opens the download page instead of
  pretending to update in place.
- Device registration failing at boot (storage unreachable) is not fatal: the bridge's own
  `RelayClient` retries the relay forever, so a machine that registers late still comes up once
  storage is reachable again.
- A relay `open` alone is not proof of pairing — the relay accepts the socket before asking
  storage whether the device is claimed, and refuses with `1008` only after. The tray's
  "Connected" therefore lags the raw socket by `RELAY_SETTLE_MS`, and "Not paired" is a real,
  actionable state rather than an indefinite "Connecting…".
- A pairing code never requires an app restart to refresh, on a timer or on demand.
- **Hosted is the default.** Local mode (own web server, own window) needs `LINES_LOCAL_MODE=1`,
  which the `dev` script sets. `web/dist` is not in the DMG.
- A missing or too-old CLI refuses the turn with an actionable sentence, in the browser and in
  the tray — never a raw SDK error.
- `LINES_CLAUDE_PATH` is exclusive: set it, and no other location is tried.
- Update checks only notify. The tray links the download page.

## Architectural rules

- A GUI-launched macOS app inherits a minimal PATH (no Homebrew, often no `git` or `rg`).
  `loginShellPath()` resolves the login shell's PATH once and hands it to both children; without
  it the agent's shell-outs silently fail only when launched from the dock.
- Inside Electron, `process.execPath` is the Electron binary, not node — children are spawned
  with `ELECTRON_RUN_AS_NODE=1` so they run as plain node instead of relaunching the app.
- The worker is never auto-restarted on crash: its live queries are gone, and a silent respawn
  would look like a healthy session that lost its turn. The bridge is restarted freely, matching
  Tilt's own asymmetry between the two.
- The desktop app and Tilt both read the same `LINES_INSTANCE`/port-discovery contract (see
  [hosted-machine-access](hosted-machine-access.md)), so a dev checkout and an installed app never
  collide.
- Device identity lives in `server/src/device.ts`, not duplicated here, so the shell and
  `npm run pair -w server` (used by Tilt) cannot drift on the credential format.
- `ROOT` resolves to `process.resourcesPath` when packaged, the repo root otherwise — the one
  branch that lets a dev checkout and an installed app share this file with no other change.
- **`identity: null` does not ad-hoc sign.** electron-builder skips bundle signing entirely
  (`skipped macOS code signing`). What remains is the linker's ad-hoc signature on the Mach-O,
  which declares sealed resources while nothing seals them — no
  `Contents/_CodeSignature/CodeResources`. macOS calls that **"Lines is damaged and can't be
  opened"**, and unlike the unidentified-developer case it offers *no* Open Anyway button, so the
  download is a dead end by every route. `afterPack.mjs` exists solely to seal the bundle, and it
  verifies afterwards so a broken bundle fails the build. This shipped once; the verify step is
  why it cannot again.
- **The agent SDK stays external to the bundle.** `sdk.mjs` resolves through
  `createRequire(import.meta.url)`; bundling it moves that anchor into our output and breaks it.
  It ships as a real package under `Resources/server/node_modules/`.
- **The SDK's `-darwin-arm64` platform package is deliberately deleted** — 231 MB of `claude`
  binary. Every query passes `pathToClaudeCodeExecutable`, so the SDK's own resolver never runs.
  That omission is the difference between a ~96 MB DMG and a ~330 MB one.
- **The server bundles must be ESM.** `server` and `shared` are both `"type": "module"` and use
  `import.meta.dirname`, which is `undefined` under CJS and throws at import time.
- **The version floor is ours or nobody's.** The SDK performs no version handshake at all: it
  never runs `--version`, never reads `claude_code_version` off the init message, and an unknown
  flag surfaces only as `Claude Code process exited with code 1`.
- **A packaged app must boot with an empty environment.** `server/src/index.ts` existence-checks
  both `.env` paths and falls back to a build-time version constant.
- **Releases go to their own public bucket.** Public-read is a bucket-level setting, so sharing
  the recipe-image bucket would publish user uploads in order to publish an installer.

## Related decisions

- Ad-hoc signing is the whole remaining UX cost: a browser download is quarantined and Gatekeeper
  blocks it until the user allows it in Privacy & Security. A Developer ID ($99/yr) is the only
  fix. When one exists: set a real `mac.identity`, delete `afterPack.mjs`, and flip
  `CAN_SELF_INSTALL` — Squirrel.Mac verifies the replacement app's signature, which is why
  self-install is inert today rather than pretending to work.
- Requiring an installed Claude Code trades 231 MB for an install step. If that proves too much
  friction, shipping the platform binary becomes a build flag, not a rewrite — the
  `pathToClaudeCodeExecutable` indirection is the seam.
- `electron` is pinned exact in `devDependencies`: electron-builder cannot compute the version
  from a range when the module is hoisted out of the workspace.
- arm64 only for now. Adding `x64`/universal is a one-line `mac.target` change.
- A dev checkout and the installed app share `~/.lines-app/device.json`, so the same device
  identity can be claimed by whichever registers last.
- [hosted-machine-access](hosted-machine-access.md) — how the shell's children find and announce
  their ports, the identity and registration it performs in hosted mode, what `RELAY_URL`
  connects to, and `hello`'s protocol version, which the update flow exists to keep from drifting
  too far.
- [production-deployment](production-deployment.md) — the hosted side the installed app talks to.
