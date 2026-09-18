/**
 * End-to-end encryption between a browser and the machine's bridge, over
 * whatever pipe happens to be in the middle.
 *
 * The relay brokers connections and must never be able to read or author them.
 * Today it can do both: it tells the bridge who is on a channel and the bridge
 * believes it, so a compromised relay can drive an agent with owner authority.
 * This module is what makes that impossible — the relay carries ciphertext and
 * an identity claim the bridge checks for itself.
 *
 * ## Shape
 *
 * Noise-IK-shaped, deliberately: mutual authentication from pinned static keys,
 * forward secrecy from a fresh ephemeral on each side, and replay resistance
 * from per-direction counters. It is written out longhand here rather than
 * pulled from a Noise library because the whole of it has to be auditable in one
 * file, and because it must run unchanged in Node and in a browser.
 *
 *   -> e_c                                   (client ephemeral, cleartext)
 *   <- e_b, AEAD(k_b2c, "" )                 (bridge ephemeral + key confirmation)
 *   -> AEAD(k_c2b, "")                       (client key confirmation)
 *   <-> AEAD(k_*, payload) per message
 *
 * The three Diffie-Hellmans mixed into the key schedule are:
 *   ee — both ephemerals: forward secrecy.
 *   es — client ephemeral × bridge static: only the real bridge can derive it.
 *   se — client static × bridge ephemeral: only the real client can derive it.
 *
 * Both static public keys are hashed into the transcript, so an attacker who
 * substitutes either one derives a different key and the confirmation fails.
 *
 * ## Choices, and what they cost
 *
 * WebCrypto only — ECDH P-256, HKDF-SHA256, AES-256-GCM. No dependency in
 * either workspace, and the browser's private key can be created
 * non-extractable, so a later XSS can *use* the key but never exfiltrate it.
 * X25519 would be nicer crypto; it needs a library and loses that property.
 *
 * Transport-agnostic on purpose: this wraps a channel of strings, not a
 * WebSocket. A WebRTC DataChannel can be slotted underneath with no change to
 * the protocol, which is the whole of the "design for P2P" requirement.
 *
 * ## What it does not defend against
 *
 * A compromised *web origin*. This code is delivered by the same server it
 * distrusts, so an attacker who can serve modified JavaScript owns the code
 * holding the keys. See the deployment notes: origin separation narrows that,
 * nothing here closes it.
 */

/** Bumped on any change to the key schedule or framing. Mixed into the transcript. */
export const E2EE_PROTOCOL = 'lines-e2ee-v1';

/** Raw (uncompressed) P-256 public key, base64. What a pin actually stores. */
export type PublicKeyB64 = string;

/**
 * Structural stand-ins for the WebCrypto types.
 *
 * Not laziness: the bridge's tsconfig has no DOM lib (it must not — a server
 * that can reference `document` invites code that does), and `@types/node` keeps
 * its WebCrypto types inside `node:crypto`, which a module that also runs in a
 * browser cannot import. Declaring exactly the surface used here is what lets
 * one implementation compile against both toolchains. A real `CryptoKey` and a
 * real `SubtleCrypto` satisfy these structurally.
 */
export interface CryptoKeyLike {
  readonly type: string;
  readonly extractable: boolean;
  readonly algorithm: unknown;
  readonly usages: readonly string[];
}

interface CryptoKeyPairLike {
  privateKey: CryptoKeyLike;
  publicKey: CryptoKeyLike;
}

interface SubtleLike {
  generateKey(algorithm: object, extractable: boolean, usages: string[]): Promise<unknown>;
  exportKey(format: string, key: CryptoKeyLike): Promise<ArrayBuffer>;
  importKey(
    format: string,
    data: Bytes,
    algorithm: object | string,
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKeyLike>;
  deriveBits(algorithm: object, key: CryptoKeyLike, length: number): Promise<ArrayBuffer>;
  encrypt(algorithm: object, key: CryptoKeyLike, data: Bytes): Promise<ArrayBuffer>;
  decrypt(algorithm: object, key: CryptoKeyLike, data: Bytes): Promise<ArrayBuffer>;
  digest(algorithm: string, data: Bytes): Promise<ArrayBuffer>;
  sign(algorithm: string, key: CryptoKeyLike, data: Bytes): Promise<ArrayBuffer>;
}

const webcrypto = (): { subtle: SubtleLike; getRandomValues(bytes: Bytes): Bytes } => {
  const c = globalThis.crypto as unknown as { subtle?: SubtleLike; getRandomValues?(b: Bytes): Bytes } | undefined;
  if (!c?.subtle || !c.getRandomValues) {
    throw new Error('WebCrypto is unavailable — end-to-end encryption cannot run here.');
  }
  return c as { subtle: SubtleLike; getRandomValues(bytes: Bytes): Bytes };
};

const subtle = (): SubtleLike => webcrypto().subtle;

/**
 * Byte arrays are pinned to a plain `ArrayBuffer` rather than left at TypeScript
 * 5.7's `ArrayBufferLike` default: WebCrypto's `BufferSource` excludes
 * `SharedArrayBuffer`, and the unpinned form does not narrow to it.
 */
type Bytes = Uint8Array<ArrayBuffer>;

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' } as const;
const AES_BITS = 256;
/** GCM nonce: 4 zero bytes then a big-endian counter. Never reused under one key. */
const NONCE_BYTES = 12;

// --------------------------------------------------------------------------
// Encoding helpers. base64 rather than raw bytes because the relay's own frame
// is JSON (relay/src/protocol.ts decodes the envelope and forwards the payload
// verbatim), so whatever rides inside it has to survive JSON.
// --------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoaSafe(s);
}

export function fromBase64(b64: string): Bytes {
  const s = atobSafe(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** `btoa`/`atob` exist in browsers and in Node ≥16, but not in every Node typing. */
function btoaSafe(s: string): string {
  const g = globalThis as { btoa?: (v: string) => string; Buffer?: { from(v: string, enc: string): { toString(enc: string): string } } };
  if (g.btoa) return g.btoa(s);
  return g.Buffer!.from(s, 'binary').toString('base64');
}

function atobSafe(b64: string): string {
  const g = globalThis as { atob?: (v: string) => string; Buffer?: { from(v: string, enc: string): { toString(enc: string): string } } };
  if (g.atob) return g.atob(b64);
  return g.Buffer!.from(b64, 'base64').toString('binary');
}

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Constant-time compare. Used on the enrollment proof, where a length-dependent
 * or early-exit comparison leaks the expected value one byte at a time.
 */
export function timingSafeEqualB64(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --------------------------------------------------------------------------
// Static identities
// --------------------------------------------------------------------------

export interface Identity {
  publicKey: PublicKeyB64;
  /** Kept as a CryptoKey so a browser can hold a non-extractable private key. */
  privateKey: CryptoKeyLike;
}

/**
 * Mint a static identity.
 *
 * `extractable` is false wherever the key never has to be written out — that is
 * the browser, which persists `CryptoKey` objects into IndexedDB directly. The
 * bridge writes its key to a 0600 file, so it needs an extractable one.
 */
export async function generateIdentity(extractable: boolean): Promise<Identity> {
  const pair = (await subtle().generateKey(ECDH_PARAMS, extractable, ['deriveBits'])) as CryptoKeyPairLike;
  return { publicKey: await exportPublicKey(pair.publicKey), privateKey: pair.privateKey };
}

export async function exportPublicKey(key: CryptoKeyLike): Promise<PublicKeyB64> {
  return toBase64(new Uint8Array(await subtle().exportKey('raw', key)));
}

export async function importPublicKey(b64: PublicKeyB64): Promise<CryptoKeyLike> {
  return subtle().importKey('raw', fromBase64(b64), ECDH_PARAMS, true, []);
}

/** Import a private key the bridge previously wrote to disk (PKCS#8, base64). */
export async function importPrivateKey(b64: string): Promise<CryptoKeyLike> {
  return subtle().importKey('pkcs8', fromBase64(b64), ECDH_PARAMS, true, ['deriveBits']);
}

export async function exportPrivateKey(key: CryptoKeyLike): Promise<string> {
  return toBase64(new Uint8Array(await subtle().exportKey('pkcs8', key)));
}

/**
 * A short, human-comparable fingerprint of a public key: the first 8 bytes of
 * its SHA-256, in groups of four hex characters. For the tray's enrolled-device
 * list and the bridge log, so two humans can check they mean the same key.
 */
export async function fingerprint(pub: PublicKeyB64): Promise<string> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', fromBase64(pub)));
  const hex = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.replace(/(.{4})(?=.)/g, '$1-');
}

// --------------------------------------------------------------------------
// Key schedule
// --------------------------------------------------------------------------

async function dh(priv: CryptoKeyLike, pub: CryptoKeyLike): Promise<Bytes> {
  return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, priv, 256)) as Bytes;
}

/**
 * Derive the two directional keys from the three DH results and the transcript.
 *
 * The transcript hash is the HKDF salt, which is what binds the derived keys to
 * *these* four public keys. Substitute any one of them — the relay swapping in
 * its own static key for the bridge's, say — and the two sides derive different
 * keys, so the first confirmation message fails to decrypt and the handshake
 * aborts. That is the whole authentication argument.
 */
async function deriveKeys(
  ee: Bytes,
  es: Bytes,
  se: Bytes,
  transcript: Bytes,
): Promise<{ c2b: CryptoKeyLike; b2c: CryptoKeyLike }> {
  const ikm = await subtle().importKey('raw', concat(ee, es, se), 'HKDF', false, ['deriveBits']);
  const bits: Bytes = new Uint8Array(
    await subtle().deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: transcript, info: utf8.encode(E2EE_PROTOCOL) },
      ikm,
      512,
    ),
  );
  const importAes = (raw: Bytes) =>
    subtle().importKey('raw', raw, { name: 'AES-GCM', length: AES_BITS }, false, ['encrypt', 'decrypt']);
  return { c2b: await importAes(bits.slice(0, 32)), b2c: await importAes(bits.slice(32, 64)) };
}

async function transcriptHash(parts: string[]): Promise<Bytes> {
  const joined = utf8.encode([E2EE_PROTOCOL, ...parts].join('|')) as Bytes;
  return new Uint8Array(await subtle().digest('SHA-256', joined)) as Bytes;
}

function nonce(counter: number): Bytes {
  const out = new Uint8Array(new ArrayBuffer(NONCE_BYTES));
  const view = new DataView(out.buffer);
  // 64-bit counter in the low 8 bytes. `setBigUint64` keeps it exact past 2^53,
  // which a long-lived link streaming deltas could in principle reach.
  view.setBigUint64(4, BigInt(counter));
  return out;
}

// --------------------------------------------------------------------------
// Record layer
// --------------------------------------------------------------------------

/**
 * An established session: two keys, two counters, and the peer we authenticated.
 *
 * Counters are per-direction and strictly increasing. The receiver refuses a
 * counter it has already seen or passed, which is what makes a relay unable to
 * replay a captured `prompt` frame or reorder two of them.
 */
export class SecureSession {
  private sendCounter = 0;
  private lastReceived = -1;

  constructor(
    private sendKey: CryptoKeyLike,
    private receiveKey: CryptoKeyLike,
    /** The static public key this session actually authenticated. */
    readonly peerPublicKey: PublicKeyB64,
  ) {}

  async seal(plaintext: string): Promise<{ n: number; d: string }> {
    const n = this.sendCounter++;
    const ct = await subtle().encrypt(
      { name: 'AES-GCM', iv: nonce(n) },
      this.sendKey,
      utf8.encode(plaintext) as Bytes,
    );
    return { n, d: toBase64(new Uint8Array(ct)) };
  }

  async open(frame: { n: number; d: string }): Promise<string> {
    if (!Number.isInteger(frame.n) || frame.n < 0) throw new Error('e2ee: malformed counter');
    // Strictly increasing, so a replayed or reordered frame is refused rather
    // than merely noticed. The transport is ordered and reliable, so there is no
    // legitimate out-of-order case to accommodate.
    if (frame.n <= this.lastReceived) throw new Error('e2ee: replayed or reordered frame');
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: nonce(frame.n) },
      this.receiveKey,
      fromBase64(frame.d),
    );
    this.lastReceived = frame.n;
    return utf8Decode.decode(pt);
  }
}

// --------------------------------------------------------------------------
// Handshake
// --------------------------------------------------------------------------

/** Client → bridge, in the clear: the client's ephemeral, and who it thinks it is. */
export interface HandshakeOffer {
  protocol: string;
  /** Client static public key — the one the bridge looks up in its pinned list. */
  clientKey: PublicKeyB64;
  /** Fresh per connection; the source of forward secrecy. */
  ephemeral: PublicKeyB64;
}

/** Bridge → client: its ephemeral plus a key confirmation only the real bridge can produce. */
export interface HandshakeAccept {
  ephemeral: PublicKeyB64;
  /** AEAD over an empty plaintext under the bridge→client key. */
  confirm: { n: number; d: string };
}

/**
 * Client → bridge: the mirror confirmation, which is what authenticates the
 * client. A sealed record like any other — the empty plaintext is the point,
 * since only a peer holding the pinned key could have produced the tag.
 */
export interface HandshakeConfirm {
  n: number;
  d: string;
}

/**
 * Client half of the handshake.
 *
 * `bridgeKey` is the pin established at enrollment. Passing the key the *relay*
 * claims would defeat the entire exercise, so this takes it as an argument and
 * never learns it from the wire.
 */
export async function startHandshake(
  self: Identity,
  bridgeKey: PublicKeyB64,
): Promise<{
  offer: HandshakeOffer;
  finish: (accept: HandshakeAccept) => Promise<{ session: SecureSession; confirm: HandshakeConfirm }>;
}> {
  const ephemeral = (await subtle().generateKey(ECDH_PARAMS, true, ['deriveBits'])) as CryptoKeyPairLike;
  const ephemeralPub = await exportPublicKey(ephemeral.publicKey);
  const offer: HandshakeOffer = { protocol: E2EE_PROTOCOL, clientKey: self.publicKey, ephemeral: ephemeralPub };

  const finish = async (accept: HandshakeAccept) => {
    const bridgeStatic = await importPublicKey(bridgeKey);
    const bridgeEphemeral = await importPublicKey(accept.ephemeral);
    const keys = await deriveKeys(
      await dh(ephemeral.privateKey, bridgeEphemeral),
      await dh(ephemeral.privateKey, bridgeStatic),
      await dh(self.privateKey, bridgeEphemeral),
      await transcriptHash([self.publicKey, bridgeKey, ephemeralPub, accept.ephemeral]),
    );
    // Receive first: if this throws, the peer did not hold the pinned private
    // key (or something rewrote a public key in flight) and nothing is sent.
    const session = new SecureSession(keys.c2b, keys.b2c, bridgeKey);
    await session.open(accept.confirm);
    return { session, confirm: await session.seal('') };
  };

  return { offer, finish };
}

/**
 * Bridge half.
 *
 * `isEnrolled` is the pin check, and it is the whole of E3: the bridge decides
 * who this is from its own local list, not from anything the relay said. An
 * unknown key never reaches the key schedule.
 */
export async function acceptHandshake(
  self: Identity,
  offer: HandshakeOffer,
  isEnrolled: (clientKey: PublicKeyB64) => boolean,
): Promise<{
  accept: HandshakeAccept;
  finish: (confirm: HandshakeConfirm) => Promise<SecureSession>;
}> {
  if (offer?.protocol !== E2EE_PROTOCOL) throw new Error('e2ee: unsupported protocol version');
  if (typeof offer.clientKey !== 'string' || typeof offer.ephemeral !== 'string') {
    throw new Error('e2ee: malformed handshake offer');
  }
  if (!isEnrolled(offer.clientKey)) throw new Error('e2ee: unknown device key');

  const ephemeral = (await subtle().generateKey(ECDH_PARAMS, true, ['deriveBits'])) as CryptoKeyPairLike;
  const ephemeralPub = await exportPublicKey(ephemeral.publicKey);
  const clientStatic = await importPublicKey(offer.clientKey);
  const clientEphemeral = await importPublicKey(offer.ephemeral);
  const keys = await deriveKeys(
    await dh(ephemeral.privateKey, clientEphemeral),
    await dh(self.privateKey, clientEphemeral),
    await dh(ephemeral.privateKey, clientStatic),
    await transcriptHash([offer.clientKey, self.publicKey, offer.ephemeral, ephemeralPub]),
  );
  const session = new SecureSession(keys.b2c, keys.c2b, offer.clientKey);
  const accept: HandshakeAccept = { ephemeral: ephemeralPub, confirm: await session.seal('') };

  const finish = async (confirm: HandshakeConfirm) => {
    // Until this opens, the peer has proved nothing: anyone can replay an offer
    // carrying a public key they do not hold the private half of.
    await session.open(confirm);
    return session;
  };

  return { accept, finish };
}

// --------------------------------------------------------------------------
// Enrollment
// --------------------------------------------------------------------------

/**
 * Crockford-style base32 without the ambiguous letters, so a code can be read
 * off one screen and typed into another without an I/1 or O/0 mistake.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** 20 characters of this alphabet is 100 bits — enough to authenticate the
 *  exchange against an attacker who can see it and has to guess in one shot. */
export const ENROLL_CODE_LENGTH = 20;

export function generateEnrollCode(): string {
  const bytes = new Uint8Array(new ArrayBuffer(ENROLL_CODE_LENGTH));
  webcrypto().getRandomValues(bytes);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Normalise what a human typed: case, spaces and dashes are not part of it. */
export function normalizeEnrollCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Proof that whoever is enrolling holds the code the host displayed.
 *
 * Two labels, and the asymmetry between them is the point:
 *
 * - `enroll` (client → bridge) covers the client's key alone. The client cannot
 *   cover the bridge's key here, because with a typed code it has not learned it
 *   yet — that is exactly what this exchange delivers.
 * - `enrolled` (bridge → client) covers *both* keys. Only a holder of the code
 *   can produce it, so the client can pin the bridge key it comes with. A relay
 *   that substitutes its own key cannot produce a matching MAC, so key
 *   substitution at enrollment fails rather than succeeding silently.
 *
 * This is what makes a typed code sufficient, and why the code has to be long:
 * an attacker who watches the exchange and can guess the code can impersonate
 * either side. 100 bits makes that hopeless; a short code would need a PAKE.
 */
export async function enrollProof(
  code: string,
  label: 'enroll' | 'enrolled',
  clientKey: PublicKeyB64,
  bridgeKey: PublicKeyB64 = '',
): Promise<string> {
  const key = await subtle().importKey(
    'raw',
    utf8.encode(normalizeEnrollCode(code)) as Bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await subtle().sign(
    'HMAC',
    key,
    utf8.encode([E2EE_PROTOCOL, label, clientKey, bridgeKey].join('|')) as Bytes,
  );
  return toBase64(new Uint8Array(mac));
}
