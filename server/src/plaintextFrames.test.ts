import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { plaintextFrameAllowed } from '../../web/src/lib/plaintextFrames.ts';

/**
 * The browser's half of "the relay can't forge": on a link that opened with a
 * pinned machine key, a frame in the clear is the relay talking, and is not
 * applied. Tested from the server's runner because that is the only test runner
 * this repo has.
 */
describe('plaintextFrameAllowed', () => {
  test('a forged app frame on a pinned link is refused, whatever the handshake state', () => {
    // Pinned is for the socket's whole life: a forged `e2eeReady` cannot talk the
    // link back into accepting plaintext, which is what keying on the handshake
    // flags would have allowed.
    for (const type of ['hello', 'transcript', 'session', 'event', 'pong', 'error']) {
      assert.equal(plaintextFrameAllowed(true, type), false, type);
    }
  });

  test('the relay’s own control frames still arrive in the clear', () => {
    for (const pinned of [true, false]) {
      assert.equal(plaintextFrameAllowed(pinned, 'deviceOffline'), true);
      assert.equal(plaintextFrameAllowed(pinned, 'deviceOnline'), true);
    }
  });

  test('a link with no pin takes plaintext as before', () => {
    assert.equal(plaintextFrameAllowed(false, 'hello'), true);
  });
});
