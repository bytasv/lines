# Subagent transcript nesting

## Purpose

Attribute SDK messages to the agent that actually produced them. The harness already
runs the Claude Code preset with `settingSources: ['user','project']` and no
`allowedTools` restriction, so the `Task` tool is live and `.claude/agents/` definitions
load — a prompt can spawn subagents (Explore, Plan, custom agents) exactly like Claude
Code's CLI. Every SDK message carries `parent_tool_use_id` when it was produced by such a
subagent. This feature nests a subagent's transcript under its spawning `Task` card
instead of flattening it into the main agent's stream, and excludes subagent messages
from every piece of main-agent state (context usage, workflow step output, turn
summaries).

## Entry points

- A prompt that causes the agent to use the `Task` tool (e.g. "use the Explore agent to
  map server/src").
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
- `web/src/components/Transcript.tsx` — `Item`'s `renderNested` closure passed to
  `ToolGroup`
- `web/src/components/ToolGroup.tsx` — forwards `renderNested` to `ToolCallCard`
- `web/src/components/ToolCallCard.tsx` — Task-specific `summarizeInput`, violet badge +
  nested tool tally, nested body render
- `web/src/components/ActivityRow.tsx` — `label()` names the live subagent type

## Important symbols

- `subagentParentId(msg)` — pure predicate; returns the owning `Task` call's id, or
  `null` for main-agent messages
- `Sink` / `sinkFor(parentId)` — per-agent assistant-message accumulator (`items`,
  `openGroup`, `lastText`) used while building the transcript; the main agent and each
  subagent get their own, so concurrent subagents can't merge into one tool group
- `ToolBlock.children` — a `Task` block's nested `TranscriptItem[]`, populated by its
  subagent's sink
- `scanTurnActivity(events)` — pure; the tool-call/error/final-text scan behind the turn
  summary, subagent-excluded

## Data flow

Worker → bridge: every SDK message (including subagent ones) is forwarded and persisted
verbatim, `parent_tool_use_id` included — this predates the feature, so existing
transcripts already carry the field and gain nesting on reload with no migration.

Server (`handleWorkerEvent`): an `assistant` message only updates the live
`contextUsage` reading when `subagentParentId` is null. `collectTurns` skips any `sdk`
event with a non-null `subagentParentId` before scanning for turn output. `summarizeTurn`
calls `scanTurnActivity`, which applies the same skip before building the tool-call list
handed to the Haiku summarization prompt (the `Task` call itself survives — it's a
main-agent tool use — so the summary still reads as "spawned an Explore subagent").

Web (`buildTranscript`): one pass over events, routing each `assistant` message through
`sinkFor(subagentParentId(msg))`. A `null` parent id (or a parent id naming a `Task`
block no longer in `toolBlocks` — e.g. a truncated transcript) resolves to the main sink;
otherwise the message's items land in `toolBlocks.get(parentId).children`. Tool results
(SDK `user` messages) need no special handling — `toolBlocks` is a flat id-keyed map, so
a nested tool's result finds it by id regardless of which sink created it. `sinks.clear()`
on every turn boundary (`user`, `workflow`, `result`) so a new turn starts with no stale
subagent sinks. Live activity (`stream_event`) resolves `subagentType` from
`toolBlocks.get(parentId)?.input.subagent_type` when the spawning `Task` call is already
known.

Rendering: `ToolCallCard` shows a violet badge and a `groupSummary` tally of the nested
tools when `tool.children` is non-empty; expanding the card renders the subagent's own
transcript (via the `renderNested` callback threaded down from `Transcript.Item`) above
the raw Input/Result JSON. `ActivityRow` prefixes the live label with the subagent's type
once its `Task` call is known ("Explore: …"), falling back to "Subagent: …" until then.

## Dependencies

- `.claude/agents/` reaches sessions through `settingSources`, matching how the whole
  Claude Code preset is inherited — there is no separate `agents` option in
  `buildQueryOptions`.
- `Task` is auto-allowed by `server/src/autoGuard.ts`, so a spawn never prompts.
- [[transcript-markdown-rendering]] — the nested subagent body is a third level of the
  borderless-row/lazy-body convention documented there.
- [[context-window-inspector]] — the fallback context-usage reading this feature gates
  is documented there; this feature only adds the main-agent-only restriction.

## Tests

- `server/src/sessions.turns.test.ts` — a subagent's final text landing after the main
  agent's does not become the turn output; a subagent's `ExitPlanMode`/plan-file write
  does not turn an ordinary turn into a plan turn; `scanTurnActivity` drops a subagent's
  tool calls while keeping its parent `Task` call and the main agent's final text.
- `server/src/sessions.context.test.ts` — `subagentParentId` recognizes a subagent
  message and returns `null` for a main-agent one; documents the gate `handleWorkerEvent`
  applies (the extractor itself is agent-agnostic).
- No web test infrastructure covers `buildTranscript`'s sink routing or the nested
  rendering — verified manually only (spawn a subagent, confirm nesting, live label,
  context ring, and reload back-compat).

## Business rules

- A subagent's assistant text and tool calls are never counted as main-agent output:
  workflow step output (`collectTurns`), the turn summary (`scanTurnActivity`), and the
  live context-usage reading (`handleWorkerEvent`) are all derived from main-agent
  messages only.
- A subagent's tool calls and text nest under its spawning `Task` card
  (`ToolBlock.children`), never inline in the main transcript or folded into the main
  agent's tool group.
- A subagent cannot itself spawn a `Task` (harness restriction), so nesting is one level
  deep in practice; the data model (`children: TranscriptItem[]`) is recursive, so a
  deeper tree would render rather than break.
- A message whose `parent_tool_use_id` names a `Task` block that isn't in `toolBlocks`
  (truncated transcript, compaction) falls back to the main sink instead of being
  dropped.

## Architectural rules

- Existing transcripts already carry `parent_tool_use_id` on disk (the worker persists
  every SDK message verbatim) — this feature is a pure read-side reinterpretation, no
  new capture and no migration.
- No `agents` option was added to `buildQueryOptions`; subagent definitions are inherited
  via `settingSources`, the same mechanism that already inherits the rest of the preset.
- `ToolCallCard` cannot import `Transcript.tsx`'s `Item` (an import cycle, since
  `Transcript.tsx` already imports `ToolGroup` → `ToolCallCard`); nested rendering is
  threaded down as a `renderNested` callback instead of a new shared module.
- `foldAgentTurns` needed no change: subagent items live inside `ToolBlock.children`,
  never in the top-level item array it operates on.

## Related decisions

None recorded.
