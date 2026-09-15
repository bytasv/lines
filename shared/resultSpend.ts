/**
 * Reading spend off an SDK `result` message.
 *
 * `total_cost_usd` is NOT this turn's cost: it is cumulative across the lifetime
 * of the query process that produced it, and resets only when that process is
 * replaced. Summing it per turn re-bills every earlier turn of the same query on
 * every later one, so the overstatement compounds quadratically within a
 * lifetime. The turn's own cost is the delta between consecutive readings, with
 * the first reading of each lifetime taken whole.
 *
 * The same rule has to hold in two places — the live accumulator on
 * `SessionMeta.totalCostUsd` and the one-time repair that recomputes historical
 * totals from the transcripts on disk — so it lives here rather than in either.
 */

/** The fields of an SDK `result` message this module reads. Everything is
 *  optional: a codex-shaped result carries usage but never a cost, and an older
 *  transcript may predate `modelUsage`. */
export interface ResultSpendPayload {
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Per-model breakdown, cumulative over the query lifetime exactly like
   *  `total_cost_usd` — which is why it can date the lifetime. */
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }
  >;
}

/** Billing decision for one result: what to add to the session total, and the
 *  cumulative reading to carry into the next one. */
export interface ResultSpend {
  /** This turn's own cost — the delta, or the whole reading at a boundary. */
  billed: number;
  /** `total_cost_usd` as read, to pass back as `previousCumulativeUsd`. */
  cumulative: number;
}

function turnTokens(usage: ResultSpendPayload['usage']): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

function cumulativeTokens(models: NonNullable<ResultSpendPayload['modelUsage']>): number {
  let total = 0;
  for (const m of Object.values(models)) {
    total +=
      (m.inputTokens ?? 0) +
      (m.outputTokens ?? 0) +
      (m.cacheReadInputTokens ?? 0) +
      (m.cacheCreationInputTokens ?? 0);
  }
  return total;
}

/**
 * Whether this result is the first of a query lifetime, i.e. whether its
 * cumulative counters have just been reset.
 *
 * The signal is that the cumulative `modelUsage` token total equals this
 * result's own per-turn `usage` — true exactly when the running total consists
 * of this single turn. Two more obvious anchors were measured against real
 * transcripts and both are wrong: `system`/`init` fires once per turn rather
 * than once per lifetime, and `result.session_id` survives most restarts.
 *
 * Strictly better than "the cost went down", which misses a lifetime whose first
 * turn costs more than the previous lifetime's final cumulative total.
 *
 * Returns false when the payload cannot answer (no `modelUsage`, no `usage`) —
 * callers treat that as "unknown", not as "not a boundary".
 */
export function startsQueryLifetime(msg: ResultSpendPayload): boolean {
  const models = msg.modelUsage;
  if (!models || !msg.usage) return false;
  const cumulative = cumulativeTokens(models);
  // A turn that spent nothing tells us nothing: 0 === 0 for every result.
  if (cumulative === 0) return false;
  return cumulative === turnTokens(msg.usage);
}

/**
 * This result's own cost, given the last cumulative reading billed for the same
 * query lifetime (`undefined` when none has been seen yet).
 *
 * Returns `undefined` for a result carrying no usable cost — a codex result
 * never sets `total_cost_usd` at all, and a non-finite one must not poison the
 * total.
 *
 * The whole reading is billed, rather than a delta, whenever the lifetime is
 * known or suspected to have restarted: the detector fires, or the counter went
 * backwards, or there is no earlier reading to subtract. The backwards case
 * matters because the caller's memory of the previous reading is not durable —
 * a bridge restart that leaves a worker alive loses it.
 */
export function resultSpend(
  msg: ResultSpendPayload,
  previousCumulativeUsd?: number,
): ResultSpend | undefined {
  const cost = msg.total_cost_usd;
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return undefined;
  const fresh =
    previousCumulativeUsd == null || cost < previousCumulativeUsd || startsQueryLifetime(msg);
  return { billed: fresh ? cost : cost - previousCumulativeUsd, cumulative: cost };
}

/**
 * Bill a run of results in transcript order, folding lifetimes as they are
 * detected. The output is index-aligned with the input — `undefined` where a
 * result carried no usable cost — so a caller that needs to attribute each turn
 * to something of its own (the day it happened on, say) can zip the two together
 * without restating the lifetime-boundary rule.
 */
export function billRun(results: ResultSpendPayload[]): (ResultSpend | undefined)[] {
  const billed: (ResultSpend | undefined)[] = [];
  let cumulative: number | undefined;
  for (const msg of results) {
    const spend = resultSpend(msg, cumulative);
    billed.push(spend);
    if (spend) cumulative = spend.cumulative;
  }
  return billed;
}

/**
 * Real spend over a run of results in transcript order. This is what the repair
 * script recomputes a historical session's `totalCostUsd` and `lastCostUsd`
 * from, and what the boundary rule is tested through. `lastUsd` is `undefined`
 * when no result in the run carried a cost.
 */
export function foldResultSpend(results: ResultSpendPayload[]): {
  totalUsd: number;
  lastUsd?: number;
} {
  let totalUsd = 0;
  let lastUsd: number | undefined;
  for (const spend of billRun(results)) {
    if (!spend) continue;
    totalUsd += spend.billed;
    lastUsd = spend.billed;
  }
  return { totalUsd, lastUsd };
}
