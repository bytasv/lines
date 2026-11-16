import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  REFUSED_RETRY_BASE_MS,
  REFUSED_RETRY_CAP_MS,
  clearRefusalFor,
  refusalFor,
  refusedReconnectDelay,
} from '../../web/src/lib/connectRefusal.ts';

/**
 * A refusal belongs to the machine that sent it. The window links to several
 * machines at once; a secondary one refusing used to put the enroll form on the
 * connecting screen of a machine this browser was already enrolled with.
 * Tested from the server's runner because that is the only test runner this repo has.
 */
describe('refusalFor', () => {
  const refusal = { deviceId: 'machine-b', reason: 'admits a guest only through the invite link' };

  test("another machine's refusal is invisible", () => {
    assert.equal(refusalFor(refusal, 'machine-a'), null);
  });

  test("a machine sees its own refusal", () => {
    assert.equal(refusalFor(refusal, 'machine-b'), refusal.reason);
  });

  test('no refusal reads as none', () => {
    assert.equal(refusalFor(null, 'machine-a'), null);
  });
});

describe('clearRefusalFor', () => {
  const refusal = { deviceId: 'machine-b', reason: 'refused' };

  test("clearing one machine leaves another machine's refusal in place", () => {
    assert.equal(clearRefusalFor(refusal, 'machine-a'), refusal);
  });

  test('clearing the refusing machine clears it', () => {
    assert.equal(clearRefusalFor(refusal, 'machine-b'), null);
  });
});

describe('refusedReconnectDelay', () => {
  test('starts at the ordinary reconnect delay and doubles', () => {
    assert.equal(refusedReconnectDelay(1), REFUSED_RETRY_BASE_MS);
    assert.equal(refusedReconnectDelay(2), REFUSED_RETRY_BASE_MS * 2);
    assert.equal(refusedReconnectDelay(3), REFUSED_RETRY_BASE_MS * 4);
  });

  test('caps at five minutes, however long the refusals run', () => {
    assert.equal(REFUSED_RETRY_CAP_MS, 300_000);
    assert.equal(refusedReconnectDelay(9), REFUSED_RETRY_CAP_MS);
    assert.equal(refusedReconnectDelay(10_000), REFUSED_RETRY_CAP_MS);
  });

  test('a nonsense count is treated as the first refusal', () => {
    assert.equal(refusedReconnectDelay(0), REFUSED_RETRY_BASE_MS);
    assert.equal(refusedReconnectDelay(-3), REFUSED_RETRY_BASE_MS);
  });
});
