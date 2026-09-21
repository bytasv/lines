# Multi-machine client

## Purpose

Hold a live link to more than one machine at once, so a browser can show its own sessions and a
session shared with it side by side — without the two ever bleeding into each other. This
dismantles the client's single-socket assumption: `web/src/ws.ts` used to hold one module-level
`socket`, and `switchDevice` closed it and called `clearBootstrap()` on every switch specifically
so that "delivering a stale frame to the new machine would attribute a session to the wrong
host" could never happen. Sharing a session (see
[session-collaboration](session-collaboration.md)) means holding two machines' sessions at once,
so that guard had to become structural instead of a teardown.

Three reducers were correct for exactly one machine and silently destructive for two — replace
the whole session map on `hello`, prune every draft with no matching live session, auto-select
anything newly created — and are the highest-risk part of this feature for exactly that reason.

## Entry points

- `web/src/main.tsx` — connects every machine shared with the signed-in user, not just the
  primary, on device-list load
- `switchDevice(id)` (`web/src/ws.ts`) — point the UI at a different machine without tearing down
  any other open link
- A session row / session header / composer for a session hosted on a non-primary machine
  (`web/src/components/Sidebar.tsx`, `SessionView.tsx`, `Composer.tsx`)
- Settings → Machines (`web/src/components/DevicesSection.tsx`) — the three-state health dot per
  machine

## Files

- `web/src/lib/machines.ts` — the pure per-machine reducers: `mergeMachineSessions`,
  `prunableDraftIds`, `shouldClaimSelection`, `emptyMachine`, `MachineSlice`
- `web/src/lib/wake.ts` — the pure per-link wake decision: `wakeAction`, `probeExpired`,
  `wakeDebounced`, `bootDial`
- `web/src/ws.ts` — `MachineLink`, the `links: Map<deviceId, MachineLink>`, `connectMachine`,
  `disconnectMachine`, `linkFor`/`linkForMessage`, per-link heartbeat/retry/auth-relay/idle
  timers, `fileRequest`'s machine-aware default
- `web/src/store.ts` — `machines: Record<string, MachineSlice>`, `primaryDeviceId`,
  `sessionMachine: Record<sessionId, deviceId>`, `setPrimaryMachine`, the per-machine
  `applyServerMessage`/`setConnectionStatus`/`setMachineOffline`/`workerStatus`/`storageStatus`/
  `updateStatus`/`bridge`/`protocolSkew` handling, `draftSessionIds`/`pruneDrafts`/
  `pruneDraftAttachments` (inverted to take the ids to delete)
- `web/src/lib/can.ts` — `useSessionMachine`, `useSessionMachineHealth` (both `useShallow`-wrapped
  — see Architectural rules)
- `web/src/lib/machineHealth.ts` — `linkedMachineHealth`, `unlinkedMachineHealth`,
  `MachineHealthState` (the three-state model)
- `web/src/components/MachineDot.tsx`, `DevicesSection.tsx`, `ConnectingMachine.tsx` — the health
  dot and the pairing/connecting screens' "switch to another machine" affordances
- `web/src/components/Sidebar.tsx` — the remote-session left accent and host avatar chip
- `web/src/components/Composer.tsx`, `SessionView.tsx` — judge a session's own machine's health,
  not the primary's

## Symbols

- `MachineSlice` — `{ deviceId, scope, connectionStatus, machineOffline, bootstrapped, worker,
  storage, update, bridge, ownerProfile }`, one per machine in `store.machines`
- `mergeMachineSessions({ sessions, sessionMachine, deviceId, incoming })` — folds one machine's
  `hello` into the shared session map. Drops only the sessions *stamped to this machine* that it
  no longer reports; every other machine's stamped sessions pass through untouched; an unstamped
  session with no live claim from any hello is kept rather than guessed away
- `prunableDraftIds({ draftIds, sessionMachine, deviceId, live })` — the ids a `hello` may delete
  drafts for: exactly the ones stamped to *this* machine and no longer live. A draft for a
  session id with no stamp at all — another machine's link not yet open — is never touched
- `shouldClaimSelection({ fromPrimary, pendingCreate, alreadySeen })` — `pendingCreate` and
  `alreadySeen` are the pre-existing intent-based rule (see
  [session-and-project-ui](session-and-project-ui.md)); `fromPrimary` is the new half, so a
  session created on a machine the user is not looking at can never steal their view
- `linkFor(deviceId)` — get-or-create a `MachineLink`; every per-socket timer, the retry state,
  and in-flight `fileRequest`s live on it, replacing what used to be `ws.ts` module globals
- `linkForMessage(msg)` — routes a `ClientMessage` to the machine hosting its `sessionId` (via
  `sessionMachine`), or the primary for anything session-less
- `useSessionMachine(sessionId)` / `useSessionMachineHealth(sessionId)` — a session's host device
  id/owner profile, and that machine's own three-state health, independent of the primary
- `linkedMachineHealth` / `unlinkedMachineHealth` — the three-state model: not linked (only
  `lastSeenAt`, no live claim), linked with no bridge attached (the relay's `deviceOffline`
  frame), and attached (then `worker`/`storage` sub-health)
- `wakeAction(link, now)` — what a resumed tab does with one link: `'redial'` for a socket already
  `CLOSED`/`CLOSING`, `'probe'` for `OPEN` (never a close-on-suspicion), `'none'` for `CONNECTING`
  or a probe already in flight
- `probeExpired(link, now)` — judges a wake probe against its **own** stamp
  (`awaitingProbeSince`), not `lastPongAt` alone — the heartbeat's stall guard re-baselines
  `lastPongAt` on a late tick, which a resumed tab's first tick always is
- `bootDial(remembered, devices, dialed)` — `{ dial, drop }`: dial the remembered machine while
  the device list is still in flight, and drop it once the list lands if it isn't in there

## Data flow

### Which machines connect

`main.tsx` connects the primary plus every device the storage `/v1/devices` list marks `shared:
true`. `connectMachine` enforces `LINK_CAP` (4) and logs when it drops one rather than silently
connecting to a subset — a silent cap would read as "connected to everything" when it isn't.

### `switchDevice` no longer tears anything down

`switchDevice` sets the primary and calls `setPrimaryMachine`, which re-derives the legacy scalar
fields (`connectionStatus`, `machineOffline`, `bootstrapped`, `workerStatus`, `storageStatus`,
`updateStatus`, `bridge`, `protocolSkew`) from that machine's `MachineSlice`. `protocolSkew` is
recomputed rather than copied, gated on `bootstrapped` — before a machine's first `hello`, `bridge`
is "not asked yet", not a pre-versioning bridge, and reading that as skew would flash the pill on
every switch. It neither closes the previous link nor calls
`clearBootstrap()` — the previous machine's sessions and connection stay exactly as they were,
which is the entire point of holding more than one.

### The `hello` merge

Each `hello`'s `sessions` folds into the shared map via `mergeMachineSessions` instead of
replacing it — the single-machine version replaced the whole map, so whichever machine's `hello`
landed last silently erased every other machine's sessions from the sidebar. `sessionMachine` is
stamped from the same call, and is deliberately **not** a field on `SessionMeta`: that blob syncs
to Postgres, and which machine currently hosts a session is a property of this client's live
connections, not of the session's persisted metadata.

Draft pruning runs against `prunableDraftIds`, not the live set directly — the old
`pruneDrafts`/`pruneDraftAttachments` took the *live* session ids and deleted every draft not in
that set, which is exactly backwards once a second machine's sessions (with their own drafts) can
be off-map while that machine's link is still connecting. Both functions were inverted to take
the ids to **delete**.

### Routing a message and a file request

`send()` calls `linkForMessage`, which looks up `sessionMachine[msg.sessionId]` for anything
session-scoped and falls back to the primary otherwise — a prompt for a shared session reaches
the machine that actually hosts it, never the primary. `fileRequest` defaults to the *selected
session's* machine (`machineForSelectedSession()`), not the primary: the file tree, `@mention`
search and docs are all driven by that session's cwd, so with a shared session open those paths
exist only on the host's disk.

### Session-row and composer differentiation

`useSessionMachine(sessionId)` reports whether a session's host differs from the primary. The
sidebar row gets a left accent in a colour reserved for "somebody else's machine" plus the host's
avatar; the composer gets the same accent on its border, since that is the surface where typing
into the wrong machine unaware actually happens. Both read `useSessionMachineHealth`, which
looks up the session's *own* `MachineSlice` rather than the primary's — a shared session hosted on
a sleeping laptop must show offline even while the machine in front of the user is fine.

### Waking a backgrounded tab

A backgrounded tab is throttled, so a socket the OS tore down while it slept is otherwise only
discovered by the heartbeat — up to ~11.5s (a full `PONG_TIMEOUT_MS` plus `RECONNECT_DELAY_MS`) —
and the heartbeat's own stall guard makes that worse: a resumed tab's first tick is always late,
so the guard re-baselines `lastPongAt` and forgives its way into a second full window.

`wireConnectivity()` listens for `document.visibilitychange` (acting only when `!document.hidden`)
and `window.pageshow` guarded by `event.persisted` (bfcache restore, which on iOS Safari may not
come with a visibility change at all), debounced by `WAKE_DEBOUNCE_MS` so the two collapse into
one wake. For every link that currently holds a socket — the same "a shared machine must be back
on screen too" reasoning as the `online` handler — a `CLOSED`/`CLOSING` socket is redialled via
`reconnectMachine` at once; an `OPEN` one is probed rather than closed on suspicion: a ping goes
out through `writeToLink` (never `socket.send`, to avoid the e2ee plaintext-downgrade the bridge
would close over), stamped with `awaitingProbeSince`, and judged against that stamp — not
`PONG_TIMEOUT_MS` — after `WAKE_PROBE_TIMEOUT_MS`. A link with no socket at all was
idle-disconnected on purpose (`IDLE_DISCONNECT_MS`) and is left alone; reviving it on every tab
switch would defeat that.

`bootDial` (also in `lib/wake.ts`) decides the optimistic pre-list dial the gate makes at boot —
see [hosted-machine-access](hosted-machine-access.md#the-gate) for that flow; it lives beside
`wakeAction` because both are the same kind of pure, dependency-free decision this feature keeps
out of `ws.ts` and `main.tsx`.

## Dependencies

- [session-collaboration](session-collaboration.md) — the grant model that determines which
  machines appear as `shared: true`, and the presence/attribution surfaces that also read
  `useIdentityResolver`/`sessionMachine`.
- [hosted-machine-access](hosted-machine-access.md) — `deviceOffline`/`deviceOnline` relay control
  frames, and the device-list shape this layers `shared`/`scope`/`ownerProfile` onto.
- [session-and-project-ui](session-and-project-ui.md) — `pendingCreate`/`seenSessionIds`, which
  `shouldClaimSelection` reuses unchanged;
  `ConnectionBanner`/`SkewBanner`/`WorkerBanner`/`StorageBanner`/`UpdateBanner`'s precedence rule,
  which stays scoped to the primary machine (see [turn-recovery](turn-recovery.md#multi-machine)).
- zustand v5's `useSyncExternalStore`-backed `useStore` — any selector returning a freshly built
  object per call must be wrapped in `useShallow`, or it re-renders on every store tick (see
  Architectural rules).

## Tests

- `server/src/machineMerge.test.ts` — imports `web/src/lib/machines.ts` directly (see
  Architectural rules) and covers every merge/prune/select rule, including the destructive cases
  each replaces: another machine's sessions survive a `hello`; a session a machine stops
  reporting is dropped but only its own; an unstamped session with no claimant is kept; a draft
  for an unknown session is never pruned; a session created on another machine never steals the
  selection
- `server/src/wakeRedial.test.ts` — imports `web/src/lib/wake.ts` directly, the same
  dependency-free pattern: every `readyState` → expected wake action, a pong that lands after the
  probe stamp reading as healthy, the heartbeat's stall-forgiveness *not* being able to rescue an
  unanswered probe, the wake debounce window, and `bootDial`'s four cases (nothing remembered,
  remembered present, remembered absent → drop, empty list → drop).
- No automated coverage for the rest of the transport (`ws.ts`'s socket lifecycle, timers, the
  link cap) — the web workspace has no test runner; verified by hand per the plan's own checklist
  (draft survival across a reconnect, per-machine health while the primary stays healthy, file
  reads routing to the session's host, a backgrounded tab's redial time)

## Business rules

- The primary machine's `connectionStatus`/`machineOffline`/`bootstrapped`/`protocolSkew`/`bridge`/
  `workerStatus`/`storageStatus`/`updateStatus` are the only values
  `ConnectionBanner`/`SkewBanner`/`WorkerBanner`/`StorageBanner`/`UpdateBanner` read — see
  [turn-recovery](turn-recovery.md#multi-machine). A non-primary machine's health never reaches
  those banners; it surfaces on the session row and header instead.
- A shared machine connects automatically (up to `LINK_CAP`); an idle non-primary link
  disconnects after `IDLE_DISCONNECT_MS` and reconnects on selection.
- A session's `sessionMachine` stamp is per-client, in-memory state — never persisted, never
  synced, and reset to nothing on reload (re-derived from the next round of `hello`s).
- Auto-selecting a freshly created session additionally requires the creating frame to have come
  from the primary machine; a session created elsewhere never steals the current view.
- A resumed tab probes every link it holds a socket for and redials only one that fails the
  probe; an idle-disconnected link (`socket === null`) stays down — a tab switch must not defeat
  `IDLE_DISCONNECT_MS`.

## Architectural rules

- Every merge/prune/select rule that touches more than one machine's state lives in
  `web/src/lib/machines.ts` as a plain function taking its inputs explicitly, specifically so it
  is unit-testable without a socket, a store, or React — the single highest-risk surface in this
  feature is exactly the kind of reducer that looks correct for one machine and is silently
  destructive for two.
- `prunableDraftIds`/`pruneDrafts`/`pruneDraftAttachments` take the ids to **delete**, not the
  ids to keep — the inverted signature makes the destructive "drop everything not live" version
  impossible to write by accident.
- `MachineLink` owns every piece of per-socket state that used to be a `ws.ts` module global
  (socket, generation counter, retry/heartbeat/auth-relay timers, in-flight `fileRequest`s).
  `socketGeneration`'s original purpose — discarding a superseded socket's in-flight frames — now
  holds per link; cross-*machine* misattribution is structural (every frame carries the link it
  arrived on), but a reconnect within one link still needs the per-link counter.
- Two selectors (`useSessionMachine`, `useSessionMachineHealth`) build a fresh derived object per
  call and must be wrapped in `useShallow`; zustand v5 hands a selector straight to
  `useSyncExternalStore`, which treats a new object reference as new state and re-renders without
  end otherwise. Every other selector in this feature returns a primitive or a stable store
  reference and needs no wrapper.
- `web/src/lib/machines.ts` is imported directly by a `server/`-side test file
  (`machineMerge.test.ts`) purely so it can run under `node:test` without a browser — this is the
  same "read the file as a dependency-free module" pattern used for `web/src/lib/identityRule.ts`
  and is not a real cross-workspace dependency; `web/src/lib/wake.ts` and
  `server/src/wakeRedial.test.ts` follow the identical pattern.
- Lifecycle listeners (`visibilitychange`, `pageshow[persisted]`) are registered exactly once,
  from `wireConnectivity()` in `ws.ts`, never from a component effect — reconnect policy stays
  owned by `ws.ts`, and a component would register one listener per mount. The wake probe uses its
  own stamp (`awaitingProbeSince`) and its own timeout (`WAKE_PROBE_TIMEOUT_MS`), never
  `PONG_TIMEOUT_MS`, so the heartbeat's stall-forgiveness (`ws.ts`'s late-tick re-baseline of
  `lastPongAt`) cannot extend it.

## Related decisions

- [session-collaboration](session-collaboration.md) — the grant model that makes a second
  machine appear in the device list at all.
- [hosted-machine-access](hosted-machine-access.md) — the relay control frames and device-verify
  machinery this layers on.
- [session-and-project-ui](session-and-project-ui.md) — `pendingCreate`/`seenSessionIds`, reused
  unchanged inside `shouldClaimSelection`.
- [turn-recovery](turn-recovery.md) — the banner precedence rule, now qualified to the primary
  machine only.
