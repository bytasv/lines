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

export function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

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
): Promise<string | null> {
  const res = await fetch(`${storageUrl}/v1/devices/register`, {
    method: 'POST',
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
