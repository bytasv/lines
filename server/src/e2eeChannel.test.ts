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
import { guardRelayChannel, type ChannelPolicy } from './e2eeChannel.ts';
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

/** A machine with exactly one device enrolled, and nothing on disk. */
function policyFor(enrolled: string[], required = true): ChannelPolicy {
  return {
    isEnrolled: (key) => enrolled.includes(key),
    required: () => required,
    enroll: async () => ({ error: 'not under test' }),
    touch: () => {},
  };
}

/** Wait for the guard's async frame handling to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function bridgeAndClient(): Promise<{ bridge: Identity; client: Identity }> {
  return { bridge: await generateIdentity(true), client: await generateIdentity(true) };
}

describe('an adversarial relay', () => {
  test('cannot open an owner channel without a key', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let ready = false;
    guardRelayChannel(raw, bridge, false, () => { ready = true; }, policyFor([client.publicKey]));

    // The forged `open` already happened at the relay: this is the first app
    // frame arriving on a channel the relay claims belongs to the owner.
    raw.deliver({ type: 'prompt', sessionId: 's1', text: 'rm -rf ~' } as ClientMessage);
    await settle();

    assert.equal(ready, false, 'the bridge must never see this channel');
    assert.equal(raw.closedWith?.code, 1008);
    assert.ok(raw.last('e2eeError'), 'and it is told why');
  });

  test('cannot authenticate with a key the machine never enrolled', async () => {
    const { bridge } = await bridgeAndClient();
    const stranger = await generateIdentity(true);
    const raw = new FakeChannel();
    let ready = false;
    guardRelayChannel(raw, bridge, false, () => { ready = true; }, policyFor([]));

    const { offer } = await startHandshake(stranger, bridge.publicKey);
    raw.deliver({ type: 'e2eeHello', offer });
    await settle();

    assert.equal(ready, false);
    assert.match((raw.last('e2eeError') as { reason: string }).reason, /unknown device key/);
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
      false,
      (secured, key) => {
        link = secured;
        peerKey = key;
      },
      policyFor([client.publicKey]),
    );

    const initiator = await startHandshake(client, bridge.publicKey);
    raw.deliver({ type: 'e2eeHello', offer: initiator.offer });
    await settle();
    const accept = raw.last('e2eeAccept') as { accept: Parameters<typeof initiator.finish>[0] };
    assert.ok(accept, 'the bridge answered the offer');

    // Nothing has been handed to the bridge yet: an offer proves only that
    // somebody copied a public key.
    assert.equal(peerKey, undefined);

    const { session, confirm } = await initiator.finish(accept.accept);
    raw.deliver({ type: 'e2eeConfirm', confirm });
    await settle();

    assert.equal(peerKey, client.publicKey, 'identity comes from the key, not the relay');
    assert.equal((raw.last('e2eeReady') as { bridgeKey: string }).bridgeKey, bridge.publicKey);

    // App traffic now travels sealed in both directions.
    const received: string[] = [];
    link!.on('message', ((raw: unknown) => received.push(String(raw))) as never);
    const sealed = await session.seal(JSON.stringify({ type: 'ping' }));
    raw.deliver({ type: 'e2eeData', ...sealed });
    await settle();
    assert.deepEqual(received, [JSON.stringify({ type: 'ping' })]);

    link!.send(JSON.stringify({ type: 'pong' }));
    await settle();
    const out = raw.last('e2eeData') as { n: number; d: string };
    assert.ok(out, 'the bridge answered in ciphertext, not in the clear');
    assert.equal(await session.open(out), JSON.stringify({ type: 'pong' }));
  });

  test('a replayed frame ends the channel rather than being ignored', async () => {
    const { bridge, client } = await bridgeAndClient();
    const raw = new FakeChannel();
    let link: BrowserLink | null = null;
    guardRelayChannel(raw, bridge, false, (secured) => { link = secured; }, policyFor([client.publicKey]));

    const initiator = await startHandshake(client, bridge.publicKey);
    raw.deliver({ type: 'e2eeHello', offer: initiator.offer });
    await settle();
    const accept = raw.last('e2eeAccept') as { accept: Parameters<typeof initiator.finish>[0] };
    const { session, confirm } = await initiator.finish(accept.accept);
    raw.deliver({ type: 'e2eeConfirm', confirm });
    await settle();

    const received: string[] = [];
    link!.on('message', ((frame: unknown) => received.push(String(frame))) as never);
    const sealed = await session.seal(JSON.stringify({ type: 'prompt', sessionId: 's', text: 'go' }));
    raw.deliver({ type: 'e2eeData', ...sealed });
    await settle();
    // The relay captured that frame and sends it again — a second turn nobody asked for.
    raw.deliver({ type: 'e2eeData', ...sealed });
    await settle();

    assert.equal(received.length, 1, 'the replay must not reach the bridge');
    assert.equal(raw.closedWith?.code, 1008, 'and the channel is ended, not merely skipped');
  });

  test('a machine with nothing enrolled still works in the clear', async () => {
    // The rollout property: shipping this must not lock an existing install out
    // of its own bridge before the user has enrolled anything.
    const { bridge } = await bridgeAndClient();
    const raw = new FakeChannel();
    let peerKey: string | null | undefined;
    guardRelayChannel(raw, bridge, false, (_link, key) => { peerKey = key; }, policyFor([], false));

    raw.deliver({ type: 'ping' });
    await settle();
    assert.equal(peerKey, null, 'handed over, with no key to claim');
    assert.equal(raw.closedWith, null);
  });
});
