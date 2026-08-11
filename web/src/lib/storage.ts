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
}

/** Set by main.tsx from Clerk, so these helpers need no React context. */
let tokenProvider: (() => Promise<string | null>) | null = null;

export function setStorageTokenProvider(fn: () => Promise<string | null>): void {
  tokenProvider = fn;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!STORAGE_URL) throw new Error('storage is not configured in this build');
  const token = tokenProvider ? await tokenProvider() : null;
  const res = await fetch(`${STORAGE_URL}${path}`, {
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
  const { devices } = await call<{ devices: Device[] }>('/v1/devices');
  return devices;
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
  return [...devices].sort(
    (a, b) => new Date(b.lastSeenAt ?? 0).getTime() - new Date(a.lastSeenAt ?? 0).getTime(),
  )[0];
}

/**
 * Bind a machine to this account with the code it printed. The code is consumed
 * on use, so a retry with the same one fails as unknown.
 */
export async function claimDevice(code: string): Promise<Device> {
  return call<Device>('/v1/devices/claim', {
    method: 'POST',
    body: JSON.stringify({ code: code.trim().toUpperCase() }),
  });
}
