# Web Push notifications

## Purpose

Alert the user about a session (`done`, `waiting-permission`, `waiting-approval`) while the
[mobile client](mobile-client.md) is backgrounded or closed. iOS suspends a home-screen app's page
and its WebSocket the moment it leaves the foreground, so nothing running in the page can raise an
alert there — but the bridge is always on, on the user's own machine, and Web Push doesn't need the
page alive: the bridge hands the push service (Apple/Google/Mozilla/Microsoft) an encrypted
message, and the OS wakes the service worker just long enough to call `showNotification`. Needs
iOS 16.4+, the app added to the home screen, and a permission prompt granted from a tap.

## Entry points

- Settings → Alerts, turned on. The permission prompt and the push subscription both start there.
- `web/public/sw.js`'s `push` and `notificationclick` handlers — fire with no page open at all.

## Files

- `web/public/sw.js` — the service worker: `push` shows the notification, `notificationclick`
  focuses or opens the app and posts `openSession` to it
- `web/src/lib/push.ts` — `registerServiceWorker`, `ensurePushSubscription`, `getVapidKeys`,
  `removePushSubscription`, `isIos`/`isStandalone`
- `web/src/lib/alerts.ts` — `notify()`'s service-worker path (falls back to the page-level
  `Notification` constructor); shares `isAlertTransition`/`alertBody` with the bridge
- `web/src/lib/machines.ts` — `alertTarget`, the click-routing lookup; see
  [multi-machine-client](multi-machine-client.md)
- `web/src/store.ts` — `setAlertsEnabled` registers/unregisters on every owner link;
  `openSessionFromAlert`; a `hello` from a push-capable owner machine re-sends `registerPush`
- `web/src/ws.ts` — `sendToMachine(deviceId, msg)`, the one way to reach a non-primary owned
  machine outside the normal session-routed `send()`
- `web/src/components/NotificationsSection.tsx` — the Alerts pane, including the "Add to Home Screen" hint on iOS outside standalone
- `server/src/pushNotifier.ts` — `PushNotifier`: registration storage, the endpoint allowlist, and
  the actual send
- `server/src/store.ts` — `loadPushSubscriptions`/`savePushSubscriptions`
  (`push-subscriptions.json`, mode `0600`)
- `server/src/userContext.ts` — one `PushNotifier` per user; `onSessionUpsert` called from the
  `broadcast` closure, skipped while sync is applying pulled state
- `server/src/index.ts` — `registerPush`/`unregisterPush` dispatch; `pushAvailable: true` on the
  owner `hello`
- `shared/types.ts` — `registerPush`/`unregisterPush` messages, `ALERT_STATUSES`,
  `isAlertTransition`, `alertBody`, `PushSubscriptionJson`, `VapidKeyPair`, `PushRegistration`,
  `PushPayload`
- `deploy/docker/web-nginx.conf` — `location = /sw.js` with `Cache-Control: no-cache`

## Symbols

- `isAlertTransition(prev, next)` (shared) — the one rule behind both the in-page chime and a
  push: fires only on a transition *into* `done`/`waiting-permission`/`waiting-approval`, never on
  a repeat, an archived session, or one with running `backgroundTasks`. No previous status (a
  bridge restart, a session never seen before) is not a transition
- `alertBody(session)` (shared) — the notification text; same labels the sidebar badge uses
  (`waitingPermissionMeta`)
- `PushNotifier` — one per user. `register`/`unregister` upsert/remove by subscription endpoint;
  `onSessionUpsert(meta)` keeps its own `Map<sessionId, lastStatus>` (the bridge mutates `meta` in
  place, so the previous status is gone by broadcast time) and calls the injected sender on a
  transition
- `isAllowedPushEndpoint(endpoint)` — the SSRF guard: `https:` only, no port, no userinfo, host is
  `fcm.googleapis.com` or ends in `.push.apple.com` / `.push.services.mozilla.com` /
  `.notify.windows.com`
- `ensurePushSubscription()` — this device's subscription, created against this device's VAPID key
  if needed; re-subscribes when an existing subscription was made under a different key
- `getVapidKeys()` — this device's P-256 keypair, minted with WebCrypto on first use and kept in
  localStorage
- `alertTarget(...)` — where a click has to land: the session's machine plus, from that machine's
  own project list, the tab the session belongs to (key-aware, same rule as `sessionsInProject`)
- `openSessionFromAlert(id)` (store) — switches the primary machine when the session isn't hosted
  there, activates its project tab, then selects it

## Data flow

1. **Subscribe.** Settings → Alerts on → `Notification.requestPermission()` granted →
   `ensurePushSubscription()` creates a `PushSubscription` under this device's VAPID public key →
   the store sends `registerPush { subscription, vapid }` to every owned machine whose `hello` said
   `pushAvailable`. Idempotent: also re-sent whenever an owner link's `hello` lands, so a newly
   paired machine or one that lost its subscriptions file picks it up.
2. **Register.** The bridge validates the endpoint against the allowlist and the key shapes
   (`parseRegistration`), upserts by endpoint into `push-subscriptions.json`, and does nothing
   further with the wire message — it never contacts the push service until there is something to
   send.
3. **Session settles.** `SessionManager` broadcasts `sessionUpsert`. `userContext`'s `broadcast`
   closure calls `pushNotifier.onSessionUpsert(session)` — unless the broadcast is happening while
   `sync.applying` is true, i.e. `adoptSynced` folding in a session pulled from another machine.
   `isAlertTransition` decides whether this is push-worthy; `alertBody` builds the text.
4. **Send.** For each registration, `webpush.sendNotification(subscription, payload, {
   vapidDetails: { subject, publicKey, privateKey }, TTL: 3600 })`. A 404/410 deletes that
   registration; any other failure is logged and the registration is kept.
5. **Deliver.** The push service wakes `sw.js`'s `push` handler, which calls
   `registration.showNotification(title, { body, tag: sessionId, icon, data: { sessionId } })`.
   `tag = sessionId` collapses a push and an in-page alert for the same session into one
   notification.
6. **Click.** `notificationclick` focuses an open Lines window and posts
   `{ type: 'openSession', sessionId }` to it, or calls `clients.openWindow('/session/<id>')` when
   none is open. The page's `registerServiceWorker` listener and the URL-to-store effect
   (`App.tsx`) both funnel into `openSessionFromAlert`, which uses `alertTarget` to switch machine
   and project tab before selecting the session.
7. **Unsubscribe.** Alerts off → `removePushSubscription()` unsubscribes the browser and returns
   its endpoint → `unregisterPush { endpoint }` to every owned machine.

## Tests

- `server/src/pushNotifier.test.ts` — `isAlertTransition` on every case above; the endpoint
  allowlist against http, IP literals, ports, userinfo and unlisted hosts; `register`/`unregister`
  upsert/remove semantics, including an identical re-register costing no write; a malformed row on
  disk is dropped rather than crashing the load; a 410 from the injected sender deletes the
  subscription while any other failure keeps it; `pushPayload` names the permission kind the same
  way the sidebar badge does
- `server/src/machineMerge.test.ts` — `alertTarget` (imports `web/src/lib/machines.ts`; see
  [multi-machine-client](multi-machine-client.md))
- `server/src/messageAuthz.test.ts` — `registerPush`/`unregisterPush` are in the owner-only,
  never-grantable set

## Business rules

- Subscriptions are **bridge-local**, stored per user in `push-subscriptions.json` and never
  synced — no storage schema change. Each bridge the user owns keeps its own list of that user's
  devices.
- The **device mints its own VAPID keypair**, not the bridge. One browser `PushSubscription` is
  tied to one application-server key, so with several machines every bridge has to sign with the
  same key — the device is the only party common to all of them, so it creates the key and hands
  it to each bridge it registers with.
- **Owner only.** `registerPush`/`unregisterPush` need `{ needs: 'owner' }`: a guest's access is
  already narrowed to specific sessions, and a push subscription would leak every session on the
  machine regardless of that grant. The bridge also POSTs to whatever endpoint the client supplies,
  which is the second reason.
- **Endpoint allowlist**, to block SSRF through that POST: `https:` only, no explicit port, no
  userinfo, and the host must be `fcm.googleapis.com` or end in `.push.apple.com`,
  `.push.services.mozilla.com`, or `.notify.windows.com`.
- **Not scoped to the primary machine**, like `maybeAlert`: a device registers with every owned
  machine, and each bridge pushes for the sessions it hosts whether or not it's the one currently
  in front of the user. See [multi-machine-client](multi-machine-client.md).
- **No push for synced sessions.** `adoptSynced` broadcasts `sessionUpsert` for a session that ran
  on another machine and has been reset to idle here; `userContext` skips `onSessionUpsert` while
  `sync.applying`, so that reset never reads as a transition worth pushing.
- **No alert between workflow steps.** `isAlertTransition` is false for a `done` whose workflow
  is started, whose current step still reads `running` (the engine hasn't decided yet), and which
  is not the last step. An advance then broadcasts the next step running; a park broadcasts
  `waiting-approval`, which still alerts as "Needs approval". The last step's `done` alerts.
  Relies on the settle upsert going out before `onWorkflowTurnComplete` updates step statuses.
  See [workflow-step-lifecycle](workflow-step-lifecycle.md).
- **Tag-based dedupe.** A push and an in-page alert for the same session both use
  `tag: sessionId`, so on one device they collapse into a single notification instead of stacking.
- **Version skew.** The owner `hello` carries `pushAvailable: true`; the client only sends
  `registerPush` to a machine that said so, rather than to every bridge unconditionally — an older
  bridge would otherwise answer the unknown message type with a visible `error` on every `hello`.
- **iOS needs the home-screen app.** Push only reaches iOS/iPadOS from the app added to the home
  screen (`display-mode: standalone`), iOS 16.4+, and a permission prompt triggered by a tap.
  Settings shows an "Add to Home Screen" hint when `isIos() && !isStandalone()`.
- **The service worker must always show a notification.** iOS may revoke a subscription that
  receives a push with no visible notification, so `sw.js`'s `push` handler calls
  `showNotification` unconditionally, even on unparseable payload data.
- **iOS adds "from <app name>" under the title.** iOS renders home-screen web app notifications as
  title / `from <manifest name>` / body. Nothing in the payload, `showNotification` options or
  manifest removes it, and blanking the manifest name breaks the "from" line and the home-screen
  icon label, so leave it. Recheck if a later iOS release changes the format.
- A bridge restart's transition map starts empty, so a session that settles immediately after
  restart does not push — accepted, since the alternative (persisting last-seen status) risks a
  duplicate push on the next real transition.
- The private VAPID key sits in this device's localStorage and is sent only to this user's own
  bridges; if it leaked, it would let someone send pushes to that one device's subscription only.

## Architectural rules

- `sw.js` handles **only** `push` and `notificationclick` — no `fetch` handler, no cache. This is
  what keeps the old "no service worker" reasoning intact (see
  [mobile-client](mobile-client.md)): with no `fetch` handler, every request still goes to the
  network, so a worker can never serve a stale bundle against a newer bridge.
- `PushNotifier` is modeled on `SpendHistory`: one instance per `UserContext`, backed by a single
  JSON file loaded at construction and rewritten on change, with the network call itself injected
  so tests never reach it.
- The alert transition rule lives once, in `shared/types.ts` (`isAlertTransition`, `alertBody`,
  `ALERT_STATUSES`), and both the page's `maybeAlert` and the bridge's `PushNotifier` call it — so
  a phone and a desktop tab can never disagree about what counts as an alert or what it says.
- `alertTarget` is a plain function in `web/src/lib/machines.ts`, imported directly by
  `server/src/machineMerge.test.ts` under `node:test`, the same pattern every other multi-machine
  merge/prune/select rule in that file follows.
- `notify()` prefers the service worker (`registration.showNotification`) when one is registered,
  and falls back to the page-level `new Notification` only when there is none — including inside
  the desktop Electron window, whose service-worker notification support is unverified and which
  has no IPC through which a worker could raise the window itself. The page-level path keeps a
  reference to every open `Notification` object so its `onclick` handler is not garbage-collected
  out from under it once the banner moves to Notification Center.

## Related decisions

- [mobile-client](mobile-client.md) — the surface this exists for, and the no-cache-worker
  reasoning it extends rather than replaces
- [multi-machine-client](multi-machine-client.md) — the not-scoped-to-primary push rule and the
  machine/project click routing
- [session-and-project-ui](session-and-project-ui.md) — `maybeAlert`'s transition rule, now shared
  with the bridge via `isAlertTransition`
- [end-to-end-encryption](end-to-end-encryption.md) — Web Push has its own end-to-end encryption
  (the push service only ever sees ciphertext); unrelated to, and not a substitute for, the app's
  own E2EE channel
