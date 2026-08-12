import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeviceHub, HubRegistry, type Sink } from './mux.ts';
import { decode, type RelayToAgent } from './protocol.ts';

/** A Sink that records, so routing is testable with no sockets involved. */
function fakeSink() {
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  const sink: Sink = {
    send: (d) => sent.push(d),
    close: (code, reason) => {
      closed = { code, reason };
    },
  };
  return {
    sink,
    sent,
    frames: () => sent.map((s) => decode<RelayToAgent>(s)!).filter(Boolean),
    closed: () => closed,
  };
}

test('a channel opened with no agent is told the device is offline', () => {
  const hub = new DeviceHub('d1');
  const client = fakeSink();
  hub.openChannel('u1', 'ctrl', client.sink, null);

  // Told immediately rather than left hanging: the UI shows an offline state
  // instead of an indefinite spinner.
  assert.deepEqual(JSON.parse(client.sent[0]), { type: 'deviceOffline' });
});

test('frames route between the browser and the bridge', () => {
  const hub = new DeviceHub('d1');
  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  const client = fakeSink();
  const ch = hub.openChannel('u1', 'ctrl', client.sink, 'tok');

  assert.deepEqual(agent.frames().at(-1), { t: 'open', ch, userId: 'u1', token: 'tok' });

  hub.fromClient(ch, '{"type":"ping"}');
  assert.deepEqual(agent.frames().at(-1), { t: 'data', ch, payload: '{"type":"ping"}' });

  // The payload reaches the browser verbatim — the relay never rewraps it.
  hub.fromAgent({ t: 'data', ch, payload: '{"type":"pong"}' });
  assert.equal(client.sent.at(-1), '{"type":"pong"}');
});

test('a reattaching agent is replayed the live channels and tokens', () => {
  const hub = new DeviceHub('d1');
  const first = fakeSink();
  hub.attachAgent(first.sink);
  const client = fakeSink();
  const ch = hub.openChannel('u1', 'ctrl', client.sink, 'tok');

  const second = fakeSink();
  hub.attachAgent(second.sink);

  // The browser stays connected across a bridge restart, so the new bridge has
  // to be told what already exists rather than waiting for a reconnect.
  const frames = second.frames();
  assert.deepEqual(frames[0], { t: 'token', userId: 'u1', token: 'tok' });
  assert.deepEqual(frames[1], { t: 'open', ch, userId: 'u1', token: 'tok' });
  // Newest agent wins; the predecessor is hung up on.
  assert.equal(first.closed()?.code, 1012);
});

test('losing the agent notifies clients but keeps them connected', () => {
  const hub = new DeviceHub('d1');
  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  const client = fakeSink();
  hub.openChannel('u1', 'ctrl', client.sink, null);

  hub.detachAgent(agent.sink);
  assert.deepEqual(JSON.parse(client.sent.at(-1)!), { type: 'deviceOffline' });
  assert.equal(client.closed(), null, 'the browser is not dropped when the bridge restarts');
  assert.equal(hub.online, false);
});

test('a superseded agent closing late does not detach the live one', () => {
  const hub = new DeviceHub('d1');
  const first = fakeSink();
  const second = fakeSink();
  hub.attachAgent(first.sink);
  hub.attachAgent(second.sink);

  hub.detachAgent(first.sink); // arrives after the takeover
  assert.equal(hub.online, true, 'the live agent must survive its predecessor');
});

test('closing a channel tells the agent exactly once', () => {
  const hub = new DeviceHub('d1');
  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  const ch = hub.openChannel('u1', 'ctrl', fakeSink().sink, null);

  hub.closeChannel(ch);
  hub.closeChannel(ch); // idempotent — a double close must not re-notify
  assert.equal(agent.frames().filter((f) => f.t === 'close').length, 1);
});

test('data for an unknown channel is dropped, not broadcast', () => {
  const hub = new DeviceHub('d1');
  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  const client = fakeSink();
  hub.openChannel('u1', 'ctrl', client.sink, null);
  const before = client.sent.length;

  hub.fromAgent({ t: 'data', ch: 'nope', payload: 'x' });
  assert.equal(client.sent.length, before, 'a stray channel id must not leak to other clients');
});

test('a token is pushed to the agent and remembered for the next one', () => {
  const hub = new DeviceHub('d1');
  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  hub.setToken('u1', 'fresh');
  assert.deepEqual(agent.frames().at(-1), { t: 'token', userId: 'u1', token: 'fresh' });

  const next = fakeSink();
  hub.attachAgent(next.sink);
  assert.deepEqual(next.frames()[0], { t: 'token', userId: 'u1', token: 'fresh' });
});

test('registry sweeps only hubs with no agent and no channels', () => {
  const reg = new HubRegistry();
  const idle = reg.get('idle');
  const busy = reg.get('busy');
  busy.openChannel('u1', 'ctrl', fakeSink().sink, null);
  assert.equal(reg.size, 2);

  reg.sweep();
  assert.equal(reg.size, 1);
  assert.equal(reg.peek('idle'), undefined);
  assert.ok(reg.peek('busy'));
  assert.ok(idle);
});

test('dropping a device tears down both sides', () => {
  const reg = new HubRegistry();
  const hub = reg.get('d1');
  const agent = fakeSink();
  const client = fakeSink();
  hub.attachAgent(agent.sink);
  hub.openChannel('u1', 'ctrl', client.sink, null);

  reg.drop('d1', 'revoked');
  // 1008 on both, because both are now unauthorized rather than merely finished:
  // the bridge's client treats it as a state that needs something to change
  // elsewhere, and retries slowly instead of hammering the relay.
  assert.deepEqual(client.closed(), { code: 1008, reason: 'revoked' });
  assert.deepEqual(agent.closed(), { code: 1008, reason: 'revoked' });
  assert.equal(reg.peek('d1'), undefined);
  assert.equal(hub.online, false, 'a dropped hub must not still look reachable');
});

test('a hub records the owner its bridge authenticated as', () => {
  // /client compares against this. Null until a bridge has ever attached, which
  // is why an unclaimed device cannot be reached by anyone.
  const hub = new DeviceHub('d1');
  assert.equal(hub.ownerId, null);
  hub.ownerId = 'user-a';
  assert.equal(hub.ownerId, 'user-a');
});

test('channels from different users stay isolated on one device', () => {
  // The /client gate should stop this ever happening, but if it were bypassed
  // the routing must still not cross-deliver.
  const hub = new DeviceHub('d1');
  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  const a = fakeSink();
  const b = fakeSink();
  const chA = hub.openChannel('user-a', 'ctrl', a.sink, null);
  hub.openChannel('user-b', 'ctrl', b.sink, null);

  const beforeB = b.sent.length;
  hub.fromAgent({ t: 'data', ch: chA, payload: 'for-a-only' });
  assert.ok(a.sent.includes('for-a-only'));
  assert.equal(b.sent.length, beforeB, "user-b must not see user-a's traffic");
});
