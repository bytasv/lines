/**
 * Polls Claude-plan usage (the same 5-hour / weekly windows shown by Claude
 * Code's `/usage`) and broadcasts snapshots to browsers.
 *
 * Auth uses the app's own login: the shared AuthManager supplies (and refreshes)
 * the OAuth access token. No login → no chip.
 */
import type { ServerMessage, UsageSnapshot, UsageWindow } from '@lines/shared';
import { AuthRequiredError, type AuthManager } from './auth.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes, like ClaudeUsageBar
const REFRESH_DEBOUNCE_MS = 5_000; // coalesce bursts of turn-complete refreshes
const REFRESH_MIN_SPACING_MS = 30_000; // never hit the endpoint more than this often
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FAILURES = 3; // consecutive failures before hiding a stale snapshot

/** Known window keys in display order; the parser also picks up unknown ones defensively. */
const KNOWN_WINDOWS = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus'];

/** Extract usage windows tolerantly, surviving additive shape drift. Throws if none parse. */
function parseSnapshot(body: unknown): UsageSnapshot {
  if (!body || typeof body !== 'object') throw new Error('usage response not an object');
  const record = body as Record<string, unknown>;
  const seen = new Set<string>();
  const windows: UsageWindow[] = [];
  const consider = (id: string) => {
    if (seen.has(id)) return;
    const val = record[id];
    if (!val || typeof val !== 'object') return;
    const util = (val as { utilization?: unknown }).utilization;
    if (typeof util !== 'number') return;
    const resets = (val as { resets_at?: unknown }).resets_at;
    seen.add(id);
    windows.push({
      id,
      utilization: util,
      resetsAt: typeof resets === 'string' ? resets : null,
    });
  };
  for (const id of KNOWN_WINDOWS) consider(id);
  for (const id of Object.keys(record)) consider(id);
  if (windows.length === 0) throw new Error('no usage windows in response');
  return { windows, fetchedAt: Date.now() };
}

export class UsagePoller {
  private snapshotValue: UsageSnapshot | null = null;
  private failures = 0;
  private inFlight = false;
  private lastFetchAt = 0;
  private available: boolean | null = null; // for logging state transitions only
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private broadcast: (msg: ServerMessage) => void,
    private auth: AuthManager,
  ) {}

  get snapshot(): UsageSnapshot | null {
    return this.snapshotValue;
  }

  start(): void {
    void this.fetch();
    setInterval(() => void this.fetch(), POLL_INTERVAL_MS).unref();
  }

  /** Request a refresh soon (after an SDK result), debounced and rate-limited. */
  refreshSoon(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (Date.now() - this.lastFetchAt < REFRESH_MIN_SPACING_MS) return;
      void this.fetch();
    }, REFRESH_DEBOUNCE_MS);
    this.debounceTimer.unref();
  }

  private async fetch(): Promise<void> {
    if (this.inFlight) return;
    if (!this.auth.isLoggedIn()) {
      // Logged out: drop any stale snapshot so the chip disappears.
      if (this.snapshotValue) {
        this.snapshotValue = null;
        this.broadcast({ type: 'usage', usage: null });
      }
      this.setAvailable(false, new Error('not logged in'));
      return;
    }
    this.inFlight = true;
    this.lastFetchAt = Date.now();
    try {
      let token = await this.auth.ensureFreshToken();
      let res = await this.hit(token);
      // A 401 despite a fresh token means the token was revoked mid-life; refresh once and retry.
      if (res.status === 401) {
        token = await this.auth.forceRefresh();
        res = await this.hit(token);
      }
      if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
      const snapshot = parseSnapshot(await res.json());
      this.failures = 0;
      this.snapshotValue = snapshot;
      this.setAvailable(true);
      this.broadcast({ type: 'usage', usage: snapshot });
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        this.snapshotValue = null;
        this.broadcast({ type: 'usage', usage: null });
        this.setAvailable(false, err);
        this.inFlight = false;
        return;
      }
      this.failures++;
      this.setAvailable(false, err);
      // Keep a stale snapshot through transient blips; hide it once clearly broken.
      if (this.snapshotValue && this.failures >= MAX_FAILURES) {
        this.snapshotValue = null;
        this.broadcast({ type: 'usage', usage: null });
      }
    } finally {
      this.inFlight = false;
    }
  }

  private hit(token: string): Promise<Response> {
    return fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  /** Log only on availability transitions, so a no-creds machine stays quiet. */
  private setAvailable(ok: boolean, err?: unknown): void {
    if (this.available === ok) return;
    this.available = ok;
    if (ok) console.log('[usage] plan usage available');
    else console.warn('[usage] unavailable:', err instanceof Error ? err.message : String(err));
  }
}
