import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { after, test } from 'node:test';
import { WebSocketServer } from 'ws';

// Compressed so the hung-dial case below finishes quickly. Set before the import:
// the constant is read at module load (same pattern as relayClient.supersede.test.ts).
process.env.LINES_RELAY_DIAL_TIMEOUT_MS = '300';
const { RelayClient } = await import('./relayClient.ts');

/**
 * How the bridge presents its device secret when it dials the relay.
 *
 * In a header, never the URL. A URL is what reverse proxies and access logs write
 * down, and this secret is the machine's long-lived credential: anyone who reads
 * it can attach as this machine. The relay still reads the old query form for
 * bridges released before the header (relay/src/agentHeartbeat.test.ts).
 */

const SECRET = 'SECRET-canary-never-in-a-url';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clients: InstanceType<typeof RelayClient>[] = [];
const servers: WebSocketServer[] = [];
const tcpServers: Server[] = [];
const tcpSockets: Socket[] = [];

after(async () => {
  for (const c of clients) c.dispose();
  for (const s of servers) s.close();
  for (const sock of tcpSockets) sock.destroy();
  for (const s of tcpServers) s.close();
  await sleep(50);
});

test('the device secret rides a header, and neither the URL nor the log carries it', async (t) => {
  const printed: string[] = [];
  const original = { log: console.log, warn: console.warn };
  const record = (...args: unknown[]) => void printed.push(args.map(String).join(' '));
  console.log = record;
  console.warn = record;
  t.after(() => Object.assign(console, original));

  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  const dialed = new Promise<IncomingMessage>((resolve) =>
    wss.on('connection', (ws, req) => {
      ws.on('error', () => {});
      resolve(req);
      // And hang up, so the close path — which names the URL it re-dials — runs too.
      ws.close(1011, 'test over');
    }),
  );
  await new Promise<void>((resolve) => wss.on('listening', resolve));
  const { port } = wss.address() as { port: number };

  const client = new RelayClient(`ws://127.0.0.1:${port}`, 'dev-device', SECRET, {
    onChannel: () => {},
    onToken: () => {},
  });
  clients.push(client);
  const req = await dialed;

  assert.equal(req.headers['x-lines-device-secret'], SECRET);
  const url = new URL(req.url ?? '/', 'http://relay');
  assert.equal(url.pathname, '/agent');
  assert.equal(url.searchParams.get('device'), 'dev-device');
  assert.equal(url.searchParams.has('secret'), false, 'the deprecated query form is no longer sent');
  assert.equal(req.url?.includes(SECRET), false);

  await sleep(100);
  assert.ok(printed.some((line) => line.includes('/agent')), 'the dial was logged at all');
  assert.equal(printed.some((line) => line.includes(SECRET)), false, 'the secret is never printed');
});

test('a dial the relay never answers is abandoned and dialled again', async (t) => {
  const original = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  t.after(() => Object.assign(console, original));

  // Accepts TCP and then says nothing: the upgrade request is never answered, which
  // is what a dial caught mid network-switch looks like from the bridge. Before the
  // dial timeout this socket sat in CONNECTING forever and nothing re-dialled.
  let connections = 0;
  const server = createServer((sock) => {
    connections++;
    tcpSockets.push(sock);
    sock.on('error', () => {});
  });
  tcpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const client = new RelayClient(`ws://127.0.0.1:${port}`, 'dev-device', SECRET, {
    onChannel: () => {},
    onToken: () => {},
  });
  clients.push(client);

  const deadline = Date.now() + 10_000;
  while (connections < 2 && Date.now() < deadline) await sleep(20);
  assert.ok(connections >= 2, `expected a re-dial after the hung one, saw ${connections} connection(s)`);
  assert.equal(client.connected, false);
});
