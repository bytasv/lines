# Context window inspector

## Purpose

Show live context-window occupancy in the composer — a small ring chip, and on hover a
breakdown of what is filling the window (system prompt, tools, MCP servers, memory files,
skills, agents, messages), so the user can see how full the context is and what's driving it,
distinct from the cumulative billing figures shown elsewhere.

## Entry points

- Composer toolbar `ContextWindowIndicator` chip, next to the cumulative `totalCostUsd` text.

## Important files

- `shared/types.ts` — `ContextUsage`, `ContextCategory`, `ContextSummary`, `ContextBreakdown`,
  `SessionMeta.contextUsage` / `contextSummary` / `contextResetAt`, `contextWindowFor`,
  `preferContextSummary`, `contextDenominator`
- `server/src/sessions.ts` — `extractContextUsage`, `fetchContextBreakdown`,
  `resetClaudeSession`
- `server/src/contextBreakdown.ts` — `normalizeContextBreakdown`, `summarizeContextBreakdown`,
  `sameContextSummary`, `sumNonDeferred`
- `server/src/workerProtocol.ts`, `server/src/worker.ts`, `server/src/workerClient.ts` — the
  bridge↔worker `ask`/`askResult` control-request channel
- `server/src/index.ts` — `contextBreakdown` client-message handler
- `web/src/store.ts` — `contextBreakdowns` state, `requestContextBreakdown`
- `web/src/components/ContextWindowIndicator.tsx`
- `web/src/lib/format.ts` — `formatTokens`, `usageColor`

## Important symbols

- `Query.getContextUsage()` (SDK) — the same data behind the CLI's `/context` command
- `ContextUsage` — fallback reading derived from the last `assistant` message's `usage`
- `ContextSummary` / `ContextBreakdown` — persisted summary vs. ephemeral full breakdown of
  the SDK's category data
- `extractContextUsage(msg, model, at)` — pure, derives the fallback reading
- `normalizeContextBreakdown(raw, at)` / `summarizeContextBreakdown(full)` — pure, project the
  raw SDK control-response into the two shapes above
- `fetchContextBreakdown(sessionId)` — coalescing, best-effort ask to the live query
- `preferContextSummary`, `contextDenominator` — shared precedence/denominator logic used by
  both the server (persistence) and the UI (rendering)

## Data flow

Server: on turn settle, `handleWorkerEvent`'s `result` branch commits the fallback
`contextUsage` (derived per-`assistant`-message, unchanged from before this feature) and
fire-and-forget calls `fetchContextBreakdown`, which asks the worker's live `Query` handle via
a new bridge→worker `ask`/`askResult` channel (`AskMethod = 'contextUsage'`,
`PROTOCOL_VERSION` 1→2) for `getContextUsage()`. A successful ask is normalized, summarized,
and — only when it differs from the previous summary — committed to
`SessionMeta.contextSummary` and upserted (broadcast + persisted + synced). A failed ask
(no live session, worker down, older CLI) resolves `null` and is not logged as an error.

Browser: `sessionUpsert` carries `contextUsage`/`contextSummary`/`contextResetAt` like any
other `SessionMeta` field — no dedicated push message. Hovering the chip additionally sends
`{type: 'contextBreakdown', sessionId}`; the bridge re-asks the worker and replies
`{type: 'contextBreakdown', sessionId, breakdown}` with the full per-item detail (MCP tools by
server, memory file paths, agents, skills, message composition), held only in
`store.contextBreakdowns` (never persisted).

`ContextWindowIndicator` renders the SDK breakdown when available (`preferContextSummary`),
falling back to the four-component `ContextUsage` card otherwise, and renders nothing before
either exists.

## Dependencies

- `@anthropic-ai/claude-agent-sdk`'s `Query.getContextUsage()` control request (worker-only;
  requires a live query for the session).
- `ModelOption.contextWindow` (hardcoded 200k on `DEFAULT_MODELS`) as the fallback-path
  denominator only — the SDK breakdown's own `maxTokens` is used whenever it's available.
- [[context-compaction]] — corrects this feature's occupancy reading after a compaction and adds
  the manual "Compact now" action + near-limit warning to the same indicator.

## Tests

- `server/src/sessions.context.test.ts` — `extractContextUsage` coercion, missing-usage,
  residual-total detection.
- `server/src/contextBreakdown.test.ts` — `normalizeContextBreakdown` (full fixture, MCP
  grouping, deferred exclusion, older-CLI partial payloads, malformed input, NaN coercion),
  `summarizeContextBreakdown` (detail stripped, free-space/zero rows dropped, size-budget
  guard), `sameContextSummary`, `preferContextSummary`, `contextDenominator`.

## Business rules

- Occupancy is sourced from the SDK's `/context` control request (`getContextUsage()`) when a
  live query exists; the fallback (`ContextUsage`, derived from the last `assistant` message's
  `usage`) is used only when it isn't — never from `result.usage`, which is cumulative across
  every API call in the turn, not a point-in-time occupancy reading.
- No reading yet → no chip (`return null`), in both fallback and SDK modes.
- Unknown model window → raw token count text, no ring, no guessed denominator.
- SDK category rows must sum to the shown total in both modes; the fallback mode surfaces any
  SDK-reported/component-sum mismatch as an explicit "Unaccounted" row instead of hiding it.
- Deferred categories (tools not yet loaded into context) are excluded from the total and from
  "Free space," and rendered with no percentage share — folding them in would double-count.
- `SessionMeta.contextSummary` is capped (≤16 non-zero, non-free-space rows) and holds no
  per-item detail — it is persisted to disk and pushed through storage sync, so it must stay
  small; per-item detail (MCP tools, memory files, agents, skills) is fetched on demand and
  never persisted.
- A hover-triggered summary refresh only upserts (broadcasts + syncs) when the summary actually
  changed, so opening the hover card repeatedly does not generate sync traffic.
- When a workflow step resets the Claude session (fresh start), `contextResetAt` is stamped;
  any reading older than that is rendered as stale (dimmed ring, explanatory footnote) until the
  next turn reports a fresh value — the underlying conversation it described no longer exists.
- The fallback reading is main-agent-only: an `assistant` message produced by a subagent
  (`parent_tool_use_id` set) never updates it, so a spawned Task's small context can't clobber
  the ring with a number that isn't the main agent's — see [[subagent-transcript]].
- Lines does not set `autoCompactEnabled` and has no control over the CLI's own background
  auto-compaction — the hover card's auto-compact row (`isAutoCompactEnabled`,
  `autoCompactThreshold`) is a straight passthrough of whatever the CLI itself resolved through
  `settingSources`. The row is shown even when the CLI reports it off, naming the CLI as the
  owner, rather than hidden — so "off" reads as a setting, not a missing feature. See
  [[context-compaction]] for the manual alternative.

## Architectural rules

- The bridge↔worker protocol gained a generic `ask`/`askResult` request/response method
  (`AskMethod`) rather than a one-off message type, so future control requests don't require
  another `PROTOCOL_VERSION` bump (which restarts the worker and drops in-flight turns).
- The worker returns raw SDK JSON from `ask`; all normalization lives in
  `server/src/contextBreakdown.ts` as pure, defensively-coerced functions, keeping the worker's
  import graph unchanged (stdlib + ws + SDK + workerProtocol only).
- The existing cumulative fields (`lastTokens`, `totalTokens`) are untouched — this feature adds
  a parallel occupancy reading rather than reusing or altering the billing one.

## Related decisions

None recorded.
