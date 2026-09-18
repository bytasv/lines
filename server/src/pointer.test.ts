import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { revealActions } from '../../web/src/lib/pointer.ts';

/**
 * The hover rule, tested from the server's runner because that is the only test
 * runner this repo has. `pointer.ts` is a pure function for exactly this reason
 * — the hook beside it touches `matchMedia`, which node does not have.
 */
describe('revealActions', () => {
  test('a mouse keeps the behaviour it always had', () => {
    assert.equal(revealActions(true, false), true);
    assert.equal(revealActions(false, false), false);
  });

  test('a finger sees the actions without hovering', () => {
    // Touch never sets `hovered`, so under the old rule delete, rewind and edit
    // simply did not exist on a phone.
    assert.equal(revealActions(false, true), true);
  });
});
