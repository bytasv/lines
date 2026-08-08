# Remote relay bridge

## Purpose

Lets a hosted web app drive the agent on a user's own machine. The bridge dials
**out** to a relay; the browser connects to the same relay; the relay pipes
frames between them.

Outbound-only is the whole point: the user's machine accepts no inbound
connection, needs no port forwarding, no NAT or firewall change, and no
dynamic-DNS. It also works from a phone, or from a second machine, which a
browser-to-localhost scheme cannot.

Execution stays local. The bridge, the worker, the filesystem, `git`, and the
Claude OAuth token are all exactly where they were — only the browser moved.

## Entry points

- `relay/src/index.ts` — `/agent` (bridge dials in) and `/client` (browser)
- `server/src/relayClient.ts` — the outbound dialler
- `server/src/index.ts` — the `RELAY_URL` block wiring channels to `handleConnection`

## Important files

- `relay/src/protocol.ts` — frames, shared by both ends
- `relay/src/mux.ts` — `DeviceHub`, `HubRegistry`: pairing and routing, transport-free
- `server/src/relayClient.ts` — `RelayChannel` (a `BrowserLink`), reconnect, channel lifecycle
- `Tiltfile` — the opt-in `relay` resource

## Important symbols

- `RELAY_PROTOCOL_VERSION` — frames only; the app messages inside are versioned
  separately by `APP_PROTOCOL_VERSION`
- `DeviceHub.attachAgent` / `detachAgent` / `openChannel` / `fromClient` / `fromAgent`
- `RelayClient` — dial, backoff, dispatch
- `RelayChannel` — one browser, presented to the bridge as a `BrowserLink`
- `AttestedIdentity` — the userId the relay vouched for

## Data flow

The bridge dials `/agent?device=…&secret=…` and sends `hello`. A browser connects
to `/client?device=…&token=…`; the relay allocates a channel and sends
`{t:'open', ch, userId, token}` to the bridge, which builds a `RelayChannel` and
hands it to the ordinary `handleConnection`. From there a relayed client *is* a
client — same message handling, same `ctx.sockets`, same broadcast.

App messages ride inside `{t:'data', ch, payload}` in both directions, verbatim.

A browser's `/client` connection is refused unless its verified Clerk `userId`
matches the device's owner (`DeviceHub.ownerId`, learned from the bridge's own
`/agent` authentication) — see [device-pairing](device-pairing.md) for how a
device acquires an owner in the first place.

## Dependencies

Depends on `BrowserLink` (see [browser-bridge-link](browser-bridge-link.md)) —
without it `handleConnection` could only take a real socket. Depends on the
storage service to verify a device's secret (see
[device-pairing](device-pairing.md)); the relay holds no database credentials
itself. Nothing depends on this feature: with `RELAY_URL` unset the bridge
behaves exactly as before.

## Tests

- `relay/src/mux.test.ts` — routing, agent takeover, offline notification,
  per-channel isolation, token replay, registry sweep and revoke
- `server/src/relayEndToEnd.test.ts` — a real relay and a real bridge, with a
  browser reaching the bridge only through the tunnel

## Business rules

- A browser that connects while no bridge is attached is told `deviceOffline`
  immediately, rather than left on an indefinite spinner.
- A bridge restart does **not** disconnect the browser: channels stay open and
  are replayed to the new bridge, which answers with a fresh `hello`.
- Newest bridge wins. A reconnecting bridge must be able to take over from a
  half-dead predecessor the relay has not yet noticed.
- The relay persists nothing and logs no payload.
- With `RELAY_URL` unset nothing dials, so the local-only setup is unchanged.
- A browser may only reach a device it owns. If storage cannot be reached to
  verify a device's secret, the relay refuses the connection rather than
  admitting it — an outage must never widen access.

## Architectural rules

- **The relay client is a peripheral, never a supervisor.** Relay health must
  never restart the bridge and absolutely never the worker: that would turn a
  relay blip into a reconcile, an `interruptedAt` stamp, and an auto-continued
  turn. Its own reconnect is the only thing a relay failure drives.
- The payload is opaque. The relay routes on the header and never parses the
  message, so end-to-end encryption can later encrypt `payload` alone with no
  codec rewrite. Nothing in `relay/` may start reading it.
- Frames are forwarded **synchronously** inside the message handler. An `await`
  per frame would let two race and reorder a stream.
- A dropped relay socket must synthesize `close` for every open channel.
  Otherwise `ctx.sockets` keeps dead links forever and `broadcast` serialises
  JSON into them on every state change.
- `RelayChannel` is a plain object, not an EventEmitter — an unhandled `'error'`
  on an EventEmitter throws and takes the process down.
- The relay is the auth edge; the bridge trusts the attested `userId` on relay
  channels and does not re-verify. A second verifier means two failure modes, and
  would make every relayed connection depend on the user's machine reaching
  Clerk's JWKS. Direct sockets still verify locally.
- `relay/` shares no types with the app and the bridge does not import the relay
  package: the frame shapes are duplicated in `relayClient.ts` on purpose, since
  the bridge ships to users' machines.
- Reconnect uses exponential backoff **with jitter**. A flat retry across every
  user's bridge turns one relay restart into a synchronised stampede.

## Related decisions

- [browser-bridge-link](browser-bridge-link.md) — the `BrowserLink` contract this
  implements
- [file-routes-over-ws](file-routes-over-ws.md) — why the relay needs no HTTP
  surface at all
