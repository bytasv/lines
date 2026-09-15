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
  meta.backgroundTasks = [{ id: 'b1', type: 'bash', description: 'still working' }];
  assert.ok(sessions.devReloadBlockers().length > 0, 'background work');
  meta.backgroundTasks = undefined;
  sessions.holdForAuth('s1');
  assert.ok(sessions.devReloadBlockers().length > 0, 'authentication handshake');
  sessions.releaseAuthHold('s1');
  assert.deepEqual(sessions.devReloadBlockers(), []);
});

test('real IPC preparation refuses live work and activation releases startup hold', async (t) => {
  const { spawn } = await import('node:child_process');
  const code = `
    import { devRuntime } from ${JSON.stringify(new URL('./devRuntime.ts', import.meta.url).href)};
    devRuntime.configure(() => ({ ready: true, blockers: [] }));
    let release;
    process.on('message', (m) => {
      if (m.type === 'holdOperation') {
        void devRuntime.run(() => new Promise(r => { release = r; }));
        process.send({ type: 'heldOperation' });
      }
      if (m.type === 'releaseOperation') { release(); process.send({ type: 'releasedOperation' }); }
    });
    process.send({ type: 'boot', held: devRuntime.held });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(), env: { ...process.env, LINES_DEV_SUPERVISED: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill(); await exited; } });
  const messages: any[] = [];
  child.on('message', (message) => messages.push(message));
  async function receive(type: string, id?: string) {
    for (let i = 0; i < 200; i++) {
      const index = messages.findIndex((m) => m.type === type && (!id || m.id === id));
      if (index !== -1) return messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No ${type} response`);
  }
  assert.equal((await receive('boot')).held, true);
  child.send({ type: 'devControl', action: 'activate', id: 'activate' });
  assert.equal((await receive('devAck', 'activate')).ok, true);
  child.send({ type: 'holdOperation' });
  await receive('heldOperation');
  child.send({ type: 'devControl', action: 'prepare', id: 'busy' });
  assert.equal((await receive('devAck', 'busy')).ok, false);
  child.send({ type: 'releaseOperation' });
  await receive('releasedOperation');
  child.send({ type: 'devControl', action: 'prepare', id: 'idle' });
  assert.equal((await receive('devAck', 'idle')).ok, true);
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Supervised service survived IPC loss')), 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  child.disconnect();
  await exited;
  assert.equal(child.signalCode, 'SIGTERM', 'IPC loss uses the normal service shutdown signal');
});

test('worker replay waits for activation, retains FIFO order, and blocks a handover', () => {
  const runtime = new DevRuntime(false);
  runtime.configure(() => ({ ready: true, blockers: [] }));
  runtime.held = true;
  const seen: string[] = [];
  for (const kind of ['hello', 'event', 'rpc', 'ended']) runtime.whenActive(() => seen.push(kind));
  assert.deepEqual(seen, []);
  assert.ok(runtime.snapshot().blockers.includes('deferred worker messages'));
  runtime.activate();
  assert.deepEqual(seen, ['hello', 'event', 'rpc', 'ended']);
  assert.deepEqual(runtime.snapshot().blockers, []);
  runtime.activate();
  assert.equal(seen.length, 4, 'activation must not replay twice');
});
