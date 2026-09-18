import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isLoopbackAddress } from './locality.ts';

/**
 * The predicate behind `hello.local`, and the whole reason "not relayed" was not
 * good enough: the bridge listens on every interface, so a direct socket can
 * come from another computer on the LAN.
 */
describe('isLoopbackAddress', () => {
  test('accepts every shape the loopback actually arrives in', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    // The whole /8 is loopback, not just .1.
    assert.equal(isLoopbackAddress('127.1.2.3'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    // A dual-stack listener reports an IPv4 client this way.
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::FFFF:127.0.0.1'), true);
  });

  test('a LAN peer is not local', () => {
    assert.equal(isLoopbackAddress('192.168.1.20'), false);
    assert.equal(isLoopbackAddress('::ffff:192.168.1.20'), false);
    assert.equal(isLoopbackAddress('fe80::1%en0'), false);
    // Not in 127.0.0.0/8, however similar it reads.
    assert.equal(isLoopbackAddress('12.7.0.0.1'), false);
  });

  test('an unknown address fails closed', () => {
    // A socket that has already gone away reports nothing; hiding a button is
    // the cheap outcome, opening a dialog on someone else's desk is not.
    assert.equal(isLoopbackAddress(undefined), false);
    assert.equal(isLoopbackAddress(null), false);
    assert.equal(isLoopbackAddress(''), false);
  });
});
