# Hosted machine access

Covers: `device-pairing`, `hosted-device-gate`, `browser-bridge-link`,
`local-port-discovery`, `remote-relay-bridge`.

## Purpose

The whole path from a browser anywhere to an agent running on the user's own machine: how a
client finds a bridge, what contract the two speak, how a machine is bound to an account, how a
relay pipes frames between them, and the UI that gates all of it.

- **Local port discovery** — nothing hardcodes a local port. The worker and the bridge each bind
  an ephemeral port and publish it to `~/.lines-app/run/<instance>/<name>.json`; whoever needs to
  reach them reads (and watches) that file. Fixed ports were already wrong before this:
  `worker.ts` retried `EADDRINUSE` on the *same* port twenty times rather than picking a free
  one, so running a dev checkout alongside a second Lines install left one of them spinning
  forever. The discovery file also carries a per-boot token, which closes a gap open since the
  bridge/worker split: the worker's WebSocket had no authentication at all and was protected only
  by its `127.0.0.1` binding — which does not protect against another process, or another OS
  user's process, on the same machine.
- **Browser–bridge link** — the contract between a browser connection and the bridge: what the
  bridge is allowed to call on a connection, how it protects itself from a slow client, and how
  the two sides discover they speak different versions. Groundwork for hosting Lines remotely:
  `handleConnection` took a concrete `ws.WebSocket` so nothing else could be handed to it,
  `broadcast` sent unconditionally into an unbounded send buffer (invisible on loopback,
  unbounded memory growth over a network), and the two halves always deployed together so
  neither could say which contract it spoke.
- **Remote relay bridge** — lets a hosted web app drive the agent on a user's own machine. The
  bridge dials **out** to a relay; the browser connects to the same relay; the relay pipes frames
  between them. Outbound-only is the whole point: the user's machine accepts no inbound
  connection, needs no port forwarding, no NAT or firewall change, and no dynamic-DNS. It also
  works from a phone, or from a second machine, which a browser-to-localhost scheme cannot.
  Execution stays local — the bridge, the worker, the filesystem, `git`, and the Claude OAuth
  token are all exactly where they were; only the browser moved.
- **Device pairing** — binds a machine (a bridge, running under a tray app or Tilt) to a Clerk
  user, so the relay knows which browser connections may reach it. Pairing exists because the
  relay must refuse two things by default: an unclaimed machine reachable by anyone, and a
  claimed machine reachable by the wrong user. Only a hash of the machine's pairing secret ever
  reaches Postgres. The plaintext is generated on the machine and never leaves it, so a database
  compromise cannot yield anything that can impersonate a device — the same argument that lets a
  password hash live in a database.
- **Hosted device gate** — in a hosted build, gates the app behind "which of my machines am I
  talking to": lists paired machines, lets the signed-in user pair a new one or switch between
  them, and re-gates automatically if the machine in use is revoked or disconnects with an
  auth-shaped close. Renders a diagram explaining the split (browser ↔ relay ↔ user's own
  machine) at the one moment a user has to understand why a website is asking them to run
  something locally, and links to the installable desktop app so that "run something locally"
  has a one-click answer rather than a repo checkout. Inert in a local (non-hosted) build: gated
  entirely on `VITE_STORAGE_URL` being set at build time, since a local bridge is the only
  machine there is and nothing to pick between.

## Entry points

- `server/src/worker.ts` — `listen()` publishes `worker.json` from the bound port
- `server/src/index.ts` — `listen()` publishes `bridge.json`; `handleConnection`, the `hello`
  payload; the `RELAY_URL` block wiring channels to `handleConnection`
- `server/src/workerClient.ts` — reads and watches `worker.json` to dial the worker
- `web/vite.config.ts` — dev-only `/__bridge` endpoint handing the port to the browser
- `server/src/userContext.ts` — `broadcast`
- `web/src/ws.ts` — the client's `hello` handling
- `relay/src/index.ts` — `/agent` (bridge dials in) and `/client` (browser)
- `server/src/relayClient.ts` — the outbound dialler
- `storage/src/index.ts` — `POST /v1/devices/register`, `POST /v1/devices/claim`,
  `GET /v1/devices`, `PATCH /v1/devices/:id`, `DELETE /v1/devices/:id`,
  `POST /v1/devices/verify`, `POST /v1/devices/unpair`
- `server/src/device.ts` — `deviceIdentity`, `registerDevice`, `unpairDevice`; shared by the
  desktop app and `npm run pair -w server`
- `server/scripts/pair-device.ts` — CLI/Tilt entry point that calls the above and prints the
  pairing code
- `web/src/main.tsx` — `DeviceGate`, the component the gate hangs off
- `web/src/components/SettingsModal.tsx` — the `devices` section (`Machines`)
- `web/src/components/DownloadDesktopApp.tsx` — the install surface shown on `ConnectMachine`,
  `DevicesSection`, and reachable from the stuck-connecting screen

## Files

- `server/src/workerProtocol.ts` — every port-discovery helper, plus `APP_ROOT`
- `server/src/store.ts` — re-exports `APP_ROOT`, owns every path *under* it
- `web/src/ws.ts` — `initBridgeOrigin()` and the `bridgeOrigin` the HTTP routes use;
  `setDeviceId`/`switchDevice`/`reconnectNow`, the device param on the socket URL, the 1008
  retry/re-check path, and the relay control frames
- `Tiltfile` — pins both ports so its readiness probes have fixed targets; the opt-in `relay`
  resource; the `pair-device` resource
- `.env.example` — `LINES_BRIDGE_PORT`, `LINES_WORKER_PORT`, `LINES_INSTANCE`;
  `RELAY_AGENT_PING_MS`, `RELAY_AGENT_DEAD_MS`, `RELAY_REVERIFY_MS`, `LINES_RELAY_IDLE_MS`
- `server/src/userContext.ts` — `BrowserLink`, `linkSendAction`, `broadcast`
- `server/src/index.ts` — `BRIDGE_VERSION`, per-socket handlers, `claimBridgeLock`/
  `releaseBridgeLock`/`resolveRelayIdentity`, the single-instance `bridge.lock`,
  `EXIT_BRIDGE_LOCK_HELD`, `LINES_ALLOW_MULTIPLE_BRIDGES`
- `shared/types.ts` — `APP_PROTOCOL_VERSION`, `BridgeInfo`, `hello.bridge`
- `web/src/store.ts` — `bridge`, `protocolSkew` (both primary-machine-scoped; see
  [multi-machine-client](multi-machine-client.md))
- `web/src/components/SkewBanner.tsx` — the pill `protocolSkew` drives (see Data flow)
- `relay/src/protocol.ts` — frames, shared by both ends
- `relay/src/mux.ts` — `DeviceHub`, `HubRegistry`: pairing and routing, transport-free;
  `DeviceHub.ownerId`; `HubRegistry.drop`, whose caller is the re-verify tick
- `server/src/relayClient.ts` — `RelayChannel` (a `BrowserLink`), reconnect, channel lifecycle,
  the idle watchdog on its own socket, the duplicate-`open` guard, the supersede-count log, the
  supersede circuit breaker (`RELAY_STABLE_MS`/`SUPERSEDE_LIMIT`/`SUPERSEDE_CAP_MS`)
- `storage/prisma/schema.prisma` — the `Device` model
- `storage/src/index.ts` — the six device routes, plus CORS and the unauthenticated-path
  allowlist that fronts them
- `relay/src/index.ts` — calls `verify`, sets `hub.ownerId`; the per-agent ping/reap interval and
  the re-verify tick that rides it
- `server/src/device.ts` — identity minting/registration, shared to avoid a second
  implementation drifting on the credential format
- `web/src/lib/devices.ts` — `useDevices`, the shared machine-list store
- `web/src/lib/storage.ts` — `listDevices`/`claimDevice`/`renameDevice`/`revokeDevice`,
  `chooseDevice`, remembered-device persistence, `DESKTOP_DOWNLOAD_URL`
- `web/src/lib/wake.ts` — `bootDial`, the optimistic pre-list dial decision the gate makes at boot
  (see Data flow); `wakeAction`/`probeExpired`/`wakeDebounced` live in the same file but belong to
  [multi-machine-client](multi-machine-client.md)
- `web/src/components/ConnectMachine.tsx` — pairing screen and its loading/error siblings
- `web/src/components/ChooseMachine.tsx` — the first-visit machine list, shown before anything
  connects
- `web/src/components/ConnectingMachine.tsx` — shown between "device chosen" and the bridge's
  first `hello`; offers the escalating way out once that takes too long, or at once when the relay
  says the machine is offline
- `web/src/components/DownloadDesktopApp.tsx` — the DMG link and the Gatekeeper steps an ad-hoc
  signed build forces
- `web/src/components/GateShell.tsx` — chrome (header + sign-out) shared by every pre-app screen
- `web/src/components/PairingDiagram.tsx` — the explainer SVG
- `web/src/components/DevicesSection.tsx` — the Settings pane: list, pair, switch, revoke, share
  (see [session-collaboration](session-collaboration.md) for the share flow itself)

## Symbols

- `RuntimeInfo` — `{ port, pid, startedAt, protocolVersion, token }`
- `publishRuntimeInfo(name, info)` — atomic (temp + rename), mode `0600`
- `readRuntimeInfo(name, instance?)` — null when missing, unparseable, or naming a dead pid;
  `instance` defaults to the caller's own and is only overridden to cross-check *another*
  install's published runtime file (the bridge lock's preempt check)
- `clearRuntimeInfo(name)` — best-effort removal on clean exit
- `watchRuntimeInfo(name, onChange)` — watches the *directory*, returns a disposer
- `WORKER_TOKEN_HEADER` (`x-lines-worker-token`) — carries the token on connect
- `WorkerClient.dispose()` — releases socket, watcher, and retry chain
- `INSTANCE` / `RUNTIME_DIR` — resolved once, at module load
- `BrowserLink` — the whole surface the bridge uses on a connection:
  `send`/`close`/`terminate`/`on('message'|'close'|'error')`/`readyState`/`bufferedAmount`
- `LINK_OPEN` — `WebSocket.OPEN` inlined, so implementations need no `ws` import
- `linkSendAction(msg, bufferedAmount)` — `'send' | 'skip' | 'close'`
- `APP_PROTOCOL_VERSION` / `BridgeInfo` / `hello.bridge`
- `protocolSkew` — set when the bridge's contract differs from this client's `APP_PROTOCOL_VERSION`;
  drives `SkewBanner`, ranked directly below `ConnectionBanner` in the pill precedence chain (see
  [turn-recovery](turn-recovery.md))
- `RELAY_PROTOCOL_VERSION` — frames only; the app messages inside are versioned separately by
  `APP_PROTOCOL_VERSION`
- `DeviceHub.attachAgent` / `detachAgent` / `openChannel` / `fromClient` / `fromAgent`
- `RelayClient` — dial, backoff, dispatch
- `RelayChannel` — one browser, presented to the bridge as a `BrowserLink`
- `AttestedIdentity` — the userId the relay vouched for
- `Device` — `id`, `userId` (null until claimed), `name`, `platform`, `secretHash`,
  `pairingCode`, `pairingExpiresAt`, `appProtocol`, `revokedAt`
- `DeviceHub.ownerId` — the userId learned when a bridge last authenticated on this device;
  `null` until a bridge has ever attached
- `deviceIdentity()` — loads `~/.lines-app/device.json` or mints one; a corrupt file is treated
  as a new machine rather than a fatal error
- `unpairDevice(storageUrl, identity)` — the machine releasing itself, proving possession of its
  own secret; issues no code, so `registerDevice` stays the only thing that mints one
- `machineOffline` (in `web/src/store.ts`) — set by the relay's `deviceOffline`/`deviceOnline`
  control frames, cleared on `hello` and by `clearBootstrap()`; surfaced by `ConnectionBanner`
  even after bootstrap, not just by the pre-`hello` `ConnectingMachine` screen
- `reconnectNow()` — re-dial the current machine immediately; `switchDevice` cannot serve this
  because it early-returns when the device id is unchanged. No longer the only non-heartbeat
  redial path: a resumed tab's wake probe (see [multi-machine-client](multi-machine-client.md))
  calls `reconnectMachine(deviceId)` directly, the same lower-level primitive `reconnectNow` wraps
- `DeviceHub.waitForAgent(timeoutMs)` (`relay/src/mux.ts`) — resolves once a bridge attaches to
  this hub, or on timeout; used only when `ownerId` is still null, to close the race where a
  browser reconnects (after a relay restart) faster than its own bridge finishes `verifyDevice`
- `OWNER_ATTACH_GRACE_MS` (`relay/src/index.ts`, default 2000) — how long `/client` holds a
  browser via `waitForAgent` before classifying it against whatever the hub knows; paid only when
  no bridge has attached to the device in this relay process
- `HubRegistry.sweep()` — now also skips a hub with `hasPendingClients` (a browser parked in
  `waitForAgent`), so the 60s idle sweep cannot drop a hub out from under a waiter
- `DeviceHub.isAgent(sink)` — whether a socket is still the hub's current bridge; every per-socket
  timer and handler on the relay checks this before acting, since a superseded socket owns nothing
- `DeviceHub.agentAttaches` / `lastAttachAt` — how many bridges have ever claimed this device and
  when the newest one did; diagnostics for telling a flapping single link from two competing
  bridges
- `HubRegistry.list()` — per-device `{deviceId, online, channels, agentAttaches, lastAttachAt}`
  summary, returned by the relay's health endpoint only to a caller presenting the shared secret
- `Sink.terminate?()` — hard drop, skipping the close handshake; optional so a test sink need not
  implement it. Used on supersede, mirroring the existing dead-agent reap
- `claimBridgeLock(deviceId)` / `releaseBridgeLock()` (`server/src/index.ts`) — this machine's
  single-instance lock (`~/.lines-app/bridge.lock`), claimed unconditionally (relaying or not);
  `deviceId` is `null` for a bridge with no `RELAY_URL`. Preempts a live `instance: 'desktop'`
  holder (`SIGTERM`, bounded wait, then take the lock); any other live holder gets a bounded
  retry window (for a `tsx watch` successor meeting a still-exiting predecessor) before the
  process exits `EXIT_BRIDGE_LOCK_HELD`
- `EXIT_BRIDGE_LOCK_HELD` (`78`, `EX_CONFIG`) — the bridge's contract with the desktop shell: a
  refusal, distinguishable from a crash, that tells `main.ts` to stand its own bridge down instead
  of respawning on a timer
- `resolveRelayIdentity()` (`server/src/index.ts`) — the env-or-`deviceIdentity()` resolution,
  called only when `RELAY_URL` is set, so a local-only bridge never mints `device.json`
- `socketGeneration` (`web/src/ws.ts`) — monotonic id per `new WebSocket(...)`; `onmessage` drops a
  frame whose generation is not current
- `useDevices` — a small zustand store independent of the main `useStore`, because two unrelated
  trees (the gate, and the Settings pane) must observe and mutate the same machine list; a revoke
  in Settings has to put the gate back up, which a component-local fetch could not do
- `chooseDevice(devices)` — picks the remembered device if it still exists, else the
  most-recently-seen one. The gate calls it **only when this browser has a remembered device
  id**: it is the right rule for returning, and the wrong one for a first visit, where it would
  attach a browser to a computer it never named
- `renameDevice(id, name)` — `PATCH /v1/devices/:id`, Clerk-authed and scoped to the owner. The
  name is plaintext in Postgres and is the label every other user in a shared session sees, so
  renaming is the user's control over what the hostname leaks
- `bootstrapped` (in `web/src/store.ts`) — true once a `hello` has been received from the
  currently-chosen machine
- `switchDevice(id)` — closes the current socket and clears `bootstrapped` before opening the
  new one

## Data flow

### Port discovery

Worker: bind `:0` → `listening` → publish `worker.json` with the bound port and a fresh
`bootToken` → `clearRuntimeInfo` on `SIGINT`/`SIGTERM`/`exit`.

Bridge: `WorkerClient` reads `worker.json`, dials `ws://127.0.0.1:<port>` with the token in a
header, and `watchRuntimeInfo` re-dials the moment the worker republishes on a new port. No file,
or a file naming a dead pid, means "worker down or still booting" — retry. The bridge publishes
`bridge.json` the same way.

Browser (dev): the Vite plugin reads `bridge.json` per request and serves `{ "port": … }` at
`/__bridge`; `initBridgeOrigin()` resolves it once before render, and `connect()` re-resolves on
every attempt so a restarted bridge is found again. A hosted build sets `VITE_BRIDGE_WS_URL` and
never probes.

### The browser–bridge contract

A connection arrives, is gated on Clerk, is added to `ctx.sockets`, and receives `hello` — which
carries `bridge: { version, appProtocol }` alongside the full state snapshot. Every later state
change fans out through `broadcast`, which consults `linkSendAction` per link before sending.

The client compares `hello.bridge.appProtocol` against its own `APP_PROTOCOL_VERSION` and records
`protocolSkew`, which `SkewBanner` renders as a pill naming which side is older and, when it is
this tab, a reload action. Nothing throws on a message type it does not recognise:
`applyServerMessage` has no `default` case, so an unknown type falls through untouched — the case
this doesn't cover is a client old enough to still *render* a field a newer bridge stopped sending
(a removed-field change, not an added one), which is why removing or renaming a rendered field is
a protocol bump in its own right (see `architecture.md`).

### Relaying

The bridge dials `/agent?device=…&secret=…` and sends `hello`. A browser connects to
`/client?device=…&token=…`; the relay allocates a channel and sends
`{t:'open', ch, userId, token}` to the bridge, which builds a `RelayChannel` and hands it to the
ordinary `handleConnection`. From there a relayed client *is* a client — same message handling,
same `ctx.sockets`, same broadcast. App messages ride inside `{t:'data', ch, payload}` in both
directions, verbatim.

A browser's `/client` connection is refused unless its verified Clerk `userId` matches the
device's owner (`DeviceHub.ownerId`, learned from the bridge's own `/agent` authentication).

On the browser side, `web/src/ws.ts` stamps each socket with a monotonic generation and has
`onmessage` drop any frame whose generation is stale. `switchDevice` closes the previous socket but
does not detach its listener, so without this a frame already in flight from the old machine could
still reach `applyServerMessage` after `clearBootstrap()` had already reset the store for the new
one.

A backgrounded tab that resumes probes its live links and redials a dead one directly, rather than
waiting for the heartbeat to notice — see
[multi-machine-client](multi-machine-client.md#waking-a-backgrounded-tab) for the mechanism; it is
client-side only and changes nothing about this section's protocol.

### One bridge speaks at a time

Two bridge processes can end up claiming one device — a stale `device.json` shared across
processes, a respawn racing a not-yet-exited predecessor — and the relay's fan-in used to have no
guard against it: a superseded (or merely half-dead) bridge could keep writing frames into a live
browser channel, and its `t:'close'` frame could delete a channel the *current* bridge now owns.
Two alternating bridge states meant two alternating `hello` snapshots reaching one browser, which
is what turned a freshly created session into a flicker loop between it and the previous one.

`DeviceHub.attachAgent` now returns the sink it superseded (if any), so the caller can log a
distinct warning naming the running attach count — a takeover used to be indistinguishable from a
first attach. The predecessor is `close(1012, 'superseded')`d **and** `terminate()`d: a close
handshake on a socket whose peer may be gone never completes, so without the hard drop the loser
lingers `OPEN` on the relay for minutes. `DeviceHub.fromAgent(frame, sink)` takes the sender and
refuses (`this.agent !== sink`) as its first line — mirroring the guard `detachAgent` already had —
so a superseded socket cannot inject state or close a channel it no longer owns. The per-agent
re-verify tick and the ping/health interval both bail out the instant their own socket is no longer
`hub.isAgent(sink)`, so a superseded socket's still-running timer can never tear down the hub (or
evict the browser's channels) that replaced it.

Bridge-side, `RelayClient.dispatch`'s `open` case is now idempotent: every agent attach replays
`open` for all live channels, so a takeover re-delivers channel ids the bridge already serves.
Handling one again used to build a second `RelayChannel`, run `handleConnection` a second time, and
push a second full `hello` snapshot down a browser socket that never reconnected — the other half of
the flicker loop. A repeated `open` for a channel id already held is now a no-op (logged); a
genuine reopen after the channel actually closed still creates a new one. `connect()` also closes
any socket it already holds before dialling a new one, so one `RelayClient` instance can never hold
two live sockets for the same device.

None of this fixes two bridges existing — it only stops the fallout from being visible. The actual
cure is `claimBridgeLock`, and it runs for **every** bridge, not only one with `RELAY_URL` set:
`~/.lines-app` assumes a sole writer (see [app-data-root](app-data-root.md)), which is a
local-store risk independent of the relay. The claim is atomic (`fs.writeFileSync` with the
`'wx'` flag) rather than read-then-write, closing a TOCTOU window two bridges starting in the same
instant could otherwise hit.

On `EEXIST` there are three outcomes, checked in order:

1. **Dead, corrupt, or our own pid** — nothing is really holding the lock, so take it over.
2. **A live holder whose lock names `instance: 'desktop'`** — *preempt*. The tray app is the only
   supervisor that can stand its own bridge down and re-arm it later, so a dev bridge (Tilt, a
   terminal `npm run dev -w server`) always wins the machine. Before signalling, the pid is
   cross-checked against that instance's own published `run/desktop/bridge.json`
   (`readRuntimeInfo('bridge', 'desktop')`) — the lock file's word alone is not enough to
   `SIGTERM` a pid, since pids get reused. Then `SIGTERM` (the same signal `tsx watch` and Tilt
   already send; `shutdown()` releases the lock on it), and a bounded ~2s poll for the pid to
   clear before taking the lock.
3. **Any other live holder** — the same bounded ~2s poll runs first (without signalling anyone):
   `tsx watch` starts the successor immediately after signalling the old child, and `shutdown()`
   has its own 1.5s exit fallback, so a legitimate reload can meet a still-live predecessor.
   Only once that window expires does the new process exit `EXIT_BRIDGE_LOCK_HELD` (`78`), naming
   the holder's pid, instance, and whether it is relaying.

`LINES_ALLOW_MULTIPLE_BRIDGES=1` is the deliberate escape hatch (tests, an intentional second
bridge) and skips the lock entirely — it neither reads nor writes the file. It must never be set
in a real deployment.

The release side is registered only after a successful claim (`process.on('exit', ...)`, in
addition to `shutdown()`'s explicit call), so a refused start never touches the incumbent's file.

The desktop shell mirrors this from the other side: it reads the same lock file, and on either its
own bridge exiting `EXIT_BRIDGE_LOCK_HELD` or a re-read showing a live foreign holder (the
preempt case, where its bridge dies by `SIGTERM` with `code === null`), it stands its bridge down
instead of respawning it — see [desktop-app](desktop-app.md#boot-and-modes).

The relay's health endpoint (`GET /`) keeps its exact unauthenticated shape — `{ok, version,
devices}` — for anyone; a request presenting the correct `x-relay-secret` (constant-time compared)
additionally gets `hubs: HubRegistry.list()`, a per-device `{online, channels, agentAttaches,
lastAttachAt}` summary. `agentAttaches` climbing on an otherwise-idle paired device is the tell for
two bridges fighting over one identity, versus `agentAttaches: 1` pointing at a single flapping
link instead — this is the triage tool for a report like "sessions keep flickering," without
touching Postgres.

The lock stops a *second local start*; it does nothing for a bridge already running elsewhere
(a shipped desktop build that predates the lock, or the escape hatch) whose relay dial still gets
superseded on every attempt. `RelayClient` resetting `attempt = 0` on every `'open'` used to mean
that war ran at the retry floor (500–1000ms) forever — a supersede close always follows a
successful open, so the backoff exponent never accumulated. `'open'` no longer resets it; only a
socket that survives `RELAY_STABLE_MS` (10s) does, on its `'close'`, since that is the only
evidence the dial actually worked. Each `1012` close increments a `consecutiveSupersedes` counter
alongside the existing lifetime `supersededCount`; once it reaches `SUPERSEDE_LIMIT` (5, with no
stable socket in between), `retry()` swaps its cap from `RECONNECT_CAP_MS` (30s) to
`SUPERSEDE_CAP_MS` (5 minutes) and logs the crossing once, naming `~/.lines-app/bridge.lock` and
the rival bridge as the thing to stop. A genuine relay flap that lands even one stable socket
resets the counter and stays on the ordinary 30s cap. All three constants are env-tunable
(`LINES_RELAY_STABLE_MS`, `LINES_SUPERSEDE_LIMIT`, `LINES_SUPERSEDE_CAP_MS`) so tests can compress
them; this stays entirely inside `RelayClient` as a peripheral — it only slows its own re-dial and
never parks, so it self-heals the moment the other bridge goes away, with no relay-side or
protocol change.

### Pairing a machine

1. The machine generates a random secret, keeps it, and calls `register` with only its sha256
   hash. Storage creates (or re-issues a code for) the `Device` row and returns a short
   human-typeable `pairingCode`. The desktop shell leans on the re-issue behavior deliberately:
   it calls `register` again on a timer (and on demand, from "Get a new code") to keep a valid
   code on screen, which only works because re-registering an *unclaimed* device is a repeat, not
   a conflict — see [desktop-app](desktop-app.md).
2. The signed-in user types that code into the web app, which calls `claim`. Storage looks the
   code up, checks it is unexpired and unrevoked, and sets `userId` — the step that actually
   binds machine to account. The code is cleared on use so it cannot be replayed.
3. The bridge dials the relay's `/agent` with its id and the plaintext secret. The relay calls
   storage's `verify` (authenticated by a shared secret, not a user token), which recomputes the
   hash and returns the owning `userId` on a match. The relay records it as `hub.ownerId`.
4. A browser connecting to `/client?device=…` is refused unless its verified Clerk `userId`
   equals `hub.ownerId`.

### The owner-attach race

`hub.ownerId` is null until step 3 completes, and a relay restart puts the browser back at step 4
before its own bridge has finished step 3 again — measured at roughly a one-second gap. Without
the grace below, `/client` reads that null as "not the owner," routes the machine's own user down
the guest path, and `authorizeClient` denies an `owner`-shaped grant — so the owner is refused
`1008` on their own machine and backs off `UNAUTHORIZED_RETRY_DELAY_MS` (5s) before trying again.
Repeated over a flapping relay, that is the difference between a reload taking about a second and
taking the better part of a minute.

`handleClient` now calls `hub.waitForAgent(OWNER_ATTACH_GRACE_MS)` before classifying a browser,
but only when `hub.ownerId === null` — a running machine with an already-attached bridge pays
nothing. If a bridge attaches inside the grace window, the wait resolves and classification
proceeds normally (owner or guest, correctly this time); if it does not, the browser is
classified exactly as it always was. The trust rule is unchanged: ownership is still only ever
learned from a bridge that proved the device secret, never inferred from storage or from the
browser's own claim.

### Un-pairing a machine

Two ways in, one end state — the row is tombstoned and the machine's next `register` mints a
fresh code:

1. **From the browser.** `DELETE /v1/devices/:id` (Clerk-authed), from Settings → Machines or from
   the stuck-connecting screen's "Unpair" action. The relay's next re-verify tick sees the revoked
   row and drops the hub; the bridge re-dials into `1008` until a new code is claimed.
2. **From the machine.** `POST /v1/devices/unpair` with `{id, secret}`, from the tray's
   "Unpair this machine…". This is the lockout-proof path: it needs no browser, which matters
   because the browser's own escape hatch lives *behind* the gate, and `register` refuses to
   re-issue a code for a claimed device.

Either way the desktop shell ends up registering again — automatically on a `1008` it did not
expect, or immediately after its own unpair — and shows the new code in the tray and a pairing
window. See [desktop-app](desktop-app.md).

In a hosted deployment the browser calls storage cross-origin (it lives on its own subdomain —
see [production-deployment](production-deployment.md)), so storage answers CORS preflights
against an explicit `WEB_ORIGINS` allowlist before the auth gate runs; a wildcard origin is not
used because these responses carry Clerk-authenticated user data.

### The gate

1. `DeviceGate` mounts, calls `useDevices().refresh()` (`GET /v1/devices`), and renders
   `ConnectMachineLoading` until it resolves.
2. Zero devices → `ConnectMachine` (the pairing form + diagram). Claiming a code refreshes the
   list, which re-renders the gate off the new result — no navigation involved.
3. One or more devices, and this browser has no remembered choice → `ChooseMachine`: the whole
   list, with each machine's health dot, platform, last-seen, and an owner badge when it is
   somebody else's. Nothing connects until the user picks, and "Use this" writes the remembered
   id. A single machine still gets a list of one — the point is that the browser never attaches
   to a computer the user was not shown.
4. One or more devices, with a remembered choice → `chooseDevice` picks one, `ws.ts` gets
   `setDeviceId` and `connect()` is called. A remembered machine that has since been revoked no
   longer falls through to a different one; `chosen` is null and the list comes back.
   - Before step 1 resolves, `DeviceGate` runs `bootDial(remembered, devices, dialed)`
     (`web/src/lib/wake.ts`) against `rememberedDeviceId()` — a synchronous localStorage read — and
     calls `connectMachine` (not `switchDevice`) on its `dial` result, so the socket does not sit
     behind the `/v1/devices` round trip it does not actually need. `primaryDeviceId` stays unset
     until step 4's own effect runs and finds the socket already open, so a wrong optimistic guess
     never becomes the machine the UI is on. When the list lands, `bootDial`'s `drop` result calls
     `disconnectMachine` on a dialled id that turns out not to be in the account's list —
     `chooseDevice`'s most-recently-seen fallback means the optimistic guess and the eventual
     `chosen` can disagree, and a left-connected wrong guess would retry on every `1008` and
     re-read the device list each time.
5. Between the socket opening and its first `hello`, `bootstrapped` is false —
   `ConnectingMachine` renders instead of the app, naming the chosen machine. It escalates either
   after 6s with no `hello` **or** immediately on a `deviceOffline` frame, which is a fact where
   the 6s timer is only a guess. Waiting alone is not a recoverable state here — the socket
   reaches the relay fine and simply finds no agent attached, so the reconnect loop by itself
   never resolves it. The escape hatch escalates in that order:
   - **Reconnect now** — `reconnectNow()` plus a device-list refresh. Non-destructive, and the
     right first move after waking a machine.
   - **A button per other paired machine** — a manual pick overrides `chooseDevice`'s
     remembered/most-recent heuristic, since that heuristic is what chose the unreachable one.
   - **Pair another machine** — reopens `ConnectMachine` without losing the account's other
     devices.
   - **Unpair \<name\>** — last, red, behind an inline confirm, and the only one that cannot
     dead-end: "pair another machine" used to ask for a code the claimed machine would never
     issue. It reuses `DevicesSection.revoke`'s exact sequence (`revokeDevice` → `forgetDeviceId`
     → refresh → clear the manual pick), after which `chosen` is null and the gate falls through
     to `ConnectMachine`. The copy names the consequence: the machine's menu-bar icon shows a
     fresh pairing code.
6. `hello` sets `bootstrapped: true` in the main store; only then does `DeviceGate` render its
   children (the real app).
7. A socket closed with `1008` (bridge/relay rejection) re-reads the device list — a revoked
   machine and a sleeping one are indistinguishable at the socket layer, and re-reading is what
   tells them apart — then retries slowly rather than parking forever.

`DevicesSection` (Settings → Machines) reads and mutates the same `useDevices` store: pairing
there behaves like the gate's pairing form, "Use this" calls `switchDevice`, renaming calls
`renameDevice` and refreshes, and revoking the active machine clears the remembered device id so
the gate falls through to the pairing screen instead of retrying a device the relay will now
refuse.

## Dependencies

- `workerProtocol.ts` uses only `node:fs`/`os`/`path`/`crypto`, so it stays inside the worker's
  deliberately-minimal import graph.
- `BrowserLink` is structural, so a real `ws.WebSocket` satisfies it with no adapter. The relay
  transport depends on it — without it `handleConnection` could only take a real socket.
- The relay depends on storage to verify a device's secret; the relay holds no database
  credentials itself. With `RELAY_URL` unset the bridge behaves exactly as before.
- [desktop-app](desktop-app.md) — what `DownloadDesktopApp` links to, and why its copy has to
  name the Gatekeeper steps explicitly.
- [production-deployment](production-deployment.md) — the topology the gate exists for.

## Tests

- `server/src/portDiscovery.test.ts` — round-trip, `0600`, no temp files left, dead-pid unlink,
  unparseable/partial files, independence of the two names.
- `server/src/workerHandshake.test.ts` — spawns a real worker: ephemeral bind and publish, hello
  on the right token, `1008` on a wrong or absent one, and that a rejected dial does not evict
  the live bridge.
- `server/src/workerClient.test.ts` — outage detection against a fake worker.
- `server/src/browserLink.test.ts` — `LINK_OPEN` matches `WebSocket.OPEN`; a real `ws.WebSocket`
  satisfies the interface; a plain object does too.
- `server/src/broadcastBackpressure.test.ts` — the full `linkSendAction` policy.
- `relay/src/mux.test.ts` — routing, agent takeover, offline notification, per-channel isolation,
  token replay, registry sweep and revoke; `ownerId` recording; cross-user channel isolation on
  one device; a superseded agent's `data`/`close` frames are refused and cannot touch the live
  agent's channel; `attachAgent` replays `open` only to the new sink and reports who it superseded
  (including that predecessor being `terminate()`d, not just closed); `agentAttaches` increments
  per attach; `HubRegistry.list()`'s per-hub summary; `waitForAgent` resolving on attach, resolving
  immediately when already attached, and timing out when none arrives; a hub with a pending waiter
  surviving `sweep()` that an idle hub with no waiter does not.
- `relay/src/agentHeartbeat.test.ts` — spawns real relay processes with the intervals compressed
  by env: an agent answering `pong` survives, a silent one is reaped and a later browser gets
  `deviceOffline`, the re-verify asymmetry both ways against a stub storage (403 drops the
  device, 500 does not), and a second bridge claiming the same device supersedes (and hard-drops)
  the first without the takeover looking like an outage to a browser arriving after it.
- `server/src/relayEndToEnd.test.ts` — a real relay and a real bridge, with a browser reaching
  the bridge only through the tunnel; plus the bridge's idle watchdog, driven by `SIGSTOP`ping the
  relay so the socket goes silent without closing.
- `server/src/relayClient.duplicateOpen.test.ts` — a repeated `open` for a channel id already
  served invokes `onChannel` exactly once and leaves one live link; a channel actually closed and
  reopened on the same id is still served as new.
- `server/src/bridgeLock.test.ts` — spawns real bridge processes against a temp `HOME`: a
  no-`RELAY_URL` bridge still claims the lock and mints no `device.json`; a second bridge exits
  `78` leaving the incumbent's lock bytes untouched; a dead-pid or corrupt lock is taken over;
  `LINES_ALLOW_MULTIPLE_BRIDGES=1` neither reads nor writes the file; an `instance: 'desktop'`
  holder is preempted (`SIGTERM`, exits, lock ends up naming the newcomer).
- `server/src/relayClient.supersede.test.ts` — a fake relay that accepts and immediately
  `1012`-closes every dial: re-dial gaps grow and settle at the escalated cap; a socket held open
  past `RELAY_STABLE_MS` resets the backoff. Real timers, compressed via the same env vars a
  deployment leaves alone.
- `storage/src/schema.credentials.test.ts` — `Device.secretHash` is the one allowlisted field,
  with its justification.
- `storage/src/devices.unpair.test.ts` — the unpair route's failure modes. **Opt-in**: the only
  test in the repo needing a real Postgres, gated on `STORAGE_TEST_DATABASE_URL` (deliberately not
  `DATABASE_URL`, which in a checkout points at the deployment's database) and skipped without it.
- `server/src/wakeRedial.test.ts` — imports `web/src/lib/wake.ts` directly; covers `bootDial`'s
  four cases (see [multi-machine-client](multi-machine-client.md) for the full list, shared with
  the wake-probe coverage there).
- No web test harness in this repo for the gate's UI flows; verified manually against the
  deployed relay (device rejection close code, re-pairing after revoke, gate transition on a live
  `hello`, sleep/wake recovery, and both escape hatches end to end).

## Business rules

- The default local port is ephemeral. `LINES_WORKER_PORT` / `LINES_BRIDGE_PORT` pin a port only
  when explicitly set; Tilt sets both so its readiness probes have fixed targets.
- `LINES_INSTANCE` separates concurrent installs. The desktop shell sets `desktop`; a dev checkout
  (Tilt included) leaves it unset, so it is `default`. Tilt deliberately sets nothing itself: its
  `web` resource resolves `/__bridge` from this same variable, so pinning one for the bridge alone
  would stop the dev server finding it.
- The worker rejects any connection that cannot echo the published token, and checks this
  *before* the newest-bridge-wins takeover — otherwise any local process could terminate the real
  bridge just by connecting.
- A discovery file naming a dead pid is removed on read, not merely ignored.
- `PORT` belongs to the storage server alone; bridge and worker no longer read it, so the
  collision `.env.example` used to warn about is gone.
- Stream deltas are the only droppable traffic. They are never persisted and the browser refetches
  the transcript on reconnect, so losing one costs a partially-typed token rather than state. This
  is the worker's `OUTBOX_CAP` rule at the other end of the same pipe.
- Above the high-water mark a link sheds stream deltas but still gets every critical message.
- Above the hard limit the link is closed outright. Safe by construction: `hello` is a complete
  state snapshot, so a reconnect resyncs whatever was missed.
- Thresholds (4 MB / 32 MB) are deliberately far above any loopback burst, so local development
  never reaches them.
- An absent `hello.bridge` means a bridge older than the field, which counts as skew.
- `hello` also carries an optional `worker: WorkerStatus` (bridge↔worker link health — see
  [turn-recovery](turn-recovery.md)), and a `workerStatus` message broadcasts later transitions.
  Neither bumped `APP_PROTOCOL_VERSION`: both are additive and `applyServerMessage` has no
  `default` case, so an older client simply ignores `workerStatus` and an absent `hello.worker`
  degrades to "no banner" — the same tolerance `hello.bridge` already relies on.
- A browser that connects while no bridge is attached is told `deviceOffline` immediately, rather
  than left on an indefinite spinner.
- A machine's `name` is the hostname it registered with, stored in plaintext and visible to
  everyone it shares a session with. It is renameable for exactly that reason — the hostname is
  the one piece of a machine's identity the user did not choose and cannot otherwise change.
- The gate never connects to a machine this browser has not been shown. The
  remembered/most-recent heuristic resumes a choice; it does not make one.
- A bridge restart does **not** disconnect an owner's browser: their channel stays open and is
  replayed to the new bridge, which answers with a fresh `hello`. A guest's channel is the
  exception — it is dropped rather than replayed, so its browser reconnects and re-runs the
  `/client` gate against the new bridge's now-known protocol version; see
  [session-collaboration](session-collaboration.md#the-relay-gate).
- Newest bridge wins. A reconnecting bridge must be able to take over from a half-dead predecessor
  the relay has not yet noticed.
- The relay persists nothing and logs no payload.
- With `RELAY_URL` unset nothing dials, so the local-only setup is unchanged.
- A browser may only reach a device it owns. If storage cannot be reached to verify a device's
  secret, the relay refuses the connection rather than admitting it — an outage must never widen
  access.
- `register` is unauthenticated: the machine has no user yet, and a code is worthless until
  claimed. Re-registering an already-claimed **and unrevoked** device is refused (409) rather than
  silently re-bound. A **revoked** device is the exception: register clears the stale `userId` and
  `revokedAt` and issues a fresh code, or a revoked machine could never be claimed by anyone again
  — `claim` refuses a revoked row, and the relay's `verify` refuses it too, so a device stuck in
  that state would otherwise be permanently dead.
- `claim`, `verify` and expired/revoked lookups all answer the same "unknown or expired code" for
  absent, expired, and revoked — a distinct "expired" reply would confirm a guessed code had once
  been real.
- Revoking a device tombstones it (`revokedAt`) rather than deleting the row, so it stays an audit
  trail. Revoking stops it reconnecting **and** ends a connection already open, within a bounded
  window: the relay re-checks each attached device's claim every `REVERIFY_MS` (5 minutes by
  default) and drops the hub on a refusal, rather than only checking on attach. The UI describes
  it as exactly that — "within a few minutes", not "when it next reconnects".
- The re-verify tick is **asymmetric with attach, deliberately**. Attach fails closed on either a
  refusal or an outage. The tick drops a live device only on an explicit `unauthorized` (storage's
  403); `unreachable` — a 401, a 503, a 5xx, a timeout — leaves it alone. Getting this backwards
  would turn a storage blip into every user being kicked off their own machine, which is why
  `verifyDevice` returns three outcomes rather than a nullable one.
- The relay pings its attached agent every `AGENT_PING_MS` (20s) and `terminate()`s one that has
  been silent for `AGENT_DEAD_MS` (55s, ~2 missed pings). Without it a half-open socket — after a
  sleep, a Wi-Fi change, a NAT rebind — leaves both ends reporting `OPEN`, so `hub.online` stays
  true, a browser is handed a channel into a dead sink, and no `hello` ever arrives: an indefinite
  spinner with no way out. Reaping is what makes `hub.online` false, which is what gets
  `deviceOffline` to the browser.
- The bridge watches its own side the same way: no frame for `LINES_RELAY_IDLE_MS` (60s) and it
  terminates its own socket and re-dials with the existing backoff. This is also the macOS-sleep
  fix — the tick is wall-clock, so on wake it fires late, the delta is enormous, and the stale
  socket goes immediately. No `powerMonitor` hook needed.
- `POST /v1/devices/unpair` is authenticated by the device secret, not a Clerk token, because the
  machine has none — and unlike `verify` it must stay reachable from the internet, since the
  machine dials storage directly exactly as it does to `register`. It grants strictly less than
  the secret already does (whoever holds it can dial `/agent` and drive that machine), the compare
  is constant-time, and unknown id / never-claimed / wrong secret all answer the same opaque 403 —
  a distinct reply would confirm a guessed id had once been real. It returns **no** pairing code:
  `register`'s revoked-row exception is the one code-issuing path.
- `GET /v1/devices` never returns `secretHash`. It also unions in machines reachable through a
  live share (tagged `shared: true`, with the host's profile and grant scope) and an `online`
  flag derived from the relay's presence report — see
  [session-collaboration](session-collaboration.md) and
  [multi-machine-client](multi-machine-client.md).
- Pairing a new machine only becomes the active one automatically if there was no machine active
  before; otherwise silently switching a working session to a different computer would be worse
  than an extra "Use this" click.
- The `Machines` settings section does not render at all in a local build — a one-row list of the
  machine you are already on is noise, not a feature.
- The stuck-connecting screen's escape hatch only offers machines the account already has; a
  "pair another" action always stays available regardless, since a first-time user with one dead
  machine would otherwise have no path forward at all. Unpair sits behind an inline confirm (the
  second click flips the label) because it is destructive and one click from a screen the user is
  already frustrated with.
- `deviceOffline` / `deviceOnline` are relay control frames, not app messages: they are handled in
  `ws.ts` alongside `pong` and `fileResponse`, never in `applyServerMessage`, which has no
  `default` case and would drop them silently — as it did until they were wired up.
- `DownloadDesktopApp` renders nothing when no build has been published (`DESKTOP_DOWNLOAD_URL`
  unset) — a button pointing at nothing is worse than no button.
- `fromAgent` only accepts a frame from the socket the hub currently calls its agent — a
  superseded (or half-dead) bridge that keeps writing cannot inject state into a live browser
  channel, nor close a channel now owned by the bridge that replaced it.
- `attachAgent` `terminate()`s (not just closes) the predecessor it supersedes, so a takeover
  cannot leave the loser's socket lingering `OPEN` on the relay for minutes.
- The per-agent re-verify tick and health/ping interval both bail out the instant their own socket
  is no longer `hub.isAgent(sink)`, so a superseded socket's still-running timer can never drop the
  hub — or evict the browser channels — out from under the bridge that replaced it.
- A duplicate agent attach for a device logs distinctly from a first attach, naming the running
  attach count — a takeover used to be indistinguishable from a first attach in the logs.
- The relay's unauthenticated health shape is unchanged; presenting the correct `x-relay-secret`
  additionally returns `hubs` (per-device `online`/`channels`/`agentAttaches`/`lastAttachAt`).
  Device ids must never leak to an unauthenticated caller.
- The bridge rejects a duplicate `open` for a channel id it already serves (warns, keeps the
  existing link) rather than building a second `RelayChannel` — a takeover (or any re-announcement)
  re-delivers ids already held, and building a second link means a second full `hello` down a
  browser socket that never reconnected.
- `RelayClient.connect()` closes any pre-existing socket (and drops its channels) before dialling
  a new one, so one `RelayClient` instance can never hold two live sockets for the same device.
- Every bridge takes this machine's single-instance lock (`~/.lines-app/bridge.lock`, pid + start
  time + `instance` + `deviceId`) unconditionally — relaying or not, since the sole-writer
  assumption on `~/.lines-app` (see [app-data-root](app-data-root.md)) isn't relay-specific. The
  claim is atomic (`'wx'`), not read-then-write.
- On a collision, a live `instance: 'desktop'` holder is preempted (`SIGTERM`, cross-checked
  against its own published runtime file first) since the tray is the only supervisor that can
  stand its bridge down and re-arm it; any other live holder gets a bounded ~2s retry window
  (covering a `tsx watch` successor meeting a still-exiting predecessor) before the new process
  exits `EXIT_BRIDGE_LOCK_HELD` (`78`) rather than `1` — a distinct code so the desktop shell can
  tell "lock held" from a crash.
- `LINES_ALLOW_MULTIPLE_BRIDGES=1` is the deliberate escape hatch that skips the lock entirely (no
  read, no write), for tests and any intentionally-run second bridge; it must never be set in a
  real deployment.
- Resetting `RelayClient`'s reconnect backoff on `'open'` let a supersede war run at the retry
  floor forever, since a supersede close always follows a successful open. Only a socket that
  survives `RELAY_STABLE_MS` resets the backoff now; a run of `SUPERSEDE_LIMIT` consecutive
  supersedes with no such socket escalates the re-dial cap to `SUPERSEDE_CAP_MS`, self-healing back
  to the ordinary cap the moment a dial lands a stable link.
- A browser socket carries a monotonic generation stamp; `onmessage` drops a frame whose
  generation is no longer current. `switchDevice` closes the old socket but does not detach its
  handler, so a late frame from the previous machine could otherwise still reach
  `applyServerMessage` after `clearBootstrap()`.
- `machineOffline` is surfaced by `ConnectionBanner` after bootstrap too, not only by the
  pre-bootstrap `ConnectingMachine` screen — "relay up, machine gone" used to render as a healthy
  "connected" UI in which every action silently went nowhere.
- `/client` holds a browser for up to `OWNER_ATTACH_GRACE_MS` only when `hub.ownerId` is still
  null in this relay process — a running machine with an attached bridge is classified
  immediately, exactly as before. The hold never widens access; it only delays a classification
  that would otherwise be made on stale information.
- `DeviceGate` dials the remembered machine optimistically, before the device list has loaded (see
  Data flow, "The gate"), and drops that dial if the list lands without the id in it — the gate
  never connects to a machine this browser has not been shown remains true; the optimistic dial is
  provisional until the list confirms it, not an exception to that rule.

## Architectural rules

- The port-discovery helpers live in `workerProtocol.ts`, not a module of their own: port
  discovery *is* part of the bridge↔worker contract, and a separate file would widen the worker's
  `tsx watch` restart trigger for no benefit.
- `APP_ROOT` is defined there and re-exported by `store.ts` — the worker needs it and cannot
  import `store.ts` without dragging the whole bridge graph along.
- Publishing is atomic (temp + rename) so a reader never sees a partial file, and `0600` so the
  token stays private to this OS user.
- `watchRuntimeInfo` watches the directory, not the file: publishing renames over the target, so
  a file watch would follow the replaced inode.
- Timers and watchers are released via `WorkerClient.dispose()` rather than `unref()`. `unref()`
  makes a timer invisible to node's mock timers, and the retry chain re-arms forever while the
  worker is down, so a short-lived consumer needs a real disposer.
- The bridge's token is published but **not** enforced on browser connections: a browser cannot
  set headers on a WebSocket, so the Clerk gate guards that path. The `/__bridge` endpoint exposes
  only the port, never the token.
- A live `ws` socket and node's mock timers cannot be mixed — `ws` schedules its own real timers,
  and faking the clock underneath corrupts node's timer list when the socket closes. Tests
  compress the client's intervals instead.
- `BrowserLink` covers only what the bridge genuinely calls. Every addition is another thing an
  alternative transport has to implement.
- `close()` must move `readyState` off `LINK_OPEN` synchronously — `broadcast` relies on that to
  avoid re-closing the same wedged link on every message.
- Removal from `ctx.sockets` is owned solely by the `'close'` handler, including on the
  hard-limit path.
- A per-socket `'error'` listener is mandatory: an unhandled `'error'` on an EventEmitter throws
  and takes the bridge down. Loopback hides this; over a network, per-socket errors are routine.
  A non-EventEmitter implementation (a plain object with stored callbacks) avoids the footgun
  entirely.
- `linkSendAction` is pure and exported so the policy is testable without a socket.
- `APP_PROTOCOL_VERSION` is bumped only for browser↔bridge changes; the bridge↔worker
  `PROTOCOL_VERSION` in `workerProtocol.ts` is a separate contract on its own numbering.
- `hello.bridge` is optional in the type. Once the web app is hosted it will meet bridges older
  than itself, and an absent field is exactly that case.
- **The relay client is a peripheral, never a supervisor.** Relay health must never restart the
  bridge and absolutely never the worker: that would turn a relay blip into a reconcile, an
  `interruptedAt` stamp, and an auto-continued turn. Its own reconnect is the only thing a relay
  failure drives.
- The payload is opaque. The relay routes on the header and never parses the message, so
  end-to-end encryption can later encrypt `payload` alone with no codec rewrite. Nothing in
  `relay/` may start reading it.
- Frames are forwarded **synchronously** inside the message handler. An `await` per frame would
  let two race and reorder a stream.
- A dropped relay socket must synthesize `close` for every open channel. Otherwise `ctx.sockets`
  keeps dead links forever and `broadcast` serialises JSON into them on every state change.
- `RelayChannel` is a plain object, not an EventEmitter — an unhandled `'error'` on an
  EventEmitter throws and takes the process down.
- **The relay is not the auth edge.** It used to be, and this document used to say so: the
  bridge took the attested `userId` and granted owner access on the relay's word. That made a
  compromised relay able to forge an `open` frame as any user and drive their machine. The
  attested identity is now a *routing hint* — which user's context to open — and owner authority
  on a relay channel comes from a static key the machine pinned itself, out of band, at
  enrollment. See [end-to-end-encryption](end-to-end-encryption.md); `guardRelayChannel` refuses
  an unauthenticated owner channel before `handleConnection` ever sees it.
  - Rollout shape, which is why the old behaviour is still reachable: a machine with **no**
    enrolled device behaves exactly as it did, because requiring a key before any exists would
    have locked every install out of its own bridge. Enrolling one browser turns the requirement
    on, machine-wide.
  - The bridge still does not re-verify the Clerk token on a relay channel, and that part of the
    original reasoning stands: a second verifier means two failure modes and would make every
    relayed connection depend on the user's machine reaching Clerk's JWKS. The token is
    authorization for *storage sync*, not for driving the machine. Direct sockets still verify
    locally.
- A link's *locality* is a property of the link, not of the app: `hello.local` is true only for a
  socket that is both unrelayed and on loopback. `!attested` alone is not enough — the bridge
  binds every interface, so a direct socket may be a laptop on the same LAN, which is as remote
  as the relay for anything that opens a window on the host's screen. It fails closed: absent
  means not local, so an older bridge simply hides the affordance. Today that gates exactly one
  thing, the Finder folder picker (`pickFolder`), which is also refused server-side rather than
  merely hidden.
- `relay/` shares no types with the app and the bridge does not import the relay package: the
  frame shapes are duplicated in `relayClient.ts` on purpose, since the bridge ships to users'
  machines.
- Reconnect uses exponential backoff **with jitter**. A flat retry across every user's bridge
  turns one relay restart into a synchronised stampede.
- Only the device secret's hash is stored, never the plaintext.
- The relay holds no database credentials and never queries Postgres directly — it asks storage,
  which is the only process with DB credentials at all.
- The `/client` gate now has two branches, not one, and both fail closed at the earliest point:
  the owner check (`hub.ownerId === userId`) is byte-for-byte what it always was and never
  consults storage; anyone else must hold a grant from `POST /v1/devices/authorize`, checked
  before routing proceeds. See [session-collaboration](session-collaboration.md) for the grant
  model and why a non-owner additionally needs the bridge to speak a minimum app protocol.
- `POST /v1/devices/verify`, `/presence`, and `/authorize` are all called machine-to-machine by
  the relay with no Clerk token to present, so all three sit behind the same
  constant-time-compared shared secret (`RELAY_SHARED_SECRET`) instead of the Clerk gate, and are
  excluded from storage's public router in a hosted deployment so none is reachable from the
  internet even with the secret guessed. Unset, storage refuses all three with 503/401 rather
  than falling open.
- Device identity (mint, hash, register) lives in `server/src/device.ts` rather than duplicated
  in the desktop app and the CLI pairing script, so the two cannot drift on the credential
  format.
- Token providers for both the socket and storage calls are installed during React **render**,
  not inside a `useEffect`: effects on a child component (`DeviceGate`) run before effects on its
  parent (`AuthedConnect`), so an effect-based registration meant the device list's first fetch,
  and the first socket connect, both fired with no Clerk token attached.
- `switchDevice` closes the existing socket rather than waiting for it to drop and clears
  `bootstrapped` before reconnecting — every in-flight message on the old socket belongs to the
  old machine's bridge, and delivering one after the switch would attribute a session to the
  wrong host.
- The socket URL is built with `new URL(...)`/`searchParams`, not string concatenation — the
  relay matches its endpoint path exactly, and concatenating a token onto a URL that already had
  a trailing segment once produced a non-matching path.
- `terminate()` on supersede is deliberately aggressive rather than a graceful close-and-drain: a
  superseded bridge has no readers left, so draining it only leaves a noisy half-open socket
  around longer. The trade-off is a louder log during a genuine flap — a feature during triage,
  not a bug.
- The bridge closes its own pre-existing socket (and drops its channels) at the start of
  `connect()`, before dialling — belt-and-braces alongside the existing single-flight
  `retryTimer`, so `RelayClient` itself can never be the source of two live sockets for one
  device.
- The single-instance lock file lives beside `device.json` under the same `APP_ROOT`, reusing the
  existing app-data-root path helpers rather than adding a new resolver (see
  [app-data-root](app-data-root.md)).
- Stale-lock detection is `process.kill(pid, 0)`: `ESRCH` means nothing holds the pid, so the new
  process takes the lock; any other outcome (including `EPERM`, another OS user's live process) is
  treated as held.
- Only `instance: 'desktop'` is preemptible, and only after cross-checking the pid against that
  instance's own `readRuntimeInfo('bridge', 'desktop')` — the lock file's word alone must never be
  enough to `SIGTERM` a pid, since pids are reused; this narrows but does not close that gap.
- `armLockRelease()` (`process.on('exit', releaseBridgeLock)`) is registered only after a
  successful claim, never before — a refused start must not touch the incumbent's lock file on its
  way out.
- The supersede circuit breaker lives entirely in `RelayClient`, never in `index.ts` or the lock:
  it is peripheral by the same rule as the rest of this client — it only slows its own retry and
  never restarts or blocks anything else.
- `waitForAgent`'s timeout is deliberately not `unref()`'d — an unref'd timer lets an otherwise-idle
  event loop drain before the deadline fires, so the promise it guards would never settle at all.
  It is cleared the instant a bridge attaches and is bounded at a few seconds, so it is not the
  kind of long-lived timer `unref()` exists for elsewhere in this feature (contrast
  `WorkerClient.dispose()` above).
- `DeviceGate`'s optimistic dial calls `connectMachine`, never `switchDevice`: `primaryDeviceId`
  must stay unset until the ordinary `chosen` effect runs, so a wrong guess can never become the
  machine the UI considers itself on, even briefly.

## Related decisions

- [file-routes-over-ws](file-routes-over-ws.md) — why the relay needs no HTTP surface at all.
- [production-deployment](production-deployment.md) — the hosted topology these pieces assemble
  into.
- [desktop-app](desktop-app.md) — the installable shell that runs the bridge and drives pairing.
- [turn-recovery](turn-recovery.md) — the other credential boundary (Claude OAuth), kept local by
  the same kind of argument, and the `WorkerStatus` the `hello` payload carries; also where a
  duplicate bridge's reconcile amplification is scoped down separately.
- [app-data-root](app-data-root.md) — the `~/.lines-app` root the single-instance lock lives
  under.
- [cloud-sync-sessions](cloud-sync-sessions.md) — the delete-tombstone half of the same underlying
  bug report (a stuck session that could not be deleted), fixed independently of the relay/bridge
  supersede work here.
