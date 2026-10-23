/**
 * Polls Claude-plan usage (the same 5-hour / weekly windows shown by Claude
 * Code's `/usage`), plus the extra-usage block and the plan name, and broadcasts
 * snapshots to browsers.
 *
 * Auth uses the app's own login: the shared AuthManager supplies (and refreshes)
 * the OAuth access token. No login → no chip.
 */
import type { ServerMessage, UsageCredits, UsageSnapshot, UsageWindow } from '@lines/shared';
import { AuthRequiredError, type AuthManager } from './auth.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** What the CLI reads its plan from; needs the `user:profile` scope Lines already requests. */
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const OAUTH_BETA = 'oauth-2025-04-20';

const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes, like ClaudeUsageBar
const REFRESH_DEBOUNCE_MS = 5_000; // coalesce bursts of turn-complete refreshes
const REFRESH_MIN_SPACING_MS = 30_000; // never hit the endpoint more than this often
const FETCH_TIMEOUT_MS = 10_000;
/** Refetch this long after a window's `resetsAt`, so the API has rolled it over. */
const RESET_GRACE_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The plan changes on an upgrade, not per turn — an hourly re-read is plenty. */
const PLAN_TTL_MS = 60 * 60_000;

/** Known window keys in display order; the parser also picks up unknown ones defensively. */
const KNOWN_WINDOWS = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus'];

/**
 * Top-level keys that are not windows even though some carry a numeric
 * `utilization` — `extra_usage` does once enabled, and used to surface as a bogus
 * "extra usage" window.
 */
const NON_WINDOW_KEYS = new Set(['extra_usage', 'limits']);

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * The `extra_usage` block → `UsageCredits`. Money is in minor units of
 * `currency`, as the API sends it. `monthly_limit: null` while enabled means no
 * cap. Undefined when the block is absent or not an object.
 */
export function parseExtraUsage(record: Record<string, unknown>): UsageCredits | undefined {
  const raw = record.extra_usage;
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  const enabled = e.is_enabled === true;
  const credits: UsageCredits = { enabled };
  if (enabled && e.monthly_limit === null) credits.unlimited = true;
  const limit = num(e.monthly_limit);
  if (limit !== undefined) credits.limitMinor = limit;
  const used = num(e.used_credits);
  if (used !== undefined) credits.usedMinor = used;
  const util = num(e.utilization);
  if (util !== undefined) credits.utilization = util;
  if (typeof e.currency === 'string' && e.currency) credits.currency = e.currency;
  if (typeof e.disabled_reason === 'string' && e.disabled_reason) credits.disabledReason = e.disabled_reason;
  return credits;
}

/**
 * A non-ok usage response. Carries the status and, on a 429, how long the
 * endpoint asked us to wait — the message names both so the log says why.
 */
class UsageHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(
      `usage endpoint ${status}${retryAfterMs !== null ? ` (retry-after ${Math.round(retryAfterMs / 1000)})` : ''}`,
    );
  }
}

/** `retry-after` as milliseconds: delta-seconds or an HTTP date. Null when absent or unparsable. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Extract usage windows tolerantly, surviving additive shape drift. Throws if none parse. */
export function parseSnapshot(body: unknown): UsageSnapshot {
  if (!body || typeof body !== 'object') throw new Error('usage response not an object');
  const record = body as Record<string, unknown>;
  const seen = new Set<string>();
  const windows: UsageWindow[] = [];
  const consider = (id: string) => {
    if (seen.has(id) || NON_WINDOW_KEYS.has(id)) return;
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
  const credits = parseExtraUsage(record);
  return { windows, fetchedAt: Date.now(), ...(credits ? { credits } : {}) };
}

const ORG_TYPE_LABELS: Record<string, string> = {
  claude_pro: 'Pro',
  claude_max: 'Max',
  claude_team: 'Team',
  claude_enterprise: 'Enterprise',
};

const titleCase = (s: string): string =>
  s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

/**
 * Plan label from an `/api/oauth/profile` body: `organization.organization_type`
 * names the plan, and for Max `rate_limit_tier` (e.g. `default_claude_max_20x`)
 * carries the multiplier. Undefined when the profile names no plan.
 */
export function planLabelFromProfile(body: unknown): string | undefined {
  const org = (body as { organization?: unknown } | null)?.organization as
    | { organization_type?: unknown; rate_limit_tier?: unknown }
    | null
    | undefined;
  const type = typeof org?.organization_type === 'string' ? org.organization_type : '';
  if (!type) return undefined;
  const base = ORG_TYPE_LABELS[type] ?? titleCase(type.replace(/^claude_/, ''));
  if (type === 'claude_max' && typeof org?.rate_limit_tier === 'string') {
    const multiplier = /(\d+)x$/.exec(org.rate_limit_tier)?.[1];
    if (multiplier) return `${base} ${multiplier}x`;
  }
  return base;
}

export class UsagePoller {
  private snapshotValue: UsageSnapshot | null = null;
  private inFlight = false;
  private lastFetchAt = 0;
  private available: boolean | null = null; // for logging state transitions only
  /** Last failure message logged, so a repeat stays quiet but a new cause shows up. */
  private lastFailure: string | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  /** A 429 asked us to wait: no request before this (epoch ms). */
  private nextAllowedAt = 0;
  /** One-shot refetch right after the earliest window rolls over. */
  private resetTimer: NodeJS.Timeout | null = null;
  /** `five_hour` arriving without `resets_at` is logged once, raw, for diagnosis. */
  private warnedNullReset = false;
  /** Last plan label read off the profile, and when — see PLAN_TTL_MS. */
  private plan: { label: string | undefined; at: number } | null = null;

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
    if (Date.now() < this.nextAllowedAt) return; // rate-limited: a turn must not extend it
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.fetchSpaced();
    }, REFRESH_DEBOUNCE_MS);
    this.debounceTimer.unref();
  }

  /** `fetch()` unless the endpoint was hit within REFRESH_MIN_SPACING_MS. */
  private fetchSpaced(): void {
    if (Date.now() - this.lastFetchAt < REFRESH_MIN_SPACING_MS) return;
    void this.fetch();
  }

  /**
   * Refetch once, RESET_GRACE_MS after the earliest future `resetsAt`, so the
   * chip moves on right after a window rolls over instead of at the next poll.
   */
  private scheduleResetRefetch(snapshot: UsageSnapshot): void {
    this.clearResetTimer();
    const now = Date.now();
    const next = snapshot.windows
      .map((w) => (w.resetsAt ? new Date(w.resetsAt).getTime() : NaN))
      .filter((t) => Number.isFinite(t) && t > now)
      .reduce((a, b) => Math.min(a, b), Infinity);
    if (!Number.isFinite(next)) return;
    // Capped: Node fires an over-int32 delay immediately; an early refetch just reschedules.
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      this.fetchSpaced();
    }, Math.min(next - now + RESET_GRACE_MS, MAX_TIMER_MS));
    this.resetTimer.unref();
  }

  private clearResetTimer(): void {
    if (!this.resetTimer) return;
    clearTimeout(this.resetTimer);
    this.resetTimer = null;
  }

  private async fetch(): Promise<void> {
    if (this.inFlight) return;
    if (!this.auth.isLoggedIn()) {
      // Logged out: drop any stale snapshot so the chip disappears.
      this.plan = null;
      this.clearResetTimer();
      if (this.snapshotValue) {
        this.snapshotValue = null;
        this.broadcast({ type: 'usage', usage: null });
      }
      this.setAvailable(false, new Error('not logged in'));
      return;
    }
    if (Date.now() < this.nextAllowedAt) return; // honouring a 429's retry-after
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
      if (!res.ok) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        if (res.status === 429) this.nextAllowedAt = Date.now() + (retryAfterMs ?? POLL_INTERVAL_MS);
        throw new UsageHttpError(res.status, retryAfterMs);
      }
      const body = await res.json();
      const snapshot = parseSnapshot(body);
      this.warnIfNoFiveHourReset(body, snapshot);
      const plan = await this.planLabel(token);
      if (plan) snapshot.plan = plan;
      this.snapshotValue = snapshot;
      this.setAvailable(true);
      this.broadcast({ type: 'usage', usage: snapshot });
      this.scheduleResetRefetch(snapshot);
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        this.plan = null;
        this.clearResetTimer();
        this.snapshotValue = null;
        this.broadcast({ type: 'usage', usage: null });
        this.setAvailable(false, err);
        this.inFlight = false;
        return;
      }
      // A stale snapshot survives transient failures — the UI shows staleness via
      // `fetchedAt` ("Updated Xm ago"). Only logout / AuthRequiredError hides the chip,
      // so a `usage: null` broadcast always means "auth gone", never "network hiccup".
      this.setAvailable(false, err);
    } finally {
      this.inFlight = false;
    }
  }

  private hit(token: string, url = USAGE_URL): Promise<Response> {
    return fetch(url, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  /**
   * The plan label, cached for PLAN_TTL_MS. Never throws: a profile failure (a
   * 403 on an old login without `user:profile`, a network blip) keeps the cached
   * label, or leaves the plan absent — it never fails the usage poll.
   */
  private async planLabel(token: string): Promise<string | undefined> {
    if (this.plan && Date.now() - this.plan.at < PLAN_TTL_MS) return this.plan.label;
    try {
      const res = await this.hit(token, PROFILE_URL);
      if (!res.ok) throw new Error(`profile endpoint ${res.status}`);
      this.plan = { label: planLabelFromProfile(await res.json()), at: Date.now() };
      return this.plan.label;
    } catch {
      return this.plan?.label;
    }
  }

  /** The API's semantics for a null `five_hour.resets_at` are unknown; log the raw window once. */
  private warnIfNoFiveHourReset(body: unknown, snapshot: UsageSnapshot): void {
    if (this.warnedNullReset) return;
    const five = snapshot.windows.find((w) => w.id === 'five_hour');
    if (!five || five.resetsAt !== null) return;
    this.warnedNullReset = true;
    console.warn('[usage] five_hour without resets_at', JSON.stringify((body as Record<string, unknown>).five_hour));
  }

  /**
   * Successes log only on the transition back to available; failures log once
   * per distinct message, so a no-creds machine stays quiet but a 401 turning
   * into a 429 still shows up.
   */
  private setAvailable(ok: boolean, err?: unknown): void {
    const wasAvailable = this.available;
    this.available = ok;
    if (ok) {
      this.lastFailure = null;
      if (wasAvailable !== true) console.log('[usage] plan usage available');
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message === this.lastFailure) return;
    this.lastFailure = message;
    console.warn('[usage] unavailable:', message);
  }
}
