# Session sidebar usage display

## Purpose

Shows per-session spend (cost + tokens) and creation date in the sidebar session list,
so users can see at a glance which sessions are expensive without opening them.

## Entry points

- Sidebar session row meta line (date, cost, token icon, status badge)

## Important files

- `web/src/components/Sidebar.tsx` — renders date (EU format), cost, token icon + tooltip
- `shared/types.ts` — `SessionMeta.totalCostUsd`, `SessionMeta.totalTokens`
- `server/src/sessions.ts` — accumulates cost/tokens from each turn's SDK `result` message

## Important symbols

- `SessionMeta.totalCostUsd` — cumulative USD cost across the session (pre-existing)
- `SessionMeta.totalTokens` — cumulative tokens across the session (input + output + cache
  creation + cache read), summed from `result.usage` per turn
- `SessionsStore` result handler in `server/src/sessions.ts` — where both totals accumulate

## Data flow

SDK `result` message (`total_cost_usd`, `usage`) → `SessionMeta.totalCostUsd` /
`totalTokens` accumulated per turn → persisted via `SessionMeta` upsert → sidebar reads
from session store and renders.

## Dependencies

`@tabler/icons-react` (`IconCoins`), Mantine `Tooltip`/`Text`/`Center`.

## Tests

None. No test infrastructure covers Sidebar/SessionMeta display at time of writing.

## Business rules

- Cost shown as `$X.XX` (2 decimals); hidden entirely when `totalCostUsd` is unset.
- Token icon + tooltip (`"N tokens spent"`) hidden entirely when `totalTokens` is unset.
- Date rendered EU style (`en-GB`, dd/mm/yyyy), not browser-default locale.
- Existing sessions show no token icon until their next turn completes (field is additive,
  not backfilled).

## Architectural rules

None beyond reusing the existing per-session accumulation pattern already used for
`totalCostUsd` — `totalTokens` follows the same accumulate-on-`result` approach rather than
introducing a new tracking mechanism.

## Related decisions

None recorded.
