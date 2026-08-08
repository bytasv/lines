# Permission resolution provenance

## Purpose

Close every path by which an `ALWAYS_ASK_TOOLS` request (`ExitPlanMode`,
`AskUserQuestion`) could be resolved without a human clicking a card, and record
*how* every permission resolution happened so a report like "I never approved that
plan" is answerable from the transcript instead of unprovable. Before this, a
worker restart's auto-continue could nudge a session with a plan card still open,
a hook-level `continue: true` for these tools let `bypassPermissions` or a
`settings.json` `permissions.allow` entry resolve the tool before it ever reached
a user prompt, a duplicate/stale `permissionResponse` could re-resolve an
already-answered request, and a model-initiated `EnterPlanMode` was invisible to
the server, so a query restart silently dropped plan-mode gating.

## Entry points

- Every permission resolution site in `server/src/sessions.ts`: `resolvePermission`,
  `recoverOrphanedPermission`, `expireUnresolvedPermissions`, `flushPending`,
  `handleRpcCancel`, and the auto-approve branches of `handlePreToolUse` /
  `handleCanUseTool`.
- `server/src/sessions.ts` `handlePreToolUse` — the `ALWAYS_ASK_TOOLS` and
  `EnterPlanMode` branches.
- `web/src/components/PermissionPrompt.tsx` — the resolution badge tooltip.

## Important files

- `shared/types.ts` — `PermissionResolutionSource`, `PermissionRequestData.resolvedBy`
- `server/src/sessions.ts` — all resolution sites, `hasUnresolvedAlwaysAsk`,
  `unresolvedPermissions`, `findPermissionResolution`
- `web/src/lib/transcript.ts` — carries `resolvedBy` from the resolution event onto
  the merged transcript item
- `web/src/components/PermissionPrompt.tsx` — `ResolutionBadge`, `SOURCE_NOTE`

## Important symbols

- `PermissionResolutionSource` — `'user' | 'plan-reply' | 'auto' | 'recovery' |
  'workflow-advance' | 'interrupt-expire' | 'stop' | 'cancel'`
- `PermissionRequestData.resolvedBy` — optional (absent on transcripts predating
  this field); every consumer treats a missing value as `'user'`
- `hasUnresolvedAlwaysAsk(events)` — true when an `ALWAYS_ASK_TOOLS` request has no
  recorded resolution; gates both auto-continue and card expiry (see
  [interrupted-turn-recovery](interrupted-turn-recovery.md))
- `unresolvedPermissions(events)` — one-pass scan returning `{requestId, toolName}`
  for every open request; `unresolvedPermissionIds` is a thin wrapper over it

## Data flow

`handlePreToolUse` now returns an explicit `permissionDecision: 'ask'` for any
`ALWAYS_ASK_TOOLS` call, in every permission mode, instead of merely skipping its
own auto-allow branch — a bare `continue: true` would let `bypassPermissions` or a
`settings.json` `permissions.allow` entry resolve the tool before `canUseTool` runs
at all. The same hook mirrors a model-initiated `EnterPlanMode` into
`meta.permissionMode = 'plan'`, the inverse of the mirroring `resolvePermission`
already does on approval, so a query restart respawns still gated.

Every site that resolves a permission request stamps `resolvedBy`, logs one
`[permission] ...` line, and `resolvePermission`/`recoverOrphanedPermission` both
bail out (logging "duplicate answer ignored") when `findPermissionResolution`
already has an answer for that `requestId` — a second click, a second tab, or a
stale card can no longer synthesize a second decision. `findPermissionResolution`
scans the transcript backwards so the newest resolution wins.

On a worker-restart resend, `handleCanUseTool` only replays a stored resolution
for an `ALWAYS_ASK_TOOLS` request when its `resolvedBy` is `'user'` or
`'plan-reply'` (or absent, for legacy transcripts) — a synthesized `'recovery'` or
`'workflow-advance'` allow is not handed to the SDK as a real approval; the request
is re-asked instead.

## Dependencies

- [interrupted-turn-recovery](interrupted-turn-recovery.md) — auto-continue and
  card expiry both defer to `hasUnresolvedAlwaysAsk`.
- [plan-file-auto-approve](plan-file-auto-approve.md) — shares `ALWAYS_ASK_TOOLS`
  and the guard this hook change sits next to.
- [plan-review-card](plan-review-card.md) — renders `resolvedBy` as a badge tooltip.

## Tests

- `server/src/autoGuard.plan.test.ts` — the hook returns `permissionDecision: 'ask'`
  for both `ALWAYS_ASK_TOOLS` in every `PermissionMode`, including
  `bypassPermissions`.
- `server/src/sessions.permission.test.ts` — `resolvedBy` stamped per source; a
  duplicate resolution is a no-op; `findPermissionResolution` returns the newest
  answer; resend replay re-asks a synthesized allow but replays a user/plan-reply
  one (and a legacy resolution with no `resolvedBy`); `EnterPlanMode` mirrors
  `meta.permissionMode`.
- `server/src/sessions.reconcile.test.ts` — an unresolved `ExitPlanMode` card blocks
  auto-continue and survives `continueTurn`'s expiry; an ordinary tool's card still
  expires.

## Business rules

- `ExitPlanMode` and `AskUserQuestion` always resolve to an explicit `'ask'` from
  the hook, in every permission mode — never a bare `continue: true` that a mode or
  settings entry could pre-empt.
- A second answer to an already-resolved permission request is dropped; it never
  re-emits a resolution event or re-triggers `recoverOrphanedPermission`'s injected
  prompt.
- A resend after a bridge restart replays a stored `ALWAYS_ASK_TOOLS` resolution
  only when it was produced by a human (`resolvedBy` is `'user'`, `'plan-reply'`,
  or absent/legacy); any server-synthesized resolution is re-asked instead.
- A model-initiated `EnterPlanMode` sets `meta.permissionMode = 'plan'` immediately,
  so a subsequent worker/bridge restart resumes still gated rather than dropping
  back to `'default'` with edits ungated.
- Every resolution logs one `[permission] ...` line (session, tool, allow/deny,
  source) — there was previously no server-side record of how a request was
  answered.

## Architectural rules

- `resolvedBy` is optional and every reader treats a missing value as `'user'` —
  the only source that existed for any card a user could have seen before this
  field was added.
- `findPermissionResolution` scans backwards (newest wins), matching the existing
  convention in `exitPlanRequestId`.
- The workflow plan-step gate's recorded `resolution: 'allow'` was already not a
  record of the SDK's tool result (the tool itself is denied so the step stays
  read-only); `resolvedBy: 'workflow-advance'` makes that legible rather than
  changing it.

## Related decisions

None recorded.
