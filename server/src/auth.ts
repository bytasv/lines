/**
 * App-managed Claude login via OAuth 2.0 (PKCE). Replaces the ambient Claude
 * Code CLI login outright: the app runs its own authorize flow, stores its own
 * tokens under ~/.lines-app/auth.json, refreshes them, and hands the access
 * token to the SDK (worker queries) and the usage poller. The ambient
 * ~/.claude login is never a fallback — it is a separate token store this app
 * cannot refresh, so a stale one 401s every turn forever. A turn that cannot
 * get an app token is refused instead (see SessionManager.pushTurn).
 *
 * Uses Claude Code's public OAuth client. The manual code-paste redirect
 * (console.anthropic.com/oauth/code/callback) is used so no local port needs to
 * be registered — the consent page shows a `code#state` string to paste back.
 *
 * NOTE: this client_id / these endpoints are Claude Code's and undocumented for
 * third-party use; Anthropic can change or block them.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AuthStatus } from '@lines/shared';
import type { Store, StoredAuth } from './store.ts';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

/** Refresh when the access token is within this window of expiring. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Proactive refresh timer fires this long before expiry. */
const PROACTIVE_MARGIN_MS = 60 * 60_000;
/** First retry delay after a proactive refresh fails transiently. */
const PROACTIVE_RETRY_MS = 60_000;
/** Ceiling for the proactive-refresh retry backoff. */
const PROACTIVE_RETRY_CAP_MS = 15 * 60_000;
/** How long an unfinished login stays completable. Generous: the user has to
 *  leave the app, approve in a browser, and paste the result back. */
const PENDING_LOGIN_TTL_MS = 30 * 60_000;

/** Thrown when a turn-starting action is attempted while logged out. */
export class AuthRequiredError extends Error {
  constructor() {
    super('Not logged in to Claude');
    this.name = 'AuthRequiredError';
  }
}

/**
 * Error text that means "the API rejected our token", as opposed to a network
 * blip or an ordinary tool failure. Matched against SDK/CLI error strings, which
 * are not a published contract — a wording change degrades this to today's
 * behaviour (no login prompt until the usage poller notices), never to worse.
 * Kept deliberately narrow: a false positive forces a refresh on a healthy session.
 */
const AUTH_FAILURE_PATTERNS = [
  /invalid_grant/i,
  /authentication_error/i,
  /invalid bearer token/i,
  /oauth authentication failed/i,
  /\boauth\b[^.\n]*\btoken\b[^.\n]*\bexpired\b/i,
  /\b401\b[^\n]*\bunauthorized\b/i,
  /\bunauthorized\b[^\n]*\b401\b/i,
  /please run \/login/i,
  /re-?authenticate to continue/i,
];

export function isAuthFailureMessage(message: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(message));
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  account?: { email_address?: string };
  organization?: { name?: string };
}

export class AuthManager {
  private auth: StoredAuth | null;
  /**
   * In-flight logins, keyed by their OAuth `state`. A map rather than a single
   * slot because two logins can overlap — two browser tabs today, two paired
   * devices later — and a second startLogin would otherwise overwrite the first
   * one's PKCE verifier, making the first paste fail with a confusing
   * state-mismatch. Never persisted: the verifier staying in memory is what
   * makes an intercepted authorization code useless.
   */
  private pendingLogins = new Map<string, { verifier: string; state: string; startedAt: number }>();
  private refreshInFlight: Promise<string> | null = null;
  private proactiveTimer: NodeJS.Timeout | null = null;
  /** Current proactive-retry backoff, null while the ladder is unclimbed. */
  private proactiveBackoffMs: number | null = null;

  /** Wired by index.ts: fires on any login/logout/refresh so the bridge can broadcast + recycle. */
  onChange: ((status: AuthStatus) => void) | null = null;
  /** Wired by index.ts: fires after a token refresh so idle worker queries can be recycled. */
  onRefresh: (() => void) | null = null;

  constructor(private store: Store) {
    this.auth = store.loadAuth();
    if (this.auth) this.scheduleProactiveRefresh();
  }

  getStatus(): AuthStatus {
    if (!this.auth) return { loggedIn: false };
    return { loggedIn: true, account: this.auth.account };
  }

  isLoggedIn(): boolean {
    return this.auth !== null;
  }

  /** Build the authorize URL and stash the PKCE verifier + state for completion. */
  startLogin(): { authorizeUrl: string } {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(32));
    // Drop logins the user clearly abandoned, so a long-lived bridge doesn't
    // accumulate verifiers for approvals that never happened.
    for (const [key, p] of this.pendingLogins) {
      if (Date.now() - p.startedAt > PENDING_LOGIN_TTL_MS) this.pendingLogins.delete(key);
    }
    this.pendingLogins.set(state, { verifier, state, startedAt: Date.now() });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('code', 'true');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return { authorizeUrl: url.toString() };
  }

  /** Exchange a pasted `code#state` (or full callback URL) for tokens. */
  async completeLogin(pasted: string): Promise<void> {
    if (!this.pendingLogins.size) throw new Error('No login in progress — start again');

    const { code, state } = parsePastedCode(pasted);
    if (!code) throw new Error('Could not read the code — paste the value shown after approving');
    // With a state we can name the exact login this paste belongs to. Without
    // one (the paste carried no `#state`) fall back to the newest in-flight
    // login, which is what a single-slot implementation effectively did.
    // Newest = last inserted; Map preserves insertion order, and two logins
    // started in the same millisecond make startedAt useless for ordering.
    const pending = state
      ? this.pendingLogins.get(state)
      : [...this.pendingLogins.values()].at(-1);
    if (!pending) throw new Error('State mismatch — start the login again');

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        state: pending.state,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: pending.verifier,
      }),
    });
    if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
    const body = (await res.json()) as TokenResponse;
    // We are signed in now, so every other in-flight attempt is moot.
    this.pendingLogins.clear();
    this.persistTokens(body);
    this.emitChange();
  }

  logout(): void {
    this.auth = null;
    this.store.deleteAuth();
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
    this.proactiveBackoffMs = null;
    this.emitChange();
  }

  /** In-memory access token if present and not within the refresh margin; else null. */
  getAccessTokenSync(): string | null {
    if (!this.auth) return null;
    if (this.auth.expiresAt - Date.now() < REFRESH_MARGIN_MS) return null;
    return this.auth.accessToken;
  }

  /** Return a valid access token, refreshing if near expiry. Throws AuthRequiredError if logged out. */
  async ensureFreshToken(): Promise<string> {
    if (!this.auth) throw new AuthRequiredError();
    if (this.auth.expiresAt - Date.now() >= REFRESH_MARGIN_MS) return this.auth.accessToken;
    return this.refresh();
  }

  /**
   * A turn was rejected by the API. Try exactly one refresh: a merely-expired
   * access token recovers silently (onRefresh recycles idle queries), while a
   * dead refresh token makes refresh() self-logout, which broadcasts
   * `authStatus { loggedIn: false }` and opens the browser's login modal.
   * Single-flight comes free from refresh(), so N sessions failing at once
   * cause one token request.
   */
  async handleTokenRejected(): Promise<void> {
    if (!this.isLoggedIn()) return;
    try {
      await this.forceRefresh();
    } catch (err) {
      // 400/401 already self-logged-out and broadcast; anything else (5xx,
      // offline) leaves us logged in with a token the API rejects — log it and
      // let the next turn's ensureFreshToken surface the reason to the user.
      if (!(err instanceof AuthRequiredError)) console.warn('[auth] recovery refresh failed:', err);
    }
  }

  /** Force a refresh regardless of expiry (used after a 401 from the usage endpoint). */
  async forceRefresh(): Promise<string> {
    if (!this.auth) throw new AuthRequiredError();
    return this.refresh();
  }

  /** Single-flight refresh: rotated refresh tokens make a lost race fatal, so never run two. */
  private refresh(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refreshToken = this.auth?.refreshToken;
    if (!refreshToken) return Promise.reject(new AuthRequiredError());

    this.refreshInFlight = (async () => {
      try {
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
          }),
        });
        if (res.status === 400 || res.status === 401) {
          // invalid_grant: refresh token is dead — treat as logged out.
          console.warn('[auth] refresh token rejected — signed out');
          this.logout();
          throw new AuthRequiredError();
        }
        if (!res.ok) {
          console.warn(`[auth] token refresh failed (${res.status})`);
          throw new Error(`Token refresh failed (${res.status})`);
        }
        const body = (await res.json()) as TokenResponse;
        this.persistTokens(body);
        console.log('[auth] token refreshed');
        this.onRefresh?.();
        return body.access_token;
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private persistTokens(body: TokenResponse): void {
    const prev = this.auth;
    this.auth = {
      version: 1,
      accessToken: body.access_token,
      // Refresh-token rotation: keep the previous one if the response omitted it.
      refreshToken: body.refresh_token ?? prev?.refreshToken ?? '',
      expiresAt: Date.now() + body.expires_in * 1000,
      scopes: body.scope ? body.scope.split(' ') : (prev?.scopes ?? []),
      account: extractAccount(body) ?? prev?.account,
    };
    this.store.saveAuth(this.auth);
    // A recovery resets the backoff ladder for the next expiry window.
    this.proactiveBackoffMs = null;
    this.scheduleProactiveRefresh();
  }

  private scheduleProactiveRefresh(delayMs?: number): void {
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    if (!this.auth) return;
    const delay = delayMs ?? Math.max(0, this.auth.expiresAt - Date.now() - PROACTIVE_MARGIN_MS);
    this.proactiveTimer = setTimeout(() => {
      void this.refresh().catch(() => {
        // Transient (offline at wake, 5xx): retry with backoff rather than let
        // the token rot until a turn 401s. A dead refresh token already logged
        // out, which cleared this.auth and stops the chain.
        if (!this.auth) return;
        this.proactiveBackoffMs =
          this.proactiveBackoffMs === null
            ? PROACTIVE_RETRY_MS
            : Math.min(this.proactiveBackoffMs * 2, PROACTIVE_RETRY_CAP_MS);
        console.warn(`[auth] proactive refresh failed, retrying in ${this.proactiveBackoffMs / 1000}s`);
        this.scheduleProactiveRefresh(this.proactiveBackoffMs);
      });
    }, delay);
    this.proactiveTimer.unref();
  }

  private emitChange(): void {
    this.onChange?.(this.getStatus());
  }
}

/** Pull email/org out of the token response, if present. */
function extractAccount(body: TokenResponse): { email?: string; organization?: string } | undefined {
  const email = body.account?.email_address;
  const organization = body.organization?.name;
  if (!email && !organization) return undefined;
  return { email, organization };
}

/** Parse a pasted `code#state`, a bare code, or a full callback URL into its parts. */
function parsePastedCode(pasted: string): { code: string; state: string | null } {
  const trimmed = pasted.trim();
  // Full URL form: ...?code=...&state=...
  if (trimmed.startsWith('http')) {
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state');
      return { code, state };
    } catch {
      // fall through to the fragment parse
    }
  }
  // `code#state` form shown on the consent page.
  const [code, state] = trimmed.split('#');
  return { code: code ?? '', state: state ?? null };
}
