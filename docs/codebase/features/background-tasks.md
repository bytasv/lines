# Background tasks

## Purpose

Claude Code can run a subagent or a Bash command as a background task: the foreground turn gets
a "running in the background" tool result and settles with a normal `result` while the task
keeps running inside the same CLI child process. Before this feature Lines dropped every
`task_*`/`background_tasks_changed` SDK event, so a session with a live background task read as
idle in the sidebar, the composer offered Send instead of Stop, nothing in the transcript said a
task existed, and — the actual data-loss bug — `recycleIdleQueries()` would close the query (and
kill the CLI child, and with it the task) of any session that merely looked settled.

This feature tracks background tasks as live, per-session, server-side state; mirrors the set
onto `SessionMeta` so every client sees it; exempts a session that owns one from query recycling;
adds a stop path distinct from the turn-level `interrupt`; and surfaces the set in the transcript,
a composer Stop button, a live strip above the composer, and the sidebar.

A backgrounded call's transcript state lives on the `Task`/`Bash` tool card that launched it
(`ToolBlock.background`), not as a separate row — a separate row duplicated the same fact the card
already showed, and a card given an instant "launched successfully" tool result read as finished
while its subagent was still streaming into it. A standalone row survives only for a genuine orphan
(no matching tool card).

## Entry points

- The SDK's `system/background_tasks_changed` message on a session's live query — level signal,
  REPLACE semantics, emitted whenever membership changes (task start, completion, kill, a
  foreground call being backgrounded)
- The SDK's `system/task_started` and `system/task_notification` messages — edge bookends for the
  transcript state only, never used to derive "is work running" for the live set. Matched onto the
  launching tool card by `tool_use_id` (falling back to a standalone row when no card matches).
- `server/src/sessions.ts` `handleWorkerEvent` (the `system` branch) and `reconcileWithWorker`
- `web/src/components/Composer.tsx` — Stop button, gated on `interruptible || bgTasks > 0`
- `web/src/components/SessionView.tsx` — the live strip above the composer
- `web/src/lib/format.ts` `sessionRowMeta` — the sidebar's "background work" row

## Files

- `shared/types.ts` — `BackgroundTaskInfo`, `SessionMeta.backgroundTasks`, the
  `stopBackgroundTasks` `ClientMessage` variant and its `MESSAGE_AUTHZ` entry
- `server/src/sessions.ts` — `LiveState.backgroundTasks`, `SessionManager.setBackgroundTasks`
  (private), `SessionManager.stopBackgroundTasks` (public), `recycleIdleQueries`'s exemption, the
  `background_tasks_changed`/`init` branch in `handleWorkerEvent`, the clears in `closeQuery`,
  `resetClaudeSession` and `handleWorkerEnded`, the hydration clear in the constructor, and the
  `reconcileWithWorker` hydration from `LiveSessionInfo.backgroundTasks`
- `server/src/workerProtocol.ts` — the `stopTask` `BridgeToWorker` message, `PROTOCOL_VERSION` 5,
  `LiveSessionInfo.backgroundTasks`
- `server/src/worker.ts` — `SessionState.backgroundTasks`, the `pump` tracking of
  `background_tasks_changed`/`init`, the `hello` report, `case 'stopTask'`
- `server/src/workerClient.ts` — `WorkerClient.stopTask`
- `server/src/index.ts` — `case 'stopBackgroundTasks'`
- `web/src/lib/transcript.ts` — `ToolBlock.background`, `TaskItem`, the `openTasks` map (now keyed
  to either a `ToolBlock` or a `TaskItem`), the `task_started`/`task_notification` cases in
  `buildTranscript`'s `system` switch, the `'task'` case in `reconcileItem`, the `background`
  compare in `reuseTool`, the backgrounded-subagent early exit in the `stream_event` case
- `web/src/components/Transcript.tsx` — the `case 'task'` row (orphan fallback only)
- `web/src/components/ToolCallCard.tsx` — the `pending`/badge treatment of `tool.background`
- `web/src/components/TaskCall.tsx` — `TaskHeader` feeding `taskFlags` from `tool.background`
- `web/src/components/SessionView.tsx` — the background-work strip
- `web/src/components/Composer.tsx` — `bgTasks`, the Stop-button gating and its
  `stopBackgroundTasks` send
- `web/src/lib/alerts.ts` `maybeAlert` — the early return while tasks are live
- `web/src/lib/format.ts` `sessionRowMeta` — `BACKGROUND_WORK_META`

## Symbols

- `BackgroundTaskInfo` (`shared/types.ts`) — `{ id, type, description }`, one live task; a
  record, not a bare count, because the SDK payload already names every live task
- `SessionMeta.backgroundTasks?: BackgroundTaskInfo[]` — live-only, never restored from disk (see
  Business rules)
- `SessionManager.setBackgroundTasks(sessionId, list)` (private) — the single writer: replaces
  `LiveState.backgroundTasks` wholesale, and mirrors + `upsert`s onto the meta only when the id
  set actually changed
- `SessionManager.stopBackgroundTasks(sessionId)` (public) — calls `WorkerClient.stopTask` once
  per live id; does not clear the set itself
- `recycleIdleQueries()`'s second exemption — skips closing the query of a settled session whose
  `LiveState.backgroundTasks` is non-empty
- `LiveSessionInfo.backgroundTasks` (`workerProtocol.ts`) — worker→bridge report in `hello`;
  `undefined` means a worker too old to say (demote-only, same convention as `LiveSessionInfo.busy`)
- `BridgeToWorker`'s `stopTask` message — new in protocol v5
- `ToolBlock.background` (`web/src/lib/transcript.ts`) — `{ taskId, status }` matched onto the
  launching tool card by `tool_use_id`; the card owns the running/completed/failed/stopped state
  instead of a separate row. Deliberately drops `task_notification.summary` — it is either the
  verbatim script the Bash card already shows or the Bash `description` itself, never new
  information
- `TaskItem` (`web/src/lib/transcript.ts`) — orphan-only transcript row kind (no `task_started`,
  or no tool card to match): `taskId`, `description`, `subagentType?`, and an
  `outcome?: { status, summary }` filled in by the matching `task_notification`

## Data flow

### Level tracking, top to bottom

The CLI emits `system/background_tasks_changed` with a full list of every task still live after
the change (REPLACE semantics — never a delta). `worker.ts`'s `pump` records the payload on
`SessionState.backgroundTasks` and clears it on `system/init` (the CLI process (re)started, and
nothing is emitted at startup). The worker reports the set in `hello.live[].backgroundTasks` —
same shape as the existing `busy` field.

The bridge tracks its own copy in `LiveState.backgroundTasks`, written in exactly one place,
`SessionManager.setBackgroundTasks`: called from `handleWorkerEvent` on the same
`background_tasks_changed`/`init` messages (the bridge sees the live event stream directly, not
just the worker's summary), and from `reconcileWithWorker` using `hello`'s report — which is what
lets the set survive a **bridge** restart even though `LiveState` itself is bridge-memory-only:
the worker's CLI children (and their tasks) don't restart with the bridge, so the next `hello`
repopulates from there. `setBackgroundTasks` mirrors onto `SessionMeta.backgroundTasks` and
broadcasts only when the id set changed, so a same-membership repeat of the level signal costs no
extra render.

### Recycling

`recycleIdleQueries()` — called on auth login/refresh and on project-root changes — used to close
the query of every session that wasn't mid-turn, which also kills the CLI child and every task it
owns, silently: no notification, no transcript trace. It now skips a session whose `LiveState`
carries a non-empty `backgroundTasks` list, in addition to its existing interruptible-status
skip.

### Stopping

`stopBackgroundTasks` is a second stop path, separate from `interrupt` (which only aborts the
foreground turn): `Composer` sends `{ type: 'stopBackgroundTasks', sessionId }` when the session
isn't `interruptible` but has live tasks; `index.ts` routes it to
`SessionManager.stopBackgroundTasks`, which calls `WorkerClient.stopTask(sessionId, taskId)` for
every id currently in the set. That message reaches `worker.ts`'s `case 'stopTask'`, which calls
the SDK `Query.stopTask(taskId)`. `stopBackgroundTasks` then clears the local set itself,
optimistically — this is the user's manual escape hatch: a task the CLI has already forgotten
makes `stopTask` a no-op, so no level signal ever arrives and without this clear the strip, sidebar
badge and chime suppression would stay on with nothing the user could do about it. At worst this
flickers a still-genuinely-alive entry back in on the next `background_tasks_changed` — a
recoverable flicker, traded for an unrecoverable wedge. See Business rules for the invariant this
now upholds.

### Transcript rendering

`task_started` (skipped entirely when the SDK marks it `skip_transcript: true`, e.g. ambient
housekeeping tasks) first looks up the launching tool card by `tool_use_id` in `toolBlocks` — the
`tool_use` block for a `Task`/`Bash` call always precedes its `task_started`, so the card exists by
the time the task fires. Found, it sets `card.background = { taskId, status: 'running' }` and
registers the card (not a new row) in the `taskId`-keyed `openTasks` map; nothing is pushed. Not
found (compacted-away or rewound transcript), it falls back to opening a standalone `TaskItem` and
pushing it, exactly as before.

The matching `task_notification` resolves whichever `openTasks` holds — falling back to a second
`toolBlocks` lookup by its own `tool_use_id`, since a backgrounded Bash call has been observed
sending a notification with no `task_started` of its own. A `ToolBlock` target gets
`background.status` updated in place; a `TaskItem` target gets its `outcome` set, the same
resolve-in-place idiom the compaction span (`openCompact`) already uses, generalized from a single
slot to a map because tasks can overlap. Neither matching — the standalone-row fallback, unchanged.

`reuseTool` (structural-sharing reconcile) compares `background.status`/`background.taskId`
alongside `result`/`isError`/`snapshot`: a `task_notification` flipping the status changes none of
the other fields, so without this compare the card would never re-render past `running` on a live
session, while reading correctly after a reload — a bug invisible to any check that starts by
reloading.

`task_progress`/`task_updated` are still ignored by `buildTranscript` — too chatty for the inline
transcript — and, separately, are no longer written to disk at all (see
[transcript-rendering](transcript-rendering.md)'s `EPHEMERAL_SYSTEM_SUBTYPES`).

A background subagent's own `stream_event` deltas no longer drive the shared live-activity row
(`ActivityRow`): `buildTranscript`'s `stream_event` case exits early when the event's
`parent_tool_use_id` names a tool block with `background` set. Before this, a session running two
concurrent background Explore agents had its activity row flip between "Explore: …" for each of
them every few hundred ms, contradicting the (correctly labeled) background card and strip. A
background agent's progress is now visible only in its own card and the strip.

### UI surfaces

`Composer`'s Stop button renders when `interruptible || bgTasks > 0`; when not interruptible it
sends `stopBackgroundTasks` instead of `interrupt` and its tooltip reads "Stop background work".
Send stays enabled and unblocked either way — the CLI runs a new turn concurrently with a
background task. `SessionView` renders a strip above the composer whenever
`session.backgroundTasks?.length` — the live truth, since a page reload rebuilds it from the meta
rather than from transcript rows. `sessionRowMeta` (`format.ts`) adds a "background work" row
below the `waiting-permission` and interrupted checks (both outrank it — they need the user;
background work does not) and marks it `actionable: false`, so it never lights up a project tab.
`maybeAlert` (`alerts.ts`) returns early while `next.backgroundTasks?.length` is non-zero, so the
finish chime doesn't fire mid-background-work; the notification turn's own eventual `result`
settles normally once the set is empty and chimes as usual.

The orphan `TaskItem` row (the only case that still renders standalone) is capped to one line
(`lineClamp={1}`): `task_notification.summary` for a backgrounded Bash task has been observed as
the entire multi-line shell script, and this row's dimmed-centered register is a one-liner, not a
transcript card.

## Dependencies

- SDK `Query.stopTask(taskId)` and the `background_tasks_changed`/`task_started`/
  `task_notification`/`task_progress`/`task_updated` message types (`@anthropic-ai/claude-agent-sdk`,
  verified against the installed `sdk.d.ts` at implementation time)
- [turn-recovery](turn-recovery.md) — `LiveState`, `recycleIdleQueries`, the worker/bridge
  asymmetry (`hello` surviving a bridge restart) this feature's hydration path reuses
- [transcript-rendering](transcript-rendering.md) — the resolve-in-place idiom
  (`openCompact`/`openTasks`) and the `system`-subtype switch this extends

## Tests

- `server/src/sessions.backgroundTasks.test.ts` — `background_tasks_changed` replaces the set
  wholesale (including shrinking and emptying it); the record carries `type`/`description`, not
  just the id; `system/init`, `handleWorkerEnded`, `resetClaudeSession` and `closeQuery` each
  clear the set; the meta is broadcast on a membership change and only on one;
  `recycleIdleQueries()` skips a settled session with a live task and still closes one without; a
  `result` arriving with live tasks still settles the turn to `done`; a persisted
  `backgroundTasks` value never survives load from disk; `reconcileWithWorker` repopulates the set
  from `hello`, and leaves it alone when the worker reports `undefined`. Also now: `task_notification`
  removes its own id and leaves the others (one extra broadcast); a `task_notification` for an
  unknown id is a strict no-op (set and broadcast count both unchanged — the monotone-toward-empty
  invariant asserted directly); the last `task_notification` empties the set; `stopBackgroundTasks`
  stops each live task **and clears the set**, with a follow-on `background_tasks_changed` proving
  a still-live task comes back; an ephemeral system subtype (`task_progress`, `task_updated`,
  `thinking_tokens`, `status`, `hook_started`, `hook_response`) is broadcast but never reaches
  `store.loadTranscript`; a `status` carrying `compact_result` is still persisted;
  `task_started`/`task_notification` are still persisted (guards against a future over-eager
  addition to the drop set)
- No web test infrastructure — the transcript card state, the composer Stop gating, the live strip
  and the sidebar row are manual-verification only (`verify` skill), same as the rest of the
  transcript/composer/sidebar surface. Verifying the card dedup and the live `running` badge
  specifically requires watching a live task settle — reading correctly after a page reload does
  not prove the `reuseTool` compare is wired up.

## Business rules

- The set is live-only: never restored from a persisted `SessionMeta.backgroundTasks` on load — a
  background task belongs to a specific CLI process, and a value surviving a bridge/process
  restart in `sessions.json` describes a process nothing here has a handle on any more. The
  worker's `hello` (via `reconcileWithWorker`) or the next `background_tasks_changed` repopulate
  it for whichever tasks are genuinely still running.
- **Strengthened invariant** (renegotiates the previous rule below): `background_tasks_changed` is
  the only thing that may put an id **into** the live set. Everything else — `init`, `closeQuery`,
  `handleWorkerEnded`, `resetClaudeSession`, and now `task_notification` and
  `stopBackgroundTasks` — may only take ids **out**. Membership is monotone toward empty between
  level emissions. This keeps the original rule's intent (a missed bookend must never wedge a
  stale "running" indicator) in a stronger form: every failure mode of a removal-only edge is a
  *premature empty*, self-corrected by the next level emission in one message, whereas the old
  rule's failure mode was a *permanent non-empty* — observed in a real session where two
  concurrent background Explore agents left the level signal naming only one of them; the set,
  the sidebar badge, the Stop button and the chime suppression all stayed on for 661 more events
  across three complete turns, clearable only by a CLI restart (`system/init`).
- A settled session (not interruptible) that still owns a background task is never recycled —
  closing its query would kill the CLI child and the task with it, silently.
- `stopBackgroundTasks` stops each live task, then clears the set itself, optimistically — the
  user's manual escape hatch for a task the CLI has already forgotten (where `stopTask` is a no-op
  and no level signal ever arrives to clear the set otherwise). A task that really is still alive
  flickers back on the next `background_tasks_changed`; that flicker is accepted since a
  recoverable flicker beats an unrecoverable wedge. (Previously this method deliberately did not
  clear the set, on the theory that clearing would "only resurrect the entries on the next level
  emission" — under the strengthened invariant above, that resurrection *is* the level signal
  working, not a bug.)
- A task that vanishes silently — no `task_notification`, no further `background_tasks_changed`
  naming it — is not self-healing under this invariant; the user still needs to click Stop. Fixing
  that needs per-task timestamps driven off `task_progress` plus a timer, out of scope here (see
  Open verification).
- A `result` arriving while background tasks are still live still settles the turn normally
  (`done`/`error`) — the turn lifecycle (workflow advance, queue flush, spend accounting) is
  unaffected by background work outside it.
- A queued prompt can still flush into a session while a background task runs — the CLI handles a
  new foreground turn concurrently with a background one, so this is correct, not a gap.
- The composer's Send action is never blocked by a live background task, only Stop's target
  message changes (`interrupt` vs. `stopBackgroundTasks`) based on whether a turn is also live.
- The sidebar's "background work" row is not `actionable` — a project tab must not light up for
  it — and is checked after `waiting-permission` and the interrupted-turn state, both of which do
  need the user's attention and outrank it.
- The finish chime/notification is suppressed while `backgroundTasks` is non-empty; it fires
  normally for the eventual notification turn once the set has emptied.

## Architectural rules

- `SessionStatus` is deliberately not overloaded to represent background work. Keeping a session
  `running` while a task lives in the background would leak into workflow-step advance, queue
  flushing and turn-complete accounting, all of which key off the turn settling — `backgroundTasks`
  is a separate field precisely so the turn lifecycle stays byte-identical. See
  [turn-recovery](turn-recovery.md) for the same `isSessionActive`/`isSessionInterruptible`
  boundary this respects.
- `BackgroundTaskInfo[]` is a record, not a bare count: the SDK's level payload already names
  every live task (id, type, description), so a count would either drop that information or risk
  drifting from it. One field, so the two can never disagree.
- All five writers of `LiveState.backgroundTasks` (the `handleWorkerEvent` branch,
  `reconcileWithWorker`, `closeQuery`, `resetClaudeSession`, `handleWorkerEnded`) go through the
  single private `setBackgroundTasks` helper, which owns the compare-then-upsert — no call site
  broadcasts on its own.
- Adding `stopTask` to `BridgeToWorker` is a protocol bump (v4 → v5): unlike an added field on an
  existing message (e.g. `LiveSessionInfo.backgroundTasks` itself, additive and non-breaking), a
  new message *type* is not safely ignorable by an old worker.
- `worker.ts` stays thin: it records the `background_tasks_changed`/`init` payload onto
  `SessionState` and forwards it in `hello`, but does not interpret it — the same convention
  `busy` already follows.
- The `openTasks` map in `buildTranscript` is keyed by `taskId`, not a single slot like
  `openCompact`, because background tasks (unlike compaction spans) can overlap. Its value is
  either the launching `ToolBlock` (the common case, which owns `background` in place) or a
  standalone `TaskItem` (the orphan fallback) — never both for the same id.
- `run_in_background` is absent from every real backgrounded call's input observed in practice
  (`parseTaskInput`'s `input.run_in_background === true` never matches a live launch) — the
  `taskFlags` clock-icon flag it feeds is instead sourced from `ToolBlock.background` at the
  `TaskHeader` call site, so it renders as a durable "this ran in the background" trace on a
  completed card even though the underlying input field never carries the signal.
- `task_progress`/`task_updated`/`thinking_tokens`/`status`(no compact verdict)/`hook_started`/
  `hook_response` system events are broadcast (keeping the client's `lastEventAt` honest) but no
  longer written to the transcript file (`EPHEMERAL_SYSTEM_SUBTYPES` in `server/src/sessions.ts`;
  see [transcript-rendering](transcript-rendering.md)) — roughly half of every transcript file's
  lines, and nothing reads them back on reload.

## Related decisions

- [turn-recovery](turn-recovery.md) — `LiveState`, `recycleIdleQueries`, the worker-survives-a-
  bridge-restart asymmetry this feature's `reconcileWithWorker` hydration reuses; `LiveSessionInfo`
  field-addition-is-not-a-protocol-bump convention.
- [transcript-rendering](transcript-rendering.md) — the `system`-subtype switch in
  `buildTranscript` this feature extends, and the resolve-in-place idiom borrowed from the
  compaction span.
- [session-and-project-ui](session-and-project-ui.md) — `sessionRowMeta`'s priority ladder, which
  the "background work" row is appended to beneath `waiting-permission` and the interrupted state.

## Open verification

**Residual gap in the wedge fix:** a task that vanishes silently — the CLI stops reporting it in
`background_tasks_changed` with no `task_notification` ever sent for it — is not self-healing under
the current removal-only invariant; the strip/badge/Stop button stay on for that task until the
user clicks Stop themselves (which now works, per the change above, but is still a click). Fully
self-healing this needs per-task timestamps driven off `task_progress` plus a timer to expire a
task that has gone quiet — a new abstraction, deliberately out of scope for this change.

The claim that the CLI auto-re-invokes the model (a fresh assistant turn, `origin.kind:
'task-notification'`) once a background task's `task_notification` lands is read from SDK type
docs, not confirmed against a live Lines run — the transcript grep this doc was meant to record
verbatim (tailing `~/.lines-app/transcripts/<sessionId>.jsonl` for `task_started`,
`background_tasks_changed`, `task_notification`, and a `user` event with `origin.kind:
'task-notification'` landing after the turn's own `result`) has not yet been run. If the
re-invoke does not happen on its own, the fix is one addition — the bridge injects the
notification summary as a follow-up prompt itself (`pushTurnSafely`, source `'user'`) — and
nothing else in this document changes.
