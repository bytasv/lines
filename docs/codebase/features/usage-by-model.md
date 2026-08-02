# Usage by model

## Purpose

Splits chat-turn spend by the model that produced it, so the plan-usage hover card can show a
`/usage`-style breakdown ("Spend by model") instead of the single untagged cost/token totals on
`SessionMeta`.

## Entry points

- `UsageIndicator` hover card — "Spend by model" section, plus a "This session" sub-section
  when the selected session used more than one model

## Important files

- `shared/types.ts` — `ModelSpend`, `ModelSpendMap`, `SessionMeta.costByModel`
- `shared/usageByModel.ts` — `addSpend`, `mergeSpend`, `sortedSpend`
- `server/src/sessions.ts` — tags each settled turn's cost/tokens onto `costByModel`
- `web/src/components/UsageIndicator.tsx` — renders the global rollup and the current session's
  rows

## Important symbols

- `ModelSpend` — `{ costUsd, tokens, turns }` for one model id
- `ModelSpendMap` — `Record<modelId, ModelSpend>`
- `SessionMeta.costByModel` — per-session spend map, keyed by resolved model id
- `addSpend(map, modelId, costUsd, tokens)` — mutates, creating the row on first sight, always
  incrementing `turns` once per call
- `mergeSpend(maps)` — sums an array of (possibly `undefined`) maps into one rollup
- `sortedSpend(map)` — rows ordered by `costUsd` descending

## Data flow

SDK `result` message → the same accumulate-on-`result` pass in `server/src/sessions.ts` that
already owns `totalCostUsd`/`totalTokens` also calls `addSpend(metaNow.costByModel,
resolveModelId(metaNow.model), cost, turnTokens)` → persisted via the `SessionMeta` upsert →
`UsageIndicator` reads `mergeSpend(sessions.map(s => s.costByModel))` for the global rollup and
`session.costByModel` for the current session, both rendered via `sortedSpend`.

## Dependencies

`ModelOption[]` from the store (for model id → label), the same list `model-selector` reads.

## Tests

- `server/src/usageByModel.test.ts` — `addSpend`/`mergeSpend`/`sortedSpend` pure-function
  behavior
- `server/src/sessions.ended.test.ts` — a settled `result` splits spend under the session's
  model, a `setModel()` between turns opens a second row instead of moving the first, and a
  result with neither cost nor usage opens no row

## Business rules

- Rows are keyed by `resolveModelId(meta.model)` — a retired stored model id folds into the same
  row as its replacement rather than opening a second one.
- A result carrying neither `total_cost_usd` nor `usage` opens no row (no zero-cost placeholder).
- Only chat-turn spend is counted. The internal helper queries (step-output consolidation,
  `autoName`, `summarizeTurn`) hardcode their own cheap model and their `total_cost_usd`/`usage`
  is never read, so their spend is excluded — the table under-reports true account spend by
  whatever those helpers cost.
- `costByModel` is additive and never backfilled: a session shows nothing until its next turn
  settles, same convention as `totalTokens`/`totalDurationMs` in [[session-sidebar-usage]].
- The global rollup is derived client-side from the sessions the store already holds — deleting
  a session removes its spend from the rollup; there is no separate persisted total.
- The "Spend by model" section (and its "This session" sub-section) render nothing at all when
  the merged map is empty, rather than showing an empty header.

## Architectural rules

Reuses the existing per-turn accumulation in `server/src/sessions.ts` instead of adding a new
tracking mechanism — see [[session-sidebar-usage]] and [[workflow-step-cost]], which accumulate
`totalCostUsd`/`lastCostUsd` the same way. No new persistence and no new ws message: `costByModel`
travels inside the existing `SessionMeta` blob, and the rollup is computed in the browser from
data already pushed via `sessionUpsert`/`hello`.

## Related decisions

None recorded. Planned follow-up (not yet started): use this table's numbers to justify
subagent-only cheaper-model routing — see [[model-selector]] for the routing boundary once that
work begins.
