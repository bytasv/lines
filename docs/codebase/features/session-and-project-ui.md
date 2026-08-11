# Session and project UI

Covers: `composer-draft-persistence`, `composer-focus-new-session`,
`project-switch-session-selection`, `project-tab-status-dot`, `session-status-badge`.

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

## Entry points

- `web/src/components/Composer.tsx`
- `web/src/components/ProjectTabs.tsx` — tab click; the tab row shown in the app header
- `web/src/ws.ts` — `openProject` (server-initiated project switch)
- `web/src/App.tsx` — URL deep-link effect
- Sidebar session row status badge
- OS/browser notification fired for a session that enters `waiting-permission`

## Files

- `web/src/store.ts` — `readDraft`, `writeDraft`, `pruneDrafts`, `readDraftAttachments`,
  `writeDraftAttachments`, `pruneDraftAttachments`; `sessionUpsert` auto-select-on-create;
  `setActiveProject`, `latestSessionIn`, `sessionsInProject`; `seenSessionStatus`,
  `reconcileSeenStatus`
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

`store.ts`'s `sessionUpsert` handler auto-selects a session when it's new and
`Date.now() - session.createdAt < 5000`. `Composer` re-runs a focus effect keyed on `session.id`
and reuses the same 5-second heuristic to decide whether to call `.focus()` on the textarea ref —
so it only fires for genuinely new sessions, not on every session switch.

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

## Dependencies

- `@mention` pill data model (`MentionValue` = `{ text, ranges }`) from `web/src/lib/mentions.ts`
  — see [prompt-mentions](prompt-mentions.md).
- Browser IndexedDB, for staged attachments only.
- The existing `.status-dot` CSS (`web/src/index.css`) and Mantine theme colors (`sandstone`,
  `violet`, `teal`, `yellow`, `red`); Mantine `Badge` color props.

## Tests

None — `web/` has no test runner. Draft persistence was verified manually via reload; the rest
(`sessionRowMeta`, `projectStatusMeta`, the alerts status logic, the selection rules) is
uncovered and verified by hand.

## Business rules

- The persisted text draft is the full `MentionValue`, not plain text — restoring a draft must
  keep its `@mention` pills and expansions intact, not just the raw characters.
- Staged attachments persist across reload too; they live in IndexedDB rather than
  `localStorage` because base64 file/image data routinely runs tens of MB, well past typical
  `localStorage` quotas.
- An empty text draft (`text === ''`) or empty attachment list deletes its storage entry rather
  than storing an empty one.
- Focus fires only when the session is younger than 5 seconds (shared threshold with the store's
  auto-select logic); switching to an older existing session does not steal focus.
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

## Related decisions

- [turn-recovery](turn-recovery.md) — the yellow interrupted state `sessionRowMeta` folds in.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — `isWorkflowFinished` and the sidebar
  icon's fourth branch.
- [prompt-mentions](prompt-mentions.md) — the `MentionValue` the text draft persists.
