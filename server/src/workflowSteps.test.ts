import test from 'node:test';
import assert from 'node:assert/strict';
// Imported straight out of the web workspace: the rule is pure and
// dependency-free precisely so it can run here, the same arrangement as
// `pointer.test.ts` and `machineMerge.test.ts`. See mobile-client.md.
import { namedStepWindow } from '../../web/src/lib/workflowSteps';

const size = (w: { start: number; end: number }) => w.end - w.start + 1;

test('every step keeps its name while they fit', () => {
  assert.deepEqual(namedStepWindow(4, 0, 4), { start: 0, end: 3 });
  assert.deepEqual(namedStepWindow(3, 2, 4), { start: 0, end: 2 });
});

test('the window centres on the current step', () => {
  assert.deepEqual(namedStepWindow(9, 4, 3), { start: 3, end: 5 });
  assert.deepEqual(namedStepWindow(9, 4, 1), { start: 4, end: 4 });
});

test('it slides rather than shrinks at either end', () => {
  // A workflow spends most of its life on its first and last steps, so the
  // budget must not be half-wasted there.
  assert.equal(size(namedStepWindow(9, 0, 4)), 4);
  assert.equal(size(namedStepWindow(9, 8, 4)), 4);
  assert.deepEqual(namedStepWindow(9, 0, 4), { start: 0, end: 3 });
  assert.deepEqual(namedStepWindow(9, 8, 4), { start: 5, end: 8 });
});

test('a step index outside the workflow still yields a window', () => {
  // A step deleted from under a running session: misplaced is recoverable,
  // empty is a stepper with no names at all.
  assert.deepEqual(namedStepWindow(5, 99, 2), { start: 3, end: 4 });
  assert.deepEqual(namedStepWindow(5, -3, 2), { start: 0, end: 1 });
});

test('degenerate inputs do not produce a negative or oversized window', () => {
  assert.deepEqual(namedStepWindow(0, 0, 4), { start: 0, end: -1 });
  assert.equal(size(namedStepWindow(6, 2, 0)), 1);
  assert.equal(size(namedStepWindow(6, 2, -5)), 1);
  assert.equal(size(namedStepWindow(2, 1, 99)), 2);
});
