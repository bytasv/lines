# Desktop packaging

## Purpose

Turns the menu-bar shell into a `.dmg` a non-developer installs from the hosted app. The
shell itself is older than this (see `desktop-shell.md`); what packaging adds is the ability to
run **away from a repo checkout** — no `tsx`, no repo-root `.env`, no `node_modules`.

Three decisions shape everything here, and each is a trade recorded below: the build is ad-hoc
signed (no Apple Developer ID), the Claude Code CLI is *not* bundled, and the agent SDK is
shipped unbundled next to the code.

## Entry points

- `desktop/scripts/build.mjs` — the three esbuild bundles, the pruned SDK tree, `config.json`
- `desktop/scripts/afterPack.mjs` — ad-hoc signs the packed bundle
- `desktop/scripts/release.mjs` — uploads artifacts to the public R2 bucket
- `desktop/package.json` — the `build` block (electron-builder config) and `package`/`release` scripts

## Important files

- `desktop/src/config.ts` — reads `Resources/config.json`, env vars override
- `server/src/claudeCli.ts` — finds the machine's `claude`, with a version floor
- `desktop/assets/` — `trayTemplate.png` (+`@2x`), `icon.icns`, `icon.png`
- `deploy/README.md` — the release procedure and the two-bucket rule

## Important symbols

- `MIN_CLAUDE_VERSION` (`claudeCli.ts`) — the CLI version the pinned SDK wrapper ships
- `claudeCliStatus()` / `refreshClaudeCli()` — cached discovery; the tray's "Check again" refreshes
- `claudeCliRefusalMessage()` — the sentence a hosted user sees when the CLI is missing or old
- `loadConfig()` / `isLocalMode()` (`desktop/src/config.ts`)
- `CAN_SELF_INSTALL` (`desktop/src/main.ts`) — false until a Developer ID exists

## Data flow

`npm run package -w desktop` runs `build.mjs`, then electron-builder.

`build.mjs` emits `dist/main.cjs` (CJS, the Electron main process) plus `dist/server/bridge.mjs`
and `dist/server/worker.mjs` (ESM). It copies `@anthropic-ai/claude-agent-sdk` and its
dependency walk into `dist/server/node_modules`, and writes `dist/config.json` from any
`LINES_*` env vars set at build time.

electron-builder packs `dist/main.cjs` into the asar, copies `dist/server`, `dist/config.json`
and the tray assets to `Resources/`, runs `afterPack.mjs`, then builds the DMG and the zip.

At runtime `main.ts` resolves `ROOT` to `process.resourcesPath` when packaged (the repo root
otherwise) and spawns `Resources/server/{bridge,worker}.mjs` with Electron's own node via
`ELECTRON_RUN_AS_NODE=1`. Every `query()` is handed `pathToClaudeCodeExecutable` from
`claudeCliStatus()`.

## Dependencies

- `electron-builder` (DMG/zip, `latest-mac.yml`), `electron-updater` (checks only)
- `esbuild` — already used for the shell bundle
- The R2 credentials that `storage/src/r2.ts` uses, plus a second bucket

## Tests

- `server/src/claudeCli.test.ts` — discovery order, the exclusive env override, `--version`
  parsing against real executables, the version floor
- `server/src/sessions.claudeCli.test.ts` — a push carries `pathToClaudeCodeExecutable`; a
  missing CLI refuses the turn with the install message

No harness covers the packaging scripts or the shell — verified by building and installing.

## Business rules

- **Hosted is the default.** Local mode (own web server, own window) needs `LINES_LOCAL_MODE=1`,
  which the `dev` script sets. `web/dist` is not in the DMG.
- A missing or too-old CLI refuses the turn with an actionable sentence, in the browser and in
  the tray — never a raw SDK error.
- `LINES_CLAUDE_PATH` is exclusive: set it, and no other location is tried.
- Update checks only notify. The tray links the download page.

## Architectural rules

- **`identity: null` does not ad-hoc sign.** electron-builder skips bundle signing entirely
  (`skipped macOS code signing`). What remains is the linker's ad-hoc signature on the Mach-O,
  which declares sealed resources while nothing seals them — no `Contents/_CodeSignature/
  CodeResources`. macOS calls that **"Lines is damaged and can't be opened"**, and unlike the
  unidentified-developer case it offers *no* Open Anyway button, so the download is a dead end
  by every route. `afterPack.mjs` exists solely to seal the bundle, and it verifies afterwards so
  a broken bundle fails the build. This shipped once; the verify step is why it cannot again.
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
