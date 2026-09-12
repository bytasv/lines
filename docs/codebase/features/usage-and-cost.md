# Usage and cost

Covers: `usage-indicator`, `usage-by-model`, `session-sidebar-usage`, `workflow-step-cost`.

## Purpose

Every place spend is measured and shown, all fed by the same accumulate-on-`result` pass in
`server/src/sessions.ts`:

- **Plan usage** — the logged-in user's Claude-plan usage (5-hour / weekly windows, same data as
  Claude Code's `/usage`) as a ring-progress chip with a hover-card breakdown.
- **Spend by model** — chat-turn spend split by the model that produced it, so the plan-usage
  hover card can show a `/usage`-style breakdown instead of the single untagged cost/token
  totals on `SessionMeta`.
- **Per-session** — cost, tokens, active-turn duration and creation date in the sidebar session
  list, so users can see at a glance which sessions are expensive or slow without opening them.
- **Per-workflow-step** — the same three numbers in the workflow stepper, so users can see which
  step of a running workflow is expensive or slow without opening the transcript.

## Entry points

- Top-bar `UsageIndicator` chip
- `UsageIndicator` hover card — "Spend by model" section, plus a "This session" sub-section when
  the selected session used more than one model
- Sidebar session row meta line (date, cost, token icon, duration, status badge)
- `web/src/components/WorkflowStepper.tsx` (cost label, token icon, and duration label in a
  metrics row below each step name)

## Files

- `server/src/usage.ts` — `UsagePoller`
- `web/src/store.ts` — `hello` and `usage` message handling
- `web/src/components/UsageIndicator.tsx` — the chip, the global rollup, and the current
  session's rows
- `shared/types.ts` — `UsageSnapshot`, `UsageWindow`, `ModelSpend`, `ModelSpendMap`,
  `SessionMeta.costByModel`, `SessionMeta.totalCostUsd`, `SessionMeta.totalTokens`,
  `SessionMeta.totalDurationMs`, `WorkflowState.stepCostsUsd`, `WorkflowState.stepTokens`,
  `WorkflowState.stepDurationsMs`
- `shared/usageByModel.ts` — `addSpend`, `mergeSpend`, `sortedSpend`
- `server/src/sessions.ts` — accumulates cost/tokens/duration from each turn's SDK `result`
  message; tags each settled turn's spend onto `costByModel`; sets `SessionMeta.lastTokens` /
  `SessionMeta.lastDurationMs` per turn
- `server/src/workflows.ts` — `WorkflowEngine.onWorkflowTurnComplete` (accumulates all three
  per-step numbers)
- `web/src/components/Sidebar.tsx` — renders date (EU format), cost, token icon + tooltip,
  duration
- `web/src/components/WorkflowStepper.tsx` — renders the amount, the token tooltip, and the
  duration
- `web/src/lib/format.ts` — `formatDuration`

## Symbols

- `UsagePoller` — polls `api.anthropic.com/api/oauth/usage`, broadcasts `{type: 'usage', ...}`
- `UsageSnapshot`, `UsageWindow` (`shared/types.ts`)
- `UsageIndicator` — renders the chip, gated on `auth.loggedIn`
- `ModelSpend` — `{ costUsd, tokens, turns }` for one model id
- `ModelSpendMap` — `Record<modelId, ModelSpend>`
- `SessionMeta.costByModel` — per-session spend map, keyed by resolved model id
- `addSpend(map, modelId, costUsd, tokens)` — mutates, creating the row on first sight, always
  incrementing `turns` once per call
- `mergeSpend(maps)` — sums an array of (possibly `undefined`) maps into one rollup
- `sortedSpend(map)` — rows ordered by `costUsd` descending
- `SessionMeta.totalCostUsd` — cumulative USD cost across the session
- `SessionMeta.totalTokens` — cumulative tokens across the session (input + output + cache
  creation + cache read), summed from `result.usage` per turn
- `SessionMeta.totalDurationMs` — cumulative active-turn duration across the session in ms,
  summed from `result.duration_ms` per turn minus that turn's permission-wait time; excludes
  idle wait between turns and human approval wait within a turn
- `SessionsStore` result handler in `server/src/sessions.ts` — where all the totals accumulate
- `SessionMeta.lastTokens` — tokens spent by the most recent turn (input + output + cache), same
  composition as `totalTokens`
- `SessionMeta.lastDurationMs` — active-turn duration of the most recent turn: the SDK `result`
  message's `duration_ms` minus that turn's accumulated `LiveState.permissionWaitMs` (so
  plan-mode / tool-approval waits don't count as step time)
- `WorkflowState.stepCostsUsd` — `number[]` indexed by step position, cumulative across retries
- `WorkflowState.stepTokens` — `number[]` indexed by step position, cumulative across retries
- `WorkflowState.stepDurationsMs` — `number[]` indexed by step position, cumulative active-turn
  duration across retries; excludes idle wait between turns
- `WorkflowEngine.onWorkflowTurnComplete` — adds `meta.lastCostUsd` onto
  `stepCostsUsd[stepIndex]`, `meta.lastTokens` onto `stepTokens[stepIndex]`, and
  `meta.lastDurationMs` onto `stepDurationsMs[stepIndex]` each time a workflow turn completes
- `formatDuration` — renders ms as `Xs` / `Xm Ys` / `Xh Ym`

## Data flow

### Plan usage

`UsagePoller.start()` fetches on an interval and after turn completion (debounced via
`refreshSoon`), broadcasting snapshots to all clients. `hello` also carries the current snapshot
for newly connecting clients. The store merges both into `state.usage`; `UsageIndicator` renders
from it.

### Spend by model

SDK `result` message → the same accumulate-on-`result` pass in `server/src/sessions.ts` that
already owns `totalCostUsd`/`totalTokens` also calls
`addSpend(metaNow.costByModel, resolveModelId(metaNow.model), cost, turnTokens)` → persisted via
the `SessionMeta` upsert → `UsageIndicator` reads
`mergeSpend(sessions.map(s => s.costByModel))` for the global rollup and `session.costByModel`
for the current session, both rendered via `sortedSpend`.

### Per-session totals

SDK `result` message (`total_cost_usd`, `usage`, `duration_ms`) → `SessionMeta.totalCostUsd` /
`totalTokens` accumulated per turn; `duration_ms` minus the turn's accumulated
`LiveState.permissionWaitMs` (tracked from `askPermission` start to resolution, across every
permission prompt in the turn) → `SessionMeta.totalDurationMs` → persisted via `SessionMeta`
upsert → sidebar reads from the session store and renders `totalDurationMs` via
`formatDuration`.

### Per-step totals

SDK `result` message → `SessionMeta.lastCostUsd` / `lastTokens` / `lastDurationMs` (the same
accumulation) → read by `onWorkflowTurnComplete` and added onto
`WorkflowState.stepCostsUsd[stepIndex]` / `stepTokens[stepIndex]` / `stepDurationsMs[stepIndex]`
→ persisted on `SessionMeta` upsert → `WorkflowStepper` renders `stepCostsUsd[i]` as a `$X.XX`
label, `stepTokens[i]` as a coin icon with a "N tokens spent" tooltip, and `stepDurationsMs[i]`
via `formatDuration`, all in a metrics row below the step name.

## Dependencies

- Shared `AuthManager` for the OAuth access token used to call the usage endpoint.
- `ModelOption[]` from the store (for model id → label), the same list
  [model-selector](model-selector.md) reads.
- `@tabler/icons-react` (`IconCoins`), Mantine `Tooltip`/`Text`/`Center`.

## Tests

- `server/src/usageByModel.test.ts` — `addSpend`/`mergeSpend`/`sortedSpend` pure-function
  behavior.
- `server/src/sessions.ended.test.ts` — a settled `result` splits spend under the session's
  model, a `setModel()` between turns opens a second row instead of moving the first, and a
  result with neither cost nor usage opens no row.
- No test infrastructure covers `UsagePoller`, the Sidebar/`SessionMeta` display, or
  `WorkflowStepper` rendering at time of writing; natural first targets are `UsagePoller`
  (mocked `fetch`/`AuthManager`) and `parseSnapshot`.

## Business rules

- No login → no usage chip. Enforced both server-side (poller never fetches without a session,
  logout nulls the snapshot) and client-side (`UsageIndicator` gates on `auth.loggedIn`).
- `{type: 'usage', usage: null}` means auth is gone (logout or a revoked/expired OAuth session) —
  nothing else. The poller is not the only discoverer of a dead session: a turn rejected for a
  bad token recovers or logs out on the spot (see [turn-recovery](turn-recovery.md)).
- A stale snapshot survives transient fetch failures (network blips, non-2xx responses);
  staleness is communicated to the user via "Updated Xm ago" in the hover card, never by hiding
  the chip.
- `hello` may arrive with `usage: null` before the poller's first fetch completes (e.g. right
  after a server restart); if the client is still logged in, the previously held snapshot is
  kept rather than cleared, so the chip does not flicker away on reconnect.
- Spend-by-model rows are keyed by `resolveModelId(meta.model)` — a retired stored model id
  folds into the same row as its replacement rather than opening a second one.
- A result carrying neither `total_cost_usd` nor `usage` opens no row (no zero-cost
  placeholder).
- Only chat-turn spend is counted. The internal helper queries (step-output consolidation,
  `autoName`, `summarizeTurn`) hardcode their own cheap model and their `total_cost_usd`/`usage`
  is never read, so their spend is excluded — the table under-reports true account spend by
  whatever those helpers cost.
- `costByModel` is additive and never backfilled: a session shows nothing until its next turn
  settles, same convention as `totalTokens`/`totalDurationMs`.
- The global rollup is derived client-side from the sessions the store already holds — deleting
  a session removes its spend from the rollup; there is no separate persisted total.
- The "Spend by model" section (and its "This session" sub-section) render nothing at all when
  the merged map is empty, rather than showing an empty header. The section inherits the usage
  chip's login gate rather than checking `auth.loggedIn` a second time.
- Sidebar cost shown as `$X.XX` (2 decimals); hidden entirely when `totalCostUsd` is unset.
- Sidebar token icon + tooltip (`"N tokens spent"`) hidden entirely when `totalTokens` is unset.
- Sidebar duration shown via `formatDuration`; hidden entirely when `totalDurationMs` is unset.
  Counts only active SDK turn time: excludes idle wait between turns AND any time spent waiting
  on a permission-prompt approval (e.g. plan-mode review) within a turn.
- Date rendered EU style (`en-GB`, dd/mm/yyyy), not browser-default locale.
- Existing sessions show no token icon or duration until their next turn completes (fields are
  additive, not backfilled).
- Hovering a sidebar row whose status shows a badge (not idle/running/done) swaps the badge for
  the date/cost/token/duration meta for the duration of the hover; the meta row reserves a fixed
  min-height so this swap doesn't shift row height.
- Step cost, tokens, and duration render in a metrics row below the step name (not inline with
  it), so the name has the full column width to itself.
- Step cost shown as `$X.XX` (2 decimals); hidden (rendered invisible, not removed) for a step
  whose accumulated cost is zero or unset, so the metrics row keeps a fixed height and other
  steps' rows don't jump when a value later appears. The token icon and the duration are hidden
  under the same zero/unset rule.
- Step duration counts only active SDK turn time: excludes idle wait between turns AND
  permission-prompt approval wait within a turn (e.g. a plan-mode review card left open) — so a
  step blocked on a slow approval doesn't read as an expensive step.
- Retries and auto-advance turns on the same step add onto the same array slot rather than
  overwriting it, for cost, tokens, and duration.

## Architectural rules

- No new message types for the usage chip — it follows the existing `sessionUpsert`-style
  broadcast conventions.
- Every spend number reuses the existing per-turn accumulation in `server/src/sessions.ts`
  instead of adding a new tracking mechanism: `totalTokens`/`totalDurationMs`, `costByModel`,
  and the per-step `lastCostUsd`/`lastTokens`/`lastDurationMs` all follow the same
  accumulate-on-`result` pass.
- No new persistence and no new ws message for spend-by-model: `costByModel` travels inside the
  existing `SessionMeta` blob, and the rollup is computed in the browser from data already
  pushed via `sessionUpsert`/`hello`.
- Duration is sourced from the SDK `result` event's `duration_ms` rather than clock math against
  `turnStartedAt`, so it excludes idle time by construction. Permission-wait deduction lives in
  `LiveState.permissionWaitMs` (transient, in-memory, not persisted) rather than
  `duration_api_ms` (the SDK's own API-only-time field), because `duration_api_ms` would also
  strip real tool-execution time (bash runs, file I/O), not just human approval wait — deducting
  only the measured prompt-to-resolution span keeps the duration "active work" without
  discarding genuine tool time.
- The permission-wait accumulator is reset to 0 both when a turn's `result` consumes it and
  whenever a turn dies without a `result` (worker crash/error, interrupt, or
  reconcile-on-reconnect), so stale wait time from a dead turn never leaks into the next turn's
  deduction.

## Related decisions

- [model-selector](model-selector.md) — the routing boundary for a planned follow-up (not yet
  started): using the spend-by-model table's numbers to justify subagent-only cheaper-model
  routing.
- [turn-recovery](turn-recovery.md) — the auth path that also discovers a dead OAuth session.

## Two providers

There are two plan-usage chips, one per connected account, rendered from one component so they
cannot drift. Each shows only its own provider's spend rows. The ChatGPT numbers come from
`GET https://chatgpt.com/backend-api/wham/usage` — the same endpoint the Codex CLI's own status
card reads — polled on the same cadence as the Claude one.

The `$` half of a spend row is dropped when a row has no cost: codex reports tokens but never a
price, and a column of `$0.00` reads as "these turns were free" rather than "we are not told".

Each chip wears its provider's mark, **always** — which vendor a number belongs to is part of
reading it, not a tiebreaker for when two are on screen. See
[openai-codex-sessions](openai-codex-sessions.md).
