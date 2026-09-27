/**
 * Client connection reports (`POST /v1/diagnostics`).
 *
 * A browser stuck on "connecting to your machine" has no socket to the bridge,
 * so its record of what the connect path did can only reach a human through
 * here. Nothing is stored: the sanitised report is written to stdout as one
 * `[diag]` line and read with `docker compose logs storage | grep '\[diag\]'`.
 *
 * Pure so it can be tested without Express or a database.
 */

export const DIAG_BODY_LIMIT = 128 * 1024;
const MAX_ENTRIES = 1000;
const MAX_STRING = 300;
const SOURCES = new Set(['desktop-window', 'pwa', 'browser']);

type Scalar = string | number | boolean | null;
export interface DiagReport {
  source: string;
  deviceId: string | null;
  userAgent: string;
  entries: { t: number; k: string; d?: Record<string, Scalar> }[];
}

const clip = (v: string) => (v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v);

// Belt and braces: the client already strips the socket query, but a token that
// slipped into any string field must never reach a log line.
const scrub = (v: string) => clip(v.replace(/([?&](?:token|secret)=)[^&\s"]+/gi, '$1[redacted]'));

function scalar(v: unknown): Scalar | undefined {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return scrub(v);
  return undefined;
}

/** Null when the body is not a report at all; otherwise a copy with only known, bounded fields. */
export function sanitizeDiagReport(body: unknown): DiagReport | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.entries)) return null;
  const entries: DiagReport['entries'] = [];
  for (const raw of b.entries.slice(-MAX_ENTRIES)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.t !== 'number' || typeof e.k !== 'string') continue;
    const entry: DiagReport['entries'][number] = { t: e.t, k: clip(e.k) };
    if (e.d && typeof e.d === 'object') {
      const d: Record<string, Scalar> = {};
      for (const [key, value] of Object.entries(e.d as Record<string, unknown>).slice(0, 20)) {
        const s = scalar(value);
        if (s !== undefined) d[clip(key)] = s;
      }
      entry.d = d;
    }
    entries.push(entry);
  }
  return {
    source: typeof b.source === 'string' && SOURCES.has(b.source) ? b.source : 'unknown',
    deviceId: typeof b.deviceId === 'string' ? clip(b.deviceId) : null,
    userAgent: typeof b.userAgent === 'string' ? clip(b.userAgent) : '',
    entries,
  };
}
