# Permissions and plan mode

Covers: `permission-mode-selector`, `permission-resolution-provenance`, `guard-allowlist`,
`plan-file-auto-approve`, `plan-mode-reads`, `plan-mode-write-rejection`, `plan-review-card`,
`plan-reply-keeps-planning`, `plan-comments`.

## Purpose

Everything that decides whether a tool call runs, who decided it, and how plan mode's
deliverable is written and reviewed.

- **Mode selector** — pick how much a session or workflow step's tool calls are gated by the
  permission guard. The shared list holds five modes and their descriptions; the composer/settings
  segmented controls show three of them (Plan, Assist, Full Auto) as an escalating scale, while the
  workflow step editor/library `Select`s still offer all five.
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
- **Plan-mode reads** — auto-approve every observation call in plan mode, not just file reads:
  read-only `Bash`, `WebFetch`/`WebSearch`, subagent/skill calls, and read-shaped MCP tools all
  run without a card, so a research-heavy plan step doesn't stop for allow/deny on every `ls`,
  `grep`, or `Agent` call the way it did before.
- **Plan-mode write rejection** — an opt-in setting that, instead of raising a card, denies
  outright any plan-mode call that the read allowlist above didn't already approve — an edit, a
  writing shell command, a Lines workflow write. The agent gets a deny message telling it to stay
  read-only and keeps researching instead of stalling on an unanswered card.
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
- Any tool call at all while a session sits in `plan` mode — `PreToolUse` and `canUseTool` both
  run `isSafePlanModeRead` first, and, when the "Auto-reject writes in plan mode" setting is on,
  deny whatever it didn't approve
- Settings modal, Sessions pane — the "Auto-reject writes in plan mode" `Switch`, next to the
  plan-effort select
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
  `PermissionRequestData.denyMessage`, `KEEP_PLANNING_MESSAGE`, `PLAN_REPLY_MARKER`,
  `keepPlanningReason`; `PlanComment`, `normalizePlanComments`, `planCommentsBody`,
  `formatPlanComments`; `ClientMessage.permissionResponse.planComments`;
  `PermissionResolutionSource` (`'plan-readonly'`); `PLAN_MODE_REJECT_MESSAGE`;
  `UserUiSettings.planModeRejectWrites`
- `web/src/lib/permissionModes.tsx` — shared mode list, segmented-control data, dropdown render
  helper
- `web/src/lib/modelSelect.tsx` — `renderOptionWithDescription` (label + dimmed description
  renderer, shared with the model selector), `modelComboboxProps` (popover widener, shared)
- `web/src/components/Composer.tsx`, `web/src/components/SessionsSection.tsx`
- `web/src/components/workflow/StepLibrary.tsx`
- `web/src/components/workflow/StepCard.tsx` — also shows the collapsed step's mode label
- `server/src/sessions.ts` — `'auto'` runs the SDK in `acceptEdits` while the bridge guard
  approves/prompts per tool call; all resolution sites, `hasUnresolvedAlwaysAsk`,
  `unresolvedPermissions`, `findPermissionResolution`; `handlePreToolUse`, `handleCanUseTool`,
  `collectTurns`; `resolvePermission`'s "Always allow" branch; `planReplyDecision`, `userPrompt`,
  `recoverOrphanedPermission`; `pushIntoLiveTurn` (extracted from `interjectQueued`, see
  [turn-interjection](turn-interjection.md)); `resolvePermission`'s `planComments` handling
  (gate branch, allow+interject, deny wording, queue fallback); `takeQueuedPlanReply` (beside
  `takeQueuedText`) — the button's queue fold into a keep-planning deny
- `server/src/autoGuard.ts` — `GuardAllowlist` (CRUD, load-time migration, the review
  lifecycle); re-exports `ALWAYS_ASK_TOOLS`/`GuardAllowEntry` from `shared/types.ts` for
  existing importers; `isPlanPath` (exported), `isSafeReadOnly`, `isSafePlanWrite`,
  `assessToolCall`; `isReadOnlyBash`, `READ_ONLY_COMMANDS`, `READ_ONLY_ARG_RULES`,
  `isSafePlanModeRead`, `PLAN_MODE_READ_TOOLS`
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
- `web/src/store.ts` — `planModeRejectWrites` state, `setPlanModeRejectWrites`, the
  `lines.planModeRejectWrites` `localStorage` cache and the settings save/hello-merge sync sites

## Symbols

- `PERMISSION_MODES` — `{ value, label, description }[]`, single source of truth for all five
  pickers; all five entries stay in it even though only three appear as pills
- `PERMISSION_MODE_SEGMENTS` — a subset of `PERMISSION_MODES` (`plan`, `auto`, `bypassPermissions`,
  in that order — an escalating scale, not `PERMISSION_MODES`' own order) mapped to Mantine
  `SegmentedControl` data, each label wrapped in a `Tooltip` showing the description
- `permissionModeLabel()` — label lookup by value, raw value fallback (used by the collapsed
  step card)
- `renderPermissionModeOption` — alias of `renderOptionWithDescription`, used as the workflow
  Select's `renderOption`
- `PermissionResolutionSource` — `'user' | 'plan-reply' | 'auto' | 'plan-readonly' | 'recovery' |
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
- `isReadOnlyBash(command)` — fail-closed allowlist classifier for a `Bash` command: parses quotes
  and shell operators itself (no shelling out), rejects any redirect/substitution/heredoc/background
  job it can't prove targets `/dev/null` or is a pure fd duplication, splits the rest on
  `&& || ; |` and newlines, and requires every resulting segment's first word to be in
  `READ_ONLY_COMMANDS` or pass that command's entry in `READ_ONLY_ARG_RULES` (`git`, `find`,
  `sed`, `awk`, `tsc`/`npx tsc`, `sort`, `tree`, `diff`, `uniq`, `rg`, `file`, `env`, `hostname`,
  `date`). `BASH_RULES` still runs on top, so a credential/destruction rule always wins over the
  allowlist
- `isSafePlanModeRead(toolName, input, roots, allowlist)` — the plan-mode gate: `false` for
  `ALWAYS_ASK_TOOLS`; else `true` for `isSafeReadOnly`, a `Bash` command `isReadOnlyBash` accepts,
  a `PLAN_MODE_READ_TOOLS` member (`WebFetch`, `WebSearch`, `Agent`, `Task`, `Skill`,
  `ToolSearch`, the `Task*` todo tools), or an `mcp__*` tool whose own name (after the
  `mcp__<server>__` prefix) *starts with* a read verb (`read`/`list`/`get`/`search`/`view`) — an
  anchored check, unlike auto mode's looser substring match, so a write like
  `submit_diff_review` (contains "view") is not mistaken for a read
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
- `PLAN_REPLY_MARKER` — the `"The user's message:\n"` marker separating that prefix from the
  user's own words; exported so `planReplyText` slices on it instead of re-declaring the literal
- `keepPlanningReason(body)` — `KEEP_PLANNING_MESSAGE` + `PLAN_REPLY_MARKER` + `body`; the single
  builder of a keep-planning deny reason, called by `planReplyDecision`, `formatPlanComments`'s
  `'refine'` arm, and `resolvePermission`'s queue fold
- `planCommentsBody(comments)` — the numbered `1. On "quote": note` list, with no surrounding
  wording; `formatPlanComments` and `resolvePermission`'s queue fold both build on it
- `takeQueuedPlanReply(meta, actor?)` — pulls the leading run of queue items authored by `actor`
  into a keep-planning deny (see [Data flow](#keep-planning-button-folds-the-queue)); leaves a
  paused queue or a foreign-authored row untouched, and keeps an attachments row in place with
  its text stripped
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
  lives; `'refine'` is `keepPlanningReason(planCommentsBody(comments))`, `'approve'` states the
  count and applies-not-replaces framing over the same `planCommentsBody`
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
controls use `PERMISSION_MODE_SEGMENTS`, a three-item subset (Plan, Assist, Full Auto) in its own
order; the workflow Selects use the full `PERMISSION_MODES` (all five, its own order) +
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
Without those branches `bypassPermissions` ("Full Auto") behaved exactly like `default` ("Manual").
`buildQueryOptions` also passes `allowDangerouslySkipPermissions: true` unconditionally — the SDK
requires it before it will accept the mode at all, and setting it at spawn is what lets a
*mid-session* switch to `bypassPermissions` take effect on the running query instead of being
rejected into a `worker.ts` `console.warn`.

### Resolution provenance

`handlePreToolUse` returns an explicit `permissionDecision: 'ask'` for any `ALWAYS_ASK_TOOLS`
call, in every permission mode, instead of merely skipping its own auto-allow branch — a bare
`continue: true` would let `bypassPermissions` (whose own branch sits right below it) or a
`settings.json` `permissions.allow` entry resolve the tool before `canUseTool` runs at all. That
explicit `'ask'` is the only thing keeping plan approval and clarifying questions in front of a
human under `bypassPermissions` ("Full Auto"). The same hook mirrors a model-initiated
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
`isSafeReadOnly(...) || isSafePlanWrite(...) || (permissionMode === 'plan' && isSafePlanModeRead(...))`
→ if any is true, auto-approve (same `resolution: 'allow', auto: true` transcript event and
`permissionDecision: 'allow'` / `{ behavior: 'allow' }` return used by the existing
observation-only path) instead of prompting. The `isSafePlanModeRead` branch is plan-mode only and
skipped for a codex session (`isCodexSession`) — codex's own plan mode is already a read-only
sandbox, so anything reaching these handlers there is an escalation the sandbox couldn't satisfy,
and should stay the user's call rather than being auto-approved as if it were an ordinary read.

Separately, `resolveWorkspacePath` (used by the `file`, `tree`, and `find` request routes) first
checks the requested path against every project root and session cwd; if that fails, it
additionally allows the path when `isPlanPath` holds for any of the user's session cwds (which
also covers the cwd-independent `~/.claude/plans`). Everything downstream of that resolve — the
`MAX_FILE_BYTES` cap, binary rejection, auth — is unchanged; `tree` and `find` inherit the same
widening since they share the same resolver.

### Plan-mode write rejection

With `UserUiSettings.planModeRejectWrites === true`, a plan-mode call that the read-only branch
above didn't approve is denied automatically instead of parking on a card. The check lives in
*both* permission handlers, not only `canUseTool`:

- `handlePreToolUse` checks it right after the read-allow branch, skipping `ALWAYS_ASK_TOOLS` and
  `EnterPlanMode` (denying the very call that just mirrored the session into plan mode would leave
  `meta.permissionMode` out of step with the CLI). It returns `permissionDecision: 'deny'` with
  `PLAN_MODE_REJECT_MESSAGE` as the reason, and records the rejection via `recordAutoDeny` (the
  deny twin of `recordAutoAllow`, skipped on a resend the same way).
- `handleCanUseTool` repeats the same check as a fail-closed backstop, placed after the Lines-MCP
  read-allow branch so a Lines *write* (`save_step`, `update_workflow`, …) is rejected too — plan
  mode is read-only, and a saved workflow outlives the session and is visible to other users.

The hook check exists because a `settings.json` `permissions.allow` entry (e.g. `Bash(npm:*)`)
resolves *before* `canUseTool` ever runs — the same reasoning that already put the
`ALWAYS_ASK_TOOLS` 'ask' branch in the hook rather than relying on `canUseTool` alone.

`recordAutoDeny` writes `resolution: 'deny', auto: true, resolvedBy: 'plan-readonly', denyMessage:
PLAN_MODE_REJECT_MESSAGE` to the transcript, so the rejection is visible there exactly like every
other resolution, distinct from a human-clicked deny.

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
reason built by `keepPlanningReason(text)` — `KEEP_PLANNING_MESSAGE` plus the `PLAN_REPLY_MARKER`
prefix around the user's text. `resolvePermission` (and `recoverOrphanedPermission`, for the case
where the original query already died) persist `denyMessage` on the `permission` resolution
event. A restart-resend of the same request replays that persisted `denyMessage` instead of a
generic denial string. The web transcript merge copies `denyMessage` from the resolution event
onto the existing card, and `PlanApproval` shows it as a quoted reply under a `kept planning`
badge (`planReplyText` slices the message on the exported `PLAN_REPLY_MARKER` constant, rather
than a re-declared copy of the literal).

`keepPlanningReason` and `planCommentsBody` (both in `shared/types.ts`) are the single builder and
single body-formatter every keep-planning deny goes through — the typed-composer path above, the
"Refine with comments" path (`formatPlanComments(..., 'refine')`, now `keepPlanningReason(planCommentsBody(comments))`),
and the button's queue fold (`takeQueuedPlanReply`, next section) all call them rather than each
assembling the wording inline.

### Keep planning (button) folds the queue

The button's deny (`source: 'user'`) reaches the *same* stranding the typed-reply's attachments
branch does: a keep-planning deny is a `tool_result` answered inside the live turn, never a turn
boundary, so `maybeFlush` — which only fires once the session settles to `idle`/`done`/`error` —
never opens on it. A message queued before the card appeared (typed while the turn was merely
`running`) would otherwise sit stranded until the plan is finally approved and the whole turn
completes.

`resolvePermission` closes that gap by calling `takeQueuedPlanReply(meta, actor)` before building
the deny reason, whenever the resolved request is `ExitPlanMode`, the answer is a deny, and
`source === 'user'` (a button click or any other user-sourced deny — not `'plan-reply'`, which
already carries its own text, and not the workflow plan-step gate, which only denies on an
*allow*). `takeQueuedPlanReply`:

- Returns `[]` immediately for an empty or `queuePaused` queue — a paused queue is a guest's
  prompt held for the owner and is never auto-released by someone else's click.
- Walks the queue from the head, folding text from the leading run whose `item.actor?.userId`
  matches the clicker's (`undefined` on both sides means the machine owner) — the same comparison
  `editQueued` already uses. The first foreign-authored item stops the walk, so a collaborator's
  queued words are never re-attributed to whoever clicked, and a guest's row is never released by
  the owner's click.
- An item with attachments has its `text` folded but its row kept (with `mentions`/`draft`
  cleared) rather than removed, since attachments can't ride a `tool_result` either; that row
  still delivers in its place once the turn does settle. The walk stops there.
- Calls `upsert` before returning whenever it changed anything, so no client ever renders a queue
  row the model has already been handed.

`resolvePermission` joins `planCommentsBody(comments)` and the folded text (in that order) into
one `keepPlanningReason(...)` body. An empty queue and no comments leaves `denyMessage` exactly as
the caller passed it — the identity path every existing deny assertion (including the codex bare-
deny branch in `reviewCodexPlan`) depends on.

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
  `assessToolCall` cases; `isReadOnlyBash` table tests built from real transcript samples (compound
  but read-only commands allowed; writes, execution, substitutions, heredocs, and credential paths
  rejected, including the sort/tree/diff/git-branch/git-tag/env flag traps); `isSafePlanModeRead`
  (`ExitPlanMode`/`AskUserQuestion` false; `WebFetch`/`Agent`/`Skill` true; an `mcp__x__list_things`
  tool true and `mcp__x__create_thing`/`mcp__x__submit_diff_review` false; a `Read` of
  `~/.ssh/id_rsa` false; an in-project `Edit` false).
- `server/src/sessions.permission.test.ts` — `resolvedBy` stamped per source; a duplicate
  resolution is a no-op; `findPermissionResolution` returns the newest answer; resend replay
  re-asks a synthesized allow but replays a user/plan-reply one (and a legacy resolution with no
  `resolvedBy`); a `bypassPermissions` session resolves `Bash` straight to `allow` with no card
  and no `waiting-permission`, while `ExitPlanMode` still parks; `EnterPlanMode` mirrors
  `meta.permissionMode`; a plan-mode session resolves a read-only `Bash` call to `allow` with no
  card while a writing `Bash` command, an in-project `Edit`, and `ExitPlanMode` all still park, and
  the same read-only `Bash` still parks in `default` mode; with `planModeRejectWrites: true`, a
  plan-mode `Edit` resolves `deny` with `resolvedBy: 'plan-readonly'` and no card, a writing `Bash`
  command is denied while a read-only one is still allowed, `ExitPlanMode`/`AskUserQuestion` still
  park, a Lines MCP write (`save_step`) is denied, the setting has no effect outside plan mode, and
  leaving it off (or its default) still parks a plan-mode `Edit` as before; a hook-level test
  asserts `handlePreToolUse` itself returns `permissionDecision: 'deny'` for a plan-mode `Edit`
  with the setting on; `planReplyDecision`
  fall-through conditions, request-id selection (live vs. transcript-scan fallback), and the
  attachments/no-attachments reason-text branches; `normalizePlanComments` (empty-note drop,
  truncation, cap) and `formatPlanComments` (the refine wording still contains
  `KEEP_PLANNING_MESSAGE` and the marker `planReplyText` parses); approve-with-comments resolves
  `allow`/`resolvedBy: 'user'` with a matching `'interject'` transcript event; comments on an
  approval whose turn cannot be steered land in the queue instead of being dropped;
  refine-with-comments produces a `deny` whose `denyMessage` is server-built from the comments,
  never the client's; a workflow plan-step gate with comments still resolves
  `resolvedBy: 'workflow-advance'` with no `'interject'` event, the comments folded into the gate's
  deny message instead; an empty comment list resolves exactly as before this feature existed; a
  button Keep planning with one queued message produces a `denyMessage` byte-identical to the
  same text typed at the card; several queued messages fold in order; comments and a queued
  message compose into one `keepPlanningReason` body; an empty queue leaves `denyMessage`
  byte-identical to before this fold existed; a `'plan-reply'` deny does not also eat the queue;
  a paused queue is never released by the button; the folded text is persisted on the resolution
  event so Retry re-sends it.
- `server/src/sessions.queue.test.ts` — `takeQueuedPlanReply` mechanics: a single text-only item
  folded and its row removed; several items folded in order; a paused queue yields `[]` and is
  left untouched; a foreign-authored item stops the walk and the FIFO order past it is preserved;
  an unattributed item is treated as the machine owner's; an attachments-bearing item keeps its
  row with `text`/`mentions`/`draft` cleared and stops the walk there; an attachment-only row (no
  text) is left completely alone; an empty queue folds to nothing.
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

- All five `PermissionMode` values stay in `PERMISSION_MODES` and selectable in the workflow step
  `Select`s, including `acceptEdits` — preset workflows (`web/src/lib/workflowPresets.ts`,
  `server/src/workflows.ts`) ship steps with `permissionMode: 'acceptEdits'`, so dropping it from
  the option list would blank those Selects. `default` and `acceptEdits` have no pill in the
  composer/settings segmented controls, which only show Plan, Assist, and Full Auto.
- `default` displays as **Manual** — the stored value is unchanged, only the label differs — for
  the workflow step badge (`permissionModeLabel`) and any session outside the three pill values.
- The shipped new-session default is `'auto'` ("Assist"), and a session lands on `'auto'` (not
  `'default'`) after a plan is approved, on every path that used to reset it to `'default'`: the
  normal `ExitPlanMode` approval, the interrupted-approval workflow-step resume, and the
  loop-guard exit path. All three go through `setPermissionMode` rather than a bare meta write, so
  the worker is told (`worker.setPermissionMode`) instead of only the stored meta changing.
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
- The plan-mode read allowlist is fail-closed: an unrecognised `Bash` command, tool, or MCP name
  always still prompts (or, with the reject-writes setting, is denied) rather than being guessed
  safe. Redirects, command/process substitution, heredocs, background jobs, and interpreters
  (`python`, `node`, …) always fail the classifier and never auto-approve.
- `BASH_RULES` (the deny-list) is still evaluated over a command `isReadOnlyBash` would otherwise
  allow, so a credential-access or destructive-command rule always wins over the read allowlist.
- Out-of-root/credential file reads still escalate under `isSafePlanModeRead` exactly as they do
  under `isSafeReadOnly` — the plan-mode read widening only adds `Bash`, network, subagent/skill,
  and MCP-read coverage; it does not loosen the file-tool path check. `cd /other/repo && ls`
  through `Bash` does pass, though, which is a deliberate inconsistency with the `Read` tool:
  listing a directory isn't secret-bearing, and `cat ~/.ssh/*` still hits `BASH_RULES`.
- The plan-mode read branch is skipped entirely for a codex session (`isCodexSession`); its plan
  mode already runs inside a read-only sandbox, so anything reaching this branch is already an
  escalation the sandbox couldn't satisfy, and shouldn't be waved through as an ordinary read.
- `planModeRejectWrites` (`UserUiSettings`) is off unless explicitly `true`, global, and read fresh
  on every call — nothing about it is cached on the session. It never touches `ALWAYS_ASK_TOOLS`
  (`ExitPlanMode`/`AskUserQuestion` always still park) or `EnterPlanMode` itself.
- With `planModeRejectWrites` on, a Lines MCP write (e.g. `save_step`) is denied exactly like any
  other plan-mode write — plan mode shouldn't change a saved workflow regardless of the setting's
  usual "shell/file write" framing.
- An auto-deny (`resolvedBy: 'plan-readonly'`) stays visible in the transcript: `isRedundant` hides
  an auto item only when it resolved `allow`, so the user can see what plan mode rejected instead
  of every auto-approved read *and* every auto-denied write disappearing the same way.
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
  attachments can't ride a `tool_result`); the real text and attachments are queued separately.
  A keep-planning deny is answered as a `tool_result` inside the *live* turn — it does not end
  the turn or emit an SDK `result` — so `maybeFlush` does not open on it; the queued item is
  only delivered once the turn genuinely settles (`idle`/`done`/`error`), which on a plan can be
  several "keep planning" rounds and the eventual approval later, not "as soon as the deny is
  sent".
- **Keep planning (button) folds the queue into the same deny reason** (`takeQueuedPlanReply`):
  because that deny never settles the turn either, a message queued before the card appeared
  would otherwise be stranded until final approval, with removing and retyping it as the only
  workaround. The click walks the queue from the head and folds the leading run authored by the
  clicker (`item.actor?.userId === actor?.userId`, matching `editQueued`'s author check) into
  `keepPlanningReason(...)`, stopping at the first foreign-authored row so a collaborator's words
  are never re-attributed to the clicker. A paused queue (a guest's prompt held for the owner) is
  never folded. A folded item with attachments keeps its row — attachments can't ride the deny
  either — with its `text`/`mentions`/`draft` cleared, so it still delivers in order once the
  plan is approved; the walk stops there. `resolvePermission` composes one `keepPlanningReason`
  body from `planCommentsBody(comments)` plus the folded text, in that order, before emitting the
  resolution event, so `PlanReply` and Retry read the same combined text. Only a `source: 'user'`
  deny on `ExitPlanMode` folds the queue — `'plan-reply'` already carries its own text, and the
  workflow plan-step gate only fires on an allow.
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
  Editing a label or description here changes every picker at once, though `PERMISSION_MODE_SEGMENTS`
  only exposes a three-item, independently-ordered subset (`plan`, `auto`, `bypassPermissions`) of
  it — built by mapping over that subset list, not by filtering `PERMISSION_MODES`, so the pill
  order can differ from the Selects' order. `SEGMENT_MODES` (the plain `PermissionMode[]` behind
  that mapping) is exported too, so the phone composer's mode `Menu`
  ([mobile-client](mobile-client.md)) offers the exact same three modes in the same order without
  a second hand-written list.
- Mantine `SegmentedControl` has no per-segment tooltip prop, so per-item tooltips are attached
  by wrapping each segment's `label` in a `Tooltip`-wrapped `span` (`display:block; width:100%`
  so the hover target fills the segment instead of shrinking to the text). The composer's
  control-level `Tooltip` (wrapping the whole `SegmentedControl`) only renders when the session is
  disabled (a Codex session, explaining the reduced surface) — a generic "how calls are approved"
  tooltip on top of it would fight the per-pill ones.
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
- The keep-planning wording itself has exactly one builder: `keepPlanningReason` (paired with
  `PLAN_REPLY_MARKER`), in `shared/types.ts` so it is the same function `server/` calls to build a
  deny and `web/` (`planReplyText`) parses to render one back — build and parse can never drift
  across the three packages the way two independently-written string templates eventually would.
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

A user can now choose plan mode's effort directly, as a global setting distinct from a session's
own — mirroring codex's own `plan_mode_reasoning_effort` config key, and applying to a Claude
session's plan turns the same way. See [reasoning-effort-selection](reasoning-effort-selection.md).
