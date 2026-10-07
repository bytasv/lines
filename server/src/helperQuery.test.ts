import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_HELPER_MODEL, runHelperQuery } from './helperQuery.ts';
import { DEFAULT_MODELS, providerForModel } from '@lines/shared';

/**
 * Provider *selection* only. The two execution paths spawn real CLIs, so they are
 * exercised by hand; what has to hold under test is which one gets chosen, since
 * that is what decides whether an OpenAI-only user gets titles and MCP vetting at
 * all.
 */
const request = {
  prompt: 'p',
  systemPrompt: 's',
  claudeModel: 'claude-haiku-5-5',
};

test('neither provider connected answers null rather than throwing', async () => {
  // Every caller has a fallback (a local title, no summary, an UNCHECKED
  // verdict), so a helper with nowhere to run must not become their failure.
  const answer = await runHelperQuery(
    { claudeToken: async () => null, codexHome: () => null },
    request,
  );
  assert.equal(answer, null);
});

test('with no preference, Claude still wins when both are connected', async () => {
  // The unprefixed order is unchanged — the MCP judge has no session to take a
  // provider from, and Claude is the cheaper path.
  let codexAsked = false;
  await runHelperQuery(
    {
      claudeToken: async () => {
        throw new Error('claude-path-reached');
      },
      codexHome: () => {
        codexAsked = true;
        return '/tmp/codex';
      },
    },
    request,
  ).catch(() => {});
  assert.equal(codexAsked, false, 'codex must not be consulted while Claude is available');
});

test('prefer openai consults codex first even with a Claude token', async () => {
  // A codex session's title is written by codex: the point of `prefer`.
  let claudeAsked = false;
  await runHelperQuery(
    {
      claudeToken: async () => {
        claudeAsked = true;
        return 'tok';
      },
      codexHome: () => {
        throw new Error('codex-path-reached');
      },
    },
    { ...request, prefer: 'openai' },
  ).catch(() => {});
  assert.equal(claudeAsked, false, 'Claude must not be consulted before the preferred provider');
});

test('a preferred provider that answers null falls back to the other', async () => {
  // What keeps a stale codex CLI probe or an unreachable helper model degrading
  // to a Claude-written title rather than to no title at all.
  let claudeAsked = false;
  await runHelperQuery(
    {
      claudeToken: async () => {
        claudeAsked = true;
        throw new Error('claude-path-reached');
      },
      // Not connected, so the preferred provider has no answer.
      codexHome: () => null,
    },
    { ...request, prefer: 'openai' },
  ).catch(() => {});
  assert.equal(claudeAsked, true, 'the other provider must be tried when the preferred one is absent');
});

test('a thrown provider lookup is swallowed, not propagated', async () => {
  const answer = await runHelperQuery(
    {
      claudeToken: async () => {
        throw new Error('boom');
      },
      codexHome: () => null,
    },
    request,
  );
  assert.equal(answer, null);
});

test('the codex helper model is a real, currently offered OpenAI model', () => {
  // A typo here would be invisible until an OpenAI-only user noticed their
  // sessions had stopped being named.
  assert.equal(providerForModel(CODEX_HELPER_MODEL), 'openai');
  assert.ok(
    DEFAULT_MODELS.some((m) => m.id === CODEX_HELPER_MODEL),
    `${CODEX_HELPER_MODEL} is not in DEFAULT_MODELS`,
  );
});
