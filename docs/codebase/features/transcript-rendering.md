# Transcript rendering

Covers: `transcript-markdown-rendering`, `tool-call-structured-input`, `subagent-transcript`.

## Purpose

How everything in the transcript is drawn: text, tool calls, and subagent runs.

- **Markdown rendering** — every transcript item's text goes through the same `Markdown`
  component with a shared compact rhythm. A bubble is reserved for user prompts only — agent
  output (answers, tool summaries) renders unwrapped, flush-left, borderless.
- **Structured tool input** — replace the raw `JSON.stringify(tool.input)` dump every transcript
  tool card used to show (both in the collapsed row's one-liner and in the expanded body) with a
  per-tool structured field list. Raw JSON stays reachable behind an explicit toggle rather than
  being deleted, since tool input shapes are free-form and unbounded (arbitrary MCP tools, an SDK
  type that gains fields before this code knows about them). Two tool kinds get further,
  kind-specific treatment on top of the shared field list: a call with a diff to show (a
  successful edit) drops its expand affordance entirely, and a settled (answered, non-error)
  `AskUserQuestion` drops the row entirely and renders as just the read-only option-card review the
  live prompt uses — always visible, never behind a chevron, isolated from tool grouping and
  turn-folding so it always sits as its own top-level transcript item.
- **Subagent nesting** — attribute SDK messages to the agent that actually produced them, and
  render a subagent spawn as a run (agent identity and description first) instead of a bare tool
  badge. The harness already runs the Claude Code preset with `settingSources: ['user','project']`
  and no `allowedTools` restriction, so the spawn tool is live and `.claude/agents/` definitions
  load — a prompt can spawn subagents (Explore, Plan, custom agents) exactly like Claude Code's
  CLI. Every SDK message carries `parent_tool_use_id` when it was produced by such a subagent.
  This nests a subagent's transcript under its spawning card instead of flattening it into the
  main agent's stream, excludes subagent messages from every piece of main-agent state (context
  usage, workflow step output, turn summaries), and gives the spawning card its own header,
  container, and agent-identity badge — shared with the live `ActivityRow` via one lookup so a
  running agent and the card that replaces it always match.

## Entry points

- `web/src/components/Transcript.tsx` (`Item`, `case 'user'` and `case 'assistant'`)
- Any expanded tool card in the transcript (`web/src/components/ToolCallCard.tsx`)
- A settled `AskUserQuestion` call, rendered bare as its own top-level review — no chevron, never
  grouped or folded away; before it was deduped this coexisted with a separate "Claude asked"
  summary below it, which still appears for a denied/expired question
- A prompt that causes the agent to spawn a subagent (e.g. "use the Explore agent to map
  server/src")
- `web/src/lib/transcript.ts` (`buildTranscript`) — nests rendering
- `server/src/sessions.ts` (`handleWorkerEvent`, `collectTurns`, `scanTurnActivity`) — excludes
  subagent messages from main-agent state

## Files

- `web/src/components/Transcript.tsx` — user bubble renders `<Markdown text={item.text} />`;
  agent text (`case 'assistant'`, streaming) renders the same component with no wrapping `Paper`;
  `isRedundant` (drops a resolved `AskUserQuestion` permission item once its tool card carries the
  same information); `Item`'s `renderNested` closure passed to `ToolGroup`
- `web/src/components/Markdown.tsx` — shared renderer (`remarkGfm`, `rehypeColorSwatches`,
  `rehypeFilePaths`, `rehypeHighlight`)
- `web/src/index.css` — `.md-body` compact spacing vars, `.md-body pre code` wrap rules,
  `.md-table-wrap` horizontal-scroll wrapper for GFM tables, `.tx-row`/`.tx-streaming`
  borderless-row and caret styling, `.tx-static` (cursor-only change for a non-expandable row),
  `.tx-task`
- `web/src/lib/toolFields.ts` — `toolFields`, `toolSummary`, `parseQuestionAnswers`,
  `matchAnswerToOptions`, `BODY_CAP`
- `web/src/components/ToolCallCard.tsx` — `ToolFields`, `RawInput`, the `expandable` gate, the
  one-liner (`toolSummary`); branches to `TaskHeader`/`TaskBody` for a spawn call, `.tx-task`
  container class, nested tool tally; a settled `AskUserQuestion` short-circuits before any of
  that and returns bare `QuestionReview`
- `web/src/components/QuestionPrompt.tsx` — `OptionCard`'s `readOnly` mode, `QuestionReview`
- `shared/types.ts` — `subagentParentId`
- `server/src/sessions.ts` — `handleWorkerEvent` (context-usage gate), `collectTurns`
  (turn-output scan), `scanTurnActivity` (turn-summary scan, extracted from `summarizeTurn`)
- `web/src/lib/transcript.ts` — `ToolBlock.children`, `LiveActivity.subagent` / `subagentType`,
  `Sink`, `sinkFor`, `buildTranscript`, `isQuestionTool`
- `web/src/lib/agents.ts` — `isAgentTool`, `parseTaskInput`, `agentMeta`, `MAIN_AGENT_META`,
  `taskFlags`
- `web/src/components/TaskCall.tsx` — `TaskHeader` (badge + description + flags), `TaskBody`
  (prompt disclosure)
- `web/src/components/ToolGroup.tsx` — forwards `renderNested` to `ToolCallCard`
- `web/src/components/ActivityRow.tsx` — renders the same `agentMeta`/`MAIN_AGENT_META` icon the
  settled card will use

## Symbols

- `Markdown` — shared renderer, used by both the user bubble and unwrapped agent text
- `.md-body` — CSS scope overriding Mantine `Typography` spacing/heading vars for a compact
  rhythm
- `.md-body pre code` — CSS controlling code-block overflow behavior
- `.tx-row` / `.tx-streaming` — borderless hover row and streaming-caret classes shared by the
  transcript's collapsible rows
- `toolFields(tool): ToolField[]` — classifies every input key: the first hit of the priority
  list `command → file_path → pattern → url → description` becomes the `primary` field; remaining
  strings become `text` (short/single-line) or `code` (multiline or >200 chars); booleans/numbers
  become `text`; objects/arrays collapse to a single capped `json` field. Never assumes a shape —
  every branch is `typeof`-guarded
- `toolSummary(tool): string` — the collapsed row's one-liner, built from the same field list
  (`AskUserQuestion` instead summarizes its first question text); this replaced the old
  `summarizeInput`'s `JSON.stringify` fallback
- `BODY_CAP` (6000 chars) — shared cap on every rendered value (a field, the raw JSON, a tool
  result, a spawn prompt) so a large input can't stall first paint
- `parseQuestionAnswers(result)` — an `AskUserQuestion` result is prose (`Your questions have
  been answered: "Q"="A", …`), not JSON; this extracts only the answer side of each pair with a
  regex, since a question's own text can contain unescaped quotes
- `matchAnswerToOptions(answer, labels)` — a multi-select answer is comma-joined, but an option
  label can itself contain a comma; this matches labels longest-first and strips them from the
  string as it goes, so what's left over is what was typed into "Other…"
- `QuestionReview` — renders an answered/denied `AskUserQuestion` call using `OptionCard` in
  `readOnly` mode: the exact cards the live prompt offered, with what was picked still checked and
  everything else dimmed
- `isQuestionTool(name)` — true for `'AskUserQuestion'`; used to isolate the call into its own
  single-tool group at every grouping level and to mark that group a `foldAgentTurns` boundary
- `subagentParentId(msg)` — pure predicate; returns the owning spawn call's id, or `null` for
  main-agent messages
- `Sink` / `sinkFor(parentId)` — per-agent assistant-message accumulator (`items`, `openGroup`,
  `lastText`) used while building the transcript; the main agent and each subagent get their own,
  so concurrent subagents can't merge into one tool group
- `ToolBlock.children` — a spawn block's nested `TranscriptItem[]`, populated by its subagent's
  sink
- `scanTurnActivity(events)` — pure; the tool-call/error/final-text scan behind the turn summary,
  subagent-excluded
- `isAgentTool(name)` — true for `'Agent'` or `'Task'`; the harness names the spawn tool `Agent`,
  the SDK's own types/docs call it `Task`, and persisted transcripts contain both, so every
  consumer matches on this rather than one literal
- `parseTaskInput(input)` — defensively parses a spawn call's input into `{description, prompt,
  subagentType, model, background, name, mode, isolation}`; every field is `typeof`-guarded and a
  missing `description` falls back to the prompt's first line, never throws
- `agentMeta(subagentType)` / `MAIN_AGENT_META` — the single source of truth for an agent's badge
  icon and colour, read by both `TaskHeader` and `ActivityRow`
- `taskFlags(call)` — the non-default options on a spawn call (`run_in_background`, `isolation`,
  non-default `mode`) as tooltipped icons; empty when the call has none

## Data flow

### Text

`TranscriptItem` (`user.text` or `assistant.blocks[].text`) → `Markdown` → `ReactMarkdown` +
`remarkGfm` (tables, strikethrough, task lists, footnotes, autolink literals) + rehype plugins
(syntax highlight, file-path links, color swatches) → rendered inside the user `Paper` bubble, or
directly (no wrapper) for agent text.

### Tool cards

`ToolCallCard` computes `isTask`/`isQuestion` alongside the existing `editTool` check. For an
edit tool with a diff and no error, `expandable` is false: no chevron, no click/keyboard toggle,
just a dimmed dot in that 13px slot so the badge column still lines up with every other row — the
Monaco diff button already covers what the body would show. `PermissionPrompt`'s plan-approval row
uses the same dot when there is no plan to expand. Every other tool card's body renders `ToolFields`
(for a spawn call, `TaskBody`'s prompt disclosure instead; for a pending or errored
`AskUserQuestion`, `QuestionReview` instead), followed by an always-present `RawInput` toggle that
lazily serializes `tool.input` only once opened. The field the row's one-liner already showed is
dropped from the body unless it needed its own code block (a Bash heredoc, a Write's content) —
showing a Read's path twice, once in the badge row and again in the body, would be pure
duplication.

A settled `AskUserQuestion` (answered, not pending, not an error, with a non-empty `questions`
array) skips all of that: `ToolCallCard` returns bare `QuestionReview` before building the row at
all — no badge, no chevron, no `Collapse`, nothing to click. A pending question keeps the ordinary
collapsible card (the live `PermissionPrompt` below it is the interactive copy; an always-open
card here would duplicate it), and so does an error (the result text is the point) or a malformed
call (nothing to review, so the card stays rather than vanishing).

That bare review also never gets buried: `buildTranscript` isolates every `AskUserQuestion` call
into its own single-tool group regardless of the session's tool-grouping level (`isolated =
!groupTools || isQuestionTool(tool.name)`), which `ToolGroup` renders as an ungrouped card since a
one-tool group carries no group chrome. `foldAgentTurns` treats that single-tool question group as
a boundary, the same way it already treats a pending `ExitPlanMode` — so at Compact level the
question always renders as its own top-level item between two folded turn halves, never hidden
inside one.

For `Transcript.tsx`'s permission-item filter: previously just `!data.auto`, it is now
`isRedundant()`, which also drops a `resolution: 'allow'` question — its tool card, via
`QuestionReview`, already shows the full question/answer review. A denied or expired question
keeps its separate "Claude asked" card, since that copy ("re-send your prompt and Claude will ask
again") exists nowhere else, and keeps the ordinary collapsible tool card too (the early-return
only applies to a non-error settled question).

### Subagents

Worker → bridge: every SDK message (including subagent ones) is forwarded and persisted verbatim,
`parent_tool_use_id` included — this predates the feature, so existing transcripts already carry
the field and gain nesting on reload with no migration.

Server (`handleWorkerEvent`): an `assistant` message only updates the live `contextUsage` reading
when `subagentParentId` is null. `collectTurns` skips any `sdk` event with a non-null
`subagentParentId` before scanning for turn output. `summarizeTurn` calls `scanTurnActivity`,
which applies the same skip before building the tool-call list handed to the Haiku summarization
prompt (the spawn call itself survives — it's a main-agent tool use — so the summary still reads
as "spawned an Explore subagent").

Web (`buildTranscript`): one pass over events, routing each `assistant` message through
`sinkFor(subagentParentId(msg))`. A `null` parent id (or a parent id naming a spawn block no
longer in `toolBlocks` — e.g. a truncated transcript) resolves to the main sink; otherwise the
message's items land in `toolBlocks.get(parentId).children`. Tool results (SDK `user` messages)
need no special handling — `toolBlocks` is a flat id-keyed map, so a nested tool's result finds it
by id regardless of which sink created it. `sinks.clear()` on every turn boundary (`user`,
`workflow`, `result`) so a new turn starts with no stale subagent sinks. Live activity
(`stream_event`) resolves `subagentType` from `toolBlocks.get(parentId)?.input.subagent_type` when
the spawning call is already known.

Rendering: `ToolCallCard` detects a spawn call with `isAgentTool(tool.name)` and renders
`TaskHeader` in place of the generic badge+summary — an agent-identity badge (icon + label from
`agentMeta`/`MAIN_AGENT_META`, coloured violet for a subagent, blue for the main agent, red on
error) followed by the call's `description` as the primary text (not dimmed, not monospace), a
cluster of tooltipped flag icons from `taskFlags`, and the nested `groupSummary` tally. The card
itself gets the `.tx-task` container class (an inset violet accent + tint) so a subagent run reads
as one unit rather than an ordinary row. Expanding the card renders the subagent's own transcript
(via the `renderNested` callback threaded down from `Transcript.Item`), then `TaskBody`'s prompt
disclosure. `ActivityRow` renders the identical `agentMeta`/`MAIN_AGENT_META` icon (in the same
colour) while the turn is still running, so the live row and the card that replaces it always
match; the main agent's row is icon-only (no label prefix) since the session is already known to
be talking to it.

## Dependencies

- `remark-gfm` — the remark-side plugin enabling GFM (tables, strikethrough, task lists,
  footnotes, autolink literals); otherwise nothing beyond the existing `Markdown` component and
  its rehype plugin chain for text.
- `.claude/agents/` reaches sessions through `settingSources`, matching how the whole Claude Code
  preset is inherited — there is no separate `agents` option in `buildQueryOptions`.
- The spawn tool is auto-allowed by `server/src/autoGuard.ts`, so a spawn never prompts.
- [context-window](context-window.md) — the fallback context-usage reading the subagent gate
  applies to.

## Tests

- No test infrastructure covers `Transcript`/`Markdown` rendering, `buildTranscript`'s sink
  routing, or the nested rendering — `web/` has no test infrastructure.
  `toolFields`/`toolSummary`/`parseQuestionAnswers`/`matchAnswerToOptions` were exercised manually
  against real persisted transcript strings during development. Verification is otherwise manual:
  expand a Bash/Read/Edit/Grep/WebFetch/MCP card and confirm a field list instead of JSON, confirm
  the raw-input toggle reproduces byte-identical JSON, confirm a successful edit has no chevron,
  and spawn a subagent to confirm nesting, live label/icon/colour match, agent badge on reload,
  context ring, and reload back-compat. For `AskUserQuestion`: confirm an answered question shows
  the option cards already picked with no click needed, no chevron, and no separate "Claude asked"
  card below it (exactly one review on screen); confirm it sits as its own top-level item between
  two folded turns at Compact level; confirm a still-pending question stays an ordinary collapsed
  card with the live `QuestionPrompt` as the only interactive copy; confirm a denied/expired
  question is unchanged (collapsible card plus the separate "Claude asked" re-send card); confirm
  the placement and open state survive a tool-grouping-level switch and a page reload.
- `server/src/sessions.turns.test.ts` — a subagent's final text landing after the main agent's
  does not become the turn output; a subagent's `ExitPlanMode`/plan-file write does not turn an
  ordinary turn into a plan turn; `scanTurnActivity` drops a subagent's tool calls while keeping
  its parent spawn call and the main agent's final text. These build spawn inputs with only
  `subagent_type` + `description` — exactly the degraded path `parseTaskInput` must handle.
- `server/src/sessions.context.test.ts` — `subagentParentId` recognizes a subagent message and
  returns `null` for a main-agent one; documents the gate `handleWorkerEvent` applies (the
  extractor itself is agent-agnostic).

## Business rules

- User and agent text render markdown (headings, code fences, lists, GFM tables, color swatches)
  instead of plain preformatted text; single newlines collapse and raw HTML tags are dropped.
- Code blocks (`.md-body pre code`) wrap long lines (`white-space: pre-wrap`,
  `overflow-wrap: anywhere`) instead of scrolling horizontally, so they stay within the
  conversation column.
- A GFM table wider than the conversation column scrolls horizontally inside its own
  `.md-table-wrap` wrapper instead of widening the column, paralleling the code-block wrap rule.
- Only the user prompt renders as a bubble (right-aligned `Paper`, capped at 80% column width).
  Agent output — answers, folded turns, tool groups/calls — is unwrapped and flush-left; nesting
  is shown by vertical order and the row's expand/collapse affordance, not by a box or
  indentation.
- Every tool's expanded body shows a structured field list, never raw JSON by default; raw JSON is
  one toggle away for every tool, with no exceptions (it is the safety net for shapes `toolFields`
  can't classify well).
- A tool call already fully explained elsewhere in the row loses its expand affordance rather than
  offering an empty or redundant body: a successful edit (diff button covers it) loses only the
  chevron. A settled (answered, non-error) `AskUserQuestion` goes further and loses the row too —
  it renders as just the always-open review, since that review is the entire point of the card.
- An `AskUserQuestion` call's answer is read from its tool result's prose, not from its input —
  the input only ever contains the questions asked.
- Every `AskUserQuestion` call — pending, answered, or errored — is isolated into its own
  single-tool group at every tool-grouping level and treated as a `foldAgentTurns` boundary (like
  a pending `ExitPlanMode`), so the question always renders as its own top-level transcript item:
  never grouped with neighbouring tool calls, never folded inside a Compact-level agent turn. Only
  once it settles successfully does the card itself also drop its row (previous rule); while
  pending or on error it is still top-level, just an ordinary collapsible card there.
- A subagent's assistant text and tool calls are never counted as main-agent output: workflow step
  output (`collectTurns`), the turn summary (`scanTurnActivity`), and the live context-usage
  reading (`handleWorkerEvent`) are all derived from main-agent messages only.
- A subagent's tool calls and text nest under its spawning card (`ToolBlock.children`), never
  inline in the main transcript or folded into the main agent's tool group.
- A subagent cannot itself spawn another subagent (harness restriction), so nesting is one level
  deep in practice; the data model (`children: TranscriptItem[]`) is recursive, so a deeper tree
  would render rather than break.
- A message whose `parent_tool_use_id` names a spawn block that isn't in `toolBlocks` (truncated
  transcript, compaction) falls back to the main sink instead of being dropped.
- A spawn card leads with `description`, not the tool name — the tool name ("Agent"/"Task")
  carries no information a reader wants first.
- An unmapped or plugin-scoped `subagent_type` (e.g. `caveman:cavecrew-builder`) degrades to a
  generic agent badge (violet, robot icon, the raw identifier — prefix stripped, truncated — as
  the label) rather than being hidden or crashing; `subagent_type` is a free-form, user- and
  plugin-defined string that the seed map can never fully cover.
- The main agent and a subagent share the same badge icon but never the same colour (blue vs
  violet), so which one is running/spoke reads from colour alone before any label is read.
- Every user bubble carries an author avatar (`PromptAuthor`), solo sessions included — see
  [session-collaboration](session-collaboration.md#attribution). Historical rows and the owner's
  own prompt carry no recorded actor and resolve to the session's host, so this is a pure
  read-side change with no migration.
- Code-block syntax highlighting (`rehype-highlight`) is deferred: a `Markdown` document's
  first paint renders without it, then an idle callback (2s timeout fallback) upgrades it in
  place — the highlighter only adds classes inside an already-laid-out `<pre>`, so the upgrade
  cannot reflow the transcript around it. A document with no fenced or indented code block
  skips the deferral and renders with the full plugin set immediately, since there is nothing
  for a second pass to add. See [transcript-performance](transcript-performance.md) for the
  measured cost this addresses.

## Architectural rules

- User and agent transcript text share one markdown renderer (`Markdown`) rather than each having
  its own text-rendering path; `ColorizedText.tsx` (the prior plain-text-plus-swatch twin) was
  deleted as dead code.
- A peer's user bubble stays right-aligned, exactly like the owner's own — it is never flipped to
  the left the way a real messaging app would. Agent output is already flush-left by convention,
  so a left-aligned prompt would read as the agent talking; authorship is carried by the avatar
  and its colour instead of by side. Deliberate deviation, recorded here so it is not "fixed"
  later.
- `Markdown` also takes an optional `onLinkClick` prop, added for the
  [docs-reader](docs-reader.md) so it can route links inside its own page instead of the
  source-file preview. Every transcript call site passes nothing, so its rendering is unchanged
  (falls back to `openFilePreview`).
- The user bubble `Paper` needs `minWidth: 0` alongside `maxWidth: '80%'` — without it, a flex
  child containing wide content (e.g. a code block or one long unbroken token) can grow past 80%
  regardless of the CSS wrap rules on its content: used width is
  `max(min-width, min(max-width, width))`, so a default `min-width: auto` (min-content) would win
  over `maxWidth` for a single unbreakable run.
- Compact markdown rhythm is implemented as **scoped Mantine spacing variable overrides on
  `.md-body`**, not CSS selector overrides. Mantine `Typography`'s list rule is
  `:where(ul, ol):not([data-type='taskList'])`, specificity (0,2,0), which beats a `.md-body ul`
  override at (0,1,1) regardless of import order — only overriding the underlying
  `--mantine-spacing-*`/`--mantine-h*-font-size` vars sidesteps that.
- Table borders, cell padding, and block margin come entirely from Mantine `Typography`'s own
  table rules, driven by the same `.md-body` spacing vars above — no dedicated table CSS was
  added; `.md-table-wrap` only handles horizontal overflow.
- GFM task lists render as `<ul class="contains-task-list">`, which Typography's
  `:where(ul, ol):not([data-type='taskList'])` rule still bullets. `.md-body
  ul.contains-task-list { list-style: none }` ties that rule's specificity (0,2,0); `index.css`
  importing after `@mantine/core/styles.css` decides it in our favor, the same mechanism as the
  `.md-body pre` override above.
- Collapsible transcript rows (agent turns, tool groups, tool calls) share one borderless row
  convention (`.tx-row` in `web/src/index.css`): no `Paper`/border, hover highlight via CSS,
  click/keyboard toggle on the row `Group`, no accumulating indentation — every row (top-level or
  nested inside an expanded body) sits at the same left edge. A spawn card's subagent transcript
  is a third nesting level under the same convention — no indentation, only the expand/collapse
  affordance.
- A collapsed row's body (markdown, tool input/result, nested diff computation) is not rendered
  while closed — `Collapse`'s `expanded` prop only hides it visually, so the body's own children
  are additionally gated on `expanded` so they unmount instead of merely being hidden. Most rows
  in a long transcript load collapsed, so this is what keeps first paint cheap. Consequence: any
  state living inside a collapsed body (e.g. a tool card's own expand toggle) does not survive its
  parent collapsing/expanding unless lifted into a module-scope sticky map — see the
  `stickyOverrides`/`turnOverrides`/`stickyExpanded` maps in `ToolGroup.tsx`, `Transcript.tsx`,
  and `ToolCallCard.tsx`. Sub-toggles *inside* an already-expanded body (a spawn card's prompt
  disclosure, the raw-input toggle every tool card has) are deliberately plain `useState`, not
  sticky: they live inside the collapsed body itself, so resetting on close is the expected
  behavior, not a bug.
- `react-window` (or similar list virtualization) is still rejected for the transcript list —
  it would break `updateProgress`'s workflow-step-marker scan, the `scrollHeight`-based
  auto-pin and its `ResizeObserver`, and browser find-in-page. What changed instead is a
  simple tail window (last ~40 top-level items, growing on idle backfill or on scrolling near
  the top) that keeps every `ScrollArea`/find-in-page/auto-pin guarantee intact — lazy-mounted
  bodies alone stopped being enough once a real session's Markdown mount cost dominated a
  session switch. See [transcript-performance](transcript-performance.md) for the mechanism
  and the measurement behind it.
- `reconcileItems` (`transcript.ts`) hands a rebuilt item back its previous object identity
  when every field `buildTranscript` can later mutate in place is unchanged —
  `ToolBlock.result`/`isError`/`snapshot`/`children`, permission `.resolution`/`.data`,
  `ResultItem.summary`, and streaming/assistant text. This is what makes `memo` on
  `Item`/`AgentTurn`/`ToolGroup`/`ToolCallCard` actually skip work (a rebuild recreates every
  item from scratch otherwise) and what lets the `toolDiffCache` `WeakMap` (keyed on the
  `ToolBlock` object) survive a rebuild instead of recomputing every whole-file diff on every
  event. Missing a mutated field here means a changed row silently keeps rendering its old
  content — the field list above is meant to stay exhaustive against whatever
  `buildTranscript` writes post-creation.
- The `renderNested` callback threaded from `Transcript` into `ToolGroup`/`ToolCallCard` must
  stay referentially stable across renders (it's a `useCallback` keyed on `sessionId`, reached
  through a ref so it can call itself for a nested subagent transcript) — a fresh closure
  every render defeats those components' `memo` silently: nothing errors, the row just never
  skips a reconcile.
- The workflow progress bar (`updateProgress`) reads which steps have started from the item
  list itself (a `'workflow'` item with event `'started'`), not from the positions of rendered
  `[data-workflow-step]` DOM markers — the tail window can clip an early marker out of the DOM
  entirely, and a clipped-but-started step reports its segment as fully filled (its bounds
  collapse to 0) rather than 0% filled. Clicking a stepper step that isn't currently mounted
  goes through `revealWorkflowStep()`/`REVEAL_STEP_EVENT` (`web/src/lib/workflowReveal.ts`)
  instead of a direct `querySelector` — see [workflow-step-lifecycle](workflow-step-lifecycle.md).
- `toolFields` degrades instead of failing: an unclassifiable value becomes a capped `json` field
  rather than throwing or being skipped, because tool input shapes (especially MCP tools) are not
  controlled by this code and drift freely.
- `OptionCard` (originally built as the interactive picker in `QuestionPrompt`) gained a
  `readOnly` prop instead of being duplicated into a second component — a settled answer should
  look exactly like the choice that produced it.
- In the interactive `OptionCard`, the `Checkbox`/`Radio` is a non-interactive indicator only
  (`readOnly`, `pointerEvents: none`, no `onChange`); the wrapping `UnstyledButton` is the sole
  click target and carries `role`/`aria-checked`. Wiring `onChange` on the control too makes a
  click on it fire the toggle twice (control + bubbled button), which cancels itself in
  multi-select — do not re-add it.
- The raw-input toggle is intentionally shown even for an empty (`{}`) input, unlike
  `PermissionPrompt`'s equivalent guard — consistency across every tool card was chosen over
  hiding a toggle that would do nothing.
- Existing transcripts already carry `parent_tool_use_id` on disk (the worker persists every SDK
  message verbatim) — subagent nesting is a pure read-side reinterpretation, no new capture and no
  migration.
- No `agents` option was added to `buildQueryOptions`; subagent definitions are inherited via
  `settingSources`, the same mechanism that already inherits the rest of the preset.
- The spawn tool's name is not a stable literal: the harness emits `'Agent'`, the SDK's own
  `AgentInput` type and docs call it `'Task'`, and both appear in persisted transcripts. Every
  consumer checks `isAgentTool(name)` instead of a single string comparison.
- `agentMeta`/`MAIN_AGENT_META` in `web/src/lib/agents.ts` is the single source of truth for agent
  icon/colour, read by both the settled `TaskHeader` and the live `ActivityRow` — a running agent
  and the card that replaces it cannot drift apart.
- `parseTaskInput` never throws and never assumes a field is present: `AgentInput` gains fields
  the map won't know about (`effort` is the live example — used in practice, absent from the SDK's
  own type at time of writing), so the raw-input toggle stays reachable behind every spawn card
  rather than being dropped once structured rendering shipped.
- `ToolCallCard` cannot import `Transcript.tsx`'s `Item` (an import cycle, since `Transcript.tsx`
  already imports `ToolGroup` → `ToolCallCard`); nested rendering is threaded down as a
  `renderNested` callback instead of a new shared module.
- `.tx-task`'s container accent uses `box-shadow: inset` plus an asymmetric `margin-inline` (not a
  real border) so the chevron stays in the single column `.tx-row` maintains for every other row,
  at every nesting depth.
- `foldAgentTurns` needed no change for subagent nesting: subagent items live inside
  `ToolBlock.children`, never in the top-level item array it operates on.
- `buildTranscript` isolates an `AskUserQuestion` call into its own single-tool group the same way
  Full-level tool grouping does (`sink.openGroup = null` before and after), rather than adding a
  second isolation mechanism — a one-tool group already renders bare via `ToolGroup`'s existing
  `group.tools.length === 1` check, so no new rendering path was needed either.
- `foldAgentTurns`' boundary check gained one clause (a single-tool `AskUserQuestion` group) rather
  than a new concept: it already treated a pending `ExitPlanMode` permission item as a boundary, so
  a question uses the same mechanism instead of a parallel one.

## Related decisions

- [docs-reader](docs-reader.md) — the one consumer of `Markdown`'s `onLinkClick`.
- [context-window](context-window.md) — the main-agent-only restriction on the fallback occupancy
  reading.
- [session-collaboration](session-collaboration.md) — the author avatar and identity resolution
  behind every user bubble.
- [transcript-performance](transcript-performance.md) — event batching and the tail window that
  `reconcileItems`/the row memos above make effective.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — the stepper's jump-to-step against a
  windowed transcript.
