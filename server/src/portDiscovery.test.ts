import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';

// Point the helpers at a throwaway instance before importing them: RUNTIME_DIR
// is resolved once at module load, and the real one belongs to a running app.
// Hence the dynamic import — a static one would be hoisted above this line.
process.env.LINES_INSTANCE = `test-${process.pid}`;
const { RUNTIME_DIR, clearRuntimeInfo, newRuntimeToken, publishRuntimeInfo, readRuntimeInfo } =
  await import('./workerProtocol.ts');

const info = (over: Partial<Parameters<typeof publishRuntimeInfo>[1]> = {}) => ({
  port: 54321,
  pid: process.pid,
  startedAt: Date.now(),
  protocolVersion: 4,
  token: newRuntimeToken(),
  ...over,
});

/** A pid that has certainly exited: spawnSync reaps the child before returning. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  assert.ok(pid, 'expected a pid from the reaped child');
  return pid;
}

after(() => fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }));

test('a published file round-trips and is owner-only', () => {
  const written = info();
  publishRuntimeInfo('worker', written);

  assert.deepEqual(readRuntimeInfo('worker'), written);
  // 0600: the token in this file is what gates the worker connection.
  const mode = fs.statSync(path.join(RUNTIME_DIR, 'worker.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('publishing leaves no temp file behind', () => {
  publishRuntimeInfo('worker', info());
  const strays = fs.readdirSync(RUNTIME_DIR).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(strays, []);
});

test('a file naming a dead process reads as absent and is removed', () => {
  publishRuntimeInfo('worker', info({ pid: deadPid() }));
  const file = path.join(RUNTIME_DIR, 'worker.json');
  assert.equal(fs.existsSync(file), true);

  assert.equal(readRuntimeInfo('worker'), null);
  // Removed, not merely ignored — otherwise every reconnect re-reads the corpse.
  assert.equal(fs.existsSync(file), false);
});

test('a missing or unparseable file reads as absent', () => {
  assert.equal(readRuntimeInfo('bridge'), null);

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNTIME_DIR, 'bridge.json'), '{ not json');
  assert.equal(readRuntimeInfo('bridge'), null);
});

test('a file missing its port or token reads as absent', () => {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const file = path.join(RUNTIME_DIR, 'bridge.json');

  fs.writeFileSync(file, JSON.stringify({ ...info(), port: undefined }));
  assert.equal(readRuntimeInfo('bridge'), null);

  fs.writeFileSync(file, JSON.stringify({ ...info(), token: undefined }));
  assert.equal(readRuntimeInfo('bridge'), null);
});

test('clearRuntimeInfo removes the file and tolerates a second call', () => {
  publishRuntimeInfo('worker', info());
  clearRuntimeInfo('worker');
  assert.equal(readRuntimeInfo('worker'), null);
  clearRuntimeInfo('worker'); // already gone — must not throw
});

test('the two names are independent', () => {
  const worker = info({ port: 1111 });
  const bridge = info({ port: 2222 });
  publishRuntimeInfo('worker', worker);
  publishRuntimeInfo('bridge', bridge);

  assert.equal(readRuntimeInfo('worker')?.port, 1111);
  assert.equal(readRuntimeInfo('bridge')?.port, 2222);

  clearRuntimeInfo('worker');
  assert.equal(readRuntimeInfo('bridge')?.port, 2222);
});
