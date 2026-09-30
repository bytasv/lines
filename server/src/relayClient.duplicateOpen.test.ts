import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { RelayClient } from './relayClient.ts';
import type { BrowserLink } from './userContext.ts';

/**
 * A repeated `open` for a channel the bridge already serves must be inert.
 *
 * The relay replays `open` for every live channel each time a bridge attaches, so a
 * takeover (or any re-announcement) re-delivers ids we already hold. Handling one
 * again builds a second BrowserLink for one browser, which means a second
 * `handleConnection` and a second full `hello` snapshot down a socket that never
 * reconnected — half of the session-flicker loop.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clients: RelayClient[] = [];
const servers: WebSocketServer[] = [];

after(async () => {
  for (const c of clients) c.dispose();
  for (const s of servers) s.close();
  await sleep(50);
});

async function until<T>(fn: () => T | null | undefined, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** A stand-in relay: accepts one /agent socket and lets the test script its frames. */
async function fakeRelay(): Promise<{ port: number; socket: () => ServerSocket | null }> {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  let socket: ServerSocket | null = null;
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('error', () => {});
  });
  await new Promise<void>((resolve) => wss.on('listening', resolve));
  const { port } = wss.address() as { port: number };
  return { port, socket: () => socket };
}

/** A RelayClient wired to `relay`, recording every channel it hands out. */
function bridgeAgainst(port: number) {
  const opened: BrowserLink[] = [];
  const delivered: string[] = [];
  const client = new RelayClient(`ws://127.0.0.1:${port}`, 'dev', 'secret', {
    onChannel: (link) => {
      opened.push(link);
      link.on('message', (raw) => delivered.push(String(raw)));
    },
    onToken: () => {},
  });
  clients.push(client);
  return { client, opened, delivered };
}

test('a repeated open for a live channel is ignored, leaving one link', async () => {
  const relay = await fakeRelay();
  const bridge = bridgeAgainst(relay.port);
  const ws = await until(() => relay.socket(), 'the bridge to dial in');

  ws.send(JSON.stringify({ t: 'open', ch: 'c1', userId: 'u1', token: null }));
  await until(() => bridge.opened.length === 1, 'the first channel');

  // Exactly what a bridge attach replay looks like from here.
  ws.send(JSON.stringify({ t: 'open', ch: 'c1', userId: 'u1', token: null }));
  await sleep(100);
  assert.equal(bridge.opened.length, 1, 'one browser, one link — and so one hello');

  // The surviving link is the live one: traffic for c1 still reaches it.
  ws.send(JSON.stringify({ t: 'data', ch: 'c1', payload: '{"type":"ping"}' }));
  await until(() => bridge.delivered.length === 1, 'data on the surviving link');
  assert.deepEqual(bridge.delivered, ['{"type":"ping"}']);
  assert.equal(bridge.opened[0].readyState, 1, 'and it was never closed');
});

test('an open after the channel closed is a real new channel', async () => {
  // The guard must not be a permanent block on an id: the relay reuses none, but a
  // reconnect that legitimately reopens one has to be served.
  const relay = await fakeRelay();
  const bridge = bridgeAgainst(relay.port);
  const ws = await until(() => relay.socket(), 'the bridge to dial in');

  ws.send(JSON.stringify({ t: 'open', ch: 'c9', userId: 'u1', token: null }));
  await until(() => bridge.opened.length === 1, 'the first channel');
  ws.send(JSON.stringify({ t: 'close', ch: 'c9' }));
  await until(() => bridge.opened[0].readyState === 3 || null, 'the channel to close');

  ws.send(JSON.stringify({ t: 'open', ch: 'c9', userId: 'u1', token: null }));
  await until(() => bridge.opened.length === 2, 'a genuinely new channel on the same id');
});

test('frames that arrive before the bridge listens are delivered, in order', async () => {
  // The bridge attaches its message handler only after loading its e2ee key,
  // and on an encrypted channel the browser speaks first. A frame dropped in
  // that window is the handshake itself, and the browser then waits forever.
  const relay = await fakeRelay();
  const delivered: string[] = [];
  const client = new RelayClient(`ws://127.0.0.1:${relay.port}`, 'dev', 'secret', {
    onChannel: (link) => {
      setTimeout(() => link.on('message', (raw) => delivered.push(String(raw))), 100);
    },
    onToken: () => {},
  });
  clients.push(client);
  const ws = await until(() => relay.socket(), 'the bridge to dial in');

  ws.send(JSON.stringify({ t: 'open', ch: 'c2', userId: 'u1', token: null }));
  ws.send(JSON.stringify({ t: 'data', ch: 'c2', payload: 'first' }));
  ws.send(JSON.stringify({ t: 'data', ch: 'c2', payload: 'second' }));
  await until(() => delivered.length === 2, 'the early frames');
  assert.deepEqual(delivered, ['first', 'second']);

  ws.send(JSON.stringify({ t: 'data', ch: 'c2', payload: 'third' }));
  await until(() => delivered.length === 3, 'a frame after the handler');
  assert.deepEqual(delivered, ['first', 'second', 'third']);
});
