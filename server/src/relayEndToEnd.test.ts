import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';

/**
 * The whole tunnel, for real: a relay process, a bridge dialling out to it, and
 * a browser reaching that bridge only through the relay. Nothing here stubs a
 * socket — the point is to prove `handleConnection` serves a relay channel
 * exactly as it serves a direct one.
 */

const HOME = path.join('/tmp', `lines-relay-e2e-${process.pid}`);
const DEVICE = 'test-device';
const REPO = path.resolve(import.meta.dirname, '../..');

let relay: ChildProcess;
let bridge: ChildProcess;
let relayPort = 0;
let bridgeLog = '';

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

before(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'proj', 'note.md'), 'relayed hello');
  fs.mkdirSync(path.join(HOME, '.lines-app'), { recursive: true });
  fs.writeFileSync(
    path.join(HOME, '.lines-app', 'projects.json'),
    JSON.stringify([{ path: path.join(HOME, 'proj') }]),
  );

  // Relay on an ephemeral port, auth off — the Device table arrives in Phase 3.
  // Its keepalive is compressed to stay well inside the bridge's idle window below;
  // its own reap threshold is left long, so only the bridge-side watchdog is under
  // test here.
  relay = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(REPO, 'relay'),
    env: {
      ...process.env,
      RELAY_PORT: '0',
      RELAY_AUTH_DISABLED: '1',
      RELAY_AGENT_PING_MS: '400',
      RELAY_AGENT_DEAD_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  relay.stdout!.on('data', (c) => (out += String(c)));
  const match = await until(() => /listening on http:\/\/localhost:(\d+)/.exec(out), 'relay to listen');
  relayPort = Number(match[1]);

  bridge = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(REPO, 'server'),
    env: {
      ...process.env,
      HOME,
      BRIDGE_AUTH_DISABLED: '1',
      LINES_BRIDGE_PORT: '',
      LINES_INSTANCE: 'relay-e2e',
      STORAGE_URL: '',
      RELAY_URL: `ws://127.0.0.1:${relayPort}`,
      LINES_DEVICE_ID: DEVICE,
      LINES_DEVICE_SECRET: 'dev-secret',
      // Compressed watchdog: the relay pings every 400ms above, so a healthy link
      // never trips this, and a relay that stops answering trips it in ~2s.
      LINES_RELAY_IDLE_MS: '2000',
    },
    // Piped, because the watchdog test's only direct evidence is what the bridge
    // says when it gives up on a socket the OS still calls open.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout!.on('data', (c) => (bridgeLog += String(c)));
  bridge.stderr!.on('data', (c) => (bridgeLog += String(c)));
  // The bridge publishes only once it is listening; the relay dial follows.
  await until(
    () => fs.existsSync(path.join(HOME, '.lines-app', 'run', 'relay-e2e', 'bridge.json')),
    'bridge to publish',
  );
  await sleep(500); // let the outbound dial land
});

after(async () => {
  bridge?.kill('SIGTERM');
  relay?.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(HOME, { recursive: true, force: true });
});

/** A browser, connected only through the relay. */
function openClient(): { ws: WebSocket; messages: Record<string, unknown>[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/client?device=${DEVICE}`);
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  ws.on('error', () => {
    /* surfaces as a timeout in the assertions below */
  });
  return { ws, messages };
}

const find = (msgs: Record<string, unknown>[], type: string) => msgs.find((m) => m.type === type);

test('a browser reaches the bridge through the relay and gets hello', async () => {
  const { ws, messages } = openClient();
  const hello = await until(() => find(messages, 'hello'), 'hello over the relay');
  // Proof it is the real bridge answering, not the relay: only the bridge knows this.
  assert.ok((hello.bridge as { appProtocol: number }).appProtocol);
  ws.close();
});

test('request/response round-trips over the tunnel', async () => {
  const { ws, messages } = openClient();
  await until(() => find(messages, 'hello'), 'hello');

  ws.send(JSON.stringify({ type: 'ping' }));
  await until(() => find(messages, 'pong'), 'pong');

  ws.send(
    JSON.stringify({
      type: 'fileRequest',
      reqId: 'r1',
      kind: 'file',
      params: { paths: [path.join(HOME, 'proj', 'note.md')] },
    }),
  );
  const res = await until(() => find(messages, 'fileResponse'), 'fileResponse');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { content: 'relayed hello' });
  ws.close();
});

test('two browsers get their own replies', async () => {
  const a = openClient();
  const b = openClient();
  await until(() => find(a.messages, 'hello'), 'hello a');
  await until(() => find(b.messages, 'hello'), 'hello b');

  // Per-channel routing is load-bearing: these replies go to the originating
  // socket, not via broadcast, so a mix-up would show up here.
  a.ws.send(JSON.stringify({ type: 'fileRequest', reqId: 'only-a', kind: 'tree', params: { paths: [path.join(HOME, 'proj')] } }));
  const res = await until(() => find(a.messages, 'fileResponse'), 'reply to a');
  assert.equal(res.reqId, 'only-a');
  assert.equal(find(b.messages, 'fileResponse'), undefined, "b must not see a's reply");

  a.ws.close();
  b.ws.close();
});

test('the bridge gives up on a silent relay and re-dials', async () => {
  // SIGSTOP, not a kill: the socket stays open at the OS level and simply goes
  // quiet, which is exactly the half-open state that used to strand the tunnel —
  // both ends report OPEN, so nothing but silence can reveal it.
  relay.kill('SIGSTOP');
  await until(
    () => bridgeLog.includes('no frame for') || null,
    'the bridge to notice the silence',
    15_000,
  );

  relay.kill('SIGCONT');
  // Recovery is the point, not just the detection: the bridge's own retry re-attaches
  // and a browser gets a fresh hello with no user action anywhere.
  const { ws, messages } = openClient();
  await until(() => find(messages, 'hello'), 'hello after the re-dial');
  ws.close();
});

test('a client that connects while the bridge is down is told, not left hanging', async () => {
  bridge.kill('SIGTERM');
  await sleep(600);

  const { ws, messages } = openClient();
  await until(() => find(messages, 'deviceOffline'), 'deviceOffline');
  // No hello: there is nothing on the other end to produce one.
  assert.equal(find(messages, 'hello'), undefined);
  ws.close();
});
