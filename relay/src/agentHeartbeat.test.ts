import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import { WebSocket } from 'ws';

/**
 * The keepalive on the /agent link, against a real relay process.
 *
 * A half-open socket is the whole point: both ends still report OPEN, so nothing
 * short of silence can reveal it. That cannot be faked with a stub sink — it needs
 * a real socket the relay believes in and a peer that stops answering. Intervals
 * are compressed through the env rather than with mock timers, because node's mock
 * timers and a live `ws` socket corrupt each other's timer lists.
 */

const RELAY_DIR = path.resolve(import.meta.dirname, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const spawned: ChildProcess[] = [];
const servers: http.Server[] = [];

after(async () => {
  for (const child of spawned) child.kill('SIGKILL');
  for (const server of servers) server.close();
  await sleep(100);
});

async function until<T>(fn: () => T | null | undefined, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

/** A relay on an ephemeral port, with whatever intervals the test needs. */
async function startRelay(env: Record<string, string>): Promise<number> {
  const relay = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: RELAY_DIR,
    env: { ...process.env, RELAY_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  spawned.push(relay);
  let out = '';
  relay.stdout!.on('data', (c) => (out += String(c)));
  const match = await until(() => /listening on http:\/\/localhost:(\d+)/.exec(out), 'relay to listen');
  return Number(match[1]);
}

/** A bridge, as the relay sees one: a socket that may or may not keep answering. */
function openAgent(port: number, device: string, opts: { answerPings: boolean }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent?device=${device}&secret=dev-secret`);
  const frames: { t: string }[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', version: 1, appProtocol: 1 })));
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as { t: string };
    frames.push(frame);
    if (frame.t === 'ping' && opts.answerPings) ws.send(JSON.stringify({ t: 'pong' }));
  });
  ws.on('close', (code: number, reason: Buffer) => (closed = { code, reason: reason.toString() }));
  ws.on('error', () => {
    /* surfaces as a timeout in the assertions */
  });
  return {
    ws,
    pings: () => frames.filter((f) => f.t === 'ping').length,
    closed: () => closed as { code: number; reason: string } | null,
  };
}

/** A browser, which is where the consequence of a reap becomes visible. */
function openClient(port: number, device: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/client?device=${device}`);
  const messages: { type: string }[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as { type: string }));
  ws.on('error', () => {
    /* surfaces as a timeout in the assertions */
  });
  return { ws, find: (type: string) => messages.find((m) => m.type === type) };
}

test('an agent that answers pong stays attached past several intervals', async () => {
  const port = await startRelay({
    RELAY_AUTH_DISABLED: '1',
    RELAY_AGENT_PING_MS: '150',
    RELAY_AGENT_DEAD_MS: '450',
  });
  const agent = openAgent(port, 'd-alive', { answerPings: true });
  await until(() => agent.pings() >= 5, 'five pings');
  await sleep(200);

  assert.equal(agent.closed(), null, 'a responsive bridge must never be reaped');
  assert.equal(agent.ws.readyState, WebSocket.OPEN);
  agent.ws.close();
});

test('a silent agent is reaped and the device reports offline', async () => {
  const port = await startRelay({
    RELAY_AUTH_DISABLED: '1',
    RELAY_AGENT_PING_MS: '150',
    RELAY_AGENT_DEAD_MS: '400',
  });
  const agent = openAgent(port, 'd-dead', { answerPings: false });
  await until(() => agent.pings() >= 1, 'a first ping');

  // Terminated, not closed: the reap must not wait on a handshake reply from a
  // peer that is gone — that wait is the bug this exists to fix.
  await until(() => agent.closed() ?? agent.ws.readyState === WebSocket.CLOSED, 'the agent to be reaped');

  // The consequence that matters: a browser arriving now is told, rather than
  // handed a channel into a dead sink and left spinning forever.
  const client = openClient(port, 'd-dead');
  await until(() => client.find('deviceOffline'), 'deviceOffline');
  assert.equal(client.find('hello'), undefined, 'nothing is on the other end to say hello');
  client.ws.close();
});

/** Storage, stubbed, answering /v1/devices/verify from a scripted sequence. */
async function startStubStorage(replies: { status: number; body?: unknown }[]): Promise<number> {
  let n = 0;
  const server = http.createServer((req, res) => {
    const reply = replies[Math.min(n++, replies.length - 1)];
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body ?? { error: 'unauthorized' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

test('re-verify drops a device storage refuses', async () => {
  // 200 on attach, then 403 — the row was revoked in the web app.
  const storagePort = await startStubStorage([
    { status: 200, body: { userId: 'u1' } },
    { status: 403 },
  ]);
  const port = await startRelay({
    // Explicitly empty, not absent: a repo-root .env with the dev escape hatch on
    // would otherwise skip verification entirely and this would pass vacuously.
    RELAY_AUTH_DISABLED: '',
    CLERK_SECRET_KEY: 'sk_test_not_used_on_the_agent_path',
    RELAY_SHARED_SECRET: 'shared',
    STORAGE_URL: `http://127.0.0.1:${storagePort}`,
    RELAY_AGENT_PING_MS: '100',
    RELAY_AGENT_DEAD_MS: '10000',
    RELAY_REVERIFY_MS: '300',
  });
  const agent = openAgent(port, 'd-revoked', { answerPings: true });

  const closed = await until(() => agent.closed(), 'the agent to be dropped');
  assert.equal(closed.code, 1008);
});

test('re-verify leaves a live device alone when storage cannot be asked', async () => {
  // 200 on attach, then 500s forever — an outage, not a refusal. Tearing sessions
  // down here would turn a storage blip into every user being kicked off their
  // own machine, which is why the two results are distinguished at all.
  const storagePort = await startStubStorage([
    { status: 200, body: { userId: 'u1' } },
    { status: 500, body: { error: 'boom' } },
  ]);
  const port = await startRelay({
    // Explicitly empty, not absent: a repo-root .env with the dev escape hatch on
    // would otherwise skip verification entirely and this would pass vacuously.
    RELAY_AUTH_DISABLED: '',
    CLERK_SECRET_KEY: 'sk_test_not_used_on_the_agent_path',
    RELAY_SHARED_SECRET: 'shared',
    STORAGE_URL: `http://127.0.0.1:${storagePort}`,
    RELAY_AGENT_PING_MS: '100',
    RELAY_AGENT_DEAD_MS: '10000',
    RELAY_REVERIFY_MS: '300',
  });
  const agent = openAgent(port, 'd-blip', { answerPings: true });
  await until(() => agent.pings() >= 12, 'several re-verify rounds');

  assert.equal(agent.closed(), null, 'a storage outage must never reap a live device');
  agent.ws.close();
});
