/**
 * This browser's end-to-end encryption identity, and the machine keys it has
 * pinned.
 *
 * The private key is a non-extractable `CryptoKey` kept in IndexedDB — which
 * stores `CryptoKey` objects directly, so the key material never exists as bytes
 * this code (or anything that later runs in this origin) can read. A pinned
 * bridge key sits in localStorage beside it: it is public, and being able to
 * *read* it is not a weakness — being able to rewrite it would be, which is why
 * it is only ever written by an enrollment the user completed with a code from
 * the host's own screen.
 *
 * The honest limit, restated here because this is where a reader will look: none
 * of this defends against a modified bundle served from the app's own origin.
 * See docs — origin separation narrows that, nothing in the browser closes it.
 */
import { generateIdentity, type CryptoKeyLike, type Identity, type PublicKeyB64 } from '@lines/shared';

/**
 * Why this browser cannot do cryptography at all, or null when it can.
 *
 * Browsers expose `crypto.subtle` only in a secure context — https, or
 * `localhost`. A page served from `http://192.168.x.x` has no WebCrypto, so
 * every key operation here throws before it starts. That is worth detecting
 * up front rather than as a stack trace: the fix is a different URL, and no
 * amount of retrying gets there.
 */
export function cryptoUnavailable(): string | null {
  const secure = typeof window === 'undefined' || window.isSecureContext;
  if (!secure) {
    return (
      'This page is not on a secure origin, so the browser will not do cryptography here. ' +
      'Open Lines over https (or on localhost) to enrol this browser.'
    );
  }
  if (!globalThis.crypto?.subtle) {
    return 'This browser does not expose WebCrypto, so it cannot hold an encryption key.';
  }
  return null;
}

const DB_NAME = 'lines-e2ee';
const STORE = 'identity';
const IDENTITY_KEY = 'device-identity';
/** deviceId -> pinned bridge public key. '' is the local bridge, which needs none. */
const PINS_KEY = 'lines.e2ee.pins';

interface StoredIdentity {
  publicKey: PublicKeyB64;
  /** A real `CryptoKey`, stored as one. `CryptoKeyLike` is the shared module's
   *  structural stand-in — it has no DOM lib to name the real type with. */
  privateKey: CryptoKeyLike;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readIdentity(): Promise<StoredIdentity | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(IDENTITY_KEY);
      req.onsuccess = () => resolve((req.result as StoredIdentity | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeIdentity(identity: StoredIdentity): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(identity, IDENTITY_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let pending: Promise<Identity> | null = null;

/**
 * This browser's identity, minted on first use.
 *
 * Single-flight: the socket layer and the enrollment form both ask, often in the
 * same tick, and two mints would leave the enrolled key and the connecting key
 * different — an enrollment that appears to succeed and then cannot connect.
 */
export function deviceIdentity(): Promise<Identity> {
  if (!pending) {
    pending = (async () => {
      const saved = await readIdentity();
      if (saved?.privateKey && saved.publicKey) return saved;
      // Non-extractable: a later XSS in this origin can use this key to talk to
      // the machine, but cannot carry it away and keep the access.
      const fresh = await generateIdentity(false);
      await writeIdentity({ publicKey: fresh.publicKey, privateKey: fresh.privateKey });
      return fresh;
    })();
  }
  return pending;
}

type Pins = Record<string, PublicKeyB64>;

function readPins(): Pins {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Pins) : {};
  } catch {
    return {};
  }
}

/** The machine key this browser pinned at enrollment, or null if it has none. */
export function pinnedKey(deviceId: string): PublicKeyB64 | null {
  return readPins()[deviceId] ?? null;
}

export function pinKey(deviceId: string, key: PublicKeyB64): void {
  localStorage.setItem(PINS_KEY, JSON.stringify({ ...readPins(), [deviceId]: key }));
}

/** Forget a machine — after an unpair, or a re-enrollment against a fresh key. */
export function unpinKey(deviceId: string): void {
  const pins = readPins();
  delete pins[deviceId];
  localStorage.setItem(PINS_KEY, JSON.stringify(pins));
}

export function pinnedDeviceIds(): string[] {
  return Object.keys(readPins());
}
