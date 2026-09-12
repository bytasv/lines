import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthStatus } from '@lines/shared';
import { accountFromIdToken, OpenaiAuthManager } from './openaiAuth.ts';
import type { Store, StoredOpenaiAccount } from './store.ts';

/** A signed-looking JWT whose payload is what we claim it is. Never verified —
 *  the claims are display-only, so the signature is irrelevant here and there. */
function idToken(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `header.${body}.signature`;
}

const ID_TOKEN = idToken({
  email: 'someone@example.com',
  'https://api.openai.com/auth': { chatgpt_account_id: 'acc_1', chatgpt_plan_type: 'pro' },
});

/**
 * Fake store that records what the manager writes. The codex auth file is the
 * only store of secrets, so "what was written, and how often" is the property
 * under test throughout.
 */
function makeManager(initial?: { auth?: unknown; account?: StoredOpenaiAccount }) {
  let codexAuth: unknown = initial?.auth ?? null;
  let account: StoredOpenaiAccount | null = initial?.account ?? null;
  let writes = 0;
  const store = {
    codexHome: () => '/tmp/codex-home',
    saveCodexAuth: (payload: unknown) => {
      writes++;
      codexAuth = payload;
    },
    hasCodexAuth: () => codexAuth !== null,
    readCodexAuthRaw: () => codexAuth,
    deleteCodexAuth: () => {
      codexAuth = null;
    },
    loadOpenaiAccount: () => account,
    saveOpenaiAccount: (a: StoredOpenaiAccount) => {
      account = a;
    },
    deleteOpenaiAccount: () => {
      account = null;
    },
  } as unknown as Store;

  const manager = new OpenaiAuthManager(store);
  const changes: AuthStatus[] = [];
  const errors: string[] = [];
  manager.onChange = (status) => changes.push(status);
  manager.onError = (message) => errors.push(message);
  return {
    manager,
    changes,
    errors,
    auth: () => codexAuth as Record<string, unknown> | null,
    account: () => account,
    writeCount: () => writes,
  };
}

/** Swap global fetch for the duration of one test, scripting one reply per URL hit. */
function stubFetch(
  t: { after: (fn: () => void) => void },
  respond: (url: string, body: unknown, raw: string | undefined) => Response,
) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    urls.push(url);
    const raw = init?.body === undefined ? undefined : String(init.body);
    // The token exchange is form-encoded, so a blanket JSON.parse would throw —
    // callers that care about that body read `raw`.
    let parsed: unknown;
    try {
      parsed = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    return respond(url, parsed, raw);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return urls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('status is read from the account file with no network call', async (t) => {
  const urls = stubFetch(t, () => json({}));
  const { manager } = makeManager({
    auth: { tokens: {} },
    account: { version: 1, email: 'someone@example.com', plan: 'pro', connectedAt: 1 },
  });

  assert.deepEqual(manager.getStatus(), {
    loggedIn: true,
    account: { email: 'someone@example.com', organization: 'ChatGPT pro' },
  });
  assert.equal(urls.length, 0);
});

test('no tokens file means disconnected, whatever the account file says', () => {
  const { manager } = makeManager({
    account: { version: 1, email: 'someone@example.com', connectedAt: 1 },
  });
  // The file codex owns is the source of truth: a user who ran `codex logout`
  // elsewhere really is disconnected.
  assert.deepEqual(manager.getStatus(), { loggedIn: false });
  assert.equal(manager.isLoggedIn(), false);
});

test('claims are parsed off the id_token', () => {
  const account = accountFromIdToken(ID_TOKEN);
  assert.equal(account.email, 'someone@example.com');
  assert.equal(account.plan, 'pro');
  assert.equal(account.accountId, 'acc_1');
});

test('device code -> poll -> exchange writes auth.json exactly once', async (t) => {
  let polls = 0;
  let pollBody: Record<string, unknown> | undefined;
  let exchangeBody: string | undefined;
  const urls = stubFetch(t, (url, body, raw) => {
    if (url.endsWith('/deviceauth/usercode')) {
      // `interval` really is a string on the wire — codex parses it with a custom
      // deserializer, so a number-typed read here would be wrong about the API.
      return json({ device_auth_id: 'dev_1', user_code: 'ABCD-1234', interval: '1' });
    }
    if (url.endsWith('/deviceauth/token')) {
      polls++;
      pollBody = body as Record<string, unknown>;
      // Pending is a 403, not a body field. Reading a JSON `error` instead would
      // treat a real refusal as pending and poll for the full fifteen minutes.
      if (polls === 1) return new Response('', { status: 403 });
      return json({
        authorization_code: 'code_1',
        code_challenge: 'chal_1',
        code_verifier: 'ver_1',
      });
    }
    exchangeBody = raw;
    return json({ id_token: ID_TOKEN, access_token: 'at', refresh_token: 'rt' });
  });

  const { manager, changes, auth, account, writeCount } = makeManager();
  const started = await manager.startLogin();
  assert.equal(started.userCode, 'ABCD-1234');
  assert.match(started.verificationUrl, /auth\.openai\.com/);

  // Two poll ticks, driven by real timers at the 1s interval the server named.
  await new Promise((resolve) => setTimeout(resolve, 2400));

  assert.ok(polls >= 2, `expected a re-poll after the 403, got ${polls}`);
  // Both fields, and no client_id — this is the body codex sends.
  assert.deepEqual(pollBody, { device_auth_id: 'dev_1', user_code: 'ABCD-1234' });
  // The exchange is form-encoded and carries the PKCE verifier the poll handed
  // back. JSON, or a missing verifier, is rejected by the token endpoint.
  const form = new URLSearchParams(exchangeBody ?? '');
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'code_1');
  assert.equal(form.get('code_verifier'), 'ver_1');
  assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  // Written once, and never again: codex rotates the refresh token from here on,
  // and a second Lines write would clobber tokens fresher than ours.
  assert.equal(writeCount(), 1);
  const written = auth()!;
  // The shape codex's own AuthDotJson/TokenData serde writes.
  assert.equal(written.auth_mode, 'chatgpt');
  assert.equal(written.OPENAI_API_KEY, null);
  assert.deepEqual(written.tokens, {
    id_token: ID_TOKEN,
    access_token: 'at',
    refresh_token: 'rt',
    account_id: 'acc_1',
  });
  assert.equal(typeof written.last_refresh, 'string');
  assert.equal(account()?.email, 'someone@example.com');
  assert.deepEqual(changes.at(-1), {
    loggedIn: true,
    account: { email: 'someone@example.com', organization: 'ChatGPT pro' },
  });
  assert.ok(urls.some((u) => u.endsWith('/oauth/token')));
});

test('a refusal ends the flow with a message instead of polling on', async (t) => {
  let polls = 0;
  stubFetch(t, (url) => {
    if (url.endsWith('/deviceauth/usercode')) {
      return json({ device_auth_id: 'dev_1', user_code: 'ABCD-1234', interval: '1' });
    }
    polls++;
    // Any status that is not 2xx/403/404 is terminal.
    return new Response('', { status: 400 });
  });

  const { manager, errors, writeCount } = makeManager();
  await manager.startLogin();
  await new Promise((resolve) => setTimeout(resolve, 2400));

  assert.match(errors.at(-1) ?? '', /not completed/i);
  assert.equal(writeCount(), 0);
  // Terminal means terminal: it must not keep polling behind the error.
  assert.equal(polls, 1);
});

test('a grant with no usable credentials fails rather than writing a broken file', async (t) => {
  stubFetch(t, (url) => {
    if (url.endsWith('/deviceauth/usercode')) {
      return json({ device_auth_id: 'dev_1', user_code: 'ABCD-1234', interval: '1' });
    }
    if (url.endsWith('/deviceauth/token')) {
      return json({ authorization_code: 'code_1', code_challenge: 'c', code_verifier: 'v' });
    }
    // No id_token: codex parses it into its own claims struct on load, so writing
    // the file without one makes the credential unreadable to the process it is for.
    return json({ access_token: 'at', refresh_token: 'rt' });
  });

  const { manager, errors, writeCount } = makeManager();
  await manager.startLogin();
  await new Promise((resolve) => setTimeout(resolve, 1400));

  assert.match(errors.at(-1) ?? '', /no usable credentials/i);
  assert.equal(writeCount(), 0);
});

test('cancelLogin stops the poll loop', async (t) => {
  let polls = 0;
  stubFetch(t, (url) => {
    if (url.endsWith('/deviceauth/usercode')) {
      return json({ device_auth_id: 'dev_1', user_code: 'ABCD-1234', interval: '1' });
    }
    polls++;
    return new Response('', { status: 403 });
  });

  const { manager } = makeManager();
  await manager.startLogin();
  manager.cancelLogin();
  await new Promise((resolve) => setTimeout(resolve, 1400));

  // Without this an abandoned login polls OpenAI until the code expires.
  assert.equal(polls, 0);
});

test('logout revokes best-effort, then deletes the credential either way', async (t) => {
  let revokeBody: unknown;
  const urls = stubFetch(t, (_url, body) => {
    revokeBody = body;
    return new Response('nope', { status: 500 });
  });
  const { manager, changes, auth, account } = makeManager({
    auth: { tokens: { refresh_token: 'rt' } },
    account: { version: 1, email: 'someone@example.com', connectedAt: 1 },
  });

  await manager.logout();

  assert.ok(urls.some((u) => u.endsWith('/oauth/revoke')));
  assert.deepEqual(revokeBody, {
    token: 'rt',
    token_type_hint: 'refresh_token',
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  });
  // A revoke we could not deliver must not block a disconnect.
  assert.equal(auth(), null);
  assert.equal(account(), null);
  assert.deepEqual(changes.at(-1), { loggedIn: false });
});
