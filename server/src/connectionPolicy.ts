/**
 * Who may open a direct socket to this bridge, and what a connection may do
 * with a Clerk token it hands over.
 *
 * The bridge runs agent turns, so a direct socket is remote code execution on
 * this machine for whoever holds it. It used to listen on every interface with
 * no check at all on a desktop install (CLERK_SECRET_KEY never ships there, so
 * the Clerk gate in handleConnection is off): anyone on the same Wi-Fi could
 * dial it, and so could any website the user visited — a browser lets a page
 * open a WebSocket to 127.0.0.1, and only the server can say no.
 *
 * So the default is loopback-only, and a browser socket must come from a page
 * served by this machine (or one the operator named). Reaching the bridge from a
 * phone on the LAN is still possible for development, but only on purpose:
 * `LINES_BRIDGE_HOST=0.0.0.0` plus that page's origin in
 * `LINES_BRIDGE_ALLOWED_ORIGINS`.
 *
 * Pure and dependency-free so every combination can be tested without standing
 * the bridge up; `verifyClient` is the one piece of glue, shared by the bridge
 * and its socket test so the test exercises the code that actually runs.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isLoopbackAddress } from './locality.ts';

/** Where the bridge listens unless told otherwise. IPv4 on purpose: see `listenHost`. */
export const DEFAULT_LISTEN_HOST = '127.0.0.1';

/** The two hosts that mean "every interface" — the LAN-testing opt-in. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

export interface ConnectionPolicy {
  /** The interface the listener binds. */
  host: string;
  /**
   * Bound to loopback only. A browser can then only arrive here by naming this
   * machine, so a Host header naming anything else is a DNS-rebinding page.
   */
  loopbackOnly: boolean;
  /**
   * False when `LINES_BRIDGE_DIRECT=0`: every browser arrives through the relay,
   * so a direct socket has no legitimate caller at all. The desktop app sets it
   * in relay mode, where its own window is the hosted app, unless its local
   * fallback window is on (then `token`, below).
   */
  direct: boolean;
  /**
   * `LINES_BRIDGE_DIRECT=token`: the desktop app's local fallback window. A
   * direct socket must then come from loopback, name loopback, carry exactly one
   * of `allowedOrigins`, and present this boot's runtime token as a subprotocol
   * — see `tokenGatedVerdict`. Nothing else gets in, a no-origin client included.
   */
  tokenGated: boolean;
  /** The per-boot runtime token a token-gated socket must present. Null outside that mode. */
  bridgeToken: string | null;
  /** Page origins besides this machine's own that may open a direct socket. */
  allowedOrigins: ReadonlySet<string>;
}

/**
 * How a browser hands the runtime token over: as a WebSocket subprotocol,
 * `lines.bt.<token>`, beside a plain `lines` the server selects. A page cannot
 * set headers on a WebSocket, and a query string ends up in logs and history;
 * the protocol header is the one place a browser sends a secret on the upgrade.
 */
export const BRIDGE_TOKEN_PROTOCOL_PREFIX = 'lines.bt.';
/** The subprotocol the bridge selects, so the token is never echoed back. */
export const LINES_SUBPROTOCOL = 'lines';

/**
 * The interface to bind, and a value of `LINES_BRIDGE_HOST` that was refused.
 *
 * 127.0.0.1 or every interface, nothing else. A specific LAN address buys
 * nothing the wildcard does not, and every caller on this machine — the
 * browser's page, the codex MCP child, the OAuth redirect — dials 127.0.0.1 by
 * number, so another loopback address (`::1`, `127.0.0.2`) would leave them all
 * finding nothing there. `localhost` is accepted as the same thing.
 */
export function listenHost(env: NodeJS.ProcessEnv = process.env): { host: string; refused?: string } {
  const raw = env.LINES_BRIDGE_HOST?.trim();
  if (!raw) return { host: DEFAULT_LISTEN_HOST };
  if (raw.toLowerCase() === 'localhost' || raw === DEFAULT_LISTEN_HOST) return { host: DEFAULT_LISTEN_HOST };
  if (WILDCARD_HOSTS.has(raw)) return { host: raw };
  return { host: DEFAULT_LISTEN_HOST, refused: raw };
}

/** Canonical `scheme://host[:port]` of an origin, or null for `null` and anything unparseable. */
function canonicalOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    // `new URL('file:///x').origin` is the string 'null', which must never match.
    return url.origin === 'null' ? null : url.origin;
  } catch {
    return null;
  }
}

/**
 * The whole policy, read once from the environment at startup. `bridgeToken` is
 * this boot's runtime token, which only the token-gated mode reads.
 */
export function connectionPolicy(
  env: NodeJS.ProcessEnv = process.env,
  bridgeToken: string | null = null,
): ConnectionPolicy {
  const { host } = listenHost(env);
  const allowedOrigins = new Set<string>();
  for (const entry of (env.LINES_BRIDGE_ALLOWED_ORIGINS ?? '').split(',')) {
    const origin = entry.trim() ? canonicalOrigin(entry.trim()) : null;
    if (origin) allowedOrigins.add(origin);
  }
  const tokenGated = env.LINES_BRIDGE_DIRECT === 'token';
  return {
    host,
    loopbackOnly: !WILDCARD_HOSTS.has(host),
    direct: env.LINES_BRIDGE_DIRECT !== '0',
    tokenGated,
    bridgeToken: tokenGated && bridgeToken ? bridgeToken : null,
    allowedOrigins,
  };
}

/**
 * A hostname — from a Host header or an origin — that can only mean this
 * machine. IP literals and `localhost` exactly: no `*.localhost`, no trailing
 * dot, and not `0.0.0.0`, which some browsers still route to loopback and which
 * no page of ours is ever served from.
 */
function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return bare === 'localhost' || isLoopbackAddress(bare);
}

/**
 * Whether a request's Host header is acceptable here.
 *
 * Only enforced on a loopback-bound bridge: there, any name other than this
 * machine's own is a page that re-pointed its domain at 127.0.0.1 (DNS
 * rebinding) to make the browser treat the bridge as same-origin. A missing
 * header fails closed — every HTTP/1.1 client sends one.
 */
export function hostAllowed(hostHeader: string | undefined, policy: ConnectionPolicy): boolean {
  if (!policy.loopbackOnly) return true;
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname);
}

export type UpgradeVerdict = { ok: true } | { ok: false; status: 403 | 421; reason: string };

/** What an upgrade request says about itself, as far as the policy cares. */
export interface UpgradeRequest {
  origin?: string;
  host?: string;
  remoteAddress?: string;
  /** The raw `Sec-WebSocket-Protocol` header: comma-separated subprotocols. */
  protocols?: string;
}

/** Whether `Sec-WebSocket-Protocol` carries `lines.bt.<expected>`, compared in constant time. */
function presentsBridgeToken(protocols: string | undefined, expected: string): boolean {
  const want = Buffer.from(expected);
  let found = false;
  for (const entry of (protocols ?? '').split(',')) {
    const value = entry.trim();
    if (!value.startsWith(BRIDGE_TOKEN_PROTOCOL_PREFIX)) continue;
    const got = Buffer.from(value.slice(BRIDGE_TOKEN_PROTOCOL_PREFIX.length));
    // timingSafeEqual throws on a length mismatch, which is itself an answer.
    if (got.length === want.length && timingSafeEqual(got, want)) found = true;
  }
  return found;
}

/**
 * The desktop app's local fallback window, and nothing else.
 *
 * Every condition on its own, because each stops a different stranger: the Host
 * a rebinding page, the peer a LAN machine, the exact origin any other page on
 * this machine (another app's localhost server included — "any loopback origin"
 * is not enough here), and the token whoever is not this OS user, since only
 * they can read the 0600 `bridge.json` it is published in. The token is never
 * taken from the query string.
 */
function tokenGatedVerdict(req: UpgradeRequest, policy: ConnectionPolicy): UpgradeVerdict {
  if (!policy.bridgeToken) return { ok: false, status: 403, reason: 'no runtime token to check against' };
  let hostname: string | null = null;
  try {
    hostname = req.host ? new URL(`http://${req.host}`).hostname : null;
  } catch {
    hostname = null;
  }
  if (!hostname || !isLoopbackHostname(hostname)) {
    return { ok: false, status: 421, reason: `host ${req.host ?? '(none)'} does not name this machine` };
  }
  if (!isLoopbackAddress(req.remoteAddress)) return { ok: false, status: 403, reason: 'not from this machine' };
  if (req.origin === undefined) return { ok: false, status: 403, reason: 'no origin' };
  const origin = canonicalOrigin(req.origin);
  if (!origin || !policy.allowedOrigins.has(origin)) {
    return { ok: false, status: 403, reason: `origin ${req.origin} is not allowed` };
  }
  if (!presentsBridgeToken(req.protocols, policy.bridgeToken)) {
    return { ok: false, status: 403, reason: 'missing or wrong bridge token' };
  }
  return { ok: true };
}

/**
 * The subprotocol to answer with, for `ws`'s `handleProtocols`. A browser that
 * offered any fails the handshake unless one is echoed, and `lines` is the one
 * picked so the token offered beside it never comes back on the response.
 */
export function selectProtocol(protocols: ReadonlySet<string>): string | false {
  return protocols.has(LINES_SUBPROTOCOL) ? LINES_SUBPROTOCOL : false;
}

/**
 * May this WebSocket upgrade proceed? Decided before the socket exists, so a
 * refused page never reaches `handleConnection` — nor, therefore, a `hello`.
 *
 * A browser always sends `Origin` on a WebSocket and a page cannot forge it, so
 * the origin is the check that actually stops a website: only a page this
 * machine served (a loopback origin, asked from loopback) or one the operator
 * listed gets in. `null` — a sandboxed frame, a file:// page — is refused like
 * any other stranger. No origin at all is a non-browser client (the tests, a
 * CLI), and only from this machine.
 *
 * The loopback origin is honoured only from a loopback peer: on a wildcard bind
 * a LAN machine's own `http://localhost` page would otherwise pass for ours.
 */
export function upgradeVerdict(req: UpgradeRequest, policy: ConnectionPolicy): UpgradeVerdict {
  if (!policy.direct) {
    return { ok: false, status: 403, reason: 'direct connections are disabled on this machine' };
  }
  if (policy.tokenGated) return tokenGatedVerdict(req, policy);
  if (!hostAllowed(req.host, policy)) {
    return { ok: false, status: 421, reason: `host ${req.host ?? '(none)'} does not name this machine` };
  }
  const fromLoopback = isLoopbackAddress(req.remoteAddress);
  if (req.origin === undefined) {
    return fromLoopback ? { ok: true } : { ok: false, status: 403, reason: 'no origin from a remote peer' };
  }
  const origin = canonicalOrigin(req.origin);
  if (origin && policy.allowedOrigins.has(origin)) return { ok: true };
  if (origin && fromLoopback && isLoopbackHostname(new URL(origin).hostname)) return { ok: true };
  return { ok: false, status: 403, reason: `origin ${req.origin} is not allowed` };
}

/**
 * The `ws` server's `verifyClient`, built from a policy. `onRefused` is for the
 * log line: a refusal is otherwise invisible from both ends.
 */
export function verifyClient(
  policy: ConnectionPolicy,
  onRefused?: (reason: string) => void,
): (
  info: { origin?: string; req: IncomingMessage },
  done: (ok: boolean, status?: number, message?: string) => void,
) => void {
  return (info, done) => {
    const verdict = upgradeVerdict(
      {
        // `ws` hands over an empty string when the header is absent on some paths.
        origin: info.origin || undefined,
        host: info.req.headers.host,
        remoteAddress: info.req.socket.remoteAddress,
        protocols: info.req.headers['sec-websocket-protocol'],
      },
      policy,
    );
    if (verdict.ok) return done(true);
    onRefused?.(verdict.reason);
    done(false, verdict.status, verdict.reason);
  };
}

/** What to do with a refreshed Clerk token that arrived on one connection. */
export type TokenRefreshAction = 'ignore' | 'verify' | 'accept';

/**
 * Whether a connection's refreshed token may become its context's storage
 * credential.
 *
 * - A guest: never. The context is the *host's*, so a guest token installed on
 *   it would push the host's sessions into the guest's account.
 * - A relayed owner: accepted. The relay verified it, the same trust its
 *   hello-time token already has, and the owner channel itself authenticated
 *   end to end against a key this machine pinned.
 * - A direct socket: re-verified through Clerk when this bridge can, otherwise
 *   ignored — with no relay vouching for it, nothing else says whose it is.
 */
export function tokenRefreshAction(
  conn: { owner: boolean; relayed: boolean },
  authEnabled: boolean,
): TokenRefreshAction {
  if (!conn.owner) return 'ignore';
  if (conn.relayed) return 'accept';
  return authEnabled ? 'verify' : 'ignore';
}

/**
 * The `sub` claim of a JWT, read without verifying it — verification is the
 * caller's (or the relay's) business. Null for anything that is not a JWT.
 */
export function jwtSubject(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * Whether a token may serve as this context's storage credential: its subject
 * must be the context's own user.
 *
 * The single-tenant context has no account id of its own to compare against,
 * and the one place it legitimately receives a token is the dev relay with auth
 * off, which binds every browser to it. So the exemption is passed in only
 * there; elsewhere `singleTenantUserId` is null and that context takes no token
 * at all — otherwise a relay could push its own account's token onto it and
 * collect everything it syncs.
 */
export function tokenFitsContext(token: string, contextUserId: string, singleTenantUserId: string | null): boolean {
  if (singleTenantUserId !== null && contextUserId === singleTenantUserId) return true;
  return jwtSubject(token) === contextUserId;
}
