/**
 * Signed sync blobs, so storage cannot author content.
 *
 * The encrypted channel closes the relay's door. This closes the other one: the
 * bridge pulls workflows, sessions, memory and settings out of Postgres over
 * plain TLS and applies them, so anyone who can write those rows can write to
 * this machine. Signing makes the database a place that can *hold* content it
 * cannot *write* — an attacker with the database can still delete, withhold or
 * replay a row, and cannot forge one.
 *
 * ## No schema change, on purpose
 *
 * Every storage table already keeps its payload in a `data` JSON column, so the
 * signature rides inside that payload under one reserved key rather than in a
 * new column. That matters practically: a column means a Prisma migration on a
 * running deployment, and a rollout where a bridge writing signatures and a
 * storage server that has not migrated cannot talk to each other.
 *
 * ## Trust, stated plainly
 *
 * Machine keys are learned on first use and pinned after that, the way SSH
 * learns a host key. A *change* of signer for a user is refused and surfaced
 * rather than silently accepted, because that is exactly what an attacker with
 * the database would have to do. The weakness is the first blob: a database
 * compromised before this machine ever pulled from it can seed its own key. The
 * fix for that is carrying machine keys out of band as the browser enrollment
 * does — worth doing, not done here.
 *
 * ECDSA P-256, because it is the signing counterpart of the ECDH curve already
 * in use and needs no dependency. Rollback is handled by a per-signer counter
 * signed into the blob: a pulled blob whose counter goes backwards is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fromBase64, toBase64, type PublicKeyB64 } from '@lines/shared';
import { APP_ROOT } from './workerProtocol.ts';

/** The one reserved key a signed blob carries. Stripped before anything applies it. */
export const SIGNATURE_KEY = '_linesSig';

export const SIGNING_IDENTITY_FILE = path.join(APP_ROOT, 'sync-signing.json');
export const SIGNING_PEERS_FILE = path.join(APP_ROOT, 'sync-peers.json');

const ECDSA_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

export interface BlobSignature {
  /** Algorithm tag, so a future change is a refusal rather than a misread. */
  alg: 'ecdsa-p256-sha256';
  /** The signing machine's public key, raw, base64. */
  key: PublicKeyB64;
  /** Strictly increasing per signing machine. A regression is a replay. */
  counter: number;
  sig: string;
}

type Signed = Record<string, unknown> & { [SIGNATURE_KEY]?: BlobSignature };

/** Verdicts, in the order the caller cares about them. */
export type VerifyResult =
  | { ok: true; signer: PublicKeyB64 }
  /** No signature at all — a peer that predates this, or storage stripping it. */
  | { ok: false; reason: 'unsigned' }
  /** A different machine key than the one pinned for this resource. */
  | { ok: false; reason: 'signer-changed'; signer: PublicKeyB64 }
  /** Counter went backwards: a replayed older blob. */
  | { ok: false; reason: 'rollback'; signer: PublicKeyB64 }
  /** The signature does not verify against its own claimed key. */
  | { ok: false; reason: 'forged' };

/**
 * Canonical bytes for a blob: keys sorted at every level, signature key removed.
 *
 * Two machines must produce identical bytes for identical content, and JSON
 * property order is not guaranteed across engines or across a Postgres JSON
 * round trip — an uncanonicalised signature would fail at random.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k, v]) => k !== SIGNATURE_KEY && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

const subtle = () => {
  const c = globalThis.crypto as unknown as { subtle?: SubtleLike };
  if (!c?.subtle) throw new Error('WebCrypto is unavailable — sync signing cannot run here.');
  return c.subtle;
};

/** The slice of SubtleCrypto used here; see shared/e2ee.ts for why it is spelled out. */
interface SubtleLike {
  generateKey(algorithm: object, extractable: boolean, usages: string[]): Promise<unknown>;
  exportKey(format: string, key: unknown): Promise<ArrayBuffer>;
  importKey(
    format: string,
    data: Uint8Array<ArrayBuffer>,
    algorithm: object,
    extractable: boolean,
    usages: string[],
  ): Promise<unknown>;
  sign(algorithm: object, key: unknown, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
  verify(
    algorithm: object,
    key: unknown,
    signature: Uint8Array<ArrayBuffer>,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<boolean>;
}

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s) as Uint8Array<ArrayBuffer>;

export interface SigningIdentity {
  publicKey: PublicKeyB64;
  privateKey: unknown;
}

let cachedIdentity: SigningIdentity | null = null;

/** This machine's signing key, minted on first use. 0600, never uploaded. */
export async function signingIdentity(file = SIGNING_IDENTITY_FILE): Promise<SigningIdentity> {
  if (cachedIdentity) return cachedIdentity;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { publicKey?: string; privateKey?: string };
    if (saved.publicKey && saved.privateKey) {
      cachedIdentity = {
        publicKey: saved.publicKey,
        privateKey: await subtle().importKey('pkcs8', fromBase64(saved.privateKey), ECDSA_PARAMS, true, ['sign']),
      };
      return cachedIdentity;
    }
  } catch {
    // fall through to minting
  }
  const pair = (await subtle().generateKey(ECDSA_PARAMS, true, ['sign', 'verify'])) as {
    privateKey: unknown;
    publicKey: unknown;
  };
  const publicKey = toBase64(new Uint8Array(await subtle().exportKey('raw', pair.publicKey)));
  const privateKeyB64 = toBase64(new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ publicKey, privateKey: privateKeyB64 }, null, 2), { mode: 0o600 });
  cachedIdentity = { publicKey, privateKey: pair.privateKey };
  return cachedIdentity;
}

/** Pinned signer per resource path, plus the highest counter seen from it. */
interface PeerRecord {
  key: PublicKeyB64;
  counter: number;
}

type PeerFile = Record<string, PeerRecord>;

function loadPeers(file = SIGNING_PEERS_FILE): PeerFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PeerFile) : {};
  } catch {
    return {};
  }
}

function savePeers(peers: PeerFile, file = SIGNING_PEERS_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(peers, null, 2), { mode: 0o600 });
}

/**
 * The signer pinning and counter bookkeeping, as an interface so the policy can
 * be driven from a temp directory in tests rather than from `~/.lines-app`.
 */
export interface SignerStore {
  get(resource: string): PeerRecord | undefined;
  set(resource: string, record: PeerRecord): void;
}

export const fileSignerStore: SignerStore = {
  get: (resource) => loadPeers()[resource],
  set: (resource, record) => {
    const peers = loadPeers();
    peers[resource] = record;
    savePeers(peers);
  },
};

/** Counter for this machine's own writes. Monotonic across restarts. */
let localCounter = 0;

export function nextCounter(store: SignerStore, publicKey: PublicKeyB64): number {
  const own = store.get('self');
  const base = Math.max(localCounter, own?.counter ?? 0);
  localCounter = base + 1;
  store.set('self', { key: publicKey, counter: localCounter });
  return localCounter;
}

/** Attach a signature to a blob. Returns a copy; the input is untouched. */
export async function signBlob<T extends object>(
  value: T,
  identity: SigningIdentity,
  store: SignerStore = fileSignerStore,
): Promise<T & { [SIGNATURE_KEY]: BlobSignature }> {
  const counter = nextCounter(store, identity.publicKey);
  const payload = `${counter} ${canonicalize(value)}`;
  const sig = toBase64(new Uint8Array(await subtle().sign(SIGN_PARAMS, identity.privateKey, bytes(payload))));
  return {
    ...value,
    [SIGNATURE_KEY]: { alg: 'ecdsa-p256-sha256', key: identity.publicKey, counter, sig },
  };
}

/**
 * Check a pulled blob.
 *
 * `resource` names what is being pulled ('/sessions', '/memory'), because the
 * pin and the counter are per resource: two machines legitimately write
 * different resources, and one counter across all of them would make ordinary
 * concurrent use look like a rollback.
 */
export async function verifyBlob(
  resource: string,
  value: unknown,
  store: SignerStore = fileSignerStore,
): Promise<VerifyResult> {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'unsigned' };
  const signature = (value as Signed)[SIGNATURE_KEY];
  if (!signature || signature.alg !== 'ecdsa-p256-sha256' || typeof signature.sig !== 'string') {
    return { ok: false, reason: 'unsigned' };
  }
  const pinned = store.get(resource);
  // Trust-on-first-use, then pinned. A signer that changes is what an attacker
  // with the database has to do, and it is also what a genuinely new machine
  // looks like — so it is refused *and surfaced* rather than either silently
  // accepted or silently dropped.
  if (pinned && pinned.key !== signature.key) {
    return { ok: false, reason: 'signer-changed', signer: signature.key };
  }
  if (pinned && signature.counter <= pinned.counter) {
    return { ok: false, reason: 'rollback', signer: signature.key };
  }

  let verified = false;
  try {
    const key = await subtle().importKey('raw', fromBase64(signature.key), ECDSA_PARAMS, true, ['verify']);
    const payload = `${signature.counter} ${canonicalize(value)}`;
    verified = await subtle().verify(SIGN_PARAMS, key, fromBase64(signature.sig), bytes(payload));
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: 'forged' };

  store.set(resource, { key: signature.key, counter: signature.counter });
  return { ok: true, signer: signature.key };
}

/** The blob as the app should see it: whatever was signed, without the signature. */
export function stripSignature<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const { [SIGNATURE_KEY]: _sig, ...rest } = value as Signed;
  return rest as T;
}

/**
 * Whether an unsigned or unverifiable blob is refused outright.
 *
 * Off during rollout: every machine in a fleet has to be writing signatures
 * before refusing unsigned ones is anything other than a way to stop syncing.
 * The same switch as the channel's strict mode, deliberately — a deployment is
 * either taking the server's word for things or it is not.
 */
export function strictSync(): boolean {
  return process.env.LINES_E2EE_STRICT === '1';
}
