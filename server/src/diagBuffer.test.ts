import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  hasUnsentStall,
  parseBuffer,
  pushEntry,
  redactUrl,
  withTimeout,
  type DiagEntry,
} from '../../web/src/lib/diag.ts';

/**
 * The web client's connection record (web/src/lib/diag.ts). Lives here because
 * the web workspace has no test runner — same arrangement as wakeRedial.test.ts.
 */

const e = (t: number, k = 'x'): DiagEntry => ({ t, k });

describe('pushEntry', () => {
  test('trims oldest-first by count', () => {
    let buf: DiagEntry[] = [];
    for (let i = 0; i < 5; i++) buf = pushEntry(buf, e(i), 3);
    assert.deepEqual(
      buf.map((x) => x.t),
      [2, 3, 4],
    );
  });

  test('trims oldest-first by serialized size', () => {
    let buf: DiagEntry[] = [];
    for (let i = 0; i < 50; i++) buf = pushEntry(buf, { t: i, k: 'y'.repeat(50) }, 1000, 500);
    assert.ok(JSON.stringify(buf).length <= 500);
    assert.equal(buf.at(-1)?.t, 49, 'the newest entry always survives');
  });

  test('does not mutate its input', () => {
    const before = [e(1)];
    pushEntry(before, e(2));
    assert.equal(before.length, 1);
  });
});

describe('parseBuffer', () => {
  test('tolerates garbage left in storage', () => {
    assert.deepEqual(parseBuffer(null), []);
    assert.deepEqual(parseBuffer('{not json'), []);
    assert.deepEqual(parseBuffer('{"a":1}'), []);
    assert.deepEqual(parseBuffer('[{"t":1,"k":"a"},{"k":"b"},null]'), [{ t: 1, k: 'a' }]);
  });
});

describe('withTimeout', () => {
  test('a promise that never settles resolves as a timeout instead of hanging', async () => {
    const result = await withTimeout(new Promise<string>(() => {}), 20);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'timeout');
  });

  test('passes a value through', async () => {
    const result = await withTimeout(Promise.resolve('tok'), 1000);
    assert.deepEqual(result.ok && result.value, 'tok');
  });

  test('a rejection resolves as an error, never throws', async () => {
    const result = await withTimeout(Promise.reject(new Error('boom')), 1000);
    assert.equal(!result.ok && result.reason, 'error');
  });
});

describe('redactUrl', () => {
  test('drops the query, which carries the Clerk token', () => {
    assert.equal(redactUrl('wss://lines.example/client?token=abc&device=d'), 'wss://lines.example/client');
    assert.equal(redactUrl('ws://127.0.0.1:1234'), 'ws://127.0.0.1:1234');
  });
});

describe('hasUnsentStall', () => {
  test('only a stall newer than the last upload counts', () => {
    const entries = [e(10, 'dial'), e(20, 'connecting-slow'), e(30, 'hello')];
    assert.equal(hasUnsentStall(entries, 0), true);
    assert.equal(hasUnsentStall(entries, 25), false);
    assert.equal(hasUnsentStall([e(10, 'dial')], 0), false);
  });
});
