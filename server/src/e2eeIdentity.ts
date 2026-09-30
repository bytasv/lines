/**
 * This machine's end-to-end encryption identity, and the devices it trusts.
 *
 * Three files under `~/.lines-app`, all 0600, all local-only:
 *
 *   e2ee-identity.json — the bridge's static keypair.
 *   e2ee-peers.json    — public keys of enrolled client devices.
 *   e2ee-enroll.json    — the live one-time enrollment code, if any.
 *
 * **None of them is ever uploaded.** `storage/prisma/schema.prisma` has no
 * public-key column and must not gain one: a key the server can rewrite is a key
 * an attacker with the database can rewrite, which is exactly the trust the
 * handshake exists to remove. Enrollment carries keys through the user — a code
 * read off one screen and typed (or scanned) into another — so the server never
 * sees, and never has to be believed about, either half.
 *
 * Shared with the desktop shell the same way `device.ts` is: the shell displays
 * the code and lists enrolled devices in the tray, the bridge verifies against
 * the same files, and neither can drift on the format.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ENROLL_CODE_LENGTH,
  enrollProof,
  exportPrivateKey,
  fingerprint,
  generateEnrollCode,
  generateIdentity,
  importPrivateKey,
  normalizeEnrollCode,
  timingSafeEqualB64,
  type Identity,
  type PublicKeyB64,
} from '@lines/shared';
import { APP_ROOT } from './workerProtocol.ts';

export const E2EE_IDENTITY_FILE = path.join(APP_ROOT, 'e2ee-identity.json');
export const E2EE_PEERS_FILE = path.join(APP_ROOT, 'e2ee-peers.json');
export const E2EE_ENROLL_FILE = path.join(APP_ROOT, 'e2ee-enroll.json');

/** Matches the pairing code's own lifetime, and short enough that a code read off
 *  a screen and left there is not a standing invitation. */
export const ENROLL_TTL_MS = 15 * 60_000;

/** One enrolled client device, as the tray lists it and the handshake checks it. */
export interface EnrolledPeer {
  publicKey: PublicKeyB64;
  /** Short hash of the key, so a human can compare two screens. */
  fingerprint: string;
  /** What the user called it — a browser's own guess, so purely a label. */
  label: string;
  enrolledAt: number;
  lastSeenAt?: number;
}

interface StoredIdentity {
  publicKey: PublicKeyB64;
  /** PKCS#8, base64. The bridge's key has to survive a restart, so unlike the
   *  browser's it cannot be non-extractable. The file is 0600; that is the
   *  protection, and it is the same one `device.json` relies on. */
  privateKey: string;
}

let cached: Identity | null = null;

/**
 * Load this machine's static key, minting one on first use.
 *
 * A corrupt file is treated as no key rather than a fatal error, exactly as
 * `deviceIdentity` treats a corrupt `device.json`: the user re-enrolls their
 * devices, which is a smaller inconvenience than a bridge that will not start.
 * Re-enrollment is possible from the tray without a browser, which is what keeps
 * key pinning from being a lock-out.
 */
export async function bridgeIdentity(file = E2EE_IDENTITY_FILE): Promise<Identity> {
  if (cached) return cached;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredIdentity>;
    if (saved.publicKey && saved.privateKey) {
      cached = { publicKey: saved.publicKey, privateKey: await importPrivateKey(saved.privateKey) };
      return cached;
    }
  } catch {
    // fall through to minting
  }
  const identity = await generateIdentity(true);
  const stored: StoredIdentity = {
    publicKey: identity.publicKey,
    privateKey: await exportPrivateKey(identity.privateKey),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  cached = identity;
  return identity;
}

export function listPeers(file = E2EE_PEERS_FILE): EnrolledPeer[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is EnrolledPeer =>
        !!p && typeof (p as EnrolledPeer).publicKey === 'string' && typeof (p as EnrolledPeer).fingerprint === 'string',
    );
  } catch {
    return [];
  }
}

function savePeers(peers: EnrolledPeer[], file = E2EE_PEERS_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(peers, null, 2), { mode: 0o600 });
}

/** Whether a client key may open an encrypted channel here. The pin check. */
export function isEnrolled(publicKey: PublicKeyB64, file = E2EE_PEERS_FILE): boolean {
  return listPeers(file).some((p) => p.publicKey === publicKey);
}

/** Forget a device. Its next connection fails the handshake with an unknown key. */
export function revokePeer(publicKey: PublicKeyB64, file = E2EE_PEERS_FILE): boolean {
  const peers = listPeers(file);
  const next = peers.filter((p) => p.publicKey !== publicKey);
  if (next.length === peers.length) return false;
  savePeers(next, file);
  return true;
}

interface StoredEnrollment {
  code: string;
  expiresAt: number;
}

/**
 * Mint the code the user carries to the new device. Displayed by the desktop
 * shell (as text and inside a QR), and consumed by exactly one enrollment.
 *
 * Deliberately single-use and short-lived: it is the only thing standing between
 * "somebody watched this exchange" and "somebody enrolled a device on your
 * machine", and its length (100 bits) is what makes guessing it in one shot
 * hopeless. A PAKE would let it be short; that needs a vetted library and an
 * external review, so it is explicitly not this version.
 */
export function mintEnrollmentCode(file = E2EE_ENROLL_FILE): StoredEnrollment {
  const enrollment: StoredEnrollment = {
    code: generateEnrollCode(),
    expiresAt: Date.now() + ENROLL_TTL_MS,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(enrollment, null, 2), { mode: 0o600 });
  return enrollment;
}

/** The live code, or null when there is none or it has expired. */
export function currentEnrollment(file = E2EE_ENROLL_FILE): StoredEnrollment | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredEnrollment>;
    if (typeof raw.code !== 'string' || typeof raw.expiresAt !== 'number') return null;
    if (raw.expiresAt <= Date.now()) return null;
    if (normalizeEnrollCode(raw.code).length !== ENROLL_CODE_LENGTH) return null;
    return { code: raw.code, expiresAt: raw.expiresAt };
  } catch {
    return null;
  }
}

export function clearEnrollment(file = E2EE_ENROLL_FILE): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Already gone, or a read-only home. Either way the TTL still bounds it.
  }
}

/**
 * Verify an enrollment request and, if it holds up, pin the device.
 *
 * The proof is an HMAC over *both* public keys under the code, so possession of
 * the code authenticates the exchange rather than merely the request: a relay
 * that forwards a genuine enrollment cannot substitute its own key without
 * invalidating it. Returns the answering proof the client checks in turn, which
 * is what lets the client pin this bridge's key rather than one the relay named.
 */
export async function enrollPeer(
  identity: Identity,
  clientKey: PublicKeyB64,
  proof: string,
  label: string,
  files: { peers?: string; enroll?: string } = {},
): Promise<{ proof: string } | { error: string }> {
  const enrollment = currentEnrollment(files.enroll);
  if (!enrollment) return { error: 'No enrollment is open on that machine. Get a new code from the tray.' };
  // The request's proof covers the client key only — see enrollProof: a client
  // enrolling from a typed code has not learned this machine's key yet.
  const expected = await enrollProof(enrollment.code, 'enroll', clientKey);
  if (!timingSafeEqualB64(expected, proof)) return { error: 'That code does not match.' };

  const peers = listPeers(files.peers);
  if (!peers.some((p) => p.publicKey === clientKey)) {
    peers.push({
      publicKey: clientKey,
      fingerprint: await fingerprint(clientKey),
      label: label.slice(0, 64) || 'device',
      enrolledAt: Date.now(),
    });
    savePeers(peers, files.peers);
  }
  // One code, one device. Leaving it live would turn a shoulder-surfed screen
  // into a standing invitation for the rest of the TTL.
  clearEnrollment(files.enroll);
  return { proof: await enrollProof(enrollment.code, 'enrolled', clientKey, identity.publicKey) };
}

/** Note that a pinned device connected, for the tray's list. Best-effort. */
export function touchPeer(publicKey: PublicKeyB64, file = E2EE_PEERS_FILE): void {
  const peers = listPeers(file);
  const peer = peers.find((p) => p.publicKey === publicKey);
  if (!peer) return;
  peer.lastSeenAt = Date.now();
  try {
    savePeers(peers, file);
  } catch {
    // A read-only home must not fail a connection over a timestamp.
  }
}
