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

## Entry points

- The SDK's `system/background_tasks_changed` message on a session's live query — level signal,
  REPLACE semantics, emitted whenever membership changes (task start, completion, kill, a
  foreground call being backgrounded)
- The SDK's `system/task_started` and `system/task_notification` messages — edge bookends for the
  transcript row only, never used to derive "is work running"
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
- `web/src/lib/transcript.ts` — `TaskItem`, the `openTasks` map, the `task_started`/
  `task_notification` cases in `buildTranscript`'s `system` switch, the `'task'` case in
  `reconcileItem`
- `web/src/components/Transcript.tsx` — the `case 'task'` row
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
- `TaskItem` (`web/src/lib/transcript.ts`) — transcript row kind: `taskId`, `description`,
  `subagentType?`, and an `outcome?: { status, summary }` filled in by the matching
  `task_notification`

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
the SDK `Query.stopTask(taskId)`. Nothing here clears the local set — `background_tasks_changed`
is the only writer, and the CLI reports the kill itself (plus a `task_notification` with
`status: 'stopped'`) once the task actually dies. Clearing optimistically on the stop request
would resurrect the entries on the next level emission if the CLI hadn't caught up yet.

### Transcript rendering

`task_started` opens a `TaskItem` (skipped entirely when the SDK marks it
`skip_transcript: true`, e.g. ambient housekeeping tasks) and is tracked in a `taskId`-keyed
`openTasks` map inside `buildTranscript`. The matching `task_notification` resolves that item in
place by setting its `outcome`, rather than pushing a second card — the same resolve-in-place
idiom the compaction span (`openCompact`) already uses, generalized from a single slot to a map
because tasks can overlap. A `task_notification` whose `task_started` was never seen (skipped, or
a truncated transcript) pushes a standalone already-resolved card instead of being dropped.
`task_progress`/`task_updated` are ignored — too chatty for the inline transcript.

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
  `recycleIdleQueries()` skips a settled session with a live task and still closes one without;
  `stopBackgroundTasks` issues one `stopTask` per live id and does not clear the set itself; a
  `result` arriving with live tasks still settles the turn to `done`; a persisted
  `backgroundTasks` value never survives load from disk; `reconcileWithWorker` repopulates the set
  from `hello`, and leaves it alone when the worker reports `undefined`
- No web test infrastructure — the transcript row, the composer Stop gating, the live strip and
  the sidebar row are manual-verification only (`verify` skill), same as the rest of the
  transcript/composer/sidebar surface

## Business rules

- The set is live-only: never restored from a persisted `SessionMeta.backgroundTasks` on load — a
  background task belongs to a specific CLI process, and a value surviving a bridge/process
  restart in `sessions.json` describes a process nothing here has a handle on any more. The
  worker's `hello` (via `reconcileWithWorker`) or the next `background_tasks_changed` repopulate
  it for whichever tasks are genuinely still running.
- The level signal (`background_tasks_changed`) is the only writer of the live set. `task_started`
  and `task_notification` never mutate it — they only drive the transcript row. A missed bookend
  (a `task_started` skipped as ambient, or a truncated transcript) must never wedge a stale
  "running" indicator, and the ordering between the level signal and the edge events is
  unspecified by the SDK.
- A settled session (not interruptible) that still owns a background task is never recycled —
  closing its query would kill the CLI child and the task with it, silently.
- `stopBackgroundTasks` never clears the set itself; only a subsequent `background_tasks_changed`
  (driven by the CLI's own `task_notification: 'stopped'`) does.
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
  `openCompact`, because background tasks (unlike compaction spans) can overlap.

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

The claim that the CLI auto-re-invokes the model (a fresh assistant turn, `origin.kind:
'task-notification'`) once a background task's `task_notification` lands is read from SDK type
docs, not confirmed against a live Lines run — the transcript grep this doc was meant to record
verbatim (tailing `~/.lines-app/transcripts/<sessionId>.jsonl` for `task_started`,
`background_tasks_changed`, `task_notification`, and a `user` event with `origin.kind:
'task-notification'` landing after the turn's own `result`) has not yet been run. If the
re-invoke does not happen on its own, the fix is one addition — the bridge injects the
notification summary as a follow-up prompt itself (`pushTurnSafely`, source `'user'`) — and
nothing else in this document changes.
