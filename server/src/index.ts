import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@claude-ui/shared';
import { DEFAULT_MODELS } from '@claude-ui/shared';
import { SessionManager } from './sessions.ts';
import { WorkerClient } from './workerClient.ts';
import { WorkflowEngine } from './workflows.ts';
import { store } from './store.ts';
import { UsagePoller } from './usage.ts';

const PORT = Number(process.env.PORT ?? 8787);

const clients = new Set<WebSocket>();

function broadcast(msg: ServerMessage) {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

const usage = new UsagePoller(broadcast);
usage.start();

const sessions = new SessionManager((msg) => {
  broadcast(msg);
  // A result message means plan usage just changed — refresh the poller soon.
  if (
    msg.type === 'event' &&
    msg.event.kind === 'sdk' &&
    (msg.event.data as { type?: string } | null)?.type === 'result'
  ) {
    usage.refreshSoon();
  }
});
// The worker owns the Claude CLI children so this process can restart freely
// (tsx watch, dogfooding edits) without killing in-flight agent turns.
const worker = new WorkerClient({
  onHello: (live) => sessions.reconcileWithWorker(live),
  onEvent: (sessionId, message) => sessions.handleWorkerEvent(sessionId, message),
  onEnded: (sessionId, error) => sessions.handleWorkerEnded(sessionId, error),
  onRpc: (rpc) => void sessions.handleWorkerRpc(rpc),
  onRpcCancel: (id) => sessions.handleRpcCancel(id),
});
sessions.attachWorker(worker);
// If the worker never shows up, in-flight statuses loaded from disk are stale.
setTimeout(() => {
  if (!worker.everConnected) {
    console.warn('[worker] not reachable after 15s — clearing in-flight session statuses');
    sessions.reconcileWithWorker([]);
  }
}, 15_000).unref();

const workflows = new WorkflowEngine(sessions, broadcast);

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

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/attachments/')) {
    return serveAttachment(req.url, res);
  }
  if (req.url && req.url.startsWith('/file?')) {
    return serveFile(req.url, res);
  }
  if (req.url && req.url.startsWith('/tree?')) {
    return serveTree(req.url, res);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, sessions: sessions.list().length }));
});

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Resolve a ?path= query param to an absolute path, or null if outside known project/session roots. */
function resolveWorkspacePath(url: string): string | null {
  const raw = new URL(url, 'http://localhost').searchParams.get('path') ?? '';
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const abs = path.resolve(expanded);
  const roots = [...store.loadProjects(), ...sessions.list().map((s) => s.cwd)];
  const allowed = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
  return allowed ? abs : null;
}

/** Serve a workspace file for the clickable-path preview, restricted to known project/session roots. */
function serveFile(url: string, res: http.ServerResponse) {
  const cors = { 'access-control-allow-origin': '*' };
  const abs = resolveWorkspacePath(url);
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

/** List one directory for the sidebar file tree, restricted to known project/session roots. */
function serveTree(url: string, res: http.ServerResponse) {
  const cors = { 'access-control-allow-origin': '*' };
  const abs = resolveWorkspacePath(url);
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

/** Serve a stored attachment, guarding against path traversal outside the attachments root. */
function serveAttachment(url: string, res: http.ServerResponse) {
  const rel = decodeURIComponent(url.slice('/attachments/'.length).split('?')[0]);
  const abs = path.resolve(store.attachmentsRoot, rel);
  if (abs !== store.attachmentsRoot && !abs.startsWith(store.attachmentsRoot + path.sep)) {
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

wss.on('connection', (ws) => {
  clients.add(ws);
  const hello: ServerMessage = {
    type: 'hello',
    sessions: sessions.list(),
    workflows: workflows.list(),
    models: DEFAULT_MODELS,
    recentDirs: store.loadRecentDirs(),
    projects: store.loadProjects(),
    usage: usage.snapshot,
  };
  ws.send(JSON.stringify(hello));

  ws.on('close', () => clients.delete(ws));

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    handleMessage(ws, msg).catch((err) => {
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
});

async function handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case 'ping':
      // App-level heartbeat: browsers can't send WS protocol pings, so we answer this.
      ws.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage));
      break;
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
      if (workflows.startIfPending(msg.sessionId, msg.text)) break;
      // A prompt sent while a step is parked iterates on that same step.
      if (workflows.iterateIfWaiting(msg.sessionId, msg.text, msg.attachments)) break;
      sessions.userPrompt(msg.sessionId, msg.text, msg.attachments);
      break;
    }
    case 'interrupt':
      sessions.interrupt(msg.sessionId);
      break;
    case 'retryTurn':
      sessions.retryTurn(msg.sessionId);
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
      workflows.approve(msg.sessionId);
      break;
    case 'workflowRetry':
      workflows.retry(msg.sessionId, msg.feedback);
      break;
    case 'saveWorkflow':
      workflows.save(msg.workflow);
      break;
    case 'deleteWorkflow':
      workflows.delete(msg.workflowId);
      break;
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
      broadcast({ type: 'projects', projects });
      break;
    }
    case 'closeProject': {
      const projects = store.loadProjects().filter((p) => p !== msg.path);
      store.saveProjects(projects);
      broadcast({ type: 'projects', projects });
      break;
    }
    case 'pickFolder': {
      const path = await pickFolderNative();
      ws.send(JSON.stringify({ type: 'folderPicked', path } satisfies ServerMessage));
      break;
    }
    case 'loadTranscript': {
      const events = store.loadTranscript(msg.sessionId);
      ws.send(
        JSON.stringify({ type: 'transcript', sessionId: msg.sessionId, events } satisfies ServerMessage),
      );
      break;
    }
  }
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
    console.log(`claude-ui bridge listening on http://localhost:${PORT}`);
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
  for (const ws of clients) ws.terminate();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

listen();
