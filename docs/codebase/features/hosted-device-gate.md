# Hosted device gate

## Purpose

In a hosted build, gates the app behind "which of my machines am I talking
to": lists paired machines, lets the signed-in user pair a new one or switch
between them, and re-gates automatically if the machine in use is revoked or
disconnects with an auth-shaped close. Renders a diagram explaining the
split (browser ↔ relay ↔ user's own machine) at the one moment a user has to
understand why a website is asking them to run something locally.

Inert in a local (non-hosted) build: gated entirely on `VITE_STORAGE_URL`
being set at build time, since a local bridge is the only machine there is and
nothing to pick between.

## Entry points

- `web/src/main.tsx` — `DeviceGate`, the component this whole feature hangs off
- `web/src/components/SettingsModal.tsx` — the `devices` section (`Machines`)

## Important files

- `web/src/main.tsx` — `DeviceGate`; wraps the authenticated app
- `web/src/lib/devices.ts` — `useDevices`, the shared machine-list store
- `web/src/lib/storage.ts` — `listDevices`/`claimDevice`/`revokeDevice`,
  `chooseDevice`, remembered-device persistence
- `web/src/components/ConnectMachine.tsx` — pairing screen and its
  loading/error siblings
- `web/src/components/ConnectingMachine.tsx` — shown between "device chosen"
  and the bridge's first `hello`
- `web/src/components/GateShell.tsx` — chrome (header + sign-out) shared by
  every pre-app screen
- `web/src/components/PairingDiagram.tsx` — the explainer SVG
- `web/src/components/DevicesSection.tsx` — the Settings pane: list, pair,
  switch, revoke
- `web/src/ws.ts` — `setDeviceId`/`switchDevice`, the device param on the
  socket URL, and the 1008 retry/re-check path

## Important symbols

- `useDevices` — a small zustand store independent of the main `useStore`,
  because two unrelated trees (the gate, and the Settings pane) must observe
  and mutate the same machine list; a revoke in Settings has to put the gate
  back up, which a component-local fetch could not do
- `chooseDevice(devices)` — picks the remembered device if it still exists,
  else the most-recently-seen one
- `bootstrapped` (in `web/src/store.ts`) — true once a `hello` has been
  received from the currently-chosen machine; see Data flow
- `switchDevice(id)` — closes the current socket and clears `bootstrapped`
  before opening the new one

## Data flow

1. `DeviceGate` mounts, calls `useDevices().refresh()` (`GET /v1/devices`), and
   renders `ConnectMachineLoading` until it resolves.
2. Zero devices → `ConnectMachine` (the pairing form + diagram). Claiming a
   code refreshes the list, which re-renders the gate off the new result — no
   navigation involved.
3. One or more devices → `chooseDevice` picks one, `ws.ts` gets `setDeviceId`
   and `connect()` is called.
4. Between the socket opening and its first `hello`, `bootstrapped` is false —
   `ConnectingMachine` renders instead of the app, naming the chosen machine
   and escalating its copy after 6s if nothing has arrived.
5. `hello` sets `bootstrapped: true` in the main store; only then does
   `DeviceGate` render its children (the real app).
6. A socket closed with `1008` (bridge/relay rejection) re-reads the device
   list — a revoked machine and a sleeping one are indistinguishable at the
   socket layer, and re-reading is what tells them apart — then retries slowly
   rather than parking forever.

`DevicesSection` (Settings → Machines) reads and mutates the same `useDevices`
store: pairing there behaves like the gate's pairing form, "Use this" calls
`switchDevice`, and revoking the active machine clears the remembered device
id so the gate falls through to the pairing screen instead of retrying a
device the relay will now refuse.

## Dependencies

- [device-pairing](device-pairing.md) — the storage/relay endpoints this UI
  calls
- [remote-relay-bridge](remote-relay-bridge.md) — what a `1008` close means
  here and why it is not necessarily fatal

## Tests

None — no web test harness in this repo for UI flows; verified manually
against the deployed relay (device rejection close code, re-pairing after
revoke, gate transition on a live `hello`).

## Business rules

- Pairing a new machine only becomes the active one automatically if there
  was no machine active before; otherwise silently switching a working
  session to a different computer would be worse than an extra "Use this"
  click.
- Revoking is described in the UI as what it actually does: it stops a
  machine from *reconnecting*, it does not sever a connection already open.
- The `Machines` settings section does not render at all in a local build —
  a one-row list of the machine you are already on is noise, not a feature.

## Architectural rules

- Token providers for both the socket and storage calls are installed during
  React **render**, not inside a `useEffect`: effects on a child component
  (`DeviceGate`) run before effects on its parent (`AuthedConnect`), so an
  effect-based registration meant the device list's first fetch, and the
  first socket connect, both fired with no Clerk token attached.
- `switchDevice` closes the existing socket rather than waiting for it to
  drop and clears `bootstrapped` before reconnecting — every in-flight
  message on the old socket belongs to the old machine's bridge, and
  delivering one after the switch would attribute a session to the wrong
  host.
- The socket URL is built with `new URL(...)`/`searchParams`, not string
  concatenation — the relay matches its endpoint path exactly, and
  concatenating a token onto a URL that already had a trailing segment once
  produced a non-matching path.

## Related decisions

- [device-pairing](device-pairing.md)
- [remote-relay-bridge](remote-relay-bridge.md)
- [production-deployment](production-deployment.md) — the topology this gate
  exists for
