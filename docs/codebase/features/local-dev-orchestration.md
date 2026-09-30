# Local development orchestration

## Purpose

`tilt up` runs separate worker and bridge resources, web, and optional storage/relay
services with readiness probes, environment preflight, and Prisma generation. Each
backend resource has its own stable runner and process ownership. `npm run dev`
uses the same runners; `npm run dev:backend` starts just the pair.

Backend source edits no longer restart a live agent. The supervisor builds a saved
code generation, waits until every session is idle, and reloads worker and bridge
together. Vite continues to handle web HMR independently.

## Safe reload behavior

- `server/scripts/dev-runtime.mjs worker` coordinates reloads; the `bridge` runner
  owns only the bridge. Both remain outside source watching. The worker copies `server/src`, shared code, and package metadata into
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
- The worker runner refuses to overwrite a live worker's discovery record.
- Each runner starts a small `dev-process.mjs` guard in a private process group.
  The guard forwards IPC and owns the service and its ordinary descendants. On
  graceful termination or runner IPC loss, it sends SIGTERM and performs a final
  SIGKILL group sweep after two seconds. Runners also detect parent loss. Supervised
  services reuse normal shutdown on IPC disconnect, including persistence and
  discovery cleanup. Explicit shutdown ends active work; idle protection applies
  only to automatic reloads. `tilt down` sends authenticated shutdown requests to
  the checkout-local runners, stopping coordination before the bridge.
- Stopping the worker resource does not stop the bridge resource, and vice versa.
  A returning worker coordinator adopts the live bridge's generation before
  considering pending edits. An unavailable peer blocks automatic reloads.

## Forced restart

The automatic idle-boundary reload can starve indefinitely on a real machine: a workflow step
parked at `waiting-approval` counts as active session state, and one such session anywhere on
the machine holds every pending edit behind it — potentially for days. `restart-backend`
(`Supervisor.forceReload`, wired to a manual Tilt resource and a **Rebuild + restart backend**
button on both the `worker` and `bridge` resources) is the deliberate way through: it rebuilds
from current source and cycles worker and bridge as a pair *without* waiting for idle. In-flight
turns die — that is the whole trade, and it is why this is a manual action, never automatic.

It still adopts the pairing rule everything else in this file relies on: it runs with
`phase: 'reloading'`, never `'starting'`, which is what stops `WorkerRunner.startPair` from
adopting the bridge's already-running (and, here, deliberately stale) generation — the same trap
that otherwise makes "restart the worker resource, then the bridge resource" independently do
nothing. A failed candidate restores the previously running generation, the same rollback
`reload()` performs.

While it runs, the supervisor's own crash recovery is paused, and a candidate
rejected earlier is retried. Otherwise recovery would restart the stopped children
on the old generation and the restart would silently roll back. A restart that
does roll back fails loudly with the rejection reason instead of reporting success.

**The command only trusts a real restart, not a 200.** The control route answers with a
`restarted: true` handshake field; a supervisor from before this route existed answers an
unknown URL with its plain state and a 200 anyway, which is otherwise indistinguishable from
success. `restartCommand` treats a missing handshake as a hard failure with a message telling
the user to cycle the supervisor by hand once (`tilt down` / `tilt up`, or restart the dev
terminal) — after that, the command works from a warm start every time.

## Controls and shutdown

The default is automatic protection. No per-turn freeze step is needed.

```sh
npm run dev:backend
node server/scripts/dev-runtime.mjs status
node server/scripts/dev-runtime.mjs freeze all
node server/scripts/dev-runtime.mjs resume all
```

Tilt's worker and bridge resources both have Freeze and Resume buttons. Both send control commands;
neither changes `serve_cmd` or restarts a process. Resume still waits for idle.
`--no-reload worker`, `--no-reload bridge`, and `--no-reload all` remain accepted.
Either backend hold pauses the coordinated pair. CLI policy changes run through
Tilt's `reload-policy` resource, separately from the backend serve specification.
Buttons do not rewrite Tilt arguments, so flags such as `--relay-auth` are preserved.
`--no-ui-buttons` works offline without fetching the UI-button extension.

**Re-enabling a disabled resource.** Tilt's per-resource disable is genuinely useful (running
agent-only against a deployment means disabling `web`/`storage`), but a disabled resource takes
its own buttons with it — including, for anything else disabled the same way, any affordance
that would turn it back on. `enable-all` (`tilt enable --all`, manual, plus an **Enable all
resources** button) lives on `preflight` specifically because that resource holds no process and
nothing has a reason to disable it — it is the one place a way back survives whatever else was
switched off. It is all-or-nothing; narrowing it to specific resources or labels is a possible
follow-up, not built.

Restart Tilt once idle to replace the old combined `backend` resource. There is
no legacy-resource switching. Old orphaned processes are not adopted or killed
by discovery-file PID alone; stop their owning stack before starting the new one.
The standalone `server` workspace's old `dev` and `dev:worker` scripts remain
unsupervised watch commands for compatibility, not the protected entrypoints.

`node server/scripts/dev-runtime.mjs status`, the worker log, and the bridge status
response expose the running generation, pending generation, freeze state, blockers,
and build/recovery errors. The controller binds loopback and requires a random token
stored in a mode-0600 control file. That token is not included in status output.

## Other Tilt behavior

- Ports remain worker 8788, bridge 8787, storage 8790, relay 8791, web 5173,
  and optional Prisma Studio 5555. Each runner passes its resource environment
  to its own service; `LINES_DEV_CHECKOUT` keeps dotenv resolution at the original
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
  is enabled. Pairing stays available on the bridge resource.

## Limits

This protects source edits, not dependency installation, environment changes,
database migrations, deliberate process termination, or arbitrary behavioral bugs
that pass startup checks. Run dependency changes when idle. A healthy-but-wedged
process is not killed automatically when the supervisor cannot prove its work is idle.
Supervisor code itself takes effect at the next normal development-stack restart.

## Validation

- `server/scripts/dev-runtime.test.mjs`: isolated process fixtures exercise immutable
  local imports, busy deferral, Freeze/Resume PID stability, paired reload, failed
  builds, startup rollback, preparation races, stale activity, bridge-only recovery, a
  forced restart cycling the pair while work is live, a forced restart whose new build
  will not start restoring the working one, and a restart request against a supervisor
  too old to answer the handshake failing loudly rather than reporting false success.
- `server/src/devRuntime.test.ts`: real IPC preparation and activation, asynchronous
  activity accounting, session blockers, and ordered worker replay without duplicates.
- Existing session/worker tests verify persistence, queued work, provider reconciliation,
  permissions, and reconnect behavior. Process fixtures do not spend provider credits.

The process suite also checks independent resource stop/re-enable, coordinator
restart, SIGINT/SIGTERM/SIGKILL ownership loss, stubborn descendants, released
listening ports, and shutdown during startup/reload. Fixtures use temporary state
and never connect to providers. Set `LINES_TEST_TILT=1` when running the process
suite to include real Tilt startup, resource disable/re-enable, Ctrl-C, abrupt
termination, and `tilt down` smoke tests.

See [session collaboration](session-collaboration.md) for relay sharing and
[desktop app](desktop-app.md) for packaged runtime ownership.

[Cross-provider model switching](cross-provider-model-switching.md) is unrelated to this
file's mechanism but is why the forced-restart resource exists: it and the CLI-status
self-heal both needed a way to get a running dev stack onto new server code without
waiting for the automatic idle boundary.
