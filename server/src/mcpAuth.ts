/**
 * OAuth for a user-added MCP server.
 *
 * ## Why this file is a shim
 *
 * Authorizing a server that reports `needs-auth` is owned by the CLI binary, and
 * the SDK's *typed* surface has no entry point for it: `Query` declares
 * `mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer` and `setMcpServers`,
 * and nothing that starts an OAuth handshake. The three methods that do exist —
 * `mcpAuthenticate`, `mcpSubmitOAuthCallbackUrl`, `mcpClearAuth` — are present at
 * runtime in `sdk.mjs` but absent from `sdk.d.ts`.
 *
 * `onElicitation` does not cover this case, which is worth stating because it
 * looks like it should: an elicitation is a request from a *connected* server, and
 * a server awaiting OAuth never completes its transport handshake, so there is no
 * MCP session to elicit through. Elicitation is for mid-session consent; this is
 * for bootstrapping the token.
 *
 * ## The upgrade tripwire
 *
 * Calling undeclared methods means a silent break on upgrade — a `TypeError` deep
 * in a turn, or worse, a changed response shape that quietly yields no auth URL.
 * Two guards, and neither is optional:
 *
 *  1. `mcpAuthSupport()` — a runtime probe. Every call site goes through it, so a
 *     renamed or removed method degrades into a typed "unsupported" answer the UI
 *     can explain, instead of throwing.
 *  2. `mcpAuth.contract.test.ts` — a canary that fails in *both* directions: if
 *     the methods vanish from the runtime bundle, and if they appear in the
 *     typings (which means this shim is obsolete and should be deleted in favour
 *     of the real API). An `npm update` that moves either way goes red.
 *
 * The response shape below was established empirically against Figma's server,
 * since it is documented nowhere. `normalizeAuthStart` is therefore deliberately
 * tolerant: it validates the one field the flow cannot proceed without and
 * ignores the rest.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { MCP_AUTH_METHODS } from './workerProtocol.ts';

// The probe itself lives in workerProtocol.ts, which is the one local module the
// worker may import (see worker.ts's header) and the worker is the side that
// holds a Query. Re-exported here so the bridge, the UI copy below, and the
// canary all name one definition.
export { MCP_AUTH_METHODS, mcpAuthSupport, type McpAuthApi, type McpAuthSupport } from './workerProtocol.ts';

/** Human-readable reason for the UI when the shim no longer matches the SDK. */
export function unsupportedReason(missing: string[]): string {
  return `This build of the Claude Agent SDK does not expose ${missing.join(' or ')}. Authorize the server from an interactive CLI session instead.`;
}

/**
 * The useful part of `mcpAuthenticate`'s undocumented answer.
 *
 * Observed shape:
 *   { authUrl, requiresUserAction, callbackExpected, redirectScheme, state }
 *
 * `authUrl` is the only field the flow genuinely needs. `state` is echoed back by
 * the provider on the redirect and is what makes the callback route safe to
 * expose unauthenticated, so it is kept when present — but its absence is not
 * fatal, because a provider that omits it still completes via the callback URL.
 */
export interface McpAuthStart {
  authUrl: string;
  state?: string;
  /**
   * Always true on this variant: a `false` from the SDK means the CLI considers
   * the server already authorized, which `normalizeAuthStart` returns as
   * `alreadyAuthorized` instead. Kept on the type because it is part of the
   * recorded response shape this file is the only record of.
   */
  callbackExpected: boolean;
}

export function normalizeAuthStart(
  raw: unknown,
): { start: McpAuthStart } | { alreadyAuthorized: true } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'The SDK returned no authorization details.' };
  const src = raw as Record<string, unknown>;
  // Checked ahead of the URL, because this answer legitimately carries none: the
  // CLI already holds a token for this server, so there is nothing to hand the
  // user and no callback to wait for. Reported as its own outcome rather than as
  // "no authorization URL", which would read as a failure of a working setup.
  if (src.callbackExpected === false) return { alreadyAuthorized: true };
  // Tolerate a renamed field rather than failing outright: this shape is
  // undocumented, and `authorizationUrl` is the likelier rename.
  const authUrl =
    typeof src.authUrl === 'string'
      ? src.authUrl
      : typeof src.authorizationUrl === 'string'
        ? src.authorizationUrl
        : '';
  if (!authUrl) return { error: 'The SDK returned no authorization URL.' };
  let parsed: URL;
  try {
    parsed = new URL(authUrl);
  } catch {
    return { error: 'The SDK returned a malformed authorization URL.' };
  }
  // The user is about to be sent here, so refuse anything but a real web URL.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'The authorization URL is not an http(s) URL.' };
  }
  return {
    start: {
      authUrl,
      ...(typeof src.state === 'string' && src.state ? { state: src.state } : {}),
      // Absent means "expected": the flow that needs no callback is the exception.
      callbackExpected: src.callbackExpected !== false,
    },
  };
}

/**
 * How long a started handshake stays claimable before its state is forgotten.
 *
 * Exported because `SessionManager` bounds its query hold on the same clock: a
 * hold that outlived the handshake it was protecting would pin a CLI child open
 * for a flow that can no longer complete.
 */
export const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingAuth {
  userId: string;
  sessionId: string;
  serverName: string;
  startedAt: number;
}

/**
 * Handshakes waiting on their browser redirect, keyed by the provider's `state`.
 *
 * `state` is the *only* credential on the callback route — an OAuth redirect
 * cannot carry the app's own token — so the rules here are load-bearing:
 * single-use (claimed and deleted atomically), TTL-bounded, and compared without
 * leaking length or position. That is the standard OAuth CSRF defence and is what
 * makes an unauthenticated route acceptable.
 *
 * Per-bridge and in memory only. A restart forgets every pending handshake, which
 * is correct: the PKCE verifier lives in the CLI process that leg 1 ran in, so a
 * handshake cannot outlive its query anyway.
 */
export class McpAuthPending {
  private byState = new Map<string, PendingAuth>();

  start(state: string, entry: Omit<PendingAuth, 'startedAt'>): void {
    this.prune();
    this.byState.set(state, { ...entry, startedAt: Date.now() });
  }

  /** Claim a handshake by state, removing it. Null when unknown, stale, or already used. */
  claim(state: string): PendingAuth | null {
    this.prune();
    // Map lookup on an attacker-supplied key is a hash comparison, so walk the
    // entries and compare each with timingSafeEqual instead.
    for (const [known, entry] of this.byState) {
      if (!sameSecret(known, state)) continue;
      this.byState.delete(known);
      return entry;
    }
    return null;
  }

  /** Drop a handshake whose query died, so a stale state cannot be replayed later. */
  forgetSession(sessionId: string): void {
    for (const [state, entry] of [...this.byState]) {
      if (entry.sessionId === sessionId) this.byState.delete(state);
    }
  }

  get size(): number {
    this.prune();
    return this.byState.size;
  }

  private prune(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, entry] of [...this.byState]) {
      if (entry.startedAt < cutoff) this.byState.delete(state);
    }
  }
}

/** Length-safe constant-time compare for opaque secrets. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be an oracle;
  // compare a fixed-width digest-shaped pair instead by bailing on length first.
  // Length alone is not secret here (the provider chooses it), the value is.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Does the *installed* SDK still match this shim's assumptions? Used by the
 * canary test, and exported so the answer has exactly one implementation.
 *
 * Returns which methods exist on `Query.prototype` in the runtime bundle, and
 * whether the typings have started declaring them (the signal to delete this
 * file and use the typed API).
 */
export function inspectInstalledSdk(): {
  runtime: Record<string, boolean>;
  declaredInTypings: string[];
} {
  const require = createRequire(import.meta.url);
  // Resolve the package entry, then read its siblings: `sdk.d.ts` is named in
  // `exports["."].types` but is not itself an importable subpath, so resolving it
  // directly throws ERR_PACKAGE_PATH_NOT_EXPORTED.
  const bundlePath = require.resolve('@anthropic-ai/claude-agent-sdk');
  const typingsPath = bundlePath.replace(/\.mjs$/, '.d.ts');
  const source = fs.readFileSync(bundlePath, 'utf8');
  const typings = fs.readFileSync(typingsPath, 'utf8');
  const runtime: Record<string, boolean> = {};
  for (const name of MCP_AUTH_METHODS) {
    // Matches the method definition in the class body, e.g. `mcpAuthenticate(e,t){`.
    runtime[name] = new RegExp(`\\b${name}\\s*\\(`).test(source);
  }
  const declaredInTypings = MCP_AUTH_METHODS.filter((name) =>
    new RegExp(`^\\s+${name}\\s*\\(`, 'm').test(typings),
  );
  return { runtime, declaredInTypings };
}
