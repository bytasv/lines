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
 *
 * ## Library items
 *
 * Workflows, steps and recipes travel as arrays, so each *item* carries its own
 * signature under the same reserved key, and the trust model is different on
 * purpose (see `ItemTrust`). Pinning one signer per resource, as the blobs do,
 * would refuse every edit made on the user's second machine as a "changed
 * signer"; instead anything this machine did not sign is kept but held back from
 * running until the owner has reviewed that exact content.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fromBase64, toBase64, type PublicKeyB64, type UntrustedMark, type UntrustedReason } from '@lines/shared';
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

/**
 * Claim `n` consecutive counters for this machine's writes and return the first.
 * One store write for the lot: a push of a step's whole version history signs
 * every row, and a file write per row would cost more than the signing does.
 */
export function reserveCounters(store: SignerStore, publicKey: PublicKeyB64, n: number): number {
  const own = store.get('self');
  const base = Math.max(localCounter, own?.counter ?? 0);
  localCounter = base + n;
  store.set('self', { key: publicKey, counter: localCounter });
  return base + 1;
}

export function nextCounter(store: SignerStore, publicKey: PublicKeyB64): number {
  return reserveCounters(store, publicKey, 1);
}

/** The signature over `canonical`, which is whatever part of a value it covers. */
async function signatureFor(canonical: string, identity: SigningIdentity, counter: number): Promise<BlobSignature> {
  const payload = `${counter}\0${canonical}`;
  const sig = toBase64(new Uint8Array(await subtle().sign(SIGN_PARAMS, identity.privateKey, bytes(payload))));
  return { alg: 'ecdsa-p256-sha256', key: identity.publicKey, counter, sig };
}

/** Attach a signature to a blob. Returns a copy; the input is untouched. */
export async function signBlob<T extends object>(
  value: T,
  identity: SigningIdentity,
  store: SignerStore = fileSignerStore,
): Promise<T & { [SIGNATURE_KEY]: BlobSignature }> {
  const counter = nextCounter(store, identity.publicKey);
  return { ...value, [SIGNATURE_KEY]: await signatureFor(canonicalize(value), identity, counter) };
}

/** The signature a value carries, if it is one this module could have written. */
function signatureOf(value: unknown): BlobSignature | null {
  if (!value || typeof value !== 'object') return null;
  const signature = (value as Signed)[SIGNATURE_KEY];
  if (!signature || signature.alg !== 'ecdsa-p256-sha256' || typeof signature.sig !== 'string') return null;
  return signature;
}

/** Does `signature` verify over `canonical` under the key it names? Any malformation is a no. */
async function signatureMatches(signature: BlobSignature, canonical: string): Promise<boolean> {
  try {
    const key = await subtle().importKey('raw', fromBase64(signature.key), ECDSA_PARAMS, true, ['verify']);
    const payload = `${signature.counter}\0${canonical}`;
    return await subtle().verify(SIGN_PARAMS, key, fromBase64(signature.sig), bytes(payload));
  } catch {
    return false;
  }
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
  const signature = signatureOf(value);
  if (!signature) return { ok: false, reason: 'unsigned' };
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

  if (!(await signatureMatches(signature, canonicalize(value)))) return { ok: false, reason: 'forged' };

  store.set(resource, { key: signature.key, counter: signature.counter });
  return { ok: true, signer: signature.key };
}

// ---- library items -----------------------------------------------------------

/**
 * Fields an item's signature leaves out, because something other than the
 * signing machine legitimately rewrites them. Storage injects `createdAt` from
 * its own column on `GET /workflows` and `/steps`. `untrusted` is this bridge's
 * own verdict and never travels.
 *
 * `ownerId` is deliberately signed, although storage fills it from the row's
 * `user_id` on some routes: for a user's own rows that is the value the bridge
 * signed, and the signing key is per machine, not per account — so without the
 * owner inside the signature, a row one account on a shared machine signed
 * would verify in another account's library.
 */
const ITEM_UNSIGNED_FIELDS = new Set(['createdAt', 'untrusted']);

/** The part of a library item its signature covers. */
export function itemPayload(item: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([k]) => !ITEM_UNSIGNED_FIELDS.has(k)));
}

export type TrustKind = 'workflow' | 'step' | 'recipe';

/**
 * What a signature binds an item to besides its content: which kind of item it
 * is, and whose. The account matters because one machine key signs for every
 * account on that machine, and an item may carry no `ownerId` of its own (the
 * seeded default workflow, rows from before owners were stamped) — so without
 * it, a row moved from one account's table into another's would still verify.
 */
export interface ItemScope {
  kind: TrustKind;
  account: string;
}

/** The exact bytes an item's signature covers, as a canonical string. */
function itemCanonical(item: object, scope: ItemScope): string {
  return canonicalize({ account: scope.account, item: itemPayload(item), kind: scope.kind });
}

/**
 * Sign library items — workflows, steps, recipes — each on its own, so a row
 * carries its signature wherever storage puts it. Counters are claimed in one
 * reservation. Returns copies; the inputs are untouched.
 */
export async function signItems<T extends object>(
  items: T[],
  scope: ItemScope,
  identity: SigningIdentity,
  store: SignerStore = fileSignerStore,
): Promise<(T & { [SIGNATURE_KEY]: BlobSignature })[]> {
  if (items.length === 0) return [];
  const first = reserveCounters(store, identity.publicKey, items.length);
  return Promise.all(
    items.map(async (item, i) => ({
      ...item,
      [SIGNATURE_KEY]: await signatureFor(itemCanonical(item, scope), identity, first + i),
    })),
  );
}

export type ItemVerdict =
  | { ok: true; signer: PublicKeyB64 }
  | { ok: false; reason: 'unsigned' | 'forged' };

/**
 * Check one pulled item's signature against the key it names — the crypto only.
 *
 * No pin and no counter check, unlike `verifyBlob`: no key but this machine's
 * own is trusted for items (see `ItemTrust`), and a replayed older item loses to
 * the engines' own last-write-wins on `updatedAt` / `version`, both of which sit
 * inside the signature and so cannot be bumped by whoever replays it.
 */
export async function verifyItem(item: unknown, scope: ItemScope): Promise<ItemVerdict> {
  const signature = signatureOf(item);
  if (!signature) return { ok: false, reason: 'unsigned' };
  const ok = await signatureMatches(signature, itemCanonical(item as object, scope));
  return ok ? { ok: true, signer: signature.key } : { ok: false, reason: 'forged' };
}

/**
 * Whether a mark keeps its item from running.
 *
 * - **Another machine's signature** holds the item back unless the account
 *   trusts that machine — which only ever happens by the owner comparing its
 *   fingerprint with the one that machine shows (`trustSigner`).
 * - **Unsigned or forged** items still run under `LINES_E2EE_STRICT=0`, the
 *   recovery switch the blobs honour too (a fleet with a bridge too old to sign
 *   writes nothing else), but keep their mark, so this machine never signs them
 *   as its own.
 * - **Another user's content** is held back until reviewed, always.
 */
export function holdsBack(mark: UntrustedMark, trustedSigners?: ReadonlySet<PublicKeyB64>): boolean {
  if (mark.reason === 'unknown-signer') return !(mark.signer && trustedSigners?.has(mark.signer));
  if (mark.reason === 'unsigned' || mark.reason === 'forged') return strictSync();
  return true;
}

/**
 * A mark with `held` decided now — from the current strictness and, for
 * another machine's signature, the account's trusted keys — and the signer's
 * fingerprint computed from the key itself. Every mark the bridge stores goes
 * through here, including ones loaded from disk: a decision made while strict
 * sync was off, or before a key was revoked, cannot outlive it. Without
 * `trustedSigners`, another machine's signature holds (the engine re-settles
 * with the account's keys).
 */
export function settledHold(mark: UntrustedMark, trustedSigners?: ReadonlySet<PublicKeyB64>): UntrustedMark {
  const { held: _was, signerFingerprint: _shown, ...rest } = mark;
  const fingerprint = rest.signer ? fingerprintOf(rest.signer) : undefined;
  const settled = fingerprint ? { ...rest, signerFingerprint: fingerprint } : rest;
  return holdsBack(mark, trustedSigners) ? settled : { ...settled, held: false };
}

/** A key's fingerprint, or undefined for a malformed one — marks are re-settled on load, which must not throw. */
function fingerprintOf(key: PublicKeyB64): string | undefined {
  try {
    return syncKeyFingerprint(key);
  } catch {
    return undefined;
  }
}

/** True when the item is held back from running here (not merely marked). */
export function isHeld(item: { untrusted?: UntrustedMark }): boolean {
  return !!item.untrusted && item.untrusted.held !== false;
}

/** True when the mark only records which trusted machine signed the item. */
export function fromTrustedMachine(mark: UntrustedMark | undefined): boolean {
  return mark?.reason === 'unknown-signer' && mark.held === false;
}

/**
 * Content this account vouches for: unmarked, or signed by a machine it trusts.
 * Narrower than "not held back" on purpose — an unsigned item running under
 * `LINES_E2EE_STRICT=0` is tolerated, not verified, and must never be what
 * makes another copy count as trusted.
 */
export function vouchedFor(item: { untrusted?: UntrustedMark }): boolean {
  return !item.untrusted || fromTrustedMachine(item.untrusted);
}

const UNTRUSTED_REASONS: readonly UntrustedReason[] = ['unsigned', 'forged', 'unknown-signer', 'foreign'];

/**
 * The mark an item keeps across a local save. An item held back stays held back
 * when its owner edits it — only a review clears a mark, and an edit is not one,
 * or renaming an unverified workflow would be all it took to run it. The digest
 * follows the new content; the signer only survives an edit that changed nothing
 * that runs, since it no longer describes who wrote what is there.
 *
 * Content from a machine the account trusts is the user's own, and so is an
 * edit made to it here: that mark is dropped, and this machine signs the result.
 *
 * `requested` is the mark a caller sent along — a copy of held-back content
 * carries its original's; a stranger's recipe copied into the user's library
 * arrives as `foreign` — and is honoured in the one direction a client may push:
 * towards holding back. An existing mark always wins, so a client can never
 * clear one by sending something else.
 */
export function markAfterSave(
  kind: TrustKind,
  item: object,
  existing: UntrustedMark | undefined,
  requested: unknown,
): UntrustedMark | undefined {
  const kept = fromTrustedMachine(existing) ? undefined : existing;
  const sent = requested as Partial<UntrustedMark> | null | undefined;
  const reason =
    kept?.reason ??
    (sent && typeof sent === 'object'
      ? UNTRUSTED_REASONS.includes(sent.reason!)
        ? sent.reason!
        : 'unsigned'
      : undefined);
  if (!reason) return undefined;
  const digest = runnableDigest(kind, item);
  return settledHold({
    reason,
    digest,
    ...(kept?.signer && kept.digest === digest ? { signer: kept.signer } : {}),
  });
}

/**
 * A signing key's fingerprint, the form a user compares between two machines:
 * the first 8 bytes of SHA-256 over the raw key, in groups of four hex digits —
 * the same rendering `fingerprint` in shared/e2ee.ts gives an enrolled browser's
 * key, so every key a user is ever asked to compare reads the same way. Computed
 * on the bridge, which holds the keys, and handed to the browser ready-made.
 */
export function syncKeyFingerprint(key: PublicKeyB64): string {
  const digest = createHash('sha256').update(fromBase64(key)).digest();
  return [...digest.subarray(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * This machine's signing key, read without loading the private half — for the
 * owner's `hello`, which is built synchronously. Null before the key exists: it
 * is minted the first time this machine signs or checks a synced item.
 */
export function ownSigningKey(file = SIGNING_IDENTITY_FILE): PublicKeyB64 | null {
  if (cachedIdentity && file === SIGNING_IDENTITY_FILE) return cachedIdentity.publicKey;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { publicKey?: unknown };
    return typeof saved.publicKey === 'string' ? saved.publicKey : null;
  } catch {
    return null;
  }
}
/**
 * What an item *runs*, as opposed to how it is labelled: a workflow's steps, a
 * step's content fields, a recipe's prompt and members. A rename or a publish
 * toggle is not an instruction change, so it neither needs a review nor
 * invalidates one.
 */
function runnableContent(kind: TrustKind, item: Record<string, unknown>): unknown {
  if (kind === 'workflow') return { steps: item.steps ?? [] };
  if (kind === 'recipe') return { title: item.title, prompt: item.prompt, members: item.members ?? [] };
  return {
    name: item.name,
    promptTemplate: item.promptTemplate,
    model: item.model,
    permissionMode: item.permissionMode,
    // Empty and absent mean the same thing for these two (see `sameContent`).
    reasoningEffort: item.reasoningEffort || undefined,
    routing: item.routing,
    autoAdvance: item.autoAdvance,
    freshStart: item.freshStart,
    outputName: item.outputName || undefined,
  };
}

/** `item` without its `untrusted` mark; the same object when it carries none. */
export function unmarked<T extends { untrusted?: unknown }>(item: T): T {
  if (item.untrusted === undefined) return item;
  const { untrusted: _mark, ...rest } = item;
  return rest as T;
}

/** SHA-256 of an item's runnable content, canonicalised — what a review is bound to. */
export function runnableDigest(kind: TrustKind, item: object): string {
  return createHash('sha256')
    .update(canonicalize(runnableContent(kind, item as Record<string, unknown>)))
    .digest('base64');
}

/** The per-account trust record: content the owner has reviewed, and machines they verified. */
interface TrustRecord {
  /** `kind:ownerId/id[/version]` -> the digest that was reviewed. */
  approved: Record<string, string>;
  /** Other machines' signing keys, each trusted by comparing its fingerprint. */
  signers: { key: PublicKeyB64; trustedAt: number }[];
}

/**
 * What one account has reviewed and allowed, on top of what this machine signed
 * itself — which is runnable without a record.
 *
 * - **Approved content.** Bound to one item's digest, whoever wrote it: another
 *   machine of the user's, another user, or something that only had the
 *   database. If the content changes — a later edit, an author rewriting a
 *   published version in place (a version row is only immutable by convention)
 *   — it needs reviewing again. Approving an item never extends to the machine
 *   that signed it.
 * - **Trusted machines.** A key is only ever added by the owner's explicit
 *   "trust this machine", made after comparing its fingerprint with the one that
 *   machine shows in its own Settings — the one thing that ties a key to a
 *   machine of theirs. Everything that key signs then runs here, until revoked.
 *
 * Per user and 0600, beside the rest of that user's state, and never uploaded: a
 * trust decision storage could write is one an attacker with the database could
 * write. Read on every call rather than cached, because both engines and the
 * command layer hold one each and must agree.
 */
export class ItemTrust {
  constructor(private readonly file: string) {}

  /** The trust record for the user whose store lives in `rootDir`. */
  static forStore(rootDir: string): ItemTrust {
    return new ItemTrust(path.join(rootDir, 'sync-trust.json'));
  }

  private load(): TrustRecord {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<TrustRecord> | null;
      const approved = raw?.approved;
      const signers = Array.isArray(raw?.signers) ? raw.signers : [];
      return {
        approved: approved && typeof approved === 'object' && !Array.isArray(approved) ? approved : {},
        signers: signers.filter(
          (s): s is TrustRecord['signers'][number] => typeof s?.key === 'string' && typeof s.trustedAt === 'number',
        ),
      };
    } catch {
      return { approved: {}, signers: [] };
    }
  }

  private save(record: TrustRecord): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(record, null, 2), { mode: 0o600 });
  }

  /** Every approval, in one read for a whole batch of items — a shared corpus can hold hundreds. */
  approvals(): Record<string, string> {
    return this.load().approved;
  }

  approvedDigest(itemKey: string): string | undefined {
    return this.load().approved[itemKey];
  }

  approve(itemKey: string, digest: string): void {
    const record = this.load();
    if (record.approved[itemKey] === digest) return;
    record.approved[itemKey] = digest;
    this.save(record);
  }

  /** The machine keys this account trusts, in one read. */
  trustedSigners(): Set<PublicKeyB64> {
    return new Set(this.load().signers.map((s) => s.key));
  }

  /** Every trusted machine key, oldest first, for the owner to review and revoke. */
  signers(): { key: PublicKeyB64; trustedAt: number }[] {
    return this.load().signers;
  }

  /** Record a key as trusted. False when it already was. */
  trustSigner(key: PublicKeyB64, at = Date.now()): boolean {
    const record = this.load();
    if (record.signers.some((s) => s.key === key)) return false;
    record.signers.push({ key, trustedAt: at });
    this.save(record);
    return true;
  }

  /** Stop trusting a key. False when it was not trusted. */
  untrustSigner(key: PublicKeyB64): boolean {
    const record = this.load();
    const kept = record.signers.filter((s) => s.key !== key);
    if (kept.length === record.signers.length) return false;
    record.signers = kept;
    this.save(record);
    return true;
  }
}

/** The blob as the app should see it: whatever was signed, without the signature. */
export function stripSignature<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const { [SIGNATURE_KEY]: _sig, ...rest } = value as Signed;
  return rest as T;
}

/**
 * Whether an unsigned blob is refused outright.
 *
 * On by default: a blob without a signature is exactly what a storage server
 * that wanted to author this machine's settings would write, so accepting one
 * is taking the server's word for it. `LINES_E2EE_STRICT=0` turns it off, and
 * is for recovery only — say, a fleet with a bridge too old to sign. A blob
 * that is signed but does not verify is refused either way.
 */
export function strictSync(): boolean {
  return process.env.LINES_E2EE_STRICT !== '0';
}
