import assert from 'node:assert/strict';
import { test } from 'node:test';
import { substituteTokens, usesHandoffTokens } from './workflows.ts';

const NONE = { task: '', feedback: '', previous: '', diff: '', changed: '', roots: '' };

test('a template pulling only {outputs.*} counts as carrying its own hand-off', () => {
  // Regression: this returned false, so runStep also auto-prepended the same text
  // under a "## Context from the previous step" heading.
  assert.equal(usesHandoffTokens('Plan from {outputs.context}'), true);
  assert.equal(usesHandoffTokens('Use {previous}'), true);
  assert.equal(usesHandoffTokens('Review {diff}'), true);
  assert.equal(usesHandoffTokens('Commit {changed}'), true);
  assert.equal(usesHandoffTokens('Implement the feature: {task}'), false);
  // {roots} is workspace shape, not a hand-off: a template using only it must
  // still get the auto-prepend of previous+diff.
  assert.equal(usesHandoffTokens('Commit in each of {roots}'), false);
});

test('substituteTokens fills known output names', () => {
  const r = substituteTokens('Implement {outputs.plan} now', NONE, { plan: '# Plan\n\nDo it.' });
  assert.equal(r.prompt, 'Implement # Plan\n\nDo it. now');
  assert.deepEqual(r.missing, []);
});

test('a template with no tokens is left alone', () => {
  const r = substituteTokens('Just do it.', NONE, {});
  assert.equal(r.prompt, 'Just do it.');
  assert.deepEqual(r.missing, []);
});

test('substituteTokens fills every token in one pass', () => {
  const r = substituteTokens(
    '{task}\n{outputs.plan}\n{previous}\n{diff}\n{changed}\n{roots}{feedback}',
    { task: 'T', feedback: ' F', previous: 'P', diff: 'D', changed: 'C', roots: 'R' },
    { plan: 'PLAN' },
  );
  assert.equal(r.prompt, 'T\nPLAN\nP\nD\nC\nR F');
  assert.deepEqual(r.missing, []);
});

test('tokens inside substituted output text are left alone', () => {
  // The bug: staged replaceAll passes rescanned inserted text, so a plan *about*
  // the hand-off tokens got itself pasted once per literal {previous} and the diff
  // once per literal {diff} — 3.8 MB of prompt from a 13 KB plan and a 105 KB diff.
  const plan = 'The step fills {previous}, {diff}, {changed} and {roots}; see {previous} again.';
  const r = substituteTokens(
    'Implement {outputs.plan}',
    { task: '', feedback: '', previous: 'PREV', diff: 'DIFF', changed: 'CHANGED', roots: 'ROOTS' },
    { plan },
  );
  assert.equal(r.prompt, `Implement ${plan}`);
  assert.equal(r.prompt.split('PREV').length - 1, 0);
  assert.equal(r.prompt.split('DIFF').length - 1, 0);
  assert.equal(r.prompt.split('CHANGED').length - 1, 0);
  assert.equal(r.prompt.split('ROOTS').length - 1, 0);
});

test('substituteTokens reports absent and blank output names once each', () => {
  const r = substituteTokens('{outputs.plan} {outputs.plan} {outputs.notes}', NONE, { notes: '  ' });
  assert.deepEqual(r.missing, ['plan', 'notes']);
  assert.equal(r.prompt, '  ');
});

test('unfilled hand-off tokens collapse to empty for a non-fresh step', () => {
  const r = substituteTokens('Do it.\n{previous}{diff}', NONE, {});
  assert.equal(r.prompt, 'Do it.\n');
});
