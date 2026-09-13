# Local development orchestration

## Purpose

`tilt up` runs the backend, web, and optional storage/relay services with readiness
probes, environment preflight, and Prisma generation. The backend supervisor owns
both worker and bridge. `npm run dev` uses the same supervisor; `npm run dev:backend`
starts only the backend.

Backend source edits no longer restart a live agent. The supervisor builds a saved
code generation, waits until every session is idle, and reloads worker and bridge
together. Vite continues to handle web HMR independently.

## Safe reload behavior

- `server/scripts/dev-runtime.mjs` is a stable parent process, outside source watching.
  It copies `server/src`, shared code, and package metadata into
  `.cache/dev-runtime/generations/<hash>`. Each generation resolves `@lines/shared`
  to its own copy. The MCP stdio helper also runs from that generation. Third-party
  packages remain shared with the installed `node_modules`.
- After 500 ms without edits, esbuild validates the local import graph. A syntax or
  import failure leaves the running generation untouched. The actual processes run
  through tsx without watch mode, retaining per-module paths and useful stack traces.
- A reload requires two seconds of confirmed idle across both processes. Turns,
  permission waits, workflow approval waits, queued prompts, background tasks,
  outstanding RPCs, authentication holds, helper queries, and scheduled workflow
  continuations block it. Missing or stale activity also blocks reload.
- The private Node IPC channel in `server/src/devRuntime.ts` closes bridge admission
  before preparing the worker, then rechecks the bridge for messages that arrived
  during preparation. A failed preparation reopens admission without
  restarting either process. Prompts refused during handover return an explicit
  error and their content to the browser's composer/draft; they are not executed.
- The bridge flushes session persistence before shutdown. The next worker and
  bridge must report readiness and a compatible handshake before admission reopens.
  A previously connected relay must reconnect for a candidate to pass readiness.
  Each startup readiness wait allows 15 seconds.
- A failed candidate restores the previous working generation. The failed content
  hash is quarantined for the supervisor's lifetime; editing the code produces a
  new candidate. The last healthy generation is saved for the next supervisor boot.
- A crashed bridge restarts from the current generation without killing its worker.
  Its worker snapshot, buffered events, RPCs, cancellations, and end notifications
  wait for activation and replay once in arrival order. Deferred messages also
  block reload, so a reconnect cannot start work inside a prepared handover.
  A crashed worker restarts from the same code; the existing reconciliation path
  handles interrupted sessions. A worker crash cannot preserve an in-flight turn.
- The supervisor refuses to overwrite a live worker's discovery record, including
  orphaned children left by a lost supervisor. Closing the supervisor's IPC channel
  does not kill a running agent.

## Controls and migration

The default is automatic protection. No per-turn freeze step is needed.

```sh
npm run dev:backend
node server/scripts/dev-runtime.mjs status
node server/scripts/dev-runtime.mjs freeze all
node server/scripts/dev-runtime.mjs resume all
```

Tilt's backend resource has Freeze and Resume buttons. Both send control commands;
neither changes `serve_cmd` or restarts a process. Resume still waits for idle.
`--no-reload worker`, `--no-reload bridge`, and `--no-reload all` remain accepted.
Either backend hold pauses the coordinated pair. CLI policy changes run through
Tilt's `reload-policy` resource, separately from the backend serve specification.
Buttons do not rewrite Tilt arguments, so flags such as `--relay-auth` are preserved.
`--no-ui-buttons` works offline without fetching the UI-button extension.

Installing this change into an already running legacy Tilt stack preserves its
existing worker and bridge resources. Once current work is idle, stop Tilt and
start it again to activate the supervisor. This is a one-time migration; hot-swapping
ownership of the old worker would itself kill the session being protected.
The standalone `server` workspace's old `dev` and `dev:worker` scripts remain
unsupervised watch commands for compatibility, not the protected entrypoints.

`node server/scripts/dev-runtime.mjs status`, the backend log, and the bridge status
response expose the running generation, pending generation, freeze state, blockers,
and build/recovery errors. The controller binds loopback and requires a random token
stored in a mode-0600 control file. That token is not included in status output.

## Other Tilt behavior

- Ports remain worker 8788, bridge 8787, storage 8790, relay 8791, web 5173,
  and optional Prisma Studio 5555. The supervisor passes backend environment values
  to both children; `LINES_DEV_CHECKOUT` keeps dotenv resolution at the original
  checkout. No environment files are copied into generations.
- Preflight checks `.env` key names, not secret values. Missing storage settings
  can be bypassed with `--no-storage`; the backend and web remain independently useful.
- `STORAGE_URL` defaults to local storage only when unset. `RELAY_URL` otherwise
  follows `.env`; `--with-relay` overrides it with the local relay. Session sharing
  requires `--relay-auth`, Clerk configuration, and a paired device. The synthetic
  local device credential is only used without relay authentication.
- Existing bridge-lock takeover/refusal rules remain in force. A deployed relay
  must use storage from the same deployment.
- Source files are not Tilt service dependencies. The supervisor owns backend
  watching, Vite owns web HMR, and tsx owns storage/relay watching. `.cache` is excluded
  from Tilt watching to avoid generation build loops.
- Install watches package manifests, not its own rewritten lockfile. After a pull
  changing only `package-lock.json`, trigger install manually. `resource_deps` gates
  initial startup; later installs do not cascade into service restarts.
- Typecheck, tests, database migration, pairing, desktop packaging, and optional
  Prisma Studio remain manual resources. Prisma generation is automatic when storage
  is enabled. Pairing stays available on the backend resource.

## Limits

This protects source edits, not dependency installation, environment changes,
database migrations, deliberate process termination, or arbitrary behavioral bugs
that pass startup checks. Run dependency changes when idle. A healthy-but-wedged
process is not killed automatically when the supervisor cannot prove its work is idle.
Supervisor code itself takes effect at the next normal development-stack restart.

## Validation

- `server/scripts/dev-runtime.test.mjs`: isolated process fixtures exercise immutable
  local imports, busy deferral, Freeze/Resume PID stability, paired reload, failed
  builds, startup rollback, preparation races, stale activity, and bridge-only recovery.
- `server/src/devRuntime.test.ts`: real IPC preparation and activation, asynchronous
  activity accounting, session blockers, and ordered worker replay without duplicates.
- Existing session/worker tests verify persistence, queued work, provider reconciliation,
  permissions, and reconnect behavior. Process fixtures do not spend provider credits.

Validated with 1,105 server tests plus six supervisor process tests, server/web
typechecks, and Tilt evaluation in automatic and frozen modes. Freeze leaves the
backend deployment specification identical; relay authentication and offline-button
configuration remain supported.

See [session collaboration](session-collaboration.md) for relay sharing and
[desktop app](desktop-app.md) for packaged runtime ownership.
