# Usage and cost

Covers: `usage-indicator`, `usage-by-model`, `usage-history`, `session-sidebar-usage`,
`workflow-step-cost`, `transcript-turn-cost`.

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
- **Per-turn (transcript)** — cost + duration for one agent turn, rendered as a chip pair on
  the turn's Compact-level header card, or a small right-aligned meta line when there is no
  card (a text-only turn, or Full/Grouped level) — see
  [transcript-rendering](transcript-rendering.md#noise-reduction).
- **Usage history** — a day-resolution spend ledger, browsable by day/week/month/year from the
  same hover card, so "what did I spend this month?" has an answer beyond the all-time rollup.
- **Estimated spend** — a provider whose capability table says `cost: false` (OpenAI/codex) never
  reports a price, so its turns are priced from a static per-model rate table instead
  (`shared/estimateSpend.ts`) and every figure derived from that estimate is marked with a `~`
  prefix, everywhere a real cost would otherwise render bare.
- **Live in-flight spend** — while a turn runs, its token usage is priced with the same estimator
  and shown as `~$X.XX` on the session view turn label, the active transcript turn card, the
  session totals (sidebar row, composer, context popover) and the running workflow step; the
  real billed figure replaces it when the turn settles.

## Entry points

- Top-bar `UsageIndicator` chip
- `UsageIndicator` hover card — "Spend by model" section (with a period picker menu and pager),
  plus a "This session" sub-section when the selected session used more than one model
- Sidebar session row meta line (date, cost, token icon, duration, status badge)
- `web/src/components/WorkflowStepper.tsx` (cost label, token icon, and duration label in a
  metrics row below each step name)

## Files

- `server/src/usage.ts` — `UsagePoller`
- `web/src/store.ts` — `hello`, `usage`, and `spendDay` message handling
- `web/src/components/UsageIndicator.tsx` — the chip, the global rollup, the period picker/pager,
  and the current session's rows
- `shared/types.ts` — `UsageSnapshot`, `UsageWindow`, `ModelSpend`, `ModelSpendMap`,
  `SpendHistoryBlob`, `SessionMeta.costByModel`, `SessionMeta.totalCostUsd`,
  `SessionMeta.totalTokens`, `SessionMeta.totalDurationMs`, `WorkflowState.stepCostsUsd`,
  `WorkflowState.stepTokens`, `WorkflowState.stepDurationsMs`, `WorkflowState.stepModels`,
  `ModelOption.price`, `ModelPrice`, `priceFor`
- `shared/usageByModel.ts` — `addSpend`, `mergeSpend`, `sortedSpend`, `dayKey`, `periodBounds`,
  `foldDays`, `shiftPeriod`, `periodLabel`, `Granularity`
- `shared/estimateSpend.ts` — `estimateSpendUsd`, `hasEstimatedSpend`: prices a turn from
  `ModelOption.price` for a provider that reports no cost, and answers whether a per-model spend
  map contains any such estimated money
- `shared/providers.ts` — `capabilitiesFor(provider).cost`: the gate that decides whether a
  turn's cost is provider-reported truth or has to be estimated; see
  [openai-codex-sessions](openai-codex-sessions.md)
- `server/src/sessions.ts` — accumulates cost/tokens/duration from each turn's SDK `result`
  message; tags each settled turn's spend onto `costByModel`; sets `SessionMeta.lastTokens` /
  `SessionMeta.lastDurationMs` per turn; feeds the same billed-or-estimated figure into
  `SpendHistory`; calls `estimateSpendUsd` when the turn's provider reports no cost at all
- `shared/resultSpend.ts` — `resultSpend`, `startsQueryLifetime`, `foldResultSpend`, `billRun`:
  turns a `result`'s cumulative `total_cost_usd` into that turn's own delta. Used by the live
  accumulator in `server/src/sessions.ts`, the one-time repair script, and the spend-history
  backfill script, so they cannot disagree about where a query lifetime starts.
- `server/scripts/repair-spend.ts` — one-time local backfill (`npm run repair:spend -w server`)
  that recomputes `totalCostUsd`/`lastCostUsd`/`costByModel` from transcript `result` events for
  sessions whose totals predate the delta fix, and also fills in `estimateSpendUsd` for turns on
  a no-cost provider whose stored rows are still at zero
- `server/src/spendHistory.ts` — `SpendHistory`: the day-resolution ledger, fed from
  `accumulateResultSpend`, debounce-persisted, broadcasting one day row per turn
- `server/src/store.ts` — `loadSpendHistory`/`saveSpendHistory` (flat-JSON, per-user, same
  pattern as every other store file)
- `server/scripts/backfill-spend-history.ts` — one-time local reconstruction
  (`npm run backfill:spend-history -w server`) of the ledger from transcript `result` events, for
  history predating the ledger's existence; also estimates cost for a no-cost provider's turns via
  `estimateSpendUsd`
- `server/src/workflows.ts` — `WorkflowEngine.onWorkflowTurnComplete` (accumulates all three
  per-step numbers, and stamps `WorkflowState.stepModels[stepIndex]`)
- `web/src/components/Sidebar.tsx` — renders date (EU format), cost, token icon + tooltip,
  duration
- `web/src/components/WorkflowStepper.tsx` — renders the amount, the token tooltip, and the
  duration, marked `~` when the step's model is on a no-cost provider
- `web/src/components/SessionView.tsx`, `web/src/components/ContextWindowIndicator.tsx`,
  `web/src/components/Composer.tsx` — the other per-session cost readouts (last-turn cost, the
  context-ring hover card's session total, the composer's running total), all routed through
  `formatSpendUsd`
- `web/src/components/Transcript.tsx` — `AgentTurn`'s cost/duration chip pair
  (`turnToolStats(turn.items).result`), and `ResultMeta`'s right-aligned meta line for a turn
  with no header card, both via `formatSpendUsd`/`formatDuration` and a boolean
  `hasEstimatedSpend(session.costByModel)` store selector
- `web/src/lib/format.ts` — `formatDuration`, `formatSpendUsd`

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
- `resultSpend(msg, previousCumulativeUsd)` — this turn's own cost: the delta against the last
  cumulative reading billed for the same query lifetime, or the reading whole at a lifetime
  boundary
- `startsQueryLifetime(msg)` — true when a `result`'s cumulative `modelUsage` token total equals
  its own per-turn `usage`, meaning the running total consists of just this turn (a fresh query
  process)
- `foldResultSpend(results)` — folds a transcript's `result` events into `{ totalUsd, lastUsd }`,
  the recomputation the repair script and its test both drive
- `LiveState.lastCostCumulativeUsd` — the last `total_cost_usd` reading billed for the
  session's currently-open query lifetime; cleared in `closeQuery` so the next lifetime's first
  turn is billed whole
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
- `SpendHistoryBlob` — `{ v: 1, tz, days: Record<dayKey, ModelSpendMap> }`, one per user, held by
  `SpendHistory` and carried on `hello`
- `SpendHistory` — in-memory ledger over `SpendHistoryBlob`; `record(modelId, costUsd, tokens, ts)`
  folds one turn into `days[dayKey(ts)]`, debounce-persists, and broadcasts the mutated day whole;
  caps to the newest ~730 days on load
- `dayKey(ts)` — `YYYY-MM-DD` in local time, never `toISOString()` (which is UTC and can name the
  wrong day)
- `Granularity` — `'day' | 'week' | 'month' | 'year' | 'all'`
- `periodBounds(anchor, g)` — the inclusive day-key range a granularity/anchor pair covers; weeks
  are hardcoded Monday-start
- `foldDays(days, from, to)` — `mergeSpend` over the day rows inside an inclusive range
- `shiftPeriod(anchor, g, delta)` — the anchor one period earlier/later; `'all'` cannot page
- `periodLabel(anchor, g, now?)` — the heading text, e.g. `Today` / `Current month` for a period
  containing `now`, else `4 Oct 2026` / `September 2026` / `2026` / a week's date range
- `billRun(results)` — bills a transcript's `result` events index-aligned with the input
  (`undefined` where a result carried no usable cost), so a caller can attribute each turn to
  something of its own (the day it happened on) without restating the lifetime-boundary rule;
  `foldResultSpend` is now implemented over it
- `ModelOption.price` / `ModelPrice` — vendor list price in USD per 1M tokens (`input`,
  `cachedInput`, `output`), a static constant on the model list exactly like `contextWindow`
- `priceFor(modelId)` — resolves a (possibly retired) model id to its `ModelPrice`, or `undefined`
  when the model carries none
- `estimateSpendUsd(modelId, usage)` — this turn's cost computed from `priceFor`, or `undefined`
  when the model has no price (never `0`, which would read as "this turn was free"). Bills
  `input − cacheRead` at `input`, `cacheRead` at `cachedInput`, `cacheCreation` at `input` (no
  separate rate), and `output + reasoning` at `output` — codex's `input_tokens` already contains
  its cached reads, so billing it whole would double-charge them
- `hasEstimatedSpend(spend)` — true when any row in a `ModelSpendMap` holds estimated money
  (`costUsd > 0` on a model whose `capabilitiesFor(provider).cost` is false); drives the `~`
  marker at the section/session/step level rather than per row
- `formatSpendUsd(usd, estimated)` — `$1.23` or `~$1.23`, always 2 decimals; the one place
  every cost readout renders its dollar sign, so no site can pick its own precision

## Data flow

### Plan usage

`UsagePoller.start()` fetches on an interval and after turn completion (debounced via
`refreshSoon`), broadcasting snapshots to all clients. `hello` also carries the current snapshot
for newly connecting clients. The store merges both into `state.usage`; `UsageIndicator` renders
from it.

### Spend by model

SDK `result` message → the same accumulate-on-`result` pass in `server/src/sessions.ts` that
already owns `totalCostUsd`/`totalTokens` resolves the turn's own cost via `resultSpend` (see
Per-session totals below) and calls
`addSpend(metaNow.costByModel, resolveModelId(metaNow.model), billed, turnTokens)` with that
resolved delta, never the raw `total_cost_usd` reading → persisted via the `SessionMeta` upsert →
`UsageIndicator` reads `mergeSpend(sessions.map(s => s.costByModel))` for the global rollup and
`session.costByModel` for the current session, both rendered via `sortedSpend`.

### Estimated spend

A turn on a provider whose `capabilitiesFor(provider).cost` is `false` never carries a
`total_cost_usd`, so `resultSpend` returns `undefined` and the ordinary delta path bills nothing.
`accumulateResultSpend` then calls `estimateSpendUsd(resolveModelId(meta.model), usage)`; if that
returns a number it becomes `billedUsd` and flows into the same three places a real cost would —
`SessionMeta.lastCostUsd`/`totalCostUsd`, the `costByModel` row via `addSpend`, and
`SpendHistory.record` — so nothing downstream needs to know the number was computed rather than
reported. The gate is the capability, not "is the cost missing": a Claude turn that happens to
carry no cost stays uncosted rather than silently getting an estimate, which would leave one
Anthropic row part-real and part-computed. `live.lastCostCumulativeUsd` is left untouched, since an
estimate is genuinely per-turn and has no cumulative reading to carry forward.

Every render site asks `hasEstimatedSpend(costByModel)` (or, in the workflow stepper,
`WorkflowState.stepModels[i]` when present) and passes the answer to `formatSpendUsd`, which
prefixes a `~` rather than dimming or using a tooltip — dimmed is already the ambient color at
every one of these sites, and a tooltip is invisible on touch. The usage card's hover text spells
out once, at the section level, what the `~` means: estimated from token counts at API list
prices, not what a flat-rate plan actually billed.

### Live in-flight spend

The SDK reports `total_cost_usd` only on the final `result`, so mid-turn there is no real cost —
but there is token usage, and that is priced live with `estimateSpendUsd` (list price, so it is
always an estimate and always marked `~`).

- **Source per provider.** Claude: every `assistant` message's `message.usage`, subagent messages
  included (their tokens are the turn's spend). Codex: `live.codexUsage`, fed by
  `thread/tokenUsage/updated` — the same field mapping (`resultUsage`) the settle bills from.
- **Dedupe by `message.id`.** The SDK emits one `assistant` message per content block of an API
  call, each repeating the call's usage, so readings are kept in `LiveState.turnUsage` keyed by
  `message.id` and overwritten; summing per message would multiply the cost.
- **Throttle.** A trailing ~1s timer per session broadcasts `{type: 'turnSpend', sessionId,
  spend: {costUsd, tokens} | null}`; not per message. Nothing is sent for a model with no price
  (never `$0.00`) or while the session is not running.
- **Clear on settle.** `spend: null` drops the figure. It is sent after the settling upsert (so the
  billed total is already on the client), on a recovery result (the failed attempt was billed for
  real, so the next attempt starts from zero), on `closeQuery` and on `handleWorkerEnded`. The web
  store also drops the entry when a `sessionUpsert` shows the session no longer running, covering
  a dropped `null`.
- **Display.** `withLiveSpend(base, live, baseEstimated)` adds the live figure onto a settled
  base and forces the `~` marker; surfaces render through `formatSpendUsd`. Only the running
  workflow step gets the live figure; steps are billed at `onWorkflowTurnComplete`.
- **Known limits.** The estimate can step up or down at settle (list price, cache creation billed
  as plain input). A client that connects mid-turn sees no figure until the next broadcast (not in
  `hello`).

### Transcript turn cost

The cost on a transcript turn card (and on a result row) is that turn's own billed figure, not
the raw `total_cost_usd` the `result` carries. `buildTranscript` walks every `result` in order
through `resultSpend`, carrying the last cumulative reading forward, so each card shows its delta
by the same lifetime rule the server bills by. Results hidden inside a compaction span still
advance the reading, so a compaction's cost is never folded into the next card.

### Usage history

Same accumulate-on-`result` pass, one line further: inside `accumulateResultSpend`'s existing
`if (spend || turnTokens != null)` guard, right after the `addSpend` call that maintains
`costByModel`, with the identical resolved model id and billed delta →
`SpendHistory.record(modelId, billed, tokens, Date.now())` folds the turn into
`days[dayKey(now)]` → debounce-persisted to `spend-history.json` and broadcast as
`{ type: 'spendDay', day, spend: days[day] }` (the whole row, not a delta, so a dropped message
self-heals on the next turn) → the store applies it as a whole-row replace, gated on
`fromPrimary` → `hello` also carries the full `SpendHistoryBlob` for newly connecting clients,
same `fromPrimary` gate.

`UsageIndicator` keeps one `{ g: Granularity, anchor }` period, defaulting to `all`, lifted above
both provider chips so they page in lockstep. For `all` the section renders the existing
cross-machine `mergeSpend` rollup unchanged; for every other granularity it instead computes
`periodBounds(anchor, g)` and folds `spendHistory.days` over that range via `foldDays`. A menu on
the "Spend by model" heading (word + chevron) switches granularity, re-anchoring on today; a
prev/next pager (hidden on `all`) steps the anchor via `shiftPeriod`. Both read from one place,
so the picker, the pager and the totals can never disagree about which period is on screen.

### Per-session totals

`usage` and `duration_ms` are genuinely per-turn: `SessionMeta.totalTokens` accumulates `usage`
directly, and `duration_ms` minus the turn's accumulated `LiveState.permissionWaitMs` (tracked
from `askPermission` start to resolution, across every permission prompt in the turn) accumulates
into `SessionMeta.totalDurationMs`.

`total_cost_usd` is not per-turn — it is cumulative across the lifetime of the underlying query
process (the CLI child), resetting only when that process is replaced. `accumulateResultSpend`
calls `resultSpend(msg, live.lastCostCumulativeUsd)` (`shared/resultSpend.ts`) to recover the
turn's own cost as the delta against the last reading billed for the same lifetime, then adds
*that* onto `SessionMeta.totalCostUsd`/`lastCostUsd` and stores the raw reading as the new
`LiveState.lastCostCumulativeUsd`. `closeQuery` — the one function every path that ends a query
lifetime goes through — clears `lastCostCumulativeUsd`, so the next lifetime's first `result` is
recognised as having no prior reading and is billed whole. As a safety net for a lifetime the
runtime failed to observe closing (e.g. a bridge restart that leaves the worker's query alive),
`resultSpend` also bills a reading whole whenever it is below the stored cumulative value, or
whenever `startsQueryLifetime` detects the cumulative `modelUsage` token total equals this
result's own `usage` (the running total consists of just this turn). All three accumulated numbers
persist via `SessionMeta` upsert → sidebar reads from the session store and renders
`totalDurationMs` via `formatDuration`.

### Per-step totals

SDK `result` message → `SessionMeta.lastCostUsd` / `lastTokens` / `lastDurationMs` (the same
accumulation, estimate included) → read by `onWorkflowTurnComplete` and added onto
`WorkflowState.stepCostsUsd[stepIndex]` / `stepTokens[stepIndex]` / `stepDurationsMs[stepIndex]`;
the same block stamps `stepModels[stepIndex] = resolveModelId(meta.model)` (last writer wins
across retries) → persisted on `SessionMeta` upsert → `WorkflowStepper` renders `stepCostsUsd[i]`
via `formatSpendUsd`, `stepTokens[i]` as a coin icon with a "N tokens spent" tooltip, and
`stepDurationsMs[i]` via `formatDuration`, all in a metrics row below the step name.
`stepModels[i]` exists only because a provider-crossing workflow keeps one `SessionMeta`: the
session's *current* model cannot say what an earlier step actually ran on, so per-step estimation
marking needs its own stamp. A step run before this field existed falls back to the
session-level `hasEstimatedSpend` reading.

## Dependencies

- Shared `AuthManager` for the OAuth access token used to call the usage endpoint.
- `ModelOption[]` from the store (for model id → label), the same list
  [model-selector](model-selector.md) reads.
- `@tabler/icons-react` (`IconCoins`), Mantine `Tooltip`/`Text`/`Center`.

## Tests

- `server/src/usageByModel.test.ts` — `addSpend`/`mergeSpend`/`sortedSpend` pure-function
  behavior; `dayKey` is local-time (not UTC-shifted); `periodBounds` for a Monday-start week, a
  month, a year, a day, and across month/year boundaries; `shiftPeriod` wrapping December →
  January and stepping a day across a month/year boundary; `foldDays` range-inclusive, a single
  day, and empty-range cases; `periodLabel`'s "current period" branch (and that a neighbouring
  period does not falsely match it).
- `server/src/resultSpend.test.ts` — `resultSpend`/`startsQueryLifetime`/`foldResultSpend`: a
  second turn in a lifetime bills the delta, a lifetime that opens above the previous one's final
  reading still bills whole, a cumulative reading that drops bills whole, and a run of results
  folds to the sum of its lifetimes rather than the sum of its raw readings; `billRun` is
  index-aligned with its input and yields `undefined` for an uncosted result without breaking
  alignment for the results around it; a codex-shaped payload yields `undefined` regardless of
  `estimateSpendUsd`, so the estimator can never reach the cumulative-delta path.
- `server/src/sessions.ended.test.ts` — a settled `result` splits spend under the session's
  model; a second turn in the same query lifetime bills the delta, not the raw reading; a turn
  after `recycleIdleQueries()` closes the query bills its reading whole; a cumulative reading that
  drops, or that trips the `startsQueryLifetime` detector, bills whole even when the raw reading
  rose; `setModel()` between turns opens a second row instead of moving the first; a costless
  result on a cost-reporting provider (Anthropic) stays uncosted; a codex-shaped result is priced
  from the table instead, matching the codex fixture's usage composition by hand; a result with
  neither cost nor usage opens no row; the same settled/recovered/no-op cases open (or don't open)
  a matching `SpendHistory` day row and broadcast its whole content as `spendDay`.
- `server/src/estimateSpend.test.ts` — `estimateSpendUsd`: an unpriced model returns `undefined`,
  a priced model with no usage returns `0`, a cached read is billed once at the cached rate (not
  the naive double-charge of billing `input_tokens` whole), a cache write bills as input,
  reasoning bills as output, a retired model id prices as its replacement; `hasEstimatedSpend`:
  a Claude row never marks, an OpenAI row with `costUsd > 0` does, a mixed session marks, and a
  zero-cost OpenAI row (recorded before estimation existed) does not.
- `server/src/sessions.turnSpend.test.ts` — live spend: repeated blocks with one `message.id` count
  once and different ids sum; subagent messages count; the broadcast is throttled to one per
  window; the settling `result` broadcasts `spend: null` after the upsert and bills exactly the
  reported figure into `totalCostUsd`/`costByModel`/the ledger; a recovery result resets the live
  figure; an unpriced model broadcasts nothing; `handleWorkerEnded` and `closeQuery` clear it.
  `server/src/sessions.codex.test.ts` also checks the codex live figure equals the settle-time
  estimate, and `server/src/broadcastScope.test.ts` lists `turnSpend` as session-scoped.
- No test infrastructure covers `UsagePoller`, the Sidebar/`SessionMeta` display, or
  `WorkflowStepper` rendering at time of writing; natural first targets are `UsagePoller`
  (mocked `fetch`/`AuthManager`) and `parseSnapshot`.

## Business rules

- `result.total_cost_usd` is cumulative across the lifetime of the query process that produced
  it, not this turn's own cost. A turn's billed cost is the delta against the last reading billed
  for the same lifetime (`resultSpend`, `shared/resultSpend.ts`); the first reading of a new
  lifetime is billed whole. Getting this wrong compounds quadratically within a long-lived query
  — every earlier turn gets re-billed on every later one.
- A lifetime boundary the runtime itself did not observe closing (e.g. a bridge restart that
  leaves a worker's query alive, so `LiveState.lastCostCumulativeUsd` is lost) is still caught: a
  reading below the stored cumulative value, or a `startsQueryLifetime` detection (cumulative
  `modelUsage` tokens equal this turn's own `usage`), forces the whole reading to be billed
  instead of subtracted.
- Historical sessions accumulated before this delta fix have inflated `totalCostUsd`/`lastCostUsd`
  that will not self-correct — the field is additive and never rewound. `server/scripts/repair-spend.ts`
  is a one-time, per-machine, dry-run-by-default backfill that recomputes them from each session's
  surviving transcript `result` events; a session with none left is skipped, not zeroed.
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
- A turn on a provider whose capability table says `cost: false` is priced from
  `ModelOption.price` via `estimateSpendUsd` instead of left uncosted; `estimateSpendUsd` returns
  `undefined` (never `0`) for a model with no price entry, since a zero would render as "this turn
  was free" rather than "we cannot say". The gate is the provider's capability, not whether a
  particular result happens to be missing a cost — a Claude turn with no cost stays uncosted.
- Every figure derived from an estimate — the usage-chip section total, a sidebar row, the
  composer total, the context-ring hover card, a workflow step's cost, a transcript turn's
  chip/meta line — renders with a `~` prefix
  (`formatSpendUsd`) rather than a dimmed style or a tooltip-only cue, and the usage card spells
  out the caveat once at the section level: estimated from token counts at API list prices, not
  what a flat-rate plan was actually billed.
- The `~` marker is decided per spend surface, not per row: every one of these surfaces is already
  narrowed to a single provider (`rowsFor`, a session's own `costByModel`, a workflow step's
  stamped model), so within one surface every dollar figure is either all reported or all
  estimated.
- `WorkflowState.stepModels[i]` records the model id a step's turns actually ran on, because a
  provider-crossing workflow stays inside one `SessionMeta` and the session's *current* model
  cannot answer for an earlier step. Absent on a step run before this field existed, which falls
  back to the session-level `hasEstimatedSpend` reading.
- `server/scripts/repair-spend.ts` and `server/scripts/backfill-spend-history.ts` both call the
  same `estimateSpendUsd`, behind the same capability gate, as the live accumulator — so a
  rebuilt or repaired figure for historical codex spend agrees with what a live turn would have
  recorded. `repair-spend.ts` splits an estimated total across a session's already-zero rows by
  token share, since cost cannot be the weight when every row starts at zero.
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
- Usage-history period totals (day/week/month/year) are computed from this bridge's own
  `spend-history.json` and are **not synced** — they cover only turns run on this machine. The
  all-time rollup, by contrast, is derived from synced sessions and spans every machine the
  account has used. For a multi-machine user, a period figure can therefore read lower than the
  all-time one for the same window; the hover card labels every period other than `All time` as
  "This machine only" (plus the ledger's timezone when it disagrees with the browser's).
- `All time` is the default and first entry in the period picker — it is the only figure in the
  section that is not machine-scoped, and it is the number the card already showed before period
  browsing existed, so upgrading a bridge must not silently change what the user is reading.
- Day keys (`YYYY-MM-DD`) are stamped in the bridge's local timezone at write time and frozen —
  they are never re-bucketed if the machine's timezone later changes; the blob's `tz` field
  records what zone was in effect, and a mismatch against the browser's own zone is surfaced as
  a note rather than corrected.
- The ledger is additive only: nothing ever rewrites an existing day row except the one-time
  backfill script, which replaces the whole file. Live turns can only add to it.
- The live in-flight estimate (`turnSpend`) is never persisted and never enters `totalCostUsd`,
  `lastCostUsd`, `costByModel`, the spend-history ledger or `lastCostCumulativeUsd`; it exists
  only in `LiveState` and the web store, and is replaced by the billed figure at settle. Anything
  shown that includes it is `~`-marked, and an unpriced model shows no live figure rather than
  `$0.00`.
- `server/scripts/backfill-spend-history.ts` is best-effort, not authoritative: a session whose
  transcript was deleted (session delete, or a rewind that truncated it) contributes nothing and
  cannot be recovered, so a later run can produce a *smaller* history than an earlier one. It
  attributes cost by the SDK-reported per-model `modelUsage` delta (falling back to the session's
  current model when absent) rather than the session's model at that historical moment, which the
  transcript does not record — a provenance difference from the live path, not a bug, and can
  cause a turn split across two models to count a `turns` against each. It refuses to run while
  the bridge is up, mirroring `repair-spend.ts` and `migrate-user.ts`.
- The period picker's menu re-anchors on today whenever the granularity changes, so switching
  from "Month" to "Week" (say) never leaves the user looking at a week that has nothing to do
  with the month they were just viewing.

## Architectural rules

- No new message types for the usage chip — it follows the existing `sessionUpsert`-style
  broadcast conventions.
- Every spend number reuses the existing per-turn accumulation in `server/src/sessions.ts`
  instead of adding a new tracking mechanism: `totalTokens`/`totalDurationMs`, `costByModel`,
  and the per-step `lastCostUsd`/`lastTokens`/`lastDurationMs` all follow the same
  accumulate-on-`result` pass.
- The query-lifetime-boundary rule for cost lives in `shared/resultSpend.ts`, not inline in
  `server/src/sessions.ts`, specifically so the live accumulator and `repair-spend.ts` (a
  standalone script with no access to `LiveState`) share one definition of "where does a
  lifetime start" and cannot silently diverge.
- Estimation is deliberately kept out of `shared/resultSpend.ts`: that module does
  cumulative-delta arithmetic because `total_cost_usd` is cumulative over a query lifetime, while
  an estimate is genuinely per-turn — running it through the delta path would over- and
  under-count against the whole-reading guard. `shared/estimateSpend.ts` is its own file for that
  reason, called once from `accumulateResultSpend` after `resultSpend` comes back empty.
- `shared/estimateSpend.ts` and `shared/types.ts` form an import cycle (the estimator reads
  `priceFor`/`DEFAULT_MODELS`; `types.ts` re-exports the estimator alongside them) — safe only
  because the estimator reads those bindings inside function bodies, never at its own top level,
  and the re-export statement in `types.ts` runs after `priceFor` is initialized. Same pattern as
  the pre-existing `workflowValidation.ts` cycle in the same file.
- `repair-spend.ts` is a throwaway script, not startup migration code — the fix in
  `server/src/sessions.ts` only corrects turns going forward, so historical totals need running
  once per machine rather than a permanent code path. See `server/scripts/migrate-user.ts` for
  the established pattern this follows (bridge-running guard, dry-run default, JSON backup).
- No new persistence and no new ws message for spend-by-model: `costByModel` travels inside the
  existing `SessionMeta` blob, and the rollup is computed in the browser from data already
  pushed via `sessionUpsert`/`hello`. (The live in-flight estimate is the exception, below.)
- The live in-flight estimate rides its own ephemeral, session-scoped `turnSpend` message, not
  `upsert`: an upsert bumps `updatedAt` (the last-write-wins sync key), persists `sessions.json`
  and broadcasts the whole meta, none of which a throwaway per-second figure should do. Being
  session-bearing, `sessionIdOf`/`mayReceive` scope it to that session's viewers automatically.
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
- The spend-history ledger deliberately lives in its own store file (`spend-history.json`), not on
  `SessionMeta`: that blob is synced last-write-wins under a hard 1.5 MB push cap, and a
  day-by-day record is exactly the kind of per-turn data it is documented as having to stay free
  of (`shared/types.ts`). A separate file follows the same per-user flat-JSON pattern every other
  store file already uses.
- Spend history is deliberately **not cloud-synced in v1** — no Prisma migration, no new sync
  route. That is a real limitation (see the business rule above), accepted rather than solved
  here; a synced ledger table is the stated follow-up.
- A day's spend rides its own `{ type: 'spendDay' }` message rather than piggybacking on the
  nullable `{ type: 'usage' }` broadcast: `usage: null` has one fixed meaning ("auth is gone") and
  spend history has nothing to do with plan auth, so overloading it would make that message mean
  two unrelated things depending on which field is set.
- The ledger write sits *inside* `accumulateResultSpend`'s existing `if (spend || turnTokens !=
  null)` guard, immediately after the `addSpend` call for `costByModel`, using the identical
  resolved model id and billed delta — not a second, independently-derived call. This is what
  guarantees the ledger and the per-session split can never disagree about what counted; a
  discrepancy between the two would otherwise be a permanent, hard-to-notice reconciliation bug.
- `SpendDay` broadcasts (and the `hello` snapshot) carry the *whole* day row, not a delta, for the
  same reason `sessionUpsert` sends whole objects: a message dropped mid-flight (a flaky relay
  link) self-heals on the next turn instead of leaving a permanent gap that nothing ever re-sends.
- The web store's `hello` merge and its `spendDay` handler are both gated on `fromPrimary`,
  mirroring `updateStatus`/`bridge`/`claudeCli`: the ledger describes one specific machine, so a
  second machine's `hello` (a guest connection, or another of the user's own bridges) must never
  overwrite or blend into the primary's history.
- The period picker is a plain `useState` lifted only as far as `UsageIndicator`, not zustand
  state: it is ephemeral view state with no reason to survive a remount or be read anywhere else,
  and lifting it exactly one component higher than where it's needed (so both provider chips share
  it) is enough.
- The period-picker menu is rendered with `withinPortal={false}`: a portaled Mantine dropdown
  renders outside the `HoverCard`'s DOM subtree, so moving the pointer onto it would read as
  leaving the hover card and dismiss both at once. Keeping it inline makes the menu part of what
  the hover card considers itself.

## Related decisions

- [model-selector](model-selector.md) — the routing boundary for a planned follow-up (not yet
  started): using the spend-by-model table's numbers to justify subagent-only cheaper-model
  routing.
- [turn-recovery](turn-recovery.md) — the auth path that also discovers a dead OAuth session.
- [transcript-rendering](transcript-rendering.md) — the turn-header chip / result meta line,
  the newest consumer of `formatSpendUsd`/`formatDuration`/`hasEstimatedSpend`; it also uses
  3-digit precision (matching the composer's running total), which reads calmer than the
  4-digit "last turn" figure `SessionView` shows for the same number.

## Two providers

There are two plan-usage chips, one per connected account, rendered from one component so they
cannot drift. Each shows only its own provider's spend rows. On a phone, with both accounts
connected, the two collapse into a single ring — the provider with the least usage left, so the
one closer to blocking is the one already visible — that opens an accordion listing every
connected provider's full chip body on tap; on any wider viewport, or with only one account
connected, the two chips (or the one) still render side by side as before. The ChatGPT numbers come from
`GET https://chatgpt.com/backend-api/wham/usage` — the same endpoint the Codex CLI's own status
card reads — polled on the same cadence as the Claude one.

A codex turn does carry a `$` figure now — estimated from `ModelOption.price` and marked with a
`~` (see Estimated spend above) — but the `$` half of a spend row is still dropped outright when a
row has genuinely no cost information at all (an unpriced model, or a row recorded before
estimation existed): a column of `$0.00` would read as "these turns were free" rather than "we are
not told".

Each chip wears its provider's mark, **always** — which vendor a number belongs to is part of
reading it, not a tiebreaker for when two are on screen. See
[openai-codex-sessions](openai-codex-sessions.md).
