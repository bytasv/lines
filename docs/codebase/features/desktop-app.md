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
- `desktop/scripts/release.mjs` — uploads artifacts to the public R2 bucket, plus the stable
  download alias
- `desktop/scripts/ship.mjs` — the one-command release: version guard, clean build, publish
- `desktop/scripts/check-unreleased.mjs` — refuses to publish a version already at the edge
- `.github/workflows/release-desktop.yml` — `workflow_dispatch` that runs `ship.mjs` on a
  GitHub-hosted mac runner
- `desktop/package.json` — the `build` block (electron-builder config) and `package`/`release`/`ship`
  scripts

## Files

- `desktop/src/main.ts` — spawn, supervise, tray, pairing, un-pairing, relay status
- `desktop/src/config.ts` — `loadConfig`, `isLocalMode`; reads `Resources/config.json`, env vars
  override
- `server/src/updates.ts` — `UpdateManager`, `reportRelayStatus`
- `server/src/relayClient.ts` — `RelayClient.onStatus`, the raw open/close the tray's connection
  state is derived from
- `shared/types.ts` — `UpdateStatus`, `installUpdate`, `updateStatus`
- `server/src/claudeCli.ts` — finds the machine's `claude`, with a version floor
- `desktop/assets/` — `trayTemplate.png` (+`@2x`), `icon.icns`, `icon.png`
- `desktop/scripts/ship.mjs` — orchestrates `check-unreleased.mjs`, `package`, `release` behind one
  command, local or CI
- `desktop/scripts/check-unreleased.mjs` — compares `desktop/package.json`'s version against the
  published `latest-mac.yml`
- `.github/workflows/release-desktop.yml` — the manual dispatch job; a cheap ubuntu `guard` job
  ahead of the mac `release` job
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
- `foreignBridgeLock()` — reads `~/.lines-app/bridge.lock`; null unless it names a different,
  still-live pid (absent, corrupt, dead, or naming our own bridge are all "no collision")
- `enterStandDown(holder)` — kills the tray's own bridge reference, flips the tray to "Paused",
  and arms the ~5s recheck that re-spawns both children once the lock clears
- `standDown` — `{ pid, instance } | null`; set exactly while another bridge owns this machine
- `EXIT_BRIDGE_LOCK_HELD` (`78`) — duplicated from `server/src/index.ts` rather than imported,
  the same precedent as `APP_ROOT` above it

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
spawns the bridge with the relay URL, storage URL, and device credential in its env. The bridge
itself takes this machine's single-instance lock (`~/.lines-app/bridge.lock`, `instance: 'desktop'`)
unconditionally, before it ever dials the relay — see
[hosted-machine-access](hosted-machine-access.md#one-bridge-speaks-at-a-time). A respawn racing a
not-yet-exited previous bridge child, or a bridge started by hand alongside the packaged app, now
exits immediately (`EXIT_BRIDGE_LOCK_HELD`, `78`) naming the pid already holding the lock, rather
than silently becoming a second `RelayClient` claiming the same device. It serves no
local UI — the tray menu opens the hosted web app instead of a local window. If registration
returns a pairing code, a small `BrowserWindow` shows it as a data URL, independent of `web/dist`
even existing. The code auto-refreshes every ~14 minutes while unpaired, and "Get a new code" in
the tray does the same on demand — both rely on `registerDevice` re-issuing a code for an
unclaimed device rather than 409ing, so neither needs a restart. The bridge relays its
`RelayClient`'s raw connect/close over IPC as `relayStatus`; the shell treats a link that survives
`RELAY_SETTLE_MS` as proof the claim landed (clearing the code, closing the pairing window, firing
a native notification) and a `1008` close as "Not paired" rather than "Connecting…".

A `1008` with no code in hand now also *acts*: the shell re-registers on its own (debounced by
`AUTO_REGISTER_MIN_MS`) and pops the pairing window with a fresh code. That is what closes the loop
after the owner unpairs the machine from the browser — storage only refuses to re-issue a code for
a *claimed* row, so registering again after a revoke succeeds. Before this the tray simply read
"Not paired" and offered nothing, because both pairing items are hidden while `pairingCode` is
null.

When paired, the tray offers `Unpair this machine…` instead: a `dialog.showMessageBox` confirm
(it kicks the owner's browser session off this machine), then `unpairDevice()` and an immediate
re-register, so the fresh code is on screen at once. This is the lockout-proof path — it needs no
browser at all, which matters because the web app's own escape hatch lives behind the gate that is
stuck, and "Get a new code" cannot help while the device is still claimed. Nothing here restarts
the bridge or the worker: the link converges on its own once the relay's re-verify sees the revoked
row.

The tray also shows this machine's `Claude Code` status (from `claudeCliStatus()`) and a
login-item toggle (`app.setLoginItemSettings`), and enforces a single instance
(`requestSingleInstanceLock`) so a second launch cannot double-register this machine's device
identity.

### Standing down

The tray is the one supervisor the bridge lock is allowed to preempt — see
[hosted-machine-access](hosted-machine-access.md#one-bridge-speaks-at-a-time) — so `main.ts`
mirrors the collision from its side rather than treating it as a crash.

Three entry points reach `enterStandDown`, all landing in the same `standDown` state:

- **Startup** (`start()`): `foreignBridgeLock()` is checked before either child spawns. If it
  names a live foreign pid, neither the worker nor the bridge is started at all — a worker of
  ours would only add a second writer to the same `~/.lines-app` the other bridge already owns.
- **Our bridge refused** (`spawnChild`'s exit handler, `code === EXIT_BRIDGE_LOCK_HELD`): the
  ordinary case, when a dev bridge started after ours.
- **Our bridge was preempted**: the dev bridge `SIGTERM`s ours, so the exit handler sees
  `code === null` with no matching lock-held exit code — the tell here is a re-read of the lock
  file showing a live foreign holder.

While standing down: `bridge` is cleared, `applyRelayStatus({connected: false})` runs so the tray
never claims a link that does not exist, and the tray's status line and its `Bridge:` menu item
both read "Paused — another bridge owns this machine (pid N)". A ~5s recheck
(`STAND_DOWN_RECHECK_MS`) polls `foreignBridgeLock()`; once it clears, both children spawn again
(the worker only if it isn't already alive — see the note on the restart asymmetry below).

**The worker is never touched by any of this.** Only the bridge collides on the lock and on the
relay device identity; a worker holding a live turn must not be treated as part of the collision.
This is the same asymmetry `spawnChild`'s restart logic already has for an ordinary crash: a dead
worker is deliberately not respawned, because its queries are gone and a silent respawn would look
like a healthy session that lost its turn.

No desktop test harness exists in this repo (see Tests below); the stand-down path (both
directions — Tilt already up when the tray launches, and the tray already running when `tilt up`
starts) is verified manually.

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

### Releasing

`npm run ship -w desktop` is the one command for the whole release, local or CI — the same entry
point either way, so the two never drift into two procedures. It: runs `check-unreleased.mjs`
(skippable with `--force`), clears `desktop/release/`, runs `package`, then runs `release` (skippable
with `--dry-run`). Both `LINES_UPDATE_FEED_URL` and `LINES_DOWNLOAD_URL` are derived from
`R2_RELEASE_PUBLIC_BASE_URL` rather than hand-set, so a build-time URL cannot be typed wrong without
also breaking the derivation everywhere else.

`check-unreleased.mjs` fetches the published `latest-mac.yml`, compares its `version:` line against
`desktop/package.json`, and exits 1 on a match — the version bump is still a manual edit
(`desktop/package.json` + a `chore(desktop): release X` commit); this only catches forgetting it. A
missing feed (first release, or an unreachable base URL) is treated as "proceed".

`release.mjs` uploads the versioned artifacts, then re-uploads the DMG a second time under a fixed
key (`desktop/Lines-latest.dmg`, `Cache-Control: no-cache`) — the alias `VITE_DESKTOP_DOWNLOAD_URL`
points at, so the web app never needs a per-release edit. It refuses outright if more than one
`.dmg` sits in `desktop/release/`, since a leftover would otherwise be published as *that* alias for
every user. The alias upload is last, so a partial failure leaves it pointing at the previous good
build rather than a release whose update feed never finished publishing.

`.github/workflows/release-desktop.yml` (`workflow_dispatch`, `dry_run`/`force` inputs) runs the
same `ship.mjs` on a GitHub-hosted `macos-latest` (arm64, standard) runner, behind a cheap ubuntu
`guard` job that runs `typecheck` and `check-unreleased.mjs` first — a stale version fails there at
1x billing rather than on the 10x mac runner.

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
  installing. `ship.mjs`/`check-unreleased.mjs`/`release-desktop.yml` are included: verified by a
  real dispatch (dry run, then a real one) rather than a test.

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
- A pairing code never requires an app restart to refresh, on a timer, on demand, after an unpair
  from either side.
- The automatic re-register on `1008` is debounced (30s floor) and guarded on `!pairingCode`.
  Without both, a device refused for some *other* reason would `register` against storage on every
  one of the bridge's relay retries.
- Unpairing from the tray revokes the row (a tombstone, exactly as `DELETE /v1/devices/:id`) and
  touches no session data and no filesystem state — hence the confirm dialog is about access, not
  about losing work.
- **Hosted is the default.** Local mode (own web server, own window) needs `LINES_LOCAL_MODE=1`,
  which the `dev` script sets. `web/dist` is not in the DMG.
- A missing or too-old CLI refuses the turn with an actionable sentence, in the browser and in
  the tray — never a raw SDK error.
- `LINES_CLAUDE_PATH` is exclusive: set it, and no other location is tried.
- Update checks only notify. The tray links the download page.
- A bridge child refuses to start if another live process already holds this machine's
  single-instance lock — **unless** that other process names `instance: 'desktop'` (i.e. it is a
  previous tray bridge), in which case ours preempts it instead of refusing. This is a second,
  independent guard beneath the shell's own `requestSingleInstanceLock` (which stops a second
  *Electron* process) — it also catches a respawn racing a not-yet-exited previous bridge, or a
  bridge run by hand alongside the packaged app. Without it, two bridge processes can share one
  `device.json`, and the relay resolves that by superseding one of them — visible in every
  connected browser as a flicker until it does.
- When a *different* installation (a dev checkout, most commonly Tilt) holds the lock instead, the
  tray's own bridge stands down rather than fighting for it: no bridge or worker spawns at startup,
  or the running bridge exits/gets preempted and is not respawned, until the lock clears. The tray
  reports this plainly ("Paused — another bridge owns this machine") rather than showing
  "Connecting…" or silently retrying forever.
- The worker is never part of a stand-down: only the bridge collides on the machine lock and the
  relay device identity, and a worker mid-turn must not be torn down because a sibling process
  collided on a resource the worker doesn't touch.
- A release is refused when `desktop/package.json`'s version is already published, unless the
  caller explicitly passes `--force` (or the workflow's `force` input) — artifacts are immutable at
  the edge (one-year max-age), so a same-version re-upload can leave stale bytes cached rather than
  replacing them.
- `npm run ship -w desktop` is destructive on purpose: it deletes `desktop/release/` before every
  build, since that directory is electron-builder output and nothing else is meant to live there.
- The desktop release pipeline is manual-dispatch only — no tag convention, no release on push to
  `main` — since a release starts with a deliberate version-bump commit, not a merge.

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
- **A local release and a CI release are the same code path on purpose.** Both run
  `desktop/scripts/ship.mjs`; a script the workflow calls but a person could not also run by hand
  would be a second procedure to keep in sync, and the local one is what you reach for when CI is
  broken.
- `ship.mjs` derives `LINES_UPDATE_FEED_URL`/`LINES_DOWNLOAD_URL` from `R2_RELEASE_PUBLIC_BASE_URL`
  rather than taking them as separate inputs — a hand-typed feed URL that's wrong bakes a dead
  updater into the shipped app, and nothing catches it until a user's copy silently stops finding
  releases.
- `release-desktop.yml`'s `guard` job runs on `ubuntu-latest` (1x billing) specifically so a stale
  version or a type error is cheap; the `release` job runs on `macos-latest` (10x billing, arm64,
  a *standard* runner — larger/x64 mac runners are always billed, never included).
- The bridge lock file lives beside `device.json` under the same `APP_ROOT`, reusing the existing
  app-data-root path helpers rather than adding a new resolver (see
  [app-data-root](app-data-root.md)). A stale lock is detected via `process.kill(pid, 0)`
  (`ESRCH` means take it); `LINES_ALLOW_MULTIPLE_BRIDGES=1` is the deliberate escape hatch that
  must never be set in a real deployment.
- `foreignBridgeLock()`/`BRIDGE_LOCK_FILE`/`EXIT_BRIDGE_LOCK_HELD` are duplicated in `main.ts`
  rather than imported from `server/src/index.ts` — the same precedent `APP_ROOT` already sets in
  this file: the shell needs the two constants and a read, not the bridge's module graph.
  `EXIT_BRIDGE_LOCK_HELD = 78` is a contract between the two files; changing it in one without the
  other silently breaks the stand-down trigger.
- `enterStandDown` is the only path that clears `bridge`/`worker` handles and arms the recheck
  timer; both the startup check and `spawnChild`'s exit handler funnel into it rather than each
  duplicating the tray-copy and recheck logic.

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
  identity can be claimed by whichever registers last — and, since the bridge lock, also share
  `~/.lines-app/bridge.lock`, so only one bridge from either can be running against it at once.
- [app-data-root](app-data-root.md) — the `~/.lines-app` root the bridge lock lives under.
- [hosted-machine-access](hosted-machine-access.md) — how the shell's children find and announce
  their ports, the identity and registration it performs in hosted mode, what `RELAY_URL`
  connects to, and `hello`'s protocol version, which the update flow exists to keep from drifting
  too far.
- [production-deployment](production-deployment.md) — the hosted side the installed app talks to;
  `VITE_DESKTOP_DOWNLOAD_URL` there is now set once, to the stable alias, rather than per release.
- The five `R2_RELEASE_*`/`R2_ACCOUNT_ID`/etc. credentials now live in two places — the VPS
  `lines.env` (manual release) and GitHub Actions secrets (CI release) — same token, wider blast
  radius; scope it to both R2 buckets and rotate on the usual schedule.
