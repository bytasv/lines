/**
 * A persistent, bounded record of what the connection path did, for the case
 * where it silently did nothing: a window stuck on "connecting to your machine"
 * after a night asleep, with no socket, no error and no console attached.
 *
 * Entries survive a reload (localStorage) because the usual first response to a
 * stuck window is to reload it. Each entry is also echoed as a `[diag]` console
 * line, which the desktop shell mirrors into ~/.lines-app/logs/desktop.log — the
 * only way the chrome-less desktop window's renderer reaches disk.
 *
 * Coarse on purpose: connect attempts, closes, wake decisions — never pings,
 * frames or stream deltas, and never a token or a URL query.
 *
 * The ring and timeout logic is pure and DOM-free so server/src/diagBuffer.test.ts
 * can import it under node:test; only `diag()` and its persistence touch globals.
 */

export type DiagValue = string | number | boolean | null;
export interface DiagEntry {
  /** Epoch ms. */
  t: number;
  /** Event kind, e.g. `dial`, `close`, `token-timeout`. */
  k: string;
  d?: Record<string, DiagValue>;
}

export const DIAG_STORAGE_KEY = 'lines.diag';
export const DIAG_MAX_ENTRIES = 1000;
export const DIAG_MAX_BYTES = 128 * 1024;

/**
 * Append and trim, oldest first, by count and then by serialized size. Returns a
 * new array; the input is not mutated.
 */
export function pushEntry(
  buffer: readonly DiagEntry[],
  entry: DiagEntry,
  maxEntries = DIAG_MAX_ENTRIES,
  maxBytes = DIAG_MAX_BYTES,
): DiagEntry[] {
  const next = [...buffer, entry];
  if (next.length > maxEntries) next.splice(0, next.length - maxEntries);
  let bytes = JSON.stringify(next).length;
  while (bytes > maxBytes && next.length > 1) {
    bytes -= JSON.stringify(next[0]).length + 1;
    next.shift();
  }
  return next;
}

/** Parse a persisted buffer, tolerating anything a previous build or a user left there. */
export function parseBuffer(raw: string | null): DiagEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is DiagEntry =>
        !!e && typeof e === 'object' && typeof (e as DiagEntry).t === 'number' && typeof (e as DiagEntry).k === 'string',
    );
  } catch {
    return [];
  }
}

export type TimeoutResult<T> =
  | { ok: true; value: T; ms: number }
  | { ok: false; reason: 'timeout' | 'error'; error?: unknown; ms: number };

/**
 * Race a promise against a deadline, never rejecting. A promise that never
 * settles — the failure this whole module exists to catch — resolves as
 * `timeout` instead of stranding its caller.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<TimeoutResult<T>> {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', ms: Date.now() - started }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value, ms: Date.now() - started });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'error', error, ms: Date.now() - started });
      },
    );
  });
}

/** Drop the query and fragment: a socket URL carries the Clerk token in `?token=`. */
export function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

let buffer: DiagEntry[] | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function load(): DiagEntry[] {
  if (buffer === null) buffer = parseBuffer(storage()?.getItem(DIAG_STORAGE_KEY) ?? null);
  return buffer;
}

function flush() {
  flushTimer = null;
  try {
    storage()?.setItem(DIAG_STORAGE_KEY, JSON.stringify(load()));
  } catch {
    /* quota or private mode: the console echo still carries it */
  }
}

/** Record one event. Cheap enough to call on every connect attempt. */
export function diag(k: string, d?: Record<string, DiagValue>): void {
  const entry: DiagEntry = d ? { t: Date.now(), k, d } : { t: Date.now(), k };
  buffer = pushEntry(load(), entry);
  console.info(`[diag] ${k}${d ? ` ${JSON.stringify(d)}` : ''}`);
  // Batched: a failing connect loop logs a few entries every 1.5s, and a
  // synchronous 128KB write per entry is main-thread time a stuck UI can't spare.
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
}

/** Write now — for pagehide, where a pending timer would never fire. */
export function flushDiag(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flush();
}

export function diagEntries(): DiagEntry[] {
  return [...load()];
}

const SOURCE_KEY = 'lines.diag.source';

/**
 * Remember that this tab is the desktop shell's window. The shell scrubs
 * `Electron/` from its user agent (Google refuses OAuth otherwise), so the only
 * tell is the `#host=` fragment it alone adds — consumed at boot, hence kept in
 * sessionStorage, which lives exactly as long as the window. Call before the
 * fragment is read.
 */
export function noteDesktopWindow(hash: string): void {
  if (!/(^|[#&])host=/.test(hash)) return;
  try {
    sessionStorage.setItem(SOURCE_KEY, 'desktop-window');
  } catch {
    /* best effort */
  }
}

/** Where this client is running, for the report header. */
export function diagSource(): 'desktop-window' | 'pwa' | 'browser' {
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(SOURCE_KEY)) return 'desktop-window';
  } catch {
    /* no storage */
  }
  // Read off globalThis: server/src tests import this module with no DOM lib.
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  if (mm?.('(display-mode: standalone)').matches) return 'pwa';
  return 'browser';
}

/** The whole buffer as text, for the "Copy" fallback. */
export function diagReport(): string {
  const header = {
    source: diagSource(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    at: new Date().toISOString(),
  };
  const lines = load().map((e) => `${new Date(e.t).toISOString()} ${e.k}${e.d ? ` ${JSON.stringify(e.d)}` : ''}`);
  return `${JSON.stringify(header)}\n${lines.join('\n')}\n`;
}

/** Marks entries up to now as already uploaded, so an auto-send never repeats. */
const SENT_KEY = 'lines.diag.sentAt';

export function lastDiagSentAt(): number {
  return Number(storage()?.getItem(SENT_KEY) ?? 0) || 0;
}

export function markDiagSent(at: number): void {
  try {
    storage()?.setItem(SENT_KEY, String(at));
  } catch {
    /* best effort */
  }
}

/**
 * Whether the buffer holds a stuck-connecting episode that has not been sent
 * yet — the trigger for uploading automatically once the link comes back.
 */
export function hasUnsentStall(entries: readonly DiagEntry[], sentAt: number): boolean {
  return entries.some((e) => e.k === 'connecting-slow' && e.t > sentAt);
}
