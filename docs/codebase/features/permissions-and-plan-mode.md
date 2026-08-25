# Permissions and plan mode

Covers: `permission-mode-selector`, `permission-resolution-provenance`, `guard-allowlist`,
`plan-file-auto-approve`, `plan-review-card`, `plan-reply-keeps-planning`.

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

## Files

- `shared/types.ts` — `PermissionMode` type (`default` | `auto` | `acceptEdits` | `plan` |
  `bypassPermissions`); `PermissionResolutionSource`, `PermissionRequestData.resolvedBy`;
  guard entry/blob/review types, `normalizeAllowEntry` and the other validators, the
  `addGuardAllow`/`removeGuardAllow`/`reviewGuardAllowlist` and
  `guardAllowlist`/`guardAllowlistReview` wire messages; `PLAN_DIR_MARKER`, `isPlanFilePath`;
  `PermissionRequestData.denyMessage`, `KEEP_PLANNING_MESSAGE`
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
  `recoverOrphanedPermission`
- `server/src/autoGuard.ts` — `GuardAllowlist` (CRUD, load-time migration, the review
  lifecycle); re-exports `ALWAYS_ASK_TOOLS`/`GuardAllowEntry` from `shared/types.ts` for
  existing importers; `isPlanPath` (exported), `isSafeReadOnly`, `isSafePlanWrite`,
  `assessToolCall`
- `server/src/store.ts` — `GuardSyncState`, `loadGuardSync`/`saveGuardSync`
  (`guard-allowlist-sync.json`, separate from the bare-array `guard-allowlist.json`)
- `server/src/sync.ts` — `pushGuardAllowlist`, the isolated `/guard-allowlist` pull
- `server/src/userContext.ts` — wires `guard.onChange`/`guard.onReview` to broadcast + push, and
  calls `reviewRemote` before the push block in `syncNow`
- `server/src/index.ts` — `hello` fields, the three guard message cases
- `server/src/workspacePaths.ts` — `resolveWorkspacePath`, `workspaceRoots` (the
  `file`/`tree`/`find` root gate; its plan-directory exception is `isPlanPath`)
- `storage/prisma/schema.prisma`, `storage/src/index.ts` — the `guard_allowlist` table and its
  `GET`/`PUT /guard-allowlist` endpoints
- `web/src/store.ts` — `guardAllowlist`/`guardReview` state, actions, message cases
- `web/src/components/GuardAllowlistSection.tsx`,
  `web/src/components/GuardAllowlistReviewModal.tsx`, `web/src/lib/guardEntries.ts`
- `web/src/lib/transcript.ts` — carries `resolvedBy` from the resolution event onto the merged
  transcript item; `buildTranscript` (`permission` case), `withPlanFileText`; the permission-card
  merge copies `denyMessage` onto the resolved card
- `web/src/components/PermissionPrompt.tsx` — `ResolutionBadge`, `SOURCE_NOTE`, `PlanApproval`
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
  attachments/no-attachments reason-text branches.
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
  (`collectTurns`, `permissionWaitMs`).

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
