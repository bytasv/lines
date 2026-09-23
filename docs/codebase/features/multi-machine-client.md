# Multi-machine client

## Purpose

Hold a live link to more than one machine at once, but show exactly one machine's sessions,
projects, library and account state at a time — chosen from a switcher in the header — so a
browser holding a shared machine's link alongside its own never has to merge two owner states.
This dismantles the client's single-socket assumption: `web/src/ws.ts` used to hold one
module-level `socket`, and `switchDevice` closed it and called `clearBootstrap()` on every switch
specifically so that "delivering a stale frame to the new machine would attribute a session to the
wrong host" could never happen. Sharing a session (see
[session-collaboration](session-collaboration.md)) means holding two machines' sessions at once,
so that guard had to become structural instead of a teardown.

Earlier revisions of this feature showed a guest's sessions *alongside* the owner's own, merged
into one sidebar. That inverted the bridge's own contract: a shared machine's `hello` deliberately
carries only sessions and nothing else — except `projects`/`projectKeys` at machine scope, since a
whole-machine grant lends the projects too (see `server/src/index.ts`'s `buildHello`, and
[session-collaboration](session-collaboration.md)) — and the client
used to write the rest of a `hello` — projects, the library, usage, account state — straight into
one global set regardless of which machine sent it. A guest's thin `hello` landing there blanked
the owner's own UI (empty projects, a narrowed `access`) until the owner's own machine's next
`hello` put it back — a visible flicker between the two machines' state. The fix scopes a `hello`'s
owner-state fields to the machine that sent it (`MachineSlice.view`) and projects only the
*primary* machine's view onto the globals; the session list itself narrows to one machine's
sessions for display, via `sessionsOnMachine`.

Four reducers were correct for exactly one machine and silently destructive for two — replace the
whole session map on `hello`, prune every draft with no matching live session, auto-select
anything newly created, and (added by this scoping) write a machine's owner state into the global
fields regardless of who sent it — and are the highest-risk part of this feature for exactly that
reason.

## Entry points

- `web/src/main.tsx` — connects every machine shared with the signed-in user, not just the
  primary, on device-list load
- `switchDevice(id)` (`web/src/ws.ts`) — point the UI at a different machine without tearing down
  any other open link
- `web/src/components/MachineSwitcher.tsx` — the header control that picks the machine the
  sidebar, project tabs and account UI describe
- A session row / session header / composer for a session hosted on a non-primary machine
  (`web/src/components/Sidebar.tsx`, `SessionView.tsx`, `Composer.tsx`)
- Settings → Machines (`web/src/components/DevicesSection.tsx`) — the three-state health dot per
  machine, and the second surface `MachineSwitcher` shares its switch/health logic with

## Files

- `web/src/lib/machines.ts` — the pure per-machine reducers: `mergeMachineSessions`,
  `prunableDraftIds`, `shouldClaimSelection`, `machineView`, `sessionsOnMachine`, `emptyMachine`,
  `emptyView`, `MachineSlice`, `MachineView`
- `web/src/lib/wake.ts` — the pure per-link wake decision: `wakeAction`, `probeExpired`,
  `wakeDebounced`, `bootDial`
- `web/src/ws.ts` — `MachineLink`, the `links: Map<deviceId, MachineLink>`, `connectMachine`,
  `disconnectMachine`, `linkFor`/`linkForMessage`, per-link heartbeat/retry/auth-relay/idle
  timers, `fileRequest`'s machine-aware default
- `web/src/store.ts` — `machines: Record<string, MachineSlice>`, `primaryDeviceId`,
  `sessionMachine: Record<sessionId, deviceId>`, `setPrimaryMachine`, the `hello` reducer's
  `fromPrimary` gate on every owner-state field, `reconcileSeenStatus` scoped by
  `sessionsOnMachine`, `draftSessionIds`/`pruneDrafts`/`pruneDraftAttachments` (inverted to take
  the ids to delete)
- `web/src/lib/can.ts` — `useSessionMachine`, `useSessionMachineHealth` (both `useShallow`-wrapped
  — see Architectural rules)
- `web/src/lib/machineHealth.ts` — `linkedMachineHealth`, `unlinkedMachineHealth`,
  `MachineHealthState` (the three-state model)
- `web/src/components/MachineDot.tsx`, `MachineSwitcher.tsx`, `DevicesSection.tsx`,
  `ConnectingMachine.tsx` — the health dot, the header/phone-drawer switcher, and the
  pairing/connecting screens' "switch to another machine" affordances
- `web/src/components/Sidebar.tsx` — the three session groups scoped to the active machine, and
  the remote-session left accent/host avatar chip for anything still routed cross-machine
- `web/src/components/ProjectTabs.tsx` — mounts `MachineSwitcher` in place of the old
  brand/tabs separator dot, and scopes the project tab's status dot the same way the sidebar is
  scoped
- `web/src/components/Composer.tsx`, `SessionView.tsx` — judge a session's own machine's health,
  not the primary's

## Symbols

- `MachineSlice` — `{ deviceId, scope, connectionStatus, machineOffline, bootstrapped, worker,
  storage, update, bridge, ownerProfile, view }`, one per machine in `store.machines`; `view` is
  the machine's `MachineView`
- `MachineView` — the owner-state payload one machine's `hello` carries: `projects`,
  `projectKeys`, `recentDirs`, `workflows`/`sharedWorkflows`, `steps`/`sharedSteps`/`pinnedSteps`,
  `recipes`/`sharedRecipes`/`recipeStats`, `models`, `usage`/`openaiUsage`, `auth`/`openaiAuth`,
  `access`, `guardAllowlist`/`guardReview`, `memoryReview`, `mcpConnections`/`mcpReview`. Named
  field-for-field after the matching global store fields — see Architectural rules
- `machineView(msg, prev)` — pure fold of one `hello` into a `MachineView`; `prev` is that same
  machine's own previous view (never the globals), which is what lets the "keep the last good
  `usage`/`openaiUsage` snapshot across a restart" rule survive a second machine's `hello` landing
  in between. `projects` is the host's own list when `hello` sends one (owner, or a machine-scope
  guest); otherwise (a session-scope guest, or an old bridge) it falls back to `guestProjects`
- `guestProjects(sessions, projectKeys)` — synthesises project tabs for a session-scope guest, who
  gets no project list of their own, from the `cwd` of the sessions actually shared with them.
  Sessions sharing a project key (a work tree and its repo) collapse into one tab, named after the
  shortest of their paths
- `sessionsOnMachine(sessions, sessionMachine, deviceId)` — the sessions hosted by one machine, for
  display only; the store still holds every linked machine's sessions. A direct local bridge
  stamps `''` and has `primaryDeviceId: null`, so callers pass `primaryDeviceId ?? ''`
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
- `MachineSwitcher` — the header/phone-drawer machine picker; reads `useDevices` for the row list,
  `state.machines[id]` for a linked row's health (`linkedMachineHealth`) or
  `unlinkedMachineHealth(device)` otherwise, and `machineActivity` (fed a per-machine scoped
  session set) for each background row's running/needs-you counts. Renders only when
  `SHARING_ENABLED`
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
`updateStatus`, `bridge`, `protocolSkew`) from that machine's `MachineSlice`, and additionally
spreads its `view` over the same global owner-state fields the `hello` reducer writes (below) —
one switch swaps projects, library, usage and account state atomically, with no round trip.
`activeProject` is recomputed against the new `view.projects` (skipped before that machine's first
`hello`, so a remembered project across a reload survives the pre-bootstrap state), and
`selectedSessionId` is cleared when the previously selected session's `sessionMachine` stamp isn't
the new primary — otherwise `App.tsx`'s "a selected session re-activates its project" effect would
drag the old project tab back across onto the new machine. `protocolSkew` is recomputed rather than
copied, gated on `bootstrapped` — before a machine's first `hello`, `bridge` is "not asked yet",
not a pre-versioning bridge, and reading that as skew would flash the pill on every switch.
`setPrimaryMachine` no-ops entirely when the requested id is already primary, since a refresh that
re-runs the same pick must not re-derive (and thereby revert) state a later `hello` has since moved
on from. None of this closes the previous link or calls `clearBootstrap()` — the previous machine's
sessions and connection stay exactly as they were, which is the entire point of holding more than
one.

### The `hello` reducer: one machine's owner state, gated by `fromPrimary`

The bridge's own contract for a guest's `hello` is that it carries only `sessions` — `projects`,
`workflows`, `usage`, `auth`, `access` and the rest are empty or omitted (see
[session-collaboration](session-collaboration.md)). The reducer honours that contract by folding
every one of those fields into `machineView(msg, prev)` and writing the result to
`machines[from].view` unconditionally, but only spreading that `view` onto the matching global
store fields when `from === primaryDeviceId` (`fromPrimary`). A background machine's `hello` —
including a *repeated* one, which the duplicate-hello short-circuit below does not by itself make
inert against these fields — updates its own slice and nothing the user is currently looking at.
The four auto-open modal flags (`loginModalOpen`, `guardReviewOpen`, `memoryReviewOpen`,
`mcpReviewOpen`) stay global (a modal is a property of the window, not of a machine) but are gated
on `fromPrimary` too, so a background machine can never raise a dialog about an account the user
isn't looking at.

`sessions`, `sessionMachine` and `profiles` are the exceptions, deliberately ungated: `sessions`
still folds in via `mergeMachineSessions` (below) because the store must hold every machine's
sessions for message routing and notifications; `sessionMachine` still stamps from every `hello`
for the same reason; `profiles` is keyed by user id rather than by machine, so it accumulates
regardless of which machine's `hello` supplied a given collaborator's name.

### `projects`/`projectKeys` also arrive outside `hello`

A machine-scope guest receives live `projects`/`projectKeys` broadcasts too (see
[session-collaboration](session-collaboration.md)), not just the snapshot in `hello` — so these two
message types can land from a machine that isn't the primary. The store's handlers for both always
fold into that machine's own `machines[from].view`, and only additionally write the matching global
field when `from === primaryDeviceId`, the same `fromPrimary` split the `hello` reducer uses for
everything else. Skipping the slice write and gating on primary alone would silently drop a
background machine's project change until its next `hello`.

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

### The session list is scoped, not merged

The store keeps every linked machine's sessions — `linkForMessage` routes on `sessionMachine`, and
[session-and-project-ui](session-and-project-ui.md)'s `maybeAlert` still watches all of them so a
session left running on a background machine still notifies (see Business rules). What changed is
*display*: the sidebar's three groups (Sessions, Shared-with-me, Archived), and the project tab's
status dot via `reconcileSeenStatus`, are fed `sessionsOnMachine(sessions, sessionMachine,
primaryDeviceId ?? '')` rather than the raw `sessions` map, so a tab or a sidebar row can never
belong to two computers' worth of projects at once. Switching machines is how the other machine's
sessions come back into view — not a second group in the same list, which is the design this
feature reverses; see [session-and-project-ui](session-and-project-ui.md) for the groups
themselves.

### The header switcher

`MachineSwitcher` reads `useDevices` for the row list and the store's `machines` map for live
health, exactly the split `useSessionMachineHealth` already uses: a device with a held link reads
`linkedMachineHealth` off its `MachineSlice`, one without reads `unlinkedMachineHealth(device)` off
the relay's presence report. Each non-active row's running/needs-you counts come from
`machineActivity` fed that machine's `sessionsOnMachine` slice — null (not zero) for a machine with
no live link or a shared one, so "not connected" is never misread as "nothing running there".
Picking a row calls the same `rememberDeviceId` + `switchDevice` pair `DevicesSection.switchToDevice`
uses, so the two switch surfaces can never disagree about how a pick is made durable.
`SHARING_ENABLED` gates the whole component — a local build has one machine and no grants — and on
a phone, where the header has no room for it, the identical control renders as a named row at the
top of the projects bottom sheet instead of an icon.

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
  selection; a non-primary `hello` (repeated or not) leaves the primary's `projects`/
  `projectKeys`/`access`/`auth`/`usage` untouched; a bridge restart's `usage` carry-forward reads
  the machine's own previous view, not the primary's; `sessionsOnMachine` returns only the named
  machine's sessions and treats `''` as the local bridge; a machine-scope guest's `hello` yields
  the host's real `projects`; a session-scope guest's tabs are derived via `guestProjects` from
  their shared sessions' `cwd`, folding a work tree into its repo's tab by project key
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
- A `hello`'s owner-state fields — `projects`, `projectKeys`, `recentDirs`,
  `workflows`/`sharedWorkflows`, `steps`/`sharedSteps`/`pinnedSteps`,
  `recipes`/`sharedRecipes`/`recipeStats`, `models`, `usage`/`openaiUsage`, `auth`/`openaiAuth`,
  `access`, `guardAllowlist`/`guardReview`, `memoryReview`, `mcpConnections`/`mcpReview` — reach
  the global store only when the `hello` came from the primary machine; a non-primary `hello`,
  repeated or not, is inert against every one of them.
- The four auto-open modal flags (`loginModalOpen`, `guardReviewOpen`, `memoryReviewOpen`,
  `mcpReviewOpen`) stay global but are gated on `fromPrimary` too, so a background machine can
  never raise a dialog about an account the user isn't looking at.
- The sidebar's three groups and the project tab's status dot are scoped to
  `sessionsOnMachine(sessions, sessionMachine, primaryDeviceId ?? '')` for display; the store
  itself still holds every linked machine's sessions.
- `maybeAlert` (`web/src/lib/alerts.ts`) is deliberately **not** scoped this way — a session
  finishing on a background machine still chimes and notifies, which is the whole point of keeping
  that machine's link open; the header switcher badges the machine a notification came from. This
  is the one place the display scope and the store's full session set intentionally diverge.
- `setPrimaryMachine` spreads the new primary's `view` over the same global fields the `hello`
  reducer writes — one projection, used by both — and clears `selectedSessionId` when the
  previously selected session isn't hosted on the new primary; it no-ops when the requested id is
  already primary.
- A shared machine connects automatically (up to `LINK_CAP`); an idle non-primary link
  disconnects after `IDLE_DISCONNECT_MS` and reconnects on selection.
- `projects`/`projectKeys` follow the same primary-gate as a `hello`'s owner state even though they
  can arrive as their own message outside one: always folded into the sending machine's slice,
  projected onto the globals only when that machine is primary.
- A session's `sessionMachine` stamp is per-client, in-memory state — never persisted, never
  synced, and reset to nothing on reload (re-derived from the next round of `hello`s).
- Auto-selecting a freshly created session additionally requires the creating frame to have come
  from the primary machine; a session created elsewhere never steals the current view.
- A resumed tab probes every link it holds a socket for and redials only one that fails the
  probe; an idle-disconnected link (`socket === null`) stays down — a tab switch must not defeat
  `IDLE_DISCONNECT_MS`.

## Architectural rules

- Every merge/prune/select rule that touches more than one machine's state — plus `machineView`
  and `sessionsOnMachine` — lives in `web/src/lib/machines.ts` as a plain function taking its
  inputs explicitly, specifically so it is unit-testable without a socket, a store, or React — the
  single highest-risk surface in this feature is exactly the kind of reducer that looks correct
  for one machine and is silently destructive for two.
- `MachineView`'s fields are named identically to their global store counterparts, so
  `...slice.view` *is* the whole projection onto the globals — the `hello` reducer and
  `setPrimaryMachine` spread the same object rather than hand-listing the field set twice, which
  is what keeps a field gated in one place from going stale by being forgotten in the other (see
  Risks in the plan this feature's scoping came from: a field gated but not projected on switch
  goes stale rather than flickering — quieter, and just as wrong).
- `machineView(msg, prev)` reads its two "keep the last good snapshot across a restart"
  carry-forwards (`usage`, `openaiUsage`) from `prev` — that machine's own previous view — never
  from the global state, so a second machine's `hello` landing in between can never leak its
  snapshot into the first machine's chip.
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
