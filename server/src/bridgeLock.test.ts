import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

/**
 * `~/.lines-app/bridge.lock`, driven with real bridge processes.
 *
 * It has to be real processes: the lock's whole job is deciding what a *second*
 * start does, and the interesting outcomes are an exit code and a signal delivered
 * to a live pid. There is no in-process seam that can express either, and the hole
 * that shipped (a lock claimed only when RELAY_URL was set, released only on
 * SIGTERM) was exactly the kind a unit test of a pure function would have missed.
 */

const REPO = path.resolve(import.meta.dirname, '../..');
const EXIT_BRIDGE_LOCK_HELD = 78;

const children: ChildProcess[] = [];
const homes: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | null | undefined, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

/** A private HOME per case: the lock is machine-global, so cases must not share one. */
function newHome(tag: string): string {
  const home = path.join('/tmp', `lines-bridge-lock-${process.pid}-${tag}`);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.lines-app'), { recursive: true });
  homes.push(home);
  return home;
}

const lockFile = (home: string) => path.join(home, '.lines-app', 'bridge.lock');
const deviceFile = (home: string) => path.join(home, '.lines-app', 'device.json');
const bridgeJson = (home: string, instance: string) =>
  path.join(home, '.lines-app', 'run', instance, 'bridge.json');

function readLock(home: string): { pid: number; instance: string; deviceId: string | null } | null {
  try {
    return JSON.parse(fs.readFileSync(lockFile(home), 'utf8')) as {
      pid: number;
      instance: string;
      deviceId: string | null;
    };
  } catch {
    return null;
  }
}

interface Bridge {
  child: ChildProcess;
  output: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startBridge(home: string, instance: string, extra: Record<string, string> = {}): Bridge {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(REPO, 'server'),
    env: {
      ...process.env,
      HOME: home,
      BRIDGE_AUTH_DISABLED: '1',
      LINES_BRIDGE_PORT: '',
      LINES_INSTANCE: instance,
      // Empty rather than absent: dotenv keeps a key that already exists, so this
      // is what stops the repo-root .env pointing a test bridge at the production
      // relay — and, with it, minting a device.json this test then asserts about.
      RELAY_URL: '',
      STORAGE_URL: '',
      LINES_ALLOW_MULTIPLE_BRIDGES: '',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', (c) => (output += String(c)));
  child.stderr!.on('data', (c) => (output += String(c)));
  return {
    child,
    output: () => output,
    exit: new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal }))),
  };
}

after(async () => {
  for (const c of children) c.kill('SIGKILL');
  await sleep(200);
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

test('a bridge with no RELAY_URL still claims the lock, and mints no device identity', async () => {
  // The lock is not relay-specific: ~/.lines-app assumes a sole writer either way.
  // And resolving an identity we will never use would grow a credential file on a
  // purely local install, so the claim must not be what forces one.
  const home = newHome('local-only');
  const bridge = startBridge(home, 'local-only');
  const held = await until(() => readLock(home), 'the lock to be claimed');

  assert.equal(held.pid, bridge.child.pid);
  assert.equal(held.instance, 'local-only');
  assert.equal(held.deviceId, null);
  assert.equal(fs.existsSync(deviceFile(home)), false, 'a local-only bridge minted device.json');
});

test('a second bridge refuses, exits 78, and leaves the incumbent alone', async () => {
  const home = newHome('collision');
  const first = startBridge(home, 'incumbent');
  await until(() => readLock(home), 'the first claim');
  const before = fs.readFileSync(lockFile(home));

  const second = startBridge(home, 'newcomer');
  const { code } = await second.exit;

  assert.equal(code, EXIT_BRIDGE_LOCK_HELD);
  assert.deepEqual(fs.readFileSync(lockFile(home)), before, "the refused start rewrote the holder's lock");
  assert.equal(first.child.exitCode, null, 'the incumbent died');
  // The escape hatch has to be discoverable from the refusal itself: this is now a
  // behaviour change for anyone who used to run two local-only bridges.
  assert.match(second.output(), /LINES_ALLOW_MULTIPLE_BRIDGES/);
});

test('a lock naming a dead pid is taken over', async () => {
  const home = newHome('dead-pid');
  fs.writeFileSync(
    lockFile(home),
    JSON.stringify({ pid: 999_999, startedAt: Date.now() - 1_000, deviceId: null, instance: 'ghost' }),
  );
  const bridge = startBridge(home, 'takeover');

  const held = await until(() => {
    const l = readLock(home);
    return l && l.pid === bridge.child.pid ? l : null;
  }, 'the stale lock to be taken over');
  assert.equal(held.instance, 'takeover');
});

test('a corrupt lock is taken over', async () => {
  // A truncated write must never be the reason a user cannot start their bridge.
  const home = newHome('corrupt');
  fs.writeFileSync(lockFile(home), '{"pid":12');
  const bridge = startBridge(home, 'takeover');

  const held = await until(() => {
    const l = readLock(home);
    return l && l.pid === bridge.child.pid ? l : null;
  }, 'the corrupt lock to be replaced');
  assert.equal(held.instance, 'takeover');
});

test('LINES_ALLOW_MULTIPLE_BRIDGES=1 neither reads nor writes the lock', async () => {
  const home = newHome('escape-hatch');
  // A live holder (this test process) that is not the desktop app: without the flag
  // this is the refusal path, so an untouched file proves the flag short-circuits
  // before the read as well as before the write.
  const sentinel = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    deviceId: null,
    instance: 'sentinel-holder',
  });
  fs.writeFileSync(lockFile(home), sentinel);

  startBridge(home, 'escape-hatch', { LINES_ALLOW_MULTIPLE_BRIDGES: '1' });
  await until(() => fs.existsSync(bridgeJson(home, 'escape-hatch')) || null, 'the bridge to listen');

  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), sentinel);
});

test("a dev bridge preempts the desktop app's bridge", async () => {
  const home = newHome('preempt');
  // instance 'desktop' is the only preemptible holder, and its published
  // run/desktop/bridge.json is what authorises the signal — the lock's word alone
  // must never be enough to SIGTERM a pid.
  const tray = startBridge(home, 'desktop');
  await until(() => fs.existsSync(bridgeJson(home, 'desktop')) || null, 'the tray bridge to publish');
  await until(() => readLock(home), 'the tray bridge to claim the lock');

  const dev = startBridge(home, 'default');
  // Exits 0, not by signal: SIGTERM is what its own shutdown() handles, which is
  // also what releases the lock.
  const { code } = await tray.exit;
  assert.equal(code, 0);

  const held = await until(() => {
    const l = readLock(home);
    return l && l.pid === dev.child.pid ? l : null;
  }, 'the lock to name the newcomer');
  assert.equal(held.instance, 'default');
  assert.equal(dev.child.exitCode, null, 'the preempting bridge did not survive its own takeover');
});
