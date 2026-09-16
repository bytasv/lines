# Settings → Updates pane

## Purpose

One place in the browser to answer "what am I running, and is there something newer": the
version of every moving part (this web tab, the bridge, the worker, the desktop app, the Claude
Code CLI), plus a permanent download link for the latest desktop release. Before this, the only
version surface was the desktop tray (unreachable from a browser) and the dismissible
`UpdateBanner` pill, which a user could dismiss once per version and then never see again.

The pane assembles numbers that mostly already crossed the wire — `BridgeInfo.version`,
`WorkerStatus`, `UpdateStatus` — plus a web bundle version constant, and each CLI's status:
Claude's and, since [cross-provider model switching](cross-provider-model-switching.md) made a
missing Codex CLI a turn-blocking condition the model picker needs to explain, Codex's too.

Both CLI probes are self-healing rather than cached for the life of the process: a working
answer stays cached, but a "missing"/"outdated" verdict is only trusted for
`RETRY_FAILED_AFTER_MS` (10s) before the machine is asked again, and the bridge re-broadcasts
whenever the answer actually changes. Installing the CLI in response to the pane's own message
is picked up within seconds, with no restart and no manual "check again".

## Entry points

- `web/src/components/SettingsModal.tsx` — the `updates` section (`Updates`, last in the rail);
  not in `GUEST_SECTIONS`, so a guest never sees it (it reports the host's machine)
- `web/src/components/UpdatesSection.tsx` — the pane itself

## Files

- `web/src/components/UpdatesSection.tsx`
- `web/src/components/SettingsModal.tsx`
- `web/vite.config.ts` — `define`s `__LINES_VERSION__` from `web/package.json`
- `web/src/vite-env.d.ts` — declares `__LINES_VERSION__`
- `web/src/store.ts` — holds `claudeCli`/`codexCli`, `fromPrimary`-gated like `bridge`/`updateStatus`
- `web/src/lib/machines.ts` — `MachineSlice.claudeCli`/`codexCli`
- `shared/types.ts` — `ClaudeCliState`/`ClaudeCliStatus`, `CodexCliState`/`CodexCliStatus`,
  `hello.claudeCli?`/`hello.codexCli?`, the `'cliStatus'` `ServerMessage`,
  `CLAUDE_INSTALL_URL`, `CODEX_INSTALL_URL`, `CODEX_INSTALL_COMMAND`, `WorkerStatus.version?`
- `server/src/claudeCli.ts` — re-exports the shared types; `publicClaudeCliStatus`,
  `refreshClaudeCli`, the self-healing cache (`RETRY_FAILED_AFTER_MS`)
- `server/src/codexCli.ts` — the Codex mirror: `publicCodexCliStatus`, `refreshCodexCli`, the
  same self-healing cache
- `server/src/index.ts` — `buildHello` adds the owner-only `claudeCli`/`codexCli` fields; the
  15s re-probe loop that broadcasts `cliStatus` when either answer changes
- `server/src/workerProtocol.ts` — worker `hello` gains optional `appVersion?: string`
- `server/src/worker.ts` — reads its own `package.json` (or `__LINES_VERSION__`) into
  `appVersion`
- `server/src/workerClient.ts` — stashes `appVersion` from a successful hello, surfaces it on
  `status.version`, folds it into `sameStatus`

## Symbols

- `__LINES_VERSION__` — build-time constant, one per bundle (web, bridge, worker, desktop shell);
  each reads its own `package.json` at build/boot and falls back to this only when that read
  fails
- `publicClaudeCliStatus(status?)` / `publicCodexCliStatus(status?)` — the only paths
  `claudeCliStatus()`/`codexCliStatus()` may reach a client through; build the wire object
  field by field
- `WorkerClient.status` / `sameStatus` — worker link health, now version-aware
- `UpdatesSection`, `VersionRow`, `CliBadge` — the pane, its repeated row shape, and the
  shared not-ok badge both CLI rows use

## Data flow

`buildHello` (owner branch only) adds `claudeCli: publicClaudeCliStatus()` and
`codexCli: publicCodexCliStatus()` beside the existing `worker`/`update` fields. The worker's
`hello` gains `appVersion`, which `WorkerClient` stores and folds into the `WorkerStatus` it
already publishes on `onStatusChange` — no new `ServerMessage` variant, `worker.version` rides
the existing `WorkerStatus`. `web/src/store.ts` holds all of it per-machine in `MachineSlice`
and re-derives the primary machine's scalars
(`bridge`/`workerStatus`/`updateStatus`/`claudeCli`/`codexCli`) the same way it already did for
the first three. `UpdatesSection` reads these store values (`__LINES_VERSION__` is a
compile-time constant, not store state) and renders one `VersionRow` each.

**Self-healing.** `index.ts` runs a 15s interval that reads both `publicClaudeCliStatus()` /
`publicCodexCliStatus()`, and — only when the combined signature differs from the last
broadcast, and only after the first pass (which `hello` already covered) — sends
`{ type: 'cliStatus', claudeCli, codexCli }` to every context. Because a failed verdict is
cached for only `RETRY_FAILED_AFTER_MS`, this interval doubles as the mechanism that notices an
install: within one cache window the next probe reports `ok` and the next tick broadcasts it.
The web store applies `cliStatus` exactly like a `hello`'s fields (per-machine, `fromPrimary`
gated for the scalar reads), and the model picker's `warn` option
([model-selector](model-selector.md)) and the Updates pane both clear on their own.

## Tests

- `server/src/claudeCli.test.ts` — `publicClaudeCliStatus` never includes `path`; a missing CLI's
  wire copy omits `version` rather than sending it as `undefined`
- `server/src/workerClient.test.ts` — a worker restarting on a new build (same link, no outage)
  still publishes a status change, because `version` is now part of `sameStatus`; a worker too
  old to send `appVersion` reports `connected: true` with no `version` key at all
- `server/src/codexCli.test.ts` — a missing CLI is re-probed after `RETRY_FAILED_AFTER_MS` and
  reports `ok` once installed, without a restart; a working answer stays cached even after the
  binary is removed (mocked `Date`, not a real sleep)

## Business rules

- Versions shown: web, bridge, worker, desktop app, Claude CLI, Codex CLI. No other component
  gets a row.
- A CLI row that is not `ok` shows an install/update action: Claude's links out to
  `CLAUDE_INSTALL_URL`; Codex's is a **Copy install command** button
  (`CODEX_INSTALL_COMMAND`, `npm i -g @openai/codex`) rather than a link, since there is no
  single install page to send someone to. `VersionRow`'s version text is suppressed when an
  action is present — an em dash next to a fix action is noise, not information.
- A CLI status of `null` (a bridge too old to report it, or no `hello` yet) renders its own
  gray "not reported by this bridge" badge — **not** the same as `ok`. Collapsing the two would
  hide a genuinely missing CLI behind a bridge that simply predates the field.
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
- `claudeCli`/`codexCli`/`worker`/`update`/`bridge` are all owner-only and `fromPrimary`-gated
  in the store; a guest's `hello` never carries any of them, and the pane is unreachable to a
  guest regardless (`GUEST_SECTIONS` filters to `devices` only). `cliStatus` follows the same
  gating.
- `hello.claudeCli`/`hello.codexCli` never carry `path` — an absolute path to a CLI binary
  names the host's home directory and username. `publicClaudeCliStatus`/`publicCodexCliStatus`
  build the wire object field by field rather than spreading the bridge-local status,
  specifically so a future field added to the bridge-local shape cannot leak onto the wire by
  accident.
- Every new wire field (`hello.claudeCli`, `hello.codexCli`, worker `hello.appVersion`, and the
  `cliStatus` message type itself) is optional/additive, so none bumps `APP_PROTOCOL_VERSION`
  (browser↔bridge) nor the worker's `PROTOCOL_VERSION` — an older peer on either side simply
  omits the field or never sends the message, same precedent as `LiveSessionInfo.busy`.
- A failed CLI probe is cached for `RETRY_FAILED_AFTER_MS` (10s), not forever — the difference
  between "an install taken in response to this message lands within seconds" and "the picker
  stays wrong until the bridge restarts". A working answer has no such expiry; the probe spawns
  a subprocess and a CLI that exists does not usually disappear.

## Architectural rules

- `ClaudeCliState`/`ClaudeCliStatus` and `CodexCliState`/`CodexCliStatus` are declared in
  `shared/types.ts`, not `server/src/claudeCli.ts`/`codexCli.ts` — same reason `PLAN_DIR_MARKER`
  lives there: the browser needs the shape (and the install URL/command constants) without
  importing server code. Both server modules re-export their types so every existing importer
  is unaffected.
- The re-probe interval lives in `index.ts`, not inside `claudeCli.ts`/`codexCli.ts` — those
  modules only expose the cache and its `refresh*` escape hatch; deciding *when* to poll and
  *whether* to broadcast is the bridge's call, same separation `devReloadBlockers` keeps between
  a subsystem's own state and the process that watches it.
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
- [cross-provider-model-switching](cross-provider-model-switching.md) — the reason a missing
  Codex CLI needed a row and a self-healing probe: `switchProvider` refuses a switch on it, and
  the model picker's `warn` option needs the same status to explain itself before the click.
- [model-selector](model-selector.md) — the picker's `warn` option and its click-through to
  this pane.
