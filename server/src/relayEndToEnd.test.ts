import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import {
  enrollProof,
  generateEnrollCode,
  generateIdentity,
  startHandshake,
  type ClientMessage,
  type Identity,
  type PublicKeyB64,
  type SecureSession,
} from '@lines/shared';

/**
 * The whole tunnel, for real: a relay process, a bridge dialling out to it, and
 * a browser reaching that bridge only through the relay. Nothing here stubs a
 * socket — the point is to prove `handleConnection` serves a relay channel
 * exactly as it serves a direct one.
 *
 * Every browser here is enrolled and talks over the encrypted channel, because
 * that is the only way an owner reaches a bridge through the relay: there is no
 * plaintext owner path, not even on a machine with nothing enrolled yet. The
 * fixture enrols one client key once, the way a browser does from a code, and
 * every test channel then runs the real handshake — which also keeps the
 * "bridge speaks first" handover under test.
 */

const HOME = path.join('/tmp', `lines-relay-e2e-${process.pid}`);
const DEVICE = 'test-device';
const REPO = path.resolve(import.meta.dirname, '../..');

let relay: ChildProcess;
let bridge: ChildProcess;
let relayPort = 0;
let bridgeLog = '';
/** The enrolled browser's key, shared by every test client. */
let client: Identity;
/** The bridge key the enrolment pinned — never one the relay named. */
let bridgeKey: PublicKeyB64;

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
  // An open enrolment, as the tray (or `npm run enroll`) would leave it.
  const code = generateEnrollCode();
  fs.writeFileSync(
    path.join(HOME, '.lines-app', 'e2ee-enroll.json'),
    JSON.stringify({ code, expiresAt: Date.now() + 10 * 60_000 }),
    { mode: 0o600 },
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

  // Enrol, over the relay, exactly as the gate screen does: a silent socket
  // whose only frame is the proof of the code.
  client = await generateIdentity(true);
  const { ws, messages } = openRaw();
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(
    JSON.stringify({
      type: 'e2eeEnroll',
      clientKey: client.publicKey,
      proof: await enrollProof(code, 'enroll', client.publicKey),
    } satisfies ClientMessage),
  );
  const enrolled = await until(() => find(messages, 'e2eeEnrolled'), 'enrolment');
  bridgeKey = enrolled.bridgeKey as string;
  assert.equal(
    enrolled.proof,
    await enrollProof(code, 'enrolled', client.publicKey, bridgeKey),
    'the answering proof ties the bridge key to the code',
  );
  ws.close();
});

after(async () => {
  bridge?.kill('SIGTERM');
  relay?.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(HOME, { recursive: true, force: true });
});

/** A socket through the relay, frames as they arrive — no handshake. */
function openRaw(): { ws: WebSocket; messages: Record<string, unknown>[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/client?device=${DEVICE}`);
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  ws.on('error', () => {
    /* surfaces as a timeout in the assertions below */
  });
  return { ws, messages };
}

interface Client {
  ws: WebSocket;
  /** Every frame the bridge sent, sealed ones already opened. */
  messages: Record<string, unknown>[];
  /** Send one app message, sealed. */
  send: (msg: Record<string, unknown>) => void;
}

/**
 * An enrolled browser, connected only through the relay: it runs the handshake
 * against the pinned bridge key, then seals and opens every app frame.
 */
async function openClient(): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/client?device=${DEVICE}`);
  const messages: Record<string, unknown>[] = [];
  let session: SecureSession | null = null;
  // Opened in arrival order: the receiver refuses a counter it has passed, so
  // two frames decrypting out of order would read as a replay.
  let opening = Promise.resolve();
  let sending = Promise.resolve();
  const initiator = await startHandshake(client, bridgeKey);
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as Record<string, unknown>;
    opening = opening.then(async () => {
      if (msg.type === 'e2eeAccept') {
        const done = await initiator.finish(msg.accept as Parameters<typeof initiator.finish>[0]);
        session = done.session;
        ws.send(JSON.stringify({ type: 'e2eeConfirm', confirm: done.confirm } satisfies ClientMessage));
        return;
      }
      if (msg.type === 'e2eeData' && session) {
        messages.push(JSON.parse(await session.open({ n: msg.n as number, d: msg.d as string })));
        return;
      }
      messages.push(msg);
    });
  });
  ws.on('error', () => {
    /* surfaces as a timeout in the assertions below */
  });
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'e2eeHello', offer: initiator.offer } satisfies ClientMessage));
  await until(() => find(messages, 'e2eeReady'), 'the encrypted channel');
  const send = (msg: Record<string, unknown>) => {
    const sealed = session!;
    sending = sending.then(async () => {
      ws.send(JSON.stringify({ type: 'e2eeData', ...(await sealed.seal(JSON.stringify(msg))) }));
    });
  };
  return { ws, messages, send };
}

const find = (msgs: Record<string, unknown>[], type: string) => msgs.find((m) => m.type === type);

test('a browser reaches the bridge through the relay and gets hello', async () => {
  const { ws, messages } = await openClient();
  const hello = await until(() => find(messages, 'hello'), 'hello over the relay');
  // Proof it is the real bridge answering, not the relay: only the bridge knows this.
  assert.ok((hello.bridge as { appProtocol: number }).appProtocol);
  ws.close();
});

test('request/response round-trips over the tunnel', async () => {
  const { ws, messages, send } = await openClient();
  await until(() => find(messages, 'hello'), 'hello');

  send({ type: 'ping' });
  await until(() => find(messages, 'pong'), 'pong');

  send({
    type: 'fileRequest',
    reqId: 'r1',
    kind: 'file',
    params: { paths: [path.join(HOME, 'proj', 'note.md')] },
  });
  const res = await until(() => find(messages, 'fileResponse'), 'fileResponse');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { content: 'relayed hello' });
  ws.close();
});

test('two browsers get their own replies', async () => {
  const a = await openClient();
  const b = await openClient();
  await until(() => find(a.messages, 'hello'), 'hello a');
  await until(() => find(b.messages, 'hello'), 'hello b');

  // Per-channel routing is load-bearing: these replies go to the originating
  // socket, not via broadcast, so a mix-up would show up here.
  a.send({ type: 'fileRequest', reqId: 'only-a', kind: 'tree', params: { paths: [path.join(HOME, 'proj')] } });
  const res = await until(() => find(a.messages, 'fileResponse'), 'reply to a');
  assert.equal(res.reqId, 'only-a');
  assert.equal(find(b.messages, 'fileResponse'), undefined, "b must not see a's reply");

  a.ws.close();
  b.ws.close();
});

test('a browser with no key is refused, not served in the clear', async () => {
  // The machine has an enrolled browser, but that is beside the point: an owner
  // channel over the relay never carries plaintext app traffic.
  const { ws, messages } = openRaw();
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'ping' }));
  const refusal = await until(() => find(messages, 'e2eeError'), 'the refusal');
  assert.match(String(refusal.reason), /end-to-end encrypted channel/);
  assert.equal(find(messages, 'hello'), undefined, 'the bridge never saw this channel');
  ws.close();
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
  const { ws, messages } = await openClient();
  await until(() => find(messages, 'hello'), 'hello after the re-dial');
  ws.close();
});

test('a client that connects while the bridge is down is told, not left hanging', async () => {
  bridge.kill('SIGTERM');
  await sleep(600);

  // Raw: with nothing on the other end there is no handshake to wait for.
  const { ws, messages } = openRaw();
  await until(() => find(messages, 'deviceOffline'), 'deviceOffline');
  // No hello: there is nothing on the other end to produce one.
  assert.equal(find(messages, 'hello'), undefined);
  ws.close();
});
