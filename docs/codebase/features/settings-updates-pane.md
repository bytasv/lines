# Settings → Updates pane

## Purpose

One place in the browser to answer "what am I running, and is there something newer": the
version of every moving part (this web tab, the bridge, the worker, the desktop app, the Claude
Code CLI), plus a permanent download link for the latest desktop release. Before this, the only
version surface was the desktop tray (unreachable from a browser) and the dismissible
`UpdateBanner` pill, which a user could dismiss once per version and then never see again.

The pane assembles numbers that mostly already crossed the wire — `BridgeInfo.version`,
`WorkerStatus`, `UpdateStatus` — plus two that did not: a web bundle version constant, and the
Claude CLI status the bridge already computes for itself but had never sent to a client.

## Entry points

- `web/src/components/SettingsModal.tsx` — the `updates` section (`Updates`, last in the rail);
  not in `GUEST_SECTIONS`, so a guest never sees it (it reports the host's machine)
- `web/src/components/UpdatesSection.tsx` — the pane itself

## Files

- `web/src/components/UpdatesSection.tsx`
- `web/src/components/SettingsModal.tsx`
- `web/vite.config.ts` — `define`s `__LINES_VERSION__` from `web/package.json`
- `web/src/vite-env.d.ts` — declares `__LINES_VERSION__`
- `web/src/store.ts` — holds `claudeCli`, `fromPrimary`-gated like `bridge`/`updateStatus`
- `web/src/lib/machines.ts` — `MachineSlice.claudeCli`
- `shared/types.ts` — `ClaudeCliState`/`ClaudeCliStatus`, `hello.claudeCli?`,
  `WorkerStatus.version?`
- `server/src/claudeCli.ts` — re-exports the two types from `shared/`; `publicClaudeCliStatus`
- `server/src/index.ts` — `buildHello` adds the owner-only `claudeCli` field
- `server/src/workerProtocol.ts` — worker `hello` gains optional `appVersion?: string`
- `server/src/worker.ts` — reads its own `package.json` (or `__LINES_VERSION__`) into
  `appVersion`
- `server/src/workerClient.ts` — stashes `appVersion` from a successful hello, surfaces it on
  `status.version`, folds it into `sameStatus`

## Symbols

- `__LINES_VERSION__` — build-time constant, one per bundle (web, bridge, worker, desktop shell);
  each reads its own `package.json` at build/boot and falls back to this only when that read
  fails
- `publicClaudeCliStatus(status?)` — the only path `claudeCliStatus()` may reach a client
  through; builds the wire object field by field
- `WorkerClient.status` / `sameStatus` — worker link health, now version-aware
- `UpdatesSection`, `VersionRow` — the pane and its one repeated row shape

## Data flow

`buildHello` (owner branch only) adds `claudeCli: publicClaudeCliStatus()` beside the existing
`worker`/`update` fields. The worker's `hello` gains `appVersion`, which `WorkerClient` stores and
folds into the `WorkerStatus` it already publishes on `onStatusChange` — no new `ServerMessage`
variant, `worker.version` rides the existing `WorkerStatus`. `web/src/store.ts` holds all of it
per-machine in `MachineSlice` and re-derives the primary machine's scalars
(`bridge`/`workerStatus`/`updateStatus`/`claudeCli`) the same way it already did for the first
three. `UpdatesSection` reads five store values (`__LINES_VERSION__` is a compile-time constant,
not store state) and renders one `VersionRow` each.

## Tests

- `server/src/claudeCli.test.ts` — `publicClaudeCliStatus` never includes `path`; a missing CLI's
  wire copy omits `version` rather than sending it as `undefined`
- `server/src/workerClient.test.ts` — a worker restarting on a new build (same link, no outage)
  still publishes a status change, because `version` is now part of `sameStatus`; a worker too
  old to send `appVersion` reports `connected: true` with no `version` key at all

## Business rules

- Versions shown: web, bridge, worker, desktop app, Claude CLI. No other component gets a row.
- The desktop row's version is what is *available* (`DESKTOP_DOWNLOAD_VERSION`, parsed from the
  published DMG's filename — see [desktop-app](desktop-app.md)), not a client-computed "are you
  current" check. There is no version-string comparison anywhere in the pane: `updateStatus.state
  === 'available'` (the desktop shell's own verdict against its update feed) is the only signal
  that flips the badge to "update available" and the button to its filled variant.
- **The download button always renders whenever `DESKTOP_DOWNLOAD_ENABLED`** (i.e. a desktop build
  has been published), regardless of `updateStatus`. Being already on the latest version does not
  hide it — a user who wants the installer, or wants it on a second machine, should always be able
  to get it from here. Only the absence of any published build hides the row.
- The desktop row itself is hidden outright when `DESKTOP_DOWNLOAD_ENABLED` is false — a button
  pointing at nothing is worse than no row (same rule `DownloadDesktopApp.tsx` follows).
- The download link is a plain anchor to `DESKTOP_DOWNLOAD_URL`, never the owner-gated
  `installUpdate` message — with self-install off, that message only opens the download page on
  the *tray* machine, which a remote browser never sees (see `UpdateBanner.tsx` and
  [desktop-app](desktop-app.md)).
- An unknown version renders as a dimmed em dash, never an omitted row — the pane's shape is
  stable whether or not a `hello` has landed yet.
- `claudeCli`/`worker`/`update`/`bridge` are all owner-only and `fromPrimary`-gated in the store; a
  guest's `hello` never carries any of them, and the pane is unreachable to a guest regardless
  (`GUEST_SECTIONS` filters to `devices` only).
- `hello.claudeCli` never carries `path` — an absolute path to the CLI binary names the host's
  home directory and username. `publicClaudeCliStatus` builds the wire object field by field
  rather than spreading the bridge-local `ClaudeCliStatus`, specifically so a future field added to
  the bridge-local shape cannot leak onto the wire by accident.
- Both new wire fields (`hello.claudeCli`, worker `hello.appVersion`) are optional, so neither
  bumps `APP_PROTOCOL_VERSION` (browser↔bridge) nor the worker's `PROTOCOL_VERSION` — an older
  peer on either side simply omits the field, same precedent as `LiveSessionInfo.busy`.

## Architectural rules

- `ClaudeCliState`/`ClaudeCliStatus` are declared in `shared/types.ts`, not
  `server/src/claudeCli.ts` — same reason `PLAN_DIR_MARKER` lives there: the browser needs the
  shape without importing server code. `claudeCli.ts` re-exports both so every existing server
  importer is unaffected.
- The worker's `appVersion` is a *package* version, unrelated to `WorkerToBridge.hello.version`
  (the protocol number). The worker outlives bridge restarts, so a frozen worker beside a hot
  bridge is a real state this field exists to make visible, not to explain away.
- The web bundle's `__LINES_VERSION__` mirrors the bridge/worker/desktop-shell idiom exactly (a
  `define` reading `package.json` at build time, `declare const` in a `.d.ts`) rather than a
  `VITE_*` env var — this is the bundle's own identity, not deployment configuration.

## Related decisions

- [desktop-app](desktop-app.md) — `UpdateStatus`, `BRIDGE_VERSION`/`APP_VERSION`,
  `DESKTOP_DOWNLOAD_URL`/`_VERSION`/`_ENABLED`, `CAN_SELF_INSTALL`, `MIN_CLAUDE_VERSION`
- [hosted-machine-access](hosted-machine-access.md) — `BridgeInfo`, `APP_PROTOCOL_VERSION`,
  `SettingsModal.tsx`'s section rail, worker/bridge local port discovery
