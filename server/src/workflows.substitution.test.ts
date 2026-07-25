import assert from 'node:assert/strict';
import { test } from 'node:test';
import { substituteOutputs, usesHandoffTokens } from './workflows.ts';

test('a template pulling only {outputs.*} counts as carrying its own hand-off', () => {
  // Regression: this returned false, so runStep also auto-prepended the same text
  // under a "## Context from the previous step" heading.
  assert.equal(usesHandoffTokens('Plan from {outputs.context}'), true);
  assert.equal(usesHandoffTokens('Use {previous}'), true);
  assert.equal(usesHandoffTokens('Review {diff}'), true);
  assert.equal(usesHandoffTokens('Implement the feature: {task}'), false);
});

test('substituteOutputs fills known names', () => {
  const r = substituteOutputs('Implement {outputs.plan} now', { plan: '# Plan\n\nDo it.' });
  assert.equal(r.prompt, 'Implement # Plan\n\nDo it. now');
  assert.deepEqual(r.missing, []);
});

test('substituteOutputs reports absent and blank names once each', () => {
  const r = substituteOutputs('{outputs.plan} then {outputs.plan} then {outputs.notes}', { notes: '   ' });
  assert.deepEqual(r.missing, ['plan', 'notes']);
});

test('a template with no output tokens has nothing missing', () => {
  const r = substituteOutputs('Just {task}', {});
  assert.equal(r.prompt, 'Just {task}');
  assert.deepEqual(r.missing, []);
});
