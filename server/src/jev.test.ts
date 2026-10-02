import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoutingRule } from '@lines/shared';
import { decideTurn, JEV_URL } from './jev.ts';

/**
 * The JEV adapter's contract: never throw, answer null on anything it cannot
 * use, and map its safe option ids back to real model ids. The network is a
 * stub throughout — no test here talks to TypeSafe.
 */
const rule: RoutingRule = {
  rule: 'max for debugging, low for small edits',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  efforts: ['max', 'low', 'high'],
};
const input = {
  rule,
  prompt: 'fix the typo',
  currentModel: 'claude-opus-5-5',
  source: 'user' as const,
  apiKey: 'k',
};
const env = {};

const respond = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('no key answers null without calling out', async () => {
  let called = false;
  const fetchStub = (async () => {
    called = true;
    return new Response('{}');
  }) as unknown as typeof fetch;
  assert.equal(await decideTurn({ ...input, apiKey: null }, { env, fetch: fetchStub }), null);
  assert.equal(await decideTurn({ ...input, apiKey: '  ' }, { env, fetch: fetchStub }), null);
  assert.equal(called, false);
});

test('a bridge env key alone no longer enables a call', async () => {
  let called = false;
  const answer = await decideTurn(
    { ...input, apiKey: null },
    {
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    },
  );
  assert.equal(answer, null);
  assert.equal(called, false);
});

test('a timeout answers null', async () => {
  const hang = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
  assert.equal(await decideTurn(input, { env, fetch: hang, timeoutMs: 20 }), null);
});

test('a non-2xx or malformed body answers null', async () => {
  assert.equal(await decideTurn(input, { env, fetch: respond({ error: 'x' }, 500) }), null);
  assert.equal(await decideTurn(input, { env, fetch: respond({ nope: true }) }), null);
  assert.equal(await decideTurn(input, { env, fetch: respond({ answers: { model: { choice: 'm9', confidence: 1 } } }) }), null);
  const broken = (async () => new Response('not json')) as unknown as typeof fetch;
  assert.equal(await decideTurn(input, { env, fetch: broken }), null);
});

test('the official endpoint is called, and answers are mapped back', async () => {
  let seen: { url: string; body: Record<string, unknown>; auth: string } | undefined;
  const capture = (async (url: string, init: RequestInit) => {
    seen = {
      url,
      body: JSON.parse(String(init.body)),
      auth: (init.headers as Record<string, string>).Authorization,
    };
    return new Response(
      JSON.stringify({
        answers: {
          model: { type: 'choice', choice: 'm1', confidence: 0.86 },
          // Fractional score, rounded to the nearest level of low < high < max.
          effort: { type: 'score', score: 1.6, confidence: 0.9 },
        },
      }),
    );
  }) as unknown as typeof fetch;
  const answer = await decideTurn(input, { env, fetch: capture });
  assert.equal(seen?.url, JEV_URL);
  assert.equal(seen?.auth, 'Bearer k');
  assert.equal(seen?.body.model, 'jev-latest');
  // Weakest first, whatever order the rule lists them in.
  const questions = seen?.body.questions as Record<string, { criteria: unknown }>;
  assert.equal((questions.effort.criteria as string[]).length, 3);
  assert.match((questions.effort.criteria as string[])[0], /^low/);
  assert.deepEqual(Object.keys(questions.model.criteria as object), ['m0', 'm1']);
  assert.deepEqual(answer, {
    model: { id: 'claude-sonnet-5-5', confidence: 0.86 },
    effort: { level: 'max', confidence: 0.9 },
  });
});
