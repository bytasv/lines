# Permissions and plan mode

Covers: `permission-mode-selector`, `permission-resolution-provenance`, `guard-allowlist`,
`plan-file-auto-approve`, `plan-review-card`, `plan-reply-keeps-planning`, `plan-comments`.

## Purpose

Everything that decides whether a tool call runs, who decided it, and how plan mode's
deliverable is written and reviewed.

- **Mode selector** — pick how much a session or workflow step's tool calls are gated by the
  permission guard. Every picker (composer toolbar, settings defaults, workflow step
  editor/library) shows the same five modes with the same labels and descriptions.
- **Resolution provenance** — close every path by which an `ALWAYS_ASK_TOOLS` request
  (`ExitPlanMode`, `AskUserQuestion`) could be resolved without a human clicking a card, and
  record *how* every permission resolution happened so a report like "I never approved that
  plan" is answerable from the transcript instead of unprovable. Before this, a worker restart's
  auto-continue could nudge a session with a plan card still open, a hook-level `continue: true`
  for these tools let `bypassPermissions` or a `settings.json` `permissions.allow` entry resolve
  the tool before it ever reached a user prompt, a duplicate/stale `permissionResponse` could
  re-resolve an already-answered request, and a model-initiated `EnterPlanMode` was invisible to
  the server, so a query restart silently dropped plan-mode gating.
- **Guard allowlist** — make the auto-mode guard's "Always allow" exceptions visible and
  editable in Settings instead of an invisible, append-only local file, and sync the list across
  a user's machines through the storage server — without ever letting a remote change apply
  silently, since the list controls what Auto mode is allowed to run without asking.
- **Plan-file auto-approve** — let plan mode's deliverable (a Markdown file under a
  `.claude/plans/` directory) get written, edited, and re-read without a permission card on
  every call, even though the file lives outside the session `cwd` (which the guard otherwise
  escalates as "file access outside the working directory"). `isPlanPath` is also exported and
  reused by the bridge's `file` request handler, so the plan review card can read a plan file
  live even though it lives outside every project/session root.
- **Plan review card** — an approved or denied `ExitPlanMode` plan card used to collapse to a
  header + badge with the plan markdown and Focus-mode button gone/inert. The card is now
  collapsed-but-reopenable, falls back to the plan file's text when the harness passes no inline
  `plan` argument, and re-reads that file from disk each time it's opened so it is never frozen
  at whatever text it first captured.
- **Typed reply keeps planning** — while a session sits at `waiting-permission` with an
  `ExitPlanMode` card up, the SDK query is blocked inside `canUseTool` waiting on that one
  decision. If the user types a message instead of clicking a button, the old behavior queued it
  behind a promise nothing could ever resolve — the session deadlocked until the user noticed
  and clicked "Keep planning". The typed message itself now counts as "Keep planning": it denies
  the pending `ExitPlanMode` request with the user's own text as the reason, unblocking the
  query.
- **Plan comments** — select a passage inside the plan card, attach a note to it instead of
  abandoning the card to retype the whole thing in the composer. With at least one comment
  attached, the card's two actions become **Approve with comments** (a real allow; the comments
  are delivered into the turn the approval starts, since the SDK's allow arm carries no message)
  and **Refine with comments** (a deny built server-side from the comments, ignoring whatever the
  client sent as `denyMessage`). With zero comments the card is unchanged from before this existed.

## Entry points

- Session composer permission-mode segmented control
- New-session defaults in the settings modal's Sessions pane
- Workflow step editor and step library permission-mode dropdowns
- Every permission resolution site in `server/src/sessions.ts`: `resolvePermission`,
  `recoverOrphanedPermission`, `expireUnresolvedPermissions`, `flushPending`, `handleRpcCancel`,
  and the auto-approve branches of `handlePreToolUse` / `handleCanUseTool`
- `server/src/sessions.ts` `handlePreToolUse` — the `ALWAYS_ASK_TOOLS` and `EnterPlanMode`
  branches
- `web/src/components/PermissionPrompt.tsx` — the resolution badge tooltip; `PermissionPrompt`
  rendering an `ExitPlanMode` permission item (live or replayed from a persisted transcript)
- Settings modal, "Auto-mode allowlist" pane (nav rail item, deep-linked when a review is
  pending) — list, remove, hand-add an entry
- Permission card "Always allow" — the existing write path, going through the same
  normalization and change notifications as the UI
- Allowlist-changed-elsewhere review modal, mounted at the app root (not inside Settings) so a
  divergence reaches the user even if they never open the gear
- `Read`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit` tool calls targeting a plan file, arriving
  via `PreToolUse` and `canUseTool`
- A `file` request over the WebSocket, when the resolved path falls outside every
  project/session root but inside a plan directory
- Composer send while a plan-review card is open; "Keep planning" button on the plan card
- Selecting text inside `PlanApproval`'s rendered plan (inline card or fullscreen focus mode) —
  the floating comment icon, its overlay, and the comment list underneath
- Hovering a highlighted (commented) passage in the plan body, or a row in the comment list
- `permissionResponse`'s `planComments` field, consumed only on an `ExitPlanMode` resolution

## Files

- `shared/types.ts` — `PermissionMode` type (`default` | `auto` | `acceptEdits` | `plan` |
  `bypassPermissions`); `PermissionResolutionSource`, `PermissionRequestData.resolvedBy`;
  guard entry/blob/review types, `normalizeAllowEntry` and the other validators, the
  `addGuardAllow`/`removeGuardAllow`/`reviewGuardAllowlist` and
  `guardAllowlist`/`guardAllowlistReview` wire messages; `PLAN_DIR_MARKER`, `isPlanFilePath`;
  `PermissionRequestData.denyMessage`, `KEEP_PLANNING_MESSAGE`; `PlanComment`,
  `normalizePlanComments`, `formatPlanComments`; `ClientMessage.permissionResponse.planComments`
- `web/src/lib/permissionModes.tsx` — shared mode list, segmented-control data, dropdown render
  helper
- `web/src/lib/modelSelect.tsx` — `renderOptionWithDescription` (label + dimmed description
  renderer, shared with the model selector), `modelComboboxProps` (popover widener, shared)
- `web/src/components/Composer.tsx`, `web/src/components/SettingsModal.tsx`
- `web/src/components/workflow/StepLibrary.tsx`
- `web/src/components/workflow/StepCard.tsx` — also shows the collapsed step's mode label
- `server/src/sessions.ts` — `'auto'` runs the SDK in `acceptEdits` while the bridge guard
  approves/prompts per tool call; all resolution sites, `hasUnresolvedAlwaysAsk`,
  `unresolvedPermissions`, `findPermissionResolution`; `handlePreToolUse`, `handleCanUseTool`,
  `collectTurns`; `resolvePermission`'s "Always allow" branch; `planReplyDecision`, `userPrompt`,
  `recoverOrphanedPermission`; `pushIntoLiveTurn` (extracted from `interjectQueued`, see
  [turn-interjection](turn-interjection.md)); `resolvePermission`'s `planComments` handling
  (gate branch, allow+interject, deny wording, queue fallback)
- `server/src/autoGuard.ts` — `GuardAllowlist` (CRUD, load-time migration, the review
  lifecycle); re-exports `ALWAYS_ASK_TOOLS`/`GuardAllowEntry` from `shared/types.ts` for
  existing importers; `isPlanPath` (exported), `isSafeReadOnly`, `isSafePlanWrite`,
  `assessToolCall`
- `server/src/store.ts` — `GuardSyncState`, `loadGuardSync`/`saveGuardSync`
  (`guard-allowlist-sync.json`, separate from the bare-array `guard-allowlist.json`)
- `server/src/sync.ts` — `pushGuardAllowlist`, the isolated `/guard-allowlist` pull
- `server/src/userContext.ts` — wires `guard.onChange`/`guard.onReview` to broadcast + push, and
  calls `reviewRemote` before the push block in `syncNow`
- `server/src/index.ts` — `hello` fields, the three guard message cases; the `permissionResponse`
  case's `prompt`-capability gate on `planComments`
- `server/src/workspacePaths.ts` — `resolveWorkspacePath`, `workspaceRoots` (the
  `file`/`tree`/`find` root gate; its plan-directory exception is `isPlanPath`)
- `storage/prisma/schema.prisma`, `storage/src/index.ts` — the `guard_allowlist` table and its
  `GET`/`PUT /guard-allowlist` endpoints
- `web/src/store.ts` — `guardAllowlist`/`guardReview` state, actions, message cases;
  `readPlanComments`/`writePlanComments`/`prunePlanComments` (per-session, per-`requestId`
  `localStorage` drafts, mirroring the composer-draft helpers)
- `web/src/components/GuardAllowlistSection.tsx`,
  `web/src/components/GuardAllowlistReviewModal.tsx`, `web/src/lib/guardEntries.ts`
- `web/src/lib/transcript.ts` — carries `resolvedBy` from the resolution event onto the merged
  transcript item; `buildTranscript` (`permission` case), `withPlanFileText`; the permission-card
  merge copies `denyMessage` onto the resolved card
- `web/src/components/PermissionPrompt.tsx` — `ResolutionBadge`, `SOURCE_NOTE`, `PlanApproval`,
  `PlanReply` (resolved-card reply attribution); `CommentablePlan` (selection-to-comment
  affordance, the hover bubble), `locateQuotes`/`flattenText` (quote-to-`Range` anchoring for the
  CSS Custom Highlight paint)
- `web/src/lib/files.ts` — `useFileContent` (the plan card's live re-read)

## Symbols

- `PERMISSION_MODES` — `{ value, label, description }[]`, single source of truth for all four
  pickers
- `PERMISSION_MODE_SEGMENTS` — `PERMISSION_MODES` mapped to Mantine `SegmentedControl` data,
  each label wrapped in a `Tooltip` showing the description
- `permissionModeLabel()` — label lookup by value, raw value fallback (used by the collapsed
  step card)
- `renderPermissionModeOption` — alias of `renderOptionWithDescription`, used as the workflow
  Select's `renderOption`
- `PermissionResolutionSource` — `'user' | 'plan-reply' | 'auto' | 'recovery' |
  'workflow-advance' | 'interrupt-expire' | 'stop' | 'cancel'`
- `PermissionRequestData.resolvedBy` — optional (absent on transcripts predating this field);
  every consumer treats a missing value as `'user'`
- `hasUnresolvedAlwaysAsk(events)` — true when an `ALWAYS_ASK_TOOLS` request has no recorded
  resolution; gates both auto-continue and card expiry (see
  [turn-recovery](turn-recovery.md))
- `unresolvedPermissions(events)` — one-pass scan returning `{requestId, toolName}` for every
  open request; `unresolvedPermissionIds` is a thin wrapper over it
- `normalizeAllowEntry(raw)` — the single validation gate every writer (permission card,
  Settings form, load migration, remote ingest) runs an entry through; returns the canonical
  entry or a `GuardEntryError`
- `diffAllowlists(local, remote)` / `sameAllowEntry` — set-based comparison used both for
  divergence detection and for the review's added/removed lists
- `GuardAllowlist.reviewRemote(remote)` — stages, updates, or clears a pending review; never
  mutates the live entries
- `GuardAllowlist.acceptReview()` / `rejectReview()` — the only two ways a pending review
  resolves. `acceptReview` re-runs `sanitizeEntries` on the pending blob before installing it,
  since the blob round-trips through disk (`loadGuardSync` is unvalidated) between `reviewRemote`
  staging it and the user accepting
- `GuardAllowlist.blob()` — entries plus the `updatedAt` that orders the storage row; distinct
  from the set-difference comparison used to detect divergence
- `isPlanPath(filePath, roots)` — true when the resolved path is inside `~/.claude/plans` or
  `<root>/.claude/plans` for any of `roots`; the actual permission-escalation guard, anchored to
  real directories. Exported so both the guard and `resolveWorkspacePath` share one containment
  check
- `isPlanFilePath(filePath)` — shared, cheap substring check (`.claude/plans/` in the normalized
  path); a hint only, used where a resolved path isn't available (transcript scans on both
  server and web)
- `isSafeReadOnly(toolName, input, roots, allowlist)` — observation-only calls (`Read`, `Glob`,
  `Grep`, …); also true for plan-file reads outside `auto` mode
- `isSafePlanWrite(toolName, input, roots)` — true for `Write`/`Edit`/`MultiEdit`/`NotebookEdit`
  targeting a plan path
- `assessToolCall(toolName, input, roots, allowlist)` — the shared guard verdict function; plan
  paths short-circuit to non-dangerous inside its out-of-root branch. Takes every root a session
  may work in (see [multi-root-projects](multi-root-projects.md)), not a single `cwd`
- `resolveWorkspacePath(ctx, raw)` — the `file`/`tree`/`find` path resolver; falls back to
  `isPlanPath(abs, ctx.sessions.list().map(cwd))` when the project/session root check fails
- `PlanApproval` — the plan card + fullscreen focus modal; owns `expanded` (collapsed/open)
  independently of `focus` (fullscreen)
- `withPlanFileText(data, planWrite)` — on the permission *request* event only, fills
  `data.input.plan` from the turn's last plan-file write when the inline argument is empty, and
  always sets `data.input.planPath` to that write's path when one is known (independent of which
  text won); a real inline `plan` always wins on text
- `computeDiff(tool)` — reused to resolve the plan-file write's post-edit text, including
  `Edit`/`MultiEdit` revisions reconstructed from the file snapshot
- `useFileContent(path, reloadKey?)` — fetches `planPath` over the `/file` route whenever the
  card is open; `reloadKey` forces a refetch on each reopen
- `planReplyDecision(input)` — pure helper; decides whether a typed prompt should be treated as
  a plan-mode deny, which pending request to answer, and the wrapped reason text
- `KEEP_PLANNING_MESSAGE` — shared reason prefix used by both the button and the typed-reply path
- `PermissionRequestData.denyMessage` — the deny reason, persisted on the resolution transcript
  event so it survives reload/restart and can be replayed or displayed later
- `PermissionRequestData.elicitation` — set instead of a tool call when an MCP server (not the
  model) is asking the user for something, in practice an OAuth authorization URL. The card this
  produces reuses every mechanism on this page (resolution provenance, resend replay, dedupe of a
  second answer) rather than a parallel pending-request channel; see
  [mcp-connections](mcp-connections.md)
- `PlanComment` — `{ id, quote, note }`; anchored by the selected text itself, never by an
  offset, because the plan markdown re-renders and the card re-reads the plan file from disk
- `normalizePlanComments(raw)` — the single validation gate a plan-comment list runs through
  (drops an empty-note entry, truncates `quote`/`note`, caps the list at 20); run server-side on
  the wire payload and by the web client before it ever sends one, the same role
  `normalizeAllowEntry` plays for guard entries
- `formatPlanComments(comments, mode)` — the only place the wording of a commented plan decision
  lives; `'refine'` wraps `KEEP_PLANNING_MESSAGE` and the `"The user's message:\n"` marker
  `planReplyText` already parses, `'approve'` states the count and applies-not-replaces framing
- `pushIntoLiveTurn(meta, text)` — the `pushTurnSafely(..., { intoLiveTurn: true })` call
  extracted out of `interjectQueued` so a second caller (an approved plan carrying comments) can
  reuse it without duplicating the `priority: 'next'` reasoning; see
  [turn-interjection](turn-interjection.md)
- `readPlanComments`/`writePlanComments`/`prunePlanComments` — `localStorage` drafts keyed by
  session id *and* `requestId`, so comments belong to the plan round they were written against
- `CommentablePlan` — wraps a rendered plan copy with select-to-comment (an `ActionIcon` at the
  selection, an overlay `Textarea`) and the highlight paint/hover-bubble machinery; rendered once
  for the inline card and once for fullscreen focus mode, each its own instance
- `locateQuotes(root, comments)` / `flattenText(root)` — best-effort re-location of each comment's
  stored quote inside the currently-rendered plan text, for painting the highlight; a passage the
  agent has since rewritten simply isn't found, and its highlight is silently dropped

## Data flow

### Mode selection

`PERMISSION_MODES` (`web/src/lib/permissionModes.tsx`) feeds every picker directly — there is no
server round-trip for the mode list, unlike the model selector. The composer/settings segmented
controls use `PERMISSION_MODE_SEGMENTS`; the workflow Selects use `PERMISSION_MODES` +
`renderPermissionModeOption`.

The chosen value is UI/storage-level only. `'auto'` is a client-and-guard concept: the SDK
session actually runs in `acceptEdits`, and the bridge guard decides per tool call whether to
auto-approve or prompt (see the `PermissionMode` doc comment in `shared/types.ts`). The guard's
exceptions to that per-call decision are a user-visible, editable list — the allowlist below.

`'bypassPermissions'` is bridge-enforced too, for a different reason: the worker always registers
a `canUseTool` callback, so the SDK's own bypass fast-path never runs and *our* handlers decide
every call. Both `handlePreToolUse` and `handleCanUseTool` carry a `bypassPermissions` branch that
auto-allows outright — placed after the `ALWAYS_ASK_TOOLS` and Lines-MCP-write returns, so those
two carve-outs still prompt, and before the guard, so bypass never pays for `assessToolCall`.
Without those branches Bypass behaved exactly like Manual. `buildQueryOptions` also passes
`allowDangerouslySkipPermissions: true` unconditionally — the SDK requires it before it will
accept the mode at all, and setting it at spawn is what lets a *mid-session* switch to Bypass
take effect on the running query instead of being rejected into a `worker.ts` `console.warn`.

### Resolution provenance

`handlePreToolUse` returns an explicit `permissionDecision: 'ask'` for any `ALWAYS_ASK_TOOLS`
call, in every permission mode, instead of merely skipping its own auto-allow branch — a bare
`continue: true` would let `bypassPermissions` (whose own branch sits right below it) or a
`settings.json` `permissions.allow` entry resolve the tool before `canUseTool` runs at all. That
explicit `'ask'` is the only thing keeping plan approval and clarifying questions in front of a
human under Bypass. The same hook mirrors a model-initiated
`EnterPlanMode` into `meta.permissionMode = 'plan'`, the inverse of the mirroring
`resolvePermission` already does on approval, so a query restart respawns still gated.

Every site that resolves a permission request stamps `resolvedBy`, logs one `[permission] …`
line, and `resolvePermission`/`recoverOrphanedPermission` both bail out (logging "duplicate
answer ignored") when `findPermissionResolution` already has an answer for that `requestId` — a
second click, a second tab, or a stale card can no longer synthesize a second decision.
`findPermissionResolution` scans the transcript backwards so the newest resolution wins.

On a worker-restart resend, `handleCanUseTool` only replays a stored resolution for an
`ALWAYS_ASK_TOOLS` request when its `resolvedBy` is `'user'` or `'plan-reply'` (or absent, for
legacy transcripts) — a synthesized `'recovery'` or `'workflow-advance'` allow is not handed to
the SDK as a real approval; the request is re-asked instead.

### Guard allowlist and its sync review

A local change (permission card "Always allow", or a Settings add/remove) calls
`GuardAllowlist.add`/`remove`, which persists, fires `onChange`, and — unless a review is
currently pending — pushes the new blob to the storage server.

On connect/reconnect, `syncNow` pulls `/guard-allowlist` and calls
`guard.reviewRemote(pulled.guardAllowlist)` *before* pushing local state up. If the remote list
(after re-validation) differs from the local one, a review is staged and broadcast as
`guardAllowlistReview`; the entries themselves are untouched. `hello` also carries the current
list and any pending review, so a fresh page load or bridge restart shows the banner/modal
immediately rather than waiting on the next pull.

The user resolves the review by accepting (installs the remote list verbatim) or rejecting
(keeps the local list, but bumps its `updatedAt` so it now wins the storage row's
last-write-wins and gets pushed back over the remote one).

### Plan-file auto-approve

`handlePreToolUse`/`handleCanUseTool` check, outside `auto` and `bypassPermissions` mode:
`isSafeReadOnly(...) || isSafePlanWrite(...)` → if either is true, auto-approve (same
`resolution: 'allow', auto: true` transcript event and `permissionDecision: 'allow'` /
`{ behavior: 'allow' }` return used by the existing observation-only path) instead of prompting.

Separately, `resolveWorkspacePath` (used by the `file`, `tree`, and `find` request routes) first
checks the requested path against every project root and session cwd; if that fails, it
additionally allows the path when `isPlanPath` holds for any of the user's session cwds (which
also covers the cwd-independent `~/.claude/plans`). Everything downstream of that resolve — the
`MAX_FILE_BYTES` cap, binary rejection, auth — is unchanged; `tree` and `find` inherit the same
widening since they share the same resolver.

### Plan review card

`buildTranscript` tracks the current turn's last edit-tool call whose file path matches
`isPlanFilePath` in two accumulators: `lastPlanWrite` (reset every `user`/`workflow` boundary)
and `sessionPlanWrite` (never reset). When an `ExitPlanMode` permission *request* event arrives,
`withPlanFileText` is given `lastPlanWrite ?? sessionPlanWrite` — a same-turn write still wins,
but a request whose `ExitPlanMode` lands in a later turn than the write falls back to the
session-wide value instead of finding nothing. It resolves that write's text via
`computeDiff(...).after` for the captured snapshot and copies the write's file path onto
`data.input.planPath` regardless of which text won; the *resolution* event only stamps
`resolution`/`denyMessage` onto the already-built item, so the stitched text and path survive.

`PlanApproval` renders open (`expanded = true`) while pending; once `resolution` is set it
collapses and closes focus mode. The header is a click target (chevron + collapsed headline)
that re-expands the card at any time. Whenever the card is open (`expanded || focus`), it calls
`useFileContent(planPath, reloadKey)` against the bridge's `/file` route; a false→true
transition of "open" bumps `reloadKey` so reopening always refetches. The captured `plan` text
renders immediately (no empty flash) and the live `content` swaps in on arrival; a fetch failure
(deleted plan, 403) silently keeps the captured text. When resolved and the live content differs
from the captured text, a dimmed "updated since approval" hint renders next to the resolution
badge.

### Typed reply as "keep planning"

`userPrompt` calls `planReplyDecision` with the session's status, `pendingPermissionTool`, the
live pending permission ids, and the transcript. A match resolves the identified `ExitPlanMode`
request through the same `resolvePermission` path the button uses (not a bulk deny), with the
reason wrapping `KEEP_PLANNING_MESSAGE` around the user's text. `resolvePermission` (and
`recoverOrphanedPermission`, for the case where the original query already died) persist
`denyMessage` on the `permission` resolution event. A restart-resend of the same request replays
that persisted `denyMessage` instead of a generic denial string. The web transcript merge copies
`denyMessage` from the resolution event onto the existing card, and `PlanApproval` shows it as a
quoted reply under a `kept planning` badge.

### Plan comments

Comments are drafted client-side only: `CommentablePlan` writes each one to
`readPlanComments`/`writePlanComments` on every change, keyed by session id and `requestId`, so a
card that unmounts and remounts (the transcript windows its tail) never loses a half-finished
review. Nothing syncs a draft between viewers before it is sent — each reviewer sees only their
own drafts until they click one of the two buttons.

Clicking either button sends `permissionResponse` with `planComments` attached (only when the
list is non-empty; with zero comments the message is identical to before this feature). The
server re-validates with `normalizePlanComments` — the client's list is never trusted — and, since
`permissionResponse` is gated on `approvePermissions` while a text channel to the model is a
`prompt`-cap concern, drops the comments (keeping the approve/deny itself) unless the actor also
holds `prompt` and does not carry `promptNeedsApproval`.

`resolvePermission` then branches on the resolved tool and mode:

- **Workflow plan-step gate:** the comments are appended, formatted via
  `formatPlanComments(comments, 'approve')`, onto the gate's existing deny message ("do not
  implement — end your turn"). No interjection: the turn is ending so the workflow can advance,
  and a pushed message would land in a turn with nothing left to steer.
- **Ordinary allow (Approve with comments):** the resolve stays a real `{ allow: true }` — the
  SDK's allow arm has no message field, only deny carries text. If `canInterject(sessionId)`
  holds (the same gate [turn-interjection](turn-interjection.md) uses: a running, non-compacting,
  non-rewinding turn on a query this bridge knows it spawned, with the worker link open now), an
  `'interject'` transcript event is written and `pushIntoLiveTurn` delivers
  `formatPlanComments(comments, 'approve')` into the turn the approval just started — synchronous
  with the resolve, before the CLI has round-tripped the model. If `canInterject` is false (the
  turn already settled, or the worker link is down), the text is staged as an ordinary queued
  prompt instead (the same shape `userPrompt` uses) and delivered as the next turn, never dropped.
- **Deny (Refine with comments):** the deny reason is built server-side from
  `formatPlanComments(comments, 'refine')`, discarding whatever `denyMessage` the client sent, so
  "Refine with comments" and a typed composer reply read identically to the model. Reusing the
  `KEEP_PLANNING_MESSAGE` prefix and the `"The user's message:\n"` marker means `planReplyText`
  renders the comments back on the resolved card with no client-side special case.

  This stored `denyMessage`, and an `AskUserQuestion` resolution's `answers`, are also the source
  a **Retry** re-sends if the turn fails before the answer reaches the model — neither ever
  produces a `'user'` transcript event, so without this a Retry would re-send whatever opened the
  turn instead (a whole workflow step's rendered prompt, on a planning step). See
  [turn-recovery](turn-recovery.md#retry-re-sends-the-newest-human-input-not-just-the-turns-opening-prompt).
  This is deliberately a read-side fix: writing a `'user'` event when a card is answered would open
  a new turn boundary and corrupt turn-scoped bookkeeping (`collectTurns`, `permissionWaitMs`), so
  that path stays exactly as described above — no wire, store, or emitted-event change.

The plan body paints each comment's quote back onto the rendered text using the CSS Custom
Highlight API (`::highlight()` in `web/src/index.css`) rather than by injecting a `<mark>`
wrapper: a `Highlight` is a set of `Range`s held outside the DOM, so it survives the plan
markdown's own re-renders (on mount, and on every live re-read of the plan file) with nothing to
reconcile. `locateQuotes` re-finds each quote by whitespace-collapsed string match on every
re-render (via a `MutationObserver`); a quote the agent has since rewritten simply isn't found,
and only its highlight is lost — the comment itself still shows in the list and still reaches the
model. Hovering a highlighted passage is hit-tested geometrically against the `Range`s'
`getClientRects()` (a `Range` has no box and receives no native hover), and pops up the comment's
note in a small bubble with the same edit/delete actions the list row has.

## Dependencies

- Mantine `@mantine/core` `SegmentedControl` (ReactNode label) and `Select` (`renderOption`,
  `comboboxProps`).
- Storage server `guard_allowlist` table, one JSON blob per user (see
  [agent-memory-sync](agent-memory-sync.md) for the precedent this follows and the row-per-item
  alternative it explicitly does not need at this scale).
- The plan-path guard builds entirely on the pre-existing `isInside` path-containment helper and
  the out-of-cwd branch in `assessToolCall`; no new state or message type. The `file` route's use
  is a second caller of the same exported `isPlanPath`, not a parallel check.
- The plan card reuses `computeDiff` (Monaco diff support), the `.tx-row` click-target pattern
  already used by `ToolCallCard`/`ToolGroup`, and the bridge's existing `/file` route
  (`useFileContent`, shared with `MonacoPreviewModal`/`FilesView`). No new transcript event or
  message type.
- The typed-reply path reuses the existing per-request `resolvePermission` /
  `recoverOrphanedPermission` machinery — no new resolution channel.
- [turn-recovery](turn-recovery.md) — auto-continue and card expiry both defer to
  `hasUnresolvedAlwaysAsk`.
- [turn-interjection](turn-interjection.md) — plan comments' approve path reuses
  `pushIntoLiveTurn` and `canInterject` rather than building its own delivery mechanism; a second
  caller alongside "Send now", not a queue-button-only path.
- CSS Custom Highlight API (`CSS.highlights`, `::highlight()`) — no polyfill; unsupported browsers
  (pre Chrome 105 / Safari 17.2 / Firefox 140) silently render the pre-feature appearance, guarded
  by an `'highlights' in CSS` check.

## Tests

- `server/src/autoGuard.plan.test.ts` — the hook returns `permissionDecision: 'ask'` for both
  `ALWAYS_ASK_TOOLS` in every `PermissionMode`, including `bypassPermissions`; under
  `bypassPermissions` the hook allows a `Bash` call the guard would otherwise prompt for but
  still asks for a Lines workflow write; `isPlanPath`
  containment (home plans dir, `<cwd>/.claude/plans`, out-of-tree paths, and the classic
  `.../plans/../../../.ssh/id_rsa` traversal), plus the `isSafeReadOnly`/`isSafePlanWrite`/
  `assessToolCall` cases.
- `server/src/sessions.permission.test.ts` — `resolvedBy` stamped per source; a duplicate
  resolution is a no-op; `findPermissionResolution` returns the newest answer; resend replay
  re-asks a synthesized allow but replays a user/plan-reply one (and a legacy resolution with no
  `resolvedBy`); a `bypassPermissions` session resolves `Bash` straight to `allow` with no card
  and no `waiting-permission`, while `ExitPlanMode` still parks; `EnterPlanMode` mirrors
  `meta.permissionMode`; `planReplyDecision`
  fall-through conditions, request-id selection (live vs. transcript-scan fallback), and the
  attachments/no-attachments reason-text branches; `normalizePlanComments` (empty-note drop,
  truncation, cap) and `formatPlanComments` (the refine wording still contains
  `KEEP_PLANNING_MESSAGE` and the marker `planReplyText` parses); approve-with-comments resolves
  `allow`/`resolvedBy: 'user'` with a matching `'interject'` transcript event; comments on an
  approval whose turn cannot be steered land in the queue instead of being dropped;
  refine-with-comments produces a `deny` whose `denyMessage` is server-built from the comments,
  never the client's; a workflow plan-step gate with comments still resolves
  `resolvedBy: 'workflow-advance'` with no `'interject'` event, the comments folded into the gate's
  deny message instead; an empty comment list resolves exactly as before this feature existed.
- `server/src/sessions.reconcile.test.ts` — an unresolved `ExitPlanMode` card blocks
  auto-continue and survives `continueTurn`'s expiry; an ordinary tool's card still expires.
- `server/src/autoGuard.allowlist.test.ts` — validator rules (through `assessToolCall`, not just
  string comparison), CRUD, and the load-time migration.
- `server/src/autoGuard.sync.test.ts` — the review lifecycle: staging, set-equal clearing,
  invalid-entry filtering, accept/reject, reject-remembered-by-content, and restart persistence.
- `server/src/sessions.alwaysAllow.test.ts` — the permission-card write path.
- `server/src/store.test.ts` — `loadGuardSync`/`saveGuardSync` round-trip.
- `server/src/index.planFile.test.ts` — `resolveWorkspacePath` accepting a home-plans path and a
  project-local plans path, and still rejecting an arbitrary out-of-root path and plan-dir
  traversal.
- No web test infrastructure covers UI components at time of writing; `PermissionPrompt.tsx` is
  untestable here without a React renderer (matches
  [transcript-rendering](transcript-rendering.md)).

## Business rules

- All five `PermissionMode` values stay selectable everywhere, including `acceptEdits` — preset
  workflows (`web/src/lib/workflowPresets.ts`, `server/src/workflows.ts`) ship steps with
  `permissionMode: 'acceptEdits'`, so dropping it from the option list would blank those Selects.
- `default` displays as **Manual** — the stored value is unchanged, only the label differs.
- `ExitPlanMode` and `AskUserQuestion` always resolve to an explicit `'ask'` from the hook, in
  every permission mode — never a bare `continue: true` that a mode or settings entry could
  pre-empt. This holds regardless of the target path.
- A second answer to an already-resolved permission request is dropped; it never re-emits a
  resolution event or re-triggers `recoverOrphanedPermission`'s injected prompt.
- A resend after a bridge restart replays a stored `ALWAYS_ASK_TOOLS` resolution only when it was
  produced by a human (`resolvedBy` is `'user'`, `'plan-reply'`, or absent/legacy); any
  server-synthesized resolution is re-asked instead.
- A model-initiated `EnterPlanMode` sets `meta.permissionMode = 'plan'` immediately, so a
  subsequent worker/bridge restart resumes still gated rather than dropping back to `'default'`
  with edits ungated.
- Every resolution logs one `[permission] …` line (session, tool, allow/deny, source) — there
  was previously no server-side record of how a request was answered.
- A remote allowlist is never applied automatically; every divergence is shown to the user as an
  explicit added/removed diff before anything changes.
- Divergence is detected as a set difference between local and remote entries, not by comparing
  `updatedAt` — a fresh machine's empty list is otherwise "newer" than a populated cloud row and
  would silently erase it.
- Pushing the local list to storage is suppressed while a review is pending, so the push itself
  can't destroy the state being reviewed.
- Rejecting a review keeps the local list, remembers the rejection keyed on the remote's
  *content* (so the same proposal is never re-asked), and pushes the local list back over the
  remote row.
- `ALWAYS_ASK_TOOLS` (`AskUserQuestion`, `ExitPlanMode`) can never be allowlisted — the guard
  checks that set before consulting the allowlist at all, so such an entry would be a UI lie
  about what it does.
- A hand-typed Bash prefix is whitespace-collapsed the same way a permission card's prefix is,
  and may not contain `&`, `&&`, `||`, `;`, or `|` — those are exactly the operators
  `assessToolCall` splits a command on.
- Non-Bash entries never carry a `prefix`; one is silently dropped rather than rejected, matching
  the shape the guard's tool-name match actually compares.
- Plan-directory reads and writes (`~/.claude/plans/**` or `<cwd>/.claude/plans/**`)
  auto-approve in every permission mode.
- Credential paths (`~/.ssh`, `~/.aws`, `.env`) always escalate even if nested under a `plans`
  directory — the sensitive check runs before the plan check.
- Any other out-of-root file access is unaffected and still escalates.
- A `file` request (and by extension `tree`/`find`) can read any plan directory reachable from
  `isPlanPath`, not just the requesting session's own plan file — a deliberate widening of a
  route previously confined to project/session roots, scoped to plan directories only.
- A resolved plan card renders collapsed by default but is always reopenable — the plan markdown
  and Focus mode are never permanently hidden.
- Action buttons (`Approve plan & start`, `Keep planning`) never render once a request is
  resolved, in the inline card or the fullscreen modal — there is no live `requestId` left to
  answer.
- Fullscreen focus mode opens read-only for a resolved plan (just "Exit focus (Esc)").
- When the harness passes no inline `plan` argument, the card shows the turn's last plan-file
  write instead of rendering empty; an `Edit`-revised plan shows the final text, not the pre-edit
  version.
- A plan card whose only source is a plan file (no inline argument, and no same-turn write to
  stitch the text from) is still live: `hasPlan` is true whenever `planPath` is known, so the
  chevron and Focus button work and the live read supplies the text.
- Opening a plan card (expand or Focus) re-reads its plan file from disk; the resolved card's
  text is therefore live, not frozen at whatever was captured at approval time — a plan card
  genuinely reflects the most recent plan, even across several "keep planning" rounds in later
  turns.
- The resolution badge (`allowed`/`plan approved`, `denied`/`kept planning`, `expired`) wraps a
  `Tooltip` naming the resolution source (e.g. "resolved by recovery after an interrupted turn")
  whenever `resolvedBy` is present and not `'user'`; a plain click shows no tooltip. The badge
  label itself is unchanged.
- The `plan approved` badge was already not a record of what the SDK returned — the workflow
  plan-step gate records `resolution: 'allow'` and then denies the `ExitPlanMode` tool call so
  the step stays read-only. `resolvedBy: 'workflow-advance'` makes that legible in the tooltip
  instead of changing the behavior.
- The typed-reply deny only fires when `status === 'waiting-permission'`,
  `pendingPermissionTool === 'ExitPlanMode'`, and the typed text is non-empty; any other pending
  tool (e.g. `AskUserQuestion`, `Bash`) is left alone so it can't be collaterally denied.
- No attachments: the reason is `KEEP_PLANNING_MESSAGE` plus the user's raw text, and nothing
  else is queued — the deny reason is the whole turn.
- With attachments: the reason is `KEEP_PLANNING_MESSAGE` plus a note only (no raw text, since
  attachments can't ride a `tool_result`); the real text and attachments are queued separately
  and delivered as the next turn once the deny settles the busy query.
- The plan card's badge shows `kept planning` (not `denied`) for a denied `ExitPlanMode` request.
- A shared session's resolution badge additionally names *who* answered, when it was not the
  viewer: `resolvedActor` (see [session-collaboration](session-collaboration.md)) rides alongside
  `resolvedBy` on the same event, and a guest without `approvePermissions` sees the card
  read-only — "waiting for {owner} to approve" — instead of the action buttons.
- The card's two actions only relabel (to "Approve with comments (N)" / "Refine with comments
  (N)") and only send `planComments` when at least one comment is attached; with zero comments the
  wire message and the button labels are identical to before this feature existed.
- A plan comment is a `{ quote, note }` pair, never a character offset — the plan markdown
  re-renders on mount and the card re-reads the plan file from disk on every open, so an offset
  would drift while a stored excerpt does not.
- A plan-step gated by a workflow folds its comments into the gate's existing deny message and
  never interjects — the step's turn is ending so the workflow can advance, and a pushed message
  would land in a turn with nothing left to steer.
- Plan comments require the `prompt` capability in addition to `approvePermissions`, and are
  dropped outright for an actor with `promptNeedsApproval` — comments are a text channel to the
  model, which is what `prompt` (not `approvePermissions`) governs; the approve/deny decision
  itself is unaffected either way.
- A comment's `quote` is never editable from the UI, only its `note` — the quote is both the
  highlight's anchor and the record of what was actually selected; to comment on different text,
  select that text instead.
- A quote that no longer matches the live plan text (the agent has since rewritten that passage)
  silently drops its highlight; the comment itself is untouched in the list and still reaches the
  model on Approve/Refine.

## Architectural rules

- Single shared `PERMISSION_MODES` list — no component defines its own label/description array.
  Editing a label or description here changes every picker at once.
- Mantine `SegmentedControl` has no per-segment tooltip prop, so per-item tooltips are attached
  by wrapping each segment's `label` in a `Tooltip`-wrapped `span` (`display:block; width:100%`
  so the hover target fills the segment instead of shrinking to the text).
- `resolvedBy` is optional and every reader treats a missing value as `'user'` — the only source
  that existed for any card a user could have seen before this field was added.
- `resolvedActor` sits **alongside** `resolvedBy`, never folded into it: `resolvedBy` is
  provenance-of-*decision* (a user, a workflow advance, a recovery sweep), which is a different
  question from *which person* clicked. See
  [session-collaboration](session-collaboration.md#attribution).
- `findPermissionResolution` scans backwards (newest wins), matching the existing convention in
  `exitPlanRequestId`.
- The workflow plan-step gate's recorded `resolution: 'allow'` was already not a record of the
  SDK's tool result (the tool itself is denied so the step stays read-only);
  `resolvedBy: 'workflow-advance'` makes that legible rather than changing it.
- Guard validators live in `shared/types.ts`, not `server/src/autoGuard.ts`, so the web client
  runs the exact same rules before ever sending an entry to the bridge.
- The allowlist is synced through dedicated `addGuardAllow`/`removeGuardAllow`/
  `reviewGuardAllowlist` intent messages, not folded into the whole-blob `UserUiSettings` save —
  the bridge also writes entries on its own (permission cards), so a whole-blob client save would
  have an unbounded race window to clobber them.
- The web store never caches the allowlist in `localStorage`; it is server-authoritative and
  arrives on every `hello`, so a cached copy would be a stale second source of truth for a
  security-relevant list.
- Removing an entry has no confirmation modal — it only narrows what the guard allows, so it
  fails safe. Guarding the safe direction while leaving the risky one (add) unguarded would train
  the wrong reflex.
- The review modal is mounted at the app root, not inside the Settings modal, because the
  requirement is that the user is notified of a divergence, not that they happen to open
  Settings.
- `assessToolCall`'s self-worker-source check (`isSelfWorkerSource`, see
  [turn-recovery](turn-recovery.md)) runs *before* the blanket `{ tool: 'Edit' }`/
  `{ tool: 'Write' }` allowlist short-circuit — the first guard verdict an allowlist entry cannot
  disarm. Keep it ordered first if this function is refactored; moving it below the short-circuit
  would let a standing allowlist entry silently re-enable edits that kill the running worker.
- `isPlanPath` resolves the path (`path.resolve`) and anchors containment checks to real
  directories via `isInside`; it does not use the substring-based `isPlanFilePath`, so a crafted
  path like `.../plans/../../.ssh/id_rsa` cannot pass as a plan path. `isPlanFilePath` is only
  safe for transcript text scans, never for permission decisions.
- `PLAN_DIR_MARKER`/`isPlanFilePath` live in `shared/types.ts`, not `server/src/autoGuard.ts`,
  because the web client needs the same plan-path hint and cannot import from `server/`.
- `isInside` does not resolve symlinks — a symlink planted inside a plan directory pointing
  elsewhere would still be treated as safe. Accepted risk: the plan directory is
  agent-and-user-owned. The `file` handler inherits this same limitation since it reuses
  `isPlanPath` unchanged.
- Auto-approved plan writes stop producing a permission card but remain visible as `tool_use`
  blocks in the transcript; the auto-approval event itself is filtered from the UI, consistent
  with other auto-approved calls.
- `resolveWorkspacePath`, `workspaceRoots`, and `resolveWorkspaceParam` live in
  `server/src/workspacePaths.ts`, not `server/src/index.ts`, purely so they're importable by
  their own test — `index.ts` starts listening as a side effect of being imported.
- `~/.claude/plans` is per-OS-user, not per-app-user: with `AUTH_ENABLED`, every signed-in app
  user on the same machine shares that directory, so its plans are readable across app-user
  boundaries through this exception. Accepted for now; revisit if multi-user support becomes a
  near-term goal.
- The plan-file fallback is no longer purely transcript-local: `withPlanFileText` still builds
  `data.input.plan`/`planPath` from the transcript alone, but the rendered card layers a live
  filesystem read (`useFileContent` against `/file`) on top whenever it's open. The
  transcript-only text is the fallback shown before that fetch resolves or if it fails.
- The plan-file text tracking is turn-scoped for text stitching (`lastPlanWrite`) but the path
  also has a session-wide fallback (`sessionPlanWrite`, never reset) — only consulted when the
  turn-scoped write is absent, so it can't override a genuine same-turn write.
- `expanded` and `focus` (fullscreen) are independent pieces of state; resolving a request forces
  both closed via an effect keyed only on `resolution`, so manually re-expanding an
  already-resolved card does not get fought by that effect.
- The card's live read means a resolved card no longer necessarily shows the exact text the user
  approved — the "updated since approval" hint is the mitigation, not a guarantee of a faithful
  approval record.
- The typed-reply path picks the request id via a single backwards scan (same shape as
  `findPermissionRequest`/`findPermissionResolution`), preferring a live pending id whose
  transcript request is `ExitPlanMode`, else the newest unresolved one — never a bulk
  deny-everything-pending pass, so a concurrent unrelated permission card is never touched.
- It never emits a `user` transcript event or calls `prompt()` directly for the typed text on the
  no-attachments path — both would open a new turn boundary and corrupt turn-scoped bookkeeping
  (`collectTurns`, `permissionWaitMs`). [turn-interjection](turn-interjection.md) follows the same
  rule from the other direction: its release path is deliberately not routed through `prompt()`
  either, for the same reason.
- The wording of a commented plan decision lives solely in `formatPlanComments` — the two button
  labels, the interjected text, and the deny reason all derive from it, so the model-facing wording
  can never drift between the approve and refine paths.
- On a deny, the server always rebuilds `denyMessage` from the comments via `formatPlanComments`
  and discards whatever the client sent in that field — the wording is server-owned, never
  client-supplied, the same posture `resolvePermission` already took before comments existed.
- `pushIntoLiveTurn` is the exact `pushTurnSafely(..., { intoLiveTurn: true })` call
  `interjectQueued` used inline, extracted so the plan-comments approval path is a second caller
  rather than a duplicate of the `priority: 'next'` reasoning documented in
  [turn-interjection](turn-interjection.md).
- Plan-comment drafts follow the existing composer-draft `localStorage` pattern
  (`web/src/store.ts`) rather than a new persistence mechanism, keyed by session id and
  `requestId` so a draft never leaks onto a later, unrelated plan card.
- When `canInterject` is false, comments are staged through the same `meta.queued` shape
  `userPrompt` builds (not a bespoke queue entry), so `maybeFlush` delivers them as an ordinary
  next turn with no new delivery path to maintain.
- The highlight paint uses the CSS Custom Highlight API rather than DOM mutation
  (`<mark>`-wrapping matched text) specifically because the plan markdown re-renders on mount and
  on every live re-read of the plan file — a `Highlight`'s `Range`s live outside the DOM and need
  no cleanup or reconciliation across either re-render.

## Related decisions

- [turn-recovery](turn-recovery.md) — why auto-continue and card expiry both defer to an open
  `ALWAYS_ASK_TOOLS` card, and the `isSelfWorkerSource` guard ordering.
- [multi-root-projects](multi-root-projects.md) — whose `roots` replaced the single `cwd` the
  guard functions took.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — `collectTurns` reading a plan file from
  disk when reconstructing a step's deliverable.
- [agent-memory-sync](agent-memory-sync.md) — the one-blob-per-user storage precedent the
  allowlist sync follows.
- [session-collaboration](session-collaboration.md) — `resolvedActor`, and the
  `approvePermissions` capability that gates a guest's card to read-only.
- [turn-interjection](turn-interjection.md) — `waiting-permission` is excluded from Send now in
  v1 for the same open question this feature has never resolved: whether the CLI drains stdin
  while parked inside `canUseTool`.
- [mcp-connections](mcp-connections.md) — a second producer of `PermissionRequestData`
  (`elicitation` instead of a tool call), reusing this page's resolution machinery rather than
  building its own.

## On a codex session

Codex asks before it acts, and the request lands in **this** card, under this auto-guard, this
allowlist and this provenance. None of the decision logic was ever Claude-specific — only the
transport — so the approvals ride the RPC channel the worker already had rather than one of
their own.

Threads run `on-request` in every gated mode, and **what stops for approval is set by the
sandbox, not by the policy**. That split matters, and it was originally got wrong.

The first cut used `untrusted` — ask about everything — on the theory that the auto-guard would
silently approve the safe calls. It cannot: `isSafeReadOnly` gates on `READ_ONLY_TOOLS`
(`Read`/`Glob`/`Grep`/…) and every codex command arrives as `Bash`, so nothing was auto-approved
and a codex session raised a card for every `cat` and `rg`. Claude does not rely on the guard for
this either — measured, the same "cat package.json" prompt through the Claude SDK calls
`canUseTool` **zero** times, because the CLI classifies a read-only Bash command itself.

So the sandbox carries the gate instead:

| mode | sandbox | policy | effect |
| --- | --- | --- | --- |
| `default`, `auto`, `plan` | `read-only` | `on-request` | reads run; any write must escalate, and the escalation *is* the card |
| `acceptEdits` | `workspace-write` | `on-request` | the workspace was granted up front, so edits do not ask |
| `bypassPermissions` | `danger-full-access` | `never` | Lines' own handlers still see the call |

Measured against the live app-server on `gpt-5.6-luna`: `untrusted` + workspace-write produced 5
approval requests for 5 commands; `on-request` + read-only produced 0 for a read and 2 for a
write. `bypassPermissions` is safe *because* Lines is the gate — the sandbox is a second line,
not the only one, and the always-ask tools still stop.

### Plan mode is codex's own, not a prompt

The sandbox above is what stops a plan-mode turn writing. What makes it *plan* is separate:
codex's **collaboration mode**, a first-class preset selected per turn with `turn/start`'s
`collaborationMode: { mode: 'plan' | 'default', settings: {...} }`.

That field, and `collaborationMode/list` which discovers the presets, exist only for a client
that declares `experimentalApi` at `initialize`. Lines sent `capabilities: null` for the whole
first cut of this integration, so neither existed for it — and because
`codex app-server generate-ts` runs under the same handshake, neither appears in
`shared/codexProtocol` either. **The vendored types are a filtered view of the API, not the whole
of it**, which is the trap that cost this feature a working plan mode: the types looked like
proof that plan mode was not exposed.

An earlier cut therefore hand-wrote a `<collaboration_mode>Plan</collaboration_mode>` block and
passed it as `developerInstructions`, on the theory that codex's rule — a mode changes when
developer instructions carrying a different tag arrive — applied to any client text. It does not;
that governs codex's own *managed* instructions. Measured on one prompt:

| | questions | plan items |
| --- | --- | --- |
| hand-written tag | 0 | 0 |
| `collaborationMode: {mode:'plan'}` | 2 | 1 |

Real plan mode asks clarifying questions through `request_user_input`, stays read-only, and emits
a dedicated `plan` item. The tool grant and the plan contract live inside codex's managed Plan
instructions, and only the real mode gets them.

Two consequences worth knowing:

- **`reasoning_effort` must be a real value.** A `null` is taken literally rather than as "use the
  preset", and a plan turn sent with null asks nothing and emits no plan item — plan mode in name
  only. The worker fills it from `collaborationMode/list` (Plan reports `medium`) so the value
  stays OpenAI's; `applyModePreset` in `workerCodex.ts`.
- **The mode is sent on every turn, including ordinary ones.** Codex's mode persists until a
  different one replaces it and a resumed thread carries its history, so a session that planned
  once would otherwise refuse to edit for the rest of its life.

`codexExperimental.contract.test.ts` guards the part `generate-ts` cannot describe: it spawns the
installed binary and asserts a Plan mode is still listed. Verified that regeneration cannot close
this gap — the experimental surface is absent from the output with and without
`--enable collaboration_modes`.

`acceptForSession` is deliberately never sent. Lines keeps its own allowlist, and asking codex
to remember a second copy would split one decision across two stores that cannot be kept in step
and that the user can only see one of. See [openai-codex-sessions](openai-codex-sessions.md).
