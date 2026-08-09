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
 * Bind a machine to this account with the code it printed. The code is consumed
 * on use, so a retry with the same one fails as unknown.
 */
export async function claimDevice(code: string): Promise<Device> {
  return call<Device>('/v1/devices/claim', {
    method: 'POST',
    body: JSON.stringify({ code: code.trim().toUpperCase() }),
  });
}
