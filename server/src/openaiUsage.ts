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
 * Read from the payload: both main windows (`rate_limit.primary_window` /
 * `secondary_window`), per-model caps (`additional_rate_limits[].rate_limit`),
 * the live `plan_type` (which beats the plan stored at login — that one goes
 * stale on an upgrade), `credits`, whether the limit is hit right now
 * (`rate_limit.limit_reached` / `allowed`), and how many rate-limit reset
 * credits the account holds (`rate_limit_reset_credits.available_count`).
 *
 * Redeeming a reset credit is the one write, and it goes through
 * `codex app-server` rather than raw HTTP — see `consumeResetCredit`.
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
import { randomUUID } from 'node:crypto';
import type {
  CodexCliStatus,
  ResetCreditOutcome,
  ServerMessage,
  UsageCredits,
  UsageSnapshot,
  UsageWindow,
} from '@lines/shared';
import { CodexAppServer, CodexRpcError } from './codexAppServer.ts';
import { codexCliStatus } from './codexCli.ts';
import type { Store } from './store.ts';

/** `chatgpt.com` normalizes to `/backend-api`, and the ChatGPT path style puts the
 *  usage route under `/wham` — see `PathStyle::ChatGptApi` in the CLI. */
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const POLL_INTERVAL_MS = 5 * 60_000;
const REFRESH_DEBOUNCE_MS = 5_000;
const REFRESH_MIN_SPACING_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
/** One redeem attempt, app-server spawn and handshake included. */
const CONSUME_TIMEOUT_MS = 20_000;

/** Human label for a window the API describes only by its length. */
function windowLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Plan limit';
  const hours = Math.round(seconds / 3600);
  if (hours >= 24 * 7 && hours < 24 * 8) return 'Weekly limit';
  if (hours >= 24) return `${Math.round(hours / 24)}-day limit`;
  return `${hours}-hour limit`;
}

/** One `RateLimitWindowSnapshot` → the shape the chip already renders. */
function toWindow(id: string, raw: unknown, fetchedAt: number, prefix?: string): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as {
    used_percent?: unknown;
    reset_at?: unknown;
    reset_after_seconds?: unknown;
    limit_window_seconds?: unknown;
  };
  if (typeof w.used_percent !== 'number') return null;
  // `reset_at` is unix seconds; the chip wants an ISO string, as Anthropic's sends.
  // Without it, `reset_after_seconds` is relative to this fetch.
  let resetAt: string | null = null;
  if (typeof w.reset_at === 'number' && w.reset_at > 0) {
    resetAt = new Date(w.reset_at * 1000).toISOString();
  } else if (typeof w.reset_after_seconds === 'number' && w.reset_after_seconds > 0) {
    resetAt = new Date(fetchedAt + w.reset_after_seconds * 1000).toISOString();
  }
  const label = windowLabel(Number(w.limit_window_seconds));
  return {
    id,
    utilization: w.used_percent,
    resetsAt: resetAt,
    label: prefix ? `${prefix} · ${label}` : label,
  };
}

/** `PlanType` values (shared/codexProtocol/PlanType.ts) → display names. */
const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Team',
  business: 'Business',
};

/** Display name for a ChatGPT plan id; unknown ids are title-cased rather than dropped. */
export function openaiPlanLabel(plan: unknown): string | undefined {
  if (typeof plan !== 'string' || !plan) return undefined;
  const key = plan.toLowerCase();
  if (PLAN_LABELS[key]) return PLAN_LABELS[key];
  if (key.startsWith('enterprise')) return 'Enterprise';
  if (key.startsWith('edu')) return 'Edu';
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const finiteNumber = (v: unknown): number | undefined => {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  if (typeof v === 'string' && !v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** The `credits` block → `UsageCredits`; undefined when absent or not an object. */
function parseCredits(raw: unknown): UsageCredits | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const credits: UsageCredits = { enabled: c.has_credits === true };
  if (c.unlimited === true) credits.unlimited = true;
  // A string in the API, sometimes with decimals.
  const balance = finiteNumber(c.balance);
  if (balance !== undefined) credits.balance = balance;
  const local = finiteNumber(c.approx_local_messages);
  if (local !== undefined) credits.approxLocalMessages = local;
  const cloud = finiteNumber(c.approx_cloud_messages);
  if (cloud !== undefined) credits.approxCloudMessages = cloud;
  if (c.overage_limit_reached === true) credits.exhausted = true;
  return credits;
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
  const payload = body as {
    plan_type?: unknown;
    rate_limit?: unknown;
    additional_rate_limits?: unknown;
    credits?: unknown;
    rate_limit_reset_credits?: unknown;
  };
  const fetchedAt = Date.now();
  const limit = payload.rate_limit as
    | { allowed?: unknown; limit_reached?: unknown; primary_window?: unknown; secondary_window?: unknown }
    | null
    | undefined;
  const windows: UsageWindow[] = [];
  const primary = toWindow('openai_primary', limit?.primary_window, fetchedAt);
  if (primary) windows.push(primary);
  const secondary = toWindow('openai_secondary', limit?.secondary_window, fetchedAt);
  if (secondary) windows.push(secondary);
  if (Array.isArray(payload.additional_rate_limits)) {
    payload.additional_rate_limits.forEach((entry, i) => {
      const e = entry as { limit_name?: unknown; rate_limit?: unknown; details?: unknown } | null;
      // `rate_limit` is the field; `details` is what an earlier reading assumed,
      // kept as a fallback in case a backend still sends it.
      const inner = (e?.rate_limit ?? e?.details) as { primary_window?: unknown } | null | undefined;
      const name = typeof e?.limit_name === 'string' && e.limit_name ? e.limit_name : undefined;
      const extra = toWindow(`openai_additional_${i}`, inner?.primary_window, fetchedAt, name);
      if (extra) windows.push(extra);
    });
  }
  if (windows.length === 0) throw new Error('no usage windows in response');

  const snapshot: UsageSnapshot = { windows, fetchedAt };
  const plan = openaiPlanLabel(payload.plan_type);
  if (plan) snapshot.plan = plan;
  const credits = parseCredits(payload.credits);
  if (credits) snapshot.credits = credits;
  if (limit?.limit_reached === true || limit?.allowed === false) snapshot.limitReached = true;
  const resets = payload.rate_limit_reset_credits as
    | { available_count?: unknown; applicable_available_count?: unknown }
    | null
    | undefined;
  const available = finiteNumber(resets?.available_count);
  if (available !== undefined && available > 0) {
    snapshot.resetCreditsAvailable = available;
    const applicable = finiteNumber(resets?.applicable_available_count);
    if (applicable !== undefined && applicable >= 0) snapshot.resetCreditsApplicable = applicable;
  }
  return snapshot;
}

/**
 * Whether the 5-hour (primary) window should be treated as informational.
 *
 * Neither the payload nor the plan says whether that window is enforced: Pro and
 * Premium Business seats have none, Plus and Standard Business do, and a
 * workspace with credits keeps working past it. The only evidence is what
 * happens at 100%, so the verdict is learnt and remembered:
 *
 * - at or past 100% while usage is still allowed: it does not block → soft;
 * - at or past 100% while blocked, and the weekly window is not also full: the
 *   5-hour window is what blocked → enforced again.
 *
 * Anything else keeps the previous verdict.
 */
export function nextSoftPrimary(previous: boolean, snapshot: UsageSnapshot): boolean {
  const primary = snapshot.windows.find((w) => w.id === 'openai_primary');
  if (!primary || primary.utilization < 100) return previous;
  if (!snapshot.limitReached) return true;
  const secondary = snapshot.windows.find((w) => w.id === 'openai_secondary');
  if (!secondary || secondary.utilization < 100) return false;
  return previous;
}

/** The slice of `CodexAppServer` a reset-credit redeem needs — the test seam. */
export interface ResetCreditRpc {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface OpenaiUsageDeps {
  codexStatus?: () => CodexCliStatus;
  createAppServer?: (options: { codexPath: string; codexHome: string }) => ResetCreditRpc;
  consumeTimeoutMs?: number;
}

const CODEX_OUTCOMES = new Set<ResetCreditOutcome>(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);

/** A throwaway app-server for one request; nothing it does should ask anything of us. */
function spawnAppServer(options: { codexPath: string; codexHome: string }): ResetCreditRpc {
  const app: CodexAppServer = new CodexAppServer({
    ...options,
    onNotification: () => {},
    onServerRequest: (id) => app.respondError(id, 'not supported'),
    onExit: () => {},
  });
  return app;
}

/** Rejects after `ms`, so a hung app-server cannot hold the consume lock forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out waiting for codex')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class OpenaiUsagePoller {
  private snapshotValue: UsageSnapshot | null = null;
  private inFlight = false;
  private lastFetchAt = 0;
  /** For logging state transitions only, so a machine with no account stays quiet. */
  private available: boolean | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  /** One redeem at a time — a double click must not spend two credits. */
  private consuming = false;
  /** Last soft-primary verdict, for when there is no account file to keep it in. */
  private softPrimary = false;

  constructor(
    private broadcast: (msg: ServerMessage) => void,
    private store: Store,
    private deps: OpenaiUsageDeps = {},
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
      this.softPrimary = false;
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
      const account = this.store.loadOpenaiAccount();
      // The live plan_type wins; the plan stored at login is only the fallback.
      if (!snapshot.plan) {
        const stored = openaiPlanLabel(account?.plan);
        if (stored) snapshot.plan = stored;
      }
      // Remembered across restarts in the account file, so a new login (maybe a
      // different plan) starts from "enforced" again.
      const previous = account ? account.softPrimaryWindow === true : this.softPrimary;
      const soft = nextSoftPrimary(previous, snapshot);
      this.softPrimary = soft;
      if (account && soft !== previous) {
        this.store.saveOpenaiAccount({ ...account, softPrimaryWindow: soft || undefined });
      }
      if (soft) {
        const primary = snapshot.windows.find((w) => w.id === 'openai_primary');
        if (primary) primary.soft = true;
      }
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

  /**
   * Redeem one rate-limit reset credit on the connected account.
   *
   * Goes through a short-lived `codex app-server` rather than POSTing to
   * `/wham/rate-limit-reset-credits/consume` directly: codex refreshes an expired
   * token itself, which keeps it the only writer of `auth.json`, and its typed
   * request saves guessing the endpoint's body. One idempotency key per click,
   * reused only for a transport retry — a fresh key could spend a second credit.
   */
  async consumeResetCredit(): Promise<{ outcome: ResetCreditOutcome; message?: string }> {
    if (this.consuming) return { outcome: 'error', message: 'A reset is already in progress.' };
    const status = (this.deps.codexStatus ?? codexCliStatus)();
    if (status.state !== 'ok' || !status.path) {
      return { outcome: 'error', message: 'Codex CLI not installed.' };
    }
    const codexPath = status.path;
    this.consuming = true;
    const idempotencyKey = randomUUID();
    try {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await this.consumeOnce(codexPath, idempotencyKey);
          if (result === 'reset') {
            // Straight away, not debounced: every tab should see the cleared window.
            this.lastFetchAt = 0;
            await this.fetch();
          }
          return { outcome: result };
        } catch (err) {
          lastErr = err;
          // The server answered and said no: retrying cannot change that.
          if (err instanceof CodexRpcError) break;
        }
      }
      return { outcome: 'error', message: lastErr instanceof Error ? lastErr.message : String(lastErr) };
    } finally {
      this.consuming = false;
    }
  }

  private async consumeOnce(codexPath: string, idempotencyKey: string): Promise<ResetCreditOutcome> {
    const options = { codexPath, codexHome: this.store.codexHome() };
    const server = this.deps.createAppServer?.(options) ?? spawnAppServer(options);
    try {
      const res = (await withTimeout(
        server.request('account/rateLimitResetCredit/consume', { idempotencyKey }),
        this.deps.consumeTimeoutMs ?? CONSUME_TIMEOUT_MS,
      )) as { outcome?: unknown } | null;
      const outcome = res?.outcome;
      if (typeof outcome === 'string' && CODEX_OUTCOMES.has(outcome as ResetCreditOutcome)) {
        return outcome as ResetCreditOutcome;
      }
      throw new CodexRpcError(`unexpected outcome: ${String(outcome)}`, -32603);
    } finally {
      server.close();
    }
  }

  private setAvailable(ok: boolean, err?: unknown): void {
    if (this.available === ok) return;
    this.available = ok;
    if (ok) console.log('[openai-usage] plan usage available');
    else console.warn('[openai-usage] unavailable:', err instanceof Error ? err.message : String(err));
  }
}
