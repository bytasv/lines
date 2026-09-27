/**
 * Direct browser calls to the storage server.
 *
 * Everything else the client needs travels over the bridge socket; devices are
 * the exception, because they are how the browser *finds* a bridge in the first
 * place. Without a paired device there is no socket to ask.
 *
 * Only reachable in a hosted deployment, where VITE_STORAGE_URL names a public
 * storage origin. In a local setup the bridge is found on localhost and no
 * pairing exists, so these are never called.
 */

import type { ShareProfile } from '@lines/shared';
import { diag, diagEntries, diagSource, withTimeout, type DiagEntry } from './diag';

/**
 * No storage call may spin forever: the device gate renders a loading screen
 * for as long as the list is in flight, and neither Clerk's getToken nor fetch
 * has a deadline of its own.
 */
const TOKEN_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

export const STORAGE_URL: string | undefined = import.meta.env.VITE_STORAGE_URL;
export const DEVICE_PAIRING_ENABLED = Boolean(STORAGE_URL);

/**
 * Direct link to the macOS DMG, baked in at image build time like STORAGE_URL.
 * Unset (a local build, or a deployment with no release published yet) hides the
 * download surface entirely — a button pointing at nothing is worse than none.
 */
export const DESKTOP_DOWNLOAD_URL: string | undefined = import.meta.env.VITE_DESKTOP_DOWNLOAD_URL;
export const DESKTOP_DOWNLOAD_ENABLED = Boolean(DESKTOP_DOWNLOAD_URL);

/**
 * Version out of the artifact name (`Lines-0.2.0-arm64.dmg`). Derived rather than
 * carried in a second env var, so a published build and the version shown next to
 * it cannot disagree. Null when the name does not follow that shape.
 */
export const DESKTOP_DOWNLOAD_VERSION: string | null = (() => {
  if (!DESKTOP_DOWNLOAD_URL) return null;
  const match = /(\d+\.\d+\.\d+)/.exec(DESKTOP_DOWNLOAD_URL.split('/').pop() ?? '');
  return match ? match[1] : null;
})();

export interface Device {
  id: string;
  name: string;
  platform: string | null;
  lastSeenAt: string | null;
  /**
   * Whether the relay has a bridge attached for this machine. The only liveness
   * signal for a machine this browser holds no socket to — and already gated on
   * `lastSeenAt` freshness by storage, so a crashed relay reports false rather
   * than leaving every machine stuck online. Read through `unlinkedMachineHealth`,
   * which also refuses to believe a row that has gone stale in memory.
   */
  online: boolean;
  /** Present when this machine is somebody else's, reached through a grant. */
  shared?: boolean;
  scope?: 'machine' | 'session';
  /** Session-scope grants only: exactly the sessions you may see there. */
  sessionIds?: string[];
  ownerProfile?: ShareProfile | null;
}

/** Set by main.tsx from Clerk, so these helpers need no React context. */
let tokenProvider: (() => Promise<string | null>) | null = null;

export function setStorageTokenProvider(fn: () => Promise<string | null>): void {
  tokenProvider = fn;
}

/**
 * Shared with the share routes (lib/shares.ts), which need the same Clerk token
 * and the same error unwrapping. Exported rather than duplicated so there is one
 * place that knows how to talk to storage.
 */
export async function storageCall<T>(path: string, init?: RequestInit): Promise<T> {
  return call<T>(path, init);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!STORAGE_URL) throw new Error('storage is not configured in this build');
  let token: string | null = null;
  if (tokenProvider) {
    const minted = await withTimeout(tokenProvider(), TOKEN_TIMEOUT_MS);
    if (!minted.ok) {
      diag('storage-token-failed', { path, reason: minted.reason, ms: minted.ms });
      throw new Error(minted.reason === 'timeout' ? 'sign-in timed out — try again' : 'could not get a sign-in token');
    }
    token = minted.value;
  }
  const res = await fetch(`${STORAGE_URL}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    // Storage answers JSON on every error path, but a proxy in front of it may
    // not — fall back to the status rather than throwing a parse error over the
    // real failure.
    const detail = await res
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => null);
    throw new Error(detail ?? `storage responded ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Machines this user has paired. Revoked ones are already filtered out server-side. */
export async function listDevices(): Promise<Device[]> {
  const started = Date.now();
  try {
    const { devices } = await call<{ devices: Device[] }>('/v1/devices');
    diag('devices', {
      ms: Date.now() - started,
      count: devices.length,
      online: devices.filter((d) => d.online).length,
    });
    return devices;
  } catch (err) {
    diag('devices-error', { ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Upload this client's connection record, so a stuck episode on a phone can be
 * read server-side (`docker compose logs storage | grep '[diag]'`) without the
 * user having to copy anything off the device.
 */
export async function sendDiagnostics(deviceId: string | null, entries: DiagEntry[] = diagEntries()): Promise<void> {
  await call<{ ok: true }>('/v1/diagnostics', {
    method: 'POST',
    body: JSON.stringify({
      source: diagSource(),
      deviceId,
      userAgent: navigator.userAgent,
      entries,
    }),
  });
}

/**
 * Rename a machine.
 *
 * Cosmetic — nothing routes on the name — but the default is the machine's
 * hostname, which is often somebody's actual name, and it is stored in the
 * hosted database in plaintext. This is how a user takes that back.
 */
export async function renameDevice(id: string, name: string): Promise<void> {
  await call<{ ok: true }>(`/v1/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

/**
 * Revoke a machine's access. The relay checks `revokedAt` when a machine
 * attaches, so this stops it reconnecting — it does NOT sever a connection that
 * is already open. Say so in the UI rather than promising an instant kill.
 */
export async function revokeDevice(id: string): Promise<void> {
  await call<{ ok: true }>(`/v1/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Which machine this browser is talking to. Persisted so a reload lands on the
 * same one, and read by the device gate at startup.
 */
const DEVICE_STORAGE_KEY = 'lines.deviceId';

export function rememberedDeviceId(): string | null {
  return localStorage.getItem(DEVICE_STORAGE_KEY);
}

export function rememberDeviceId(id: string): void {
  localStorage.setItem(DEVICE_STORAGE_KEY, id);
}

export function forgetDeviceId(): void {
  localStorage.removeItem(DEVICE_STORAGE_KEY);
}

/**
 * Pick which machine to connect to: the remembered one while it still exists,
 * otherwise the most recently seen, which is the best guess at "the machine I am
 * sitting at". Null when there are none, which is what shows the pairing screen.
 */
export function chooseDevice(devices: Device[]): Device | null {
  if (devices.length === 0) return null;
  const remembered = devices.find((d) => d.id === rememberedDeviceId());
  if (remembered) return remembered;
  // Never *prefer* somebody else's machine, however recently it was seen: landing
  // there unasked would show a colleague's sessions as though they were yours.
  //
  // But do fall back to one. Someone invited into a session before pairing a
  // machine of their own has nothing else to connect to, and showing them the
  // pairing screen would strand them — Settings, where the machine list lives,
  // is behind this very gate.
  const own = devices.filter((d) => !d.shared);
  return [...(own.length ? own : devices)].sort(
    (a, b) => new Date(b.lastSeenAt ?? 0).getTime() - new Date(a.lastSeenAt ?? 0).getTime(),
  )[0];
}

/**
 * Bind a machine to this account with the code it printed. The code is consumed
 * on use, so a retry with the same one fails as unknown.
 */
export async function claimDevice(code: string): Promise<Pick<Device, 'id' | 'name' | 'platform'>> {
  // Narrower than Device on purpose: the claim reply carries identity only, with
  // no liveness in it — the machine is not necessarily even attached yet.
  return call<Pick<Device, 'id' | 'name' | 'platform'>>('/v1/devices/claim', {
    method: 'POST',
    body: JSON.stringify({ code: code.trim().toUpperCase() }),
  });
}
