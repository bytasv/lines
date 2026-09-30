import http from 'node:http';
import { devRuntime, DEV_UPDATING } from './devRuntime.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import dotenv from 'dotenv';

// Env comes from the repo-root .env (single file for all workspaces); real
// environment variables win over .env entries.
//
// Both files are optional and existence-checked, because the packaged desktop
// app has neither: it boots with an empty environment and takes its URLs from
// the shell's config.json instead. `~/.lines-app/.env` is the user-level
// override for an installed build — same directory as every other piece of app
// state — and is read *first* because dotenv keeps the first value it sees for a
// key, so reading it before the repo file is what makes it an override.
for (const envFile of [
  path.join(os.homedir(), '.lines-app', '.env'),
  path.resolve(process.env.LINES_DEV_CHECKOUT ?? path.resolve(import.meta.dirname, '../..'), '.env'),
]) {
  if (fs.existsSync(envFile)) dotenv.config({ path: envFile });
}
import { WebSocketServer, WebSocket } from 'ws';
import type { Actor, ClientMessage, ServerMessage, SocketAccess } from '@lines/shared';
import { jevConfigured } from './jev.ts';
import { smartRoutingIssues } from './turnRouting.ts';
import {
  APP_PROTOCOL_VERSION,
  DEFAULT_MODELS,
  OWNER_ACCESS,
  authorizeMessage,
  isSessionActive,
  normalizePlanComments,
  normalizeRootPath,
  parseShareCaps,
  projectRoots,
} from '@lines/shared';
import { verifyToken } from '@clerk/backend';
import { WORKER_LOST_MS, WorkerClient, type WorkerRpc } from './workerClient.ts';
import { RelayClient, type AttestedGrant, type AttestedIdentity } from './relayClient.ts';
import { deviceIdentity } from './device.ts';
import { bridgeIdentity } from './e2eeIdentity.ts';
import { guardRelayChannel } from './e2eeChannel.ts';
import { isLoopbackAddress } from './locality.ts';
import { APP_ROOT, userStoreRoot } from './store.ts';
import { UserRegistry } from './userRegistry.ts';
import type { BrowserLink, UserContext } from './userContext.ts';
import { handleFileRequest } from './fileRoutes.ts';
import { reportActivity, reportRelayStatus, UpdateManager } from './updates.ts';
import {
  LINES_TOOL_MANIFEST,
  createMcpDispatcher,
  type McpAuthorizeOutcome,
} from './mcpWorkflowTools.ts';
import { AGENT_AUTH_WAIT_MS, McpAuthPending, type McpAuthSettled } from './mcpAuth.ts';
import * as workflowCommands from './workflowCommands.ts';
import * as recipeCommands from './recipeCommands.ts';
import * as worktreeCommands from './worktreeCommands.ts';
import {
  clearRuntimeInfo,
  INSTANCE,
  newRuntimeToken,
  publishRuntimeInfo,
  readRuntimeInfo,
  type McpToolResult,
} from './workerProtocol.ts';
import { publicClaudeCliStatus } from './claudeCli.ts';
import { publicCodexCliStatus } from './codexCli.ts';
import { publicWhisperStatus, refreshWhisperStatus } from './whisperCli.ts';
import { onWhisperModelDownload, startWhisperModelDownload, whisperModelDownloadState } from './whisperModel.ts';
import { transcribe } from './transcribe.ts';

/** Explicit pin for local dev (Tilt sets it so its readiness probe has a fixed
 *  target); unset means bind :0 and publish the result to bridge.json. */
const PORT = Number(process.env.LINES_BRIDGE_PORT ?? 0);

/** Published in bridge.json for the tray app's future control channel. It is
 *  deliberately *not* enforced on browser connections: a browser cannot set
 *  headers on a WebSocket, and the Clerk gate in handleConnection is what
 *  guards that path. The dev-server discovery endpoint never exposes it. */
const bridgeToken = newRuntimeToken();

/**
 * Injected by the desktop bundler (esbuild `--define`), because a packaged
 * bundle has no `package.json` beside it. Undefined under tsx, Tilt and every
 * test — hence the `typeof` guard rather than a bare read.
 */
declare const __LINES_VERSION__: string | undefined;

/** Reported to clients on `hello`. Read from disk rather than imported so the
 *  bridge needs no resolveJsonModule; a missing/unreadable manifest is cosmetic. */
const BRIDGE_VERSION: string = (() => {
  try {
    const pkg = fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8');
    return (JSON.parse(pkg) as { version?: string }).version ?? '0.0.0';
  } catch {
    return typeof __LINES_VERSION__ === 'string' ? __LINES_VERSION__ : '0.0.0';
  }
})();

/**
 * Opt-in perf instrumentation (LINES_PERF=1). Everything it guards — the timer
 * below, the performance.now() calls at the transcript path — is skipped
 * entirely when unset, not merely silenced.
 */
const PERF = process.env.LINES_PERF === '1';

if (PERF) {
  // The bridge is single-threaded: any synchronous burst (a transcript read and
  // parse, a whole-file sessions.json write) stalls every other session's
  // stream. Timer drift is the direct measure of that.
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    const drift = now - lastTick - 100;
    if (drift > 50) console.warn(`[perf] event-loop lag ${drift.toFixed(0)}ms`);
    lastTick = now;
  }, 100).unref();
}

/**
 * Phase 3 auth gate. Enabled only when a Clerk secret key is configured and
 * BRIDGE_AUTH_DISABLED isn't set — otherwise every socket binds to the
 * implicit 'local' user, which is the single-tenant dev behavior.
 */
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const AUTH_ENABLED = Boolean(CLERK_SECRET_KEY) && process.env.BRIDGE_AUTH_DISABLED !== '1';
if (!AUTH_ENABLED) {
  console.warn(
    `[auth] bridge auth disabled (${CLERK_SECRET_KEY ? 'BRIDGE_AUTH_DISABLED=1' : 'no CLERK_SECRET_KEY'}) — all sockets bind to user "local"`,
  );
}

/** Verify a Clerk session token; returns the user id or null. */
async function verifyClerkUserId(token: string): Promise<string | null> {
  try {
    const claims = await verifyToken(token, { secretKey: CLERK_SECRET_KEY! });
    return claims.sub ?? null;
  } catch {
    return null;
  }
}

interface ConnState {
  userId: string;
  /**
   * Stable id for this connection, for presence. Two tabs of the same person are
   * two connections, so closing one must not remove them from the other.
   */
  connId: string;
  /** Freshest verified Clerk token from this connection (handshake or relay). */
  clerkToken: string | null;
  /**
   * What this connection may do. `OWNER_ACCESS` for the machine's own user; a
   * narrowed grant for a guest. Read by the authz gate in handleMessage, and by
   * the file-read clamp.
   */
  access: SocketAccess;
  /**
   * Whether this link reaches us from this machine (loopback, not relayed). The
   * only connection that may open a native dialog on the host's screen.
   */
  local: boolean;
  /**
   * Whether this is the machine's own user rather than a guest. Lets the desktop
   * shell's own window — relayed, so not `local` — open the folder dialog; the
   * client decides whether it is sitting at the host.
   */
  owner: boolean;
}
// Keyed on the link object; relayClient will hold a strong ref per channel,
// so a WeakMap entry lives exactly as long as its connection.
const conns = new WeakMap<BrowserLink, ConnState>();

/**
 * Phase 2 of the multi-user plan: all state lives in per-user contexts held by
 * the registry, but every connection still binds to the implicit 'local' user
 * (the Clerk auth gate arrives in Phase 3). 'local' keeps the legacy flat
 * `~/.lines-app` layout so an existing install carries over untouched; real
 * user ids get `~/.lines-app/users/{id}` (migration ships with the auth gate).
 */
const LOCAL_USER = 'local';

// The worker owns the Claude CLI children so this process can restart freely
// (tsx watch, dogfooding edits) without killing in-flight agent turns.
// Callbacks close over `registry` (created right after) and only fire once the
// worker socket connects.
let devRelayConnected = false;
const worker = new WorkerClient({
  onHello: (live) => devRuntime.whenActive(() => registry.onWorkerLive(live)),
  onEvent: (sessionId, message) =>
    devRuntime.whenActive(() => registry.forSession(sessionId).sessions.handleWorkerEvent(sessionId, message)),
  onEnded: (sessionId, error) => devRuntime.whenActive(() => {
    // The PKCE verifier died with that CLI process, so any handshake it started
    // can never complete — drop the state rather than leave it claimable, and
    // drop the query hold that was protecting a query which no longer exists.
    mcpAuthPending.forgetSession(sessionId);
    const ended = registry.forSession(sessionId);
    ended.sessions.releaseAuthHold(sessionId);
    ended.sessions.handleWorkerEnded(sessionId, error);
  }),
  onRpc: (rpc) => devRuntime.whenActive(() => {
    const ctx = registry.forSession(rpc.sessionId);
    // Workflow tool calls are the bridge's own business, not the session's —
    // they read and write this user's context rather than gating a tool call.
    if (rpc.kind === 'mcpTool') void handleMcpToolRpc(ctx, rpc);
    else void ctx.sessions.handleWorkerRpc(rpc);
  }),
  // No sessionId on a cancel — only the owner's live map has the pending rpc, the rest no-op.
  onRpcCancel: (id) => devRuntime.whenActive(() => {
    for (const ctx of registry.all()) ctx.sessions.handleRpcCancel(id);
  }),
  onWorkerLost: () => devRuntime.whenActive(() => {
    console.warn(`[worker] lost — no reconnect within ${WORKER_LOST_MS}ms, flagging in-flight sessions`);
    registry.onWorkerLost();
  }),
  // Link health carries no session, so it fans out to every context rather than
  // going through the registry's session ownership.
  onStatusChange: (worker) => {
    for (const ctx of registry.all()) ctx.broadcast({ type: 'workerStatus', worker });
  },
});
// Legacy-state adoption is a manual step: server/scripts/migrate-user.ts.
const registry = new UserRegistry(
  worker,
  (userId) => (userId === LOCAL_USER ? APP_ROOT : userStoreRoot(userId)),
  LOCAL_USER,
  () => syncActivity(),
);

/**
 * Is any session on this machine mid-turn, for any user?
 *
 * The same predicate `UpdateManager.busy` uses, widened past the local user:
 * the shell holds the Mac awake for a turn whoever started it.
 */
function anyTurnActive(): boolean {
  for (const ctx of registry.all()) {
    if (ctx.sessions.list().some((s) => isSessionActive(s.status))) return true;
  }
  return false;
}

/**
 * Keep the shell's power-save blocker matched to the machine's real state.
 * Deduped inside `reportActivity`, so calling it on every session upsert costs
 * one comparison.
 */
function syncActivity(): void {
  reportActivity(anyTurnActive());
}

/**
 * Safety tick. A missed transition would otherwise either leave the Mac awake
 * for good or let it sleep mid-turn — both silent, and both only noticed hours
 * later. 30s is far below any sleep timer and costs nothing when nothing moved.
 */
setInterval(syncActivity, 30_000).unref();
// Eager local context in single-tenant mode: workflows keep advancing and
// worker events keep landing even before (or without) any browser connecting.
// With auth on, contexts build lazily per verified user instead — but seed the
// ownership index from disk so a restarted bridge routes worker events for a
// not-yet-reconnected user to the right context, not the local fallback.
if (!AUTH_ENABLED) {
  registry.get(LOCAL_USER);
} else {
  try {
    const usersDir = path.join(APP_ROOT, 'users');
    for (const entry of fs.existsSync(usersDir) ? fs.readdirSync(usersDir) : []) {
      try {
        const raw = fs.readFileSync(path.join(usersDir, entry, 'sessions.json'), 'utf8');
        for (const meta of JSON.parse(raw) as { id?: string }[]) {
          if (meta.id) registry.seedOwnership(meta.id, entry);
        }
      } catch {
        // no sessions.json for that user yet
      }
    }
  } catch (err) {
    console.warn('[auth] ownership seed scan failed:', err);
  }
}

/**
 * Desktop update plumbing. Inert unless the tray app spawned us, so Tilt and
 * `npm run dev` are untouched.
 */
const updates = new UpdateManager(
  () => registry.get(LOCAL_USER).sessions.list(),
  (msg) => {
    for (const ctx of registry.all()) ctx.broadcast(msg);
  },
);

/**
 * Outbound relay link, so a hosted web app can reach this machine. Opt-in: with
 * no RELAY_URL the bridge behaves exactly as before, serving only its local
 * socket.
 *
 * Deliberately a peripheral, never a supervisor. Relay health must never restart
 * the bridge and absolutely never the worker — that would turn a relay blip into
 * a reconcile, an `interruptedAt` stamp, and an auto-continued turn.
 */
/**
 * Where the single-instance lock lives, beside the device identity it protects.
 * Holds the pid, its start time and which install claimed it, so a stale file can
 * be told from a live claim and a live claim can say *who* it belongs to.
 */
const BRIDGE_LOCK_FILE = path.join(APP_ROOT, 'bridge.lock');

/**
 * `EX_CONFIG`: another bridge owns this machine. A contract with the desktop
 * shell (desktop/src/main.ts), which uses it to stand the tray down and re-arm
 * later instead of respawning us on a 1s timer forever.
 */
const EXIT_BRIDGE_LOCK_HELD = 78;

/**
 * How long we wait for an incumbent to go away before calling it a collision.
 *
 * `tsx watch` starts the successor as soon as it has signalled the old child, and
 * `shutdown()` below has a 1.5s exit fallback — so under Tilt the new bridge
 * legitimately meets a still-live predecessor. Without this wait, saving a file
 * would turn into a hard start failure. It doubles as the wait on the preempt path.
 */
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 100;

interface BridgeLock {
  pid: number;
  startedAt: number;
  /** null when this bridge does not relay — the lock is about the store too. */
  deviceId: string | null;
  /** LINES_INSTANCE of the holder: 'desktop' is the one we are allowed to preempt. */
  instance: string;
}

/** True unless the OS says nothing holds this pid. EPERM means alive but not ours. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Block this thread. Only ever called while deciding the lock, which happens
 * during module init: there is no listener to keep responsive yet, and an async
 * claim would let the rest of this module boot against a lock we may still refuse.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The lock as it is on disk, or null if it is absent, truncated or unparseable —
 *  all of which mean nothing is holding it. */
function readBridgeLock(): BridgeLock | null {
  try {
    const held = JSON.parse(fs.readFileSync(BRIDGE_LOCK_FILE, 'utf8')) as Partial<BridgeLock>;
    if (typeof held.pid !== 'number') return null;
    return {
      pid: held.pid,
      startedAt: typeof held.startedAt === 'number' ? held.startedAt : 0,
      deviceId: typeof held.deviceId === 'string' ? held.deviceId : null,
      instance: typeof held.instance === 'string' ? held.instance : 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * One bridge per machine, relaying or not.
 *
 * Two bridges sharing `device.json` both claim the same device, so the relay
 * supersedes one on every dial — and a superseded bridge that keeps writing
 * frames is what turned a freshly created session into a flicker loop between two
 * `hello` snapshots. But the lock is not relay-specific: `~/.lines-app` assumes a
 * sole writer (docs/codebase/features/app-data-root.md), so a purely local second
 * bridge is just as much a corruption risk.
 *
 * Three outcomes when the file already exists: take it (dead, corrupt or ours),
 * preempt it (the desktop app, which can stand down and re-arm itself), or refuse
 * and exit {@link EXIT_BRIDGE_LOCK_HELD}.
 *
 * Escape hatch for tests (and anyone deliberately running two):
 * LINES_ALLOW_MULTIPLE_BRIDGES=1 — which neither reads nor writes the file.
 */
function claimBridgeLock(deviceId: string | null): void {
  if (process.env.LINES_ALLOW_MULTIPLE_BRIDGES === '1') return;
  fs.mkdirSync(APP_ROOT, { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    deviceId,
    instance: INSTANCE,
  } satisfies BridgeLock);

  // 'wx' is the whole point: one atomic syscall for the uncontended case, instead
  // of a read followed by a write that two starting bridges can interleave.
  try {
    fs.writeFileSync(BRIDGE_LOCK_FILE, payload, { flag: 'wx' });
    armLockRelease();
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const held = readBridgeLock();
  // Dead, corrupt, or our own pid: nothing is holding the lock, so take it. A
  // corrupt file must never be the reason a user cannot start their bridge.
  if (!held || held.pid === process.pid || !pidAlive(held.pid)) {
    fs.writeFileSync(BRIDGE_LOCK_FILE, payload);
    armLockRelease();
    return;
  }

  // Only the tray app is preemptible: it is the one supervisor that can stand its
  // bridge down and bring it back when this one exits. Cross-check the published
  // runtime file before signalling — pids are reused, and the lock's word alone is
  // not enough to SIGTERM something.
  const preemptible =
    held.instance === 'desktop' && readRuntimeInfo('bridge', held.instance)?.pid === held.pid;
  if (preemptible) {
    console.warn(
      `[bridge] preempting the desktop app's bridge (pid ${held.pid}) — it stands down and re-arms ` +
        'itself once this bridge exits.',
    );
    try {
      process.kill(held.pid, 'SIGTERM');
    } catch {
      // It went away between the liveness check and the signal; the wait settles it.
    }
  }

  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    sleepSync(LOCK_POLL_MS);
    if (pidAlive(held.pid)) continue;
    // Its shutdown() removed the file, or it died without doing so: overwrite either way.
    fs.writeFileSync(BRIDGE_LOCK_FILE, payload);
    armLockRelease();
    return;
  }

  const since = held.startedAt ? new Date(held.startedAt).toISOString() : 'unknown start time';
  const role = held.deviceId ? `relaying as device ${held.deviceId}` : 'not relaying';
  console.error(
    `[bridge] another bridge already owns this machine: pid ${held.pid}, instance "${held.instance}", ` +
      `${role}, started ${since}.`,
  );
  console.error(
    `[bridge] stop that process, delete ${BRIDGE_LOCK_FILE} if it is already gone, or set ` +
      'LINES_ALLOW_MULTIPLE_BRIDGES=1 to run two bridges over one ~/.lines-app anyway.',
  );
  process.exit(EXIT_BRIDGE_LOCK_HELD);
}

/**
 * Give the lock up however we go away, so the next start doesn't have to reason
 * about a pid. Registered only after a successful claim: a refused start must
 * never touch the holder's file. Sync fs and pid-guarded, so 'exit' is safe.
 */
function armLockRelease(): void {
  process.on('exit', releaseBridgeLock);
}

function releaseBridgeLock(): void {
  try {
    const held = JSON.parse(fs.readFileSync(BRIDGE_LOCK_FILE, 'utf8')) as { pid?: number };
    if (held.pid === process.pid) fs.rmSync(BRIDGE_LOCK_FILE, { force: true });
  } catch {
    // Never ours to remove, or already gone.
  }
}

/**
 * Env first: the desktop app and the dev relay (RELAY_AUTH_DISABLED, where any
 * secret is accepted) both supply one explicitly. Otherwise fall back to this
 * machine's own identity file, minting it if absent — which is what lets the
 * bridge be started straight from Tilt or a terminal without a supervisor handing
 * it credentials, and keeps the secret out of any process spec.
 */
function resolveRelayIdentity(): { id: string; secret: string } {
  const stored =
    process.env.LINES_DEVICE_ID && process.env.LINES_DEVICE_SECRET ? null : deviceIdentity();
  return {
    id: process.env.LINES_DEVICE_ID ?? stored!.id,
    secret: process.env.LINES_DEVICE_SECRET ?? stored!.secret,
  };
}

const RELAY_URL = process.env.RELAY_URL;
// Resolved only when relaying: deviceIdentity() *mints* on read, and a local-only
// install must not grow a credential file it never uses.
const relayIdentity = RELAY_URL ? resolveRelayIdentity() : null;
// Unconditional, unlike the relay link: the sole-writer rule on ~/.lines-app
// applies to every bridge.
claimBridgeLock(relayIdentity?.id ?? null);
if (RELAY_URL) {
  new RelayClient(RELAY_URL, relayIdentity!.id, relayIdentity!.secret, {
    onChannel: (link, identity) => {
      // Never straight to handleConnection any more. A relay channel passes
      // through the e2ee gate first: an owner channel only reaches the bridge
      // once it has authenticated with a key this machine pinned itself, rather
      // than on the relay's say-so — from first launch, enrolled device or not.
      void bridgeIdentity()
        .then((self) => {
          const isGuest = !!identity.grant && identity.grant.scope !== 'owner';
          guardRelayChannel(link, self, isGuest, (secured, peerKey) => {
            void handleConnection(secured, {}, identity, peerKey);
          });
        })
        .catch((err) => {
          // No key, no channel: failing open here would restore exactly the
          // trust this removes.
          console.error('[e2ee] could not load this machine key:', err);
          link.close(1011, 'e2ee unavailable');
        });
    },
    onToken: (userId, token) => {
      // Only a user who owns a context here. A guest's token must never reach
      // this: `registry.get` MINTS a context, so a guest token would both create
      // ~/.lines-app/users/{guest} on someone else's machine and set a token that
      // pushes this machine's sessions into the guest's Postgres rows.
      //
      // The non-obvious half of the same guard in handleConnection — a guest's
      // token arrives here every ~50s from their browser's auth relay, so getting
      // handleConnection right and missing this would leak anyway.
      const ctx = registry.peek(userId);
      if (!ctx) return;
      ctx.clerkToken = token;
      // Same as the in-channel `auth` handler: a fresh token while storage is
      // down is the likely cure, so probe now. A no-op while the link is up.
      void ctx.sync.retryNow();
    },
    // Straight through to the desktop shell: it is the only consumer, and the
    // tray is the only place a user can see that this machine is reachable.
    onStatus: (status) => { devRelayConnected = status.connected; reportRelayStatus(status); },
  });
  console.log(`[relay] dialling ${RELAY_URL} as device ${relayIdentity!.id}`);
}

// If the worker never shows up, in-flight statuses loaded from disk are stale.
// Unless it did show up and we hung up on it over a protocol mismatch: that
// worker is alive and still running turns, so clearing would falsely idle them.
setTimeout(() => {
  if (devRuntime.held || worker.everConnected) return;
  if (worker.sawIncompatibleWorker) {
    console.warn('[worker] alive but incompatible — leaving in-flight session statuses alone');
    return;
  }
  console.warn('[worker] not reachable after 15s — clearing in-flight session statuses');
  registry.onWorkerLive([]);
}, 15_000).unref();


/** Handshakes waiting on their browser redirect. Per-bridge, in memory only. */
const mcpAuthPending = new McpAuthPending();

/** The port the OS actually gave us, needed to build the OAuth redirect URI. */
let boundPort = 0;

/** Path the MCP OAuth redirect comes back to. Also embedded in the auth URL. */
const MCP_OAUTH_CALLBACK_PATH = '/mcp-oauth/callback';

/** Bare page for the redirect landing — no app shell, and never echoes the code. */
function oauthPage(res: http.ServerResponse, status: number, heading: string, detail: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${heading}</title>` +
      `<body style="font:15px/1.5 system-ui;margin:0;display:grid;place-items:center;height:100vh">` +
      `<div style="max-width:32rem;padding:2rem;text-align:center">` +
      `<h1 style="font-size:1.1rem;margin:0 0 .5rem">${heading}</h1>` +
      `<p style="color:#555;margin:0">${detail}</p></div></body>`,
  );
}

/**
 * Completing an MCP OAuth handshake is the one thing besides the status page that
 * needs an HTTP surface here: an OAuth provider redirects a *browser*, so it
 * cannot carry the app's own token, and the flow cannot run over the WebSocket.
 *
 * `state` is therefore the only credential on this route. That is standard OAuth
 * CSRF defence and adequate — the value is 256-bit, minted by the CLI, matched in
 * constant time, single-use and TTL-bounded (see McpAuthPending) — but it is the
 * reason the handler below refuses anything it cannot match rather than trying to
 * be helpful, and never reflects the authorization code back into the page.
 */
async function handleOAuthCallback(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
  const state = url.searchParams.get('state') ?? '';
  const providerError = url.searchParams.get('error');
  const claimed = state ? mcpAuthPending.claim(state) : null;
  if (!claimed) {
    // Unknown, expired, or already used. Deliberately one message for all three:
    // distinguishing them tells an attacker which states exist.
    oauthPage(res, 400, 'This authorization link is no longer valid', 'Start the authorization again from Lines.');
    return;
  }
  const ctx = registry.peek(claimed.userId);
  if (!ctx) {
    claimed.onSettled?.({ ok: false, error: 'That Lines session is no longer loaded.' });
    oauthPage(res, 410, 'Authorization could not be completed', 'That Lines session is no longer loaded.');
    return;
  }
  if (providerError) {
    ctx.sessions.releaseAuthHold(claimed.sessionId);
    claimed.onSettled?.({
      ok: false,
      error: `${claimed.serverName} refused the authorization (${providerError}).`,
    });
    ctx.broadcast({
      type: 'mcpAuthCompleted',
      sessionId: claimed.sessionId,
      name: claimed.serverName,
      ok: false,
      error: `${claimed.serverName} refused the authorization (${providerError}).`,
    });
    oauthPage(res, 200, 'Authorization was declined', 'You can close this tab and try again from Lines.');
    return;
  }
  // Released only after the exchange settles, not before: the await below runs on
  // the query holding the PKCE verifier, and a token refresh landing inside it
  // would recycle that query out from under the handshake.
  const result = await ctx.sessions
    .completeMcpAuth(claimed.sessionId, claimed.serverName, url.toString())
    .finally(() => ctx.sessions.releaseAuthHold(claimed.sessionId));
  if ('error' in result) {
    claimed.onSettled?.({ ok: false, error: result.error });
    ctx.broadcast({
      type: 'mcpAuthCompleted',
      sessionId: claimed.sessionId,
      name: claimed.serverName,
      ok: false,
      error: result.error,
    });
    oauthPage(res, 200, 'Authorization could not be completed', 'Lines has the details — check the Connections pane.');
    return;
  }
  claimed.onSettled?.({ ok: true });
  ctx.broadcast({
    type: 'mcpAuthCompleted',
    sessionId: claimed.sessionId,
    name: claimed.serverName,
    ok: true,
    servers: result.servers,
  });
  oauthPage(res, 200, `${claimed.serverName} is connected`, 'You can close this tab and go back to Lines.');
}

/**
 * The bridge's HTTP surface: a status page, plus the MCP OAuth redirect landing
 * above. Workspace reads moved onto the WebSocket (see fileRoutes.ts), which
 * removed the Clerk token from query strings and left nothing else here needing
 * CORS or an auth gate.
 */
/**
 * The route `linesMcpStdio.ts` calls — how Lines' own tools reach a codex
 * session.
 *
 * Codex spawns every MCP server as a child process, so the in-process server the
 * Claude path uses has no equivalent there. The child is a thin proxy: it asks
 * here for the manifest and forwards each call here, which keeps one description
 * of the tool surface and one implementation of it.
 *
 * Authenticated with the per-boot runtime token, matched in constant time. That
 * token already gates the worker's control channel, lives in a 0600 file, and
 * changes on every restart — a stale child therefore fails closed rather than
 * acting on someone else's bridge.
 */
const LINES_MCP_PATH = '/lines-mcp';

function tokenMatches(presented: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(bridgeToken);
  // timingSafeEqual throws on a length mismatch, which is itself an answer.
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handleLinesMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const deny = (code: number, error: string) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error }));
  };
  const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!presented || !tokenMatches(presented)) return deny(401, 'unauthorized');
  if (req.method !== 'POST') return deny(405, 'method not allowed');

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A tool call is small. The cap is what stops a wedged child streaming the
    // bridge out of memory.
    if (size > 1_000_000) return deny(413, 'payload too large');
    chunks.push(chunk as Buffer);
  }
  let body: { op?: string; userId?: string; tool?: string; args?: Record<string, unknown> };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
  } catch {
    return deny(400, 'bad json');
  }

  // The caller names the user because one bridge can serve several, and each has
  // its own CODEX_HOME — so the config that spawned this child already knew which
  // one it belongs to. Resolved through the registry, never trusted as a path.
  // `peek`, not `get`: the id arrives from outside this process, and `get` would
  // build a context (and a store directory) for any string handed to it.
  const ctx = registry.peek(body.userId ?? LOCAL_USER);
  if (!ctx) return deny(404, 'no such user');

  if (body.op === 'manifest') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(LINES_TOOL_MANIFEST));
    return;
  }
  if (body.op !== 'call' || !body.tool) return deny(400, 'unknown op');

  // No session: codex names one MCP server for the whole CODEX_HOME, so a call
  // arriving here cannot say which thread made it. The two session-scoped tools
  // decline rather than guess — see McpToolSession.
  const result = await createMcpDispatcher(ctx)(body.tool, body.args ?? {});
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}

const server = http.createServer((req, res) => {
  if ((req.url ?? '').startsWith(LINES_MCP_PATH) && devRuntime.held) {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
    res.end(JSON.stringify({ error: DEV_UPDATING }));
    return;
  }
  if ((req.url ?? '').startsWith(LINES_MCP_PATH)) {
    void devRuntime.run(() => handleLinesMcp(req, res)).catch((err) => {
      console.warn('[lines-mcp] request failed:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    });
    return;
  }
  if ((req.url ?? '').startsWith(MCP_OAUTH_CALLBACK_PATH)) {
    void devRuntime.run(() => handleOAuthCallback(req, res)).catch((err) => {
      console.warn('[mcp-auth] callback failed:', err);
      if (!res.headersSent) oauthPage(res, 500, 'Something went wrong', 'Check the Lines bridge log.');
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, sessions: registry.get(LOCAL_USER).sessions.list().length, devRuntime: devRuntime.publicStatus }));
});

const wss = new WebSocketServer({ server });
// The ws library re-emits http server errors here; without a listener they crash the process.
wss.on('error', (err) => console.warn('[wss]', (err as Error).message));

wss.on('connection', (ws, req) => {
  void handleConnection(ws, req);
});

/**
 * `attested` is supplied for relay channels. It used to be the authorization
 * decision — the relay said who this was and the bridge granted owner access on
 * that word alone, so whoever ran the relay could drive any machine it brokered.
 * It is now a *routing hint*: which user's context to open, nothing more.
 *
 * What actually grants owner authority on a relay channel is `peerKey`: the
 * static key the channel authenticated against this machine's own enrolled list
 * (see e2eeChannel.ts). Direct sockets are unaffected — there is no relay in the
 * middle of one, and a loopback socket is the machine's own browser.
 */
async function handleConnection(
  ws: BrowserLink,
  req: { url?: string; socket?: { remoteAddress?: string } },
  attested?: AttestedIdentity,
  peerKey?: string | null,
) {
  let userId = LOCAL_USER;
  let clerkToken: string | null = null;
  if (attested) {
    userId = attested.userId;
    clerkToken = attested.clerkToken;
  } else if (AUTH_ENABLED) {
    // Hard gate: no valid Clerk token in the handshake query → close, no hello.
    const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    const verified = token ? await verifyClerkUserId(token) : null;
    if (!verified) {
      ws.close(1008, 'unauthorized');
      return;
    }
    userId = verified;
    clerkToken = token;
  }

  /**
   * Whose state this connection serves.
   *
   * A guest reaches the *host's running session*, not a copy of it: transcripts
   * and turns are host-local, so resolving a guest to their own context would
   * hand them an empty machine. `hostUserId` is the relay's attestation, and the
   * only thing that may pick a context other than the caller's own.
   */
  const grant = attested?.grant;
  const isGuest = !!grant && grant.scope !== 'owner';
  const hostUserId = isGuest ? grant.hostUserId : userId;
  // `get` on the host (their context is the point), never on the guest — see
  // registry.peek's comment. A guest that somehow arrives for a host with no
  // context yet gets one built for the *host*, which is correct: it is the host's
  // own data root either way.
  const ctx = registry.get(hostUserId);

  const access: SocketAccess = isGuest
    ? {
        scope: grant.scope,
        // Re-parsed rather than trusted as-is: the wire type is a loose record,
        // and parseShareCaps denies anything not explicitly true.
        caps: parseShareCaps(grant.caps),
        ...(grant.scope === 'session' ? { sessionIds: grant.sessionIds ?? [] } : {}),
        ownerProfile: grant.profile ?? null,
        viewerProfile: grant.viewerProfile ?? null,
      }
    : OWNER_ACCESS;

  // The E3 gate, stated once. The channel guard already refuses every
  // unauthenticated owner channel over the relay, so this
  // is the second lock on the same door: an owner grant over a relay needs a key
  // this machine pinned, never the relay's assertion about who is calling.
  if (attested && !isGuest && !peerKey) {
    console.warn('[e2ee] refused an unauthenticated owner channel');
    ws.close(1008, 'unauthorized');
    return;
  }

  const connId = randomUUID();
  // Only a loopback socket is this machine's own browser. `!attested` alone is
  // not enough — the listener binds every interface, so a direct socket may be
  // a laptop on the same LAN, which is as remote as the relay for anything that
  // opens a window here.
  const local = !attested && isLoopbackAddress(req.socket?.remoteAddress);
  conns.set(ws, { userId, connId, clerkToken, access, local, owner: !isGuest });
  // A guest's token is never installed on the host's context, and a guest never
  // triggers a sync: either would push this machine's sessions up under the
  // guest's Clerk identity, which is the worst outcome in this whole feature.
  if (clerkToken && !isGuest) {
    ctx.clerkToken = clerkToken;
    // Pull remote state (rate-limited inside) and push local state up.
    void ctx.syncNow();
  }
  ctx.sockets.set(ws, access);
  ws.send(JSON.stringify(buildHello(ctx, access, { local, encrypted: !!peerKey }, attested?.grant)));
  const helloAt = Date.now();
  console.log(
    `[ws] hello → ${connId.slice(0, 8)} user=${userId} ${attested ? 'relayed' : local ? 'local' : 'lan'}` +
      `${peerKey ? ' encrypted' : ''}${isGuest ? ' guest' : ''}`,
  );

  if (isGuest) {
    console.log(
      `[share] guest ${userId} attached to ${hostUserId} (${access.scope}${
        access.sessionIds ? `, ${access.sessionIds.length} session(s)` : ''
      })`,
    );
  }

  ws.on('close', () => {
    ctx.sockets.delete(ws);
    console.log(`[ws] link ${connId.slice(0, 8)} closed after ${Date.now() - helloAt}ms`);
    // Announce the departure before the socket is forgotten, or the avatar of
    // someone who closed their tab sits in everyone else's header forever.
    for (const sessionId of ctx.presence.drop(connId)) {
      ctx.broadcast({ type: 'presence', sessionId, viewers: ctx.presence.viewers(sessionId) });
    }
  });

  // Without this an unhandled 'error' on the socket's EventEmitter throws and
  // takes the whole bridge down. Loopback hides it; over a relay, per-socket
  // errors are routine. 'close' always follows, so cleanup stays there.
  ws.on('error', (err) => console.warn('[ws] socket error:', err.message));

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    handleMessage(ctx, ws, msg).catch((err) => {
      console.error('[ws] handler error:', err);
      const sessionId = 'sessionId' in msg ? (msg as { sessionId?: string }).sessionId : undefined;
      ws.send(
        JSON.stringify({
          type: 'error',
          sessionId,
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error && err.message === DEV_UPDATING && msg.type === 'prompt' ? { rejectedPrompt: msg } : {}),
        } satisfies ServerMessage),
      );
    });
  });
}

/**
 * The state snapshot a connection opens with.
 *
 * For the owner this is everything, unchanged. For a guest it is deliberately
 * thin: their sessions (scope-filtered), the health of the machine they are
 * borrowing, and what they may do — and *nothing* about the host's library,
 * account, settings or usage. Projects only for a machine share. That narrowing does double duty: a shared
 * machine's `hello` contributes only sessions, so a client holding two machines
 * at once never has to merge two sets of owner state.
 */
function buildHello(
  ctx: UserContext,
  access: SocketAccess,
  link: { local: boolean; encrypted: boolean },
  grant?: AttestedGrant,
): ServerMessage {
  const { local, encrypted } = link;
  const sessions =
    access.scope === 'session'
      ? ctx.sessions.list().filter((s) => access.sessionIds?.includes(s.id))
      : ctx.sessions.list();

  if (access.scope !== 'owner') {
    return {
      type: 'hello',
      bridge: { version: BRIDGE_VERSION, appProtocol: APP_PROTOCOL_VERSION },
      sessions,
      // Empty, not omitted: the client's reducer expects the keys, and an empty
      // list is the honest answer — a guest has no library on this machine.
      workflows: [],
      sharedWorkflows: [],
      steps: [],
      sharedSteps: [],
      pinnedSteps: [],
      recipes: [],
      sharedRecipes: [],
      recipeStats: {},
      models: DEFAULT_MODELS,
      recentDirs: [],
      // A machine share lends the whole machine, projects included — sessions are
      // created in them. A session share has no folder of its own to work in, so
      // it gets none and the client builds its tabs from the shared sessions.
      projects: access.scope === 'machine' ? ctx.store.loadProjects() : [],
      // Project *identity* only, which is machine-independent and is what lets a
      // shared session group under the project the guest already has open. It
      // names no path the guest may reach.
      projectKeys: ctx.projectKeys.all(),
      usage: null,
      // Both plan-usage chips are the host's business, not a guest's.
      openaiUsage: null,
      // As is what the host has spent, on any day.
      spendHistory: null,
      // The host's Claude account is theirs alone: a guest is told nothing about
      // it, not even the email. Turns run on the host's token regardless.
      auth: { loggedIn: false },
      // Same reasoning as the Claude row above: the host's OpenAI account is
      // theirs alone, and turns run on it regardless.
      openaiAuth: { loggedIn: false },
      storage: ctx.sync.status,
      worker: worker.status,
      // Unlike `claudeCli`, a guest is told: their dictation is transcribed on
      // this machine, so whether they get a mic button is this machine's answer.
      whisper: publicWhisperStatus(),
      // Always false in practice — a guest arrives over the relay — but sent
      // rather than omitted so the client reads one rule for every link.
      local,
      encrypted,
      access: {
        scope: access.scope,
        caps: access.caps,
        ...(access.sessionIds ? { sessionIds: access.sessionIds } : {}),
        ownerProfile: access.ownerProfile ?? grant?.profile ?? null,
        deviceId: relayIdentity?.id ?? null,
      },
    };
  }

  return {
    type: 'hello',
    bridge: { version: BRIDGE_VERSION, appProtocol: APP_PROTOCOL_VERSION },
    // Owner-only, like everything else below it: whoever this bridge stamps its
    // own writes as. The client prefers it over its Clerk id so a step it
    // publishes and the step the bridge stores agree on an owner.
    userId: ctx.userId,
    sessions,
    workflows: ctx.workflows.list(),
    sharedWorkflows: ctx.workflows.listShared(),
    steps: ctx.workflows.listSteps(),
    sharedSteps: ctx.workflows.listSharedSteps(),
    pinnedSteps: ctx.workflows.listPinnedSteps(),
    recipes: ctx.recipes.listRecipes(),
    sharedRecipes: ctx.recipes.listSharedRecipes(),
    // From the local cache, so counts render before the first pull lands (and
    // while storage is unreachable) instead of showing blanks.
    recipeStats: ctx.recipes.allStats(),
    models: DEFAULT_MODELS,
    recentDirs: ctx.store.loadRecentDirs(),
    projects: ctx.store.loadProjects(),
    projectKeys: ctx.projectKeys.all(),
    usage: ctx.usage.snapshot,
    openaiUsage: ctx.openaiUsage.snapshot,
    // This machine's ledger only — it is not synced, so a second machine's
    // browser merges rather than replaces (see the client's `fromPrimary` gate).
    spendHistory: ctx.spendHistory.snapshot,
    auth: ctx.auth.getStatus(),
    openaiAuth: ctx.openaiAuth.getStatus(),
    storage: ctx.sync.status,
    // So a browser connecting mid-outage learns about it without waiting for
    // the next transition (which may never come).
    worker: worker.status,
    // Same reason as `worker`, and owner-only: `installUpdate` is owner-gated,
    // and a guest has no business being told to update this machine.
    update: updates.current(),
    // Which CLI this machine's turns actually run on, for the Updates pane.
    // Owner-only like `update` above and narrowed the same way it is worded:
    // `publicClaudeCliStatus` drops `path`, which would leak the host's home
    // directory and username. Never spread `claudeCliStatus()` here.
    claudeCli: publicClaudeCliStatus(),
    // The other engine's, on the same terms: an OpenAI model is unusable without
    // it, and until this was on the wire the browser could only find that out by
    // running a turn and watching it fail.
    codexCli: publicCodexCliStatus(),
    // Voice input's transcriber, `path`s stripped the same way.
    whisper: publicWhisperStatus(),
    // Owner-only like `update`: a guest has no button that starts one.
    whisperModelDownload: whisperModelDownloadState(),
    settings: ctx.store.loadSettings(),
    // Owner-only like `settings`: whether routing can call out at all, for the
    // Settings notice. Never the key itself.
    smartRoutingAvailable: jevConfigured(),
    // Owner-only like `settings`: a guest may not subscribe (see MESSAGE_AUTHZ).
    pushAvailable: true,
    // Whether this link may drive a dialog that opens on this machine's screen.
    local,
    // Whether this link is end-to-end encrypted against a key this machine
    // pinned. False on a direct socket, where there is no relay to distrust.
    encrypted,
    guardAllowlist: ctx.guard.list(),
    // Read from persisted state, so a pending review is on screen before the
    // first pull lands (and survives the 30s pull spacing after a restart).
    guardAllowlistReview: ctx.guard.review(),
    // Same reasoning, and the same persisted source: a staged memory write is a
    // decision the user still owes, not a transient notification.
    memoryReview: ctx.memory.review(),
    // Header names only — `blob()`'s list is what the client ever sees, never a value.
    mcpConnections: ctx.mcp.list(),
    mcpConnectionsReview: ctx.mcp.review(),
  };
}

/**
 * Run one workflow tool call for the session's owner and answer the worker.
 * Failures come back as an error result rather than a rejection: the model is
 * waiting on this call, and a thrown bridge error would park its turn until the
 * worker's fallback fires.
 */
/**
 * The agent-driven half of the OAuth flow: leg 1, the sign-in card, and the wait
 * for the browser redirect to land — so `authorize_mcp_connection` can return
 * with the server's tools already usable in the same turn.
 *
 * Lives here rather than in the dispatcher because this is where the callback
 * route and the pending-handshake table are: the tool contributes the decision
 * to authorize, this contributes the plumbing. Same three legs the wire handler
 * for `authorizeMcpConnection` runs, with the browser's `mcpAuthStarted` reply
 * replaced by a card and a bounded wait.
 */
async function authorizeConnectionForAgent(
  ctx: UserContext,
  sessionId: string,
  serverName: string,
): Promise<McpAuthorizeOutcome> {
  const redirectUri = `http://127.0.0.1:${boundPort}${MCP_OAUTH_CALLBACK_PATH}`;
  const started = await ctx.sessions.startMcpAuth(sessionId, serverName, redirectUri);
  if ('error' in started) return { error: started.error };
  // The CLI already holds a token for this server: nothing to visit, and no
  // handshake to register or wait for.
  if ('alreadyAuthorized' in started) return { authorized: true, alreadyAuthorized: true };
  if (!started.state) {
    return {
      error: `${serverName} did not return an OAuth state parameter, so Lines cannot verify the callback safely. The user can authorize it from Settings → Connections.`,
    };
  }

  // Registered before the card is shown, so a fast redirect cannot beat the record.
  let settle: (result: McpAuthSettled) => void = () => {};
  const settled = new Promise<McpAuthSettled>((resolve) => {
    settle = resolve;
  });
  mcpAuthPending.start(started.state, {
    userId: ctx.userId,
    sessionId,
    serverName,
    onSettled: settle,
  });
  // Leg 2 runs against this same query — it holds the PKCE verifier — so exempt
  // it from idle recycling until the callback lands or the hold ages out.
  ctx.sessions.holdForAuth(sessionId);
  // The Connections pane shows the same link, for a user who is looking there.
  ctx.broadcast({ type: 'mcpAuthStarted', sessionId, name: serverName, authUrl: started.authUrl });

  const card = ctx.sessions.promptMcpAuthorization(sessionId, serverName, started.authUrl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race<McpAuthSettled | 'declined' | 'timed-out'>([
      settled,
      // "Done — I authorized it" is not itself proof: the redirect is the
      // authority, so an acknowledgement chains onto the handshake and only a
      // Cancel ends the wait early.
      card.answered.then<McpAuthSettled | 'declined'>((allow) => (allow ? settled : 'declined')),
      new Promise<'timed-out'>((resolve) => {
        timer = setTimeout(() => resolve('timed-out'), AGENT_AUTH_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (outcome === 'declined') {
      return { error: `The user cancelled the ${serverName} sign-in.` };
    }
    // Bounded well under PENDING_TTL_MS, so the link the user is holding is still
    // claimable: the tool says "call me again" rather than hanging on the turn.
    if (outcome === 'timed-out') return { pending: true };
    return outcome.ok ? { authorized: true } : { error: outcome.error ?? 'Authorization did not complete.' };
  } finally {
    clearTimeout(timer);
    // Whatever ended the wait, the card has no reason to stay on screen.
    card.close();
  }
}

async function handleMcpToolRpc(ctx: UserContext, rpc: WorkerRpc): Promise<void> {
  return devRuntime.run(() => handleMcpToolRpcImpl(ctx, rpc));
}

async function handleMcpToolRpcImpl(ctx: UserContext, rpc: WorkerRpc): Promise<void> {
  const toolName = String(rpc.payload.tool ?? '');
  const args = (rpc.payload.args ?? {}) as Record<string, unknown>;
  let result: McpToolResult;
  try {
    result = await createMcpDispatcher(ctx, {
      sessionId: rpc.sessionId,
      authorize: (serverName) => authorizeConnectionForAgent(ctx, rpc.sessionId, serverName),
    })(toolName, args);
  } catch (err) {
    console.error('[mcp]', toolName, err);
    result = {
      content: [{ type: 'text', text: `Lines could not run ${toolName}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
  worker.rpcResult(rpc.id, result);
}

/** One wording for every refusal `McpConnections` can return. */
function sendMcpError(ws: BrowserLink, reason: string): void {
  ws.send(
    JSON.stringify({
      type: 'error',
      message: `Cannot save that connection (${reason})`,
    } satisfies ServerMessage),
  );
}

async function handleMessage(ctx: UserContext, ws: BrowserLink, msg: ClientMessage): Promise<void> {
  // Heartbeats and presence cannot start work and must not prevent an idle window.
  if (msg.type === 'ping' || msg.type === 'presence') return handleMessageImpl(ctx, ws, msg);
  return devRuntime.run(() => handleMessageImpl(ctx, ws, msg));
}

async function handleMessageImpl(ctx: UserContext, ws: BrowserLink, msg: ClientMessage): Promise<void> {
  const { sessions, workflows, recipes, store, auth, broadcast } = ctx;

  /**
   * One gate, before the switch, for every message.
   *
   * The owner passes straight through — `authorizeMessage` returns ok for
   * OWNER_ACCESS on its first line, so the unshared path costs one lookup. A
   * guest is checked against MESSAGE_AUTHZ, their capabilities, and (for
   * session-scoped messages) whether the session is inside their grant.
   *
   * A missing ConnState means a socket we never registered, which should be
   * impossible — denied rather than defaulted to the owner.
   */
  const conn = conns.get(ws);
  const verdict = conn
    ? authorizeMessage(msg, conn.access)
    : ({ ok: false, reason: 'This connection is not authorized.' } as const);
  if (!verdict.ok) {
    const sessionId = 'sessionId' in msg ? (msg as { sessionId?: string }).sessionId : undefined;
    // One line, matching the [permission] convention: a denial is worth seeing in
    // the host's log, and silence here would make a guest's "nothing happens"
    // unexplainable from either side.
    console.warn(`[share] denied ${msg.type} from ${conn?.userId ?? 'unknown'}: ${verdict.reason}`);
    ws.send(JSON.stringify({ type: 'error', sessionId, message: verdict.reason } satisfies ServerMessage));
    return;
  }
  // Narrowed by the guard above: no ConnState means we already returned.
  const access = conn!.access;
  /**
   * Who is acting, for attribution. Taken from the connection's attested identity
   * — never from the message body, so a prompt cannot claim to be someone else's.
   *
   * Recorded for the owner too, not just guests. Leaving it off meant a prompt's
   * author was *inferred* from whoever was reading it later ("no actor means the
   * host"), so the same message could render as two different people — and if a
   * client's notion of itself was wrong, attribution lied confidently. The userId
   * is the load-bearing part; `name` may be null here (the bridge has no Clerk
   * lookup for its own owner) and the client resolves it from what it knows.
   */
  const actor: Actor = {
    userId: conn!.userId,
    name: access.viewerProfile?.name ?? access.viewerProfile?.email ?? null,
    imageUrl: access.viewerProfile?.imageUrl ?? null,
  };

  switch (msg.type) {
    case 'ping':
      // App-level heartbeat: browsers can't send WS protocol pings, so we answer this.
      ws.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage));
      break;
    case 'installUpdate':
      // Refused while any session is active — a restart kills in-flight turns.
      // The reply is the status itself, so the UI shows why nothing happened.
      updates.requestRestart();
      ws.send(JSON.stringify({ type: 'updateStatus', status: updates.current() } satisfies ServerMessage));
      break;
    case 'presence': {
      // Identity comes from the connection, never the message: the body carries
      // only what they are looking at, so a client cannot present as anyone else.
      const changed = ctx.presence.signal({
        sessionId: msg.sessionId,
        connId: conn!.connId,
        userId: conn!.userId,
        // Null for the machine's owner — the client knows its own name from
        // Clerk, and a guest's is attested by storage via the grant.
        profile: access.viewerProfile ?? null,
        viewing: msg.viewing,
        focused: msg.focused,
      });
      // Only sessions whose viewer list actually changed: a repeated identical
      // heartbeat must not fan a broadcast out to every watcher.
      for (const sessionId of changed) {
        broadcast({ type: 'presence', sessionId, viewers: ctx.presence.viewers(sessionId) });
      }
      break;
    }
    case 'fileRequest': {
      // Replies on the originating link, never via broadcast: two tabs each have
      // their own in-flight reqIds.
      const { status, body } = await handleFileRequest(ctx, msg.kind, msg.params, access);
      ws.send(JSON.stringify({ type: 'fileResponse', reqId: msg.reqId, status, body } satisfies ServerMessage));
      break;
    }
    case 'auth': {
      // Fresh-token relay — the only thing that keeps storage sync alive between
      // reconnects, since a hello-time token is good for only ~60s.
      //
      // A relayed connection already trusts its hello-time token unconditionally
      // (attested.clerkToken above, no AUTH_ENABLED check at all — the relay is
      // who verified it). This reuses that exact trust boundary: nothing about
      // holding this already-open, already-authorized socket changes on a
      // refresh, and every other message on it is already trusted the same way.
      // A local connection has no relay standing behind it, so it re-verifies
      // through Clerk directly — gated on AUTH_ENABLED like the hello was —
      // which is what actually catches a revoked session within one relay cycle.
      // CLERK_SECRET_KEY is a server secret and never ships to a user's
      // machine, so AUTH_ENABLED is false on every real desktop install; before
      // this, that silently dropped every relayed refresh, not just the local
      // recheck it was meant to gate.
      const conn = conns.get(ws);
      if (!conn) break;
      if (conn.local) {
        if (!AUTH_ENABLED) break;
        const verified = await verifyClerkUserId(msg.token);
        if (verified !== conn.userId) {
          ws.close(1008, 'unauthorized');
          break;
        }
      }
      conn.clerkToken = msg.token;
      ctx.clerkToken = msg.token;
      // A new token while storage is down is the likely cure: probe now rather
      // than on the next tick. Owner only, a guest never drives host sync.
      if (conn.owner) void ctx.sync.retryNow();
      break;
    }
    case 'createSession': {
      // The work tree is cut first and awaited: cwd is identity (project-key
      // anchor, recentDirs, roots, attribution) and is never rewritten, so it has
      // to be the work tree from the very first upsert. A failed add therefore
      // creates no session at all — one `error` message, no half state.
      const worktree = msg.worktree
        ? await worktreeCommands.worktreeForNewSession(ctx, msg.cwd, msg.worktree)
        : null;
      const meta = sessions.createSession({
        name: msg.name,
        cwd: worktree?.path ?? msg.cwd,
        model: msg.model,
        permissionMode: msg.permissionMode,
        reasoningEffort: msg.reasoningEffort,
      });
      // Only nameable once the session exists; nothing depends on it beyond the
      // UI's "orphaned" label.
      if (worktree) worktreeCommands.attachSession(ctx, worktree.path, meta.id);
      // attach() re-broadcasts the session with workflow state populated.
      if (msg.workflowId) workflows.attach(meta.id, msg.workflowId);
      break;
    }
    case 'deleteSession':
      sessions.deleteSession(msg.sessionId);
      break;
    case 'prompt': {
      // A workflow-attached session consumes its first prompt as the task description.
      // Both take the actor: they intercept the prompt before userPrompt sees it,
      // so without it every prompt in a workflow-driven session — which is most of
      // them — would be recorded with no author at all.
      if (workflows.startIfPending(msg.sessionId, msg.text, msg.attachments, actor)) break;
      // A prompt sent while a step is parked iterates on that same step.
      if (workflows.iterateIfWaiting(msg.sessionId, msg.text, msg.attachments, actor)) break;
      sessions.userPrompt(msg.sessionId, msg.text, msg.attachments, msg.mentions, {
        needsApproval: access.caps.promptNeedsApproval,
        actor,
        draft: msg.draft,
      });
      break;
    }
    case 'interrupt':
      sessions.interrupt(msg.sessionId);
      break;
    case 'stopBackgroundTasks':
      sessions.stopBackgroundTasks(msg.sessionId);
      break;
    case 'retryTurn':
      // A failed workflow step re-runs through the engine, which knows whether to
      // re-render the step or re-send its prompt; anything else is a plain re-send.
      if (workflows.retryIfFailed(msg.sessionId)) break;
      sessions.retryTurn(msg.sessionId);
      break;
    case 'continueTurn':
      sessions.continueTurn(msg.sessionId);
      break;
    case 'cancelQueued':
      sessions.cancelQueued(msg.sessionId, msg.queuedId);
      break;
    case 'editQueued': {
      // The cap gate already ran; this can still refuse on the item (not yours to
      // rewrite, already flushed, nothing left after the edit).
      const edit = sessions.editQueued(msg.sessionId, msg.queuedId, msg, {
        actor,
        isOwner: access.scope === 'owner',
      });
      if (!edit.ok) {
        ws.send(
          JSON.stringify({
            type: 'error',
            sessionId: msg.sessionId,
            message: edit.reason,
          } satisfies ServerMessage),
        );
      }
      break;
    }
    case 'interjectQueued': {
      const res = sessions.interjectQueued(msg.sessionId, msg.queuedId, {
        actor,
        needsApproval: access.caps.promptNeedsApproval,
      });
      // 'settled' means the turn ended between the click and this arriving. The
      // item is still queued and maybeFlush is about to send it — not an error
      // worth putting on screen.
      if (!res.ok && res.code === 'refused') {
        ws.send(
          JSON.stringify({
            type: 'error',
            sessionId: msg.sessionId,
            message: res.reason,
          } satisfies ServerMessage),
        );
      }
      break;
    }
    case 'ackSession':
      sessions.ackSession(msg.sessionId);
      break;
    case 'archiveSession':
      sessions.archiveSession(msg.sessionId);
      break;
    case 'unarchiveSession':
      sessions.unarchiveSession(msg.sessionId);
      break;
    case 'completeSession':
      sessions.completeSession(msg.sessionId);
      break;
    case 'setModel': {
      // A cross-provider switch on a session that has already run is refused —
      // nothing carries the conversation across, so the user has to hear why.
      const verdict = sessions.setModel(msg.sessionId, msg.model);
      // A person chose this model: routing stops overriding it (see
      // pauseRoutingForManualChange — never set by routing's own setModel).
      if (verdict.ok) sessions.pauseRoutingForManualChange(msg.sessionId);
      if (!verdict.ok) {
        ws.send(
          JSON.stringify({
            type: 'error',
            sessionId: msg.sessionId,
            message: verdict.reason,
          } satisfies ServerMessage),
        );
      }
      break;
    }
    case 'switchProvider': {
      // The deliberate way past that refusal: the conversation is dropped and the
      // new model is seeded with a summary of it. The cap gate already ran for
      // `interrupt`; the `setModel` half and the held-guest case are decided
      // inside, since the table carries only one cap.
      const verdict = await sessions.switchProvider(msg.sessionId, msg.model, {
        actor,
        canSetModel: access.caps.setModel,
        needsApproval: access.caps.promptNeedsApproval,
      });
      // The block reason is written for a human — surfaced verbatim, on the same
      // channel setModel's refusal uses.
      if (!verdict.ok) {
        ws.send(
          JSON.stringify({
            type: 'error',
            sessionId: msg.sessionId,
            message: verdict.reason,
          } satisfies ServerMessage),
        );
      }
      break;
    }
    case 'setReasoningEffort':
      // No verdict to report: unlike a model change, effort never strands a
      // conversation, so there is nothing to refuse.
      sessions.setReasoningEffort(msg.sessionId, msg.effort);
      sessions.pauseRoutingForManualChange(msg.sessionId);
      break;
    case 'routingChoice':
      sessions.routingChoice(msg.sessionId, msg.accept);
      break;
    case 'setRoutingPaused':
      sessions.setRoutingPaused(msg.sessionId, msg.paused);
      break;
    case 'setPermissionMode':
      sessions.setPermissionMode(msg.sessionId, msg.mode);
      break;
    case 'permissionResponse': {
      /**
       * Plan comments are model-visible input, which is what the `prompt` cap
       * governs — this message only needs `approvePermissions`. So the approve or
       * deny itself always goes through, and the comments are dropped for anyone
       * who could not have typed them into the composer instead. Asked through
       * `authorizeMessage` rather than re-derived, so the owner short-circuit and
       * the session-scope check stay single-sourced with MESSAGE_AUTHZ.
       *
       * `promptNeedsApproval` is refused for the same reason interjectQueued
       * refuses it on its first line: a guest whose prompts wait for the owner
       * must not reach the owner's running turn by another door.
       */
      const mayPrompt =
        authorizeMessage({ type: 'prompt', sessionId: msg.sessionId, text: '' }, access).ok &&
        !access.caps.promptNeedsApproval;
      sessions.resolvePermission(
        msg.sessionId,
        msg.requestId,
        msg.allow,
        msg.updatedInput,
        msg.answers,
        msg.denyMessage,
        msg.alwaysAllow,
        'user',
        actor,
        mayPrompt ? normalizePlanComments(msg.planComments) : [],
      );
      break;
    }
    case 'workflowApprove':
      workflows.approve(msg.sessionId, msg.stepIndex);
      break;
    case 'workflowForceAdvance':
      workflows.forceAdvance(msg.sessionId, msg.stepIndex);
      break;
    case 'workflowStartStep':
      workflows.startStep(msg.sessionId, msg.stepIndex);
      break;
    case 'workflowRetry':
      workflows.retry(msg.sessionId, msg.stepIndex, msg.feedback);
      break;
    // The four workflow mutations and the version read below go through
    // workflowCommands.ts, which the session's own MCP tools also call — so the
    // two surfaces are the same code path rather than two that look alike.
    case 'saveWorkflow':
      workflowCommands.saveWorkflow(ctx, { workflow: msg.workflow, ownerName: msg.ownerName });
      break;
    case 'deleteWorkflow':
      workflowCommands.deleteWorkflow(ctx, msg.workflowId);
      break;
    case 'saveStep':
      workflowCommands.saveStep(ctx, {
        step: msg.step,
        stepId: msg.stepId,
        published: msg.published,
        ownerName: msg.ownerName,
      });
      break;
    case 'deleteStep':
      workflowCommands.deleteStep(ctx, msg.stepId);
      break;
    case 'stepVersions': {
      // Ping→pong: pull remote history (if online), adopt it so re-pins resolve, reply to this socket.
      const versions = await workflowCommands.stepVersionsView(ctx, msg.ownerId, msg.stepId);
      ws.send(
        JSON.stringify({
          type: 'stepVersions',
          ownerId: msg.ownerId,
          stepId: msg.stepId,
          versions,
        } satisfies ServerMessage),
      );
      break;
    }
    case 'saveRecipe':
      recipes.saveRecipe(msg.recipe, msg.recipeId, msg.published, msg.ownerName);
      break;
    case 'deleteRecipe':
      // Both legs: the engine drops it locally and broadcasts, but an upsert
      // broadcast cannot express a removal, so storage is told separately.
      recipes.deleteRecipe(msg.recipeId);
      ctx.sync.deleteRecipe(msg.recipeId);
      break;
    case 'recipeVersions': {
      // Ping→pong, as stepVersions: pull remote history (if online), adopt it, reply to this socket.
      const versions = await recipeCommands.recipeVersionsView(ctx, msg.ownerId, msg.recipeId);
      ws.send(
        JSON.stringify({
          type: 'recipeVersions',
          ownerId: msg.ownerId,
          recipeId: msg.recipeId,
          versions,
        } satisfies ServerMessage),
      );
      break;
    }
    case 'uploadRecipeImage': {
      const url = await ctx.sync.uploadRecipeImage({
        name: msg.name,
        mediaType: msg.mediaType,
        data: msg.data,
      });
      ws.send(
        JSON.stringify({ type: 'recipeImageUploaded', uploadId: msg.uploadId, url } satisfies ServerMessage),
      );
      break;
    }
    case 'registerPush':
      // Refused rather than stored when the endpoint is not a known push service
      // or a key is malformed: the bridge POSTs to that URL on every alert.
      if (!ctx.pushNotifier.register({ subscription: msg.subscription, vapid: msg.vapid })) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'This machine could not register the device for notifications.',
          } satisfies ServerMessage),
        );
      }
      break;
    case 'unregisterPush':
      ctx.pushNotifier.unregister(msg.endpoint);
      break;
    case 'installWhisperModel':
      // Fire and forget: progress and the outcome are broadcast (see
      // onWhisperModelDownload below), so a second tab watches the same bar.
      startWhisperModelDownload(msg.file);
      break;
    case 'transcribe': {
      // Answered on the asking link only, and always answered: a failure is a
      // `transcription` with an error rather than a thrown `error`, which carries
      // no requestId and would leave the composer waiting on its timeout.
      let reply: ServerMessage;
      try {
        reply = {
          type: 'transcription',
          requestId: msg.requestId,
          text: await transcribe(msg.audio, { language: msg.language, translate: msg.translate }),
        };
      } catch (err) {
        reply = {
          type: 'transcription',
          requestId: msg.requestId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      ws.send(JSON.stringify(reply satisfies ServerMessage));
      break;
    }
    case 'runRecipe': {
      // The whole run lives in recipeCommands: its ordering (refuse before any
      // side effect, count last) is the part that must not be re-derived here.
      const sessionId = recipeCommands.runRecipe(ctx, msg);
      // null = the cooldown swallowed a repeated click; nothing to answer.
      if (!sessionId) break;
      // Answered on the originating socket so the web selects the new session
      // deterministically instead of leaning on its new-session heuristic.
      ws.send(JSON.stringify({ type: 'recipeRun', runId: msg.runId, sessionId } satisfies ServerMessage));
      break;
    }
    case 'openProject': {
      const dir = normalizeRootPath(msg.path) || '/';
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`Not a directory: ${dir}`);
      }
      const projects = store.loadProjects();
      if (!projects.some((p) => p.path === dir)) {
        projects.push({ path: dir });
        store.saveProjects(projects);
      }
      store.addRecentDir(dir);
      // Broadcasts the key map itself when this checkout is newly identified.
      ctx.projectKeys.learn(dir);
      broadcast({ type: 'projects', projects });
      // Fire-and-forget: git is the source of truth for work trees, so reopening a
      // project is where records for deleted directories are dropped and work trees
      // created outside Lines (an agent running `git worktree add`) are adopted.
      void worktreeCommands.reconcileWorktrees(ctx, dir).catch((err) => {
        console.warn('[worktrees] reconcile failed:', err);
      });
      break;
    }
    case 'closeProject': {
      // Normalized first: openProject normalizes and close never did, so a
      // trailing slash from the client used to close nothing at all.
      const dir = normalizeRootPath(msg.path) || '/';
      const projects = store.loadProjects().filter((p) => p.path !== dir);
      store.saveProjects(projects);
      broadcast({ type: 'projects', projects });
      break;
    }
    case 'addProjectRoot': {
      const target = normalizeRootPath(msg.project) || '/';
      const root = normalizeRootPath(msg.path) || '/';
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error(`Not a directory: ${root}`);
      }
      const projects = store.loadProjects();
      const project = projects.find((p) => p.path === target);
      if (!project) throw new Error(`Not an open project: ${target}`);
      // One root, one owner — otherwise a /tree hit or a project key would be
      // ambiguous about which tab it belongs to.
      const owner = projects.find((p) => projectRoots(p).includes(root));
      if (owner) throw new Error(`Already a folder of ${owner.path}`);
      // Nested roots would double every tree and find hit under the overlap.
      const nested = projectRoots(project).find(
        (existing) => root === existing || root.startsWith(existing + path.sep) || existing.startsWith(root + path.sep),
      );
      if (nested) throw new Error(`Overlaps an existing folder: ${nested}`);
      project.extraRoots = [...(project.extraRoots ?? []), root];
      store.saveProjects(projects);
      store.addRecentDir(root);
      ctx.projectKeys.learn(root);
      // Already-spawned queries rebuild their options — and so pick up the new
      // additionalDirectories — at their next push; `resume` keeps the context.
      // The guard needs no nudge: it resolves the roots per call.
      ctx.sessions.recycleIdleQueries();
      broadcast({ type: 'projects', projects });
      break;
    }
    case 'removeProjectRoot': {
      const target = normalizeRootPath(msg.project) || '/';
      const root = normalizeRootPath(msg.path) || '/';
      const projects = store.loadProjects();
      const project = projects.find((p) => p.path === target);
      if (!project) break;
      project.extraRoots = (project.extraRoots ?? []).filter((r) => r !== root);
      if (!project.extraRoots.length) delete project.extraRoots;
      store.saveProjects(projects);
      // The learned project key stays: the registry deliberately never forgets a
      // path's identity, so re-adding the folder resolves it without another git call.
      ctx.sessions.recycleIdleQueries();
      broadcast({ type: 'projects', projects });
      break;
    }
    // Both delegate to worktreeCommands, which the createSession path above also
    // uses. Throws land in the existing handleMessage(...).catch → {type:'error'}
    // envelope, so git's refusal text reaches the browser with no new error path.
    case 'createWorktree':
      await worktreeCommands.createWorktree(ctx, msg);
      break;
    case 'removeWorktree':
      await worktreeCommands.removeWorktree(ctx, msg);
      break;
    case 'linkProjectPath': {
      // Binds a path this machine can't resolve (a checkout that lives only on
      // another install) to a known key, so its sessions group with the rest.
      const dir = normalizeRootPath(msg.path) || '/';
      if (msg.key) ctx.projectKeys.set(dir, msg.key);
      break;
    }
    case 'pickFolder': {
      // The dialog opens on *this* machine's screen. Asked for from anywhere
      // else it would hang a remote user for the full 120s timeout while a
      // Finder window nobody can see waits on an empty desk. An owner channel is
      // let through too: the desktop shell's own window arrives relayed, and
      // only the client knows it sits at the host. Not an authz boundary — an
      // owner already runs agent commands here.
      const conn = conns.get(ws);
      if (!conn?.local && !conn?.owner) {
        ws.send(JSON.stringify({ type: 'folderPicked', path: null } satisfies ServerMessage));
        break;
      }
      const path = await pickFolderNative();
      ws.send(JSON.stringify({ type: 'folderPicked', path } satisfies ServerMessage));
      break;
    }
    case 'authStartLogin': {
      const { authorizeUrl } = auth.startLogin();
      ws.send(JSON.stringify({ type: 'authLoginStarted', authorizeUrl } satisfies ServerMessage));
      break;
    }
    case 'authCompleteLogin':
      try {
        await auth.completeLogin(msg.code);
      } catch (err) {
        // Dedicated message (not the generic 'error') so the login modal can show it inline.
        ws.send(
          JSON.stringify({
            type: 'authError',
            message: err instanceof Error ? err.message : String(err),
          } satisfies ServerMessage),
        );
      }
      break;
    case 'authLogout':
      auth.logout();
      break;
    case 'openaiStartLogin':
      try {
        const { verificationUrl, userCode } = await ctx.openaiAuth.startLogin();
        // To the requesting socket only, exactly as `authLoginStarted` is: the
        // code is a one-time secret and belongs to the browser that asked.
        ws.send(
          JSON.stringify({
            type: 'openaiLoginStarted',
            verificationUrl,
            userCode,
          } satisfies ServerMessage),
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: 'openaiAuthError',
            message: err instanceof Error ? err.message : String(err),
          } satisfies ServerMessage),
        );
      }
      break;
    case 'openaiCancelLogin':
      // Stops the poll loop. Without it an abandoned login keeps polling OpenAI
      // until the device code expires.
      ctx.openaiAuth.cancelLogin();
      break;
    case 'openaiLogout':
      // Awaited: the best-effort revoke runs before the local credential is gone,
      // and the broadcast that follows is what updates every tab.
      await ctx.openaiAuth.logout();
      break;
    case 'saveSettings': {
      // LWW: an out-of-order save from a stale tab must not clobber newer state.
      const local = store.loadSettings();
      const incoming = { ...msg.settings, updatedAt: msg.settings.updatedAt ?? Date.now() };
      if ((incoming.updatedAt ?? 0) <= (local?.updatedAt ?? 0)) break;
      // A routing rule that could move a turn across providers or onto an
      // unknown model/effort is refused; the rest of the save still lands.
      const routingIssues = smartRoutingIssues(incoming.smartRouting);
      if (routingIssues.length) {
        incoming.smartRouting = local?.smartRouting;
        if (!incoming.smartRouting) delete incoming.smartRouting;
        ws.send(
          JSON.stringify({
            type: 'error',
            message: `Smart routing not saved: ${routingIssues.join('; ')}`,
          } satisfies ServerMessage),
        );
      }
      store.saveSettings(incoming);
      ctx.sync.pushSettings(incoming);
      // Other tabs of this user follow along; the sender applies idempotently.
      broadcast({ type: 'settings', settings: incoming });
      break;
    }
    case 'addGuardAllow': {
      // Broadcasts and pushes through guard.onChange. The client runs the same
      // shared validators, so a rejection here is version skew — the generic error
      // envelope is enough, and a duplicate is a no-op worth no message at all.
      const result = ctx.guard.add(msg.entry);
      if (!result.ok && result.reason !== 'duplicate') {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: `Cannot allowlist that entry (${result.reason})`,
          } satisfies ServerMessage),
        );
      }
      break;
    }
    case 'removeGuardAllow':
      ctx.guard.remove(msg.entry);
      break;
    case 'reviewGuardAllowlist':
      if (msg.accept) ctx.guard.acceptReview();
      else ctx.guard.rejectReview();
      break;
    case 'reviewMemory':
      // Accept is the only path that writes a pulled memory file to this disk.
      if (msg.accept) ctx.memory.acceptReview();
      else ctx.memory.rejectReview();
      break;
    case 'addMcpConnection': {
      // Broadcasts and pushes through mcp.onChange. The client runs the same
      // shared validator, so a rejection here is version skew — except for the
      // two the client cannot check (a name already taken, the list being full).
      const result = ctx.mcp.add(msg.connection, msg.headers);
      if (!result.ok) sendMcpError(ws, result.reason);
      break;
    }
    case 'updateMcpConnection': {
      const result = ctx.mcp.update(msg.id, msg.connection, msg.headers);
      if (!result.ok) sendMcpError(ws, result.reason);
      break;
    }
    case 'removeMcpConnection':
      ctx.mcp.remove(msg.id);
      break;
    case 'reviewMcpConnections':
      if (msg.accept) ctx.mcp.acceptReview();
      else ctx.mcp.rejectReview();
      break;
    case 'authorizeMcpConnection': {
      // Loopback, because that is what the CLI's OAuth client registers and what
      // the provider redirects to. It follows that the browser doing the
      // authorizing has to be on this machine — a relayed browser elsewhere
      // cannot reach it, which the UI says out loud rather than hanging.
      const redirectUri = `http://127.0.0.1:${boundPort}${MCP_OAUTH_CALLBACK_PATH}`;
      const started = await sessions.startMcpAuth(msg.sessionId, msg.name, redirectUri);
      if ('error' in started) {
        ws.send(
          JSON.stringify({
            type: 'mcpAuthStarted',
            sessionId: msg.sessionId,
            name: msg.name,
            error: started.error,
          } satisfies ServerMessage),
        );
        break;
      }
      // Nothing to visit and no callback coming: the CLI already holds a token
      // for this server. Answered as a success, and deliberately without
      // registering a pending state — there is no handshake to claim.
      if ('alreadyAuthorized' in started) {
        ws.send(
          JSON.stringify({
            type: 'mcpAuthStarted',
            sessionId: msg.sessionId,
            name: msg.name,
            alreadyAuthorized: true,
          } satisfies ServerMessage),
        );
        break;
      }
      // Register before answering, so a fast redirect cannot beat the record.
      // No state means the provider will not echo one, and without it the
      // callback route has nothing to authenticate — refuse rather than accept an
      // unauthenticated exchange.
      if (!started.state) {
        ws.send(
          JSON.stringify({
            type: 'mcpAuthStarted',
            sessionId: msg.sessionId,
            name: msg.name,
            error: 'That server did not return an OAuth state parameter, so Lines cannot verify the callback safely.',
          } satisfies ServerMessage),
        );
        break;
      }
      mcpAuthPending.start(started.state, {
        userId: ctx.userId,
        sessionId: msg.sessionId,
        serverName: msg.name,
      });
      // Leg 2 must run against this same query — it holds the PKCE verifier — so
      // exempt it from idle recycling until the callback lands or the hold ages
      // out on the same clock the pending handshake does.
      sessions.holdForAuth(msg.sessionId);
      ws.send(
        JSON.stringify({
          type: 'mcpAuthStarted',
          sessionId: msg.sessionId,
          name: msg.name,
          authUrl: started.authUrl,
        } satisfies ServerMessage),
      );
      break;
    }
    case 'mcpServerStatus': {
      // Answered on the asking link only, not broadcast: it names the host's
      // configured servers, and a session guest has no business with those.
      const servers = await sessions.mcpServerStatus(msg.sessionId, { warm: msg.warm === true });
      ws.send(
        JSON.stringify({
          type: 'mcpServerStatus',
          sessionId: msg.sessionId,
          servers,
        } satisfies ServerMessage),
      );
      break;
    }
    case 'contextBreakdown': {
      // Resolves null rather than throwing: a failed control request must not pop
      // the generic error toast every time the user hovers the chip.
      const breakdown = await sessions.fetchContextBreakdown(msg.sessionId);
      ws.send(
        JSON.stringify({
          type: 'contextBreakdown',
          sessionId: msg.sessionId,
          breakdown,
        } satisfies ServerMessage),
      );
      break;
    }
    case 'compactContext': {
      const result = sessions.compactContext(msg.sessionId);
      // The block reason is written for a human — surface it verbatim rather than
      // inventing a second wording for the same gate the button already reads.
      if (!result.ok) {
        ws.send(
          JSON.stringify({
            type: 'error',
            sessionId: msg.sessionId,
            message: result.reason,
          } satisfies ServerMessage),
        );
      }
      break;
    }
    case 'rewindSession': {
      const result = await sessions.rewindSession(msg.sessionId, msg.seq, { edit: msg.edit });
      // The block reason is written for a human — surfaced verbatim, exactly as
      // compactContext does with the gate its own button already reads.
      if (!result.ok) {
        ws.send(
          JSON.stringify({
            type: 'error',
            sessionId: msg.sessionId,
            message: result.reason,
          } satisfies ServerMessage),
        );
        break;
      }
      // The prompt goes back to whoever asked (it belongs in *their* composer) and
      // only when they asked to edit. The `transcriptTruncated` fan-out is not sent
      // from here: rewindSession broadcasts it itself, so it cannot be ordered
      // after the events a workflow rollback emits (see SessionManager.onRewind).
      if (result.prompt) {
        ws.send(
          JSON.stringify({
            type: 'rewound',
            sessionId: msg.sessionId,
            seq: msg.seq,
            prompt: result.prompt,
          } satisfies ServerMessage),
        );
      }
      break;
    }
    case 'loadTranscript': {
      const started = PERF ? performance.now() : 0;
      const lines = store.loadTranscriptRaw(msg.sessionId);
      const frame = transcriptFrame(msg.sessionId, lines);
      ws.send(frame);
      if (PERF) {
        console.log(
          `[perf] transcript ${msg.sessionId} ${lines.length} events ${frame.length}B ` +
            `${(performance.now() - started).toFixed(1)}ms`,
        );
      }
      break;
    }
    default: {
      // Unreachable while the switch above is exhaustive — but a client *newer*
      // than this bridge is not unreachable at all: in dev the two reload
      // independently (the supervisor holds a generation back while a session is
      // busy), and a browser tab outlives a bridge update in production. Dropping
      // the frame in silence is what makes that read as "the app hung" — a
      // confirmed action that never lands and never explains itself. Answering
      // says which message went unanswered, and the UI surfaces it.
      const unhandled = msg as { type?: string; sessionId?: string };
      console.warn(`[bridge] unhandled client message: ${unhandled.type}`);
      ws.send(
        JSON.stringify({
          type: 'error',
          ...(unhandled.sessionId ? { sessionId: unhandled.sessionId } : {}),
          message:
            `This machine's bridge doesn't understand "${unhandled.type}" — it is running an ` +
            'older version than this page. Restart the bridge, then reload.',
        } satisfies ServerMessage),
      );
      break;
    }
  }
}

/**
 * Hand-built `transcript` frame. Each JSONL line already *is* the JSON of one
 * event, so joining them skips parsing and re-serializing the whole file —
 * ~100ms of blocked event loop on a multi-MB transcript. Built as a string, so
 * it can't be checked with `satisfies ServerMessage`: keep the shape in sync
 * with the `transcript` variant in shared/types.ts by hand.
 */
function transcriptFrame(sessionId: string, lines: string[]): string {
  return `{"type":"transcript","sessionId":${JSON.stringify(sessionId)},"events":[${lines.join(',')}]}`;
}

/** Native folder picker. macOS: Finder choose-folder dialog. Returns null on cancel/unsupported. */
function pickFolderNative(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const script = [
    'tell application "Finder"',
    'activate',
    'set f to choose folder with prompt "Select working directory"',
    'end tell',
    'POSIX path of f',
  ];
  const args = script.flatMap((line) => ['-e', line]);
  return new Promise((resolve) => {
    execFile('osascript', args, { timeout: 120_000 }, (err, stdout) => {
      if (err) return resolve(null); // user canceled or dialog unavailable
      const path = stdout.trim();
      resolve(path ? path.replace(/\/$/, '') : null);
    });
  });
}

// tsx-watch restarts race the dying process for the port; retry instead of crashing.
let listenAttempts = 0;
function listen() {
  server.listen(PORT, () => {
    // The bound port, not PORT: the default is 0, so the OS picked one.
    // Publishing is what lets the dev server (and later the tray app) find us.
    const { port } = server.address() as { port: number };
    // Remembered for the OAuth redirect URI: PORT defaults to 0, so the only
    // truthful source for "where a browser can reach us" is what we actually got.
    boundPort = port;
    publishRuntimeInfo('bridge', {
      port,
      pid: process.pid,
      startedAt: Date.now(),
      protocolVersion: APP_PROTOCOL_VERSION,
      token: bridgeToken,
    });
    console.log(`lines bridge listening on http://localhost:${port}`);
  });
}
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && listenAttempts < 20) {
    listenAttempts++;
    console.warn(`port ${PORT} busy, retrying (${listenAttempts}/20)…`);
    setTimeout(() => {
      if (server.listening) return;
      server.close();
      listen();
    }, 500);
  } else {
    throw err;
  }
});

// Release the port promptly when tsx watch restarts us (SIGTERM) or on Ctrl-C.
function shutdown() {
  clearRuntimeInfo('bridge');
  releaseBridgeLock();
  for (const ctx of registry.all()) {
    // persist() is debounced — land any pending session state before we exit.
    ctx.sessions.flushPersist();
    // Debounced for the same reason, and lost the same way if we don't.
    ctx.spendHistory.flush();
    for (const ws of ctx.sockets.keys()) ws.terminate();
  }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/**
 * Re-publish the machine's CLI status when it changes.
 *
 * The probes cache a working answer for the life of the process and a failed one
 * for ten seconds (see claudeCli.ts / codexCli.ts / whisperCli.ts), so this only
 * spawns anything while something is actually missing — and stops the moment all
 * three report ready.
 *
 * It exists because the obvious response to "Codex CLI is not installed" is to
 * install it, and until now nothing noticed: `hello` carries the status once per
 * connection, so the pane kept saying "not installed" and the picker kept the
 * model disabled until the page was reloaded.
 */
let lastCliSignature = '';
function publishCliStatus(): void {
  const claude = publicClaudeCliStatus();
  const codex = publicCodexCliStatus();
  const whisper = publicWhisperStatus();
  const signature = JSON.stringify([claude, codex, whisper]);
  if (signature === lastCliSignature) return;
  // Not on the first pass: `hello` already carried it, and a broadcast before any
  // client has connected reaches nobody.
  const first = lastCliSignature === '';
  lastCliSignature = signature;
  if (first) return;
  for (const ctx of registry.all()) {
    ctx.broadcast({ type: 'cliStatus', claudeCli: claude, codexCli: codex, whisper });
  }
}
setInterval(publishCliStatus, 15_000).unref();

// The bridge's own model download: progress to every link, and on success a
// re-probe so the mic lights up now rather than on the next 15s tick.
onWhisperModelDownload((status, finished) => {
  for (const ctx of registry.all()) ctx.broadcast({ type: 'whisperModelDownload', status });
  if (finished) {
    refreshWhisperStatus();
    publishCliStatus();
  }
});

devRuntime.configure(() => ({
  ready: server.listening && worker.linkOpen,
  relayConnected: devRelayConnected,
  blockers: [
    ...(!worker.linkOpen ? ['worker disconnected'] : []),
    ...worker.devReloadBlockers(),
    ...[...registry.all()].flatMap((ctx) => [
      ...ctx.sessions.devReloadBlockers(),
      ...ctx.workflows.devReloadBlockers(),
    ]),
  ],
}));
listen();
