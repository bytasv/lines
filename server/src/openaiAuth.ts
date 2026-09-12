/**
 * App-managed OpenAI (ChatGPT) login, so a session can run on a Codex model.
 *
 * Shaped like `auth.ts` — `getStatus()`, `isLoggedIn()`, `startLogin()`,
 * `cancelLogin()`, `logout()`, `onChange` — with one deliberate difference: there
 * is **no refresh machinery here at all**.
 *
 * OpenAI rotates the refresh token on every refresh, and every `codex exec` child
 * may refresh. So a second, Lines-held copy of the tokens would be invalidated by
 * the first codex-side refresh, and a Lines write would clobber tokens fresher
 * than ours mid-session. The rule that follows:
 *
 *   **`$CODEX_HOME/auth.json` is the only store of OpenAI secrets.** Lines writes
 *   it exactly once, at login completion, and never again; codex refreshes it from
 *   then on. Logout deletes it.
 *
 * There is no `ensureFreshToken`, no single-flight refresh, and no `queryTokens`
 * analogue on the codex path — a codex turn carries no credential, it carries a
 * `CODEX_HOME`.
 *
 * The flow is a device code rather than a redirect because Lines binds ephemeral
 * ports and the browser completing a login is frequently not on the bridge's
 * machine (the same constraint the MCP connections feature already documents for
 * its loopback callback).
 *
 * NOTE: this client_id and these endpoints are the Codex CLI's own and are
 * undocumented for third-party use; OpenAI can change or block them. The
 * full-parity roadmap retires this module in favour of `codex app-server`'s own
 * `LoginAccountParams`, which is the main reason not to over-invest here.
 */
import type { AuthStatus } from '@lines/shared';
import type { Store, StoredOpenaiAccount } from './store.ts';

/**
 * Every constant and request shape below is taken from the Codex CLI's own
 * `codex-rs/login` (`auth/manager.rs`, `device_code_auth.rs`, `server.rs`) rather
 * than from documentation — none of this is a published contract.
 */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE = 'https://auth.openai.com';
const USERCODE_URL = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const REVOKE_URL = `${AUTH_BASE}/oauth/revoke`;
/** Honoured verbatim by the token endpoint for a device-code grant. */
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;

/** Where the user types the code. Shown in the modal and opened in a tab. */
export const OPENAI_VERIFICATION_URL = `${AUTH_BASE}/codex/device`;

/** Fallback poll spacing when the server names none. */
const DEFAULT_POLL_INTERVAL_S = 5;
/** Hard ceiling on one login attempt. Device codes expire well inside this; the
 *  budget is what stops an abandoned login polling until the bridge restarts. */
const LOGIN_TTL_MS = 15 * 60_000;

/** Thrown when a codex turn is attempted with no connected OpenAI account. */
export class OpenaiAuthRequiredError extends Error {
  constructor() {
    super('No OpenAI account connected');
    this.name = 'OpenaiAuthRequiredError';
  }
}

/** What `pushTurn` says when there is no account to run a codex turn with. */
export const OPENAI_CONNECT_MESSAGE =
  'No OpenAI account is connected. Connect one in Settings → Account, then Retry.';

interface PendingLogin {
  deviceAuthId: string;
  /** Sent on every poll, not just displayed: the poll body is
   *  `{device_auth_id, user_code}`. */
  userCode: string;
  intervalMs: number;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  /** Bumped by cancel/restart so a poll in flight knows it no longer owns the flow. */
  epoch: number;
}

/** Claims we read off the `id_token`; everything else is ignored. */
interface IdTokenClaims {
  email?: string;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
}

/** Decode a JWT payload without verifying it. Safe here: the token came straight
 *  from the token endpoint over TLS, and the claims are used for display only. */
export function decodeIdTokenClaims(idToken: string): IdTokenClaims | null {
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as IdTokenClaims;
  } catch {
    return null;
  }
}

/** The non-secret record the account row renders from. */
export function accountFromIdToken(idToken: string): StoredOpenaiAccount {
  const claims = decodeIdTokenClaims(idToken);
  const auth = claims?.['https://api.openai.com/auth'];
  return {
    version: 1,
    ...(claims?.email ? { email: claims.email } : {}),
    ...(auth?.chatgpt_plan_type ? { plan: auth.chatgpt_plan_type } : {}),
    ...(auth?.chatgpt_account_id ? { accountId: auth.chatgpt_account_id } : {}),
    connectedAt: Date.now(),
  };
}

/**
 * The grant a successful device-auth poll yields. It carries the PKCE pair the
 * *server* generated — unusual, but it is what makes the exchange below possible
 * from a machine that never ran the authorize leg.
 */
interface DeviceGrant {
  authorization_code: string;
  code_verifier: string;
}

interface OpenaiTokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

/** The poll interval arrives as a *string* (codex parses it with a custom
 *  deserializer), and may be absent. Coerced here, with a floor so a missing or
 *  zero value cannot turn the loop into a spin. */
function pollIntervalMs(raw: unknown): number {
  const seconds = Number.parseInt(String(raw ?? ''), 10);
  return Math.max(1, Number.isFinite(seconds) ? seconds : DEFAULT_POLL_INTERVAL_S) * 1000;
}

export class OpenaiAuthManager {
  private pending: PendingLogin | null = null;
  private epoch = 0;

  /** Wired in userContext.ts: fires on connect/disconnect so the bridge can broadcast. */
  onChange: ((status: AuthStatus) => void) | null = null;
  /** Wired in userContext.ts: a device-code flow fails long after the click that
   *  started it, so the failure needs a channel of its own. */
  onError: ((message: string) => void) | null = null;

  constructor(private store: Store) {}

  /**
   * Connected state. The tokens file is the source of truth for "connected" —
   * codex owns it, and a user who ran `codex logout` elsewhere really is
   * disconnected — while the name comes from our own non-secret copy.
   */
  getStatus(): AuthStatus {
    if (!this.store.hasCodexAuth()) return { loggedIn: false };
    const account = this.store.loadOpenaiAccount();
    const organization = account?.plan ? `ChatGPT ${account.plan}` : undefined;
    if (!account?.email && !organization) return { loggedIn: true };
    return {
      loggedIn: true,
      account: {
        ...(account?.email ? { email: account.email } : {}),
        ...(organization ? { organization } : {}),
      },
    };
  }

  isLoggedIn(): boolean {
    return this.store.hasCodexAuth();
  }

  /**
   * Ask OpenAI for a device code and start polling for the approval.
   *
   * Returns what the user has to do; the *result* of the login arrives later on
   * `onChange` (or `onError`), which is why this is not a promise that resolves
   * when they finish.
   */
  async startLogin(): Promise<{ verificationUrl: string; userCode: string }> {
    // A second Start supersedes the first rather than running two poll loops
    // against one account.
    this.cancelLogin();
    const res = await fetch(USERCODE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (!res.ok) throw new Error(`Could not start the OpenAI login (${res.status})`);
    const body = (await res.json()) as {
      device_auth_id?: string;
      user_code?: string;
      /** Spelled either way; codex accepts both as aliases. */
      usercode?: string;
      interval?: unknown;
    };
    const userCode = body.user_code ?? body.usercode;
    if (!body.device_auth_id || !userCode) {
      throw new Error('OpenAI did not return a device code — try again.');
    }
    const intervalMs = pollIntervalMs(body.interval);
    this.pending = {
      deviceAuthId: body.device_auth_id,
      userCode,
      intervalMs,
      startedAt: Date.now(),
      timer: null,
      epoch: ++this.epoch,
    };
    console.log(`[openai-auth] device code issued, polling every ${intervalMs / 1000}s`);
    this.schedulePoll(this.pending);
    return { verificationUrl: OPENAI_VERIFICATION_URL, userCode };
  }

  /** Stop polling. Idempotent — the UI calls it on close, cancel and restart. */
  cancelLogin(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.epoch++;
  }

  /**
   * Disconnect. Best-effort revoke first (so the token dies server-side too),
   * then delete the file that *is* the connection.
   *
   * The revoke reads the refresh token straight off codex's file rather than from
   * any copy of our own — this is the one read, and it happens immediately before
   * the file is deleted, so there is no window in which a stale copy could be used.
   */
  async logout(): Promise<void> {
    this.cancelLogin();
    const refreshToken = this.readRefreshTokenForRevoke();
    if (refreshToken) {
      try {
        await fetch(REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: refreshToken,
            token_type_hint: 'refresh_token',
            client_id: CLIENT_ID,
          }),
        });
      } catch (err) {
        // A revoke we could not deliver does not stop a disconnect: the local
        // credential is what makes turns run here, and it is about to be gone.
        console.warn('[openai-auth] revoke failed:', err);
      }
    }
    this.store.deleteCodexAuth();
    this.store.deleteOpenaiAccount();
    this.emitChange();
  }

  private readRefreshTokenForRevoke(): string | null {
    try {
      const raw = this.store.readCodexAuthRaw();
      const tokens = (raw as { tokens?: { refresh_token?: unknown } } | null)?.tokens;
      return typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : null;
    } catch {
      return null;
    }
  }

  private schedulePoll(login: PendingLogin) {
    login.timer = setTimeout(() => void this.poll(login), login.intervalMs);
    login.timer.unref?.();
  }

  /**
   * One poll tick.
   *
   * The approval state is carried by the HTTP *status*, not by a body field: 403
   * and 404 both mean "not approved yet" and re-arm, a 2xx carries the grant, and
   * anything else ends the flow. Reading a JSON `error` instead would treat a real
   * refusal as pending and poll for the full fifteen minutes.
   */
  private async poll(login: PendingLogin) {
    if (this.pending !== login || login.epoch !== this.epoch) return;
    if (Date.now() - login.startedAt > LOGIN_TTL_MS) {
      this.failLogin(login, 'The OpenAI login code expired — start again.');
      return;
    }
    try {
      const res = await fetch(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Both fields, and no client_id: this is the body codex sends.
        body: JSON.stringify({
          device_auth_id: login.deviceAuthId,
          user_code: login.userCode,
        }),
      });
      if (this.pending !== login || login.epoch !== this.epoch) return;
      if (res.status === 403 || res.status === 404) {
        // Logged once a minute, not once a tick: a stuck login is otherwise
        // indistinguishable from a working one that nobody has approved yet, and
        // that ambiguity is exactly what makes this flow hard to debug.
        const waitedS = Math.round((Date.now() - login.startedAt) / 1000);
        if (waitedS > 0 && waitedS % 60 < login.intervalMs / 1000) {
          console.log(`[openai-auth] still waiting for approval (${waitedS}s, status ${res.status})`);
        }
        this.schedulePoll(login);
        return;
      }
      if (!res.ok) {
        console.warn(`[openai-auth] device poll refused (${res.status})`);
        this.failLogin(login, `The OpenAI login was not completed (${res.status}). Start again.`);
        return;
      }
      const grant = (await res.json()) as Partial<DeviceGrant>;
      if (!grant.authorization_code || !grant.code_verifier) {
        this.failLogin(login, 'OpenAI approved the code but returned no grant — start again.');
        return;
      }
      await this.exchange(login, grant as DeviceGrant);
    } catch (err) {
      if (this.pending !== login || login.epoch !== this.epoch) return;
      // Network blips are what the poll loop is for — keep going until the TTL.
      console.warn('[openai-auth] poll failed:', err);
      this.schedulePoll(login);
    }
  }

  /**
   * Trade the device grant for tokens, then write the one file codex reads.
   *
   * Form-encoded, not JSON, and carrying the `code_verifier` the poll handed
   * back — the device-auth server generates the PKCE pair on our behalf, which is
   * what lets a machine that never ran the authorize leg complete the exchange.
   */
  private async exchange(login: PendingLogin, grant: DeviceGrant) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: grant.authorization_code,
        redirect_uri: DEVICE_REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: grant.code_verifier,
      }).toString(),
    });
    if (this.pending !== login || login.epoch !== this.epoch) return;
    if (!res.ok) {
      this.failLogin(login, `The OpenAI login could not be completed (${res.status}).`);
      return;
    }
    const body = (await res.json()) as OpenaiTokenResponse;
    // All three are required, `id_token` included: codex parses it into its own
    // claims struct on load, so writing a file without one makes the credential
    // unreadable to the very process it exists for.
    if (!body.id_token || !body.access_token || !body.refresh_token) {
      this.failLogin(login, 'OpenAI returned no usable credentials — start again.');
      return;
    }
    const account = accountFromIdToken(body.id_token);
    // The exact shape codex writes (`AuthDotJson` + `TokenData`).
    // `OPENAI_API_KEY: null` alongside `auth_mode: 'chatgpt'` is what marks this
    // as a subscription login rather than a metered API-key one.
    this.store.saveCodexAuth({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: body.id_token,
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        ...(account.accountId ? { account_id: account.accountId } : {}),
      },
      last_refresh: new Date().toISOString(),
    });
    this.store.saveOpenaiAccount(account);
    console.log('[openai-auth] connected; wrote $CODEX_HOME/auth.json');
    this.cancelLogin();
    this.emitChange();
  }

  private failLogin(login: PendingLogin, message: string) {
    if (this.pending === login) this.cancelLogin();
    console.warn(`[openai-auth] login failed: ${message}`);
    this.onError?.(message);
  }

  private emitChange(): void {
    this.onChange?.(this.getStatus());
  }
}
