# Context window

Covers: `context-window-inspector`, `context-compaction`.

## Purpose

Show live context-window occupancy in the composer — a small ring chip, and on hover a
breakdown of what is filling the window (system prompt, tools, MCP servers, memory files,
skills, agents, messages), so the user can see how full the context is and what's driving it,
distinct from the cumulative billing figures shown elsewhere.

On top of that reading: let the user manually compact a session's context (summarize the
conversation so far and replace it, freeing window space) from the app, and passively warn when
a session is near its context limit — without ever auto-firing compaction on the user's behalf.
Compaction also surfaces the CLI's own background auto-compaction (which already runs today via
`settingSources`) as a readable transcript event instead of an opaque dropped message, and
corrects the occupancy reading afterwards.

## Entry points

- Composer toolbar `ContextWindowIndicator` chip, next to the cumulative `totalCostUsd` text.
- `ContextWindowIndicator`'s "Compact now" button (in its hover-card dropdown).
- Passive near-limit warning badge on the same indicator.

## Files

- `shared/types.ts` — `ContextUsage`, `ContextCategory`, `ContextSummary`, `ContextBreakdown`,
  `SessionMeta.contextUsage` / `contextSummary` / `contextResetAt`, `contextWindowFor`,
  `preferContextSummary`, `contextDenominator`; `ContextCompactRecord`, `ContextCompactData`,
  `SessionMeta.contextCompact`, `ClientMessage` (`compactContext`), `CONTEXT_WARN_PCT`,
  `effectiveContextTokens`, `contextCompactBlock`, `canCompactContext`
- `server/src/sessions.ts` — `extractContextUsage`, `fetchContextBreakdown`,
  `resetClaudeSession`, `withoutCompactSpans`, `extractCompactBoundary`, `extractCompactStatus`,
  `SessionManager.compactContext`, `SessionManager.abandonCompaction`, the
  `compact_boundary`/`status` branches in `handleWorkerEvent`
- `server/src/contextBreakdown.ts` — `normalizeContextBreakdown`, `summarizeContextBreakdown`,
  `sameContextSummary`, `sumNonDeferred`
- `server/src/workerProtocol.ts`, `server/src/worker.ts`, `server/src/workerClient.ts` — the
  bridge↔worker `ask`/`askResult` control-request channel
- `server/src/index.ts` — `contextBreakdown` and `compactContext` client-message handlers
- `web/src/store.ts` — `contextBreakdowns` state, `requestContextBreakdown`
- `web/src/lib/transcript.ts` — `'context-compact'` event → `ContextCompactItem`
- `web/src/components/Transcript.tsx` — `ContextCompactMarker`
- `web/src/components/ContextWindowIndicator.tsx` — ring chip, hover card, `CompactButton`,
  near-limit badge
- `web/src/lib/format.ts` — `formatTokens`, `usageColor`

## Symbols

- `Query.getContextUsage()` (SDK) — the same data behind the CLI's `/context` command
- `ContextUsage` — fallback reading derived from the last `assistant` message's `usage`
- `ContextSummary` / `ContextBreakdown` — persisted summary vs. ephemeral full breakdown of the
  SDK's category data
- `extractContextUsage(msg, model, at)` — pure, derives the fallback reading
- `normalizeContextBreakdown(raw, at)` / `summarizeContextBreakdown(full)` — pure, project the
  raw SDK control-response into the two shapes above
- `fetchContextBreakdown(sessionId)` — coalescing, best-effort ask to the live query
- `preferContextSummary`, `contextDenominator` — shared precedence/denominator logic used by
  both the server (persistence) and the UI (rendering)
- `contextCompactBlock(meta)` — single predicate (server guard + button `disabled` + tooltip)
  deciding whether compaction can run right now, with a `{ code, reason }` explaining why not
- `effectiveContextTokens(meta)` — occupancy reading that self-corrects onto
  `contextCompact.postTokens` once a compaction (manual or the CLI's own auto-compaction) lands
  after the last measured turn
- `withoutCompactSpans(events)` — strips a compaction (and its transcript markers) from a
  transcript slice before any turn scan
- `SessionManager.compactContext(sessionId)` — the manual trigger
- `extractCompactStatus(msg)` — reads an SDK `system`/`status` message's `compact_result`
  (`'success' | 'failed'`) and `compact_error`; this is the authoritative outcome of a manual
  compaction, unlike the mere absence of a `compact_boundary`

## Data flow

### Occupancy reading

Server: on turn settle, `handleWorkerEvent`'s `result` branch commits the fallback
`contextUsage` (derived per-`assistant`-message) and fire-and-forget calls
`fetchContextBreakdown`, which asks the worker's live `Query` handle via the bridge→worker
`ask`/`askResult` channel (`AskMethod = 'contextUsage'`, `PROTOCOL_VERSION` 1→2) for
`getContextUsage()`. A successful ask is normalized, summarized, and — only when it differs
from the previous summary — committed to `SessionMeta.contextSummary` and upserted (broadcast +
persisted + synced). A failed ask (no live session, worker down, older CLI) resolves `null` and
is not logged as an error.

Browser: `sessionUpsert` carries `contextUsage`/`contextSummary`/`contextResetAt` like any other
`SessionMeta` field — no dedicated push message. Hovering the chip additionally sends
`{type: 'contextBreakdown', sessionId}`; the bridge re-asks the worker and replies
`{type: 'contextBreakdown', sessionId, breakdown}` with the full per-item detail (MCP tools by
server, memory file paths, agents, skills, message composition), held only in
`store.contextBreakdowns` (never persisted).

`ContextWindowIndicator` renders the SDK breakdown when available (`preferContextSummary`),
falling back to the four-component `ContextUsage` card otherwise, and renders nothing before
either exists.

### Compaction

Manual compaction does not go through `prompt()`. `compactContext` checks `contextCompactBlock`,
marks the session `running`, emits a `'context-compact'` `{phase:'requested'}` transcript event,
and pushes a user turn whose sole content block is the literal text `/compact` through the
existing worker `push()` path — the same mechanism the CLI's own `/compact` slash command
dispatches through (`supportsNonInteractive` + `post-text` dispatch). This is reverse-engineered
from the CLI binary, not a published SDK contract, so nothing downstream assumes it works.

`handleWorkerEvent` watches every message for an SDK `system`/`compact_boundary`
(`extractCompactBoundary`), which arrives for both a manual and the CLI's own background
auto-compaction (already enabled via `settingSources: ['user','project']`). On a boundary:
`SessionMeta.contextCompact` is written (`{at, trigger, preTokens, postTokens?, ok:true}`), a
`'context-compact'` `{phase:'done'}` event is emitted, and every context-usage reading already
collected in that turn is discarded (`LiveState.compactedInTurn`) since it may describe either
side of the boundary.

`handleWorkerEvent` also watches for an SDK `system`/`status` message carrying a `compact_result`
(`extractCompactStatus`) while a manual compaction is in flight — this is the authoritative
pass/fail verdict, not an inference from a missing boundary. `'success'` (a boundary-less
success) writes `contextCompact` with `ok:true`, same as a boundary. `'failed'` writes `ok:false`
plus the SDK's own `compact_error` text, and this is the *only* thing that flips
`contextCompactBlock` to its `unsupported` code — the button disables with the SDK's own
explanation in the tooltip. If the pushed turn instead settles at `result` with neither a
boundary nor a status verdict having arrived, the outcome is inconclusive, not unsupported:
`abandonCompaction` closes the transcript span (so scans aren't left inside an open span
forever) but writes no `contextCompact` record, leaving the button enabled for the next attempt.

A compaction can run on a workflow step parked `waiting-approval`, or on a session sitting at
`error` with a failed step's red banner — the manual button is not blocked there (see Business
rules). Both cases run as an ordinary `running` turn, which would otherwise land on `done` at
settle and erase the park or the banner. `compactContext` snapshots the covered status onto
`LiveState.compactResume` (`{status, errorMessage, errorKind}`, per-process, never persisted);
`restoreCompactedStatus` puts it back on every path that ends the turn — the `result` settle
branch, `abandonCompaction` (covers a stopped compaction and a query that dies mid-compaction),
and, if the bridge itself dies mid-compaction, `reconcileWithWorker` re-derives the park from
`WorkflowState.stepStatuses` instead (`compactResume` is lost with the process) — see
[turn-recovery](turn-recovery.md). While the turn is live, `WorkflowEngine` holds every step
control (approve, force-advance, retry, a typed prompt) so nothing races the in-flight
`/compact` — see [workflow-step-lifecycle](workflow-step-lifecycle.md).

The browser renders `'context-compact'` transcript events as a divider line ("Compacting…", then
upgraded in place to "Compacted: X → Y tokens" or an error), and the indicator recomputes its
ring/warning from `effectiveContextTokens` on every `SessionMeta` update.

## Dependencies

- `@anthropic-ai/claude-agent-sdk`'s `Query.getContextUsage()` control request (worker-only;
  requires a live query for the session).
- `ModelOption.contextWindow` (hardcoded 200k on `DEFAULT_MODELS`) as the fallback-path
  denominator only — the SDK breakdown's own `maxTokens` is used whenever it's available.
- The SDK's undocumented `/compact`-via-prompt-text dispatch — can silently change or disappear
  in a future `@anthropic-ai/claude-agent-sdk` bump.
- `SDKStatusMessage` (`system`/`status`, carrying `compact_result`/`compact_error`) — the
  authoritative pass/fail signal for a manual compaction; also undocumented as a contract,
  though the type itself ships in the SDK's `.d.ts`.

## Tests

- `server/src/sessions.context.test.ts` — `extractContextUsage` coercion, missing-usage,
  residual-total detection.
- `server/src/contextBreakdown.test.ts` — `normalizeContextBreakdown` (full fixture, MCP
  grouping, deferred exclusion, older-CLI partial payloads, malformed input, NaN coercion),
  `summarizeContextBreakdown` (detail stripped, free-space/zero rows dropped, size-budget
  guard), `sameContextSummary`, `preferContextSummary`, `contextDenominator`.
- `server/src/sessions.compact.test.ts` — `withoutCompactSpans` (matched span, unmatched
  `requested` bounded to the next `user` event not end-of-array, findStepStart/collectTurns
  same-array regression), `extractCompactBoundary`, `extractCompactStatus`,
  `effectiveContextTokens` precedence, `contextCompactBlock` per block code, the latch
  lifecycle (a silent turn writes no record, an explicit SDK failure/success does, a fresh CLI
  conversation clears a latched verdict), and status restore (a parked step's compaction settles
  back to `waiting-approval` not `done`, a failed step's banner survives, a compaction that
  itself fails does not become the session failure, stopping/killing the query mid-compaction
  still restores the park).
- `server/src/workflows.advance.test.ts` — step controls (approve, force-advance, a typed
  prompt) refuse while a parked step is compacting; a prompt queued during the compaction drains
  into the same step (never advances) once it settles.

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
- When a workflow step resets the Claude session (fresh start), `contextResetAt` is stamped; any
  reading older than that is rendered as stale (dimmed ring, explanatory footnote) until the
  next turn reports a fresh value — the underlying conversation it described no longer exists.
- The fallback reading is main-agent-only: an `assistant` message produced by a subagent
  (`parent_tool_use_id` set) never updates it, so a spawned Task's small context can't clobber
  the ring with a number that isn't the main agent's — see
  [transcript-rendering](transcript-rendering.md).
- Lines does not set `autoCompactEnabled` and has no control over the CLI's own background
  auto-compaction — the hover card's auto-compact row (`isAutoCompactEnabled`,
  `autoCompactThreshold`) is a straight passthrough of whatever the CLI itself resolved through
  `settingSources`. The row is shown even when the CLI reports it off, naming the CLI as the
  owner, rather than hidden — so "off" reads as a setting, not a missing feature.
- Lines never fires compaction itself — only a manual button and a passive warning badge. It is
  an irreversible, lossy, billable operation; timing is a judgement call left to the user. This
  is distinct from the CLI's own background auto-compaction, which Lines does not control and
  may or may not fire on its own schedule.
- The manual button is disabled whenever `contextCompactBlock` returns non-null, and the tooltip
  always states which of five reasons applies: a turn is running, a workflow step's approved
  output is being consolidated (`step-advancing`), the session has never run a turn, there is no
  occupancy reading yet, or the SDK explicitly reported the compaction as failed (`unsupported`,
  carrying the SDK's own error text when one was given).
- The `unsupported` latch requires an explicit SDK `compact_result: 'failed'` — a turn that
  settles with neither a boundary nor a status verdict is inconclusive and leaves the button
  enabled. The latch is also scoped to the CLI conversation that produced it: it is cleared on
  `resetClaudeSession`, on bridge-process restart (a previous process's verdict proves nothing
  about this one), and when a synced session adopts a remote update — so a genuinely unsupported
  setup re-latches on the next attempt rather than staying disabled forever.
- A workflow step parked `waiting-approval` does *not* block the manual button — every
  step hand-off (`lastAssistantText`, `consolidateStepOutput`, `{previous}`/`{outputs.*}`) reads
  the on-disk transcript through `withoutCompactSpans`, never the CLI's live context, so
  compacting under a parked step cannot corrupt it. The one real conflict is a *live advance*
  (`WorkflowState.advancing`) — an approve is consolidating the step's output and about to
  prompt the next step, which a compaction would race — and that blocks with the
  `step-advancing` code instead. Same is true of the CLI's own background auto-compaction, which
  Lines never blocks regardless.
- A compaction is invisible to every workflow turn scan (`consolidateStepOutput`,
  `lastAssistantText`, `summarizeTurn`, `retryTurn`) — it carries no `'user'` event of its own,
  so an unstripped span would register as a spurious extra "attempt" whose output is the
  compaction summary, corrupting the `{previous}`/`{outputs.*}` hand-off between steps.
  Permission bookkeeping (`unresolvedPermissionIds`, `expireUnresolvedPermissions`) does not
  strip compact spans — every permission event must stay visible there regardless.

## Architectural rules

- The bridge↔worker protocol gained a generic `ask`/`askResult` request/response method
  (`AskMethod`) rather than a one-off message type, so future control requests don't require
  another `PROTOCOL_VERSION` bump (which restarts the worker and drops in-flight turns).
- The worker returns raw SDK JSON from `ask`; all normalization lives in
  `server/src/contextBreakdown.ts` as pure, defensively-coerced functions, keeping the worker's
  import graph unchanged (stdlib + ws + SDK + workerProtocol only).
- The existing cumulative fields (`lastTokens`, `totalTokens`) are untouched — the occupancy
  reading is a parallel one rather than a reuse or alteration of the billing one.
- `compactContext` is a dedicated `SessionManager` method, not a call to `prompt()` — a
  compaction is not a user turn (no auto-naming, no queue interaction, no `'user'` transcript
  event).
- One shared predicate (`contextCompactBlock`) backs the server-side guard, the button's
  `disabled`, and its tooltip, rather than three independent conditionals that could drift.
- Naming: transcript event kind `'context-compact'`, its payload `ContextCompactData`,
  `SessionMeta.contextCompact` — all `contextCompact`-prefixed, distinct from the unrelated
  `compactionLevel` (transcript display density) already in `UserUiSettings`.
- `LiveState.compactResume` (the status a compaction covered) is deliberately not a
  `SessionMeta` field — it is per-process scratch state read back within the same compaction,
  never synced or persisted, so a bridge restart mid-compaction loses it cleanly rather than
  going stale on disk; `reconcileWithWorker` re-derives the park from `WorkflowState.stepStatuses`
  instead of trusting a resurrected copy.
- The browser's `buildTranscript` (`web/src/lib/transcript.ts`) mirrors the server's
  `withoutCompactSpans`: while a `'requested'` marker is open, every event but the matching
  `'done'` (or the next `'user'` event, bounding a crash mid-compaction) is dropped from the
  rendered transcript, not just hidden by the marker pair — otherwise a `/compact` that
  dispatched as ordinary prompt text leaks the model's literal reply into the timeline. A failed
  `result` (`isFailedResult`) is a third exception, alongside `'user'`: the server has already
  abandoned the span by the time that result is emitted, so the client lets it through too,
  rather than swallowing the only failure row Retry can key off — see
  [turn-recovery](turn-recovery.md).

## Related decisions

- [turn-recovery](turn-recovery.md) — the failed-result escape from an open compaction span on
  the client, so a turn that failed mid-compaction still gets a Retry-able failure row.
- [transcript-rendering](transcript-rendering.md) — why a subagent's `assistant` message never
  updates the fallback occupancy reading.
