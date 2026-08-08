import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, WORKER_TOKEN_HEADER, type RuntimeInfo } from './workerProtocol.ts';

/**
 * The token check lives in worker.ts, which starts listening as a side effect of
 * being imported — so this drives a real worker process instead. It is the branch
 * that makes a stale discovery file fail closed rather than hand an unrelated
 * local process control of the agent, which is worth a live test.
 */
const INSTANCE = `test-handshake-${process.pid}`;
const RUN_DIR = path.join(os.homedir(), '.lines-app', 'run', INSTANCE);
const WORKER_JSON = path.join(RUN_DIR, 'worker.json');

let worker: ChildProcess;
let info: RuntimeInfo;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  worker = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    // No LINES_WORKER_PORT: this also covers the ephemeral bind, which Tilt's
    // pinned port hides in normal dev.
    env: { ...process.env, LINES_INSTANCE: INSTANCE, LINES_WORKER_PORT: '' },
    stdio: 'ignore',
  });

  for (let i = 0; i < 100 && !fs.existsSync(WORKER_JSON); i++) await sleep(100);
  assert.ok(fs.existsSync(WORKER_JSON), 'worker never published worker.json');
  info = JSON.parse(fs.readFileSync(WORKER_JSON, 'utf8')) as RuntimeInfo;
});

after(async () => {
  worker?.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
});

/** Resolves to 'hello' if the worker accepted us, or `close:<code>` if it didn't. */
function dial(token: string | undefined): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}`, {
      headers: token === undefined ? {} : { [WORKER_TOKEN_HEADER]: token },
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string };
      ws.close();
      resolve(msg.type);
    });
    ws.on('close', (code) => resolve(`close:${code}`));
    ws.on('error', () => resolve('error'));
  });
}

test('the worker binds an ephemeral port and publishes it', () => {
  assert.ok(info.port > 0, 'expected an OS-assigned port');
  assert.equal(info.protocolVersion, PROTOCOL_VERSION);
  assert.equal(fs.statSync(WORKER_JSON).mode & 0o777, 0o600);
});

test('a connection with the published token gets the hello handshake', async () => {
  assert.equal(await dial(info.token), 'hello');
});

test('a connection with a wrong token is rejected', async () => {
  assert.equal(await dial('f'.repeat(64)), 'close:1008');
});

test('a connection with no token at all is rejected', async () => {
  assert.equal(await dial(undefined), 'close:1008');
});

test('a rejected connection does not evict the live bridge', async () => {
  // Newest-bridge-wins would otherwise let any local process hang up on the real
  // bridge just by connecting, so the token check has to run first.
  const bridge = new WebSocket(`ws://127.0.0.1:${info.port}`, {
    headers: { [WORKER_TOKEN_HEADER]: info.token },
  });
  let closed = false;
  bridge.on('close', () => {
    closed = true;
  });
  await new Promise((r) => bridge.on('message', r)); // hello = we are the bridge

  assert.equal(await dial('f'.repeat(64)), 'close:1008');
  await sleep(100);

  assert.equal(closed, false, 'an unauthorized dial terminated the real bridge');
  bridge.close();
});
