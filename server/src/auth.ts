/**
 * App-managed Claude login via OAuth 2.0 (PKCE). Replaces the previous model of
 * inheriting the ambient Claude Code CLI login: the app runs its own authorize
 * flow, stores its own tokens under ~/.claude-ui/auth.json, refreshes them, and
 * hands the access token to the SDK (worker queries) and the usage poller.
 *
 * Uses Claude Code's public OAuth client. The manual code-paste redirect
 * (console.anthropic.com/oauth/code/callback) is used so no local port needs to
 * be registered — the consent page shows a `code#state` string to paste back.
 *
 * NOTE: this client_id / these endpoints are Claude Code's and undocumented for
 * third-party use; Anthropic can change or block them.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AuthStatus } from '@claude-ui/shared';
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

/** Thrown when a turn-starting action is attempted while logged out. */
export class AuthRequiredError extends Error {
  constructor() {
    super('Not logged in to Claude');
    this.name = 'AuthRequiredError';
  }
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
  private pendingLogin: { verifier: string; state: string } | null = null;
  private refreshInFlight: Promise<string> | null = null;
  private proactiveTimer: NodeJS.Timeout | null = null;

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
    this.pendingLogin = { verifier, state };

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
    const pending = this.pendingLogin;
    if (!pending) throw new Error('No login in progress — start again');

    const { code, state } = parsePastedCode(pasted);
    if (!code) throw new Error('Could not read the code — paste the value shown after approving');
    if (state && state !== pending.state) throw new Error('State mismatch — start the login again');

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
    this.pendingLogin = null;
    this.persistTokens(body);
    this.emitChange();
  }

  logout(): void {
    this.auth = null;
    this.store.deleteAuth();
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
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
          this.logout();
          throw new AuthRequiredError();
        }
        if (!res.ok) throw new Error(`Token refresh failed (${res.status})`);
        const body = (await res.json()) as TokenResponse;
        this.persistTokens(body);
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
    this.scheduleProactiveRefresh();
  }

  private scheduleProactiveRefresh(): void {
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    if (!this.auth) return;
    const delay = Math.max(0, this.auth.expiresAt - Date.now() - PROACTIVE_MARGIN_MS);
    this.proactiveTimer = setTimeout(() => void this.refresh().catch(() => {}), delay);
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
