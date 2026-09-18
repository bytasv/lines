import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canonicalize,
  signBlob,
  stripSignature,
  verifyBlob,
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
