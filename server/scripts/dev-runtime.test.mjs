import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildGeneration, Supervisor, policyCommand } from './dev-runtime.mjs';

const actualRoot = path.resolve(import.meta.dirname, '../..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 8000;
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
  const supervisor = new Supervisor(f.root, { quietMs: 100, startupMs: 1200,
    command: (name, generation) => [f.childFile, generation.directory, name] });
  // Stop processes before removing the fixture, regardless of assertion failures.
  t.after(async () => {
    await supervisor.stop();
    await until(() => !supervisor.ticking, 'supervisor stopped');
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  await supervisor.start();
  return { ...f, supervisor };
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
  supervisor.children.get('bridge').process.kill('SIGKILL');
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
