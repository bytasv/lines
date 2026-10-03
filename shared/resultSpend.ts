/**
 * Reading spend off an SDK `result` message.
 *
 * `total_cost_usd` is NOT this turn's cost. It is Claude Code's cost state: a
 * running total, with a per-model breakdown in `modelUsage`, that lives as long
 * as the CLI process does — and that a restarted process may pick up again. On
 * resume the CLI restores the counters it last saved for the session, so a new
 * process can continue the old total, start again from zero, or continue from an
 * *older* save than the last reading we saw (one a later process never wrote
 * back). A fresh-start workflow step or a fork changes `session_id` and starts
 * from zero. All four were measured against real transcripts.
 *
 * A turn's own cost is therefore its reading less the reading it continues from
 * — its base — and the whole problem is choosing that base. It is chosen from
 * the counters themselves, never from what the bridge believes happened to the
 * process: a query the bridge closed can still emit a final result on the old
 * total, a resumed one usually carries the total on, and a bridge restart forgets
 * everything it believed. The rule (see `CostLineage.bill`):
 *
 *  0. Nothing, when the counters equal this turn's own `usage` exactly: they
 *     hold this turn and nothing else, so the process started fresh — provably,
 *     whatever the previous reading looked like.
 *  1. The previous reading, when this one can continue it: same session, no
 *     counter went down, and the growth covers this turn's own `usage`. The last
 *     condition is what catches a fresh process whose first turn happens to
 *     outspend the previous lifetime — its counters rise, but by less than the
 *     turn itself spent.
 *  2. Otherwise an older reading of the same session that this one continues
 *     *exactly* (growth equal to this turn's `usage`) — a restore from an older
 *     save.
 *  3. Otherwise an older reading whose cache counters for some model are carried
 *     over unchanged — a restore whose turn also ran subagents. Cache counters
 *     accumulate over many calls, so an identical pair cannot be a coincidence;
 *     a lone small call's counters can, and are not accepted as proof.
 *  4. Otherwise nothing: a fresh process with subagent spend on top.
 *
 * The same rule has to hold everywhere a turn's cost is computed — the live
 * accumulator on `SessionMeta`, the transcript's turn cards, and the scripts that
 * rebuild history from transcripts — so it lives here rather than in any of them.
 */

/** The fields of an SDK `result` message this module reads. Everything is
 *  optional: a codex-shaped result carries usage but never a cost, and an older
 *  transcript may predate `modelUsage` or `session_id`. */
export interface ResultSpendPayload {
  total_cost_usd?: number;
  /** The Claude session the reading belongs to. Cost state never crosses one. */
  session_id?: string;
  /** This turn's own main-thread usage: every API call the turn made outside
   *  its subagents. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    /** Reported apart by a provider that bills it as output (codex). Declared so
     *  a reader of a stored payload — the spend-history backfill, via
     *  `estimateSpendUsd` — can see it. Never part of a Claude reading. */
    reasoning_output_tokens?: number;
  };
  /** Per-model running totals, the same cost state as `total_cost_usd`: the
   *  per-model `costUSD` always sums to it. */
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
      /** The model's stable id, without a dated snapshot suffix. Sent by newer
       *  CLIs only. */
      canonicalModel?: string;
    }
  >;
}

/** One model's share of a billed result. */
export interface ModelSpendDelta {
  costUsd: number;
  tokens: number;
  /** `canonicalModel` as the CLI reported it, when it did. */
  canonical?: string;
}

/** Billing decision for one result. */
export interface ResultSpend {
  /** This result's own cost: its reading less the base it continues from. */
  billed: number;
  /** Tokens behind `billed`, every model and subagent included. Absent when the
   *  result carries no per-model counters to take them from. */
  tokens?: number;
  /** `billed` and `tokens` split by the model that spent them, keyed by the raw
   *  `modelUsage` key. Absent when the result carries no per-model counters. */
  models?: Record<string, ModelSpendDelta>;
  /** Which base was chosen: the previous reading, an older one, or none. */
  basis: 'continued' | 'restored' | 'fresh';
}

interface Counters {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelCounters extends Counters {
  costUsd: number;
  canonical?: string;
}

interface Reading {
  sessionId?: string;
  costUsd: number;
  models?: Record<string, ModelCounters>;
  /** This turn's own main-thread usage. */
  turn: Counters;
}

/** Float noise on a running dollar total; token counts are exact integers. */
const EPSILON_USD = 1e-9;

const CATEGORIES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readingOf(msg: ResultSpendPayload): Reading | undefined {
  const cost = msg.total_cost_usd;
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return undefined;
  let models: Record<string, ModelCounters> | undefined;
  // An empty map says nothing either: a result that failed before its first API
  // call reports `{}` while its total still carries the session's spend.
  if (msg.modelUsage && typeof msg.modelUsage === 'object' && Object.keys(msg.modelUsage).length) {
    models = {};
    for (const [key, entry] of Object.entries(msg.modelUsage)) {
      models[key] = {
        input: num(entry?.inputTokens),
        output: num(entry?.outputTokens),
        cacheRead: num(entry?.cacheReadInputTokens),
        cacheWrite: num(entry?.cacheCreationInputTokens),
        costUsd: num(entry?.costUSD),
        ...(typeof entry?.canonicalModel === 'string' ? { canonical: entry.canonicalModel } : {}),
      };
    }
  }
  return {
    ...(typeof msg.session_id === 'string' && msg.session_id ? { sessionId: msg.session_id } : {}),
    costUsd: cost,
    ...(models ? { models } : {}),
    turn: {
      input: num(msg.usage?.input_tokens),
      output: num(msg.usage?.output_tokens),
      cacheRead: num(msg.usage?.cache_read_input_tokens),
      cacheWrite: num(msg.usage?.cache_creation_input_tokens),
    },
  };
}

function summed(models: Record<string, ModelCounters>): Counters {
  const total: Counters = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of Object.values(models)) {
    for (const k of CATEGORIES) total[k] += m[k];
  }
  return total;
}

/** Per category: how much more the counters grew from `base` to `reading` than
 *  this turn alone spent. Negative means the growth cannot contain the turn. */
function slack(base: Reading, reading: Reading): Counters | undefined {
  if (!base.models || !reading.models) return undefined;
  const from = summed(base.models);
  const to = summed(reading.models);
  const out = { ...to };
  for (const k of CATEGORIES) out[k] = to[k] - from[k] - reading.turn[k];
  return out;
}

/** Could `reading` be `base`'s cost state carried on? */
function continues(base: Reading, reading: Reading): boolean {
  if (base.sessionId && reading.sessionId && base.sessionId !== reading.sessionId) return false;
  if (reading.costUsd < base.costUsd - EPSILON_USD) return false;
  // Without per-model counters on both sides the total is all there is to go on.
  if (!base.models || !reading.models) return true;
  for (const [key, from] of Object.entries(base.models)) {
    const to = reading.models[key];
    if (!to) return false;
    for (const k of CATEGORIES) if (to[k] < from[k]) return false;
    if (to.costUsd < from.costUsd - EPSILON_USD) return false;
  }
  const s = slack(base, reading)!;
  return CATEGORIES.every((k) => s[k] >= 0);
}

/** `reading` is `base` plus exactly this turn's own usage. */
function continuesExactly(base: Reading, reading: Reading): boolean {
  const s = slack(base, reading);
  return s !== undefined && CATEGORIES.every((k) => s[k] === 0);
}

/** The counters hold this turn's own usage and nothing else. */
function startsFresh(reading: Reading): boolean {
  if (!reading.models) return false;
  const total = summed(reading.models);
  return CATEGORIES.every((k) => total[k] === reading.turn[k]);
}

/** Models whose cache counters `reading` carries over from `base` unchanged. */
function carriedOver(base: Reading, reading: Reading): number {
  if (!base.models || !reading.models) return 0;
  let n = 0;
  for (const [key, from] of Object.entries(base.models)) {
    const to = reading.models[key];
    if (!to || from.cacheRead + from.cacheWrite === 0) continue;
    if (
      CATEGORIES.every((k) => to[k] === from[k]) &&
      Math.abs(to.costUsd - from.costUsd) < EPSILON_USD
    ) {
      n++;
    }
  }
  return n;
}

function spendFrom(base: Reading | undefined, reading: Reading, basis: ResultSpend['basis']): ResultSpend {
  const billed = Math.max(0, reading.costUsd - (base?.costUsd ?? 0));
  // Per-model shares need per-model counters on both ends; a base from a
  // payload that predates them leaves only the total.
  if (!reading.models || (base && !base.models)) return { billed, basis };
  const models: Record<string, ModelSpendDelta> = {};
  let tokens = 0;
  for (const [key, to] of Object.entries(reading.models)) {
    const from = base?.models?.[key];
    let modelTokens = 0;
    for (const k of CATEGORIES) modelTokens += to[k] - (from?.[k] ?? 0);
    const costUsd = Math.max(0, to.costUsd - (from?.costUsd ?? 0));
    if (modelTokens <= 0 && costUsd <= 0) continue;
    models[key] = { costUsd, tokens: modelTokens, ...(to.canonical ? { canonical: to.canonical } : {}) };
    tokens += modelTokens;
  }
  return { billed, tokens, models, basis };
}

/**
 * The run of cost readings one session has produced, in order, and the rule
 * that bills the next one against them. Stateful because rules 2 and 3 look
 * back past the previous reading.
 */
export class CostLineage {
  private readonly readings: Reading[] = [];

  /**
   * This result's own cost, given every reading before it, and record it for
   * the ones after. `undefined` for a result carrying no usable cost — a codex
   * result never sets `total_cost_usd` — which is not recorded either, so it
   * cannot disturb the base its neighbours share.
   */
  bill(msg: ResultSpendPayload): ResultSpend | undefined {
    const reading = readingOf(msg);
    if (!reading) return undefined;
    const spend = this.choose(reading);
    this.readings.push(reading);
    return spend;
  }

  private choose(reading: Reading): ResultSpend {
    const previous = this.readings[this.readings.length - 1];
    if (!previous || startsFresh(reading)) return spendFrom(undefined, reading, 'fresh');
    if (continues(previous, reading)) return spendFrom(previous, reading, 'continued');
    const older = this.readings.slice(0, -1).filter((r) => continues(r, reading));
    for (let i = older.length - 1; i >= 0; i--) {
      if (continuesExactly(older[i]!, reading)) return spendFrom(older[i], reading, 'restored');
    }
    let best: Reading | undefined;
    let bestCount = 0;
    for (const r of older) {
      const n = carriedOver(r, reading);
      // `>=` so the latest of equally good candidates wins: the restored save is
      // the most recent one this reading still contains.
      if (n > 0 && n >= bestCount) {
        best = r;
        bestCount = n;
      }
    }
    if (best) return spendFrom(best, reading, 'restored');
    return spendFrom(undefined, reading, 'fresh');
  }
}

/**
 * Bill a run of results in transcript order. The output is index-aligned with
 * the input — `undefined` where a result carried no usable cost — so a caller
 * that needs to attribute each turn to something of its own (the day it happened
 * on, say) can zip the two together without restating the rule.
 */
export function billRun(results: ResultSpendPayload[]): (ResultSpend | undefined)[] {
  const lineage = new CostLineage();
  return results.map((msg) => lineage.bill(msg));
}

/**
 * Real spend over a run of results in transcript order. This is what the repair
 * script recomputes a historical session's `totalCostUsd` and `lastCostUsd`
 * from. `lastUsd` is `undefined` when no result in the run carried a cost.
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
