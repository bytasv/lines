# Session and project UI

Covers: `composer-draft-persistence`, `composer-focus-new-session`,
`project-switch-session-selection`, `project-tab-status-dot`, `session-status-badge`,
`session-create-auto-select`, `hello-duplicate-inertness`.

## Purpose

The shell around a session: the composer's unsent state, which session a project switch opens,
and how status is surfaced in the sidebar row and the project tab.

- **Composer draft persistence** — persist the in-progress (unsent) prompt (text, `@mention`
  pills, and staged attachments) per session, so a page reload or a bridge/server restart never
  loses what the user was composing.
- **Composer focus on a new session** — when a brand-new session is created, focus the prompt
  textarea automatically so the user can type immediately without clicking into it.
- **Project switch session selection** — decide which session is shown when the active project
  changes (tab click, `hello`/reconnect, or a `/session/<id>` deep link): keep an already-valid
  selection, or auto-select that project's most recently created *non-archived* session. Never
  auto-open an archived session — those stay reachable only via the sidebar's "Archived (N)"
  group.
- **Project tab status dot** — each project tab in the header shows the single most important
  actionable status across that project's sessions as a colored pulsing dot in place of the
  folder icon, so a background project working across multiple repos can signal it needs
  attention without opening it. The open (active) project's tab always shows the plain folder
  icon — its sessions are already listed in the sidebar.
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
  transcript/context-breakdown caches. The relay replays a channel's `open` (and with it, a fresh
  `hello`) on every bridge attach or takeover, so a browser that never itself reconnected can still
  receive one.

## Entry points

- `web/src/components/Composer.tsx`
- `web/src/components/ProjectTabs.tsx` — tab click; the tab row shown in the app header
- `web/src/ws.ts` — `openProject` (server-initiated project switch)
- `web/src/App.tsx` — URL deep-link effect
- Sidebar session row status badge
- OS/browser notification fired for a session that enters `waiting-permission`

## Files

- `web/src/store.ts` — `readDraft`, `writeDraft`, `pruneDrafts`, `readDraftAttachments`,
  `writeDraftAttachments`, `pruneDraftAttachments`; `sessionUpsert`'s intent-based auto-select;
  the `hello` reducer's signature short-circuit; `setActiveProject`, `latestSessionIn`,
  `sessionsInProject`; `seenSessionStatus`, `reconcileSeenStatus`; `actionError`
- `web/src/ws.ts` — `send()` returning `boolean` and setting `actionError` on a dropped
  non-prompt message
- `web/src/components/Composer.tsx`
- `web/src/lib/mentions.ts` (`MentionValue` — the persisted text/mentions shape)
- `shared/types.ts` — `SessionMeta.createdAt`, `SessionMeta.pendingPermissionTool`
- `web/src/lib/format.ts` — `projectStatusMeta`,
  `PROJECT_STATUS_ORDER`/`PROJECT_STATUS_RANK`, `waitingPermissionMeta`, `sessionRowMeta` (the
  sidebar row's single presentation entry point; wraps `waitingPermissionMeta` and the plain
  per-status `STATUS_META` table, which lives here instead of in `Sidebar.tsx`)
- `web/src/components/ProjectTabs.tsx` — `ProjectTab` folder/dot swap and tooltip
- `server/src/sessions.ts` — `askPermission`, `setStatus`, `reconcileWithWorker`, `adoptSynced`
- `web/src/components/Sidebar.tsx` — badge label/color lookup
- `web/src/lib/alerts.ts` — notification body text

## Symbols

- `readDraft`, `writeDraft`, `pruneDrafts` (`store.ts`) — text + mention ranges, `localStorage`
- `readDraftAttachments`, `writeDraftAttachments`, `pruneDraftAttachments` (`store.ts`) — staged
  files, IndexedDB
- `Composer` — draft-seeded state, mirror-to-storage effects for both; `textareaRef`, focus
  effect
- `setActiveProject(path)` — single entry point for changing the active project; all three entry
  points above call it
- `latestSessionIn(sessions, projectKeys, project)` — most recently created (`createdAt`)
  non-archived session in a project, or `undefined`
- `sessionsInProject(sessions, projectKeys, project)` — shared, key-aware project membership
  (by project key, falling back to exact cwd match); shared with the sidebar
- `projectStatusMeta(sessions, seen)` — scans a project's sessions, skips archived and
  non-actionable ones and any `(sessionId, label)` pair already in `seen`, and returns the
  highest-priority remaining `{ color, label }`, or `null` if nothing qualifies
- `PROJECT_STATUS_ORDER` / `PROJECT_STATUS_RANK` — cross-status priority table built from the
  same `waitingPermissionMeta`/`STATUS_META` entries `sessionRowMeta` uses, so a tab dot can
  never drift from the sidebar dot it points at
- `seenSessionStatus` (store field) — session id to the `sessionRowMeta` label the user has
  already acknowledged for that session
- `reconcileSeenStatus` — recomputes `seenSessionStatus` whenever sessions, project keys, or the
  active project change
- `SessionMeta.pendingPermissionTool` — name of the tool that triggered the current
  `waiting-permission` pause (e.g. `ExitPlanMode`, `AskUserQuestion`); undefined for any other
  status
- `waitingPermissionMeta(tool)` — maps a pending tool name to `{ label, color }`
- `sessionRowMeta(session)` — maps a full session to `{ color, label, actionable }` for the
  sidebar row: `waitingPermissionMeta` first, then the [turn-recovery](turn-recovery.md) yellow
  interrupted state, then the plain status table. Sits alongside a separate sibling predicate,
  `isWorkflowFinished` (also in `format.ts`), which is not part of this return shape — see
  [workflow-step-lifecycle](workflow-step-lifecycle.md). The sidebar row's icon has a fourth
  branch (finished-workflow filled checkmark) beyond what `sessionRowMeta` alone drives
- `helloSignature(sessions, projects)` — a cheap string (each session's `id:updatedAt`, joined,
  plus project paths); the `hello` reducer compares it against the last one it stored and, on a
  match, skips replacing `sessions`/`transcriptLoaded`/`contextBreakdowns`
- `withSeen(seen, ids)` — returns `seen` unchanged when every id is already present, so a no-op
  merge doesn't trigger a re-render
- `pendingCreate` (store field) — true from `markSessionCreatePending()` until the matching
  `sessionUpsert` arrives or `CREATE_INTENT_TTL_MS` (15s) elapses
- `seenSessionIds` (store field) — every session id this browser has ever been told about, via
  either `hello` or `sessionUpsert`; maintained so a session can never look "new" a second time
- `markSessionCreatePending()` — called by every `createSession` sender (the sidebar's New
  session button and its workflow-picker menu); sets `pendingCreate`
- `actionError` / `setActionError(message)` — a control message the socket couldn't carry; set by
  `ws.ts`'s `send()` on the dropped-non-prompt path, rendered (and dismissed on click) by the
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

`Composer` re-runs a focus effect keyed on `session.id` and calls `.focus()` on the textarea ref
when `Date.now() - session.createdAt < 5000` — its own independent heuristic, so it only fires for
genuinely new sessions rather than on every session switch. This no longer shares a mechanism with
session *selection* (below); the two used to lean on the same clock comparison, but selection has
since moved to an intent flag because it has to survive the bridge and the browser being different
machines, while focus's blast radius (which textarea gets focus, on the machine the user is
already looking at) never had that problem.

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

This matters because a `hello` is not always proof of a fresh reconnect. The relay replays a
channel's `open` — and the bridge answers each one with a full `hello` — every time a bridge
attaches, including a takeover by a second bridge process that superseded the first (see
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
a deep link to it survives a tab switch. Otherwise it auto-selects via `latestSessionIn`, which
falls back to `null` (empty state) when the project has no non-archived sessions.

### Project tab dot

`ProjectTab` reads `sessions`, `projectKeys`, and `seenSessionStatus` from the store and, for
every non-active tab, calls `projectStatusMeta(sessionsInProject(...), seenSessionStatus)` in its
render body to decide folder icon vs. status dot. A `useStore.subscribe` listener recomputes
`seenSessionStatus` on any relevant state change via `reconcileSeenStatus`: every actionable
session belonging to the currently active project is marked seen; any other session's entry is
dropped the instant it stops being actionable, so a later relapse to the same status reads as new
again.

### Waiting-permission badge

`askPermission` stamps `SessionMeta.pendingPermissionTool` with the triggering tool name before
calling `setStatus(id, 'waiting-permission')` → persisted/broadcast via the existing
`sessionUpsert` path → `Sidebar` and `alerts.ts` both call `waitingPermissionMeta` to derive the
label/color or notification body from it.

### Deleting a session

`Sidebar.tsx`'s `SessionRow` no longer removes its own row optimistically. Clicking delete calls
`send({ type: 'deleteSession', ... })`; while `send()` returns `true` the row shows a loading
spinner on its trash icon and stays put until the server's `sessionDeleted` broadcast actually
removes it (unaffected — see the `applyServerMessage` case). If `send()` returns `false` — the
socket isn't open — `setActionError` records a message, which the sidebar renders (and lets the
user dismiss by clicking it) instead of the delete looking like it silently did nothing.

## Dependencies

- `@mention` pill data model (`MentionValue` = `{ text, ranges }`) from `web/src/lib/mentions.ts`
  — see [prompt-mentions](prompt-mentions.md).
- Browser IndexedDB, for staged attachments only.
- The existing `.status-dot` CSS (`web/src/index.css`) and Mantine theme colors (`sandstone`,
  `violet`, `teal`, `yellow`, `red`); Mantine `Badge` color props.
- [hosted-machine-access](hosted-machine-access.md) — why a `hello` can repeat with no browser
  reconnect, and the socket-generation guard that keeps a stale one's frames from landing at all.

## Tests

None — `web/` has no test runner. Draft persistence was verified manually via reload; the rest
(`sessionRowMeta`, `projectStatusMeta`, the alerts status logic, the selection rules) is
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
- Focus fires only when the session is younger than 5 seconds — its own heuristic, no longer
  shared with the store's session-select logic (see below); switching to an older existing
  session does not steal focus.
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
- A server-side refusal (`{type:'error'}`, e.g. a rejected mutation) also sets `actionError`
  instead of only logging to the console — see [git-worktrees](git-worktrees.md), whose worktree
  removal/creation refusals were the case that made the gap visible; the same fix also
  retroactively surfaces `compactContext`/`addGuardAllow` refusals that were silent before.
- Auto-selection (no valid current selection in the target project) always excludes archived
  sessions; `completed` needs no separate check since the server always archives alongside it.
- A project whose sessions are all archived auto-selects nothing (empty state) rather than
  opening an archived one.
- An explicit selection already in the target project — including an archived session opened via
  the sidebar's Archived group or a deep link — is never overridden by a tab switch.
- Sort key for "most recent" is `createdAt`, matching the sidebar list order (`SessionMeta` has
  no separate last-activity field).
- Project tab dot priority, highest first: plan ready (violet) > needs answer (teal) > needs
  approval (sandstone) > needs permission (yellow) > interrupted (yellow) > error (red).
- `running` / `done` / `idle` never show a dot (not actionable) — folder icon.
- A finished workflow never surfaces on a project tab: it is not actionable, so it never reaches
  `projectStatusMeta`. Only the sidebar row shows the filled checkmark — see
  [workflow-step-lifecycle](workflow-step-lifecycle.md).
- Archived sessions are excluded from the tab dot.
- A session status not in the priority table is skipped rather than guessed at.
- The active project's tab always shows the plain folder icon (render-time suppression, no extra
  state for this rule alone).
- Opening a project marks every actionable session in it "seen"; its tab stays quiet after
  leaving unless a session reaches an actionable status it hasn't already been seen in. A session
  that resolves and later relapses to the same status counts as new again.
- `seenSessionStatus` is in-memory only — a page reload clears it, so already-acknowledged dots
  can reappear once after a reload.
- `ExitPlanMode` → label "plan ready", violet badge.
- `AskUserQuestion` → label "needs answer", teal badge.
- Any other tool (or no tool recorded) → label "needs permission", yellow badge (the unchanged
  default).
- Notification body mirrors the sidebar label (capitalized) for `waiting-permission` sessions.

## Architectural rules

- Text draft storage follows the existing single-JSON-map-under-one-key convention used elsewhere
  in `store.ts` (e.g. `lines.openFiles`), rather than one `localStorage` key per session.
- Attachment draft storage uses IndexedDB instead of `localStorage` for the same reason
  attachments themselves are staged as raw base64 client-side — size, not structure, is the
  deciding factor.
- Focus reuses the store's existing `justCreated` 5s threshold instead of introducing a new "is
  this session new" flag or protocol field.
- The project membership check reuses `sessionsInProject` rather than an inline `cwd` comparison,
  so it stays key-aware like every other project-scoped scan (`reconcileSeenStatus`,
  `projectStatusMeta`, the sidebar list).
- `format.ts` never imports `store.ts`; `projectStatusMeta` takes plain `SessionMeta[]` and a
  seen map so the existing one-way dependency (`store.ts` importing `lib/alerts`, `lib/format`)
  is preserved.
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

## Related decisions

- [turn-recovery](turn-recovery.md) — the yellow interrupted state `sessionRowMeta` folds in.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — `isWorkflowFinished` and the sidebar
  icon's fourth branch.
- [prompt-mentions](prompt-mentions.md) — the `MentionValue` the text draft persists.
- [hosted-machine-access](hosted-machine-access.md) — why a `hello` can repeat with no browser
  reconnect (relay `open` replay on a bridge attach/takeover).
- [cloud-sync-sessions](cloud-sync-sessions.md) — what actually makes a delete stick once the
  `deleteSession` message here reaches the bridge.
- [git-worktrees](git-worktrees.md) — the `worktreePending` flag and `pendingCreate` re-arm added
  for a work-tree session's slower create; the `actionError` fix above.
