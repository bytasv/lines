# Plan review card stays readable after resolution

## Purpose

An approved or denied `ExitPlanMode` plan card used to collapse to a header + badge with
the plan markdown and Focus-mode button gone/inert. Revisiting the session (switching
away in the Sidebar and back, or a hard reload) left the plan text unreachable even
though it was never actually deleted. The card is now collapsed-but-reopenable: one
click on the header expands the full plan text and Focus mode, minus the now-dead
action buttons. Separately, the current harness writes the plan to a file under
`.claude/plans/` instead of passing it as the `ExitPlanMode` tool's `plan` argument; the
card now falls back to that file's text so it isn't empty on the current harness.

A plan card also used to freeze at whatever text it first captured: while the user kept
iterating on a plan ("keep planning" replies across several turns), the resolved card
from the first round never picked up later revisions, and a card whose write landed in
an earlier turn than its `ExitPlanMode` request rendered with no text at all. The card
now carries the plan file's path (`planPath`) alongside the captured text and re-reads
that file from disk each time it's opened, so both the pending and the already-resolved
card always show the plan as it stands now.

## Entry points

- `PermissionPrompt` rendering an `ExitPlanMode` permission item (live or replayed from
  a persisted transcript).

## Important files

- `web/src/components/PermissionPrompt.tsx` — `PlanApproval`
- `web/src/lib/transcript.ts` — `buildTranscript` (`permission` case), `withPlanFileText`
- `web/src/lib/files.ts` — `useFileContent` (the plan card's live re-read)
- `server/src/autoGuard.ts` — `isPlanPath` (exported; the `/file` route's plan-dir
  exception — see [plan-file-auto-approve](plan-file-auto-approve.md))
- `server/src/workspacePaths.ts` — `resolveWorkspacePath` (the `/file` route's
  path-resolution gate this card's live read goes through)
- `shared/types.ts` — `PLAN_DIR_MARKER`, `isPlanFilePath` (see
  [plan-file-auto-approve](plan-file-auto-approve.md) for the server-side guard use)

## Important symbols

- `PlanApproval` — the plan card + fullscreen focus modal; owns `expanded`
  (collapsed/open) independently of `focus` (fullscreen)
- `withPlanFileText(data, planWrite)` — on the permission *request* event only, fills
  `data.input.plan` from the turn's last plan-file write when the inline argument is
  empty, and always sets `data.input.planPath` to that write's path when one is known
  (independent of which text won); a real inline `plan` always wins on text
- `computeDiff(tool)` — reused to resolve the plan-file write's post-edit text,
  including `Edit`/`MultiEdit` revisions reconstructed from the file snapshot
- `useFileContent(path, reloadKey?)` — fetches `planPath` over the `/file` route
  whenever the card is open; `reloadKey` forces a refetch on each reopen

## Data flow

`buildTranscript` tracks the current turn's last edit-tool call whose file path matches
`isPlanFilePath` in two accumulators: `lastPlanWrite` (reset every `user`/`workflow`
boundary) and `sessionPlanWrite` (never reset). When an `ExitPlanMode` permission
*request* event arrives, `withPlanFileText` is given `lastPlanWrite ?? sessionPlanWrite`
— a same-turn write still wins, but a request whose `ExitPlanMode` lands in a later turn
than the write now falls back to the session-wide value instead of finding nothing. It
resolves that write's text via `computeDiff(...).after` for the captured snapshot and
copies the write's file path onto `data.input.planPath` regardless of which text won;
the *resolution* event only stamps `resolution`/`denyMessage` onto the already-built
item, so the stitched text and path survive.

`PlanApproval` renders open (`expanded = true`) while pending; once `resolution` is set
it collapses and closes focus mode. The header is a click target (chevron + collapsed
headline) that re-expands the card at any time. Whenever the card is open (`expanded ||
focus`), it calls `useFileContent(planPath, reloadKey)` against the bridge's `/file`
route; a false→true transition of "open" bumps `reloadKey` so reopening always
refetches. The captured `plan` text renders immediately (no empty flash) and the live
`content` swaps in on arrival; a fetch failure (deleted plan, 403) silently keeps the
captured text. When resolved and the live content differs from the captured text, a
dimmed "updated since approval" hint renders next to the resolution badge.

## Dependencies

Reuses `computeDiff` (Monaco diff support), the `.tx-row` click-target pattern already
used by `ToolCallCard`/`ToolGroup`, and the bridge's existing `/file` route
(`useFileContent`, shared with `MonacoPreviewModal`/`FilesView`). No new transcript
event or message type.

## Tests

None — `web/` has no test infrastructure and `PermissionPrompt.tsx` is untestable here
without a React renderer (matches [transcript-markdown-rendering](transcript-markdown-rendering.md)).
The server-side pieces this card's live read depends on (`isPlanPath`,
`resolveWorkspacePath`) are covered by `server/src/autoGuard.plan.test.ts` and
`server/src/index.planFile.test.ts`.

## Business rules

- A resolved plan card renders collapsed by default but is always reopenable — the
  plan markdown and Focus mode are never permanently hidden.
- Action buttons (`Approve plan & start`, `Keep planning`) never render once a request
  is resolved, in the inline card or the fullscreen modal — there is no live
  `requestId` left to answer.
- Fullscreen focus mode opens read-only for a resolved plan (just "Exit focus (Esc)").
- When the harness passes no inline `plan` argument, the card shows the turn's last
  plan-file write instead of rendering empty; an `Edit`-revised plan shows the final
  text, not the pre-edit version.
- A plan card whose only source is a plan file (no inline argument, and no same-turn
  write to stitch the text from) is still live: `hasPlan` is true whenever `planPath` is
  known, so the chevron and Focus button work and the live read supplies the text.
- Opening a plan card (expand or Focus) re-reads its plan file from disk; the resolved
  card's text is therefore live, not frozen at whatever was captured at approval time —
  a plan card genuinely reflects the most recent plan, even across several "keep
  planning" rounds in later turns.
- The resolution badge (`allowed`/`plan approved`, `denied`/`kept planning`, `expired`)
  wraps a `Tooltip` naming the resolution source (e.g. "resolved by recovery after an
  interrupted turn") whenever `resolvedBy` is present and not `'user'`; a plain click
  shows no tooltip. The badge label itself is unchanged — see
  [permission-resolution-provenance](permission-resolution-provenance.md).
- The `plan approved` badge was already not a record of what the SDK returned — the
  workflow plan-step gate records `resolution: 'allow'` and then denies the
  `ExitPlanMode` tool call so the step stays read-only. `resolvedBy: 'workflow-advance'`
  makes that legible in the tooltip instead of changing the behavior.

## Architectural rules

- The plan-file fallback is no longer purely transcript-local: `withPlanFileText`
  still builds `data.input.plan`/`planPath` from the transcript alone, but the rendered
  card layers a live filesystem read (`useFileContent` against `/file`) on top whenever
  it's open. The transcript-only text is the fallback shown before that fetch resolves
  or if it fails.
- The plan-file text tracking is turn-scoped for text stitching (`lastPlanWrite`) but
  the path also has a session-wide fallback (`sessionPlanWrite`, never reset) — only
  consulted when the turn-scoped write is absent, so it can't override a genuine
  same-turn write.
- `expanded` and `focus` (fullscreen) are independent pieces of state; resolving a
  request forces both closed via an effect keyed only on `resolution`, so manually
  re-expanding an already-resolved card does not get fought by that effect.
- The card's live read means a resolved card no longer necessarily shows the exact text
  the user approved — the "updated since approval" hint is the mitigation, not a
  guarantee of a faithful approval record.

## Related decisions

- [permission-resolution-provenance](permission-resolution-provenance.md) — the
  `resolvedBy` field this card's tooltip reads, and why it exists.
- [plan-file-auto-approve](plan-file-auto-approve.md) — `isPlanPath`, now also gating
  the `/file` route this card reads through.
