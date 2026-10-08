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
  private debounceTimer: NodeJS.Timeout | null = null;
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
      this.plan = null;
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
      const plan = await this.planLabel(token);
      if (plan) snapshot.plan = plan;
      this.snapshotValue = snapshot;
      this.setAvailable(true);
      this.broadcast({ type: 'usage', usage: snapshot });
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        this.plan = null;
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

  /** Log only on availability transitions, so a no-creds machine stays quiet. */
  private setAvailable(ok: boolean, err?: unknown): void {
    if (this.available === ok) return;
    this.available = ok;
    if (ok) console.log('[usage] plan usage available');
    else console.warn('[usage] unavailable:', err instanceof Error ? err.message : String(err));
  }
}
