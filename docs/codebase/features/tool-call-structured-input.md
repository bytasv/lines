# Tool call structured input

## Purpose

Replace the raw `JSON.stringify(tool.input)` dump every transcript tool card used
to show — both in the collapsed row's one-liner and in the expanded body — with a
per-tool structured field list. Raw JSON stays reachable behind an explicit
toggle rather than being deleted, since tool input shapes are free-form and
unbounded (arbitrary MCP tools, an SDK type that gains fields before this code
knows about them). Two tool kinds get further, kind-specific treatment on top of
the shared field list: a call with a diff to show (a successful edit) drops its
expand affordance entirely, and `AskUserQuestion` renders as the same read-only
option-card review the live prompt uses instead of a field list.

## Entry points

- Any expanded tool card in the transcript (`web/src/components/ToolCallCard.tsx`).
- A resolved `AskUserQuestion` call, either as its tool card or (before this
  feature deduped them) the separate "Claude asked" summary below it.

## Important files

- `web/src/lib/toolFields.ts` — `toolFields`, `toolSummary`, `parseQuestionAnswers`,
  `matchAnswerToOptions`, `BODY_CAP`
- `web/src/components/ToolCallCard.tsx` — `ToolFields`, `RawInput`, the
  `expandable` gate, the one-liner (`toolSummary`)
- `web/src/components/QuestionPrompt.tsx` — `OptionCard`'s `readOnly` mode,
  `QuestionReview`
- `web/src/components/Transcript.tsx` — `isRedundant` (drops a resolved
  `AskUserQuestion` permission item once its tool card carries the same
  information)
- `web/src/index.css` — `.tx-static` (cursor-only change for a non-expandable row)

## Important symbols

- `toolFields(tool): ToolField[]` — classifies every input key: the first hit of
  the priority list `command → file_path → pattern → url → description` becomes
  the `primary` field; remaining strings become `text` (short/single-line) or
  `code` (multiline or >200 chars); booleans/numbers become `text`; objects/arrays
  collapse to a single capped `json` field. Never assumes a shape — every branch
  is `typeof`-guarded.
- `toolSummary(tool): string` — the collapsed row's one-liner, built from the same
  field list (`AskUserQuestion` instead summarizes its first question text); this
  is what replaced the old `summarizeInput`'s `JSON.stringify` fallback.
- `BODY_CAP` (6000 chars) — shared cap on every rendered value (a field, the raw
  JSON, a tool result, a spawn prompt) so a large input can't stall first paint.
- `parseQuestionAnswers(result)` — an `AskUserQuestion` result is prose
  (`Your questions have been answered: "Q"="A", …`), not JSON; this extracts only
  the answer side of each pair with a regex, since a question's own text can
  contain unescaped quotes.
- `matchAnswerToOptions(answer, labels)` — a multi-select answer is comma-joined,
  but an option label can itself contain a comma; this matches labels longest-first
  and strips them from the string as it goes, so what's left over is what was
  typed into "Other…".
- `QuestionReview` — renders an answered/denied `AskUserQuestion` call using
  `OptionCard` in `readOnly` mode: the exact cards the live prompt offered, with
  what was picked still checked and everything else dimmed.

## Data flow

`ToolCallCard` computes `isTask`/`isQuestion` alongside the existing `editTool`
check. For an edit tool with a diff and no error, `expandable` is false: no
chevron, no click/keyboard toggle, just a 13px spacer so the badge column still
lines up with every other row — the Monaco diff button already covers what the
body would show. Every other tool card's body renders `ToolFields` (for a spawn
call, `TaskBody`'s prompt disclosure instead; for `AskUserQuestion`,
`QuestionReview` instead), followed by an always-present `RawInput` toggle that
lazily serializes `tool.input` only once opened. The field the row's one-liner
already showed is dropped from the body unless it needed its own code block (a
Bash heredoc, a Write's content) — showing a Read's path twice, once in the badge
row and again in the body, would be pure duplication.

For `AskUserQuestion` specifically: `Transcript.tsx`'s permission-item filter,
previously just `!data.auto`, is now `isRedundant()`, which also drops a
`resolution: 'allow'` question — its tool card, via `QuestionReview`, already
shows the full question/answer review. A denied or expired question keeps its
separate "Claude asked" card, since that copy ("re-send your prompt and Claude
will ask again") exists nowhere else.

## Dependencies

- [[subagent-transcript]] — a spawn call is a distinct branch in the same
  `ToolCallCard`, sharing `RawInput`, `BODY_CAP`, and the expand/collapse
  machinery documented there.
- [[transcript-markdown-rendering]] — the field list and raw-input toggle live
  inside the same lazy, sticky-expansion body convention documented there; the
  prompt/raw sub-toggles inside that body are plain local state, not sticky, since
  resetting them on collapse is the expected behavior.

## Tests

None — `web/` has no test infrastructure. `toolFields`/`toolSummary`/
`parseQuestionAnswers`/`matchAnswerToOptions` were exercised manually against real
persisted transcript strings during development, not via an automated test.
Verification is otherwise manual: expand a Bash/Read/Edit/Grep/WebFetch/MCP card
and confirm a field list instead of JSON, confirm the raw-input toggle reproduces
byte-identical JSON, confirm a successful edit has no chevron, and confirm an
answered question shows exactly one review (the tool card, not also the separate
summary).

## Business rules

- Every tool's expanded body shows a structured field list, never raw JSON by
  default; raw JSON is one toggle away for every tool, with no exceptions (it
  is the safety net for shapes `toolFields` can't classify well).
- A tool call already fully explained elsewhere in the row loses its expand
  affordance rather than offering an empty or redundant body: a successful edit
  (diff button covers it) and a resolved `AskUserQuestion` (its own card carries
  the review) are the two current cases.
- An `AskUserQuestion` call's answer is read from its tool result's prose, not
  from its input — the input only ever contains the questions asked.

## Architectural rules

- `toolFields` degrades instead of failing: an unclassifiable value becomes a
  capped `json` field rather than throwing or being skipped, because tool input
  shapes (especially MCP tools) are not controlled by this code and drift freely.
- `OptionCard` (originally built as the interactive picker in `QuestionPrompt`)
  gained a `readOnly` prop instead of being duplicated into a second component —
  a settled answer should look exactly like the choice that produced it.
- The raw-input toggle is intentionally shown even for an empty (`{}`) input,
  unlike `PermissionPrompt`'s equivalent guard — consistency across every tool
  card was chosen over hiding a toggle that would do nothing.

## Related decisions

None recorded.
