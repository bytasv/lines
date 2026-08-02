import type { ModelSpend, ModelSpendMap } from './types.ts';

/**
 * Fold one settled chat turn into `map`, keyed by the model it ran on. Mutates —
 * the caller owns the map (it lives on `SessionMeta.costByModel`, accumulated in
 * the same pass that owns `totalCostUsd`).
 *
 * `turns` counts calls, not billed API requests, so a zero-cost turn still
 * registers. Missing numbers are the caller's job to default; anything
 * non-finite is dropped so one bad payload can't poison the row with NaN.
 */
export function addSpend(
  map: ModelSpendMap,
  modelId: string,
  costUsd: number,
  tokens: number,
): void {
  const row = (map[modelId] ??= { costUsd: 0, tokens: 0, turns: 0 });
  if (Number.isFinite(costUsd)) row.costUsd += costUsd;
  if (Number.isFinite(tokens)) row.tokens += tokens;
  row.turns += 1;
}

/** Global rollup: sums per-model rows across sessions. `undefined` entries (a
 *  session that hasn't produced a turn since the field existed) are skipped. */
export function mergeSpend(maps: (ModelSpendMap | undefined)[]): ModelSpendMap {
  const merged: ModelSpendMap = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [modelId, spend] of Object.entries(map)) {
      const row = (merged[modelId] ??= { costUsd: 0, tokens: 0, turns: 0 });
      row.costUsd += spend.costUsd;
      row.tokens += spend.tokens;
      row.turns += spend.turns;
    }
  }
  return merged;
}

/** Rows most-expensive first — the order the by-model table renders in. */
export function sortedSpend(map: ModelSpendMap): [string, ModelSpend][] {
  return Object.entries(map).sort((a, b) => b[1].costUsd - a[1].costUsd);
}
