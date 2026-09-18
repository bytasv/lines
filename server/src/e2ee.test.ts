import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  acceptHandshake,
  enrollProof,
  generateEnrollCode,
  generateIdentity,
  normalizeEnrollCode,
  startHandshake,
  type Identity,
} from '@lines/shared';

/**
 * The handshake, from the attacker's side.
 *
 * Every case here is something a compromised relay can actually do: substitute a
 * key, replay a frame it captured, reorder two, or truncate one. The success
 * case is one test; the rest are the reason the feature exists.
 */

async function pair(): Promise<{ client: Identity; bridge: Identity }> {
  return { client: await generateIdentity(true), bridge: await generateIdentity(true) };
}

/** A completed handshake between two identities, with the bridge pinning the client. */
async function connect(client: Identity, bridge: Identity, pinnedBridgeKey = bridge.publicKey) {
  const initiator = await startHandshake(client, pinnedBridgeKey);
  const responder = await acceptHandshake(bridge, initiator.offer, (key) => key === client.publicKey);
  const { session: clientSession, confirm } = await initiator.finish(responder.accept);
  const bridgeSession = await responder.finish(confirm);
  return { clientSession, bridgeSession };
}

describe('handshake', () => {
  test('two pinned peers agree on a key and talk both ways', async () => {
    const { client, bridge } = await pair();
    const { clientSession, bridgeSession } = await connect(client, bridge);

    const sealed = await clientSession.seal('{"type":"prompt"}');
    assert.equal(await bridgeSession.open(sealed), '{"type":"prompt"}');
    const back = await bridgeSession.seal('{"type":"hello"}');
    assert.equal(await clientSession.open(back), '{"type":"hello"}');

    // Each side learned who it is talking to from the key schedule, not from a
    // claim on the wire.
    assert.equal(clientSession.peerPublicKey, bridge.publicKey);
    assert.equal(bridgeSession.peerPublicKey, client.publicKey);
  });

  test('a bridge refuses a key it has not enrolled', async () => {
    const { client, bridge } = await pair();
    const stranger = await generateIdentity(true);
    const initiator = await startHandshake(stranger, bridge.publicKey);
    await assert.rejects(
      () => acceptHandshake(bridge, initiator.offer, (key) => key === client.publicKey),
      /unknown device key/,
    );
  });

  test('a substituted bridge key fails the confirmation', async () => {
    // The relay's whole attack: answer the handshake itself, with its own key.
    const { client, bridge } = await pair();
    const impostor = await generateIdentity(true);
    const initiator = await startHandshake(client, bridge.publicKey); // client pins the real one
    const responder = await acceptHandshake(impostor, initiator.offer, () => true);
    await assert.rejects(() => initiator.finish(responder.accept));
  });

  test('a client that does not hold the pinned private key cannot confirm', async () => {
    // An attacker who has merely *seen* a public key can copy it into an offer.
    // Only the confirmation distinguishes that from the real device.
    const { client, bridge } = await pair();
    const impostor = await generateIdentity(true);
    const forged = await startHandshake(impostor, bridge.publicKey);
    const responder = await acceptHandshake(
      bridge,
      { ...forged.offer, clientKey: client.publicKey },
      (key) => key === client.publicKey,
    );
    const { confirm } = await forged.finish(responder.accept).catch(() => ({ confirm: null }));
    // The impostor cannot even derive the key, so it cannot produce a confirm at
    // all — and a garbage one is refused.
    await assert.rejects(() => responder.finish(confirm ?? { n: 0, d: 'AAAA' }));
  });
});

describe('record layer', () => {
  test('a replayed frame is refused', async () => {
    const { client, bridge } = await pair();
    const { clientSession, bridgeSession } = await connect(client, bridge);
    const frame = await clientSession.seal('run it once');
    assert.equal(await bridgeSession.open(frame), 'run it once');
    await assert.rejects(() => bridgeSession.open(frame), /replayed or reordered/);
  });

  test('a reordered frame is refused', async () => {
    const { client, bridge } = await pair();
    const { clientSession, bridgeSession } = await connect(client, bridge);
    const first = await clientSession.seal('one');
    const second = await clientSession.seal('two');
    assert.equal(await bridgeSession.open(second), 'two');
    // Delivering the earlier frame afterwards is how a relay would suppress a
    // message and then deliver it out of context.
    await assert.rejects(() => bridgeSession.open(first), /replayed or reordered/);
  });

  test('a truncated or edited tag is refused', async () => {
    const { client, bridge } = await pair();
    const { clientSession, bridgeSession } = await connect(client, bridge);
    const frame = await clientSession.seal('approve everything');
    await assert.rejects(() => bridgeSession.open({ n: frame.n, d: frame.d.slice(0, -4) }));
  });

  test('a frame re-labelled with another counter is refused', async () => {
    const { client, bridge } = await pair();
    const { clientSession, bridgeSession } = await connect(client, bridge);
    await clientSession.seal('one'); // burn counter 0
    const frame = await clientSession.seal('two');
    // The counter is the nonce, so moving it invalidates the tag rather than
    // merely reordering the message.
    await assert.rejects(() => bridgeSession.open({ n: frame.n + 5, d: frame.d }));
  });
});

describe('enrollment', () => {
  test('a code is long enough to authenticate the exchange', () => {
    const code = generateEnrollCode();
    // 20 characters of a 32-symbol alphabet is 100 bits. Shorter would need a
    // PAKE to be safe against an attacker who can watch the exchange.
    assert.equal(code.length, 20);
    assert.match(code, /^[2-9A-HJ-NP-Z]{20}$/);
  });

  test('typing is forgiving about case and separators', () => {
    assert.equal(normalizeEnrollCode('ab cd-ef'), 'ABCDEF');
  });

  test('the answer binds both keys, so a key cannot be substituted', async () => {
    const code = generateEnrollCode();
    const clientKey = 'CLIENT';
    const proof = await enrollProof(code, 'enrolled', clientKey, 'BRIDGE');
    assert.equal(await enrollProof(code, 'enrolled', clientKey, 'BRIDGE'), proof);
    // A relay that answers with its own key cannot produce a matching MAC.
    assert.notEqual(await enrollProof(code, 'enrolled', clientKey, 'RELAY'), proof);
    // Nor can anyone without the code.
    assert.notEqual(await enrollProof(generateEnrollCode(), 'enrolled', clientKey, 'BRIDGE'), proof);
    // And the request label is a different MAC, so one cannot stand in for the other.
    assert.notEqual(await enrollProof(code, 'enroll', clientKey, 'BRIDGE'), proof);
  });
});
