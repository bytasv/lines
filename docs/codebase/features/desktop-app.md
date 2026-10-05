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
no `node_modules`. Four decisions shape it, each a recorded trade: the build is signed with a
Developer ID and notarized (hardened runtime), the Claude Code CLI is *not* bundled, the agent SDK is shipped unbundled
next to the code, and — the one exception — a `whisper-cli` binary *is* bundled, compiled from
source at package time, because [voice-input](voice-input.md) has no equivalent of `npm i -g` to
point a user at.

## Entry points

- `desktop/src/main.ts` — the Electron main process
- `desktop/src/config.ts` — resolved URLs and local-mode switch
- `server/src/updates.ts` — the bridge-side half of update state
- `desktop/scripts/build.mjs` — the three esbuild bundles, the pruned SDK tree, `config.json`,
  the bundled `whisper-cli` (see `build-whisper.mjs`)
- `desktop/scripts/build-whisper.mjs` — compiles a static, Metal-enabled `whisper-cli` from a
  pinned whisper.cpp release, cached by version; a local build without `cmake` skips it with a
  warning (falls back to Homebrew's), CI refuses to ship without it
- `desktop/assets/entitlements.mac.plist` — the hardened-runtime entitlements, used for both the app
  and its inherited children
- `desktop/scripts/release.mjs` — the upload-only step (`npm run upload -w desktop`): artifacts to the
  public R2 bucket, plus the stable download alias
- `desktop/scripts/ship.mjs` — the one-command release: version guard, clean build, publish
- `desktop/scripts/check-unreleased.mjs` — refuses to publish a version already at the edge
- `.github/workflows/release-desktop.yml` — `workflow_dispatch` that runs `ship.mjs` on a
  GitHub-hosted mac runner
- `desktop/package.json` — the `build` block (electron-builder config) and `package`/`upload`/`release`/`ship`
  scripts (`release` and `ship` both run `ship.mjs`)

## Files

- `desktop/src/main.ts` — spawn, supervise, tray, pairing, un-pairing, relay status
- `desktop/src/config.ts` — `loadConfig`, `isLocalMode`; reads `Resources/config.json`, env vars
  override
- `server/src/updates.ts` — `UpdateManager`, `reportRelayStatus`
- `server/src/relayClient.ts` — `RelayClient.onStatus`, the raw open/close the tray's connection
  state is derived from
- `shared/types.ts` — `UpdateStatus`, `installUpdate`, `updateStatus`
- `server/src/claudeCli.ts` — finds the machine's `claude`, with a version floor
- `server/src/whisperCli.ts` — finds `whisper-cli`; `LINES_WHISPER_BUNDLED_BIN` (set from
  `desktop/whisper/whisper-cli` in the packaged resources) is checked before Homebrew
- `desktop/assets/` — `trayTemplate.png` (+`@2x`), `icon.icns`, `icon.png`
- `~/.lines-app/desktop.json` — the shell's own preferences (window vs. browser for "Open Lines",
  keep-awake, whether the login item has been defaulted once); read at boot, written on toggle,
  best-effort like the log
- `server/scripts/enroll-code.ts` — the tray's encryption actions without Electron, for a bridge
  under Tilt or on a headless box
- `desktop/scripts/ship.mjs` — orchestrates `check-unreleased.mjs`, `package`, `upload` behind one
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
- `startUiServer` — local-mode only; not shipped in the DMG
- `openWindow` — used in both modes now; loads `appUrl()`, which is local-mode's own server or,
  in hosted mode, `config.webUrl` directly
- `applyRelayStatus` / `onRelayVerified` / `RELAY_SETTLE_MS` — turns the relay's raw open/close
  into "Connected" only once a link survives long enough to prove the pairing claim landed, since
  the relay accepts a socket *before* checking whether the device is claimed
- `refreshPairingCode` / `schedulePairingRefresh` — re-registers (idempotently) on a timer and on
  demand, so a code never needs an app restart to replace
- `claudeCliStatus` / `refreshClaudeCli` — cached discovery; the tray's Claude Code row and
  "Check again" refreshes it
- `claudeCliRefusalMessage()` — the sentence a hosted user sees when the CLI is missing or old
- `MIN_CLAUDE_VERSION` (`claudeCli.ts`) — the CLI version the pinned SDK wrapper ships
- `APP_VERSION` — the version shown in the tray and the one `electron-updater` compares the feed
  against; packaged it is `app.getVersion()`, unpackaged it comes from the `__LINES_VERSION__`
  esbuild define (`build.mjs`), because `electron dist/main.cjs` never reads `desktop/package.json`
- `appUrl()` — the window's URL: `127.0.0.1:<uiPort>` in local mode, `config.webUrl` in hosted mode;
  one function for both, so `openWindow` is no longer local-mode-only
- `appOrigin()` / `navigationVerdict()` / `attachNavigationGuards()` — the window's navigation
  policy: `appOrigin()` reads the origin off `appUrl()` (a function, since `uiPort` is `0` until
  `startUiServer()` runs), `navigationVerdict()` is one ordered decision function deciding in-app
  vs. external vs. dropped for a target URL, and `attachNavigationGuards(window, role)` wires it
  into `will-navigate`, `setWindowOpenHandler` and `did-create-window` for every window
- `injectBackToLines()` — injects a "Back to Lines" pill into a page the main window has navigated
  to outside the app origin, via `insertCSS`/`executeJavaScript`, no preload or IPC involved
- `syncDock()` — shows the dock tile in hosted mode iff any `BrowserWindow` still exists, else hides
  it; local mode keeps a permanent tile as before
- `openLinesDefault()` — what "Open Lines" actually does, per the persisted `openIn` preference
- `loadPrefs()` / `savePrefs()` — read/write `~/.lines-app/desktop.json`
- `resetDesktopWindow()` — clears the window's cookies and storage and closes it; the only way to
  sign out of a window that has no address bar
- `shellLog()` — writes to the same log file `appendLog` writes to and echoes to stdout; everything
  that has to be diagnosable after the fact goes through it, including `autoUpdater.logger`
- `runCheck()` / `armRetry()` / `answerManualCheck()` — one update check, automatic or manual; a
  failed automatic check arms a single 5-minute retry, a manual one always answers with a dialog
- `updateRow()` — the tray's always-present update line; precedence is a staged version ("Restart
  to update to X"), then a download in progress, then checking, then an offered version (manual
  download), then disabled-and-why, then failed, then last-checked, then never-checked
- `updatesEnabled` / `updatesDisabledReason` — whether the updater actually started, and why it
  didn't when it didn't
- `CAN_SELF_INSTALL` — turns on the background download, staging and `quitAndInstall()`; true
  now that releases are signed and notarized. Off, the shell only checks (0.2.43 and earlier)
- `restartForUpdate()` / `confirmRestartForUpdate()` — install the staged update and relaunch
  (only from `'ready'`); the tray's and the notification's version warns first while a turn runs
- `notifyUpdate(version, kind)` — the once-per-version notification, `'ready'` or `'available'`
- `offerMoveToApplications()` — the once-only offer to move a packaged app into Applications
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
- `installMediaPermissions()` — grants Electron's `media` permission request only for a mic,
  requested by the app's own origin (never a third-party page the window navigated to), then on
  macOS gates it a second time behind `systemPreferences.askForMediaAccess('microphone')`; every
  other permission keeps Electron's default

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
than silently becoming a second `RelayClient` claiming the same device. "Open Lines" opens a
native `BrowserWindow` at `config.webUrl` by default — the same zero-privilege window as local mode
(no preload, no IPC, `contextIsolation` on), just pointed at the hosted URL instead of the local
server (`appUrl()` picks between them). The choice persists in `~/.lines-app/desktop.json`
(`openIn: 'desktop' | 'browser'`); the tray's second row is always the other route, labelled "Open
in Browser" or "Open Desktop Window". Navigation inside the window stays in-window only as the app
origin itself (per `appUrl()`, so local mode trusts the local origin), a dedicated identity host
Clerk's OAuth redirects go through (`clerk.` and `accounts.` on the parent domain of the app host,
that is the app host less its first label — not on the app subdomain itself), a scoped OAuth entry path (`github.com`'s `/login/oauth/`
only — the one identity host that is also a content site), or the continuation of a flow already
off-app; everything else is handed to the real browser and logged, including which rule allowed an
in-app hop and the reason `will-navigate` blocked one — Clerk's own full-page OAuth redirect has to
survive this or sign-in breaks with no way back, since the window has no address bar. The shell also supplies a native right-click menu in every window (Electron ships none): edit
actions in inputs, Copy on selected text, spelling suggestions, Copy Link, Copy Image, and Inspect
Element in unpackaged builds only. It is built from the `context-menu` event with built-in role
items, so it needs no preload or IPC, and it is attached inside `attachNavigationGuards` so popups
get it too. Link items never navigate the window: Copy Link writes the URL to the clipboard, and
Open Link in Browser appears only for `EXTERNAL_SCHEMES` and goes through `shell.openExternal`, so
`blob:` attachment links get Copy only. A custom web-side `contextmenu` handler must
`preventDefault`, or both menus appear. A window that
ends up stuck off-app (an abandoned sign-in) gets a "Back to Lines" pill injected into the page, and
the tray's "Open Lines" reloads an existing off-app window back to the app instead of just showing
it. **The window's cookie jar is not Safari's or Chrome's**: a browser
sign-in does not carry into the window and vice versa, though a dev run and the packaged app share
one jar. The dock tile (hidden by default in hosted mode) reappears for as long as any window is
open (`syncDock`) and disappears once the last one closes, since a visible window with no tile has
no Cmd-Tab and — the sharper problem — no application menu, so Cmd-C/Cmd-V would not work.

### The desktop shell's own window

The shell's own window opens `appUrlForOwnWindow()`
(see [end-to-end-encryption](end-to-end-encryption.md)), not `appUrl()` directly: in hosted mode
its socket goes out over the relay like any other browser's, so the bridge cannot tell it apart
from a phone by locality alone. Two things ride the URL **fragment** — never the query string,
which the server would see:

- `enroll=<code>`, always present in relay mode (every relayed owner channel must be encrypted),
  so the window enrols itself rather than making the user retype a code the tray just showed
  them.
- `host=<deviceId>` (`device.id` from `deviceIdentity()`), unconditionally whenever a relay device
  identity exists. The web client reads it once, saves it to `localStorage` as
  `lines.hostDeviceId`, and strips it from the URL. `useCanBrowseFolders`
  (see [session-collaboration](session-collaboration.md)) then treats a window whose saved
  `hostDeviceId` matches the machine it's connected to as sitting at the host, so "Browse…" opens
  Finder there even though the link itself isn't local — see the `pickFolder` locality rule in
  [hosted-machine-access](hosted-machine-access.md)'s Architectural rules for the server-side
  half. An older desktop build sends no `host`, so that window's "Browse…" simply stays hidden,
  same as before this existed.

If registration
returns a pairing code, a small `BrowserWindow` shows it as a data URL, independent of `web/dist`
even existing. This window navigates nowhere at all — not even to the app's own origin — so
clicking the web URL printed on the card opens the real browser and leaves the code on screen. The
code auto-refreshes every ~14 minutes while unpaired, and "Get a new code" in
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
— or refuses outright if any session is active. Every send in both directions is guarded on
`connected` with a no-op error callback rather than sent bare: a respawned-after-crash or
killed-on-quit child leaves a non-null handle whose channel is already closed, and `send` into a
closed channel throws synchronously — uncaught, that took the whole shell down.

On a signed build (`CAN_SELF_INSTALL`) the update installs itself. `autoDownload` fetches a found
version in the background (`'downloading'`, with progress in steps of ten so the tray menu and the
browsers are not updated on every chunk), and `autoInstallOnAppQuit` hands the zip to Squirrel.Mac
straight away, so it is staged by the time the user restarts. `'update-downloaded'` sets `'ready'`.
From there the user restarts into it: the tray row "Restart to update to X", the `'ready'`
notification, the manual check's dialog, or a browser's `installUpdate` (refused by the bridge
while a session is active). Quitting normally installs it too. `restartForUpdate()` acts only from
`'ready'`; Squirrel.Mac closes the windows, `before-quit` stops both children, and the new version
relaunches itself. While a version is downloading or staged, `runCheck()` skips, since another
check would only stage the same update again. A download or staging failure for a known version
(a dropped network, an app copy macOS runs read-only) falls back to `'available'` with the error
in `message`: the tray row and the banner then offer the download page, and the next scheduled
check retries from the cached download. Builds up to 0.2.43 only check, and their users install
the first self-installing build by hand once.

Detecting an update announces it three ways: a native macOS notification (`notifyUpdate`, posted
for `'ready'` on a self-installing build and for `'available'` otherwise, deduped per version in
memory — `notifiedUpdateVersion` — so the 6-hourly re-check doesn't re-nag for a version already
shown; a fresh app launch with an update still pending notifies once, which is the intended
reminder), a persistent `tray.setTitle(' ●')` marker set from `updateTray()` (macOS-only, shown
for `'available'` and `'ready'`), and, for a browser, the blue `UpdateBanner` pill (see
[turn-recovery](turn-recovery.md#multi-machine) for its place in the banner-precedence stack). The
pill reads "Restart to update" for `'ready'` and "Download" for `'available'`; the bridge re-sends
a `'ready'` status whenever a session starts or finishes (`UpdateManager.syncBlocked`), so its
`restartBlocked` flag follows the sessions rather than the moment the shell last spoke. `buildHello`'s owner branch carries `update: updates.current()` so a browser opened *after*
detection still learns about it — the guest branch omits the field, since `installUpdate` is
owner-gated and a guest has no business updating somebody else's machine.

None of those three surfaces is trustworthy on its own — a native notification can be silently
dropped by macOS, and Electron's delivery-failure event is
Windows-only — so a fourth, unconditional one exists: **every outcome of a check has a permanent
tray row**, produced by `updateRow()` and no longer gated on `state === 'available'` the way it used
to be. In order of precedence: `Restart to update to X` once a version is staged; `Downloading X…
NN%` while one downloads; `Checking for updates…` while a check is in flight; an offered version
for manual download (checked ahead of the disabled case, so `LINES_FAKE_UPDATE_VERSION` still
renders it even with real checks disabled);
`Automatic updates off — <reason>` when `startUpdateChecks()` never actually started one (no feed
URL in this build, a dev build without `LINES_FORCE_UPDATE_CHECK=1`, or the updater throwing on
start); `Update check failed — open logs` on `'error'` (the message itself stays in the log, since a
menu item cannot wrap it); `Up to date · checked <time> ago` after a clean check; or `No update
check yet`. A `'Check for updates'` row (when checks are running at all) calls `runCheck({ manual:
true })`, which always answers with a dialog — including "up to date" — so a manual check never
looks like it did nothing.

`autoUpdater.logger` is assigned to the shell's own log (`shellLog`, same file `appendLog` writes
to) before any of `startUpdateChecks()`'s guards run, so the feed URL, the parsed version, and the
literal reason a check was skipped or failed are all in `~/.lines-app/logs/<instance>.log` — "Open
logs" in the tray reveals it. A rejected `checkForUpdates()` now sets `'error'` rather than leaving
`'idle'`, which used to read as "you are up to date" with no evidence behind it. `runCheck()` arms
one 5-minute retry (`armRetry`) after an automatic failure, cleared by the next successful check —
covering a login-time network race, where Start-at-login fires the one startup check while Wi-Fi is
still associating. A `powerMonitor` `'resume'` listener re-checks if the last one is over an hour
stale, since a `setInterval` does not fire while the machine sleeps and a laptop closed nightly
could otherwise go days between checks. `LINES_FORCE_UPDATE_CHECK=1` makes an unpackaged run hit
the real feed — `electron-updater` otherwise gates every check on `app.isPackaged` — the only way to
exercise the network path itself without a signed build.

Setting `LINES_FAKE_UPDATE_VERSION` still short-circuits `startUpdateChecks()` (skipping the real
feed check entirely) — the fastest way to exercise the announcement surfaces without a packaged
build and a published release. It lands in `'available'` unless `LINES_FAKE_UPDATE_STATE` says
`downloading` or `ready`; a fake `'ready'` never restarts.

A packaged app running outside Applications offers once at launch, before either child starts, to
move itself there (`app.moveToApplicationsFolder()` relaunches it), because Squirrel.Mac cannot
replace a copy on the mounted DMG or one macOS runs read-only from Downloads. Declining is saved
in `desktop.json`; an update that then fails to install falls back to the download page.

### Packaging

`npm run package -w desktop` runs `build.mjs`, then electron-builder.

`build.mjs` emits `dist/main.cjs` (CJS, the Electron main process) plus `dist/server/bridge.mjs`
and `dist/server/worker.mjs` (ESM). It copies `@anthropic-ai/claude-agent-sdk` and its dependency
walk into `dist/server/node_modules`, and writes `dist/config.json` from any `LINES_*` env vars
set at build time.

electron-builder packs `dist/main.cjs` into the asar, copies `dist/server`, `dist/config.json`
and the tray assets to `Resources/`, signs the bundle with the Developer ID (hardened runtime,
entitlements from `entitlements.mac.plist`), notarizes it with Apple and staples the ticket, then
builds the DMG and the zip. `ship.mjs` passes `forceCodeSigning`, so a missing or untrusted
certificate fails the release instead of producing an unsigned app; a plain `npm run package`
still builds without one.

Signing inputs, none of them in the repo: `mac.identity` names the team's certificate without the
`Developer ID Application:` prefix (electron-builder rejects it). On CI the certificate comes
from `CSC_LINK`/`CSC_KEY_PASSWORD` and the notarization App Store Connect key from
`APPLE_API_KEY` (a *file path* — the workflow decodes the secret to a file and fails if the secret
is missing), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Locally, electron-builder finds the
identity in the login keychain, and notarization uses a stored `notarytool` keychain profile via
`APPLE_KEYCHAIN_PROFILE`; the `APPLE_API_*` variables take precedence when set, so keep them out of
a local shell. Notarization skipped for want of credentials is only a warning, so check the build
log for `notarization successful`.

At runtime `main.ts` resolves `ROOT` to `process.resourcesPath` when packaged (the repo root
otherwise) and spawns `Resources/server/{bridge,worker}.mjs` with Electron's own node via
`ELECTRON_RUN_AS_NODE=1`. Every `query()` is handed `pathToClaudeCodeExecutable` from
`claudeCliStatus()`.

### Releasing

`npm run ship -w desktop` is the one command for the whole release, local or CI — the same entry
point either way (`npm run release -w desktop` is an alias of it; the upload-only step is
`npm run upload -w desktop`), so the two never drift into two procedures. It: runs `check-unreleased.mjs`
(skippable with `--force`), clears `desktop/release/`, runs the root `typecheck` and the server and
relay test suites, runs `package`, then runs `upload` (skippable with `--dry-run`). The tests have
no skip flag: the bridge ships inside the app, so a release cut from a failing commit puts the
failure on every machine. Only the release workflow sets `LINES_SHIP_TESTED=1`, because its ubuntu
`guard` job has already run the same suites on the same commit. Both `LINES_UPDATE_FEED_URL` and `LINES_DOWNLOAD_URL` are derived from
`R2_RELEASE_PUBLIC_BASE_URL` rather than hand-set, so a build-time URL cannot be typed wrong without
also breaking the derivation everywhere else.

`check-unreleased.mjs` fetches the published `latest-mac.yml`, compares its `version:` line against
`desktop/package.json`, and distinguishes two failures by exit code: `2` means this version is
already published, `1` means the check itself could not run (e.g. no
`R2_RELEASE_PUBLIC_BASE_URL`). A missing feed (first release, or an unreachable base URL) is treated
as "proceed" (exit 0).

`ship.mjs` reads that exit code. On `2`, at an interactive terminal (`stdin`/`stdout` both a TTY) and
not `--dry-run`, it offers to bump the patch version, commit, and push — `Bump to 0.2.7 and continue?
[Y/n]`. Declining, a non-matching version (a prerelease `check-unreleased.mjs` won't guess how to
bump), CI, or any piped/non-interactive invocation all fall through to the original behaviour:
print the "already published" message and fail. The bump — a targeted string replace, not
`JSON.parse`/`stringify`, so formatting is untouched — is written before `package` runs (so
`build.mjs` and electron-builder both pick it up) but only committed and pushed after `upload`
succeeds, so a failed build never leaves a pushed bump for a release that didn't ship. A push
rejection (remote ahead) is reported, not fatal — the release already succeeded.

`release.mjs` uploads the versioned artifacts, then re-uploads the DMG a second time under a fixed
key (`desktop/Lines-latest.dmg`, `Cache-Control: no-cache`) — the alias `VITE_DESKTOP_DOWNLOAD_URL`
points at, so the web app never needs a per-release edit. It refuses outright if more than one
`.dmg` sits in `desktop/release/`, since a leftover would otherwise be published as *that* alias for
every user. The alias upload is last, so a partial failure leaves it pointing at the previous good
build rather than a release whose update feed never finished publishing.

`.github/workflows/release-desktop.yml` (`workflow_dispatch`, `dry_run`/`force` inputs) runs the
same `ship.mjs` on a GitHub-hosted `macos-latest` (arm64, standard) runner, behind a cheap ubuntu
`guard` job that runs `typecheck`, the server and relay tests, and `check-unreleased.mjs` first — a stale version fails there at
1x billing rather than on the 10x mac runner.

`ship.mjs` also stamps the repo-root `changelog.json`: when it commits a version bump (offered or
hand-made) it moves `desktopPending` into a new `desktop` release for that version, via
`desktop/scripts/stamp-changelog.mjs`, and includes `changelog.json` in the same commit. If the
version already has a release the notes stay pending and the bump still commits. A CI release
cannot commit, so the workflow's `guard` job runs `stamp-changelog.mjs --check` and fails on
unstamped notes (not on a dry run); stamp locally with `npm run changelog:stamp -w desktop`, commit
and push first. See [whats-new](whats-new.md).

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

### Logging and diagnostics

- `~/.lines-app/logs/desktop.log` stamps every line with an ISO time. Child output is re-cut into
  whole lines, each tagged `[bridge]`/`[worker]`. Past 5 MB the file rotates once, to
  `desktop.1.log`.
- The shell logs:
  - power transitions (`[power] suspend|resume|lock-screen|unlock-screen`)
  - each relay link change (`[relay-status] …`)
  - child spawn/exit with uptime
  - device registration outcome, never the pairing code
- The app window's console is mirrored into the log as `[renderer] …`, but only `[diag]`, `[ws]`
  and `[e2ee]` lines plus warnings and errors. Also mirrored: `did-finish-load` (URL without its
  fragment, which can carry an enrollment code), `render-process-gone` and
  `unresponsive`/`responsive`. This keeps the window's no-preload, no-IPC contract, because
  `console-message` is observed from the main process.
- The tray's "Collect diagnostics…" builds `~/.lines-app/diagnostics/lines-diag-<ts>.zip` with
  `/usr/bin/ditto` and reveals it in Finder. The zip holds:
  - both log generations
  - every `run/*/*.json` with `token` deleted
  - the bridge lock
  - `summary.json`: version, relay status and when it last changed, child pids and uptime, last
    power events, window URL
  - device.json is never copied; only the device id appears, in the summary
- `nudgeWindowAwake`: on `resume`/`unlock-screen`, the shell dispatches a `visibilitychange` event
  into the app window via `executeJavaScript` (no preload, no IPC channel — this stays a DOM event
  pushed in, not a message read back out). The window's own wake signals
  (`visibilitychange`/`pageshow[persisted]`, see multi-machine-client.md) never fire here: it is
  never hidden and never bfcache-restored by a real sleep, confirmed in the field — the renderer
  logged nothing for ~100s after a real wake, until the user reloaded by hand, while the bridge had
  already reconnected. This substitutes the signal the web app cannot generate for itself.

### Staying awake

- The shell holds a `powerSaveBlocker('prevent-app-suspension')` for exactly as long as a turn is
  running, driven by a new `{ type: 'activity'; busy }` message on the same bridge→shell IPC
  channel as `relayStatus`. `UpdateManager.busy` already knew when a turn was live; the bridge
  reports the *edge*, deduped, from every session upsert plus a 30-second safety tick so a missed
  transition self-heals.
- Keyed on a live turn, never on "a session exists". A blocker held whenever the app is paired is
  a permanent one, and a laptop that never sleeps is a battery complaint rather than a feature.
- Released on the `busy: false` edge, on the bridge child's `exit`, and on `before-quit`. A leaked
  id outlives its turn, and the respawned bridge re-reports within its first tick anyway.
- `reportActivity` is a free function, deliberately not an `UpdateManager` method:
  `updates.test.ts` asserts `deepEqual` on that class's whole IPC log, and a hot-path message
  would break every one of those assertions for no reason.
- `prevent-app-suspension` stops an idle sleep and does **not** survive the lid closing on
  battery. Nothing in-process can. The tray tooltip says so rather than letting the user find out
  by losing a turn.
- Start-at-login is defaulted **once**, recorded by a `loginItemDefaulted` pref. Without that
  record a user who deliberately turned it off would have it turned back on at every boot — the
  same bug as a setting that does not persist.

### Encryption

- Every browser other than the shell's own window needs a code before it can connect over the
  relay. The tray mints the one-time enrollment code ("Show encryption code…"), shows it as text
  and as a QR, and lists enrolled browsers by fingerprint; clicking a row revokes it after a
  confirm. With none enrolled, the tray reads "No browser enrolled yet — enrol one to connect".
- The QR encodes `<webUrl>?enroll=<code>`, so a phone's own camera opens the app with the code
  filled in — no scanner in the web bundle, nothing to install. The web app strips the parameter
  from the URL immediately, since a one-time code has no business surviving in history.
- Revocation from the tray is the lockout escape hatch: key pinning plus a lost device would
  otherwise be unrecoverable, and the same actions exist as `npm run enroll -w server` for a
  bridge with no Electron around it.

### Updates and lifecycle

- A restart is refused while any session is `running`, `waiting-permission`, or
  `waiting-approval` — a restart always kills bridge and worker together, and an atomic update
  means there is no bridge-only hot-patch path yet.
- Closing the window does not quit the app; that is the point of a menu-bar app, and it must not
  kill an in-flight turn.
- An update installs only from `'ready'`, and only on a signed build (`CAN_SELF_INSTALL`):
  Squirrel.Mac verifies that the replacement carries the same Developer ID signature. A browser's
  restart is refused while a session is active; the tray's and the notification's warn and let the
  user at the machine decide. Nothing restarts the app on its own.
- The update notification fires at most once per version (in-memory `notifiedUpdateVersion`
  guard), not once per state transition — the 6h re-check re-fires `update-available` with the
  same version, and without the guard the user is nagged four times a day.
- `UpdateBanner` (web) is gated off for a guest (`access` non-null): the `hello` a guest receives
  never carries `update` in the first place (owner-only in `buildHello`), so this is a second,
  belt-and-suspenders guard against the same broadcast a guest socket still physically receives
  from `UpdateManager`'s fan-out.
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
- Updates download in the background and install on a restart the user chooses, or on a normal
  quit. A failed download or install falls back to the download page.
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
- `npm run release -w desktop` is an alias of `ship`; the upload-only step is `upload`.
- `npm run ship -w desktop` is destructive on purpose: it deletes `desktop/release/` before every
  build, since that directory is electron-builder output and nothing else is meant to live there.
- The desktop release pipeline is manual-dispatch only — no tag convention, no release on push to
  `main` — since a release starts with a deliberate version-bump commit, not a merge. That commit no
  longer has to be written by hand first: `npm run ship -w desktop`, run interactively, can author
  and push it itself after a successful release (see Releasing above). CI keeps failing outright —
  the prompt is gated on a TTY.
- A push to `main` that only touches `desktop/package.json` (the bump commit `ship.mjs` can now
  make) does not trigger `deploy.yml` — see `paths-ignore` in that workflow. Scoped to that one file
  rather than all of `desktop/**`, because `deploy.yml`'s `typecheck` step chains
  `npm run typecheck -w desktop` and `release-desktop.yml` is dispatch-only, so ignoring the whole
  directory would remove the only push-time typecheck desktop code gets.
- Every update check outcome has a permanent tray row (checking, disabled-and-why, available,
  failed, last-checked, or never-checked) — none of the old silent failure modes (a rejected check,
  no feed URL, a dev build, an updater that would not start) can read as up to date anymore.
- A failed automatic check retries once after 5 minutes, and again on waking from sleep if the last
  check is over an hour stale — covering a login-time network race and a `setInterval` a laptop's
  sleep starved.
- The tray states the running version from the same value (`APP_VERSION`) the updater compares the
  feed against, so the two can never disagree.
- A manual "Check for updates" always answers with a dialog, including "up to date" — it must never
  look like it did nothing.
- Hosted mode's "Open Lines" opens a native window at `config.webUrl` by default; the choice
  between that and the browser persists in `~/.lines-app/desktop.json`, and "Open in Browser" /
  "Open Desktop Window" is always the other row, one click away.
- The desktop window has its own cookie jar, separate from Safari or Chrome — signing in in a
  browser does not sign in the window and vice versa; a dev run and the packaged app share one jar.

## Architectural rules

- The default `webUrl` is `https://run.linesapp.cloud`; `downloadUrl` stays on the apex, which now
  serves the marketing page (see [production-deployment](production-deployment.md#origin-separation)).
  Builds released before the move hardcode `app.linesapp.cloud`, which therefore has to keep
  serving the app until most installs update; the window's navigation guard trusts only the app
  origin, so those builds cannot yet follow a redirect to `run.`.

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
- **Unsigned builds are "damaged", not merely unidentified.** With `identity: null`
  electron-builder skips bundle signing entirely (`skipped macOS code signing`). What remains is the linker's ad-hoc signature on the Mach-O,
  which declares sealed resources while nothing seals them — no
  `Contents/_CodeSignature/CodeResources`. macOS calls that **"Lines is damaged and can't be
  opened"**, and unlike the unidentified-developer case it offers *no* Open Anyway button, so the
  download is a dead end by every route. This shipped once, as an ad-hoc-signing workaround that
  has since been removed in favour of real signing; `forceCodeSigning` in `ship.mjs` is what keeps
  an unsigned build from shipping again.
- **Hardened runtime needs explicit entitlements.** The app spawns Electron-as-node bridge and
  worker children and a bundled `whisper-cli`, and records the microphone, so the plist grants JIT,
  unsigned executable memory, library-validation off, outbound network and `audio-input`. The
  microphone key is `com.apple.security.device.audio-input`; `device.microphone` is an App Sandbox
  key the hardened runtime ignores. The set is a first guess: trim what proves unneeded after
  clean notarized builds.
- **`whisper-cli` is ad-hoc signed at build time** (`build-whisper.mjs`) so it runs unpackaged on
  arm64; electron-builder re-signs it with the Developer ID when packaging.
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
- `autoUpdater.logger` is wired to the shell's log file before every guard in `startUpdateChecks`
  runs, so the reason a check never happened is captured too, not just the reason one failed.
- `UpdateStatus` is deliberately not widened with a last-checked timestamp — the browser can
  neither trigger nor act on a check, so that state stays shell-local rather than crossing the wire
  protocol.
- `updateTray()` only calls `setContextMenu`/`setTitle` when a signature of the rendered template
  actually changes, since it runs every 2s and would otherwise reinstall a byte-identical `NSMenu`
  tens of thousands of times a day and could swap the menu out from under one the user has open.
- The desktop window gets no preload and no IPC; every `BrowserWindow` (main, pairing, and any
  popup allowed through `setWindowOpenHandler`) is routed through `attachNavigationGuards`, which
  evaluates one ordered decision function (`navigationVerdict`) against `will-navigate` and
  `setWindowOpenHandler` and hands anything not in-app to `shell.openExternal`, logging every
  blocked/dropped navigation and every non-trivial allow. The pairing window's `aux` role
  navigates nowhere at all, app origin included.
- `will-redirect` is deliberately unhandled — every OAuth 302 leg arrives that way, and guarding it
  would mean enumerating hosts no allowlist can enumerate. `will-frame-navigate` is likewise not
  added since `web/src` has no iframes and it would double-handle the main frame too.
- The "Back to Lines" pill is injected via `insertCSS`/`executeJavaScript` rather than an inline
  `style` attribute or IPC, so a page's CSP cannot strip it and the window keeps its zero-privilege,
  no-preload contract.
- `app.userAgentFallback` (not per-`webContents` `setUserAgent`) carries the Electron-token scrub,
  so an OAuth popup window inherits the same scrubbed UA as the main window.
- The dock tile is shown iff a `BrowserWindow` exists, in hosted mode; local mode keeps a permanent
  tile as before.
- Shell-owned state under `~/.lines-app` is named for the shell, never for its content —
  `desktop.json` follows that rather than `server/src/store.ts`'s content-named convention
  (`device.json`, `projects.json`).

## Related decisions

- Developer ID signing plus notarization removes the Gatekeeper warning on a browser download.
  Users on a build from before signing still need one manual install of the first signed build.
  The signing credentials (the exported certificate and its password, the App Store Connect
  `.p8`) can sign software as the team: keep them only in GitHub secrets and a password manager.
- In-place updates restart only when asked (tray, notification, browser) or on a normal quit,
  never silently: a menu-bar app supervising agent turns must not restart under one, and a quit
  alone might never come for an app left running.
- Requiring an installed Claude Code trades 231 MB for an install step. If that proves too much
  friction, shipping the platform binary becomes a build flag, not a rewrite — the
  `pathToClaudeCodeExecutable` indirection is the seam.
- `electron` is pinned exact in `devDependencies`: electron-builder cannot compute the version
  from a range when the module is hoisted out of the workspace.
- arm64 only for now. Adding `x64`/universal is a one-line `mac.target` change.
- Sign-in inside a `BrowserWindow` versus the browser is a real trade, not resolved by reading
  code: some identity providers refuse OAuth from anything they recognise as an embedded browser,
  and the window's separate cookie jar means the two surfaces never share a session. "Open in
  Browser" stays permanent for exactly this reason — if a provider is ever refused and it is the
  only sign-in method, the fix is flipping the default `openIn` preference to `'browser'`, not
  removing the window. A sharper version of the same trade showed up when a `github.com` link in
  agent output silently replaced the window, because the old allowlist trusted `github.com`
  host-wide for Clerk's OAuth redirect. The fix scopes that one host to its OAuth entry path
  (`/login/oauth/`) rather than trusting it whole; if Clerk ever redirects through a `github.com`
  path outside that prefix, the symptom is the window staying on the sign-in screen while the
  browser completes the flow in its own cookie jar, diagnosed by one `blocked navigation` log line,
  and the fix is adding that prefix — or, for a host that turns out to be pure identity
  infrastructure with no content of its own, promoting it into the host-wide identity list instead
  of a scoped entry.
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
