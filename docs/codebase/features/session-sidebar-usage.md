# Session sidebar usage display

## Purpose

Shows per-session spend (cost + tokens), active-turn duration, and creation date in the
sidebar session list, so users can see at a glance which sessions are expensive or slow
without opening them.

## Entry points

- Sidebar session row meta line (date, cost, token icon, duration, status badge)

## Important files

- `web/src/components/Sidebar.tsx` — renders date (EU format), cost, token icon + tooltip, duration
- `shared/types.ts` — `SessionMeta.totalCostUsd`, `SessionMeta.totalTokens`, `SessionMeta.totalDurationMs`
- `server/src/sessions.ts` — accumulates cost/tokens/duration from each turn's SDK `result` message
- `web/src/lib/format.ts` — `formatDuration`

## Important symbols

- `SessionMeta.totalCostUsd` — cumulative USD cost across the session (pre-existing)
- `SessionMeta.totalTokens` — cumulative tokens across the session (input + output + cache
  creation + cache read), summed from `result.usage` per turn
- `SessionMeta.totalDurationMs` — cumulative active-turn duration across the session in ms,
  summed from `result.duration_ms` per turn minus that turn's permission-wait time; excludes
  idle wait between turns and human approval wait within a turn
- `SessionsStore` result handler in `server/src/sessions.ts` — where all three totals accumulate
- `formatDuration` — renders ms as `Xs` / `Xm Ys` / `Xh Ym`

## Data flow

SDK `result` message (`total_cost_usd`, `usage`, `duration_ms`) → `SessionMeta.totalCostUsd` /
`totalTokens` accumulated per turn; `duration_ms` minus the turn's accumulated
`LiveState.permissionWaitMs` (tracked from `askPermission` start to resolution, across every
permission prompt in the turn) → `SessionMeta.totalDurationMs` → persisted via `SessionMeta`
upsert → sidebar reads from session store and renders `totalDurationMs` via `formatDuration`.

## Dependencies

`@tabler/icons-react` (`IconCoins`), Mantine `Tooltip`/`Text`/`Center`.

## Tests

None. No test infrastructure covers Sidebar/SessionMeta display at time of writing.

## Business rules

- Cost shown as `$X.XX` (2 decimals); hidden entirely when `totalCostUsd` is unset.
- Token icon + tooltip (`"N tokens spent"`) hidden entirely when `totalTokens` is unset.
- Duration shown via `formatDuration`; hidden entirely when `totalDurationMs` is unset. Counts
  only active SDK turn time: excludes idle wait between turns AND any time spent waiting on a
  permission-prompt approval (e.g. plan-mode review) within a turn.
- Date rendered EU style (`en-GB`, dd/mm/yyyy), not browser-default locale.
- Existing sessions show no token icon or duration until their next turn completes (fields are
  additive, not backfilled).
- Hovering a row whose status shows a badge (not idle/running/done) swaps the badge for the
  date/cost/token/duration meta for the duration of the hover; the meta row reserves a fixed
  min-height so this swap doesn't shift row height.

## Architectural rules

Reuses the existing per-session accumulation pattern already used for `totalCostUsd` —
`totalTokens` and `totalDurationMs` follow the same accumulate-on-`result` approach rather than
introducing a new tracking mechanism. Duration is sourced from the SDK `result` event's
`duration_ms` rather than clock math against `turnStartedAt`, so it excludes idle time by
construction. Permission-wait deduction lives in `LiveState.permissionWaitMs` (transient,
in-memory, not persisted) rather than `duration_api_ms` (the SDK's own API-only-time field),
because `duration_api_ms` would also strip real tool-execution time (bash runs, file I/O), not
just human approval wait — deducting only the measured prompt-to-resolution span keeps
`totalDurationMs` "active work" without discarding genuine tool time. The accumulator is reset
to 0 both when a turn's `result` consumes it and whenever a turn dies without a `result`
(worker crash/error, interrupt, or reconcile-on-reconnect), so stale wait time from a dead turn
never leaks into the next turn's deduction.

The same accumulate-on-`result` pass also splits spend by model onto `SessionMeta.costByModel` —
see [[usage-by-model]].

## Related decisions

None recorded.
