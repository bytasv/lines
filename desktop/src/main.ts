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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron';

/** Repo root in dev; the app bundle's resources once packaged. */
const ROOT = path.resolve(__dirname, '..', '..');
const INSTANCE = process.env.LINES_INSTANCE ?? 'desktop';
const APP_ROOT = path.join(os.homedir(), '.lines-app');
const RUN_DIR = path.join(APP_ROOT, 'run', INSTANCE);

/**
 * Hosted mode. With a relay configured this machine stops serving a UI of its
 * own: the user works in the hosted web app, and this process exists only to run
 * the agent locally and keep an outbound connection open. Unset, everything
 * behaves as the purely local app it was before.
 */
const RELAY_URL = process.env.LINES_RELAY_URL;
const STORAGE_URL = process.env.LINES_STORAGE_URL;
const WEB_URL = process.env.LINES_WEB_URL;
const RELAY_MODE = Boolean(RELAY_URL && STORAGE_URL);

/** Identity of this machine, as the relay knows it. Mode 0600: the secret is a credential. */
const DEVICE_FILE = path.join(APP_ROOT, 'device.json');

interface DeviceIdentity {
  id: string;
  secret: string;
}

/**
 * Load or mint this machine's identity. The secret never leaves the machine —
 * only its sha256 is registered — so a compromise of the server cannot yield
 * anything that impersonates this device.
 */
function deviceIdentity(): DeviceIdentity {
  try {
    const saved = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8')) as Partial<DeviceIdentity>;
    if (saved.id && saved.secret) return { id: saved.id, secret: saved.secret };
  } catch {
    // Absent or unreadable: mint a fresh one below. A corrupt file is treated as
    // a new machine rather than a fatal error — the user re-pairs and moves on.
  }
  const identity: DeviceIdentity = { id: randomUUID(), secret: randomBytes(32).toString('hex') };
  fs.mkdirSync(APP_ROOT, { recursive: true });
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

/**
 * Announce this machine to storage and return the code the user types into the
 * web app. Null means it is already claimed and needs no pairing — the common
 * case on every launch after the first.
 */
async function registerDevice(identity: DeviceIdentity): Promise<string | null> {
  const res = await fetch(`${STORAGE_URL}/v1/devices/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: identity.id,
      secretHash: createHash('sha256').update(identity.secret).digest('hex'),
      name: os.hostname(),
      platform: process.platform,
    }),
  });
  // Registration refuses to re-issue a code for a machine someone already
  // claimed, which is exactly how we recognise "already paired".
  if (res.status === 409) return null;
  if (!res.ok) {
    throw new Error(`device registration failed: ${res.status} ${await res.text()}`);
  }
  const { pairingCode } = (await res.json()) as { pairingCode: string };
  return pairingCode;
}

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
let device: DeviceIdentity | null = null;
/** Set while this machine is registered but unclaimed; cleared once pairing succeeds. */
let pairingCode: string | null = null;

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
    // In hosted mode the bridge dials out to the relay and syncs to the hosted
    // storage server. Absent, it serves only its local socket, as before.
    ...(RELAY_MODE && device
      ? {
          RELAY_URL: RELAY_URL!,
          STORAGE_URL: STORAGE_URL!,
          LINES_DEVICE_ID: device.id,
          LINES_DEVICE_SECRET: device.secret,
        }
      : {}),
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

/**
 * The pairing code, on screen. A plain data: URL rather than a React view —
 * this is the one thing the app must show before anything else works, so it
 * cannot depend on the web bundle being built or reachable.
 */
function openPairingWindow(code: string) {
  const target = WEB_URL ?? 'the Lines web app';
  const html = `<!doctype html><meta charset="utf-8"><title>Pair this machine</title>
<style>
  body { font: 14px -apple-system, system-ui, sans-serif; background:#1a1b1e; color:#c1c2c5;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0 }
  .card { text-align:center; max-width:420px; padding:0 24px }
  .code { font:600 34px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:6px;
          color:#fff; margin:20px 0; user-select:all }
  a { color:#4dabf7 }
  .hint { color:#909296; font-size:12px; margin-top:18px }
</style>
<div class="card">
  <h2>Pair this machine</h2>
  <p>Enter this code in ${WEB_URL ? `<a href="${WEB_URL}">${target}</a>` : target}:</p>
  <div class="code">${code}</div>
  <p class="hint">Expires in 15 minutes. Restart this app for a new code.<br>
  You can close this window once pairing succeeds — Lines keeps running in the menu bar.</p>
</div>`;
  const w = new BrowserWindow({
    width: 480,
    height: 380,
    title: 'Pair this machine',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function updateTray() {
  if (!tray) return;
  const alive = (c: ChildProcess | null) => Boolean(c && c.exitCode === null && !c.killed);
  const open = RELAY_MODE
    ? // Hosted mode serves no local UI; the app lives at the public URL.
      { label: 'Open Lines', click: () => WEB_URL && void shell.openExternal(WEB_URL), enabled: Boolean(WEB_URL) }
    : { label: 'Open Lines', click: openWindow };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      open,
      ...(pairingCode
        ? [{ label: `Pairing code: ${pairingCode}`, click: () => openPairingWindow(pairingCode!) }]
        : []),
      { type: 'separator' as const },
      { label: `Bridge: ${alive(bridge) ? 'running' : 'stopped'}`, enabled: false },
      { label: `Worker: ${alive(worker) ? 'running' : 'stopped'}`, enabled: false },
      { type: 'separator' as const },
      { label: 'Quit Lines', click: () => app.quit() },
    ]),
  );
}

app.whenReady().then(async () => {
  if (RELAY_MODE) {
    device = deviceIdentity();
    try {
      pairingCode = await registerDevice(device);
      console.log(
        pairingCode
          ? `[device] ${device.id} awaiting pairing, code ${pairingCode}`
          : `[device] ${device.id} already paired`,
      );
    } catch (err) {
      // Not fatal: the bridge retries the relay forever, so a machine that
      // registers late still comes up once storage is reachable again.
      console.error(`[device] ${(err as Error).message}`);
    }
  }

  // Worker first: the bridge dials it, and starting in this order avoids a
  // pointless retry round on every launch.
  worker = spawnChild('worker', false);
  bridge = spawnChild('bridge', true);
  wireBridgeIpc();

  if (!RELAY_MODE) {
    uiPort = await startUiServer();
    // Logged because it is ephemeral: without this there is no way to reach the
    // UI except through the window we happen to open.
    console.log(`[ui] serving web/dist on http://127.0.0.1:${uiPort}`);
  }

  // A 1px transparent image: the real brand mark lands with packaging.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Lines');
  updateTray();
  setInterval(updateTray, 2_000).unref();

  // Hosted mode is a background app: the only reason to put a window on screen
  // is a pairing code the user has to read.
  if (!RELAY_MODE) openWindow();
  else if (pairingCode) openPairingWindow(pairingCode);
});

// The tray app keeps running with no windows open — that is the point of a
// menu-bar app, and closing the window must not kill an in-flight agent turn.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
  bridge?.kill('SIGTERM');
  worker?.kill('SIGTERM');
});
