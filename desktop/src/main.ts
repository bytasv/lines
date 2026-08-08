/**
 * Lines desktop shell.
 *
 * Supervises the bridge and the worker as separate child processes, serves the
 * web UI locally, and puts a tray icon on the menu bar. It owns process
 * lifecycle and nothing else — no session state, no agent logic.
 *
 * The bridge and worker stay two processes on purpose: the worker holds every
 * live Claude query, so a bridge crash or restart must not take a turn with it.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron';

/** Repo root in dev; the app bundle's resources once packaged. */
const ROOT = path.resolve(__dirname, '..', '..');
const INSTANCE = process.env.LINES_INSTANCE ?? 'desktop';
const RUN_DIR = path.join(os.homedir(), '.lines-app', 'run', INSTANCE);

/**
 * A GUI-launched macOS app inherits a minimal PATH — no Homebrew, often no
 * `git`, no `rg`, no user-installed node. The agent shells out to all of them
 * (and `caveman.ts` git-clones a plugin), so resolve the login shell's PATH once
 * and hand it to the children. Without this the app works from a terminal and
 * mysteriously fails from the dock.
 */
function loginShellPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? '';
  try {
    const shellBin = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shellBin, ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    return out.trim() || (process.env.PATH ?? '');
  } catch {
    // A broken shell rc shouldn't stop the app booting; the agent may still
    // find tools on the inherited PATH.
    return process.env.PATH ?? '';
  }
}

const CHILD_PATH = loginShellPath();

let worker: ChildProcess | null = null;
let bridge: ChildProcess | null = null;
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let uiPort = 0;
let quitting = false;

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Inside Electron, process.execPath IS the Electron binary — spawning it
    // plainly relaunches the app. This makes it behave as a plain node.
    ELECTRON_RUN_AS_NODE: '1',
    PATH: CHILD_PATH,
    LINES_INSTANCE: INSTANCE,
    // Ephemeral by default; each child publishes its port under RUN_DIR.
    LINES_BRIDGE_PORT: '',
    LINES_WORKER_PORT: '',
    ...extra,
  };
}

/**
 * Children run from source via tsx in dev. Packaging will swap this for the
 * esbuild bundle; the supervision around it does not change.
 */
function spawnChild(name: 'worker' | 'bridge', ipc: boolean): ChildProcess {
  const entry = name === 'worker' ? 'src/worker.ts' : 'src/index.ts';
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: path.join(ROOT, 'server'),
    env: childEnv(),
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c) => process.stdout.write(`[${name}] ${c}`));
  child.stderr?.on('data', (c) => process.stderr.write(`[${name}] ${c}`));
  child.on('exit', (code, signal) => {
    console.log(`[${name}] exited code=${code} signal=${signal}`);
    if (quitting) return;
    // Restart the bridge freely — the worker holds the live turns, so this is
    // survivable. A dead worker is NOT auto-restarted: its queries are gone and
    // a silent respawn would look like a healthy session that lost its turn.
    if (name === 'bridge') {
      setTimeout(() => {
        bridge = spawnChild('bridge', true);
        wireBridgeIpc();
      }, 1_000);
    }
    updateTray();
  });
  return child;
}

/**
 * The bridge reports update state over `process.send`, and takes the restart
 * request back the same way. An IPC channel needs no port, no loopback listener
 * and no shared secret — the bridge is already our child.
 */
function wireBridgeIpc() {
  bridge?.on('message', (msg: { type?: string; [k: string]: unknown }) => {
    if (msg?.type === 'updateRestartRequest') {
      // The bridge only asks once it knows no session is active.
      restartForUpdate();
    }
  });
}

function restartForUpdate() {
  console.log('[update] restart requested — not wired to an installer yet');
  // Phase 4 completion: electron-updater's quitAndInstall() goes here. It needs
  // a signed and notarized build to do anything on macOS, so it stays a no-op
  // until signing exists rather than pretending to work.
}

/** Serve the built web UI, plus the /__bridge discovery endpoint the client expects. */
function startUiServer(): Promise<number> {
  const dist = path.join(ROOT, 'web', 'dist');
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
  };
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/__bridge') {
      // Same contract as the vite dev plugin, so the client needs no change:
      // only the port, never the bridge token.
      let port: number | null = null;
      try {
        port = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'bridge.json'), 'utf8')).port ?? null;
      } catch {
        port = null; // bridge still booting
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ port }));
      return;
    }
    // SPA: anything without an extension falls back to index.html.
    const rel = url === '/' || !path.extname(url) ? '/index.html' : url;
    const file = path.join(dist, rel);
    if (!file.startsWith(dist)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

function openWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Lines',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  void win.loadURL(`http://127.0.0.1:${uiPort}/`);
  // External links open in the real browser, not inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function updateTray() {
  if (!tray) return;
  const alive = (c: ChildProcess | null) => Boolean(c && c.exitCode === null && !c.killed);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Lines', click: openWindow },
      { type: 'separator' },
      { label: `Bridge: ${alive(bridge) ? 'running' : 'stopped'}`, enabled: false },
      { label: `Worker: ${alive(worker) ? 'running' : 'stopped'}`, enabled: false },
      { type: 'separator' },
      { label: 'Quit Lines', click: () => app.quit() },
    ]),
  );
}

app.whenReady().then(async () => {
  // Worker first: the bridge dials it, and starting in this order avoids a
  // pointless retry round on every launch.
  worker = spawnChild('worker', false);
  bridge = spawnChild('bridge', true);
  wireBridgeIpc();

  uiPort = await startUiServer();
  // Logged because it is ephemeral: without this there is no way to reach the UI
  // except through the window we happen to open.
  console.log(`[ui] serving web/dist on http://127.0.0.1:${uiPort}`);

  // A 1px transparent image: the real brand mark lands with packaging.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Lines');
  updateTray();
  setInterval(updateTray, 2_000).unref();

  openWindow();
});

// The tray app keeps running with no windows open — that is the point of a
// menu-bar app, and closing the window must not kill an in-flight agent turn.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
  bridge?.kill('SIGTERM');
  worker?.kill('SIGTERM');
});
