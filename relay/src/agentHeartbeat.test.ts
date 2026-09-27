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

test('a second bridge for one device supersedes the first, hard', async () => {
  const port = await startRelay({
    RELAY_AUTH_DISABLED: '1',
    RELAY_AGENT_PING_MS: '150',
    RELAY_AGENT_DEAD_MS: '10000',
  });
  const first = openAgent(port, 'd-dup', { answerPings: true });
  await until(() => first.pings() >= 1, 'the first agent to be attached');

  const second = openAgent(port, 'd-dup', { answerPings: true });
  // 1012 and then terminated: a graceful close would wait on a peer that may be
  // gone, leaving the loser OPEN here — still holding a socket the relay counts.
  const closed = await until(() => first.closed(), 'the predecessor to be hung up on');
  assert.equal(closed.code, 1012);
  await until(() => first.ws.readyState === WebSocket.CLOSED || null, 'the predecessor socket to go');

  // The winner keeps serving: a browser arriving now gets a channel, not offline.
  const client = openClient(port, 'd-dup');
  await until(() => second.pings() >= 2, 'the survivor to stay pinged');
  assert.equal(client.find('deviceOffline'), undefined, 'the takeover must not look like an outage');
  client.ws.close();
  second.ws.close();
});

/** Every presence report the stub storage received, in order. */
const presenceReports: { deviceId: string; online: boolean }[] = [];

/**
 * Storage, stubbed, answering /v1/devices/verify from a scripted sequence.
 *
 * Presence reports are recorded and always answered 200, deliberately outside
 * that sequence: they are fire-and-forget and arrive on their own schedule, so
 * letting them consume scripted replies would make the verification tests depend
 * on the interleaving of an unrelated call.
 */
async function startStubStorage(replies: { status: number; body?: unknown }[]): Promise<number> {
  let n = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/devices/presence') {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        presenceReports.push(JSON.parse(body) as { deviceId: string; online: boolean });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
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

test('an attach refusal lands in the device history with its reason', async () => {
  // Refused vs storage down: identical to the browser (the machine looks asleep),
  // so the secret-gated history is the only place that tells them apart.
  const storagePort = await startStubStorage([
    { status: 403 },
    { status: 500, body: { error: 'boom' } },
  ]);
  const port = await startRelay({
    RELAY_AUTH_DISABLED: '',
    CLERK_SECRET_KEY: 'sk_test_not_used_on_the_agent_path',
    RELAY_SHARED_SECRET: 'shared',
    STORAGE_URL: `http://127.0.0.1:${storagePort}`,
  });
  const refused = openAgent(port, 'd-refused', { answerPings: true });
  assert.equal((await until(() => refused.closed(), 'the first attach to be refused')).code, 1008);
  const outage = openAgent(port, 'd-refused', { answerPings: true });
  assert.equal((await until(() => outage.closed(), 'the second attach to be refused')).code, 1008);

  const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-relay-secret': 'shared' } });
  const body = (await res.json()) as { events: Record<string, { kind: string; detail?: { reason?: string } }[]> };
  assert.deepEqual(
    body.events['d-refused'].filter((e) => e.kind === 'agent-refused').map((e) => e.detail?.reason),
    ['unauthorized', 'unreachable'],
  );
});

const reportsFor = (device: string) => presenceReports.filter((r) => r.deviceId === device);

/**
 * Hub liveness only the relay can observe, pushed to storage so the web app can
 * say something about a machine it holds no socket to. Without it "is that
 * machine alive" is unanswerable before you type a prompt into it.
 */
test('attach and detach are reported to storage', async () => {
  const storagePort = await startStubStorage([{ status: 200, body: { userId: 'u1' } }]);
  const port = await startRelay({
    RELAY_AUTH_DISABLED: '',
    CLERK_SECRET_KEY: 'sk_test_not_used_on_the_agent_path',
    RELAY_SHARED_SECRET: 'shared',
    STORAGE_URL: `http://127.0.0.1:${storagePort}`,
    RELAY_AGENT_PING_MS: '150',
    RELAY_AGENT_DEAD_MS: '10000',
  });
  const agent = openAgent(port, 'd-presence', { answerPings: true });
  await until(() => reportsFor('d-presence').length >= 1 || null, 'the attach report');
  assert.deepEqual(reportsFor('d-presence')[0], { deviceId: 'd-presence', online: true });

  agent.ws.close();
  await until(() => reportsFor('d-presence').length >= 2 || null, 'the detach report');
  assert.deepEqual(reportsFor('d-presence')[1], { deviceId: 'd-presence', online: false });
});

test('a takeover is never reported as the device going offline', async () => {
  // The predecessor's socket closes *after* the replacement has attached, so a
  // naive detach report would tell storage the machine is down while a healthy
  // bridge is serving it — and leave the dot wrong until the next attach.
  const storagePort = await startStubStorage([{ status: 200, body: { userId: 'u1' } }]);
  const port = await startRelay({
    RELAY_AUTH_DISABLED: '',
    CLERK_SECRET_KEY: 'sk_test_not_used_on_the_agent_path',
    RELAY_SHARED_SECRET: 'shared',
    STORAGE_URL: `http://127.0.0.1:${storagePort}`,
    RELAY_AGENT_PING_MS: '150',
    RELAY_AGENT_DEAD_MS: '10000',
  });
  const first = openAgent(port, 'd-presence-dup', { answerPings: true });
  await until(() => reportsFor('d-presence-dup').length >= 1 || null, 'the first attach report');

  const second = openAgent(port, 'd-presence-dup', { answerPings: true });
  await until(() => first.closed(), 'the predecessor to be hung up on');
  await until(() => reportsFor('d-presence-dup').length >= 2 || null, 'the second attach report');
  // Long enough for a stray detach report from the loser's close to land.
  await sleep(300);

  assert.deepEqual(
    reportsFor('d-presence-dup').map((r) => r.online),
    [true, true],
    'a superseded socket closing must not report the live bridge offline',
  );
  second.ws.close();
});
