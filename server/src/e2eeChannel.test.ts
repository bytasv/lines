import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  acceptHandshake,
  generateIdentity,
  startHandshake,
  type ClientMessage,
  type Identity,
  type ServerMessage,
} from '@lines/shared';
import { capsForPreset } from '@lines/shared';
import { guardRelayChannel, type ChannelPolicy } from './e2eeChannel.ts';
import type { GuestGrantRecord } from './guestGrants.ts';
import type { BrowserLink } from './userContext.ts';

/**
 * An adversarial relay.
 *
 * `relayEndToEnd.test.ts` assumes an honest one, which is precisely the
 * assumption this feature removes. This double does what a compromised relay
 * would: opens a channel with no key at all, forges frames, replays them, and
 * substitutes its own key for the machine's.
 */
class FakeChannel implements BrowserLink {
  private onMessage: ((raw: unknown) => void) | null = null;
  private onClose: (() => void) | null = null;
  /** Everything the bridge wrote back, parsed. */
  readonly sent: (ServerMessage & { type: string })[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage & { type: string });
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.onClose?.();
  }
  terminate(): void {
    this.close();
  }
  on(event: 'message' | 'close' | 'error', cb: (arg: never) => void): this {
    if (event === 'message') this.onMessage = cb as (raw: unknown) => void;
    else if (event === 'close') this.onClose = cb as () => void;
    return this;
  }
  get readyState(): number {
    return this.closedWith ? 3 : 1;
  }
  get bufferedAmount(): number {
    return 0;
  }

  /** Push one client frame in, as the relay would. */
  deliver(msg: ClientMessage): void {
    this.onMessage?.(JSON.stringify(msg));
  }

  /** The most recent frame of a given type the bridge wrote. */
  last<T extends string>(type: T) {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

/** The one grant the test machine minted, redeemable with `GOOD_TOKEN` by `u-guest`. */
const GOOD_TOKEN = 'the-token-from-the-invite-link';
const GRANT: GuestGrantRecord = {
  id: 'g1',
  tokenHash: 'not-under-test',
  hostUserId: 'u-host',
  scope: 'session',
  sessionIds: ['s1'],
  caps: capsForPreset('collaborator', 'session'),
  guestUserId: 'u-guest',
  createdAt: 0,
  claimBy: 0,
};

/** A machine with exactly these devices enrolled, one guest grant, and nothing on disk. */
function policyFor(enrolled: string[]): ChannelPolicy {
  return {
    isEnrolled: (key) => enrolled.includes(key),
    enroll: async () => ({ error: 'not under test' }),
    touch: () => {},
    redeemGuest: (token, userId) => (token === GOOD_TOKEN && userId === 'u-guest' ? GRANT : null),
  };
}

/**
 * Wait for a frame to appear, rather than for a fixed number of milliseconds.
 *
 * A fixed sleep was enough on an idle machine and not on a loaded CI runner,
 * where this file's P-256 key generation competes with every other test file —
 * so the bridge's answer had not arrived yet and the assertion read `undefined`.
 * Polling for the thing actually being waited on is both faster and immune to
 * how busy the host is.
 */
async function until<T>(fn: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let pending async frame handling run, for assertions about what did NOT happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function bridgeAndClient(): Promise<{ bridge: Identity; client: Identity }> {
  return { bridge: await generateIdentity(true), client: await generateIdentity(true) };
}

/** Run the browser's half of a handshake against the machine's real key; returns the session. */
async function handshake(raw: FakeChannel, bridge: Identity, client: Identity) {
  const initiator = await startHandshake(client, bridge.publicKey);
  raw.deliver({ type: 'e2eeHello', offer: initiator.offer });
  const accept = (await until(() => raw.last('e2eeAccept'), 'e2eeAccept')) as {
    accept: Parameters<typeof initiator.finish>[0];
  };
  const { session, confirm } = await initiator.finish(accept.accept);
  raw.deliver({ type: 'e2eeConfirm', confirm });
  await until(() => raw.last('e2eeReady'), 'e2eeReady');
  return session;
}

describe('an adversarial relay', () => {
  test('cannot open an owner channel without a key', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let ready = false;
    guardRelayChannel(raw, bridge, null, () => { ready = true; }, policyFor([client.publicKey]));

    // The forged `open` already happened at the relay: this is the first app
    // frame arriving on a channel the relay claims belongs to the owner.
    raw.deliver({ type: 'prompt', sessionId: 's1', text: 'rm -rf ~' } as ClientMessage);
    await until(() => raw.closedWith ?? undefined, 'the channel to be closed');

    assert.equal(ready, false, 'the bridge must never see this channel');
    assert.equal(raw.closedWith?.code, 1008);
    assert.ok(raw.last('e2eeError'), 'and it is told why');
  });

  test('cannot authenticate with a key the machine never enrolled', async () => {
    const { bridge } = await bridgeAndClient();
    const stranger = await generateIdentity(true);
    const raw = new FakeChannel();
    let ready = false;
    guardRelayChannel(raw, bridge, null, () => { ready = true; }, policyFor([]));

    const { offer } = await startHandshake(stranger, bridge.publicKey);
    raw.deliver({ type: 'e2eeHello', offer });
    const refusal = (await until(() => raw.last('e2eeError'), 'a refusal')) as { reason: string };

    assert.equal(ready, false);
    assert.match(refusal.reason, /unknown device key/);
  });

  test('cannot substitute its own key for the machine key', async () => {
    const { bridge, client } = await bridgeAndClient();
    const relay = await generateIdentity(true);
    // The client pins the real machine; the relay answers with its own identity.
    const initiator = await startHandshake(client, bridge.publicKey);
    const impostor = await acceptHandshake(relay, initiator.offer, () => true);
    await assert.rejects(
      () => initiator.finish(impostor.accept),
      'the client must not accept a channel it cannot tie to its pin',
    );
  });

  test('an enrolled device gets an encrypted channel, and only then', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let peerKey: string | null | undefined;
    let link: BrowserLink | null = null;
    guardRelayChannel(
      raw,
      bridge,
      null,
      (secured, key) => {
        link = secured;
        peerKey = key;
      },
      policyFor([client.publicKey]),
    );

    const initiator = await startHandshake(client, bridge.publicKey);
    raw.deliver({ type: 'e2eeHello', offer: initiator.offer });
    const accept = (await until(() => raw.last('e2eeAccept'), 'e2eeAccept')) as {
      accept: Parameters<typeof initiator.finish>[0];
    };

    // Nothing has been handed to the bridge yet: an offer proves only that
    // somebody copied a public key.
    assert.equal(peerKey, undefined);

    const { session, confirm } = await initiator.finish(accept.accept);
    raw.deliver({ type: 'e2eeConfirm', confirm });
    await until(() => raw.last('e2eeReady'), 'e2eeReady');

    assert.equal(peerKey, client.publicKey, 'identity comes from the key, not the relay');
    assert.equal((raw.last('e2eeReady') as { bridgeKey: string }).bridgeKey, bridge.publicKey);

    // App traffic now travels sealed in both directions.
    const received: string[] = [];
    link!.on('message', ((raw: unknown) => received.push(String(raw))) as never);
    const sealed = await session.seal(JSON.stringify({ type: 'ping' }));
    raw.deliver({ type: 'e2eeData', ...sealed });
    await until(() => (received.length ? received : undefined), 'the decrypted frame');
    assert.deepEqual(received, [JSON.stringify({ type: 'ping' })]);

    link!.send(JSON.stringify({ type: 'pong' }));
    const out = (await until(() => raw.last('e2eeData'), 'a sealed answer')) as { n: number; d: string };
    assert.equal(await session.open(out), JSON.stringify({ type: 'pong' }));
  });

  test('a replayed frame ends the channel rather than being ignored', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let link: BrowserLink | null = null;
    guardRelayChannel(raw, bridge, null, (secured) => { link = secured; }, policyFor([client.publicKey]));

    const initiator = await startHandshake(client, bridge.publicKey);
    raw.deliver({ type: 'e2eeHello', offer: initiator.offer });
    const accept = (await until(() => raw.last('e2eeAccept'), 'e2eeAccept')) as {
      accept: Parameters<typeof initiator.finish>[0];
    };
    const { session, confirm } = await initiator.finish(accept.accept);
    raw.deliver({ type: 'e2eeConfirm', confirm });
    await until(() => raw.last('e2eeReady'), 'e2eeReady');

    const received: string[] = [];
    link!.on('message', ((frame: unknown) => received.push(String(frame))) as never);
    const sealed = await session.seal(JSON.stringify({ type: 'prompt', sessionId: 's', text: 'go' }));
    raw.deliver({ type: 'e2eeData', ...sealed });
    await until(() => (received.length ? received : undefined), 'the first frame');
    // The relay captured that frame and sends it again — a second turn nobody asked for.
    raw.deliver({ type: 'e2eeData', ...sealed });
    await until(() => raw.closedWith ?? undefined, 'the channel to be closed');

    assert.equal(received.length, 1, 'the replay must not reach the bridge');
    assert.equal(raw.closedWith?.code, 1008, 'and the channel is ended, not merely skipped');
  });

  test('a machine with nothing enrolled still refuses a plaintext owner channel', async () => {
    // Encrypted by default: there is no "nothing enrolled, so anything goes"
    // window for a relay to open a channel through. The only thing an owner
    // channel can do before a browser enrols is enrol.
    const { bridge } = await bridgeAndClient();
    const raw = new FakeChannel();
    let ready = false;
    guardRelayChannel(raw, bridge, null, () => { ready = true; }, policyFor([]));
    await settle();
    assert.equal(ready, false, 'an owner channel is never handed over before the handshake');

    raw.deliver({ type: 'ping' });
    await until(() => raw.closedWith ?? undefined, 'the channel to be closed');
    assert.equal(ready, false);
    assert.equal(raw.closedWith?.code, 1008);
    assert.match(
      (raw.last('e2eeError') as { reason: string }).reason,
      /end-to-end encrypted channel/,
      'the reason the client keys its enrol gate on',
    );
  });

  test('a guest channel is never handed over on the relay’s word alone', async () => {
    // The relay labelled this channel a guest's. Before host-issued grants that
    // label was the whole admission: the bridge handed the channel over at once
    // and served whatever grant the relay attached.
    const { bridge } = await bridgeAndClient();
    const raw = new FakeChannel();
    let ready = false;
    guardRelayChannel(raw, bridge, { userId: 'u-guest' }, () => { ready = true; }, policyFor([]));
    await settle();
    assert.equal(ready, false, 'nothing is handed over before the guest authenticates');

    raw.deliver({ type: 'prompt', sessionId: 's1', text: 'rm -rf ~' } as ClientMessage);
    await until(() => raw.closedWith ?? undefined, 'the channel to be closed');
    assert.equal(ready, false);
    assert.equal(raw.closedWith?.code, 1008);
    const reason = (raw.last('e2eeError') as { reason: string }).reason;
    assert.match(reason, /invite link/, 'a guest is told to use the link');
    assert.doesNotMatch(reason, /end-to-end encrypted channel/, 'not the owner enrollment gate');
  });

  test('a guest handshakes with a key this machine never enrolled, then must present the grant', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let admitted: { link: BrowserLink; peerKey: string; grants: GuestGrantRecord[] } | null = null;
    guardRelayChannel(
      raw,
      bridge,
      { userId: 'u-guest' },
      (link, peerKey, grants) => { admitted = { link, peerKey, grants }; },
      policyFor([]),
    );

    const session = await handshake(raw, bridge, client);
    assert.equal(admitted, null, 'a handshake alone opens nothing for a guest');

    raw.deliver({ type: 'e2eeData', ...(await session.seal(JSON.stringify({ type: 'guestGrant', tokens: [GOOD_TOKEN] }))) });
    const got = await until(() => admitted ?? undefined, 'the guest to be admitted');
    assert.deepEqual(got.grants, [GRANT], 'admitted on the grant this machine minted');
    assert.equal(got.peerKey, client.publicKey);

    // The grant frame itself is consumed; what follows reaches the bridge.
    const received: string[] = [];
    got.link.on('message', ((frame: unknown) => received.push(String(frame))) as never);
    raw.deliver({ type: 'e2eeData', ...(await session.seal(JSON.stringify({ type: 'ping' }))) });
    await until(() => (received.length ? received : undefined), 'the next frame');
    assert.deepEqual(received, [JSON.stringify({ type: 'ping' })]);
  });

  test('a token this machine did not mint ends the channel', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let ready = false;
    guardRelayChannel(raw, bridge, { userId: 'u-guest' }, () => { ready = true; }, policyFor([]));
    const session = await handshake(raw, bridge, client);
    raw.deliver({ type: 'e2eeData', ...(await session.seal(JSON.stringify({ type: 'guestGrant', tokens: ['forged'] }))) });
    await until(() => raw.closedWith ?? undefined, 'the channel to be closed');
    assert.equal(ready, false);
    assert.match((raw.last('e2eeError') as { reason: string }).reason, /not valid on this machine/);
  });

  test('the right token for someone else is refused too', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let ready = false;
    guardRelayChannel(raw, bridge, { userId: 'u-someone-else' }, () => { ready = true; }, policyFor([]));
    const session = await handshake(raw, bridge, client);
    raw.deliver({ type: 'e2eeData', ...(await session.seal(JSON.stringify({ type: 'guestGrant', tokens: [GOOD_TOKEN] }))) });
    await until(() => raw.closedWith ?? undefined, 'the channel to be closed');
    assert.equal(ready, false);
  });

  test('any sealed frame before the grant ends the channel', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let ready = false;
    guardRelayChannel(raw, bridge, { userId: 'u-guest' }, () => { ready = true; }, policyFor([]));
    const session = await handshake(raw, bridge, client);
    raw.deliver({ type: 'e2eeData', ...(await session.seal(JSON.stringify({ type: 'ping' }))) });
    await until(() => raw.closedWith ?? undefined, 'the channel to be closed');
    assert.equal(ready, false);
  });

  test('a guest channel cannot enrol a device', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let enrolCalls = 0;
    const policy = { ...policyFor([]), enroll: async () => (enrolCalls++, { proof: 'x' }) };
    guardRelayChannel(raw, bridge, { userId: 'u-guest' }, () => {}, policy);
    raw.deliver({ type: 'e2eeEnroll', clientKey: client.publicKey, proof: 'whatever' });
    await until(() => raw.closedWith ?? undefined, 'the channel to be closed');
    assert.equal(enrolCalls, 0, 'never even asked');
  });

  test('frames after the grant that arrive before the bridge listens are kept, in order', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let link: BrowserLink | undefined;
    guardRelayChannel(raw, bridge, { userId: 'u-guest' }, (secured) => { link = secured; }, policyFor([]));
    const session = await handshake(raw, bridge, client);
    // Sealed back to back, as the browser writes them: the grant, then traffic.
    const frames = await Promise.all([
      session.seal(JSON.stringify({ type: 'guestGrant', tokens: [GOOD_TOKEN] })),
      session.seal(JSON.stringify({ type: 'ping' })),
      session.seal(JSON.stringify({ type: 'presence', sessionId: 's1', viewing: true, focused: true })),
    ]);
    for (const f of frames) raw.deliver({ type: 'e2eeData', ...f });
    await until(() => link, 'the guest to be admitted');
    await settle();
    const received: string[] = [];
    link!.on('message', (frame) => received.push(String(frame)));
    assert.deepEqual(received.map((f) => JSON.parse(f).type), ['ping', 'presence']);
  });

  test('a token that no longer redeems is skipped, not fatal, when another still does', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let grants: GuestGrantRecord[] | null = null;
    guardRelayChannel(raw, bridge, { userId: 'u-guest' }, (_l, _k, g) => { grants = g; }, policyFor([]));
    const session = await handshake(raw, bridge, client);
    raw.deliver({
      type: 'e2eeData',
      ...(await session.seal(JSON.stringify({ type: 'guestGrant', tokens: ['revoked-share', GOOD_TOKEN] }))),
    });
    assert.deepEqual(await until(() => grants ?? undefined, 'the guest to be admitted'), [GRANT]);
  });

  test('a second handshake cannot take over an admitted guest channel', async () => {
    // A guest channel takes any client key, so without this the relay could run
    // its own handshake under the channel the bridge already holds and speak as
    // the admitted guest, with the guest's grant and none of their keys.
    const { bridge, client } = await bridgeAndClient();
    const relay = await generateIdentity(true);
    const raw = new FakeChannel();
    let link: BrowserLink | undefined;
    guardRelayChannel(raw, bridge, { userId: 'u-guest' }, (secured) => { link = secured; }, policyFor([]));
    const session = await handshake(raw, bridge, client);
    raw.deliver({ type: 'e2eeData', ...(await session.seal(JSON.stringify({ type: 'guestGrant', tokens: [GOOD_TOKEN] }))) });
    await until(() => link, 'the guest to be admitted');

    const hijack = await startHandshake(relay, bridge.publicKey);
    raw.deliver({ type: 'e2eeHello', offer: hijack.offer });
    await until(() => raw.closedWith ?? undefined, 'the channel to be closed');
    assert.equal(raw.closedWith?.code, 1008);
    assert.match((raw.last('e2eeError') as { reason: string }).reason, /second handshake/);
  });
});
