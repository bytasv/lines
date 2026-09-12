/**
 * Polls ChatGPT plan usage — the same numbers chatgpt.com/codex/cloud/settings
 * /analytics#usage shows, and the same ones the Codex CLI reads for its own
 * status card.
 *
 * The OpenAI mirror of `usage.ts`, and deliberately the same shape: one poller,
 * one `UsageSnapshot`, one broadcast. The endpoint and its payload are taken from
 * the CLI's `codex-rs/backend-client` (`rate_limit_resets.rs`, `client.rs`), not
 * from documentation — none of this is a published contract, so every read here
 * is defensive and a failure only ever hides the chip.
 *
 * ## The credential, and the rule it bends
 *
 * `openaiAuth.ts` establishes that `$CODEX_HOME/auth.json` is the only store of
 * OpenAI secrets and that Lines writes it exactly once. That rule is about
 * *writing*: OpenAI rotates the refresh token on every refresh, so a second
 * writer would clobber tokens fresher than its own.
 *
 * Reading carries none of that risk, so this module reads the access token — and
 * only the access token — straight off the file, per request, never cached. The
 * consequence is that the token can be stale, because only codex refreshes it:
 * the first codex turn after an expiry refreshes the file and the next poll
 * works. Until then the endpoint answers 401 and the chip simply hides, which is
 * the correct outcome for "we cannot read your usage right now".
 */
import type { ServerMessage, UsageSnapshot, UsageWindow } from '@lines/shared';
import type { Store } from './store.ts';

/** `chatgpt.com` normalizes to `/backend-api`, and the ChatGPT path style puts the
 *  usage route under `/wham` — see `PathStyle::ChatGptApi` in the CLI. */
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const POLL_INTERVAL_MS = 5 * 60_000;
const REFRESH_DEBOUNCE_MS = 5_000;
const REFRESH_MIN_SPACING_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

/** Human label for a window the API describes only by its length. */
function windowLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Plan limit';
  const hours = Math.round(seconds / 3600);
  if (hours >= 24 * 7) return 'Weekly';
  if (hours >= 24) return `${Math.round(hours / 24)}-day`;
  return `Session (${hours}h)`;
}

/** One `RateLimitWindowSnapshot` → the shape the chip already renders. */
function toWindow(id: string, raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { used_percent?: unknown; reset_at?: unknown; limit_window_seconds?: unknown };
  if (typeof w.used_percent !== 'number') return null;
  // `reset_at` is unix seconds; the chip wants an ISO string, as Anthropic's sends.
  const resetAt = typeof w.reset_at === 'number' && w.reset_at > 0
    ? new Date(w.reset_at * 1000).toISOString()
    : null;
  return {
    id,
    utilization: w.used_percent,
    resetsAt: resetAt,
    label: windowLabel(Number(w.limit_window_seconds)),
  };
}

/**
 * Pull the windows out of a `/wham/usage` body. Tolerant of the double-optional
 * nesting the generated models use (`Option<Option<Box<…>>>` serializes as a
 * field that may be absent, null, or an object), and of extra windows arriving
 * later: unknown ones are simply not read rather than breaking the known ones.
 *
 * Throws when nothing parses, so the caller keeps its previous snapshot rather
 * than replacing it with an empty one.
 */
export function parseOpenaiUsage(body: unknown): UsageSnapshot {
  if (!body || typeof body !== 'object') throw new Error('usage response not an object');
  const payload = body as { rate_limit?: unknown; additional_rate_limits?: unknown };
  const limit = payload.rate_limit as
    | { primary_window?: unknown; secondary_window?: unknown }
    | null
    | undefined;
  const windows: UsageWindow[] = [];
  const primary = toWindow('openai_primary', limit?.primary_window);
  if (primary) windows.push(primary);
  const secondary = toWindow('openai_secondary', limit?.secondary_window);
  if (secondary) windows.push(secondary);
  if (Array.isArray(payload.additional_rate_limits)) {
    payload.additional_rate_limits.forEach((entry, i) => {
      const details = (entry as { details?: unknown } | null)?.details as
        | { primary_window?: unknown }
        | null
        | undefined;
      const extra = toWindow(`openai_additional_${i}`, details?.primary_window);
      if (extra) windows.push(extra);
    });
  }
  if (windows.length === 0) throw new Error('no usage windows in response');
  return { windows, fetchedAt: Date.now() };
}

export class OpenaiUsagePoller {
  private snapshotValue: UsageSnapshot | null = null;
  private inFlight = false;
  private lastFetchAt = 0;
  /** For logging state transitions only, so a machine with no account stays quiet. */
  private available: boolean | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private broadcast: (msg: ServerMessage) => void,
    private store: Store,
  ) {}

  get snapshot(): UsageSnapshot | null {
    return this.snapshotValue;
  }

  start(): void {
    void this.fetch();
    setInterval(() => void this.fetch(), POLL_INTERVAL_MS).unref();
  }

  /** Request a refresh soon (after a codex turn settled), debounced and spaced. */
  refreshSoon(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (Date.now() - this.lastFetchAt < REFRESH_MIN_SPACING_MS) return;
      void this.fetch();
    }, REFRESH_DEBOUNCE_MS);
    this.debounceTimer.unref();
  }

  /**
   * The access token and account id codex currently holds. Read per request and
   * never retained — see the header. Null when no account is connected, which is
   * the ordinary state for a Claude-only user.
   */
  private credentials(): { token: string; accountId?: string } | null {
    const raw = this.store.readCodexAuthRaw() as {
      tokens?: { access_token?: unknown; account_id?: unknown };
    } | null;
    const token = raw?.tokens?.access_token;
    if (typeof token !== 'string' || !token) return null;
    const accountId = raw?.tokens?.account_id;
    return { token, ...(typeof accountId === 'string' && accountId ? { accountId } : {}) };
  }

  private async fetch(): Promise<void> {
    if (this.inFlight) return;
    const creds = this.credentials();
    if (!creds) {
      // Disconnected: drop any stale snapshot so the chip disappears.
      if (this.snapshotValue) {
        this.snapshotValue = null;
        this.broadcast({ type: 'openaiUsage', usage: null });
      }
      this.setAvailable(false, new Error('no OpenAI account connected'));
      return;
    }
    this.inFlight = true;
    this.lastFetchAt = Date.now();
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          authorization: `Bearer ${creds.token}`,
          ...(creds.accountId ? { 'chatgpt-account-id': creds.accountId } : {}),
          'user-agent': 'codex-cli',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // No retry on 401, unlike the Claude poller: Lines cannot refresh this token
      // — only codex can, and it does so on its next turn. Hiding the chip until
      // then beats hammering an endpoint that will keep saying no.
      if (res.status === 401 || res.status === 403) {
        if (this.snapshotValue) {
          this.snapshotValue = null;
          this.broadcast({ type: 'openaiUsage', usage: null });
        }
        this.setAvailable(false, new Error(`${res.status} — codex will refresh its token on the next turn`));
        return;
      }
      if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
      const snapshot = parseOpenaiUsage(await res.json());
      this.snapshotValue = snapshot;
      this.setAvailable(true);
      this.broadcast({ type: 'openaiUsage', usage: snapshot });
    } catch (err) {
      // A stale snapshot survives transient failures; the chip shows its own age.
      // Only a missing account or a rejected token clears it, so `usage: null`
      // always means "no reading available", never "network hiccup".
      this.setAvailable(false, err);
    } finally {
      this.inFlight = false;
    }
  }

  private setAvailable(ok: boolean, err?: unknown): void {
    if (this.available === ok) return;
    this.available = ok;
    if (ok) console.log('[openai-usage] plan usage available');
    else console.warn('[openai-usage] unavailable:', err instanceof Error ? err.message : String(err));
  }
}
