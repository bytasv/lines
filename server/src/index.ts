import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  path.resolve(import.meta.dirname, '../../.env'),
]) {
  if (fs.existsSync(envFile)) dotenv.config({ path: envFile });
}
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@lines/shared';
import { APP_PROTOCOL_VERSION, DEFAULT_MODELS, normalizeRootPath, projectRoots } from '@lines/shared';
import { verifyToken } from '@clerk/backend';
import { WORKER_LOST_MS, WorkerClient, type WorkerRpc } from './workerClient.ts';
import { RelayClient } from './relayClient.ts';
import { deviceIdentity } from './device.ts';
import { APP_ROOT, userStoreRoot } from './store.ts';
import { UserRegistry } from './userRegistry.ts';
import type { BrowserLink, UserContext } from './userContext.ts';
import { handleFileRequest } from './fileRoutes.ts';
import { reportRelayStatus, UpdateManager } from './updates.ts';
import { createMcpDispatcher } from './mcpWorkflowTools.ts';
import * as workflowCommands from './workflowCommands.ts';
import * as recipeCommands from './recipeCommands.ts';
import {
  clearRuntimeInfo,
  newRuntimeToken,
  publishRuntimeInfo,
  type McpToolResult,
} from './workerProtocol.ts';

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
  /** Freshest verified Clerk token from this connection (handshake or relay). */
  clerkToken: string | null;
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
const worker = new WorkerClient({
  onHello: (live) => registry.onWorkerLive(live),
  onEvent: (sessionId, message) =>
    registry.forSession(sessionId).sessions.handleWorkerEvent(sessionId, message),
  onEnded: (sessionId, error) => registry.forSession(sessionId).sessions.handleWorkerEnded(sessionId, error),
  onRpc: (rpc) => {
    const ctx = registry.forSession(rpc.sessionId);
    // Workflow tool calls are the bridge's own business, not the session's —
    // they read and write this user's context rather than gating a tool call.
    if (rpc.kind === 'mcpTool') void handleMcpToolRpc(ctx, rpc);
    else void ctx.sessions.handleWorkerRpc(rpc);
  },
  // No sessionId on a cancel — only the owner's live map has the pending rpc, the rest no-op.
  onRpcCancel: (id) => {
    for (const ctx of registry.all()) ctx.sessions.handleRpcCancel(id);
  },
  onWorkerLost: () => {
    console.warn(`[worker] lost — no reconnect within ${WORKER_LOST_MS}ms, flagging in-flight sessions`);
    registry.onWorkerLost();
  },
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
);
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
 * Holds the pid and its start time so a stale file can be told from a live claim.
 */
const BRIDGE_LOCK_FILE = path.join(APP_ROOT, 'bridge.lock');

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
 * One relay-linked bridge per machine.
 *
 * Two bridges sharing `device.json` both claim the same device, so the relay
 * supersedes one on every dial — and a superseded bridge that keeps writing
 * frames is what turned a freshly created session into a flicker loop between two
 * `hello` snapshots. The relay now refuses frames from a superseded socket, but
 * containment is not the cure: not starting the second process is.
 *
 * Escape hatch for tests (and anyone deliberately running two):
 * LINES_ALLOW_MULTIPLE_BRIDGES=1.
 */
function claimBridgeLock(deviceId: string): void {
  if (process.env.LINES_ALLOW_MULTIPLE_BRIDGES === '1') return;
  try {
    const held = JSON.parse(fs.readFileSync(BRIDGE_LOCK_FILE, 'utf8')) as {
      pid?: number;
      startedAt?: number;
    };
    if (held.pid && held.pid !== process.pid && pidAlive(held.pid)) {
      const since = held.startedAt ? new Date(held.startedAt).toISOString() : 'unknown start time';
      console.error(
        `[bridge] another bridge is already running for device ${deviceId} (pid ${held.pid}, started ${since}).`,
      );
      console.error(`[bridge] stop that process, or delete ${BRIDGE_LOCK_FILE} if it is already gone.`);
      process.exit(1);
    }
  } catch {
    // Absent, truncated or unparseable: nothing is holding the lock, so take it.
    // A corrupt file must never be the reason a user cannot start their bridge.
  }
  fs.mkdirSync(APP_ROOT, { recursive: true });
  fs.writeFileSync(
    BRIDGE_LOCK_FILE,
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), deviceId }),
  );
}

/** Give the lock up on exit, so the next start doesn't have to reason about a pid. */
function releaseBridgeLock(): void {
  try {
    const held = JSON.parse(fs.readFileSync(BRIDGE_LOCK_FILE, 'utf8')) as { pid?: number };
    if (held.pid === process.pid) fs.rmSync(BRIDGE_LOCK_FILE, { force: true });
  } catch {
    // Never ours to remove, or already gone.
  }
}

const RELAY_URL = process.env.RELAY_URL;
if (RELAY_URL) {
  // Env first: the desktop app and the dev relay (RELAY_AUTH_DISABLED, where any
  // secret is accepted) both supply one explicitly. Otherwise fall back to this
  // machine's own identity file, minting it if absent — which is what lets the
  // bridge be started straight from Tilt or a terminal without a supervisor
  // handing it credentials, and keeps the secret out of any process spec.
  const stored =
    process.env.LINES_DEVICE_ID && process.env.LINES_DEVICE_SECRET ? null : deviceIdentity();
  const deviceId = process.env.LINES_DEVICE_ID ?? stored!.id;
  const secret = process.env.LINES_DEVICE_SECRET ?? stored!.secret;
  claimBridgeLock(deviceId);
  new RelayClient(RELAY_URL, deviceId, secret, {
    onChannel: (link, identity) => {
      void handleConnection(link, {}, identity);
    },
    onToken: (userId, token) => {
      registry.get(userId).clerkToken = token;
    },
    // Straight through to the desktop shell: it is the only consumer, and the
    // tray is the only place a user can see that this machine is reachable.
    onStatus: reportRelayStatus,
  });
  console.log(`[relay] dialling ${RELAY_URL} as device ${deviceId}`);
}

// If the worker never shows up, in-flight statuses loaded from disk are stale.
// Unless it did show up and we hung up on it over a protocol mismatch: that
// worker is alive and still running turns, so clearing would falsely idle them.
setTimeout(() => {
  if (worker.everConnected) return;
  if (worker.sawIncompatibleWorker) {
    console.warn('[worker] alive but incompatible — leaving in-flight session statuses alone');
    return;
  }
  console.warn('[worker] not reachable after 15s — clearing in-flight session statuses');
  registry.onWorkerLive([]);
}, 15_000).unref();


/**
 * The bridge's only HTTP surface is this status page. Workspace reads moved onto
 * the WebSocket (see fileRoutes.ts), which removed the Clerk token from query
 * strings and left nothing here needing CORS or an auth gate.
 */
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, sessions: registry.get(LOCAL_USER).sessions.list().length }));
});

const wss = new WebSocketServer({ server });
// The ws library re-emits http server errors here; without a listener they crash the process.
wss.on('error', (err) => console.warn('[wss]', (err as Error).message));

wss.on('connection', (ws, req) => {
  void handleConnection(ws, req);
});

/**
 * `attested` is supplied for relay channels, where the relay is the auth edge and
 * has already verified the token. The bridge does not re-verify: a second
 * verifier means two failure modes, and would make every relayed connection
 * depend on this machine reaching Clerk's JWKS. Direct sockets are unaffected.
 */
async function handleConnection(
  ws: BrowserLink,
  req: { url?: string },
  attested?: { userId: string; clerkToken: string | null },
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
  const ctx = registry.get(userId);
  conns.set(ws, { userId, clerkToken });
  if (clerkToken) {
    ctx.clerkToken = clerkToken;
    // Pull remote state (rate-limited inside) and push local state up.
    void ctx.syncNow();
  }
  ctx.sockets.add(ws);
  const hello: ServerMessage = {
    type: 'hello',
    bridge: { version: BRIDGE_VERSION, appProtocol: APP_PROTOCOL_VERSION },
    sessions: ctx.sessions.list(),
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
    auth: ctx.auth.getStatus(),
    storage: ctx.sync.status,
    // So a browser connecting mid-outage learns about it without waiting for
    // the next transition (which may never come).
    worker: worker.status,
    settings: ctx.store.loadSettings(),
    guardAllowlist: ctx.guard.list(),
    // Read from persisted state, so a pending review is on screen before the
    // first pull lands (and survives the 30s pull spacing after a restart).
    guardAllowlistReview: ctx.guard.review(),
  };
  ws.send(JSON.stringify(hello));

  ws.on('close', () => ctx.sockets.delete(ws));

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
        } satisfies ServerMessage),
      );
    });
  });
}

/**
 * Run one workflow tool call for the session's owner and answer the worker.
 * Failures come back as an error result rather than a rejection: the model is
 * waiting on this call, and a thrown bridge error would park its turn until the
 * worker's fallback fires.
 */
async function handleMcpToolRpc(ctx: UserContext, rpc: WorkerRpc): Promise<void> {
  const toolName = String(rpc.payload.tool ?? '');
  const args = (rpc.payload.args ?? {}) as Record<string, unknown>;
  let result: McpToolResult;
  try {
    result = await createMcpDispatcher(ctx)(toolName, args);
  } catch (err) {
    console.error('[mcp]', toolName, err);
    result = {
      content: [{ type: 'text', text: `Lines could not run ${toolName}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
  worker.rpcResult(rpc.id, result);
}

async function handleMessage(ctx: UserContext, ws: BrowserLink, msg: ClientMessage): Promise<void> {
  const { sessions, workflows, recipes, store, auth, broadcast } = ctx;
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
    case 'fileRequest': {
      // Replies on the originating link, never via broadcast: two tabs each have
      // their own in-flight reqIds.
      const { status, body } = handleFileRequest(ctx, msg.kind, msg.params);
      ws.send(JSON.stringify({ type: 'fileResponse', reqId: msg.reqId, status, body } satisfies ServerMessage));
      break;
    }
    case 'auth': {
      // Fresh-token relay. Re-verifying catches a revoked Clerk session within
      // one relay cycle; failure closes the socket like a failed handshake.
      if (!AUTH_ENABLED) break;
      const conn = conns.get(ws);
      const verified = await verifyClerkUserId(msg.token);
      if (!conn || verified !== conn.userId) {
        ws.close(1008, 'unauthorized');
        break;
      }
      conn.clerkToken = msg.token;
      ctx.clerkToken = msg.token;
      break;
    }
    case 'createSession': {
      const meta = sessions.createSession({
        name: msg.name,
        cwd: msg.cwd,
        model: msg.model,
        permissionMode: msg.permissionMode,
        caveman: msg.caveman,
      });
      // attach() re-broadcasts the session with workflow state populated.
      if (msg.workflowId) workflows.attach(meta.id, msg.workflowId);
      break;
    }
    case 'deleteSession':
      sessions.deleteSession(msg.sessionId);
      break;
    case 'prompt': {
      // A workflow-attached session consumes its first prompt as the task description.
      if (workflows.startIfPending(msg.sessionId, msg.text, msg.attachments)) break;
      // A prompt sent while a step is parked iterates on that same step.
      if (workflows.iterateIfWaiting(msg.sessionId, msg.text, msg.attachments)) break;
      sessions.userPrompt(msg.sessionId, msg.text, msg.attachments, msg.mentions);
      break;
    }
    case 'interrupt':
      sessions.interrupt(msg.sessionId);
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
    case 'setModel':
      sessions.setModel(msg.sessionId, msg.model);
      break;
    case 'setPermissionMode':
      sessions.setPermissionMode(msg.sessionId, msg.mode);
      break;
    case 'setCaveman':
      sessions.setCaveman(msg.sessionId, msg.caveman);
      break;
    case 'permissionResponse':
      sessions.resolvePermission(
        msg.sessionId,
        msg.requestId,
        msg.allow,
        msg.updatedInput,
        msg.answers,
        msg.denyMessage,
        msg.alwaysAllow,
      );
      break;
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
    case 'linkProjectPath': {
      // Binds a path this machine can't resolve (a checkout that lives only on
      // another install) to a known key, so its sessions group with the rest.
      const dir = normalizeRootPath(msg.path) || '/';
      if (msg.key) ctx.projectKeys.set(dir, msg.key);
      break;
    }
    case 'pickFolder': {
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
    case 'saveSettings': {
      // LWW: an out-of-order save from a stale tab must not clobber newer state.
      const local = store.loadSettings();
      const incoming = { ...msg.settings, updatedAt: msg.settings.updatedAt ?? Date.now() };
      if ((incoming.updatedAt ?? 0) <= (local?.updatedAt ?? 0)) break;
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
    for (const ws of ctx.sockets) ws.terminate();
  }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

listen();
