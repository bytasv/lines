# Plan-file auto-approve

## Purpose

Lets plan mode's deliverable — a Markdown file under a `.claude/plans/` directory —
get written, edited, and re-read without a permission card on every call, even
though the file lives outside the session `cwd` (which the guard otherwise
escalates as "file access outside the working directory"). `isPlanPath` is also
exported and reused by the bridge's `/file` HTTP route, so the
[plan review card](plan-review-card.md) can read a plan file live even though it
lives outside every project/session root.

## Entry points

- `Read`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit` tool calls targeting a plan file,
  arriving via `PreToolUse` and `canUseTool`.
- `GET /file?path=...` on the bridge HTTP server, when the resolved path falls
  outside every project/session root but inside a plan directory.

## Important files

- `shared/types.ts` — `PLAN_DIR_MARKER`, `isPlanFilePath` (the cheap substring-based
  hint, shared with the web client — see [plan-review-card](plan-review-card.md))
- `server/src/autoGuard.ts` — `isPlanPath` (exported), `isSafeReadOnly`,
  `isSafePlanWrite`, `assessToolCall`
- `server/src/sessions.ts` — `handlePreToolUse`, `handleCanUseTool`, `collectTurns`
  (uses the shared `isPlanFilePath` for transcript plan-text extraction, and reads a
  plan file from disk via `isPlanPath`-gated `readPlanFile` when reconstructing a
  workflow step's deliverable — see
  [workflow-step-output-consolidation](workflow-step-output-consolidation.md))
- `server/src/workspacePaths.ts` — `resolveWorkspacePath`, `workspaceRoots` (the
  `/file`/`/tree`/`/find` root gate; its plan-directory exception is `isPlanPath`)

## Important symbols

- `isPlanPath(filePath, roots)` — true when the resolved path is inside
  `~/.claude/plans` or `<root>/.claude/plans` for any of `roots`; the actual
  permission-escalation guard, anchored to real directories (see architectural
  rules). Exported so both the guard and `resolveWorkspacePath` share one
  containment check.
- `isPlanFilePath(filePath)` — shared, cheap substring check (`.claude/plans/` in
  the normalized path); a hint only, used where a resolved path isn't available
  (transcript scans on both server and web)
- `isSafeReadOnly(toolName, input, roots, allowlist)` — observation-only calls
  (`Read`, `Glob`, `Grep`, ...); now also true for plan-file reads outside `auto` mode
- `isSafePlanWrite(toolName, input, roots)` — true for `Write`/`Edit`/`MultiEdit`/
  `NotebookEdit` targeting a plan path
- `assessToolCall(toolName, input, roots, allowlist)` — the shared guard verdict
  function; plan paths short-circuit to non-dangerous inside its out-of-root
  branch. Takes every root a session may work in (see
  [multi-root-projects](multi-root-projects.md)), not a single `cwd`.
- `resolveWorkspacePath(ctx, raw)` — `/file`/`/tree`/`/find`'s path resolver; falls
  back to `isPlanPath(abs, ctx.sessions.list().map(cwd))` when the project/session
  root check fails

## Data flow

`handlePreToolUse`/`handleCanUseTool` check, outside `auto` permission mode:
`isSafeReadOnly(...) || isSafePlanWrite(...)` → if either is true, auto-approve
(same `resolution: 'allow', auto: true` transcript event and `permissionDecision:
'allow'` / `{ behavior: 'allow' }` return used by the existing observation-only
path) instead of prompting.

Separately, `resolveWorkspacePath` (used by the `/file`, `/tree`, and `/find` HTTP
routes) first checks the requested path against every project root and session
cwd; if that fails, it additionally allows the path when `isPlanPath` holds for any
of the user's session cwds (which also covers the cwd-independent
`~/.claude/plans`). Everything downstream of that resolve — the `MAX_FILE_BYTES`
cap, binary rejection, `?token=` auth — is unchanged; `/tree` and `/find` inherit
the same widening since they share the same resolver.

## Dependencies

Builds entirely on the pre-existing `isInside` path-containment helper and the
out-of-cwd branch in `assessToolCall`; no new state or message type. The `/file`
route's use is a second caller of the same exported `isPlanPath`, not a parallel
check.

## Tests

- `server/src/autoGuard.plan.test.ts` — `isPlanPath` containment (home plans dir,
  `<cwd>/.claude/plans`, out-of-tree paths, and the classic
  `.../plans/../../../.ssh/id_rsa` traversal), plus the pre-existing
  `isSafeReadOnly`/`isSafePlanWrite`/`assessToolCall` cases.
- `server/src/index.planFile.test.ts` — `resolveWorkspacePath` accepting a
  home-plans path and a project-local plans path, and still rejecting an
  arbitrary out-of-root path and plan-dir traversal.

## Business rules

- Plan-directory reads and writes (`~/.claude/plans/**` or `<cwd>/.claude/plans/**`)
  auto-approve in every permission mode.
- `ExitPlanMode` and `AskUserQuestion` always still prompt the user
  (`ALWAYS_ASK_TOOLS`), regardless of the target path. `handlePreToolUse` enforces
  this with an explicit `permissionDecision: 'ask'` rather than merely omitting an
  auto-allow, so a session running in `bypassPermissions` (a valid step mode) or a
  user-tier `settings.json` `permissions.allow` entry cannot resolve the tool
  before `canUseTool` ever runs — see
  [permission-resolution-provenance](permission-resolution-provenance.md).
- Credential paths (`~/.ssh`, `~/.aws`, `.env`) always escalate even if nested
  under a `plans` directory — the sensitive check runs before the plan check.
- Any other out-of-cwd file access is unaffected and still escalates.
- `/file` (and by extension `/tree`/`/find`) can now read any plan directory
  reachable from `isPlanPath`, not just the requesting session's own plan file —
  a deliberate widening of a route previously confined to project/session roots,
  scoped to plan directories only.

## Architectural rules

- `isPlanPath` resolves the path (`path.resolve`) and anchors containment checks to
  real directories via `isInside`; it does not use the substring-based
  `isPlanFilePath`, so a crafted path like `.../plans/../../.ssh/id_rsa` cannot
  pass as a plan path. `isPlanFilePath` is only safe for transcript text scans,
  never for permission decisions.
- `PLAN_DIR_MARKER`/`isPlanFilePath` live in `shared/types.ts`, not
  `server/src/autoGuard.ts`, because the web client needs the same plan-path hint
  and cannot import from `server/`.
- `isInside` does not resolve symlinks — a symlink planted inside a plan directory
  pointing elsewhere would still be treated as safe. Accepted risk: the plan
  directory is agent-and-user-owned. The `/file` route inherits this same
  limitation since it reuses `isPlanPath` unchanged.
- Auto-approved plan writes stop producing a permission card but remain visible as
  `tool_use` blocks in the transcript; the auto-approval event itself is filtered
  from the UI, consistent with other auto-approved calls.
- `resolveWorkspacePath`, `workspaceRoots`, and `resolveWorkspaceParam` live in
  `server/src/workspacePaths.ts`, not `server/src/index.ts`, purely so they're
  importable by their own test — `index.ts` starts listening as a side effect of
  being imported.
- `~/.claude/plans` is per-OS-user, not per-app-user: with `AUTH_ENABLED`, every
  signed-in app user on the same machine shares that directory, so its plans are
  readable across app-user boundaries through this exception. Accepted for now;
  revisit if multi-user support becomes a near-term goal.

## Related decisions

None recorded, but see [guard-allowlist](guard-allowlist.md) — the user-visible,
editable exception list for the same guard this file's `assessToolCall` and
`ALWAYS_ASK_TOOLS` belong to —
[permission-resolution-provenance](permission-resolution-provenance.md) for how
`ALWAYS_ASK_TOOLS` is now force-prompted rather than merely never auto-approved —
and [plan-review-card](plan-review-card.md), the consumer of the `/file` widening.
