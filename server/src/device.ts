/**
 * This machine's identity, as the relay knows it.
 *
 * A hosted deployment runs the agent on the user's own computer: the bridge
 * dials out to the relay and names a device, and the relay asks storage whether
 * that device's secret is real and who owns it. This module owns the two halves
 * of that — minting the credential and registering it — so the desktop app and
 * the pairing script cannot drift apart on the format.
 *
 * The secret never leaves this machine. Only its sha256 is registered, so a
 * compromise of the server yields nothing that can impersonate the device.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT } from './workerProtocol.ts';

/** Mode 0600 — this file is a credential, not configuration. */
export const DEVICE_FILE = path.join(APP_ROOT, 'device.json');

export interface DeviceIdentity {
  id: string;
  secret: string;
}

/**
 * Load this machine's identity, minting one on first use. A corrupt or partial
 * file is treated as a new machine rather than a fatal error: the user re-pairs,
 * which is a smaller inconvenience than an app that refuses to start.
 */
export function deviceIdentity(file = DEVICE_FILE): DeviceIdentity {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DeviceIdentity>;
    if (saved.id && saved.secret) return { id: saved.id, secret: saved.secret };
  } catch {
    // fall through to minting
  }
  const identity: DeviceIdentity = { id: randomUUID(), secret: randomBytes(32).toString('hex') };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

/**
 * Who last opened an owner channel to this machine — a Clerk user id, 0600 like
 * `device.json`.
 *
 * The desktop app's local fallback window has no Clerk session, so it cannot
 * say whose sessions it wants; the bridge binds it to this user's context, so it
 * shows exactly what the hosted window showed a moment before. Only ever written
 * from an owner channel that authenticated end to end, never a guest's.
 */
export const LAST_OWNER_FILE = path.join(APP_ROOT, 'last-owner.json');

/** The last owner, or null when none has connected (or the file is unreadable). */
export function readLastOwnerId(file = LAST_OWNER_FILE): string | null {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { userId?: unknown };
    return typeof saved.userId === 'string' && saved.userId ? saved.userId : null;
  } catch {
    return null;
  }
}

/** Record the owner; a no-op when it is already the one on file. */
export function writeLastOwnerId(userId: string, file = LAST_OWNER_FILE): void {
  if (readLastOwnerId(file) === userId) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ userId }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Forget the owner: this machine was revoked, so its sessions are nobody's to show. */
export function clearLastOwnerId(file = LAST_OWNER_FILE): void {
  fs.rmSync(file, { force: true });
}

export function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * How long registration may take. It runs before the bridge and the worker are
 * spawned, so a storage server that accepts the connection and never answers
 * would otherwise hold the whole app at boot — which is exactly when the cloud
 * is down and the local window is all the user has.
 */
export const REGISTER_TIMEOUT_MS = 5_000;

/**
 * Announce this machine to storage.
 *
 * Returns the code the user types into the web app to bind it to their account,
 * or null when it is already claimed — registration refuses to re-issue a code
 * for a device someone owns, which is exactly how "already paired" is detected.
 */
export async function registerDevice(
  storageUrl: string,
  identity: DeviceIdentity,
  name = os.hostname(),
  timeoutMs = REGISTER_TIMEOUT_MS,
): Promise<string | null> {
  const res = await fetch(`${storageUrl}/v1/devices/register`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: identity.id,
      secretHash: secretHash(identity.secret),
      name,
      platform: process.platform,
    }),
  });
  if (res.status === 409) return null;
  if (!res.ok) {
    throw new Error(`device registration failed: ${res.status} ${await res.text()}`);
  }
  const { pairingCode } = (await res.json()) as { pairingCode: string };
  return pairingCode;
}

/**
 * Release this machine from whatever account claimed it, proving possession of
 * its own secret.
 *
 * The counterpart to {@link registerDevice}, and the machine's own way back when
 * the web app is unusable: storage refuses to re-issue a pairing code for a
 * claimed device, so the claim has to go first. It issues no code itself — call
 * `registerDevice` after this, which is the one path that mints one.
 */
export async function unpairDevice(storageUrl: string, identity: DeviceIdentity): Promise<void> {
  const res = await fetch(`${storageUrl}/v1/devices/unpair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: identity.id, secret: identity.secret }),
  });
  // 403 covers "not claimed by anyone" as well as a bad secret, and the first is
  // already the desired end state — so it is not an error worth raising.
  if (res.status === 403) return;
  if (!res.ok) {
    throw new Error(`device unpair failed: ${res.status} ${await res.text()}`);
  }
}
