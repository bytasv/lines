import assert from 'node:assert/strict';
import { test } from 'node:test';
import { billRun, CostLineage, foldResultSpend } from '@lines/shared';
import type { ResultSpendPayload } from '@lines/shared';

/**
 * The scenarios below are the shapes measured in real transcripts, with round
 * numbers: Claude Code's running total carried on in one process, carried on by
 * a resumed one, restarted from zero, resumed from an older save, and started
 * over by a new session id.
 */

type Counters = [input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number];

const counters = ([input, output, cacheRead, cacheWrite, costUsd]: Counters) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheWrite,
  costUSD: costUsd,
});

/**
 * A `result` whose cost state holds `models` (cumulative per-model counters), in
 * session `sid`, for a turn whose own main-thread usage was `turn`.
 */
const result = (
  sid: string,
  models: Record<string, Counters>,
  turn: [input: number, output: number, cacheRead: number, cacheWrite: number],
): ResultSpendPayload => ({
  session_id: sid,
  total_cost_usd: Object.values(models).reduce((n, m) => n + m[4], 0),
  usage: {
    input_tokens: turn[0],
    output_tokens: turn[1],
    cache_read_input_tokens: turn[2],
    cache_creation_input_tokens: turn[3],
  },
  modelUsage: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, counters(v)])),
});

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5-20251001';

const near = (actual: number | undefined, expected: number) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

test('a later turn in the same process bills its growth, not the reading', () => {
  const lineage = new CostLineage();
  lineage.bill(result('s1', { [OPUS]: [10, 100, 1_000, 500, 1] }, [10, 100, 1_000, 500]));
  const spend = lineage.bill(result('s1', { [OPUS]: [20, 300, 3_000, 700, 3] }, [10, 200, 2_000, 200]));
  assert.equal(spend?.basis, 'continued');
  near(spend?.billed, 2);
  assert.equal(spend?.tokens, 10 + 200 + 2_000 + 200);
});

test('a resumed query that carries the running total on bills a delta, not the whole total', () => {
  // The bug this module exists to prevent: closing the query (an idle recycle, a
  // retry) used to forget the last reading, so the resumed process's first
  // result — whose total the CLI had restored — was billed whole, again.
  const lineage = new CostLineage();
  lineage.bill(result('s1', { [OPUS]: [10, 100, 1_000, 500, 9.8] }, [10, 100, 1_000, 500]));
  const spend = lineage.bill(result('s1', { [OPUS]: [12, 150, 1_500, 600, 13.2] }, [2, 50, 500, 100]));
  assert.equal(spend?.basis, 'continued');
  near(spend?.billed, 3.4);
});

test('subagent spend makes the growth exceed the turn and is still the turn’s', () => {
  const lineage = new CostLineage();
  lineage.bill(result('s1', { [OPUS]: [10, 100, 1_000, 500, 1] }, [10, 100, 1_000, 500]));
  // The main thread spent [1, 50, 400, 100]; an Explore agent on Sonnet the rest.
  const spend = lineage.bill(
    result('s1', { [OPUS]: [11, 150, 1_400, 600, 1.5], [SONNET]: [5, 80, 2_000, 300, 0.25] }, [1, 50, 400, 100]),
  );
  assert.equal(spend?.basis, 'continued');
  near(spend?.billed, 0.75);
  near(spend?.models?.[OPUS]?.costUsd, 0.5);
  near(spend?.models?.[SONNET]?.costUsd, 0.25);
  assert.equal(spend?.models?.[SONNET]?.tokens, 5 + 80 + 2_000 + 300);
});

test('a fresh-start step bills its new session whole, though its total opens higher', () => {
  // Measured: planning closed its session at $14.44, the implementation step
  // opened a new one that reached $14.62 — and was billed $0.18.
  const lineage = new CostLineage();
  lineage.bill(result('plan', { [OPUS]: [60, 50_000, 19_000_000, 400_000, 14.44] }, [60, 50_000, 19_000_000, 400_000]));
  const spend = lineage.bill(
    result('impl', { [OPUS]: [230, 211_545, 34_464_696, 436_338, 14.62] }, [230, 211_545, 34_464_696, 436_338]),
  );
  assert.equal(spend?.basis, 'fresh');
  near(spend?.billed, 14.62);
});

test('a fresh process whose counters rose by less than its own turn spent is fresh', () => {
  // Same session id, every counter higher than the previous reading — but the
  // growth cannot contain the turn that produced it, so the counters restarted.
  const lineage = new CostLineage();
  lineage.bill(result('s1', { [OPUS]: [6, 969, 93_256, 53_077, 0.6] }, [6, 969, 93_256, 53_077]));
  const spend = lineage.bill(
    result('s1', { [OPUS]: [98, 44_620, 4_732_148, 186_263, 5.34] }, [98, 44_620, 4_732_148, 186_263]),
  );
  assert.equal(spend?.basis, 'fresh');
  near(spend?.billed, 5.34);
});

test('counters equal to the turn’s own usage are fresh even after a reading without them', () => {
  const lineage = new CostLineage();
  lineage.bill({ total_cost_usd: 0.25, usage: { input_tokens: 1_000 } });
  const spend = lineage.bill({
    total_cost_usd: 2,
    usage: { input_tokens: 500 },
    modelUsage: { [OPUS]: { inputTokens: 500, costUSD: 2 } },
  });
  assert.equal(spend?.basis, 'fresh');
  near(spend?.billed, 2);
});

test('a resume from an older save is billed against that save, exactly', () => {
  // R saved → the lineage went on to P without saving again → a new process
  // restored R, and its turn added exactly its own usage on top.
  const lineage = new CostLineage();
  lineage.bill(result('s1', { [OPUS]: [6, 3_000, 20_000, 9_000, 0.97] }, [6, 3_000, 20_000, 9_000]));
  lineage.bill(result('s1', { [OPUS]: [9, 9_000, 80_000, 12_000, 1.9] }, [3, 6_000, 60_000, 3_000]));
  const spend = lineage.bill(result('s1', { [OPUS]: [9, 4_000, 30_000, 10_000, 1.29] }, [3, 1_000, 10_000, 1_000]));
  assert.equal(spend?.basis, 'restored');
  near(spend?.billed, 0.32);
});

test('a resume from an older save with subagents on top is found by its carried-over cache counters', () => {
  const lineage = new CostLineage();
  const saved: Counters = [64, 25_720, 2_111_130, 82_282, 1.595];
  lineage.bill(result('s1', { [HAIKU]: [4_388, 17, 0, 0, 0.004], [OPUS]: saved }, [64, 25_720, 2_111_130, 82_282]));
  lineage.bill(
    result('s1', { [HAIKU]: [4_388, 17, 0, 0, 0.004], [OPUS]: [296, 271_027, 32_922_307, 428_134, 15.431] }, [1, 1, 1, 1]),
  );
  // Restored `saved`; this turn ran on Sonnet, with a subagent's spend on top, so
  // the growth is not exactly the turn — but Opus came back unchanged.
  const spend = lineage.bill(
    result(
      's1',
      { [HAIKU]: [4_388, 17, 0, 0, 0.004], [OPUS]: saved, [SONNET]: [2_172, 13_352, 753_256, 313_866, 1.152] },
      [22, 5_289, 741_079, 52_280],
    ),
  );
  assert.equal(spend?.basis, 'restored');
  near(spend?.billed, 1.152);
  assert.deepEqual(Object.keys(spend?.models ?? {}), [SONNET]);
});

test('a lone small call that matches by chance is no evidence of a restore', () => {
  // A single Haiku call of ~1,100 input tokens repeats across unrelated sessions
  // to the token; with no cache counters it proves nothing.
  const lineage = new CostLineage();
  lineage.bill(result('s1', { [HAIKU]: [1_091, 14, 0, 0, 0.00116], [SONNET]: [2, 300, 5_000, 2_000, 0.05] }, [2, 300, 5_000, 2_000]));
  lineage.bill(result('s1', { [HAIKU]: [1_091, 14, 0, 0, 0.00116], [SONNET]: [9, 2_000, 90_000, 9_000, 0.9] }, [7, 1_700, 85_000, 7_000]));
  // The first reading is a valid base (everything grew, by more than this turn
  // spent), just not an exact one — so only a fingerprint could pick it, and an
  // unchanged Haiku without cache counters must not count as one.
  const spend = lineage.bill(
    result('s1', { [HAIKU]: [1_091, 14, 0, 0, 0.00116], [SONNET]: [3, 900, 30_000, 4_000, 0.3] }, [1, 500, 20_000, 1_000]),
  );
  assert.equal(spend?.basis, 'fresh');
  near(spend?.billed, 0.30116);
});

test('a session returning to an earlier id resumes that id’s readings, not the other one’s', () => {
  const lineage = new CostLineage();
  lineage.bill(result('a', { [OPUS]: [10, 1_000, 50_000, 5_000, 2.22] }, [10, 1_000, 50_000, 5_000]));
  lineage.bill(result('b', { [OPUS]: [5, 800, 30_000, 4_000, 1.99] }, [5, 800, 30_000, 4_000]));
  const spend = lineage.bill(result('a', { [OPUS]: [16, 1_500, 70_000, 6_000, 3.0] }, [6, 500, 20_000, 1_000]));
  assert.equal(spend?.basis, 'restored');
  near(spend?.billed, 0.78);
});

test('without per-model counters a reading that went backwards bills whole', () => {
  const lineage = new CostLineage();
  lineage.bill({ total_cost_usd: 5, usage: { input_tokens: 100 } });
  assert.deepEqual(lineage.bill({ total_cost_usd: 2, usage: { input_tokens: 100 } }), {
    billed: 2,
    basis: 'fresh',
  });
});

test('an empty modelUsage says nothing, and leaves the total to decide', () => {
  const lineage = new CostLineage();
  lineage.bill(result('s1', { [OPUS]: [10, 100, 1_000, 500, 1] }, [10, 100, 1_000, 500]));
  // A result that failed before its first call: `{}`, total unchanged.
  const spend = lineage.bill({ session_id: 's1', total_cost_usd: 1, usage: { input_tokens: 5 }, modelUsage: {} });
  assert.equal(spend?.basis, 'continued');
  near(spend?.billed, 0);
});

test('the CLI’s canonical model id rides along with each share', () => {
  const lineage = new CostLineage();
  const spend = lineage.bill({
    session_id: 's1',
    total_cost_usd: 0.005,
    usage: {},
    modelUsage: { [HAIKU]: { inputTokens: 5_000, costUSD: 0.005, canonicalModel: 'claude-haiku-4-5' } },
  });
  assert.equal(spend?.models?.[HAIKU]?.canonical, 'claude-haiku-4-5');
});

test('a result carrying no cost yields no spend and does not disturb its neighbours', () => {
  const codex: ResultSpendPayload = { usage: { input_tokens: 500, output_tokens: 30, reasoning_output_tokens: 7 } };
  const billed = billRun([
    result('s1', { [OPUS]: [10, 100, 1_000, 500, 1] }, [10, 100, 1_000, 500]),
    codex,
    result('s1', { [OPUS]: [20, 300, 3_000, 700, 3] }, [10, 200, 2_000, 200]),
  ]);
  assert.equal(billed.length, 3);
  assert.equal(billed[1], undefined);
  assert.equal(billed[2]?.basis, 'continued');
  near(billed[2]?.billed, 2);
  assert.equal(new CostLineage().bill({ total_cost_usd: Number.NaN }), undefined);
});

test('a run totals what each result added, not the sum of its readings', () => {
  const run = [
    result('s1', { [OPUS]: [10, 100, 1_000, 500, 1] }, [10, 100, 1_000, 500]), // $1
    result('s1', { [OPUS]: [20, 300, 3_000, 700, 3] }, [10, 200, 2_000, 200]), // +$2
    result('s2', { [OPUS]: [5, 50, 500, 100, 10] }, [5, 50, 500, 100]), // new session: $10
    result('s2', { [OPUS]: [10, 100, 900, 200, 12] }, [5, 50, 400, 100]), // +$2
  ];
  assert.deepEqual(foldResultSpend(run), { totalUsd: 15, lastUsd: 2 });
  assert.deepEqual(foldResultSpend([{ usage: { input_tokens: 50 } }]), { totalUsd: 0, lastUsd: undefined });
});
