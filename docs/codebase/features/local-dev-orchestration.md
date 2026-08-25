# Local dev orchestration (Tilt)

## Purpose

`tilt up` runs the four local dev processes (worker, bridge, storage, web) as
supervised resources with readiness probes, a loud preflight instead of the
storage server's silent success-exit, automatic Prisma client generation, and
a live-togglable freeze on worker/bridge hot reload for dogfooding. `npm run
dev` (root `concurrently` script) remains a working fallback with no
preflight, no Prisma-generate step, and no per-process readiness signal.

## Entry points

- `Tiltfile` (repo root) — `tilt up`, `tilt args`, and the Freeze/Resume
  buttons in the Tilt UI

## Important files

- `Tiltfile` — resource graph, preflight, port injection, freeze/resume logic
- `.tiltignore` — excludes `**/node_modules/`, `.git/`, `web/dist/`, `**/.tilt/`
  from Tilt's file watch
- `.env.example` — documents that `PORT` must not be set there (read by both
  the bridge and the storage server from the same file); Tilt injects it per
  process instead
- `package.json`, `server/package.json`, `web/package.json`,
  `storage/package.json` — the `install` resource's watch set (workspace
  manifests only, see below); `server/package.json`/`storage/package.json`
  also supply the `dev`/`start` (watch vs. no-watch) script pairs the freeze
  toggle switches between

## Important symbols

- `frozen(name)` / `FROZEN` — resolved freeze state for `worker`/`bridge`
- `WORKER_CMD` / `BRIDGE_CMD` — the npm script each resource's `serve_cmd`
  runs, chosen by freeze state
- `tilt_args_argv(frozen_names)` — rebuilds the full `tilt args` flag list for
  a given freeze state (used by both the CLI flag and the UI buttons)
- `dotenv_keys` / `have` — preflight's key-name-only `.env` check
- `dotenv_value` / `RELAY_TARGET` / `LOOPBACK_RELAY` / `LOCK_PROBE` — the bridge-lock collision
  warning's helpers: `RELAY_URL`'s actual value (to tell a deployment from `--with-relay`'s
  loopback relay), and a `node -e` one-liner that parses/liveness-checks `~/.lines-app/bridge.lock`
  without ever failing the build on a stale or corrupt file

## Data flow

`config.parse()` reads CLI flags (`--no-storage`, `--with-studio`,
`--no-ui-buttons`, `--no-reload`) → resolved into `WITH_STORAGE`, `WITH_STUDIO`,
`WITH_BUTTONS`, `FROZEN` → these pick each resource's `serve_cmd` and gate
which resources are declared at all. Preflight reads `.env` key names (never
values) to decide whether `storage` is allowed to start; a missing key fails
loudly instead of the storage server's `process.exit(0)`.

Whether this bridge talks to a hosted install is **not** a Tilt flag — it
follows `RELAY_URL` in `.env`, which the bridge reads itself via its own
dotenv. `STORAGE_URL` is injected into `serve_env` only as a *default*
(`http://localhost:8790`); an explicit `.env` value overrides it, so a bridge
configured to dial a hosted relay does not end up syncing to a local storage
server instead. Running agent-only against a deployment is a resource-level
action (disable `web` and `storage` from the Tilt UI), not a flag.

## Dependencies

- Tilt v0.37.0+ (`version_settings(constraint='>=0.33.0')`)
- `ext://uibutton` (fetched from `github.com/tilt-dev/tilt-extensions` on
  first use, unless `--no-ui-buttons` is passed) for the Freeze/Resume reload
  buttons

## Tests

None — no infra test harness. Verified manually per the Tiltfile's own
comments (preflight negative test, watcher-ownership check, freeze workflow,
port isolation, `tilt down` orphan check).

## Business rules

- `tilt up` gates only `storage` on `.env` completeness
  (`DATABASE_URL`/`DIRECT_URL`/`CLERK_SECRET_KEY`); bridge/worker/web stay
  reachable even when storage config is missing, matching the app's
  best-effort storage design.
- Freezing worker or bridge reload means swapping which npm script the
  resource runs (`start` vs. `dev`/`dev:worker`), not changing Tilt's own
  watch behavior — Tilt does not watch source files for these resources.
- Toggling freeze (via `--no-reload` or a UI button) restarts that resource
  once, at the moment it's toggled; any in-flight agent turn on the worker
  does not survive that restart. The intended use is to freeze before a long
  turn starts, not mid-turn.
- Freezing worker while bridge stays hot, then editing `workerProtocol.ts`,
  produces a visible protocol-version mismatch in the bridge log until the
  worker is restarted by hand.
- `web` is excluded from the freeze options — Vite HMR patches modules in
  place and never restarts the dev server, so it can't drop an in-flight
  turn the way a worker/bridge process restart can.
- A pull that changes only `package-lock.json` triggers nothing; run `tilt
  trigger install` by hand.
- `pair-device` (`npm run pair -w server`) is always declared but never runs
  automatically (`auto_init=False`) — it is something you trigger when a
  pairing code has expired (15 minutes) or a machine was revoked, not a step in
  bringing the stack up. It is idempotent: once claimed it prints "already
  paired" and exits 0.
- `desktop-package` (`npm run package -w desktop`) is the same shape: manual,
  never a step in `tilt up`, and exists so the DMG build (see
  [desktop-app](desktop-app.md)) is discoverable from Tilt at all —
  the desktop app previously had no resource here.
- `RELAY_URL` set without `STORAGE_URL` warns rather than failing preflight: the
  bridge would dial a hosted relay while syncing to the local storage default,
  splitting one machine's data across two databases.
- When `RELAY_URL` in `.env` points at a non-loopback host (a real deployment, not
  `--with-relay`'s local relay) and `~/.lines-app/bridge.lock` already names a live process, the
  preflight warns rather than failing: naming the tray app by pid if it holds the lock (Tilt's
  bridge will take the machine over and the tray will pause), or naming any other holder
  (Tilt's bridge will refuse to start, exit 78) otherwise. A stale, absent, or unparseable lock is
  silent — a leftover file must never block `tilt up`. See
  [hosted-machine-access](hosted-machine-access.md#one-bridge-speaks-at-a-time).
- `LINES_INSTANCE` is not set anywhere in this Tiltfile, on purpose — despite comments elsewhere
  once claiming Tilt sets it to `dev`. `web/vite.config.ts` resolves `/__bridge` from the same
  variable, so pinning it for the bridge alone would stop the dev server finding it; a dev
  checkout runs under the unset default (`default`) the same as `npm run dev`.
- `--with-relay` alone still runs the relay with `RELAY_AUTH_DISABLED=1`: every client binds to
  one user as the machine's owner, so [session-collaboration](session-collaboration.md)'s guest
  gate never runs and no share can be exercised locally. `--relay-auth` leaves Clerk verification
  on instead, and preflight warns if it is missing `CLERK_SECRET_KEY`, `RELAY_SHARED_SECRET`, or
  `VITE_BRIDGE_WS_URL` (whose absence sends the browser straight to the bridge, bypassing the
  relay entirely, so a guest silently lands in a context of their own) — or if the relay is
  running auth-off while the browser is pointed at it, all of which otherwise present as an
  unexplained "connecting to your machine…" spinner rather than an error.

## Architectural rules

- No `deps=` on the four service resources (`worker`, `bridge`, `storage`,
  `web`). `tsx watch`/Vite own file-watching; adding Tilt-level `deps` would
  cause double-restart thrash and, for the worker specifically, would widen
  its restart trigger beyond its own files.
- `PORT` is injected per resource via `serve_env`, never a shared env block —
  the bridge and storage server default to different ports but read the same
  `.env` key, so a shared value would collide.
- Preflight reads `.env` key *names* only; no secret value is ever written
  into a Tilt spec, log, or UI button.
- The Freeze/Resume UI buttons and the `--no-reload` CLI flag are two entry
  points into the same state (`FROZEN`); the buttons work by re-invoking
  `tilt args` with the full current flag set recomputed, not by mutating
  Tilt state directly, since `tilt args` replaces the whole argument list.
- No resource watches a file its own `cmd` writes. `install`'s `deps` list the
  five workspace manifests but omit `package-lock.json`, which `npm install`
  itself rewrites — Tilt keeps file changes that land during a build as
  pending for the *next* build, so watching your own output retriggers a
  resource forever.
- `resource_deps` gates only the first build after `tilt up`; a later re-run
  of `install` does not cascade to `prisma-generate` or the four service
  resources.

## Related decisions

- [session-collaboration](session-collaboration.md) — why sharing needs `--relay-auth`, not just
  `--with-relay`.
