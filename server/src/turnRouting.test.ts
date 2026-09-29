import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoutingRule, SessionMeta, UserUiSettings } from '@lines/shared';
import { acceptPick, resolveRule, smartRoutingIssues } from './turnRouting.ts';

const claudeRule: RoutingRule = {
  rule: 'max for debugging, low for small edits',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  efforts: ['low', 'high', 'max'],
};
const stepRule: RoutingRule = { rule: 'step rule', models: ['claude-sonnet-5-5', 'claude-haiku-4-5'], efforts: ['low', 'medium'] };

const meta = (over: Partial<SessionMeta> = {}) =>
  ({ model: 'claude-opus-5-5', permissionMode: 'default', ...over }) as Pick<
    SessionMeta,
    'model' | 'permissionMode' | 'routingPaused'
  >;

const settings = (mode: 'off' | 'auto' | 'ask'): UserUiSettings => ({
  smartRouting: { mode, rules: { anthropic: claudeRule } },
});

test('a step rule beats the global rule, which beats nothing', () => {
  assert.equal(resolveRule(meta(), settings('auto'), stepRule), stepRule);
  assert.equal(resolveRule(meta(), settings('auto')), claudeRule);
  assert.equal(resolveRule(meta({ model: 'gpt-6-sol' }), settings('auto')), undefined);
  assert.equal(resolveRule(meta(), null), undefined);
});

test('off, paused and plan mode all resolve to no rule', () => {
  assert.equal(resolveRule(meta(), settings('off'), stepRule), undefined);
  assert.equal(resolveRule(meta({ routingPaused: true }), settings('auto'), stepRule), undefined);
  // Plan mode has its own global effort, and that keeps winning.
  assert.equal(resolveRule(meta({ permissionMode: 'plan' }), settings('ask')), undefined);
});

test('a rule naming another provider’s model is never applied', () => {
  const crossing: RoutingRule = { ...claudeRule, models: ['claude-sonnet-5-5', 'gpt-6-sol'] };
  assert.equal(resolveRule(meta(), settings('auto'), crossing), undefined);
});

test('acceptPick applies a confident in-set change', () => {
  const change = acceptPick(
    { model: { id: 'claude-sonnet-5-5', confidence: 0.9 }, effort: { level: 'low', confidence: 0.8 } },
    claudeRule,
    { model: 'claude-opus-5-5', effort: 'max' },
  );
  assert.deepEqual(change, { model: 'claude-sonnet-5-5', effort: 'low', confidence: 0.8 });
});

test('acceptPick rejects out-of-set, low-confidence and same-as-current picks', () => {
  const current = { model: 'claude-opus-5-5', effort: 'high' as const };
  // Out of set.
  assert.equal(
    acceptPick({ model: { id: 'claude-haiku-4-5', confidence: 1 }, effort: { level: 'xhigh', confidence: 1 } }, claudeRule, current),
    null,
  );
  // Below the default 0.7 floor.
  assert.equal(acceptPick({ model: { id: 'claude-sonnet-5-5', confidence: 0.5 } }, claudeRule, current), null);
  // Same as current.
  assert.equal(
    acceptPick({ model: { id: 'claude-opus-5-5', confidence: 1 }, effort: { level: 'high', confidence: 1 } }, claudeRule, current),
    null,
  );
  assert.equal(acceptPick(null, claudeRule, current), null);
});

test('model and effort are gated independently', () => {
  const change = acceptPick(
    { model: { id: 'claude-sonnet-5-5', confidence: 0.4 }, effort: { level: 'max', confidence: 0.95 } },
    claudeRule,
    { model: 'claude-opus-5-5', effort: 'low' },
  );
  assert.deepEqual(change, { effort: 'max', confidence: 0.95 });
});

test('a rule’s own minConfidence replaces the default', () => {
  const strict = { ...claudeRule, minConfidence: 0.95 };
  assert.equal(acceptPick({ effort: { level: 'max', confidence: 0.9 } }, strict, { model: 'claude-opus-5-5' }), null);
});

test('settings validation refuses a cross-provider model and an unknown effort', () => {
  assert.deepEqual(smartRoutingIssues(undefined), []);
  assert.deepEqual(smartRoutingIssues(settings('auto').smartRouting), []);
  const bad = smartRoutingIssues({
    mode: 'auto',
    rules: { anthropic: { rule: 'x', models: ['gpt-6-sol'], efforts: ['nope' as never] } },
  });
  assert.equal(bad.length, 2);
});
