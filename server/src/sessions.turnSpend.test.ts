import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta } from '@lines/shared';
import { estimateClaudeCallUsd } from '@lines/shared';
import type { AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { SpendHistory } from './spendHistory.ts';
import { createStore } from './store.ts';

/**
 * The live in-flight turn cost: Claude `assistant` usage priced as it arrives,
 * broadcast as a transient `turnSpend`, and dropped (`spend: null`) the moment
 * the real billed figure lands. The estimate must never leak into anything the
 * settle bills.
 */

const MODEL = 'claude-opus-5-5';

const meta = (id: string): SessionMeta =>
  ({
    id,
    name: id,
    cwd: '/tmp',
    model: MODEL,
    permissionMode: 'default',
    status: 'running',
    createdAt: 1,
  }) as SessionMeta;

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-turnspend-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta('s1')]));
  const store = createStore(root);
  const auth = {
    getAccessTokenSync: () => 'tok',
    ensureFreshToken: async () => 'tok',
    handleTokenRejected: async () => ({ outcome: 'refreshed' }),
  } as unknown as AuthManager;
  const broadcasts: ServerMessage[] = [];
  const spendHistory = new SpendHistory(store, (msg) => broadcasts.push(msg));
  const sessions = new SessionManager(
    store,
    new GuardAllowlist(store),
    (msg) => broadcasts.push(msg),
    auth,
    undefined,
    undefined,
    undefined,
    spendHistory,
  );
  sessions.attachWorker({
    setModel: () => {},
    close: () => {},
    push: () => {},
    interrupt: () => {},
  } as never);
  sessions.get('s1')!.turnSource = 'user';
  sessions.emitEvent('s1', 'user', { text: 'go on', source: 'user' });
  const turnSpends = () =>
    broadcasts.filter((m): m is Extract<ServerMessage, { type: 'turnSpend' }> => m.type === 'turnSpend');
  return { sessions, broadcasts, turnSpends };
}

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};

/** One SDK `assistant` message — one content block of one API call. */
const assistant = (id: string, usage: Usage, parent: string | null = null, model?: string) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage, ...(model ? { model } : {}) },
});

/** A raw stream event, as `includePartialMessages` delivers them. */
const stream = (event: Record<string, unknown>, parent: string | null = null) => ({
  type: 'stream_event',
  parent_tool_use_id: parent,
  event,
});

async function drain() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const A: Usage = { input_tokens: 1_000, output_tokens: 100 };
const B: Usage = { input_tokens: 2_000, output_tokens: 200, cache_read_input_tokens: 5_000 };
const priced = (...usages: Usage[]) =>
  usages.reduce((sum, u) => sum + estimateClaudeCallUsd(MODEL, u)!, 0);

test('repeated blocks of one API call count once, different calls add up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.sessions.handleWorkerEvent('s1', assistant('m1', A));
  h.sessions.handleWorkerEvent('s1', assistant('m1', A));
  h.sessions.handleWorkerEvent('s1', assistant('m2', B));
  t.mock.timers.tick(1_000);

  const sent = h.turnSpends();
  assert.equal(sent.length, 1, 'throttled: one broadcast for the whole window');
  assert.deepEqual(sent[0]!.spend, { costUsd: priced(A, B), tokens: 1_100 + 7_200 });
});

test('a subagent call is this turn\'s spend too', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.sessions.handleWorkerEvent('s1', assistant('m1', A));
  h.sessions.handleWorkerEvent('s1', assistant('sub1', B, 'toolu_task'));
  t.mock.timers.tick(1_000);

  assert.equal(h.turnSpends().at(-1)!.spend?.costUsd, priced(A, B));
});

test('nothing is broadcast before the throttle window elapses, and later usage sends again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.sessions.handleWorkerEvent('s1', assistant('m1', A));
  t.mock.timers.tick(999);
  assert.equal(h.turnSpends().length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.turnSpends().length, 1);

  h.sessions.handleWorkerEvent('s1', assistant('m2', B));
  t.mock.timers.tick(1_000);
  assert.equal(h.turnSpends().length, 2);
  assert.equal(h.turnSpends()[1]!.spend?.costUsd, priced(A, B));
});

test('the settling result drops the live figure and bills only what it reports', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.sessions.handleWorkerEvent('s1', assistant('m1', A));
  t.mock.timers.tick(1_000);
  h.sessions.handleWorkerEvent('s1', assistant('m2', B));
  h.sessions.handleWorkerEvent('s1', {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.5,
    usage: { input_tokens: 3_000, output_tokens: 300 },
  });

  // The billed figure reaches the client before the estimate is dropped.
  const nullAt = h.broadcasts.findIndex((m) => m.type === 'turnSpend' && m.spend === null);
  assert.ok(nullAt > 0, 'the live figure is dropped');
  assert.ok(
    h.broadcasts.slice(0, nullAt).some((m) => m.type === 'sessionUpsert' && m.session.totalCostUsd === 0.5),
    'the settling upsert lands first',
  );
  // The pending throttle died with the turn.
  t.mock.timers.tick(5_000);
  assert.equal(h.turnSpends().length, 2);

  const settled = h.sessions.get('s1')!;
  assert.equal(settled.totalCostUsd, 0.5);
  assert.equal(settled.lastCostUsd, 0.5);
  assert.deepEqual(settled.costByModel?.[MODEL], { costUsd: 0.5, tokens: 3_300, turns: 1 });
  const day = h.broadcasts.filter((m) => m.type === 'spendDay').at(-1) as Extract<
    ServerMessage,
    { type: 'spendDay' }
  >;
  assert.equal(day.spend[MODEL]?.costUsd, 0.5);
});

test('a re-driven attempt starts its live figure from zero', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.sessions.handleWorkerEvent('s1', assistant('m1', A));
  t.mock.timers.tick(1_000);
  h.sessions.handleWorkerEvent('s1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    total_cost_usd: 0.2,
    usage: { input_tokens: 1_000, output_tokens: 100 },
  });
  await drain();
  assert.equal(h.sessions.get('s1')!.status, 'running', 'recovering, not settled');
  assert.equal(h.turnSpends().at(-1)!.spend, null);
  assert.equal(h.sessions.get('s1')!.totalCostUsd, 0.2);

  h.sessions.handleWorkerEvent('s1', assistant('m2', B));
  t.mock.timers.tick(1_000);
  assert.equal(h.turnSpends().at(-1)!.spend?.costUsd, priced(B));
});

test('an unpriced model shows no live figure at all', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.sessions.get('s1')!.model = 'claude-unlisted-0';
  h.sessions.handleWorkerEvent('s1', assistant('m1', A));
  t.mock.timers.tick(1_000);
  assert.equal(h.turnSpends().length, 0);
});

test('a worker that ends drops the live figure', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.sessions.handleWorkerEvent('s1', assistant('m1', A));
  t.mock.timers.tick(1_000);
  h.sessions.handleWorkerEnded('s1', 'read ECONNRESET');
  assert.equal(h.turnSpends().at(-1)!.spend, null);
  assert.equal(h.sessions.get('s1')!.totalCostUsd, undefined, 'the estimate is never billed');
});

test('closing the query drops the live figure', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.sessions.handleWorkerEvent('s1', assistant('m1', A));
  t.mock.timers.tick(1_000);
  (h.sessions as unknown as { closeQuery(id: string): void }).closeQuery('s1');
  assert.equal(h.turnSpends().at(-1)!.spend, null);

  // A fresh reading after the close starts over.
  h.sessions.handleWorkerEvent('s1', assistant('m2', B));
  t.mock.timers.tick(1_000);
  assert.equal(h.turnSpends().at(-1)!.spend?.costUsd, priced(B));
});

test('the final output count comes from message_delta, which the assistant messages lack', (t) => {
  // Measured: the SDK's assistant messages repeat message_start's placeholder
  // output count — about 1% of what the call really wrote.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const start: Usage = {
    input_tokens: 10,
    output_tokens: 1,
    cache_read_input_tokens: 100_000,
    cache_creation_input_tokens: 5_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5_000 },
  };
  h.sessions.handleWorkerEvent('s1', stream({ type: 'message_start', message: { id: 'm1', model: MODEL, usage: start } }));
  h.sessions.handleWorkerEvent('s1', stream({ type: 'message_delta', usage: { output_tokens: 2_000 } }));
  // The content block lands after the delta, still carrying the placeholder.
  h.sessions.handleWorkerEvent('s1', assistant('m1', start));
  t.mock.timers.tick(1_000);

  // 10 × $4 + 2,000 × $20 + 100,000 × $0.20 + 5,000 × $8 (a 1-hour write), per 1M.
  const spend = h.turnSpends().at(-1)!.spend!;
  assert.ok(Math.abs(spend.costUsd - 0.10004) < 1e-12, String(spend.costUsd));
  assert.equal(spend.tokens, 10 + 2_000 + 100_000 + 5_000);
});

test('a subagent stream’s delta closes its own call, not the main agent’s', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.sessions.handleWorkerEvent('s1', stream({ type: 'message_start', message: { id: 'main', usage: { input_tokens: 100 } } }));
  h.sessions.handleWorkerEvent(
    's1',
    stream({ type: 'message_start', message: { id: 'sub', usage: { input_tokens: 200 } } }, 'toolu_task'),
  );
  h.sessions.handleWorkerEvent('s1', stream({ type: 'message_delta', usage: { output_tokens: 50 } }, 'toolu_task'));
  h.sessions.handleWorkerEvent('s1', stream({ type: 'message_delta', usage: { output_tokens: 7 } }));
  t.mock.timers.tick(1_000);

  assert.equal(
    h.turnSpends().at(-1)!.spend?.costUsd,
    priced({ input_tokens: 100, output_tokens: 7 }, { input_tokens: 200, output_tokens: 50 }),
  );
});

test('a subagent on another model is priced at its own rates', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  // A dated snapshot id, as the API reports it.
  h.sessions.handleWorkerEvent('s1', assistant('sub', A, 'toolu_task', 'claude-haiku-4-5-20251001'));
  t.mock.timers.tick(1_000);

  // 1,000 × $1 + 100 × $5, per 1M — Haiku's, not the session's Opus rates.
  assert.equal(h.turnSpends().at(-1)!.spend?.costUsd, 0.0015);
});

test('a synthetic message that spent nothing neither counts nor hides the figure', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.sessions.handleWorkerEvent('s1', assistant('m1', A));
  // The SDK's own error message: model `<synthetic>`, no price, zero usage.
  h.sessions.handleWorkerEvent('s1', assistant('syn', { input_tokens: 0, output_tokens: 0 }, null, '<synthetic>'));
  t.mock.timers.tick(1_000);

  assert.equal(h.turnSpends().at(-1)!.spend?.costUsd, priced(A));
});
