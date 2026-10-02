import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

/**
 * The header switcher's double-click goes back to the machine used before this
 * one, so `rememberDeviceId` has to record what it replaces — and only when the
 * id actually changes, or re-remembering the same machine would erase it.
 */

const backing = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
};

const { forgetDeviceId, previousDeviceId, rememberDeviceId, rememberedDeviceId } = await import(
  '../../web/src/lib/deviceMemory.ts'
);

describe('previousDeviceId', () => {
  beforeEach(() => backing.clear());

  test('nothing before the first switch', () => {
    rememberDeviceId('a');
    assert.equal(rememberedDeviceId(), 'a');
    assert.equal(previousDeviceId(), null);
  });

  test('a switch records the machine being left', () => {
    rememberDeviceId('a');
    rememberDeviceId('b');
    assert.equal(previousDeviceId(), 'a');
    rememberDeviceId('a');
    assert.equal(previousDeviceId(), 'b');
  });

  test('re-remembering the same machine keeps the previous one', () => {
    rememberDeviceId('a');
    rememberDeviceId('b');
    rememberDeviceId('b');
    assert.equal(previousDeviceId(), 'a');
  });

  test('forgetting the current machine leaves the previous one alone', () => {
    rememberDeviceId('a');
    rememberDeviceId('b');
    forgetDeviceId();
    assert.equal(rememberedDeviceId(), null);
    assert.equal(previousDeviceId(), 'a');
  });
});
