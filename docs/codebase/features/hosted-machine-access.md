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
  `GET /v1/devices`, `DELETE /v1/devices/:id`, `POST /v1/devices/verify`
- `server/src/device.ts` — `deviceIdentity`, `registerDevice`; shared by the desktop app and
  `npm run pair -w server`
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
  `setDeviceId`/`switchDevice`, the device param on the socket URL, and the 1008 retry/re-check
  path
- `Tiltfile` — pins both ports so its readiness probes have fixed targets; the opt-in `relay`
  resource; the `pair-device` resource
- `.env.example` — `LINES_BRIDGE_PORT`, `LINES_WORKER_PORT`, `LINES_INSTANCE`
- `server/src/userContext.ts` — `BrowserLink`, `linkSendAction`, `broadcast`
- `server/src/index.ts` — `BRIDGE_VERSION`, per-socket handlers
- `shared/types.ts` — `APP_PROTOCOL_VERSION`, `BridgeInfo`, `hello.bridge`
- `web/src/store.ts` — `bridge`, `protocolSkew`
- `relay/src/protocol.ts` — frames, shared by both ends
- `relay/src/mux.ts` — `DeviceHub`, `HubRegistry`: pairing and routing, transport-free;
  `DeviceHub.ownerId`
- `server/src/relayClient.ts` — `RelayChannel` (a `BrowserLink`), reconnect, channel lifecycle
- `storage/prisma/schema.prisma` — the `Device` model
- `storage/src/index.ts` — the five device routes, plus CORS and the unauthenticated-path
  allowlist that fronts them
- `relay/src/index.ts` — calls `verify`, sets `hub.ownerId`
- `server/src/device.ts` — identity minting/registration, shared to avoid a second
  implementation drifting on the credential format
- `web/src/lib/devices.ts` — `useDevices`, the shared machine-list store
- `web/src/lib/storage.ts` — `listDevices`/`claimDevice`/`revokeDevice`, `chooseDevice`,
  remembered-device persistence, `DESKTOP_DOWNLOAD_URL`
- `web/src/components/ConnectMachine.tsx` — pairing screen and its loading/error siblings
- `web/src/components/ConnectingMachine.tsx` — shown between "device chosen" and the bridge's
  first `hello`; offers a way out once that takes too long
- `web/src/components/DownloadDesktopApp.tsx` — the DMG link and the Gatekeeper steps an ad-hoc
  signed build forces
- `web/src/components/GateShell.tsx` — chrome (header + sign-out) shared by every pre-app screen
- `web/src/components/PairingDiagram.tsx` — the explainer SVG
- `web/src/components/DevicesSection.tsx` — the Settings pane: list, pair, switch, revoke

## Symbols

- `RuntimeInfo` — `{ port, pid, startedAt, protocolVersion, token }`
- `publishRuntimeInfo(name, info)` — atomic (temp + rename), mode `0600`
- `readRuntimeInfo(name)` — null when missing, unparseable, or naming a dead pid
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
- `protocolSkew` — client-side flag, set when the bridge's contract differs
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
- `useDevices` — a small zustand store independent of the main `useStore`, because two unrelated
  trees (the gate, and the Settings pane) must observe and mutate the same machine list; a revoke
  in Settings has to put the gate back up, which a component-local fetch could not do
- `chooseDevice(devices)` — picks the remembered device if it still exists, else the
  most-recently-seen one
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
`protocolSkew`. Nothing throws on a message type it does not recognise: `applyServerMessage` has
no `default` case, so an unknown type falls through untouched.

### Relaying

The bridge dials `/agent?device=…&secret=…` and sends `hello`. A browser connects to
`/client?device=…&token=…`; the relay allocates a channel and sends
`{t:'open', ch, userId, token}` to the bridge, which builds a `RelayChannel` and hands it to the
ordinary `handleConnection`. From there a relayed client *is* a client — same message handling,
same `ctx.sockets`, same broadcast. App messages ride inside `{t:'data', ch, payload}` in both
directions, verbatim.

A browser's `/client` connection is refused unless its verified Clerk `userId` matches the
device's owner (`DeviceHub.ownerId`, learned from the bridge's own `/agent` authentication).

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

In a hosted deployment the browser calls storage cross-origin (it lives on its own subdomain —
see [production-deployment](production-deployment.md)), so storage answers CORS preflights
against an explicit `WEB_ORIGINS` allowlist before the auth gate runs; a wildcard origin is not
used because these responses carry Clerk-authenticated user data.

### The gate

1. `DeviceGate` mounts, calls `useDevices().refresh()` (`GET /v1/devices`), and renders
   `ConnectMachineLoading` until it resolves.
2. Zero devices → `ConnectMachine` (the pairing form + diagram). Claiming a code refreshes the
   list, which re-renders the gate off the new result — no navigation involved.
3. One or more devices → `chooseDevice` picks one, `ws.ts` gets `setDeviceId` and `connect()` is
   called.
4. Between the socket opening and its first `hello`, `bootstrapped` is false —
   `ConnectingMachine` renders instead of the app, naming the chosen machine. After 6s with no
   `hello` — the common case is the machine asleep or the desktop app not running — it also
   offers a way out: a button per other paired machine (a manual pick overrides `chooseDevice`'s
   remembered/most-recent heuristic, since that heuristic is what chose the unreachable one) and
   "Pair another machine", which reopens `ConnectMachine` without losing the account's other
   devices. Waiting alone is not a recoverable state here — the socket reaches the relay fine and
   simply finds no agent attached, so the reconnect loop by itself never resolves it.
5. `hello` sets `bootstrapped: true` in the main store; only then does `DeviceGate` render its
   children (the real app).
6. A socket closed with `1008` (bridge/relay rejection) re-reads the device list — a revoked
   machine and a sleeping one are indistinguishable at the socket layer, and re-reading is what
   tells them apart — then retries slowly rather than parking forever.

`DevicesSection` (Settings → Machines) reads and mutates the same `useDevices` store: pairing
there behaves like the gate's pairing form, "Use this" calls `switchDevice`, and revoking the
active machine clears the remembered device id so the gate falls through to the pairing screen
instead of retrying a device the relay will now refuse.

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
  one device.
- `server/src/relayEndToEnd.test.ts` — a real relay and a real bridge, with a browser reaching
  the bridge only through the tunnel.
- `storage/src/schema.credentials.test.ts` — `Device.secretHash` is the one allowlisted field,
  with its justification.
- No web test harness in this repo for the gate's UI flows; verified manually against the
  deployed relay (device rejection close code, re-pairing after revoke, gate transition on a live
  `hello`).

## Business rules

- The default local port is ephemeral. `LINES_WORKER_PORT` / `LINES_BRIDGE_PORT` pin a port only
  when explicitly set; Tilt sets both so its readiness probes have fixed targets.
- `LINES_INSTANCE` separates concurrent installs. Tilt sets `dev`, so a dev checkout and an
  installed app never publish over each other.
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
- A bridge restart does **not** disconnect the browser: channels stay open and are replayed to the
  new bridge, which answers with a fresh `hello`.
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
  trail. Revoking stops it *reconnecting* — the relay checks `revokedAt` on attach, not on every
  frame — so a connection already open is unaffected until it next drops. The UI describes it as
  exactly that.
- `GET /v1/devices` never returns `secretHash`.
- Pairing a new machine only becomes the active one automatically if there was no machine active
  before; otherwise silently switching a working session to a different computer would be worse
  than an extra "Use this" click.
- The `Machines` settings section does not render at all in a local build — a one-row list of the
  machine you are already on is noise, not a feature.
- The stuck-connecting screen's escape hatch only offers machines the account already has; a
  "pair another" action always stays available regardless, since a first-time user with one dead
  machine would otherwise have no path forward at all.
- `DownloadDesktopApp` renders nothing when no build has been published (`DESKTOP_DOWNLOAD_URL`
  unset) — a button pointing at nothing is worse than no button.

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
- The relay is the auth edge; the bridge trusts the attested `userId` on relay channels and does
  not re-verify. A second verifier means two failure modes, and would make every relayed
  connection depend on the user's machine reaching Clerk's JWKS. Direct sockets still verify
  locally.
- `relay/` shares no types with the app and the bridge does not import the relay package: the
  frame shapes are duplicated in `relayClient.ts` on purpose, since the bridge ships to users'
  machines.
- Reconnect uses exponential backoff **with jitter**. A flat retry across every user's bridge
  turns one relay restart into a synchronised stampede.
- Only the device secret's hash is stored, never the plaintext.
- The relay holds no database credentials and never queries Postgres directly — it asks storage,
  which is the only process with DB credentials at all.
- The cross-user check (`hub.ownerId === userId`) lives on the `/client` gate, not deeper in
  routing, so it fails closed at the earliest point.
- `POST /v1/devices/verify` is called machine-to-machine by the relay with no Clerk token to
  present, so it sits behind a constant-time-compared shared secret (`RELAY_SHARED_SECRET`)
  instead of the Clerk gate, and is excluded from storage's public router in a hosted deployment
  so it is unreachable from the internet even with the secret guessed. Unset, storage refuses
  verification with 503 rather than falling open.
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

## Related decisions

- [file-routes-over-ws](file-routes-over-ws.md) — why the relay needs no HTTP surface at all.
- [production-deployment](production-deployment.md) — the hosted topology these pieces assemble
  into.
- [desktop-app](desktop-app.md) — the installable shell that runs the bridge and drives pairing.
- [turn-recovery](turn-recovery.md) — the other credential boundary (Claude OAuth), kept local by
  the same kind of argument, and the `WorkerStatus` the `hello` payload carries.
