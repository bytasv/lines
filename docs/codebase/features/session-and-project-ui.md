# Session and project UI

Covers: `composer-draft-persistence`, `composer-focus-new-session`,
`project-switch-session-selection`, `project-tab-status-dot`, `session-status-badge`,
`session-create-auto-select`, `hello-duplicate-inertness`, `session-list-sorting`,
`session-groups`.

## Purpose

The shell around a session: the composer's unsent state, which session a project switch opens,
and how status is surfaced in the sidebar row and the project tab.

- **Composer draft persistence** — persist the in-progress (unsent) prompt (text, `@mention`
  pills, and staged attachments) per session, so a page reload or a bridge/server restart never
  loses what the user was composing.
- **Composer focus on a new session** — when a brand-new session is created, focus the prompt
  textarea automatically so the user can type immediately without clicking into it. Driven by the
  same create-intent signal as session-create auto-select (below), not a `createdAt` age check.
- **Project switch session selection** — decide which session is shown when the active project
  changes (tab click, `hello`/reconnect, or a `/session/<id>` deep link): keep an already-valid
  selection, or fall back to the project's own last-selected session
  (`lines.lastSessionByProject`) when that session still exists and isn't archived, or otherwise
  auto-select the top row of the user's sidebar sort among that project's *non-archived, unmuted*
  sessions. Also runs after the primary machine's `hello` when a cold launch restored an active project but
  no session is selected (and no create is pending). Never auto-open an
  archived or muted session — archived ones stay reachable only via the sidebar's Archived section.
- **Project tab status dot** — each project tab in the header shows one dot in place of the
  folder icon, picked from that project's sessions in three tiers: an unseen actionable status
  (pulsing), then live work (`running` or background work, steady blue), then a recent unseen
  finish (`done` or step finished, steady green, only within the last 24h). A background project
  signals what needs attention or is still working without opening it. Archived and muted
  sessions are excluded. The open (active)
  project's tab always shows the plain folder icon — its sessions are already listed in the
  sidebar.
- **Tool-aware waiting-permission badge** — distinguish what kind of pause a
  `waiting-permission` session is actually in (a plan awaiting approval, a question awaiting an
  answer, or a plain tool permission ask) via the sidebar badge label/color and the OS/browser
  notification body, instead of a single generic "needs permission" for all three.
- **Session-create auto-select** — which session actually gets selected right after the user asks
  to create one. Intent-based (`pendingCreate` + `seenSessionIds`) rather than a wall-clock
  comparison against the session's `createdAt`, because that timestamp is stamped on the *bridge*
  machine while the comparison ran against the *browser's* clock — fine when they're the same
  computer, silently always-true when they're not (a hosted deployment, where the bridge runs on
  the user's own machine).
- **`hello` duplicate inertness** — a repeated `hello` carrying the same session/project snapshot
  as the last one applied does nothing visible: it must not replace `sessions` or blank the
  transcript/context-breakdown caches. An older relay replayed a channel's `open` (and with it, a
  fresh `hello`) on every bridge attach or takeover, so a browser that never itself reconnected
  could receive one; the guard stays for a relay that still does.
- **Session list sorting** — a per-browser choice of sidebar session order: Status (default,
  urgency-ranked), Last active, Created, or Manual. Applies to all sidebar sections. Auto-selection
  (`latestSessionIn`) follows the same setting, so a launch lands on the row the sidebar shows first.
  Manual uses a hand-placed order synced per project (see session groups).
- **Session groups** — user-made, per-project sidebar sections (e.g. "For future") that park
  sessions without archiving them. Membership is `SessionMeta.groupId`; the group list, its order
  and mute flag are synced settings (`UserUiSettings.sessionGroups`). Sections run Shared-with-me
  (session-scope guests only), Active (ungrouped), user groups in array order, then Archived. Groups collapse per browser
  (`lines.collapsedGroups`, reserved id `archived` for the Archived section) and are reordered by
  dragging their header or with Move up/down. Sessions move between sections by drag (an empty
  or collapsed group opens a "Drop here" zone while dragging), or on a phone by the row ⋯ menu's
  "Move to group". A muted group (see business rules) silences its sessions for
  notifications, the tab dot and auto-select without stopping them.

## Entry points

- `web/src/components/Composer.tsx`
- `web/src/components/ProjectTabs.tsx` — tab click; the tab row shown in the app header
- `web/src/ws.ts` — `openProject` (server-initiated project switch)
- `web/src/App.tsx` — URL deep-link effect
- Sidebar session row status badge
- OS/browser notification fired for a session that enters `waiting-permission`

## Files

- `web/src/store.ts` — `readDraft`, `writeDraft`, `pruneDrafts`, `readDraftAttachments`,
  `writeDraftAttachments`, `pruneDraftAttachments`; `sessionUpsert`'s intent-based auto-select and
  `focusComposerFor`; the `hello` reducer's signature short-circuit; `setActiveProject`, `latestSessionIn`,
  `rememberedSessionIn`, `readLastSessions`/`writeLastSession`, `readSessionSort`, `sessionsInProject`;
  `seenSessionStatus`, `reconcileSeenStatus`; `actionError`
- `web/src/ws.ts` — `send()` returning `boolean` and setting `actionError` on a dropped
  non-prompt message
- `web/src/components/Composer.tsx`
- `web/src/lib/mentions.ts` (`MentionValue` — the persisted text/mentions shape)
- `shared/types.ts` — `SessionMeta.createdAt`, `SessionMeta.pendingPermissionTool`,
  `SessionMeta.groupId`, `SessionGroup`, `UserUiSettings.sessionGroups`/`sessionOrder`,
  `isSessionMuted`, `allSessionGroups`, the `setSessionGroup` message
- `server/src/sessions.ts` — `setSessionGroup` (beside `archiveSession`; leaves `groupId` alone on
  archive, unarchive and prompt reactivation)
- `server/src/pushNotifier.ts` — `isMuted` hook skipping pushes for muted groups
- `web/src/lib/format.ts` — `projectStatusMeta` (takes the group list to skip muted sessions),
  `machineActivity` (same skip),
  `PROJECT_STATUS_ORDER`/`PROJECT_STATUS_RANK`, `waitingPermissionMeta`, `sessionRowMeta` (the
  sidebar row's single presentation entry point; wraps `waitingPermissionMeta` and the plain
  per-status `STATUS_META` table, which lives here instead of in `Sidebar.tsx`); `SessionSort`,
  `SESSION_SORT_ORDER`/`SESSION_SORT_RANK`, `lastActivityAt`, `compareSessions`
- `web/src/components/ProjectTabs.tsx` — `ProjectTab` folder/dot swap and tooltip
- `server/src/sessions.ts` — `askPermission`, `setStatus`, `reconcileWithWorker`, `adoptSynced`
- `web/src/components/Sidebar.tsx` — badge label/color lookup; session groups (sections, phone
  row "Move to group", drag between sections, manual order prompt)
- `web/src/components/SessionGroupSection.tsx` — the shared collapsible section header (used for
  user groups and Archived), its urgent-dot and mute indicator, and the name popover
- `web/src/lib/alerts.ts` — notification body text; `maybeAlert`'s background-tasks early return
  (see [background-tasks](background-tasks.md)) and its muted-group early return
- `web/src/components/Composer.tsx` — Stop-button gating against `session.backgroundTasks`

## Symbols

- `readDraft`, `writeDraft`, `pruneDrafts` (`store.ts`) — text + mention ranges, `localStorage`
- `readDraftAttachments`, `writeDraftAttachments`, `pruneDraftAttachments` (`store.ts`) — staged
  files, IndexedDB
- `Composer` — draft-seeded state, mirror-to-storage effects for both; `textareaRef`, focus
  effect keyed on `focusComposerFor`
- `setActiveProject(path)` — single entry point for changing the active project; all three entry
  points above call it
- `latestSessionIn(sessions, projectKeys, project, groups, order)` — top non-archived, unmuted
  session in a project under the user's sidebar sort (`compareSessions(readSessionSort(), order)`),
  or `undefined`
- `readSessionSort()` — reads the sidebar's persisted sort from `SESSION_SORT_KEY` (`lib/format.ts`,
  shared with `Sidebar.tsx`), validated, defaulting to `status`
- `rememberedSessionIn(sessions, projectKeys, project, groups)` — the project's entry in
  `readLastSessions()`, resolved against current membership; `undefined` if the id is missing,
  archived, muted, or no longer in the project
- `readLastSessions()` / `writeLastSession(projectPath, sessionId)` — `lines.lastSessionByProject`,
  one JSON map (`{ [projectPath]: sessionId }`) in `localStorage`, following the same
  single-key-map convention as `lines.drafts`/`lines.openFiles`; written by a store subscription
  keyed on `selectedSessionId`, not at each selection call site
- `sessionsInProject(sessions, projectKeys, project)` — shared, key-aware project membership
  (by project key, falling back to exact cwd match); shared with the sidebar
- `projectStatusMeta(sessions, seen, now, groups?)` — scans a project's sessions, skips archived
  and muted ones,
  and returns the highest-priority remaining `{ color, label, pulse }`, or `null` if nothing
  qualifies. Actionable states are skipped when `seen`; live work always qualifies; recent
  finishes qualify only when unseen and recent
- `tracksSeen(meta)` — whether a session state is acknowledged by opening its project: actionable
  states and recent finishes, not live work. The store's seen reconcile uses it, so the rule has
  one source
- `PROJECT_STATUS_ORDER` / `PROJECT_LIVE_ORDER` / `PROJECT_RECENT_ORDER` / `RECENT_FINISH_MS` —
  the tab-dot tiers: actionable urgency, then live work, then recent finishes, with the 24h window
  built from the same `waitingPermissionMeta`/`STATUS_META` entries `sessionRowMeta` uses, so a tab
  dot can never drift from the sidebar dot it points at
- `seenSessionStatus` (store field) — session id to the `sessionRowMeta` label the user has
  already acknowledged for that session; persisted under `lines.seenSessionStatus`
- `reconcileSeenStatus` — recomputes `seenSessionStatus` whenever sessions, project keys, or the
  active project change
- `SessionMeta.pendingPermissionTool` — name of the tool that triggered the current
  `waiting-permission` pause (e.g. `ExitPlanMode`, `AskUserQuestion`); undefined for any other
  status
- `waitingPermissionMeta(tool)` — maps a pending tool name to `{ label, color }`
- `SessionSort` — `'status' | 'activity' | 'created' | 'manual'`; the sidebar's persisted sort choice
- `lastActivityAt(session)` — `session.updatedAt ?? session.createdAt`; the closest thing to a
  last-activity clock, since there is no dedicated last-turn field
- `compareSessions(mode, order?)` — comparator for a sidebar session list. `manual` follows the
  project's hand-placed id order, with unplaced sessions first, newest first; `status` ranks by
  `SESSION_SORT_RANK` (urgency), tie-broken by `lastActivityAt` descending; `activity` sorts by
  `lastActivityAt` descending; `created` sorts by `createdAt` descending (today's pre-existing
  order)
- `SESSION_SORT_ORDER`/`SESSION_SORT_RANK` — the `status`-mode urgency table: running, then
  `PROJECT_STATUS_ORDER` (the same table the tab dot uses), then background work, step finished,
  done, archived, idle
- `sessionRowMeta(session)` — maps a full session to `{ color, label, actionable }` for the
  sidebar row: an archived session short-circuits first to a non-actionable green "completed"
  (`ARCHIVED_META`), whatever its stored status; then `waitingPermissionMeta`, then the [turn-recovery](turn-recovery.md) yellow
  interrupted state, then a settled session's own live
  [background-tasks](background-tasks.md#business-rules) row (`actionable: false`), then the plain
  status table. Sits alongside a separate sibling predicate,
  `isWorkflowFinished` (also in `format.ts`), which is not part of this return shape — see
  [workflow-step-lifecycle](workflow-step-lifecycle.md). The sidebar row's icon has a fourth
  branch (finished-workflow filled checkmark) beyond what `sessionRowMeta` alone drives; archived
  rows render the same completed check icon as manually completed ones
- `helloSignature(sessions, projects)` — a cheap string (each session's `id:updatedAt`, joined,
  plus project paths); the `hello` reducer compares it against the last one it stored and, on a
  match, skips replacing `sessions`/`transcriptLoaded`/`contextBreakdowns`
- `SessionGroup` (`shared/types.ts`) — `{ id, name, muted? }`; array order is display order
- `UserUiSettings.sessionGroups` — `Record<projectKey, SessionGroup[]>`; `sessionOrder` —
  `Record<projectKey, sessionId[]>` for the manual sort. Both ride the settings sync path
- `SessionMeta.groupId` — the group a session is parked in; a dangling id reads as ungrouped
- `isSessionMuted(meta, groups)` / `allSessionGroups(settings)` (`shared/types.ts`) — muted check
  and the flattened group list used to resolve a `groupId` without a project lookup
- `setSessionGroup` — client message, `manageSessions` cap; `SessionManager.setSessionGroup`
- `groupKeyOf(projectKeys, path)` (`store.ts`) — project key, falling back to path
- `groupsFor`, `createGroup`, `renameGroup`, `deleteGroup`, `moveGroup`, `toggleGroupMuted`,
  `setSessionOrder` (store actions) — each edits the settings slice and calls `pushSettings`
- `SessionGroupSection` — collapsible header with chevron, name, count, muted icon, most urgent
  actionable dot while collapsed (unless muted), and a ⋯ menu; used for user groups and Archived
- `GroupNamePopover` — inline name field for create/rename
- `lines.collapsedGroups` — localStorage `{ [groupKey]: collapsedIds[] }`, browser-only; replaces
  the old global `lines.showArchived`, which is migrated once and removed
- `withSeen(seen, ids)` — returns `seen` unchanged when every id is already present, so a no-op
  merge doesn't trigger a re-render
- `pendingCreate` (store field) — true from `markSessionCreatePending()` until the matching
  `sessionUpsert` arrives or `CREATE_INTENT_TTL_MS` (15s) elapses
- `focusComposerFor` (store field) — set to a session id in the same `sessionUpsert` claim branch
  that grants `pendingCreate` the selection; `Composer` focuses its textarea when this matches
  `session.id` and then calls `takeComposerFocus()` to clear it. Reuses the create-intent signal
  instead of a `createdAt`-age check, so it isn't fooled by clock skew between the bridge and the
  browser (see session-create auto-select) and can't re-fire on a later switch back to the session
- `takeComposerFocus()` — clears `focusComposerFor`; called once by the composer that consumes it
- `seenSessionIds` (store field) — every session id this browser has ever been told about, via
  either `hello` or `sessionUpsert`; maintained so a session can never look "new" a second time
- `markSessionCreatePending()` — called by every `createSession` sender (the sidebar's New
  session button and its workflow-picker menu); sets `pendingCreate`
- `actionError` / `setActionError(message)` — a control message the socket couldn't carry; set by
  `ws.ts`'s `send()` on the dropped-non-prompt path (not for `BACKGROUND_TYPES`, which drop
  with a console warning only), rendered (and dismissed on click) by the
  sidebar

## Data flow

### Composer drafts

`Composer` seeds its prompt state from `readDraft(session.id)` via a lazy `useState` initializer
— `SessionView` keys `Composer` by session id (`App.tsx` keys `SessionView` itself the same way),
so switching sessions remounts the component and the initializer runs fresh per session. An
effect writes the full draft back to `localStorage` (key `lines.drafts`, a
`Record<sessionId, MentionValue>`) on every change.

Staged attachments follow the same remount-per-session shape but load asynchronously: a
mount-only effect calls `readDraftAttachments(session.id)` against IndexedDB (database
`lines-drafts`, object store `attachments`, keyed by session id) and seeds `attachments` state
once it resolves; an `attachmentsLoaded` ref gates the mirror-to-storage effect so it can't fire
with an empty array and wipe the stored draft before that load completes.
`readDraftAttachments`'s callback only applies the loaded value if state is still empty, so a
file staged in the brief window before load resolves is never clobbered.

Sending a message resets both the prompt and attachments state, which clears both drafts on the
next mirror-effect run. On each `hello` from the server, `pruneDrafts` and
`pruneDraftAttachments` remove drafts for sessions that no longer exist.

### Focus on a new session

Focus now shares its mechanism with session *selection* (below) instead of running its own clock
check. The `sessionUpsert` reducer's claim branch — the same branch that decides `pendingCreate`
gets the selection — also sets `focusComposerFor` to that session's id. `Composer` runs an effect
keyed on `focusComposerFor === session.id`: it calls `.focus()` on the textarea ref, then
`takeComposerFocus()` clears the field so it can't re-fire on a later switch back to the same
session. This replaces the old `Date.now() - session.createdAt < 5000` heuristic, which read
`createdAt` off the *bridge* machine's clock and could silently never fire when that clock ran
ahead of the browser's — see session-create auto-select for the same failure mode.

On a phone, closing the sidebar drawer on create (see [mobile-client](mobile-client.md)) leaves a
gap between the tap and this effect running (a `sessionUpsert` round-trip), during which iOS would
otherwise drop the keyboard it needs a synchronous in-gesture `focus()` to keep open — the sidebar
covers that half with a keyboard-primer input; see mobile-client's business rules.

### Session-create auto-select

`store.ts`'s `sessionUpsert` handler used to auto-select any upsert that was both new to the
current session map and had a `createdAt` under 5 seconds old — comparing the browser's own clock
against a timestamp stamped on whichever machine the bridge runs on. Locally those are the same
clock. Hosted, they're two different computers, and a bridge clock running even slightly ahead
made the comparison true forever, so *any* upsert for an id not currently in the map — including a
session resurrected by a duplicate/stale `hello` — stole the selection out from under whatever the
user was looking at.

The fix is explicit intent instead of a clock: `Sidebar.tsx`'s `createSession` calls
`markSessionCreatePending()` right before sending `createSession`, which sets `pendingCreate` (and
arms a 15-second expiry in case the create never lands). `sessionUpsert` claims the selection only
when `pendingCreate && !seenSessionIds.has(id)` — both the browser asked for a session recently
*and* this is genuinely the first time it's seen this id. `seenSessionIds` is maintained by both
`hello` and `sessionUpsert`, so a session that leaves and re-enters the map (deleted then
resurrected, or replayed by a duplicate snapshot) is never treated as new again.

### A repeated `hello` is inert

The `hello` reducer computes `helloSignature(msg.sessions, msg.projects)` and compares it against
the signature it stored on the previous `hello`. On a match, every other field (usage, auth,
worker/storage health, projects, etc.) still applies exactly as before, but `sessions`,
`transcriptLoaded` and `contextBreakdowns` are left untouched.

This matters because a `hello` is not always proof of a fresh reconnect. The relay used to replay a
channel's `open` — and the bridge answered each one with a full `hello` — every time a bridge
attached (it now closes the channel instead), including a takeover by a second bridge process that superseded the first (see
[hosted-machine-access](hosted-machine-access.md)). A browser that never itself reconnected could
receive two different `hello` snapshots (one from each bridge process) in quick succession;
applying each one wholesale replaced `sessions` and blanked the transcript/breakdown caches, which
reloaded the open session's transcript and, combined with the old clock-based auto-select above,
produced a session that visibly alternated between "new" and "previous" — the flicker loop this
fix (together with the relay/bridge changes) breaks.

### Project switch

`setActiveProject` first checks whether the currently selected session already belongs to the
target project (via `sessionsInProject`, so a keyed project matches across machines with
different absolute paths). If so, the selection is left alone — including an archived session, so
a deep link to it survives a tab switch. Otherwise it tries `rememberedSessionIn` — the project's
last-selected session, if it still exists in the project and isn't archived — and only when that
comes back empty falls through to `latestSessionIn`, which itself falls back to `null` (empty
state) when the project has no non-archived sessions.

On a cold launch the active project is restored from localStorage but the URL names no session,
and the server's `projects` message only arrives on change. So the `hello` reducer, after
clearing a dangling selection, calls `setActiveProject` again when the primary machine's `hello`
leaves nothing selected — unless a create is pending, whose claim must own the selection. A
second machine's `hello` never triggers it.

A separate store subscription records `selectedSessionId` into `lines.lastSessionByProject`
whenever it changes to a session that belongs to the active project — the same "one subscription,
not scattered mutation sites" shape `reconcileSeenStatus` already follows. A stale entry (the
remembered session got deleted or archived elsewhere) is not swept on write; `rememberedSessionIn`
already treats it as absent on read, and the next selection in that project overwrites it anyway.

### Project tab dot

`ProjectTab` reads `sessions`, `projectKeys`, and `seenSessionStatus` from the store and, for
every non-active tab, calls `projectStatusMeta(sessionsInProject(...), seenSessionStatus, now)` in
its render body to decide folder icon vs. status dot. Only the actionable tier pulses. A
`useStore.subscribe` listener recomputes `seenSessionStatus` on any relevant state change via
`reconcileSeenStatus`: every tracked session (see `tracksSeen`) belonging to the currently active
project is marked seen; any other session's entry is dropped the instant it leaves a tracked
state, so a later relapse or a later finish reads as new again. The map is written to localStorage
on change and read on startup. Entries for sessions not yet loaded are kept, since the session
list is empty until the first `hello`.

The recent-finish tier has no timer: a finish aging past 24h clears on the next store-driven
render.

### Waiting-permission badge

`askPermission` stamps `SessionMeta.pendingPermissionTool` with the triggering tool name before
calling `setStatus(id, 'waiting-permission')` → persisted/broadcast via the existing
`sessionUpsert` path → `Sidebar` and `alerts.ts` both call `waitingPermissionMeta` to derive the
label/color or notification body from it.

### Offline prompt queue

`send()` in `ws.ts` puts a `prompt` message into the browser-local `queuedPrompts` store (via
`enqueuePrompt`) when the link is down or mid-handshake; `flushQueue()` drains and re-sends it
after `hello`. Held in memory only — lost on reload. `OfflineQueuedMessages` (in
`QueuedMessages.tsx`, mounted by `SessionView` right after the server queue strip) shows the
current session's unsent prompts as dashed rows under a `Not sent · N` header with a yellow
warning ("You're offline" when `connectionStatus` is `offline`, otherwise "Waiting for
connection"). Each row has an X that calls `removeQueuedPrompt`, discarding the prompt before it
is sent; there is no edit or send-now. If `flushQueue()` finds a queued prompt whose session no
longer exists, it sets `actionError` once per flush instead of dropping it silently. The header
`ConnectionBanner` keeps its count, since it also covers sessions not on screen.

### Deleting a session

`Sidebar.tsx`'s `SessionRow` no longer removes its own row optimistically. Clicking delete calls
`send({ type: 'deleteSession', ... })`; while `send()` returns `true` the row shows a loading
spinner on its trash icon and stays put until the server's `sessionDeleted` broadcast actually
removes it (unaffected — see the `applyServerMessage` case). If `send()` returns `false` — the
socket isn't open — `setActionError` records a message, which the sidebar renders (and lets the
user dismiss by clicking it) instead of the delete looking like it silently did nothing.

### Session groups

Groups are settings, not a new store: `setGroups` in the store edits `sessionGroups` (and
`sessionOrder`) and calls `pushSettings`, which goes out as `saveSettings`. The bridge persists it
and fans it out through the existing sync path and the `settings` broadcast; `applySettings` mirrors
it back into the store and a localStorage cache. Membership travels as `SessionMeta.groupId`
through the normal `sessionUpsert` path. A move sends `setSessionGroup`, and the bridge upserts the
session. Drag and drop in the sidebar translates a drop into archive, unarchive, `setSessionGroup`
or a manual-order write, depending on the sections involved. The bridge's Web Push path reads the
same group list from its own settings to skip muted sessions.

## Dependencies

- `@mention` pill data model (`MentionValue` = `{ text, ranges }`) from `web/src/lib/mentions.ts`
  — see [prompt-mentions](prompt-mentions.md).
- Browser IndexedDB, for staged attachments only.
- The existing `.status-dot` CSS (`web/src/index.css`) and Mantine theme colors (`cyan`,
  `violet`, `teal`, `yellow`, `red`); Mantine `Badge` color props.
- [hosted-machine-access](hosted-machine-access.md) — why a `hello` can repeat with no browser
  reconnect, and the socket-generation guard that keeps a stale one's frames from landing at all.

## Tests

Server-side: `server/src/sessions.groups.test.ts` (set/clear and persistence of `groupId`, kept
through archive, unarchive, prompt reactivation and `adoptSynced`), `server/src/statusMeta.test.ts`
(muted skip in `projectStatusMeta`/`machineActivity`, `isSessionMuted` with `isAlertTransition`,
manual comparator), `server/src/pushNotifier.test.ts` (no push for a muted group),
`server/src/sync.sessions.test.ts` (`groupId` round-trip), `server/src/store.test.ts` (group settings
survive save and load).

Web has no test runner. Draft persistence was verified manually via reload; the rest of the web
side (drag, collapse, menus, migration, `sessionRowMeta`, `projectStatusMeta`, the alerts status logic, the selection rules) is
uncovered and verified by hand. This is the least-tested part of this feature and, per the
plan that introduced `pendingCreate`/`seenSessionIds`/the `hello` short-circuit, the highest-risk:
adding a `vitest`/`jsdom` harness with a `store.hello.test.ts` covering "duplicate hello is inert"
and "auto-select needs `pendingCreate`" is the recommended follow-up.

## Business rules

- The persisted text draft is the full `MentionValue`, not plain text — restoring a draft must
  keep its `@mention` pills and expansions intact, not just the raw characters.
- Staged attachments persist across reload too; they live in IndexedDB rather than
  `localStorage` because base64 file/image data routinely runs tens of MB, well past typical
  `localStorage` quotas.
- An empty text draft (`text === ''`) or empty attachment list deletes its storage entry rather
  than storing an empty one.
- Focus is driven by `focusComposerFor`, set only in the `sessionUpsert` claim branch that also
  grants selection (see below) — not a `createdAt` age check; switching to an older existing
  session does not steal focus, since that session's upsert (if any) never claims selection.
- A `sessionUpsert` only takes the selection when `pendingCreate` is true **and** the session id
  is not already in `seenSessionIds` — never merely because the id is new to the *current* map.
  `pendingCreate` expires on its own after 15 seconds if no matching upsert ever arrives, so a
  lost or refused create can't leave a stale intent for an unrelated session to consume.
- `seenSessionIds` is maintained by both `hello` and `sessionUpsert`; a session that leaves and
  re-enters the map — deleted then resurrected, or replayed by a duplicate `hello` — is never
  treated as new again.
- A repeated `hello` (same session/project signature as the last one applied) is inert:
  `sessions`, `transcriptLoaded` and `contextBreakdowns` are left untouched, while every other
  field still applies as normal.
- Deleting a session shows a loading state on its own row and leaves the row in place until the
  `sessionDeleted` echo removes it — no optimistic removal, so a delete that failed to send is
  never mistaken for one that worked.
- A dropped non-prompt control message (delete included) sets `actionError`, rendered by the
  sidebar and dismissed by clicking it — replacing a `console.warn` nobody saw.
  Automatic messages (`BACKGROUND_TYPES`: presence, transcript reload, etc.) are exempt, so a
  reconnect never raises the banner unprompted.
- A server-side refusal (`{type:'error'}`, e.g. a rejected mutation) also sets `actionError`
  instead of only logging to the console — see [git-worktrees](git-worktrees.md), whose worktree
  removal/creation refusals were the case that made the gap visible; the same fix also
  retroactively surfaces `compactContext`/`addGuardAllow` refusals that were silent before.
- Auto-selection (no valid current selection in the target project) always excludes archived
  sessions; `completed` needs no separate check since the server always archives alongside it.
  It also excludes sessions in a muted group, so a launch never lands inside one.
- A project whose sessions are all archived auto-selects nothing (empty state) rather than
  opening an archived one.
- An explicit selection already in the target project — including an archived session opened via
  the sidebar's Archived group or a deep link — is never overridden by a tab switch.
- A project switch prefers the project's remembered last-selected session
  (`lines.lastSessionByProject`) over `latestSessionIn`; `latestSessionIn` — the top non-archived
  session in the user's sidebar sort — remains the fallback when nothing
  is remembered, the remembered session is gone, or it's now archived. Both also run on the primary
  machine's `hello` when nothing is selected.
- The sidebar groups (Sessions, Shared-with-me, Archived), and the project tab's status dot
  via `reconcileSeenStatus`, describe one machine's sessions only —
  `sessionsOnMachine(sessions, sessionMachine, primaryDeviceId ?? '')` — not every machine this
  browser holds a link to. The store still holds all of them (message routing and notifications
  need to); which machine is shown is a display scope changed by the header's
  [`MachineSwitcher`](multi-machine-client.md), not a second group folded into this list.
- Shared-with-me exists only for a session-scope guest, and holds a session only when **no** project
  tab covers it (`sessionsInProject`
  checked against every tab, not just the active one) — not merely "outside the active tab". A
  session in another open project tab stays in that tab's Sessions list and never spills into
  Shared-with-me when you switch away from it.
- The sidebar session list order is user-selectable via `lines.sessionSort` (persisted
  `localStorage`), applied to all three groups (Sessions, Shared-with-me, Archived): **Status**
  (default) — running first, then the tab-dot urgency order (plan ready > needs answer > needs
  permission > interrupted > error), then background work, then step finished (a clean workflow
  park), then done, then idle,
  tie-broken by `lastActivityAt` descending; **Last active** — `lastActivityAt` descending;
  **Created** — `createdAt` descending (the sidebar's pre-existing, and still default-for-archived,
  behavior).
- A session status label missing from `SESSION_SORT_RANK` (a future `SessionStatus`) sorts last
  rather than being guessed at — the same rule `projectStatusMeta` applies by skipping.
- The archived group's sort key changed from `archivedAt ?? createdAt` to the same `compareSessions`
  comparator the other two groups use: Status/Last-active mode still puts the most-recently-archived
  session first (archiving is an upsert, so it bumps `updatedAt`), but Created mode now means
  creation order, not archive order.
- Project tab dot priority, highest first: plan ready (violet) > needs answer (teal) > needs
  permission (yellow) > interrupted (yellow) > error (red) — pulsing, unseen only; then running
  and background work (steady blue, no seen semantics); then done and step finished (steady
  green, unseen only, `lastActivityAt` within the last 24h).
- `idle` never shows a dot. A clean workflow park ("step finished") shows the recent-finish green
  dot like `done`. See [workflow-step-lifecycle](workflow-step-lifecycle.md).
- A finished workflow never surfaces on a project tab: it is not actionable, so it never reaches
  `projectStatusMeta`. Only the sidebar row shows the filled checkmark — see
  [workflow-step-lifecycle](workflow-step-lifecycle.md).
- Archived sessions are excluded from the tab dot, and so are sessions in a muted group.
- A session status not in the priority table is skipped rather than guessed at.
- The active project's tab always shows the plain folder icon (render-time suppression, no extra
  state for this rule alone).
- Opening a project marks every tracked session in it "seen" (actionable states and recent
  finishes); its tab stays quiet after leaving unless a session reaches a tracked status it hasn't
  already been seen in. A session that resolves and later relapses to the same status counts as
  new again.
- Live work never counts as seen: a running or background-work tab stays steady blue until the
  work ends, and then only its finish can light green.
- `seenSessionStatus` is persisted to localStorage, so a page reload keeps acknowledged dots quiet.
- A finished session whose last activity is older than 24h never lights its tab, even if unseen.
- `ExitPlanMode` → label "plan ready", violet badge.
- `AskUserQuestion` → label "needs answer", teal badge.
- Any other tool (or no tool recorded) → label "needs permission", yellow badge (the unchanged
  default).
- Notification body mirrors the sidebar label (capitalized) for `waiting-permission` sessions.
- Session groups are per project, keyed by project key (path when a project has none). A
  `groupId` naming no group of its project reads as ungrouped and falls back into Active, so
  deleting a group does not touch its sessions.
- Archive keeps `groupId`: an archived session shows only under Archived, and unarchiving returns
  it to its group. Prompt reactivation (sending to an archived session) also keeps it.
- Muting a group means: no notifications (chime and Web Push), no project tab dot, no machine
  "needs you" count, and never auto-selected. Sessions still run normally, and background work
  and turn recovery continue. The group's header keeps its muted icon; mute is not archive.
- Only the owner can manage groups or move sessions between them: a guest does not receive
  `settings`, and `setSessionGroup` needs `manageSessions`. Archived and read-only rows offer no
  move.
- Group create, rename, delete, reorder and mute are synced settings edits (last write wins on the
  whole settings blob). Concurrent edits from two browsers can lose one.
- Dragging a session between sections archives, unarchives or regroups it; a same-section drag
  reorders only under the Manual sort. Under an automatic sort it first asks to switch to Manual.
  Archived is never hand-ordered.
- Manual order is one synced list per project covering Active and every group. Sessions not yet
  placed sit on top, newest first.
- Collapse state is per browser and per project. Migration of the old global `lines.showArchived`
  seeds `archived` as collapsed only for the project open at first read, when that old value was
  `false`.
- Archived sessions in the sidebar render 20 at a time behind a "Show N more" button instead
  of the full archived list, since the Archived section starts expanded and a long-lived
  project can accumulate hundreds of them.
- A settled session that still owns a live background task (see
  [background-tasks](background-tasks.md)) shows a non-actionable "background work" sidebar row,
  ranked below `waiting-permission` and the interrupted state — both of those need the user,
  background work does not — and the composer's Stop button stays enabled for it (sending
  `stopBackgroundTasks` instead of `interrupt`) even though the session reads as settled.

## Architectural rules

- Text draft storage follows the existing single-JSON-map-under-one-key convention used elsewhere
  in `store.ts` (e.g. `lines.openFiles`), rather than one `localStorage` key per session.
  `lines.lastSessionByProject` follows the same convention, keyed by project path instead of
  session id.
- Attachment draft storage uses IndexedDB instead of `localStorage` for the same reason
  attachments themselves are staged as raw base64 client-side — size, not structure, is the
  deciding factor.
- Focus reuses the same `sessionUpsert` claim branch that decides selection (`focusComposerFor`
  set alongside `selectedSessionId`) instead of a second, independent "is this session new" flag.
- The project membership check reuses `sessionsInProject` rather than an inline `cwd` comparison,
  so it stays key-aware like every other project-scoped scan (`reconcileSeenStatus`,
  `projectStatusMeta`, the sidebar list).
- `format.ts` never imports `store.ts`; `projectStatusMeta` takes plain `SessionMeta[]` and a
  seen map so the existing one-way dependency (`store.ts` importing `lib/alerts`, `lib/format`)
  is preserved. `compareSessions` follows the same rule: it takes plain `SessionMeta` and returns
  a comparator, so `Sidebar.tsx` is the only place `.sort()` is actually called.
- `SESSION_SORT_ORDER` is built from `STATUS_META.running`, `PROJECT_STATUS_ORDER`,
  `BACKGROUND_WORK_META`, `STATUS_META['waiting-approval']`, `STATUS_META.done`, `ARCHIVED_META`, `STATUS_META.idle` rather than a second, hand-written urgency
  table — the sidebar list order can never drift from the tab dot it points at.
- Archived rows read as completed client-side only: the server keeps the session's last `status`
  and `pendingPermissionTool`, so unarchiving restores the real state. `ARCHIVED_META` is not in
  `PROJECT_STATUS_ORDER` because it is not actionable.
- `seenSessionStatus` is maintained in one place (a single store subscription), not scattered
  across every mutation site that could change what counts as seen.
- `completed` needs no separate guard in `projectStatusMeta`: the server always sets `completed`
  and `archived` together, so excluding `archived` already excludes it.
- `pendingPermissionTool` rides the existing `sessionUpsert` broadcast — no new message type. It
  is cleared centrally in `setStatus` whenever the status leaves `waiting-permission`, plus on the
  worker-reconcile and sync-adopt paths that can force a `waiting-permission` session back to
  `idle` out from under a live turn, so a stale tool name can never linger into an unrelated
  future pause. Concurrent permission asks on the same session: the last `askPermission` call
  wins the label/color, consistent with pre-existing status-overwrite behavior — no new race was
  introduced.
- `helloSignature` is a cheap string (each session's `id:updatedAt` joined, plus project paths)
  rather than a hash of the whole `hello` payload, precisely so volatile fields (usage, auth,
  worker/storage health) stay outside it and keep applying on every `hello` regardless of the
  short-circuit.
- `send()` (`ws.ts`) returns `boolean` instead of `void`, so a caller can tell "sent" apart from
  "dropped" without re-deriving socket state itself.
- `SessionRow` is memoized — selecting a different session, or any `sessions` map update (e.g.
  a live turn ticking status), otherwise re-rendered every row in the list regardless of the
  size of the session being switched to. The memo relies on `session` keeping its object
  identity when unchanged, which `sessionUpsert` already guarantees by only replacing the entry
  that changed. See [transcript-performance](transcript-performance.md) for the other half of
  "switching sessions feels slow."
- Session groups reuse the settings sync path (`sessionGroups`, `sessionOrder`) and keep membership
  on `SessionMeta.groupId`, so no store, route or migration was added. Group ids are UUIDs, so a
  muted lookup can flatten every project's groups without resolving the session's project key.

## Related decisions

- [turn-recovery](turn-recovery.md) — the yellow interrupted state `sessionRowMeta` folds in.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — `isWorkflowFinished` and the sidebar
  icon's fourth branch.
- [prompt-mentions](prompt-mentions.md) — the `MentionValue` the text draft persists.
- [hosted-machine-access](hosted-machine-access.md) — why a `hello` can repeat with no browser
  reconnect (relay `open` replay on a bridge attach/takeover, in relays before owner channels
  were closed on attach).
- [transcript-performance](transcript-performance.md) — the sidebar re-render cost measured
  alongside the transcript's own session-switch cost.
- [cloud-sync-sessions](cloud-sync-sessions.md) — what actually makes a delete stick once the
  `deleteSession` message here reaches the bridge.
- [git-worktrees](git-worktrees.md) — the `worktreePending` flag and `pendingCreate` re-arm added
  for a work-tree session's slower create; the `actionError` fix above.
- [multi-machine-client](multi-machine-client.md) — `shouldClaimSelection` reuses
  `pendingCreate`/`seenSessionIds` unchanged, adding only a primary-machine check; the sidebar row
  gains a host avatar/accent for a session on another machine.
- [session-collaboration](session-collaboration.md) — `SessionMeta.turnActor`, the sidebar's
  "someone else is running this turn" chip.
- [background-tasks](background-tasks.md) — the sidebar's "background work" row, the composer's
  Stop-button gating, and why it's ranked below `waiting-permission`/interrupted but above the
  plain status table.
