/**
 * What a turn *would* have cost, for a provider that never tells us.
 *
 * Codex reports tokens and no price — the app-server's `account/usage/read` only
 * carries `estimatedUsageUsdMicros` on a credits-billed account, and answers null
 * on the ChatGPT sign-in this app holds. So the only way to show money for an
 * OpenAI session is to compute it: tokens × a static per-model rate
 * (`ModelOption.price`).
 *
 * The number that comes out is an API-list-price equivalent, NOT money billed —
 * a ChatGPT plan is flat-rate. Everything that renders one must mark it (see
 * `formatSpendUsd` in the web app); the single rule this whole feature turns on
 * is that an estimate never looks identical to a provider-reported truth.
 *
 * Claude does report a price, but only once a turn settles. The live figure a
 * running Claude turn shows is priced here too, call by call, with Anthropic's
 * own conventions (`estimateClaudeCallUsd`) — and replaced by the reported cost
 * the moment the `result` lands.
 *
 * Deliberately not part of `./resultSpend.ts`. That module does cumulative-delta
 * arithmetic because `total_cost_usd` is cumulative over a query lifetime; an
 * estimate is genuinely per-turn, and feeding it through the delta path would
 * alternately over- and under-count against its whole-reading guard.
 */
import { capabilitiesFor } from './providers.ts';
import { priceFor, providerForModel } from './types.ts';
import type { ModelSpendMap } from './types.ts';

/** The usage fields an estimate is computed from — the SDK `result` shape, with
 *  codex's separately-reported reasoning tokens. Every field is optional: a
 *  payload missing one simply contributes nothing at that rate. */
export interface EstimateUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Billed as output, counted apart (codex). Absent on Claude, which folds its
   *  own reasoning into `output_tokens` at the source. */
  reasoning_output_tokens?: number;
}

/**
 * This turn's estimated cost in USD, or `undefined` when the model carries no
 * price.
 *
 * `undefined` rather than `0` on an unpriced model, always: a zero renders as
 * "this turn was free", which is a different and wrong claim from "we cannot
 * say". A priced model with no usage really did cost nothing and returns 0.
 *
 * The token composition is where this is easy to get wrong. Codex's
 * `inputTokens` ALREADY CONTAINS `cachedInputTokens` — its own `totalTokens` is
 * `input + output + reasoning`, with the cached read and the cache write
 * excluded (see the fixture in server/src/codexEvents.test.ts). So the cached
 * share is subtracted out before the remainder is billed at the full input rate;
 * billing `input_tokens` whole would charge every cached token twice.
 */
export function estimateSpendUsd(
  modelId: string,
  usage: EstimateUsage | undefined,
): number | undefined {
  const price = priceFor(modelId);
  if (!price) return undefined;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const uncachedInput = Math.max(0, (usage?.input_tokens ?? 0) - cacheRead);
  // A cache write has no rate of its own in the table; it bills as plain input.
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  // Reasoning is output the provider chose to count separately, not a third kind.
  const output = (usage?.output_tokens ?? 0) + (usage?.reasoning_output_tokens ?? 0);
  const usd =
    (uncachedInput * price.input +
      cacheRead * price.cachedInput +
      cacheWrite * price.input +
      output * price.output) /
    1_000_000;
  return Number.isFinite(usd) ? usd : undefined;
}

/**
 * Whether any of these per-model rows holds estimated money rather than reported
 * money — i.e. whether a total summed over them has to carry the marker.
 *
 * The question is asked of the rows rather than of a session's current model
 * because a provider-crossing workflow step stays in the same `SessionMeta`: one
 * session can legitimately hold both kinds of dollars, and marking the total
 * whenever any part of it is estimated is the honest read.
 *
 * `costUsd > 0` matters: a codex row recorded before this existed carries tokens
 * and a zero cost, and there is nothing estimated about a zero.
 */
export function hasEstimatedSpend(spend: ModelSpendMap | undefined): boolean {
  if (!spend) return false;
  return Object.entries(spend).some(
    ([modelId, row]) => row.costUsd > 0 && !capabilitiesFor(providerForModel(modelId)).cost,
  );
}

/** Anthropic bills a cache write at a multiple of the model's input rate, set
 *  by how long the write is kept. */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

/** One Claude API call's usage, in the shape `message_start`, `message_delta`
 *  and the SDK's `assistant` messages carry it. Fields can be null mid-stream. */
export interface ClaudeCallUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

/** The price of an API model id, which may name a dated snapshot of a listed
 *  model (`claude-haiku-4-5-20251001`). */
function priceForApiModel(modelId: string) {
  return priceFor(modelId) ?? priceFor(modelId.replace(/-\d{8}$/, ''));
}

/**
 * What one Claude API call cost at list price, or `undefined` when its model
 * carries no price.
 *
 * Anthropic's usage is shaped differently from codex's in exactly the two
 * places `estimateSpendUsd` would get wrong:
 *  - `input_tokens` is the uncached input only — the cached read is reported
 *    beside it, not inside it — so nothing is subtracted;
 *  - a cache write costs more than input: 1.25x for a 5-minute entry, 2x for a
 *    1-hour one.
 *
 * A call that does not split its writes by lifetime is priced at the 1-hour
 * rate. That is the one Claude Code writes with, and list prices with 1-hour
 * writes reproduce the CLI's own reported `costUSD` exactly on most model rows
 * of real transcripts; the rest held 5-minute writes, which the split names.
 */
export function estimateClaudeCallUsd(
  modelId: string,
  usage: ClaudeCallUsage | undefined,
): number | undefined {
  const price = priceForApiModel(modelId);
  if (!price) return undefined;
  const write = usage?.cache_creation_input_tokens ?? 0;
  const write5m = usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const write1h = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  // Whatever the split does not account for is priced at the 1-hour rate.
  const unsplit = Math.max(0, write - write5m - write1h);
  const usd =
    ((usage?.input_tokens ?? 0) * price.input +
      (usage?.cache_read_input_tokens ?? 0) * price.cachedInput +
      write5m * price.input * CACHE_WRITE_5M +
      (write1h + unsplit) * price.input * CACHE_WRITE_1H +
      (usage?.output_tokens ?? 0) * price.output) /
    1_000_000;
  return Number.isFinite(usd) ? usd : undefined;
}
