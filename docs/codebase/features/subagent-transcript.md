# Subagent transcript nesting

## Purpose

Attribute SDK messages to the agent that actually produced them, and render a
subagent spawn as a run — agent identity and description first — instead of a bare
tool badge. The harness already runs the Claude Code preset with
`settingSources: ['user','project']` and no `allowedTools` restriction, so the
spawn tool is live and `.claude/agents/` definitions load — a prompt can spawn
subagents (Explore, Plan, custom agents) exactly like Claude Code's CLI. Every SDK
message carries `parent_tool_use_id` when it was produced by such a subagent. This
feature nests a subagent's transcript under its spawning card instead of
flattening it into the main agent's stream, excludes subagent messages from every
piece of main-agent state (context usage, workflow step output, turn summaries),
and gives the spawning card its own header, container, and agent-identity badge —
shared with the live `ActivityRow` via one lookup so a running agent and the card
that replaces it always match.

## Entry points

- A prompt that causes the agent to spawn a subagent (e.g. "use the Explore agent
  to map server/src").
- `web/src/lib/transcript.ts` (`buildTranscript`) — nests rendering.
- `server/src/sessions.ts` (`handleWorkerEvent`, `collectTurns`, `scanTurnActivity`) —
  excludes subagent messages from main-agent state.

## Important files

- `shared/types.ts` — `subagentParentId`
- `server/src/sessions.ts` — `handleWorkerEvent` (context-usage gate), `collectTurns`
  (turn-output scan), `scanTurnActivity` (turn-summary scan, extracted from
  `summarizeTurn`)
- `web/src/lib/transcript.ts` — `ToolBlock.children`, `LiveActivity.subagent` /
  `subagentType`, `Sink`, `sinkFor`, `buildTranscript`
- `web/src/lib/agents.ts` — `isAgentTool`, `parseTaskInput`, `agentMeta`,
  `MAIN_AGENT_META`, `taskFlags`
- `web/src/components/TaskCall.tsx` — `TaskHeader` (badge + description + flags),
  `TaskBody` (prompt disclosure)
- `web/src/components/Transcript.tsx` — `Item`'s `renderNested` closure passed to
  `ToolGroup`
- `web/src/components/ToolGroup.tsx` — forwards `renderNested` to `ToolCallCard`
- `web/src/components/ToolCallCard.tsx` — branches to `TaskHeader`/`TaskBody` for a
  spawn call, `.tx-task` container class, nested tool tally
- `web/src/components/ActivityRow.tsx` — renders the same `agentMeta`/
  `MAIN_AGENT_META` icon the settled card will use
- `web/src/index.css` — `.tx-task`

## Important symbols

- `subagentParentId(msg)` — pure predicate; returns the owning spawn call's id, or
  `null` for main-agent messages
- `Sink` / `sinkFor(parentId)` — per-agent assistant-message accumulator (`items`,
  `openGroup`, `lastText`) used while building the transcript; the main agent and
  each subagent get their own, so concurrent subagents can't merge into one tool
  group
- `ToolBlock.children` — a spawn block's nested `TranscriptItem[]`, populated by
  its subagent's sink
- `scanTurnActivity(events)` — pure; the tool-call/error/final-text scan behind the
  turn summary, subagent-excluded
- `isAgentTool(name)` — true for `'Agent'` or `'Task'`; the harness names the
  spawn tool `Agent`, the SDK's own types/docs call it `Task`, and persisted
  transcripts contain both, so every consumer matches on this rather than one
  literal
- `parseTaskInput(input)` — defensively parses a spawn call's input into
  `{description, prompt, subagentType, model, background, name, mode, isolation}`;
  every field is `typeof`-guarded and a missing `description` falls back to the
  prompt's first line, never throws
- `agentMeta(subagentType)` / `MAIN_AGENT_META` — the single source of truth for an
  agent's badge icon and colour, read by both `TaskHeader` and `ActivityRow`
- `taskFlags(call)` — the non-default options on a spawn call (`run_in_background`,
  `isolation`, non-default `mode`) as tooltipped icons; empty when the call has
  none

## Data flow

Worker → bridge: every SDK message (including subagent ones) is forwarded and
persisted verbatim, `parent_tool_use_id` included — this predates the feature, so
existing transcripts already carry the field and gain nesting on reload with no
migration.

Server (`handleWorkerEvent`): an `assistant` message only updates the live
`contextUsage` reading when `subagentParentId` is null. `collectTurns` skips any
`sdk` event with a non-null `subagentParentId` before scanning for turn output.
`summarizeTurn` calls `scanTurnActivity`, which applies the same skip before
building the tool-call list handed to the Haiku summarization prompt (the spawn
call itself survives — it's a main-agent tool use — so the summary still reads as
"spawned an Explore subagent").

Web (`buildTranscript`): one pass over events, routing each `assistant` message
through `sinkFor(subagentParentId(msg))`. A `null` parent id (or a parent id
naming a spawn block no longer in `toolBlocks` — e.g. a truncated transcript)
resolves to the main sink; otherwise the message's items land in
`toolBlocks.get(parentId).children`. Tool results (SDK `user` messages) need no
special handling — `toolBlocks` is a flat id-keyed map, so a nested tool's result
finds it by id regardless of which sink created it. `sinks.clear()` on every turn
boundary (`user`, `workflow`, `result`) so a new turn starts with no stale subagent
sinks. Live activity (`stream_event`) resolves `subagentType` from
`toolBlocks.get(parentId)?.input.subagent_type` when the spawning call is already
known.

Rendering: `ToolCallCard` detects a spawn call with `isAgentTool(tool.name)` and
renders `TaskHeader` in place of the generic badge+summary — an agent-identity
badge (icon + label from `agentMeta`/`MAIN_AGENT_META`, coloured violet for a
subagent, blue for the main agent, red on error) followed by the call's
`description` as the primary text (not dimmed, not monospace), a cluster of
tooltipped flag icons from `taskFlags`, and the nested `groupSummary` tally. The
card itself gets the `.tx-task` container class (an inset violet accent + tint)
so a subagent run reads as one unit rather than an ordinary row. Expanding the
card renders the subagent's own transcript (via the `renderNested` callback
threaded down from `Transcript.Item`), then `TaskBody`'s prompt disclosure — see
[[tool-call-structured-input]] for the field-list/raw-input treatment every other
tool gets in the same body slot. `ActivityRow` renders the identical
`agentMeta`/`MAIN_AGENT_META` icon (in the same colour) while the turn is still
running, so the live row and the card that replaces it always match; the main
agent's row is icon-only (no label prefix) since the session is already known to
be talking to it.

## Dependencies

- `.claude/agents/` reaches sessions through `settingSources`, matching how the
  whole Claude Code preset is inherited — there is no separate `agents` option in
  `buildQueryOptions`.
- The spawn tool is auto-allowed by `server/src/autoGuard.ts`, so a spawn never
  prompts.
- [[transcript-markdown-rendering]] — the nested subagent body is a third level of
  the borderless-row/lazy-body convention documented there.
- [[tool-call-structured-input]] — the field-list body, raw-input toggle, and
  expand-gating a spawn card shares with every other tool card.
- [[context-window-inspector]] — the fallback context-usage reading this feature
  gates is documented there; this feature only adds the main-agent-only
  restriction.

## Tests

- `server/src/sessions.turns.test.ts` — a subagent's final text landing after the
  main agent's does not become the turn output; a subagent's `ExitPlanMode`/plan-
  file write does not turn an ordinary turn into a plan turn; `scanTurnActivity`
  drops a subagent's tool calls while keeping its parent spawn call and the main
  agent's final text. These build spawn inputs with only `subagent_type` +
  `description` — exactly the degraded path `parseTaskInput` must handle.
- `server/src/sessions.context.test.ts` — `subagentParentId` recognizes a subagent
  message and returns `null` for a main-agent one; documents the gate
  `handleWorkerEvent` applies (the extractor itself is agent-agnostic).
- No web test infrastructure covers `buildTranscript`'s sink routing or the nested
  rendering — verified manually only (spawn a subagent, confirm nesting, live
  label/icon/colour match, agent badge on reload, context ring, and reload
  back-compat).

## Business rules

- A subagent's assistant text and tool calls are never counted as main-agent
  output: workflow step output (`collectTurns`), the turn summary
  (`scanTurnActivity`), and the live context-usage reading (`handleWorkerEvent`)
  are all derived from main-agent messages only.
- A subagent's tool calls and text nest under its spawning card
  (`ToolBlock.children`), never inline in the main transcript or folded into the
  main agent's tool group.
- A subagent cannot itself spawn another subagent (harness restriction), so
  nesting is one level deep in practice; the data model (`children:
  TranscriptItem[]`) is recursive, so a deeper tree would render rather than
  break.
- A message whose `parent_tool_use_id` names a spawn block that isn't in
  `toolBlocks` (truncated transcript, compaction) falls back to the main sink
  instead of being dropped.
- A spawn card leads with `description`, not the tool name — the tool name
  ("Agent"/"Task") carries no information a reader wants first.
- An unmapped or plugin-scoped `subagent_type` (e.g. `caveman:cavecrew-builder`)
  degrades to a generic agent badge (violet, robot icon, the raw identifier —
  prefix stripped, truncated — as the label) rather than being hidden or
  crashing; `subagent_type` is a free-form, user- and plugin-defined string that
  the seed map can never fully cover.
- The main agent and a subagent share the same badge icon but never the same
  colour (blue vs violet), so which one is running/spoke reads from colour alone
  before any label is read.

## Architectural rules

- Existing transcripts already carry `parent_tool_use_id` on disk (the worker
  persists every SDK message verbatim) — this feature is a pure read-side
  reinterpretation, no new capture and no migration.
- No `agents` option was added to `buildQueryOptions`; subagent definitions are
  inherited via `settingSources`, the same mechanism that already inherits the
  rest of the preset.
- The spawn tool's name is not a stable literal: the harness emits `'Agent'`, the
  SDK's own `AgentInput` type and docs call it `'Task'`, and both appear in
  persisted transcripts. Every consumer checks `isAgentTool(name)` instead of a
  single string comparison.
- `agentMeta`/`MAIN_AGENT_META` in `web/src/lib/agents.ts` is the single source of
  truth for agent icon/colour, read by both the settled `TaskHeader` and the live
  `ActivityRow` — a running agent and the card that replaces it cannot drift
  apart.
- `parseTaskInput` never throws and never assumes a field is present: `AgentInput`
  gains fields the map won't know about (`effort` is the live example — used in
  practice, absent from the SDK's own type at time of writing), so the raw-input
  toggle stays reachable behind every spawn card rather than being dropped once
  structured rendering shipped.
- `ToolCallCard` cannot import `Transcript.tsx`'s `Item` (an import cycle, since
  `Transcript.tsx` already imports `ToolGroup` → `ToolCallCard`); nested rendering
  is threaded down as a `renderNested` callback instead of a new shared module.
- `.tx-task`'s container accent uses `box-shadow: inset` plus an asymmetric
  `margin-inline` (not a real border) so the chevron stays in the single column
  `.tx-row` maintains for every other row, at every nesting depth.
- `foldAgentTurns` needed no change: subagent items live inside
  `ToolBlock.children`, never in the top-level item array it operates on.

## Related decisions

None recorded.
