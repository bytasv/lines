import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeviceEvents, DeviceHub, HubRegistry, type Sink } from './mux.ts';
import { decode, type RelayToAgent } from './protocol.ts';

/** A Sink that records, so routing is testable with no sockets involved. */
function fakeSink() {
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  let terminated = false;
  const sink: Sink = {
    send: (d) => sent.push(d),
    close: (code, reason) => {
      closed = { code, reason };
    },
    terminate: () => {
      terminated = true;
    },
  };
  return {
    sink,
    sent,
    frames: () => sent.map((s) => decode<RelayToAgent>(s)!).filter(Boolean),
    closed: () => closed,
    terminated: () => terminated,
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
  hub.fromAgent({ t: 'data', ch, payload: '{"type":"pong"}' }, agent.sink);
  assert.equal(client.sent.at(-1), '{"type":"pong"}');
});

test('a reattaching agent gets the tokens, and every browser is sent to redial it', () => {
  const hub = new DeviceHub('d1');
  const first = fakeSink();
  hub.attachAgent(first.sink);
  const client = fakeSink();
  const ch = hub.openChannel('u1', 'ctrl', client.sink, 'tok');

  const second = fakeSink();
  hub.attachAgent(second.sink);

  // Tokens carry over, since storage sync needs one before any browser is back.
  // Channels do not: an owner channel is end-to-end encrypted, the session died
  // with the old bridge, and a replayed `open` would hand the new one a channel
  // the browser can never use. 1012, so the browser takes its quick redial.
  const frames = second.frames();
  assert.deepEqual(frames, [{ t: 'token', userId: 'u1', token: 'tok' }]);
  assert.equal(client.closed()?.code, 1012);
  assert.equal(hub.channelCount, 0);
  // The old bridge is told, so it does not keep serving a channel it lost.
  assert.deepEqual(first.frames().at(-1), { t: 'close', ch });
  // Newest agent wins; the predecessor is hung up on.
  assert.equal(first.closed()?.code, 1012);
  // And terminated: a close handshake on a socket whose peer is gone never
  // completes, so without this the loser lingers OPEN on the relay for minutes.
  assert.equal(first.terminated(), true, 'a superseded predecessor is dropped, not drained');
  assert.equal(first.frames().filter((f) => f.t === 'open').length, 1, 'only its own original open');
});

test('a guest channel is dropped on re-attach rather than replayed', () => {
  const hub = new DeviceHub('d1');
  const first = fakeSink();
  hub.attachAgent(first.sink);
  const owner = fakeSink();
  const guest = fakeSink();
  hub.openChannel('owner', 'ctrl', owner.sink, 'tok');
  hub.openChannel('guest', 'ctrl', guest.sink, 'gtok', {
    hostUserId: 'owner',
    scope: 'machine',
    caps: { prompt: true },
  });

  const second = fakeSink();
  hub.attachAgent(second.sink);

  // The new bridge has not said `hello` yet, so nothing here knows whether it is
  // new enough to enforce the grant. Replaying the guest to a bridge that ignores
  // the field would serve them as the owner.
  assert.deepEqual(second.frames().filter((f) => f.t === 'open'), []);
  // 1008, so the browser reconnects and re-runs the /client gate — which is the
  // check that could not be made at attach time.
  assert.equal(guest.closed()?.code, 1008);
  assert.equal(owner.closed()?.code, 1012, 'an owner redials quickly instead');
  assert.equal(hub.channelCount, 0);
  assert.equal(hub.guestChannels().length, 0);
});

test('a guest is refused for a stale bridge only while one is attached', () => {
  const hub = new DeviceHub('d1');
  // Nothing has ever attached: `appProtocol` is null because no bridge has stated
  // a version, not because an old one is running. Refusing here would close an
  // authorized guest `unauthorized` — byte-identical to a revoked grant — when the
  // honest answer is that the host is asleep.
  assert.equal(hub.guestNeedsNewerBridge(3), false);

  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  assert.equal(hub.guestNeedsNewerBridge(3), true, 'attached but silent about its version');

  hub.appProtocol = 2;
  assert.equal(hub.guestNeedsNewerBridge(3), true);
  hub.appProtocol = 3;
  assert.equal(hub.guestNeedsNewerBridge(3), false);
  hub.appProtocol = 4;
  assert.equal(hub.guestNeedsNewerBridge(3), false);

  // Detaching forgets the version, and with it the reason to refuse: the guest
  // should now be told the device is offline instead.
  hub.detachAgent(agent.sink);
  assert.equal(hub.guestNeedsNewerBridge(3), false);
});

test('waitForAgent resolves as soon as a bridge attaches', async () => {
  const hub = new DeviceHub('d1');
  const waiting = hub.waitForAgent(5_000);
  assert.equal(hub.hasPendingClients, true);

  const agent = fakeSink();
  hub.attachAgent(agent.sink);

  assert.equal(await waiting, true);
  assert.equal(hub.hasPendingClients, false, 'the waiter is released, not left registered');
});

test('waitForAgent does not wait at all when a bridge is already attached', async () => {
  const hub = new DeviceHub('d1');
  hub.attachAgent(fakeSink().sink);
  // The common case, and it must cost nothing: every /client connection to a
  // running machine goes through here.
  assert.equal(await hub.waitForAgent(5_000), true);
  assert.equal(hub.hasPendingClients, false);
});

test('waitForAgent gives up when no bridge arrives', async () => {
  const hub = new DeviceHub('d1');
  assert.equal(await hub.waitForAgent(10), false);
  // Cleared on the timeout too, or the sweep below could never drop the hub.
  assert.equal(hub.hasPendingClients, false);
});

test('a hub with a browser waiting on it survives the sweep', async () => {
  // It holds no channel and has no agent, so the plain "idle hub" test drops it
  // — and the bridge would then attach to a fresh hub while the waiter counts
  // down against the abandoned one.
  const hubs = new HubRegistry();
  const hub = hubs.get('d1');
  const waiting = hub.waitForAgent(5_000);
  hubs.sweep();
  assert.equal(hubs.size, 1);
  assert.equal(hubs.get('d1'), hub, 'the same hub the waiter is parked on');

  hub.attachAgent(fakeSink().sink);
  assert.equal(await waiting, true);
});

test('an idle hub with nobody waiting is still swept', async () => {
  const hubs = new HubRegistry();
  const hub = hubs.get('d1');
  assert.equal(await hub.waitForAgent(10), false);
  hubs.sweep();
  assert.equal(hubs.size, 0);
});

test('a superseded agent cannot speak into a live channel', () => {
  const hub = new DeviceHub('d1');
  const first = fakeSink();
  hub.attachAgent(first.sink);
  const second = fakeSink();
  hub.attachAgent(second.sink);
  const client = fakeSink();
  const ch = hub.openChannel('u1', 'ctrl', client.sink, null);
  const before = client.sent.length;

  // The whole flicker loop: a superseded (or half-dead) bridge still writing frames
  // injects its own older state into a browser that never reconnected.
  hub.fromAgent({ t: 'data', ch, payload: 'stale' }, first.sink);
  assert.equal(client.sent.length, before, 'a bridge that no longer owns this device is mute');

  hub.fromAgent({ t: 'data', ch, payload: 'fresh' }, second.sink);
  assert.equal(client.sent.at(-1), 'fresh');
});

test("a superseded agent's close does not kill the current agent's channel", () => {
  const hub = new DeviceHub('d1');
  const first = fakeSink();
  hub.attachAgent(first.sink);
  const second = fakeSink();
  hub.attachAgent(second.sink);
  const client = fakeSink();
  const ch = hub.openChannel('u1', 'ctrl', client.sink, null);

  hub.fromAgent({ t: 'close', ch }, first.sink);
  assert.equal(client.closed(), null, 'the browser belongs to the live bridge now');
  assert.equal(hub.channelCount, 1);

  // Still reachable from the bridge that does own it.
  hub.fromAgent({ t: 'data', ch, payload: 'still here' }, second.sink);
  assert.equal(client.sent.at(-1), 'still here');
});

test('attach bookkeeping counts every claim on a device', () => {
  // Diagnostics for the two-bridges-one-identity case: on an idle paired machine
  // this stays at 1, so a climbing count is the tell.
  const hub = new DeviceHub('d1');
  assert.equal(hub.agentAttaches, 0);
  assert.equal(hub.lastAttachAt, 0);

  const first = fakeSink();
  assert.equal(hub.attachAgent(first.sink), null, 'a first attach supersedes nobody');
  assert.equal(hub.agentAttaches, 1);
  assert.ok(hub.lastAttachAt > 0);
  assert.equal(hub.isAgent(first.sink), true);

  const second = fakeSink();
  assert.equal(hub.attachAgent(second.sink), first.sink, 'the caller is told whom it displaced');
  assert.equal(hub.agentAttaches, 2);
  assert.equal(hub.isAgent(first.sink), false);
});

test('the registry summarises each hub for triage', () => {
  const reg = new HubRegistry();
  const hub = reg.get('d1');
  hub.attachAgent(fakeSink().sink);
  hub.openChannel('u1', 'ctrl', fakeSink().sink, null);

  const [row] = reg.list();
  assert.equal(row.deviceId, 'd1');
  assert.equal(row.online, true);
  assert.equal(row.channels, 1);
  assert.equal(row.agentAttaches, 1);
  assert.ok(row.lastAttachAt > 0);
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

  hub.fromAgent({ t: 'data', ch: 'nope', payload: 'x' }, agent.sink);
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
  hub.fromAgent({ t: 'data', ch: chA, payload: 'for-a-only' }, agent.sink);
  assert.ok(a.sent.includes('for-a-only'));
  assert.equal(b.sent.length, beforeB, "user-b must not see user-a's traffic");
});

test('the event history records attach, supersede, channels and detach, in order', () => {
  const hubs = new HubRegistry();
  const hub = hubs.get('d1');
  const early = fakeSink();
  hub.openChannel('u1', 'ctrl', early.sink, null);
  const first = fakeSink();
  hub.attachAgent(first.sink);
  const second = fakeSink();
  hub.attachAgent(second.sink);
  const ch = hub.openChannel('u1', 'ctrl', fakeSink().sink, null);
  hub.closeChannel(ch);
  hub.detachAgent(second.sink);

  assert.deepEqual(
    hubs.events.get('d1').map((e) => e.kind),
    ['channel-open', 'channel-drop', 'agent-attach', 'agent-supersede', 'channel-open', 'channel-close', 'agent-detach'],
  );
  // The browser that opened with no bridge is the stuck-spinner case; say so.
  assert.equal(hubs.events.get('d1')[0].detail?.agentOnline, false);
  assert.ok(hub.lastDetachAt > 0);
});

test('the event history survives the sweep that drops an idle hub', () => {
  // Otherwise the evidence is gone by the time anyone looks: a refused browser
  // holds no channel, so its hub is swept within a minute.
  const hubs = new HubRegistry();
  const hub = hubs.get('d1');
  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  hub.detachAgent(agent.sink);
  hubs.sweep();
  assert.equal(hubs.size, 0);
  assert.deepEqual(
    hubs.events.get('d1').map((e) => e.kind),
    ['agent-attach', 'agent-detach'],
  );
  assert.ok('d1' in hubs.events.snapshot());
});

test('the event history is bounded per device and across devices', () => {
  const events = new DeviceEvents(3, 2);
  for (let i = 0; i < 5; i++) events.record('a', `k${i}`);
  assert.deepEqual(
    events.get('a').map((e) => e.kind),
    ['k2', 'k3', 'k4'],
  );
  events.record('b', 'x');
  events.record('a', 'k5'); // touches a: b is now least recent
  events.record('c', 'y');
  assert.equal(events.size, 2);
  assert.deepEqual(events.get('b'), [], 'least recently touched device evicted');
  assert.equal(events.get('a').at(-1)?.kind, 'k5');
});

test('list() reports detach time and parked browsers for triage', async () => {
  const hubs = new HubRegistry();
  const hub = hubs.get('d1');
  const waiting = hub.waitForAgent(5_000);
  assert.equal(hubs.list()[0].pendingClients, true);
  assert.equal(hubs.list()[0].lastDetachAt, 0);
  const agent = fakeSink();
  hub.attachAgent(agent.sink);
  await waiting;
  hub.detachAgent(agent.sink);
  assert.ok(hubs.list()[0].lastDetachAt > 0);
});
