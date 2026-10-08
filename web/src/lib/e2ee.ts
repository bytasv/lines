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

/**
 * The fragment's enrollment code, kept across sign-in: Clerk's redirect drops
 * the fragment, and the code is read lazily — by the connecting screen, after
 * sign-in — so without this a first launch that signs in first loses it.
 * sessionStorage (this tab only), with the pairing code's 15-minute lifetime.
 */
const PENDING_ENROLL_KEY = 'lines.enrollCode';
const PENDING_ENROLL_TTL_MS = 15 * 60_000;

/**
 * Copy `#enroll` into the stash at module load, before anything can redirect.
 * The URL is left alone: {@link takeEnrollCodeFromUrl} and
 * {@link dropEnrollParamFromUrl} still consume it from there when it survives.
 */
export function stashEnrollCodeFromUrl(): void {
  const code = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('enroll');
  if (!code) return;
  sessionStorage.setItem(PENDING_ENROLL_KEY, JSON.stringify({ code: code.toUpperCase(), at: Date.now() }));
}

/** The stashed enrollment code, consumed: read once, then gone. */
function takePendingEnrollCode(): string | null {
  const raw = sessionStorage.getItem(PENDING_ENROLL_KEY);
  sessionStorage.removeItem(PENDING_ENROLL_KEY);
  try {
    const stash = JSON.parse(raw ?? 'null') as { code?: unknown; at?: unknown } | null;
    if (typeof stash?.code !== 'string' || typeof stash.at !== 'number') return null;
    return Date.now() - stash.at < PENDING_ENROLL_TTL_MS ? stash.code : null;
  } catch {
    return null;
  }
}

/**
 * An enrollment code handed to this page by the machine itself, consumed once.
 *
 * Read from the URL **fragment**: a query string is sent to the server on the
 * first request, and the server is exactly the party this code exists to
 * exclude. The query form is still accepted, because a QR printed by an older
 * desktop build used it — but it is treated as compromised, which is why both
 * forms are stripped from the URL immediately whether or not they are used.
 */
export function takeEnrollCodeFromUrl(): { code: string; viaQuery: boolean } | null {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const fromHash = hash.get('enroll');
  const fromQuery = query.get('enroll');
  const code = fromHash ?? fromQuery;
  if (!code) {
    // The fragment did not survive sign-in; the stash did.
    const stashed = takePendingEnrollCode();
    return stashed ? { code: stashed, viaQuery: false } : null;
  }

  dropEnrollParamFromUrl();
  return { code: code.toUpperCase(), viaQuery: !fromHash };
}

/**
 * Strip `enroll` from both the query and the fragment, leaving everything else
 * where it was. For a code that arrived but will not be used — a browser that
 * already pinned this machine — so a reload cannot act on it again.
 */
export function dropEnrollParamFromUrl(): void {
  sessionStorage.removeItem(PENDING_ENROLL_KEY);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  if (!hash.has('enroll') && !query.has('enroll')) return;

  hash.delete('enroll');
  query.delete('enroll');
  const search = query.toString();
  const rest = hash.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search ? `?${search}` : ''}${rest ? `#${rest}` : ''}`,
  );
}

const HOST_DEVICE_KEY = 'lines.hostDeviceId';

/**
 * Record which machine this page is sitting at, when the desktop shell says so.
 *
 * The shell opens its own window with `#host=<deviceId>`: that window is a
 * browser on the hosted origin, so the bridge sees a relayed, non-local socket
 * and cannot tell it apart from a phone. The shell can, and that is all a
 * "Browse…" button needs — a Finder dialog is only useful on a screen someone
 * is looking at. Persisted because the fragment is stripped on arrival and the
 * window reloads; the desktop window keeps its own storage, so this never
 * reaches the user's everyday browser.
 */
export function takeHostDeviceIdFromUrl(): void {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const host = hash.get('host');
  if (!host) return;
  localStorage.setItem(HOST_DEVICE_KEY, host);

  hash.delete('host');
  const rest = hash.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`,
  );
}

/**
 * The dev-server counterpart of {@link takeHostDeviceIdFromUrl}: ask `/__host`
 * (web/vite.config.ts) whether this browser runs on the dev machine. Dev builds
 * only — a hosted origin has no such endpoint. A `null` answer clears the value,
 * so a tab that is not on the host never keeps a stale claim.
 */
export async function learnHostDeviceIdFromDevServer(): Promise<void> {
  if (!import.meta.env.DEV) return;
  try {
    const res = await fetch('/__host', { cache: 'no-store' });
    const { deviceId } = (await res.json()) as { deviceId: string | null };
    if (deviceId) localStorage.setItem(HOST_DEVICE_KEY, deviceId);
    else localStorage.removeItem(HOST_DEVICE_KEY);
  } catch {
    // Dev server without the endpoint: leave whatever is there.
  }
}

/** The machine the desktop shell said this window runs on, or null outside it. */
export function readHostDeviceId(): string | null {
  return localStorage.getItem(HOST_DEVICE_KEY);
}

/** deviceId -> the invite tokens this browser presents as a guest on that machine. */
const GUEST_GRANTS_KEY = 'lines.guestGrants';
/** An invite's grant, held between landing on `/join/…` and claiming it. */
const PENDING_JOIN_GRANT_KEY = 'lines.joinGrant';

/** Several, because a host can share more than one session with the same person. */
type GuestGrants = Record<string, string[]>;

function readGuestGrants(): GuestGrants {
  try {
    const raw = JSON.parse(localStorage.getItem(GUEST_GRANTS_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: GuestGrants = {};
    for (const [deviceId, tokens] of Object.entries(raw as Record<string, unknown>)) {
      const list = (Array.isArray(tokens) ? tokens : [tokens]).filter((t): t is string => typeof t === 'string');
      if (list.length) out[deviceId] = list;
    }
    return out;
  } catch {
    return {};
  }
}

interface PendingJoinGrant {
  /** The invite it came with, so a stash from one link is never spent on another. */
  code: string;
  /** The machine it is for, as the owner's link named it. */
  device: string;
  token: string;
  bridgeKey: string;
}

function readPendingJoinGrant(): PendingJoinGrant | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(PENDING_JOIN_GRANT_KEY) ?? 'null') as Partial<PendingJoinGrant> | null;
    if (!raw || typeof raw !== 'object') return null;
    const { code, device, token, bridgeKey } = raw;
    if (typeof code !== 'string' || typeof device !== 'string' || typeof token !== 'string' || typeof bridgeKey !== 'string') {
      return null;
    }
    return { code, device, token, bridgeKey };
  } catch {
    return null;
  }
}

/**
 * The grant half of an invite link, consumed once from the URL fragment.
 *
 * The owner's machine minted the token (see `mintGuestGrant`) and put it in the
 * fragment beside its own public key and its device id, so none of it ever
 * reaches a server: storage holds the invite, the relay carries the channel, and
 * only this browser and the owner's machine know the token. Stashed in
 * sessionStorage rather than used at once, because the invitee may have to sign
 * in first and the fragment does not survive that round trip — the same reason
 * JoinPage stashes the code.
 */
export function takeJoinGrantFromUrl(code: string): void {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = hash.get('grant');
  const bridgeKey = hash.get('key');
  const device = hash.get('device');
  if (!token && !bridgeKey && !device) return;
  if (token && bridgeKey && device) {
    sessionStorage.setItem(PENDING_JOIN_GRANT_KEY, JSON.stringify({ code, device, token, bridgeKey } satisfies PendingJoinGrant));
  }
  hash.delete('grant');
  hash.delete('key');
  hash.delete('device');
  const rest = hash.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`,
  );
}

/** The machine a stashed invite grant is for, or null when there is none. */
export function pendingJoinGrantDevice(): string | null {
  return readPendingJoinGrant()?.device ?? null;
}

/**
 * Bind a stashed invite grant to its machine: the token to present there, and
 * the machine key to hold the channel to — a pin, exactly as an enrollment makes
 * one, which is what keeps the relay out of the middle.
 *
 * Only for the machine the link itself named (`deviceId` comes from a claim or
 * the device list, both storage's word, so it has to agree with the link), and
 * never over a different key already pinned for it: a link is no way to repoint
 * the key of a machine this browser already talks to — its own, least of all.
 * False when nothing was adopted.
 */
export function adoptJoinGrant(deviceId: string, code?: string): boolean {
  const pending = readPendingJoinGrant();
  if (!pending || pending.device !== deviceId || (code !== undefined && pending.code !== code)) return false;
  const pinned = pinnedKey(deviceId);
  if (pinned && pinned !== pending.bridgeKey) return false;
  sessionStorage.removeItem(PENDING_JOIN_GRANT_KEY);
  const grants = readGuestGrants();
  const tokens = grants[deviceId] ?? [];
  if (!tokens.includes(pending.token)) grants[deviceId] = [...tokens, pending.token];
  localStorage.setItem(GUEST_GRANTS_KEY, JSON.stringify(grants));
  pinKey(deviceId, pending.bridgeKey);
  return true;
}

/** The tokens this browser presents as a guest on a machine; empty when it is not one there. */
export function guestGrantTokens(deviceId: string): string[] {
  return readGuestGrants()[deviceId] ?? [];
}
