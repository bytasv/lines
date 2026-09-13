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

test('session reload blockers include approvals, queued prompts, background work, and authentication holds', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { SessionManager } = await import('./sessions.ts');
  const { createStore } = await import('./store.ts');
  const { GuardAllowlist } = await import('./autoGuard.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-reload-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([{
    id: 's1', name: 'test', cwd: root, status: 'done', createdAt: 1,
  }]));
  const store = createStore(root);
  const sessions = new SessionManager(store, new GuardAllowlist(store), () => {});
  const meta = sessions.get('s1')!;
  assert.deepEqual(sessions.devReloadBlockers(), []);
  for (const status of ['running', 'waiting-permission', 'waiting-approval'] as const) {
    meta.status = status;
    assert.ok(sessions.devReloadBlockers().length > 0, status);
  }
  meta.status = 'done';
  meta.queued = [{ id: 'q1', ts: 1, text: 'next task' }];
  assert.ok(sessions.devReloadBlockers().length > 0, 'queued work');
  meta.queued = [];
  meta.backgroundTasks = [{ task_id: 'b1', task_type: 'local_bash', description: 'still working' }];
  assert.ok(sessions.devReloadBlockers().length > 0, 'background work');
  meta.backgroundTasks = undefined;
  sessions.holdForAuth('s1');
  assert.ok(sessions.devReloadBlockers().length > 0, 'authentication handshake');
  sessions.releaseAuthHold('s1');
  assert.deepEqual(sessions.devReloadBlockers(), []);
});
