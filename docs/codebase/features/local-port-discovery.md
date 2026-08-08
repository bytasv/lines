# Local port discovery

## Purpose

Nothing hardcodes a local port. The worker and the bridge each bind an ephemeral
port and publish it to `~/.lines-app/run/<instance>/<name>.json`; whoever needs to
reach them reads (and watches) that file.

Fixed ports were already wrong before this: `worker.ts` retried `EADDRINUSE` on the
*same* port twenty times rather than picking a free one, so running a dev checkout
alongside a second Lines install left one of them spinning forever. Once Lines ships
as something users install, that stops being a dogfooding annoyance.

The discovery file also carries a per-boot token, which closes a gap that had been
open since the bridge/worker split: the worker's WebSocket had no authentication at
all and was protected only by its `127.0.0.1` binding — which does not protect
against another process, or another OS user's process, on the same machine.

## Entry points

- `server/src/worker.ts` — `listen()` publishes `worker.json` from the bound port
- `server/src/index.ts` — `listen()` publishes `bridge.json`
- `server/src/workerClient.ts` — reads and watches `worker.json` to dial the worker
- `web/vite.config.ts` — dev-only `/__bridge` endpoint handing the port to the browser

## Important files

- `server/src/workerProtocol.ts` — every helper, plus `APP_ROOT`
- `server/src/store.ts` — re-exports `APP_ROOT`, owns every path *under* it
- `web/src/ws.ts` — `initBridgeOrigin()` and the `bridgeOrigin` the HTTP routes use
- `Tiltfile` — pins both ports so its readiness probes have fixed targets
- `.env.example` — `LINES_BRIDGE_PORT`, `LINES_WORKER_PORT`, `LINES_INSTANCE`

## Important symbols

- `RuntimeInfo` — `{ port, pid, startedAt, protocolVersion, token }`
- `publishRuntimeInfo(name, info)` — atomic (temp + rename), mode `0600`
- `readRuntimeInfo(name)` — null when missing, unparseable, or naming a dead pid
- `clearRuntimeInfo(name)` — best-effort removal on clean exit
- `watchRuntimeInfo(name, onChange)` — watches the *directory*, returns a disposer
- `WORKER_TOKEN_HEADER` (`x-lines-worker-token`) — carries the token on connect
- `WorkerClient.dispose()` — releases socket, watcher, and retry chain
- `INSTANCE` / `RUNTIME_DIR` — resolved once, at module load

## Data flow

Worker: bind `:0` → `listening` → publish `worker.json` with the bound port and a
fresh `bootToken` → `clearRuntimeInfo` on `SIGINT`/`SIGTERM`/`exit`.

Bridge: `WorkerClient` reads `worker.json`, dials `ws://127.0.0.1:<port>` with the
token in a header, and `watchRuntimeInfo` re-dials the moment the worker republishes
on a new port. No file, or a file naming a dead pid, means "worker down or still
booting" — retry. The bridge publishes `bridge.json` the same way.

Browser (dev): the Vite plugin reads `bridge.json` per request and serves
`{ "port": … }` at `/__bridge`; `initBridgeOrigin()` resolves it once before render,
and `connect()` re-resolves on every attempt so a restarted bridge is found again.
A hosted build sets `VITE_BRIDGE_WS_URL` and never probes.

## Dependencies

`workerProtocol.ts` uses only `node:fs`/`os`/`path`/`crypto`, so it stays inside the
worker's deliberately-minimal import graph.

## Tests

- `server/src/portDiscovery.test.ts` — round-trip, `0600`, no temp files left,
  dead-pid unlink, unparseable/partial files, independence of the two names
- `server/src/workerHandshake.test.ts` — spawns a real worker: ephemeral bind and
  publish, hello on the right token, `1008` on a wrong or absent one, and that a
  rejected dial does not evict the live bridge
- `server/src/workerClient.test.ts` — outage detection against a fake worker

## Business rules

- The default is ephemeral. `LINES_WORKER_PORT` / `LINES_BRIDGE_PORT` pin a port only
  when explicitly set; Tilt sets both so its readiness probes have fixed targets.
- `LINES_INSTANCE` separates concurrent installs. Tilt sets `dev`, so a dev checkout
  and an installed app never publish over each other.
- The worker rejects any connection that cannot echo the published token, and checks
  this *before* the newest-bridge-wins takeover — otherwise any local process could
  terminate the real bridge just by connecting.
- A discovery file naming a dead pid is removed on read, not merely ignored.
- `PORT` now belongs to the storage server alone; bridge and worker no longer read it,
  so the collision that `.env.example` used to warn about is gone.

## Architectural rules

- The helpers live in `workerProtocol.ts`, not a module of their own: port discovery
  *is* part of the bridge↔worker contract, and a separate file would widen the
  worker's `tsx watch` restart trigger for no benefit.
- `APP_ROOT` is defined there and re-exported by `store.ts` — the worker needs it and
  cannot import `store.ts` without dragging the whole bridge graph along.
- Publishing is atomic (temp + rename) so a reader never sees a partial file, and
  `0600` so the token stays private to this OS user.
- `watchRuntimeInfo` watches the directory, not the file: publishing renames over the
  target, so a file watch would follow the replaced inode.
- Timers and watchers are released via `WorkerClient.dispose()` rather than `unref()`.
  `unref()` makes a timer invisible to node's mock timers, and the retry chain re-arms
  forever while the worker is down, so a short-lived consumer needs a real disposer.
- The bridge's token is published but **not** enforced on browser connections: a
  browser cannot set headers on a WebSocket, so the Clerk gate guards that path. The
  `/__bridge` endpoint exposes only the port, never the token.
- A live `ws` socket and node's mock timers cannot be mixed — `ws` schedules its own
  real timers, and faking the clock underneath corrupts node's timer list when the
  socket closes. Tests compress the client's intervals instead.

## Related decisions

None recorded.
