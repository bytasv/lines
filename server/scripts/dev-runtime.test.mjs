import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { buildGeneration, WorkerRunner, BridgeRunner, policyCommand } from './dev-runtime.mjs';

const actualRoot = path.resolve(import.meta.dirname, '../..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
function fixture(t, cleanup = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-dev-runtime-'));
  for (const dir of ['server/src', 'shared']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.symlinkSync(path.join(actualRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  for (const file of ['package.json', 'server/package.json', 'shared/package.json']) {
    fs.writeFileSync(path.join(root, file), JSON.stringify({ type: 'module', main: './types.ts' }));
  }
  fs.writeFileSync(path.join(root, 'shared/types.ts'), 'export const version = 1;');
  fs.writeFileSync(path.join(root, 'server/src/index.ts'), "import { version } from '@lines/shared'; process.stdout.write(String(version));");
  fs.writeFileSync(path.join(root, 'server/src/worker.ts'), 'export const worker = 1;');
  fs.writeFileSync(path.join(root, 'server/src/linesMcpStdio.ts'), 'export const helper = 1;');
  const childFile = path.join(root, 'child.mjs');
  fs.writeFileSync(childFile, `
    import fs from 'node:fs';
    import path from 'node:path';
import { execFileSync } from 'node:child_process';
    const [directory, name] = process.argv.slice(2);
    if (fs.readFileSync(path.join(directory, 'server/src', name === 'worker' ? 'worker.ts' : 'index.ts'), 'utf8').includes('FAIL')) process.exit(9);
    let held = true;
    let activated = false;
    const flags = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, 'flags.json'))}, 'utf8')); } catch { return {}; } };
    const activity = () => ({ready: !flags().unready, blockers: flags().busy ? ['live turn'] : [], relayConnected: true});
    process.on('message', message => {
      if (message.action === 'status') return;
      if (message.action === 'prepare' && flags().race) {
        process.send({type:'devAck', id:message.id, ok:false, ...activity()}); return;
      }
      if (message.action === 'prepare') held = true;
      if (message.action === 'activate') { held = false; activated = true; }
      if (message.action === 'exit') process.exit(7);
      process.send({type:'devAck', id:message.id, ok:!flags().busy, ...activity(), held, activated});
    });
    setInterval(() => process.send({type:'devActivity', ...activity(), held, activated}), 40);
  `);
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, childFile, flags: (flags) => fs.writeFileSync(path.join(root, 'flags.json'), JSON.stringify(flags)) };
}
async function running(t) {
  const f = fixture(t, false);
  const options = { quietMs: 100, startupMs: 1200,
    command: (name, generation) => [f.childFile, generation.directory, name] };
  const supervisor = new WorkerRunner(f.root, options);
  const bridge = new BridgeRunner(f.root, options);
  // Stop processes before removing the fixture, regardless of assertion failures.
  t.after(async () => {
    await supervisor.stop();
    await bridge.stop();
    await until(() => !supervisor.ticking, 'supervisor stopped');
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  await bridge.start();
  await supervisor.start();
  return { ...f, supervisor, bridge, options };
}

test('generations isolate local sources, shared imports, and MCP helper paths', async (t) => {
  const { root } = fixture(t);
  const first = await buildGeneration(root);
  fs.writeFileSync(path.join(root, 'shared/types.ts'), 'export const version = 2;');
  const second = await buildGeneration(root);
  assert.notEqual(first.id, second.id);
  assert.equal(fs.readFileSync(path.join(first.directory, 'node_modules/@lines/shared/types.ts'), 'utf8'), 'export const version = 1;');
  assert.ok(fs.existsSync(path.join(first.directory, 'server/src/linesMcpStdio.ts')));
  assert.equal((await buildGeneration(root)).id, second.id);
  const output = execFileSync(process.execPath, ['--import', path.join(actualRoot, 'node_modules/tsx/dist/loader.mjs'), path.join(first.directory, 'server/src/index.ts')], { encoding: 'utf8' });
  assert.equal(output.trim(), '1', 'the runtime must resolve the snapshotted shared package');
});

test('active work blocks edits; freeze and resume keep PIDs; idle reloads the pair', async (t) => {
  const { root, flags, supervisor } = await running(t);
  flags({ busy: true });
  await until(() => !supervisor.idle(), 'activity arrives');
  const pids = [...supervisor.children.values()].map((c) => c.process.pid);
  const original = supervisor.current.id;
  fs.writeFileSync(path.join(root, 'shared/types.ts'), 'export const version = 2;');
  await until(() => supervisor.candidate, 'pending generation');
  await delay(350);
  assert.deepEqual([...supervisor.children.values()].map((c) => c.process.pid), pids);
  await policyCommand(root, 'freeze', ['worker']);
  flags({});
  await delay(400);
  assert.equal(supervisor.current.id, original);
  assert.deepEqual([...supervisor.children.values()].map((c) => c.process.pid), pids);
  await policyCommand(root, 'resume', ['worker']);
  await until(() => supervisor.current.id !== original && supervisor.phase === 'running', 'coordinated reload');
  assert.ok([...supervisor.children.values()].every((c) => !pids.includes(c.process.pid)));
});

test('syntax failure retains running code; failed startup rolls back without retry loop', async (t) => {
  const { root, supervisor } = await running(t);
  const original = supervisor.current.id;
  const pid = supervisor.children.get('worker').process.pid;
  fs.writeFileSync(path.join(root, 'server/src/index.ts'), 'const = ;');
  await until(() => supervisor.error?.includes('Build failed'), 'syntax failure');
  assert.equal(supervisor.children.get('worker').process.pid, pid);
  fs.writeFileSync(path.join(root, 'server/src/index.ts'), 'export const FAIL = true;');
  await until(() => supervisor.error?.includes('Rejected') && supervisor.phase === 'running', 'rollback');
  assert.equal(supervisor.current.id, original);
  const restored = supervisor.children.get('worker').process.pid;
  await delay(650);
  assert.equal(supervisor.children.get('worker').process.pid, restored);
  assert.equal(supervisor.candidate, null);
});

test('preparation race cancels reload and reopens admission', async (t) => {
  const { root, flags, supervisor } = await running(t);
  flags({ race: true });
  const original = supervisor.current.id;
  fs.writeFileSync(path.join(root, 'shared/types.ts'), 'export const version = 3;');
  await until(() => supervisor.candidate, 'candidate');
  await delay(650);
  assert.equal(supervisor.current.id, original);
  assert.ok([...supervisor.children.values()].every((c) => !c.activity.held));
  flags({});
  await until(() => supervisor.current.id !== original, 'retry after race settles');
});

test('bridge crash preserves worker PID and active work', async (t) => {
  const { flags, supervisor } = await running(t);
  flags({ busy: true });
  const workerPid = supervisor.children.get('worker').process.pid;
  const bridgePid = supervisor.children.get('bridge').process.pid;
  process.kill(supervisor.children.get('bridge').process.pid, 'SIGTERM');
  await until(() => supervisor.children.get('bridge')?.process.pid !== bridgePid && supervisor.phase === 'running', 'bridge recovery');
  assert.equal(supervisor.children.get('worker').process.pid, workerPid);
});

test('missing or stale activity is never treated as idle', async (t) => {
  const { supervisor } = await running(t);
  supervisor.children.get('worker').at = 0;
  assert.equal(supervisor.idle(), false);
  supervisor.children.get('worker').activity = null;
  assert.equal(supervisor.idle(), false);
});

test('bridge disable/re-enable preserves worker; worker stop preserves bridge and adopts its generation on restart', async (t) => {
  const { root, flags, supervisor, bridge, options } = await running(t);
  flags({ busy: true });
  const workerPid = supervisor.children.get('worker').process.pid;
  await bridge.stop();
  await delay(500);
  assert.equal(supervisor.children.get('worker').process.pid, workerPid);
  const replacement = new BridgeRunner(root, options);
  t.after(() => replacement.stop());
  await replacement.start();
  await until(() => supervisor.children.get('bridge')?.activity?.ready, 're-enabled bridge');
  const bridgePid = replacement.children.get('bridge').process.pid;
  const generation = replacement.current.id;
  await supervisor.stop();
  await delay(500);
  assert.equal(replacement.children.get('bridge').process.pid, bridgePid);
  assert.equal(replacement.children.get('bridge').process.exitCode, null);
  assert.equal(supervisor.children.has('worker'), false, 'stopped worker is not resurrected');
  fs.writeFileSync(path.join(root, 'shared/types.ts'), 'export const version = 123;');
  const coordinator = new WorkerRunner(root, options);
  t.after(() => coordinator.stop());
  await coordinator.start();
  assert.equal(coordinator.current.id, generation);
  assert.equal(replacement.children.get('bridge').process.pid, bridgePid);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

// Exercise the actual runner/guard ownership chain without providers or user state.
async function ownedProcess(t, { unready = false } = {}) {
  const f = fixture(t, false);
  const stateFile = path.join(f.root, 'pids.json');
  const service = path.join(f.root, 'service.mjs');
  fs.writeFileSync(service, `
    import fs from 'node:fs';
    import net from 'node:net';
    import { spawn } from 'node:child_process';
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
    const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.on("SIGINT",()=>{}); setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({service:process.pid, descendant:descendant.pid, port:server.address().port}));
    });
    process.on('message', m => {
      if (m.action !== 'status') process.send?.({type:'devAck',id:m.id,ok:true,ready:${!unready},blockers:[]},()=>{});
    });
    setInterval(() => { if (process.connected) process.send({type:'devActivity',ready:${!unready},blockers:[]},()=>{}); }, 40);
  `);
  const runnerFile = path.join(f.root, 'runner.mjs');
  fs.writeFileSync(runnerFile, `
    import { Supervisor, watchOwner } from ${JSON.stringify(new URL('./dev-runtime.mjs', import.meta.url).href)};
    const runner = new Supervisor(${JSON.stringify(f.root)}, {command:()=>[${JSON.stringify(service)}],startupMs:10000});
    const stop = () => runner.stop().then(()=>process.exit(0));
    process.on('SIGTERM',stop); process.on('SIGINT',stop); watchOwner(stop);
    await runner.startChild('worker', {id:'test'});
    if (${unready}) runner.ready('worker').catch(()=>{});
    setInterval(()=>{},1000);
  `);
  const runner = spawn(process.execPath, [runnerFile], { stdio: ['ignore', 'ignore', 'inherit'] });
  let state;
  t.after(async () => {
    if (alive(runner.pid)) runner.kill('SIGTERM');
    await until(() => !alive(runner.pid), 'runner cleanup');
    if (state) await until(() => !alive(state.service) && !alive(state.descendant), 'service cleanup');
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  await until(() => fs.existsSync(stateFile), 'service listening');
  state = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(await portOpen(state.port), true);
  return { runner, state };
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
  test(`${signal} of runner reaps service and stubborn descendants and releases port`, async (t) => {
    const { runner, state } = await ownedProcess(t);
    runner.kill(signal);
    await until(() => !alive(runner.pid) && !alive(state.service) && !alive(state.descendant), 'owned tree exits');
    assert.equal(await portOpen(state.port), false);
  });
}

test('shutdown during startup does not spawn replacement processes', async (t) => {
  const { runner, state } = await ownedProcess(t, { unready: true });
  runner.kill('SIGTERM');
  await until(() => !alive(runner.pid) && !alive(state.service) && !alive(state.descendant), 'startup shutdown');
  assert.equal(await portOpen(state.port), false);
});

test('shutdown during coordinated reload cannot restart the worker', async (t) => {
  const { root, supervisor } = await running(t);
  fs.writeFileSync(path.join(root, 'shared/types.ts'), 'export const version = 321;');
  await until(() => supervisor.phase === 'reloading', 'reload starts');
  await supervisor.stop();
  await until(() => !supervisor.ticking, 'reload finishes');
  assert.equal(supervisor.children.has('worker'), false);
});
