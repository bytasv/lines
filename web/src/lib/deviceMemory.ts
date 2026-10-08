/**
 * Which machine this browser is talking to. Persisted so a reload lands on the
 * same one, and read by the device gate at startup.
 */
const DEVICE_STORAGE_KEY = 'lines.deviceId';

/**
 * The machine this browser was on before the current one, so the header switcher
 * can toggle back to it. Written only when the remembered id actually changes —
 * every switch path goes through `rememberDeviceId`, so this is the one place.
 */
const PREVIOUS_DEVICE_STORAGE_KEY = 'lines.previousDeviceId';

export function rememberedDeviceId(): string | null {
  return localStorage.getItem(DEVICE_STORAGE_KEY);
}

export function rememberDeviceId(id: string): void {
  const current = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (current && current !== id) localStorage.setItem(PREVIOUS_DEVICE_STORAGE_KEY, current);
  localStorage.setItem(DEVICE_STORAGE_KEY, id);
}

export function forgetDeviceId(): void {
  localStorage.removeItem(DEVICE_STORAGE_KEY);
}

export function previousDeviceId(): string | null {
  return localStorage.getItem(PREVIOUS_DEVICE_STORAGE_KEY);
}

/**
 * A pairing code the desktop shell handed this page in `#pair=<code>`, kept
 * across sign-in: Clerk's redirect drops the fragment, so the code is stashed
 * in sessionStorage (this tab only) before anything can redirect, and stripped
 * from the URL at once. Never written to a query string or a log.
 */
const PAIR_CODE_STORAGE_KEY = 'lines.pairCode';

/** Codes expire 15 minutes after the desktop app shows one; a stash older than that is useless. */
const PAIR_CODE_TTL_MS = 15 * 60_000;

export function takePairCodeFromUrl(): void {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const code = hash.get('pair');
  if (!code) return;
  sessionStorage.setItem(PAIR_CODE_STORAGE_KEY, JSON.stringify({ code: code.toUpperCase(), at: Date.now() }));

  hash.delete('pair');
  const rest = hash.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`,
  );
}

/** The handed-over pairing code, or null when there is none or it is too old to work. */
export function pendingPairCode(): string | null {
  try {
    const stash = JSON.parse(sessionStorage.getItem(PAIR_CODE_STORAGE_KEY) ?? 'null') as {
      code?: unknown;
      at?: unknown;
    } | null;
    if (typeof stash?.code !== 'string' || typeof stash.at !== 'number') return null;
    return Date.now() - stash.at < PAIR_CODE_TTL_MS ? stash.code : null;
  } catch {
    return null;
  }
}

export function clearPendingPairCode(): void {
  sessionStorage.removeItem(PAIR_CODE_STORAGE_KEY);
}
