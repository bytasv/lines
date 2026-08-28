/**
 * Lines desktop shell.
 *
 * Supervises the bridge and the worker as separate child processes and puts a
 * tray icon on the menu bar. It owns process lifecycle, this machine's pairing
 * state, and nothing else — no session state, no agent logic.
 *
 * The bridge and worker stay two processes on purpose: the worker holds every
 * live Claude query, so a bridge crash or restart must not take a turn with it.
 *
 * Hosted is the default. The installed app serves no UI of its own: the user
 * works in the hosted web app, and this process exists to run the agent locally
 * and keep an outbound connection open. `LINES_LOCAL_MODE=1` brings back the
 * purely local app (own web server, own window), which is now a dev-only path —
 * `web/dist` is not in the DMG.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '@lines/shared';

/**
 * Device identity and CLI discovery live in the server workspace, shared with
 * `npm run pair -w server` and the bridge so nothing can drift on the credential
 * format or on which `claude` binary runs. esbuild bundles them into main.cjs;
 * nothing else from the bridge comes with them.
 */
import {
  deviceIdentity,
  registerDevice,
  unpairDevice,
  type DeviceIdentity,
} from '../../server/src/device.ts';
import {
  CLAUDE_INSTALL_URL,
  claudeCliStatus,
  refreshClaudeCli,
  type ClaudeCliStatus,
} from '../../server/src/claudeCli.ts';
import type { RelayLinkStatus } from '../../server/src/updates.ts';
import { isLocalMode, loadConfig } from './config.ts';

/**
 * Repo root in dev, the bundle's `Resources` once packaged.
 *
 * The two halves diverge deliberately: packaged, `ROOT/server` holds the esbuild
 * bundles; in a checkout it is `server/` itself, so `npm run dev -w desktop`
 * keeps running the TypeScript sources under tsx and an edit still applies
 * without repackaging.
 */
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(ROOT, 'server');
const ASSETS = app.isPackaged ? path.join(ROOT, 'assets') : path.resolve(__dirname, '..', 'assets');

const INSTANCE = process.env.LINES_INSTANCE ?? 'desktop';
const APP_ROOT = path.join(os.homedir(), '.lines-app');
const RUN_DIR = path.join(APP_ROOT, 'run', INSTANCE);
/**
 * The bridge's single-instance lock. Read here, never written: the bridge owns it.
 *
 * The path and the exit code are duplicated rather than imported from
 * server/src/index.ts, exactly as APP_ROOT above is — this shell needs two
 * constants, not the bridge's module graph.
 */
const BRIDGE_LOCK_FILE = path.join(APP_ROOT, 'bridge.lock');
/** `EX_CONFIG` from server/src/index.ts: the bridge refused to start because
 *  another one owns this machine. Distinct from a crash on purpose. */
const EXIT_BRIDGE_LOCK_HELD = 78;
/** Child stdout/stderr, so "Open logs" has something to reveal on a machine with no terminal. */
const LOG_FILE = path.join(APP_ROOT, 'logs', `${INSTANCE}.log`);

const LOCAL_MODE = isLocalMode();
const RELAY_MODE = !LOCAL_MODE;
const config = loadConfig(ROOT);

/**
 * Squirrel.Mac verifies the code signature of the replacement app, and macOS
 * quarantine applies to an ad-hoc signed bundle, so an in-place install cannot
 * work before a Developer ID exists. Until then the updater only *checks*, and
 * the user is sent to the download page. Flip this (and electron-builder's
 * `identity`) together once signing exists — nothing else changes.
 */
const CAN_SELF_INSTALL = false;

/**
 * A GUI-launched macOS app inherits a minimal PATH — no Homebrew, often no
 * `git`, no `rg`, no user-installed node. The agent shells out to all of them, so
 * resolve the login shell's PATH once and hand it to the children. Without this
 * the app works from a terminal and mysteriously fails from the dock.
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
let pairingWindow: BrowserWindow | null = null;
let uiPort = 0;
let quitting = false;
let device: DeviceIdentity | null = null;
/** Set while this machine is registered but unclaimed; cleared once pairing succeeds. */
let pairingCode: string | null = null;
let pairingTimer: NodeJS.Timeout | null = null;
/** Last relay transition the bridge reported; null before the first one arrives. */
let relay: RelayLinkStatus | null = null;
/** True once a relay link has stayed up long enough to prove the claim landed. */
let relayVerified = false;
let relaySettleTimer: NodeJS.Timeout | null = null;
/** When we last re-registered on our own, so a 1008 loop cannot hammer storage. */
let lastRegisterAt = 0;
/** Set while another bridge (a dev checkout under Tilt, normally) owns this
 *  machine, so ours is deliberately not running. */
let standDown: { pid: number; instance: string } | null = null;
let standDownTimer: NodeJS.Timeout | null = null;
let cli: ClaudeCliStatus = claudeCliStatus();
let update: UpdateStatus = { state: 'idle' };

/**
 * The relay accepts our socket *before* asking storage whether this device is
 * claimed, and refuses with a 1008 close when it is not. So an `open` alone is
 * not proof of pairing — only one that survives this long is. Comfortably longer
 * than a verification round trip, short enough that a user watching the pairing
 * window sees it resolve.
 */
const RELAY_SETTLE_MS = 6_000;

/** Codes expire after 15 minutes; refresh just inside that so one is always valid. */
const PAIRING_REFRESH_MS = 14 * 60_000;

/**
 * Floor between automatic re-registrations after a 1008.
 *
 * The bridge retries the relay forever, so every retry of a device that is
 * refused for some other reason would otherwise be one more `register` against
 * storage. This plus the `!pairingCode` guard bounds it.
 */
const AUTO_REGISTER_MIN_MS = 30_000;

/**
 * How often we look for the other bridge to go away. Slow on purpose: this is a
 * "someone ran `tilt up`" state, not a fault to race back from.
 */
const STAND_DOWN_RECHECK_MS = 5_000;

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
    // autoGuard self-locates from `server/src` under tsx, which matches nothing
    // in a packaged build — so name the files that really back this worker.
    ...(app.isPackaged ? { LINES_WORKER_SOURCES: path.join(SERVER_DIR, 'worker.mjs') } : {}),
    // In hosted mode the bridge dials out to the relay and syncs to the hosted
    // storage server. Absent, it serves only its local socket, as before.
    ...(RELAY_MODE && device
      ? {
          RELAY_URL: config.relayUrl,
          STORAGE_URL: config.storageUrl,
          LINES_DEVICE_ID: device.id,
          LINES_DEVICE_SECRET: device.secret,
        }
      : {}),
    ...extra,
  };
}

/** Append child output to the log file, best-effort — a full disk must not kill the app. */
function appendLog(line: string) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* logging is not worth crashing over */
  }
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
 * The bridge lock when a *different* live process holds it.
 *
 * Null for absent, corrupt, dead, or a lock naming our own bridge — none of those
 * is a collision, and treating one as such would park the tray for nothing.
 */
function foreignBridgeLock(): { pid: number; instance: string } | null {
  try {
    const held = JSON.parse(fs.readFileSync(BRIDGE_LOCK_FILE, 'utf8')) as {
      pid?: number;
      instance?: string;
    };
    if (typeof held.pid !== 'number') return null;
    if (held.pid === bridge?.pid) return null;
    if (!pidAlive(held.pid)) return null;
    return { pid: held.pid, instance: held.instance ?? 'unknown' };
  } catch {
    return null;
  }
}

/**
 * Another bridge owns this machine: keep ours down and watch for the lock to clear.
 *
 * The worker is deliberately left exactly as it is. It may be holding a live turn,
 * and it is the bridge — not the worker — that collides on the lock and on this
 * machine's device identity. Same argument as the restart asymmetry in spawnChild.
 */
function enterStandDown(holder: { pid: number; instance: string }) {
  standDown = holder;
  bridge = null;
  // Nothing of ours is dialling out, so the tray must not claim a link.
  applyRelayStatus({ connected: false });
  appendLog(`[bridge] standing down — pid ${holder.pid} (${holder.instance}) owns this machine\n`);
  console.log(`[bridge] standing down — pid ${holder.pid} (${holder.instance}) owns this machine`);
  if (!standDownTimer) {
    standDownTimer = setInterval(() => {
      const still = foreignBridgeLock();
      if (still) {
        // Ownership can pass from one process to another (a tsx watch restart)
        // without ever being free; report whoever holds it now.
        standDown = still;
        updateTray();
        return;
      }
      clearInterval(standDownTimer!);
      standDownTimer = null;
      standDown = null;
      console.log('[bridge] machine lock is free — re-arming');
      // The worker was never stood down, so only replace one that is actually gone.
      if (!worker || worker.exitCode !== null || worker.killed) worker = spawnChild('worker', false);
      bridge = spawnChild('bridge', true);
      wireBridgeIpc();
      updateTray();
    }, STAND_DOWN_RECHECK_MS);
    standDownTimer.unref();
  }
  updateTray();
}

/**
 * Packaged, the children are single-file esbuild bundles run by Electron's own
 * node (`ELECTRON_RUN_AS_NODE`). In a checkout they stay TypeScript under tsx, so
 * dogfooding an edit needs no repackaging. The supervision around it — IPC for
 * the bridge only, and the restart asymmetry below — is identical either way.
 */
function spawnChild(name: 'worker' | 'bridge', ipc: boolean): ChildProcess {
  const args = app.isPackaged
    ? [path.join(SERVER_DIR, `${name}.mjs`)]
    : ['--import', 'tsx', name === 'worker' ? 'src/worker.ts' : 'src/index.ts'];
  const child = spawn(process.execPath, args, {
    cwd: SERVER_DIR,
    env: childEnv(),
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const line = `[${name}] ${chunk}`;
    process[stream].write(line);
    appendLog(line);
  };
  child.stdout?.on('data', forward('stdout'));
  child.stderr?.on('data', forward('stderr'));
  child.on('exit', (code, signal) => {
    appendLog(`[${name}] exited code=${code} signal=${signal}\n`);
    console.log(`[${name}] exited code=${code} signal=${signal}`);
    if (quitting) return;
    // Restart the bridge freely — the worker holds the live turns, so this is
    // survivable. A dead worker is NOT auto-restarted: its queries are gone and
    // a silent respawn would look like a healthy session that lost its turn.
    if (name === 'bridge') {
      // The relay link died with it; don't leave the tray claiming otherwise.
      applyRelayStatus({ connected: false });
      // Two ways another bridge takes this machine: ours refused to start (78), or
      // ours was preempted — SIGTERMed by the newcomer, so `code` is null and the
      // lock is the only tell. Either way, respawning on a 1s timer would be a
      // crash loop against a machine we do not own.
      const holder = foreignBridgeLock();
      if (holder || code === EXIT_BRIDGE_LOCK_HELD) {
        enterStandDown(holder ?? { pid: 0, instance: 'unknown' });
        return;
      }
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
 * The bridge reports update state and relay health over `process.send`, and
 * takes the restart request back the same way. An IPC channel needs no port, no
 * loopback listener and no shared secret — the bridge is already our child.
 */
function wireBridgeIpc() {
  bridge?.on('message', (msg: { type?: string; [k: string]: unknown }) => {
    if (msg?.type === 'updateRestartRequest') {
      // The bridge only asks once it knows no session is active.
      restartForUpdate();
    } else if (msg?.type === 'relayStatus') {
      applyRelayStatus(msg.status as RelayLinkStatus);
    }
  });
  // The bridge's UpdateManager is created fresh on every (re)spawn, so re-send
  // whatever we already know instead of leaving the browser at 'idle'.
  if (update.state !== 'idle') sendUpdateStatus();
}

/** Push the current update state to the bridge, which broadcasts it to browsers. */
function sendUpdateStatus() {
  bridge?.send?.({ type: 'updateStatus', status: update });
}

function setUpdateStatus(status: UpdateStatus) {
  update = status;
  sendUpdateStatus();
  updateTray();
}

function restartForUpdate() {
  if (!CAN_SELF_INSTALL) {
    // Deliberately inert: an ad-hoc signed bundle cannot be replaced in place,
    // and pretending otherwise would relaunch the old version and look like a
    // silent failure. The tray offers the download page instead.
    console.log('[update] self-install needs a signed build — sending the user to the download page');
    void shell.openExternal(config.downloadUrl);
    return;
  }
  autoUpdater.quitAndInstall();
}

/**
 * Update checks only. `autoDownload` stays off because a downloaded update we
 * cannot install is just wasted bandwidth and a misleading "ready" state.
 */
function startUpdateChecks() {
  if (!config.updateFeedUrl || !app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({ provider: 'generic', url: config.updateFeedUrl });
  autoUpdater.on('update-available', (info: { version: string }) => {
    setUpdateStatus({ state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => setUpdateStatus({ state: 'idle' }));
  autoUpdater.on('error', (err: Error) => setUpdateStatus({ state: 'error', message: err.message }));
  const check = () => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      // Offline is the common case and must stay quiet in the tray.
      console.warn('[update] check failed:', err.message);
    });
  };
  check();
  setInterval(check, 6 * 60 * 60_000).unref();
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

/** Interpolating into the pairing page's HTML — a code or URL must not become markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The pairing code, on screen. A plain data: URL rather than a React view —
 * this is the one thing the app must show before anything else works, so it
 * cannot depend on the web bundle being built or reachable.
 */
function openPairingWindow(code: string) {
  const url = escapeHtml(config.webUrl);
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
  <p>Enter this code in <a href="${url}">${url}</a>:</p>
  <div class="code">${escapeHtml(code)}</div>
  <p class="hint">Expires in 15 minutes. Lines fetches a fresh code automatically, or
  use “Get a new code” in the menu bar.<br>
  This window closes itself once pairing succeeds — Lines keeps running in the menu bar.</p>
</div>`;
  if (pairingWindow && !pairingWindow.isDestroyed()) {
    void pairingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    pairingWindow.show();
    pairingWindow.focus();
    return;
  }
  const w = new BrowserWindow({
    width: 480,
    height: 380,
    title: 'Pair this machine',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  pairingWindow = w;
  w.on('closed', () => {
    if (pairingWindow === w) pairingWindow = null;
  });
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  w.webContents.setWindowOpenHandler(({ url: external }) => {
    void shell.openExternal(external);
    return { action: 'deny' };
  });
}

/**
 * Register (or re-register) this machine and show the code it gets back.
 *
 * `registerDevice` re-upserts an *unclaimed* device and answers with a fresh
 * code — storage only 409s for a claimed, unrevoked one — so this is also how
 * "already paired" is detected, and why a new code never needs a restart.
 */
async function refreshPairingCode(show: boolean): Promise<void> {
  if (!RELAY_MODE || !device) return;
  lastRegisterAt = Date.now();
  try {
    pairingCode = await registerDevice(config.storageUrl, device);
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
  if (pairingCode && show) openPairingWindow(pairingCode);
  schedulePairingRefresh();
  updateTray();
}

/** Keep a valid code in the tray while unpaired, and stop the moment we are paired. */
function schedulePairingRefresh() {
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = null;
  if (!pairingCode) return;
  pairingTimer = setTimeout(() => void refreshPairingCode(false), PAIRING_REFRESH_MS);
  pairingTimer.unref();
}

/**
 * Fold a relay transition into the tray's state.
 *
 * A link that stays up past {@link RELAY_SETTLE_MS} is the only evidence this
 * shell has that the user's claim landed — the relay sends no acknowledgement —
 * so that, and not a bare `open`, is what closes the pairing window.
 */
function applyRelayStatus(status: RelayLinkStatus) {
  relay = status;
  if (relaySettleTimer) clearTimeout(relaySettleTimer);
  relaySettleTimer = null;
  if (status.connected) {
    relaySettleTimer = setTimeout(onRelayVerified, RELAY_SETTLE_MS);
    relaySettleTimer.unref();
  } else {
    relayVerified = false;
    // 1008 with no code in hand means this machine was revoked in the web app:
    // storage only refuses to re-issue a code for a *claimed* row, so registering
    // again now succeeds and pops a fresh code without the user asking. That is
    // what closes the loop after an unpair from the browser — otherwise the tray
    // just reads "Not paired" and offers nothing.
    if (status.code === 1008 && !pairingCode && Date.now() - lastRegisterAt > AUTO_REGISTER_MIN_MS) {
      void refreshPairingCode(true);
    }
  }
  updateTray();
}

function onRelayVerified() {
  const firstTime = !relayVerified;
  relayVerified = true;
  // The claim landed, so the code we were showing is spent.
  const wasPairing = Boolean(pairingCode);
  pairingCode = null;
  schedulePairingRefresh();
  if (pairingWindow && !pairingWindow.isDestroyed()) pairingWindow.close();
  if (firstTime && wasPairing && Notification.isSupported()) {
    new Notification({
      title: 'This machine is paired',
      body: 'Lines can now run sessions here. It stays in the menu bar.',
    }).show();
  }
  updateTray();
}

/**
 * Release this machine from the account that claimed it, from the machine itself.
 *
 * The lockout-proof path: it works when the web app's gate is unusable, which is
 * the state that has no other way out — "Get a new code" cannot help, because
 * storage refuses to re-issue one for a claimed device.
 *
 * Nothing here restarts the bridge or the worker: that would break "the relay
 * client is a peripheral, never a supervisor" and could interrupt a live turn. The
 * link converges on its own — the relay's re-verify sees the revoked row and drops
 * the hub, the bridge re-dials into 1008 until the new code is claimed.
 */
async function unpairThisMachine(): Promise<void> {
  if (!RELAY_MODE || !device) return;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Unpair'],
    defaultId: 0,
    cancelId: 0,
    message: 'Unpair this machine from your Lines account?',
    detail:
      'Your browser will lose access to this machine and a new pairing code will be shown here. Sessions and files on this machine are not touched.',
  });
  if (response !== 1) return;
  try {
    await unpairDevice(config.storageUrl, device);
  } catch (err) {
    console.error(`[device] ${(err as Error).message}`);
    return;
  }
  relayVerified = false;
  // Registering straight after is what mints the fresh code — unpair deliberately
  // returns none, so there is exactly one code-issuing path.
  await refreshPairingCode(true);
}

/** One line for the tray: what the relay link is actually doing. */
function relayLabel(): string {
  if (!RELAY_MODE) return 'Local mode';
  // No bridge of ours is running, so "Connecting…" would be a lie.
  if (standDown) return 'Paused — another bridge owns this machine';
  if (relayVerified) return `Connected · ${hostLabel(config.webUrl)}`;
  if (relay?.connected) return 'Connecting…';
  // 1008 is the relay refusing this device: unclaimed, or revoked in the web app.
  if (relay?.code === 1008) return 'Not paired';
  return 'Connecting…';
}

/** Hostname of a URL, for display. Falls back to the raw string if it will not parse. */
function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function claudeLabel(): string {
  if (cli.state === 'ok') return `Claude Code: ${cli.version ?? 'installed'}`;
  if (cli.state === 'outdated') return `Claude Code ${cli.version} is too old — update it`;
  return 'Claude Code not found — how to install';
}

/**
 * The menu bar art. A template image: macOS derives the light and dark
 * appearances from its alpha, which is why the source is the near-black
 * transparent mark rather than a coloured icon. Falls back to an empty image so a
 * missing asset cannot stop the app booting — invisible, but running.
 */
function trayImage() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
  if (icon.isEmpty()) return nativeImage.createEmpty();
  icon.setTemplateImage(true);
  return icon;
}

/**
 * The dock tile, for the runs that have one.
 *
 * A packaged bundle takes its dock icon from `icon.icns` in Info.plist, but an
 * unpackaged run (`npm run dev -w desktop`) is the *Electron* bundle and shows
 * Electron's own icon — `app.dock.setIcon` is the only way to override that, and
 * it needs a PNG rather than the .icns. Harmless to call in both cases, so it is
 * not gated on `isPackaged`: it makes the two runs look the same.
 *
 * `assets/icon.png` is deliberately not the raw brand mark: macOS sizes app icons
 * on a grid where the artwork fills 824 of a 1024 canvas, so the source square is
 * inset with a 100px transparent margin. Full-bleed art renders correct-sized but
 * reads as oversized beside every other icon in the dock.
 */
function applyDockIcon() {
  if (process.platform !== 'darwin') return;
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
}

function updateTray() {
  if (!tray) return;
  const alive = (c: ChildProcess | null) => Boolean(c && c.exitCode === null && !c.killed);
  const open = RELAY_MODE
    ? // Hosted mode serves no local UI; the app lives at the public URL.
      { label: 'Open Lines', click: () => void shell.openExternal(config.webUrl) }
    : { label: 'Open Lines', click: openWindow };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      open,
      { label: relayLabel(), enabled: false },
      ...(pairingCode
        ? [
            { label: `Pairing code: ${pairingCode}`, click: () => openPairingWindow(pairingCode!) },
            { label: 'Get a new code', click: () => void refreshPairingCode(true) },
          ]
        : RELAY_MODE
          ? [{ label: 'Unpair this machine…', click: () => void unpairThisMachine() }]
          : []),
      { type: 'separator' as const },
      {
        label: claudeLabel(),
        enabled: cli.state !== 'ok',
        click: () => void shell.openExternal(CLAUDE_INSTALL_URL),
      },
      ...(cli.state === 'ok'
        ? []
        : [
            {
              label: 'Check again',
              click: () => {
                cli = refreshClaudeCli();
                updateTray();
              },
            },
          ]),
      { type: 'separator' as const },
      {
        label: standDown
          ? `Bridge: paused — another bridge owns this machine${standDown.pid ? ` (pid ${standDown.pid})` : ''}`
          : `Bridge: ${alive(bridge) ? 'running' : 'stopped'}`,
        enabled: false,
      },
      { label: `Worker: ${alive(worker) ? 'running' : 'stopped'}`, enabled: false },
      ...(update.state === 'available'
        ? [
            {
              label: `Update available: ${update.version} — download`,
              click: () => void shell.openExternal(config.downloadUrl),
            },
          ]
        : []),
      { type: 'separator' as const },
      {
        label: 'Start at login',
        type: 'checkbox' as const,
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item: { checked: boolean }) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { label: 'Open logs', click: openLogs },
      { type: 'separator' as const },
      { label: 'Quit Lines', click: () => app.quit() },
    ]),
  );
}

/** Reveal the child log in Finder. Touched first, because `showItemInFolder` on a
 *  missing path silently does nothing. */
function openLogs() {
  appendLog('');
  shell.showItemInFolder(LOG_FILE);
}

/**
 * One instance only. A menu-bar app has no window to focus, so a second launch
 * would put a second tray icon up and — worse — a second bridge on this
 * machine's device identity.
 */
// Packaged, this comes from `productName`; unpackaged it would otherwise be
// "Electron" in the dock tooltip, the app menu and any notification we post.
app.setName('Lines');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (pairingCode) openPairingWindow(pairingCode);
    else if (LOCAL_MODE) openWindow();
  });
  void start();
}

async function start() {
  await app.whenReady();
  // Hosted mode is a background app: no dock tile, no app switcher entry. Local
  // mode has a real window, so it gets a tile with our own art — `show()` because
  // the packaged Info.plist carries LSUIElement, which would otherwise suppress it
  // even here.
  if (RELAY_MODE) {
    app.dock?.hide();
  } else {
    applyDockIcon();
    void app.dock?.show();
  }

  if (RELAY_MODE) {
    device = deviceIdentity();
    await refreshPairingCode(false);
  }

  const holder = foreignBridgeLock();
  if (holder) {
    // Another bridge already owns ~/.lines-app — a dev checkout under Tilt, in
    // practice. Spawn neither child: ours would refuse to start (exit 78) and a
    // worker of ours would only compete for the same store. The recheck re-arms
    // both once the lock clears.
    enterStandDown(holder);
  } else {
    // Worker first: the bridge dials it, and starting in this order avoids a
    // pointless retry round on every launch.
    worker = spawnChild('worker', false);
    bridge = spawnChild('bridge', true);
    wireBridgeIpc();
  }

  if (LOCAL_MODE) {
    uiPort = await startUiServer();
    // Logged because it is ephemeral: without this there is no way to reach the
    // UI except through the window we happen to open.
    console.log(`[ui] serving web/dist on http://127.0.0.1:${uiPort}`);
  }

  tray = new Tray(trayImage());
  tray.setToolTip('Lines');
  updateTray();
  setInterval(updateTray, 2_000).unref();

  startUpdateChecks();

  // Hosted mode is a background app: the only reason to put a window on screen
  // is a pairing code the user has to read.
  if (LOCAL_MODE) openWindow();
  else if (pairingCode) openPairingWindow(pairingCode);
}

// The tray app keeps running with no windows open — that is the point of a
// menu-bar app, and closing the window must not kill an in-flight agent turn.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
  bridge?.kill('SIGTERM');
  worker?.kill('SIGTERM');
});
