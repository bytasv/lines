# Typed reply while a plan is pending review means "keep planning"

## Purpose

While a session sits at `waiting-permission` with an `ExitPlanMode` card up, the SDK query is
blocked inside `canUseTool` waiting on that one decision. If the user types a message instead of
clicking a button, the old behavior queued it behind a promise nothing could ever resolve — the
session deadlocked until the user noticed and clicked "Keep planning". Now the typed message
itself counts as "Keep planning": it denies the pending `ExitPlanMode` request with the user's
own text as the reason, unblocking the query.

## Entry points

- Composer send while a plan-review card is open
- "Keep planning" button on the plan card (unchanged button path, now sharing the same reason
  string and persistence)

## Important files

- `shared/types.ts` — `PermissionRequestData.denyMessage`, `KEEP_PLANNING_MESSAGE`
- `server/src/sessions.ts` — `planReplyDecision`, `userPrompt`, `resolvePermission`,
  `recoverOrphanedPermission`, `handleCanUseTool`
- `web/src/lib/transcript.ts` — permission-card merge copies `denyMessage` onto the resolved card
- `web/src/components/PermissionPrompt.tsx` — `PlanApproval` renders the reply and badge

## Important symbols

- `planReplyDecision(input)` — pure helper; decides whether a typed prompt should be treated as
  a plan-mode deny, which pending request to answer, and the wrapped reason text
- `KEEP_PLANNING_MESSAGE` — shared reason prefix used by both the button and the typed-reply path
- `PermissionRequestData.denyMessage` — the deny reason, persisted on the resolution transcript
  event so it survives reload/restart and can be replayed or displayed later

## Data flow

`userPrompt` calls `planReplyDecision` with the session's status, `pendingPermissionTool`, the
live pending permission ids, and the transcript. A match resolves the identified `ExitPlanMode`
request through the same `resolvePermission` path the button uses (not a bulk deny), with the
reason wrapping `KEEP_PLANNING_MESSAGE` around the user's text. `resolvePermission` (and
`recoverOrphanedPermission`, for the case where the original query already died) persist
`denyMessage` on the `permission` resolution event. A restart-resend of the same request replays
that persisted `denyMessage` instead of a generic denial string. The web transcript merge copies
`denyMessage` from the resolution event onto the existing card, and `PlanApproval` shows it as a
quoted reply under a `kept planning` badge.

## Dependencies

Reuses the existing per-request `resolvePermission` / `recoverOrphanedPermission` machinery — no
new resolution channel.

## Tests

- `server/src/sessions.permission.test.ts` — `planReplyDecision` fall-through conditions,
  request-id selection (live vs. transcript-scan fallback), and the attachments/no-attachments
  reason-text branches

## Business rules

- Only fires when `status === 'waiting-permission'`, `pendingPermissionTool === 'ExitPlanMode'`,
  and the typed text is non-empty; any other pending tool (e.g. `AskUserQuestion`, `Bash`) is left
  alone so it can't be collaterally denied.
- No attachments: the reason is `KEEP_PLANNING_MESSAGE` plus the user's raw text, and nothing
  else is queued — the deny reason is the whole turn.
- With attachments: the reason is `KEEP_PLANNING_MESSAGE` plus a note only (no raw text, since
  attachments can't ride a `tool_result`); the real text and attachments are queued separately
  and delivered as the next turn once the deny settles the busy query.
- The plan card's badge shows `kept planning` (not `denied`) for a denied `ExitPlanMode` request.

## Architectural rules

- Picks the request id via a single backwards scan (same shape as
  `findPermissionRequest`/`findPermissionResolution`), preferring a live pending id whose
  transcript request is `ExitPlanMode`, else the newest unresolved one — never a bulk
  deny-everything-pending pass, so a concurrent unrelated permission card is never touched.
- Never emits a `user` transcript event or calls `prompt()` directly for the typed text on the
  no-attachments path — both would open a new turn boundary and corrupt turn-scoped bookkeeping
  (`collectTurns`, `permissionWaitMs`).

## Related decisions

None recorded.
