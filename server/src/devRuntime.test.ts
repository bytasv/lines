import assert from 'node:assert/strict';
import test from 'node:test';
import { DevRuntime, DEV_UPDATING } from './devRuntime.ts';

test('admission gate refuses work before executing it', async () => {
  const runtime = new DevRuntime(false);
  runtime.held = true;
  let ran = false;
  await assert.rejects(runtime.run(async () => { ran = true; }), { message: DEV_UPDATING });
  assert.equal(ran, false);
});

test('requests remain reload blockers until asynchronous work settles, including failures', async () => {
  const runtime = new DevRuntime(false);
  runtime.configure(() => ({ ready: true, blockers: [] }));
  let release!: () => void;
  const pending = runtime.run(() => new Promise<void>((resolve) => { release = resolve; }));
  assert.deepEqual(runtime.snapshot().blockers, ['requests in flight']);
  release(); await pending;
  assert.deepEqual(runtime.snapshot().blockers, []);
  await assert.rejects(runtime.run(async () => { throw new Error('failed'); }));
  assert.deepEqual(runtime.snapshot().blockers, []);
});

test('non-supervised runtime never defers session reconciliation', () => {
  const runtime = new DevRuntime(false);
  let called = 0;
  runtime.whenActive(() => { called++; });
  assert.equal(called, 1);
  assert.equal(runtime.held, false);
});
