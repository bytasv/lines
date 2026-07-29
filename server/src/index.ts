import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import dotenv from 'dotenv';

// Env comes from the repo-root .env (single file for all workspaces); real
// environment variables win over .env entries.
dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@lines/shared';
import { DEFAULT_MODELS } from '@lines/shared';
import { verifyToken } from '@clerk/backend';
import { WorkerClient, type WorkerRpc } from './workerClient.ts';
import { APP_ROOT, userStoreRoot } from './store.ts';
import { UserRegistry } from './userRegistry.ts';
import type { UserContext } from './userContext.ts';
import { searchFiles } from './fileSearch.ts';
import { createMcpDispatcher } from './mcpWorkflowTools.ts';
import * as workflowCommands from './workflowCommands.ts';
import type { McpToolResult } from './workerProtocol.ts';

const PORT = Number(process.env.PORT ?? 8787);

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
const conns = new WeakMap<WebSocket, ConnState>();

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

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
};

/**
 * Browsers may only call the file routes from the web app's origin. `WEB_ORIGIN`
 * (comma-separated) pins the allowlist in deployments; with it unset any loopback
 * origin passes, because the vite dev server drifts to 5174/5175 when 5173 is taken.
 */
const WEB_ORIGINS = (process.env.WEB_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** The response CORS headers for one request: the caller's own origin, echoed back if allowed. */
function corsFor(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin) return {}; // non-browser caller (curl, <img>) — nothing to grant
  const allowed = WEB_ORIGINS.length ? WEB_ORIGINS.includes(origin) : LOOPBACK_ORIGIN.test(origin);
  return allowed ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}

/** Resolve the requesting user for a plain-HTTP route from its ?token= param. */
async function httpUserId(url: string): Promise<string | null> {
  if (!AUTH_ENABLED) return LOCAL_USER;
  const token = new URL(url, 'http://localhost').searchParams.get('token');
  return token ? verifyClerkUserId(token) : null;
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  const isFileRoute =
    url.startsWith('/attachments/') ||
    url.startsWith('/file?') ||
    url.startsWith('/tree?') ||
    url.startsWith('/find?');
  if (isFileRoute) {
    const cors = corsFor(req);
    void (async () => {
      // These routes read workspace files and attachments — same gate as the WS.
      const userId = await httpUserId(url);
      if (!userId) {
        res.writeHead(401, cors).end();
        return;
      }
      const ctx = registry.get(userId);
      if (url.startsWith('/attachments/')) serveAttachment(ctx, url, res);
      else if (url.startsWith('/file?')) serveFile(ctx, url, res, cors);
      else if (url.startsWith('/find?')) serveFind(ctx, url, res, cors);
      else serveTree(ctx, url, res, cors);
    })().catch((err) => {
      console.error('[http]', err);
      if (!res.headersSent) res.writeHead(500, cors).end();
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, sessions: registry.get(LOCAL_USER).sessions.list().length }));
});

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Resolve a ?path= query param to an absolute path, or null if outside the user's project/session roots. */
function resolveWorkspacePath(ctx: UserContext, url: string): string | null {
  const raw = new URL(url, 'http://localhost').searchParams.get('path') ?? '';
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const abs = path.resolve(expanded);
  const roots = [...ctx.store.loadProjects(), ...ctx.sessions.list().map((s) => s.cwd)];
  const allowed = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
  return allowed ? abs : null;
}

/** Serve a workspace file for the clickable-path preview, restricted to the user's project/session roots. */
function serveFile(
  ctx: UserContext,
  url: string,
  res: http.ServerResponse,
  cors: Record<string, string>,
) {
  const abs = resolveWorkspacePath(ctx, url);
  if (!abs) {
    res.writeHead(403, cors).end();
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    res.writeHead(404, cors).end();
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, cors).end();
    return;
  }
  if (stat.size > MAX_FILE_BYTES) {
    res.writeHead(413, cors).end();
    return;
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    res.writeHead(404, cors).end();
    return;
  }
  // Reject binary files (NUL byte in the first 8KB).
  if (buf.subarray(0, 8192).includes(0)) {
    res.writeHead(415, cors).end();
    return;
  }
  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ content: buf.toString('utf8') }));
}

/** Directory entries hidden from the file tree. */
const TREE_IGNORE = new Set(['node_modules', '.git']);

/** List one directory for the sidebar file tree, restricted to the user's project/session roots. */
function serveTree(
  ctx: UserContext,
  url: string,
  res: http.ServerResponse,
  cors: Record<string, string>,
) {
  const abs = resolveWorkspacePath(ctx, url);
  if (!abs) {
    res.writeHead(403, cors).end();
    return;
  }
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    res.writeHead(404, cors).end();
    return;
  }
  const entries = dirents
    .filter((d) => !d.name.startsWith('.') && !TREE_IGNORE.has(d.name))
    .filter((d) => d.isDirectory() || d.isFile())
    .map((d) => ({ name: d.name, type: d.isDirectory() ? ('dir' as const) : ('file' as const) }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ entries }));
}

const FIND_MAX_LIMIT = 25;

/**
 * Rank project files by name for the composer's `@mention` search, restricted to
 * the user's project/session roots exactly like /tree and /file.
 */
function serveFind(
  ctx: UserContext,
  url: string,
  res: http.ServerResponse,
  cors: Record<string, string>,
) {
  const root = resolveWorkspacePath(ctx, url);
  if (!root) {
    res.writeHead(403, cors).end();
    return;
  }
  const params = new URL(url, 'http://localhost').searchParams;
  const limit = Math.min(Number(params.get('limit')) || FIND_MAX_LIMIT, FIND_MAX_LIMIT);
  const files = searchFiles(root, params.get('q') ?? '', limit);
  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ files }));
}

/**
 * Serve a stored attachment, guarding against path traversal. Only the
 * requesting user's own attachments root is searched, so another user's
 * sessionId in the URL simply 404s.
 */
function serveAttachment(ctx: UserContext, url: string, res: http.ServerResponse) {
  const rel = decodeURIComponent(url.slice('/attachments/'.length).split('?')[0]);
  const attachmentsRoot = ctx.store.attachmentsRoot;
  const abs = path.resolve(attachmentsRoot, rel);
  if (abs !== attachmentsRoot && !abs.startsWith(attachmentsRoot + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
    });
    res.end(data);
  });
}

const wss = new WebSocketServer({ server });
// The ws library re-emits http server errors here; without a listener they crash the process.
wss.on('error', (err) => console.warn('[wss]', (err as Error).message));

wss.on('connection', (ws, req) => {
  void handleConnection(ws, req);
});

async function handleConnection(ws: WebSocket, req: http.IncomingMessage) {
  let userId = LOCAL_USER;
  let clerkToken: string | null = null;
  if (AUTH_ENABLED) {
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
    sessions: ctx.sessions.list(),
    workflows: ctx.workflows.list(),
    sharedWorkflows: ctx.workflows.listShared(),
    steps: ctx.workflows.listSteps(),
    sharedSteps: ctx.workflows.listSharedSteps(),
    pinnedSteps: ctx.workflows.listPinnedSteps(),
    models: DEFAULT_MODELS,
    recentDirs: ctx.store.loadRecentDirs(),
    projects: ctx.store.loadProjects(),
    projectKeys: ctx.projectKeys.all(),
    usage: ctx.usage.snapshot,
    auth: ctx.auth.getStatus(),
    storage: ctx.sync.status,
    settings: ctx.store.loadSettings(),
    guardAllowlist: ctx.guard.list(),
    // Read from persisted state, so a pending review is on screen before the
    // first pull lands (and survives the 30s pull spacing after a restart).
    guardAllowlistReview: ctx.guard.review(),
  };
  ws.send(JSON.stringify(hello));

  ws.on('close', () => ctx.sockets.delete(ws));

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

async function handleMessage(ctx: UserContext, ws: WebSocket, msg: ClientMessage): Promise<void> {
  const { sessions, workflows, store, auth, broadcast } = ctx;
  switch (msg.type) {
    case 'ping':
      // App-level heartbeat: browsers can't send WS protocol pings, so we answer this.
      ws.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage));
      break;
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
    case 'openProject': {
      const dir = msg.path.replace(/\/+$/, '') || '/';
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`Not a directory: ${dir}`);
      }
      const projects = store.loadProjects();
      if (!projects.includes(dir)) {
        projects.push(dir);
        store.saveProjects(projects);
      }
      store.addRecentDir(dir);
      // Broadcasts the key map itself when this checkout is newly identified.
      ctx.projectKeys.learn(dir);
      broadcast({ type: 'projects', projects });
      break;
    }
    case 'closeProject': {
      const projects = store.loadProjects().filter((p) => p !== msg.path);
      store.saveProjects(projects);
      broadcast({ type: 'projects', projects });
      break;
    }
    case 'linkProjectPath': {
      // Binds a path this machine can't resolve (a checkout that lives only on
      // another install) to a known key, so its sessions group with the rest.
      const dir = msg.path.replace(/\/+$/, '') || '/';
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
    console.log(`lines bridge listening on http://localhost:${PORT}`);
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
