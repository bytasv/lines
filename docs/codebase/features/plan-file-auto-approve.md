# Plan-file auto-approve

## Purpose

Lets plan mode's deliverable — a Markdown file under a `.claude/plans/` directory —
get written, edited, and re-read without a permission card on every call, even
though the file lives outside the session `cwd` (which the guard otherwise
escalates as "file access outside the working directory").

## Entry points

- `Read`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit` tool calls targeting a plan file,
  arriving via `PreToolUse` and `canUseTool`.

## Important files

- `server/src/autoGuard.ts` — `isPlanPath`, `isSafeReadOnly`, `isSafePlanWrite`,
  `assessToolCall`, `PLAN_DIR_MARKER`
- `server/src/sessions.ts` — `handlePreToolUse`, `handleCanUseTool`, `collectTurns`
  (string scan over `PLAN_DIR_MARKER` for transcript plan-text extraction)

## Important symbols

- `isPlanPath(filePath, cwd)` — true when the resolved path is inside
  `~/.claude/plans` or `<cwd>/.claude/plans`
- `isSafeReadOnly(toolName, input, cwd, allowlist)` — observation-only calls
  (`Read`, `Glob`, `Grep`, ...); now also true for plan-file reads outside `auto` mode
- `isSafePlanWrite(toolName, input, cwd)` — true for `Write`/`Edit`/`MultiEdit`/
  `NotebookEdit` targeting a plan path
- `assessToolCall` — the shared guard verdict function; plan paths short-circuit to
  non-dangerous inside its out-of-cwd branch

## Data flow

`handlePreToolUse`/`handleCanUseTool` check, outside `auto` permission mode:
`isSafeReadOnly(...) || isSafePlanWrite(...)` → if either is true, auto-approve
(same `resolution: 'allow', auto: true` transcript event and `permissionDecision:
'allow'` / `{ behavior: 'allow' }` return used by the existing observation-only
path) instead of prompting.

## Dependencies

Builds entirely on the pre-existing `isInside` path-containment helper and the
out-of-cwd branch in `assessToolCall`; no new state or message type.

## Tests

`server/src/autoGuard.plan.test.ts`

## Business rules

- Plan-directory reads and writes (`~/.claude/plans/**` or `<cwd>/.claude/plans/**`)
  auto-approve in every permission mode.
- `ExitPlanMode` and `AskUserQuestion` always still prompt the user
  (`ALWAYS_ASK_TOOLS`), regardless of the target path.
- Credential paths (`~/.ssh`, `~/.aws`, `.env`) always escalate even if nested
  under a `plans` directory — the sensitive check runs before the plan check.
- Any other out-of-cwd file access is unaffected and still escalates.

## Architectural rules

- `isPlanPath` resolves the path (`path.resolve`) and anchors containment checks to
  real directories via `isInside`; it does not substring-match `PLAN_DIR_MARKER`,
  so a crafted path like `.../plans/../../.ssh/id_rsa` cannot pass as a plan path.
- `isInside` does not resolve symlinks — a symlink planted inside a plan directory
  pointing elsewhere would still be treated as safe. Accepted risk: the plan
  directory is agent-and-user-owned.
- Auto-approved plan writes stop producing a permission card but remain visible as
  `tool_use` blocks in the transcript; the auto-approval event itself is filtered
  from the UI, consistent with other auto-approved calls.

## Related decisions

None recorded.
