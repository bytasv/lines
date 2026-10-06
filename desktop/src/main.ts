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
 * Hosted is the default. The app hosts no UI of its own: the user works in the
 * hosted web app — either in their browser or in a plain `BrowserWindow` pointed
 * at the same public URL — and this process exists to run the agent locally and
 * keep an outbound connection open. `LINES_LOCAL_MODE=1` brings back the purely
 * local app (own web server, own window), which is now a dev-only path —
 * `web/dist` is not in the DMG.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  dialog,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import QRCode from 'qrcode';
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
  ENROLL_TTL_MS,
  currentEnrollment,
  listPeers,
  mintEnrollmentCode,
  revokePeer,
  type EnrolledPeer,
} from '../../server/src/e2eeIdentity.ts';
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
/** Voice input's transcriber, shipped in the bundle's resources. */
const BUNDLED_WHISPER = path.join(ROOT, 'whisper', 'whisper-cli');
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
/**
 * The shell's own preferences. Named for the shell rather than its content,
 * unlike every bridge-owned file beside it (`device.json`, `projects.json`), so
 * a future store file cannot claim the name.
 *
 * Same root as the log the tray already reveals: a second location under
 * `app.getPath('userData')` would only double where you have to look.
 */
const PREFS_FILE = path.join(APP_ROOT, 'desktop.json');

const LOCAL_MODE = isLocalMode();
const RELAY_MODE = !LOCAL_MODE;
const config = loadConfig(ROOT);

/**
 * Squirrel.Mac verifies the code signature of the replacement app, so an
 * in-place install needs a Developer ID signed, notarized build. Releases are
 * signed that way now, so updates download in the background and install on a
 * restart (see startUpdateChecks). Off, the shell only checks and points at the
 * download page — all that 0.2.43 and earlier ever do, which is why those
 * builds pick up the first self-installing one by hand.
 */
const CAN_SELF_INSTALL = true;

/**
 * Injected by esbuild, because `electron dist/main.cjs` passes a *file* — Electron
 * never reads desktop/package.json, so `app.getVersion()` answers with Electron's
 * own version unpackaged. Undefined under tsx, hence the `typeof` guard; same
 * pattern as `server/src/index.ts`.
 */
declare const __LINES_VERSION__: string | undefined;

/**
 * The running version, as shown in the tray.
 *
 * Packaged, `app.getVersion()` *is* desktop/package.json's version — the exact
 * value electron-updater compares the feed against — so the displayed version and
 * the updater's basis cannot disagree. Both are logged at boot so a mismatch is
 * visible rather than inferred.
 */
const APP_VERSION = app.isPackaged
  ? app.getVersion()
  : typeof __LINES_VERSION__ === 'string'
    ? __LINES_VERSION__
    : app.getVersion();

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
/** When each child last spawned, for exit logs and the diagnostics summary. */
const childStartedAt: Record<'worker' | 'bridge', number> = { worker: 0, bridge: 0 };
/** Power transitions and relay changes, kept for the diagnostics summary. */
const lastPower: Record<string, number> = {};
let relayChangedAt = 0;
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let pairingWindow: BrowserWindow | null = null;
/** The encryption-enrollment window, when one is open. Its own, not the pairing
 *  window's: the two answer different questions and can both be up at once. */
let enrollWindow: BrowserWindow | null = null;
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
/** Version we have already posted a notification for, so a re-check stays quiet. */
let notifiedUpdateVersion: string | null = null;
/** True once the updater is wired to a real feed and checks are actually running. */
let updatesEnabled = false;
/** Why they are not, when they are not — a tray row, never silence. */
let updatesDisabledReason: string | null = null;
/** A check is in flight; drives the transient `Checking for updates…` row. */
let checking = false;
/**
 * When the last check settled, success or failure. Shell-local rather than a new
 * `UpdateStatus` field: the browser can neither trigger a check nor act on one,
 * so widening the wire protocol would earn nothing.
 */
let lastCheckAt: number | null = null;
/** The single pending post-failure retry, so an offline machine cannot loop. */
let checkRetryTimer: NodeJS.Timeout | null = null;
/**
 * Check a real feed from an unpackaged run. `AppUpdater` gates every check on
 * `app.isPackaged || forceDevUpdateConfig`, so without this the whole network
 * path is unexercisable outside a DMG — which is how a broken release shipped.
 */
const FORCE_UPDATE_CHECK = process.env.LINES_FORCE_UPDATE_CHECK === '1';
/**
 * Pretend the feed offered this version, without a check. Real checks need a live
 * feed, so this is the only practical way to exercise the update surfaces (tray
 * row, notification, title marker, the browser's banner and pane) without a
 * release. LINES_FAKE_UPDATE_STATE picks where it lands: `available` (the
 * default), `downloading` or `ready`. A fake 'ready' never restarts.
 */
const FAKE_UPDATE_VERSION = process.env.LINES_FAKE_UPDATE_VERSION;
const FAKE_UPDATE_STATE: 'available' | 'downloading' | 'ready' =
  (['downloading', 'ready'] as const).find((s) => s === process.env.LINES_FAKE_UPDATE_STATE) ?? 'available';
/** Where "Open Lines" goes. Read once at boot from {@link PREFS_FILE}. */
let openIn: 'desktop' | 'browser' = 'desktop';
/**
 * Whether to hold the Mac awake while a turn is running. On by default: the
 * whole point of leaving this app running is that a session driven from a phone
 * finishes, and a machine that sleeps mid-turn kills it silently.
 */
let keepAwake = true;
/**
 * Whether we have ever set the login item ourselves. Without it a user who
 * deliberately turned start-at-login *off* would have it turned back on at every
 * boot, which is the same bug as a setting that does not persist.
 */
let loginItemDefaulted = false;
/** The user said no to moving the app into Applications; never ask again. */
let moveToApplicationsDeclined = false;
/**
 * The live `powerSaveBlocker` id, or null when nothing is held. A leaked id
 * outlives its turn and keeps the Mac awake forever, so every path that can end
 * a turn — the busy=false message, the bridge's exit, quit — releases it.
 */
let powerBlockerId: number | null = null;
/** Last `activity` the bridge reported, so the tray can say what it is doing. */
let turnActive = false;

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

/** Between automatic checks. */
const UPDATE_CHECK_MS = 6 * 60 * 60_000;

/**
 * After a failed automatic check, try once more.
 *
 * Start-at-login fires the first check while Wi-Fi is still associating, and
 * without this the next attempt is six hours away. Deliberately a single armed
 * timer rather than a repeating one: an offline laptop would otherwise retry
 * every five minutes forever for no benefit.
 */
const UPDATE_RETRY_MS = 5 * 60_000;

/**
 * How stale the last check has to be for a wake from sleep to re-check.
 *
 * A `setInterval` does not fire while the machine sleeps — a laptop closed
 * nightly can go days without the 6h timer ever coming due.
 */
const UPDATE_RESUME_STALE_MS = 60 * 60_000;

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
    // In relay mode this app's own window is the hosted page, which reaches the
    // bridge through the relay, so nothing has a reason to open a socket on the
    // bridge's port at all — and a socket there drives the agent. Local mode is
    // the other way round: the window is our loopback page and dials it directly.
    LINES_BRIDGE_DIRECT: RELAY_MODE ? '0' : '1',
    // autoGuard self-locates from `server/src` under tsx, which matches nothing
    // in a packaged build — so name the files that really back this worker.
    ...(app.isPackaged ? { LINES_WORKER_SOURCES: path.join(SERVER_DIR, 'worker.mjs') } : {}),
    // The whisper-cli this app ships (desktop/scripts/build-whisper.mjs). Only
    // when it is really there: a local package built without cmake has none, and
    // the bridge then falls back to Homebrew's.
    ...(app.isPackaged && fs.existsSync(BUNDLED_WHISPER)
      ? { LINES_WHISPER_BUNDLED_BIN: BUNDLED_WHISPER }
      : {}),
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

/** One previous generation is kept beside the log (`desktop.1.log`) once it passes this. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Bytes in LOG_FILE, tracked in memory so rotation needs no stat per write. Null until first write. */
let logBytes: number | null = null;

function rotateLogIfFull(incoming: number) {
  if (logBytes === null) {
    try {
      logBytes = fs.statSync(LOG_FILE).size;
    } catch {
      logBytes = 0;
    }
  }
  if (logBytes + incoming <= LOG_MAX_BYTES) return;
  try {
    fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.1.log'));
  } catch {
    /* nothing to rotate */
  }
  logBytes = 0;
}

/**
 * Append to the log file, one ISO timestamp per line — without them nothing in
 * here could be lined up against a sleep, a wake, or the relay's own logs.
 * Best-effort: a full disk must not kill the app.
 */
function appendLog(text: string) {
  const stamp = new Date().toISOString();
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) return;
  const out = lines.map((l) => `${stamp} ${l}\n`).join('');
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
    rotateLogIfFull(out.length);
    // Owner-only from the first byte: the log carries session names, paths and
    // the bridge's own diagnostics. `mode` only applies on creation, which is
    // why ensurePrivateAppRoot also tightens a log an older build left behind.
    fs.appendFileSync(LOG_FILE, out, { mode: 0o600 });
    logBytes = (logBytes ?? 0) + out.length;
  } catch {
    /* logging is not worth crashing over */
  }
}

/**
 * Re-cut a child's output into whole lines, each carrying the child's tag. Pipe
 * chunks split anywhere, so tagging chunks left most lines of a burst untagged
 * and could glue two lines' halves under one timestamp.
 */
function lineForwarder(name: string, write: (text: string) => void) {
  let carry = '';
  return (chunk: Buffer) => {
    const text = carry + chunk.toString();
    const cut = text.lastIndexOf('\n');
    if (cut === -1) {
      carry = text;
      return;
    }
    carry = text.slice(cut + 1);
    write(
      text
        .slice(0, cut)
        .split('\n')
        .map((l) => `[${name}] ${l}\n`)
        .join(''),
    );
  };
}

/**
 * A line from the shell itself, to both the log file and stdout.
 *
 * `console.log` alone is unreachable from a packaged LSUIElement app — there is
 * no terminal attached — so anything that has to be diagnosable after the fact
 * goes through here, where "Open logs" can reveal it.
 */
function shellLog(line: string) {
  appendLog(`${line}\n`);
  console.log(line);
}

/** Shell preferences, best-effort: a read-only home must not break the tray. */
function loadPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) as {
      openIn?: unknown;
      keepAwake?: unknown;
      loginItemDefaulted?: unknown;
      moveToApplicationsDeclined?: unknown;
    };
    if (raw.openIn === 'browser' || raw.openIn === 'desktop') openIn = raw.openIn;
    if (typeof raw.keepAwake === 'boolean') keepAwake = raw.keepAwake;
    if (raw.loginItemDefaulted === true) loginItemDefaulted = true;
    if (raw.moveToApplicationsDeclined === true) moveToApplicationsDeclined = true;
  } catch {
    /* absent or corrupt: the default stands */
  }
}

/**
 * Keep `~/.lines-app` readable by this user only.
 *
 * Everything the app knows lives under it — transcripts, the device secret, the
 * e2ee keys, MCP credentials, logs — and a 0755 directory hands all of that to
 * every other account on the machine. Tightening the directory covers whatever
 * an older build created with looser modes beneath it; the log files are
 * tightened too, since "Open logs" is the one place a user is sent to share them
 * from. Best-effort: a read-only or foreign-owned home must not stop the app.
 */
function ensurePrivateAppRoot() {
  try {
    fs.mkdirSync(APP_ROOT, { recursive: true, mode: 0o700 });
    fs.chmodSync(APP_ROOT, 0o700);
  } catch (err) {
    shellLog(`[shell] could not make ${APP_ROOT} private: ${(err as Error).message}`);
  }
  for (const file of [LOG_FILE, LOG_FILE.replace(/\.log$/, '.1.log')]) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* not there yet */
    }
  }
}

function savePrefs() {
  try {
    fs.mkdirSync(APP_ROOT, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      PREFS_FILE,
      `${JSON.stringify({ openIn, keepAwake, loginItemDefaulted, moveToApplicationsDeclined }, null, 2)}\n`,
    );
  } catch (err) {
    shellLog(`[prefs] could not save: ${(err as Error).message}`);
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
  shellLog(`[bridge] standing down — pid ${holder.pid} (${holder.instance}) owns this machine`);
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
      shellLog('[bridge] machine lock is free — re-arming');
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
  const forward = (stream: 'stdout' | 'stderr') =>
    lineForwarder(name, (text) => {
      process[stream].write(text);
      appendLog(text);
    });
  child.stdout?.on('data', forward('stdout'));
  child.stderr?.on('data', forward('stderr'));
  childStartedAt[name] = Date.now();
  shellLog(`[${name}] spawned pid=${child.pid}`);
  child.on('exit', (code, signal) => {
    shellLog(`[${name}] exited code=${code} signal=${signal} after ${Date.now() - childStartedAt[name]}ms`);
    if (quitting) return;
    // Restart the bridge freely — the worker holds the live turns, so this is
    // survivable. A dead worker is NOT auto-restarted: its queries are gone and
    // a silent respawn would look like a healthy session that lost its turn.
    if (name === 'bridge') {
      // The relay link died with it; don't leave the tray claiming otherwise.
      applyRelayStatus({ connected: false });
      // Same reasoning for the blocker: the process that knew whether a turn was
      // running is gone, so a held id would outlive every turn it was taken for.
      // The respawned bridge re-reports within its first 30s tick.
      applyActivity(false);
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
    } else if (msg?.type === 'activity') {
      applyActivity(msg.busy === true);
    }
  });
  // The bridge's UpdateManager is created fresh on every (re)spawn, so re-send
  // whatever we already know instead of leaving the browser at 'idle'.
  if (update.state !== 'idle') sendUpdateStatus();
}

/**
 * Hold the Mac awake for exactly as long as a turn is running.
 *
 * Keyed on a live turn, never on "a session exists": a blocker held whenever the
 * app is paired is a permanent one, and a laptop that never sleeps is a battery
 * complaint rather than a feature. `prevent-app-suspension` keeps the process and
 * the network alive while allowing the display to sleep, which is what an
 * unattended machine driven from a phone needs.
 *
 * Honest limit, repeated in the tray tooltip: this does not defeat closing the
 * lid on battery. Nothing in-process can.
 */
function applyActivity(busy: boolean) {
  turnActive = busy;
  const wanted = busy && keepAwake;
  if (wanted && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    shellLog('[power] holding the machine awake for a running turn');
  } else if (!wanted && powerBlockerId !== null) {
    releasePowerBlocker();
  }
  updateTray();
}

/** Drop the blocker if we hold one. Safe to call when we do not. */
function releasePowerBlocker() {
  if (powerBlockerId === null) return;
  // An id from a previous run of the app is not ours to stop; `isStarted` is the
  // only honest check, and stopping an unknown id throws.
  if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
  powerBlockerId = null;
  shellLog('[power] released');
}

/**
 * Push the current update state to the bridge, which broadcasts it to browsers.
 *
 * Guarded on `connected`, not on the handle: the bridge is respawned after a
 * crash and killed on quit, and neither path nulls `bridge`, so a non-null child
 * is no proof of a live channel. `send` throws synchronously into a closed one,
 * and an uncaught throw here kills the whole shell. The no-op callback covers the
 * same race landing between the check and the write.
 */
function sendUpdateStatus() {
  if (bridge?.connected) bridge.send({ type: 'updateStatus', status: update }, () => {});
}

function setUpdateStatus(status: UpdateStatus) {
  update = status;
  sendUpdateStatus();
  updateTray();
}

/**
 * Announce an update once, natively.
 *
 * The tray menu already lists the update, but nobody opens the tray menu, so a
 * shipped release went unnoticed. Deduped per version rather than per state
 * transition: the 6h re-check re-fires the same version, and nagging four times a
 * day is how a notification gets muted. The dedup is memory-only on purpose — a
 * fresh launch with an update still pending posts one reminder, which is the
 * behaviour we want.
 *
 * A self-installing build announces 'ready', once the download is staged, never
 * the download starting: there is nothing to click until then.
 */
function notifyUpdate(version: string, kind: 'available' | 'ready') {
  // Electron's `'failed'` event is Windows-only, so delivery is undetectable from
  // in here. Recording what we attempted is the only way to tell "never posted"
  // from "posted and swallowed", and the tray row is the surface that does not
  // depend on it either way.
  shellLog(
    `[update] notify ${kind} version=${version} supported=${Notification.isSupported()} deduped=${version === notifiedUpdateVersion}`,
  );
  if (version === notifiedUpdateVersion || !Notification.isSupported()) return;
  notifiedUpdateVersion = version;
  const notification =
    kind === 'ready'
      ? new Notification({
          title: `Lines ${version} is ready`,
          body: 'Click to restart and update. It takes a few seconds.',
        })
      : new Notification({
          title: `Lines ${version} is available`,
          body: 'Click to download. Sessions keep running until you install it.',
        });
  notification.on('click', () => {
    if (kind === 'ready') void confirmRestartForUpdate();
    else void shell.openExternal(config.downloadUrl);
  });
  notification.show();
}

/**
 * Swap in the staged update and relaunch on it.
 *
 * Only from 'ready': the bridge forwards a browser's request without knowing the
 * shell's state, and before 'ready' there is nothing staged to install. Squirrel.Mac
 * closes the windows, the `before-quit` hook stops both children, and the new
 * version comes back up on its own.
 */
function restartForUpdate() {
  if (!CAN_SELF_INSTALL || update.state !== 'ready') {
    shellLog(`[update] restart requested in state=${update.state} — nothing staged to install`);
    return;
  }
  if (FAKE_UPDATE_VERSION) {
    shellLog('[update] restart requested for a fake update — not restarting');
    return;
  }
  shellLog(`[update] restarting to install ${update.version}`);
  autoUpdater.quitAndInstall();
}

/**
 * The restart the tray and the notification offer. Unlike a browser's, which the
 * bridge refuses mid-turn, this one is the user at the machine deciding, so a
 * running turn gets a warning rather than a refusal.
 */
async function confirmRestartForUpdate() {
  if (turnActive) {
    app.focus({ steal: true });
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Restart anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'A session is still running',
      detail: 'Restarting now stops it mid-turn. Lines comes back on the new version in a few seconds.',
    });
    if (response !== 1) return;
  }
  restartForUpdate();
}

/**
 * Checks, and on a signed build ({@link CAN_SELF_INSTALL}) the rest of the update
 * too: a newer version downloads in the background, Squirrel.Mac stages it, and
 * the user restarts into it when it suits them — from the tray, the notification
 * or a browser. Quitting normally installs it as well.
 *
 * Every exit from this function leaves a state the tray can render. A release
 * that announced itself to nobody is what motivated that: previously a rejected
 * check only `console.warn`ed and left `'idle'`, which reads to the user as "you
 * are up to date" — a claim the shell had no evidence for.
 */
function startUpdateChecks() {
  // Wired before every guard, so the reason a check never happened lands in the
  // log too. electron-updater accepts this four-method duck type, so there is no
  // `electron-log` dependency.
  autoUpdater.logger = {
    info: (m: unknown) => shellLog(`[update] ${String(m)}`),
    warn: (m: unknown) => shellLog(`[update] warn ${String(m)}`),
    error: (m: unknown) => shellLog(`[update] error ${String(m)}`),
    debug: (m: unknown) => shellLog(`[update] debug ${String(m)}`),
  };
  shellLog(
    `[update] boot version=${APP_VERSION} appGetVersion=${app.getVersion()} packaged=${app.isPackaged} feed=${config.updateFeedUrl || '(none)'} force=${FORCE_UPDATE_CHECK}`,
  );

  if (FAKE_UPDATE_VERSION) {
    const version = FAKE_UPDATE_VERSION;
    shellLog(`[update] LINES_FAKE_UPDATE_VERSION=${version} state=${FAKE_UPDATE_STATE} — skipping the real check`);
    if (FAKE_UPDATE_STATE === 'downloading') {
      setUpdateStatus({ state: 'downloading', version, progress: 40 });
    } else {
      setUpdateStatus({ state: FAKE_UPDATE_STATE, version });
      notifyUpdate(version, FAKE_UPDATE_STATE);
    }
    return;
  }

  // Both guards are stateful rather than a bare `return`: "this build has no feed"
  // and "checks are off in dev" are failure modes with no surface at all today.
  if (!config.updateFeedUrl) {
    updatesDisabledReason = 'no feed URL in this build';
    shellLog('[update] Skip checkForUpdates: no feed URL in this build');
    updateTray();
    return;
  }
  if (!app.isPackaged && !FORCE_UPDATE_CHECK) {
    updatesDisabledReason = 'dev build — set LINES_FORCE_UPDATE_CHECK=1';
    shellLog('[update] Skip checkForUpdates: dev build — set LINES_FORCE_UPDATE_CHECK=1');
    updateTray();
    return;
  }

  try {
    // `setFeedURL` never reads `app-update.yml`, so this pair genuinely checks the
    // real feed from a checkout.
    autoUpdater.forceDevUpdateConfig = FORCE_UPDATE_CHECK;
    autoUpdater.autoDownload = CAN_SELF_INSTALL;
    // Besides installing on a normal quit, this hands the download to Squirrel.Mac
    // straight away, so the restart that follows takes seconds, not an unpack.
    autoUpdater.autoInstallOnAppQuit = CAN_SELF_INSTALL;
    autoUpdater.setFeedURL({ provider: 'generic', url: config.updateFeedUrl });
    autoUpdater.on('update-available', (info: { version: string }) => {
      shellLog(`[update] available version=${info.version}`);
      if (CAN_SELF_INSTALL) {
        // Straight to downloading: autoDownload has already started it, and an
        // "available" with nothing to click would only flash past in the tray.
        setUpdateStatus({ state: 'downloading', version: info.version, progress: 0 });
        return;
      }
      setUpdateStatus({ state: 'available', version: info.version });
      notifyUpdate(info.version, 'available');
    });
    autoUpdater.on('download-progress', (progress: { percent: number }) => {
      if (update.state !== 'downloading') return;
      // In tens: every step reinstalls the tray menu and goes out to every
      // browser, and a menu swapped a hundred times under an open menu is unusable.
      const step = Math.floor(progress.percent / 10) * 10;
      if (step === update.progress) return;
      setUpdateStatus({ ...update, progress: step });
    });
    // Fires once the zip is downloaded; Squirrel.Mac then stages it in the
    // background, and a restart before it finishes simply waits for it.
    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      shellLog(`[update] downloaded version=${info.version}`);
      setUpdateStatus({ state: 'ready', version: info.version });
      notifyUpdate(info.version, 'ready');
    });
    autoUpdater.on('update-not-available', () => {
      shellLog(`[update] not available — ${APP_VERSION} is current`);
      setUpdateStatus({ state: 'idle' });
    });
    autoUpdater.on('error', (err: Error) => {
      shellLog(`[update] error ${err.message}`);
      // A version we found but could not download or stage (a dropped network,
      // a copy macOS runs read-only) falls back to the manual path: the tray row
      // and the browser banner offer the download page. The next scheduled check
      // tries again, reusing whatever was already downloaded.
      if ((update.state === 'downloading' || update.state === 'ready') && update.version) {
        setUpdateStatus({ state: 'available', version: update.version, message: err.message });
        return;
      }
      setUpdateStatus({ state: 'error', message: err.message });
    });
    updatesEnabled = true;
    void runCheck({});
    setInterval(() => void runCheck({}), UPDATE_CHECK_MS).unref();
    // The interval above does not fire while the machine sleeps, so a laptop that
    // is closed every night would otherwise check almost never.
    powerMonitor.on('resume', () => {
      if (lastCheckAt !== null && Date.now() - lastCheckAt < UPDATE_RESUME_STALE_MS) return;
      shellLog('[update] woke from sleep and the last check is stale — checking');
      void runCheck({});
    });
  } catch (err) {
    // A throw from setFeedURL used to escape start() entirely, silently skipping
    // the pairing window below it — a second invisible failure behind the first.
    updatesEnabled = false;
    updatesDisabledReason = 'updater failed to start';
    shellLog(`[update] failed to start: ${(err as Error).message}`);
    setUpdateStatus({ state: 'error', message: (err as Error).message });
  }
}

/**
 * One check, automatic or asked for.
 *
 * `checkForUpdates()` returns the in-flight promise when one is already running,
 * so a double-click on the menu item is safe.
 */
async function runCheck({ manual }: { manual?: boolean }): Promise<void> {
  // Nothing to look for while a version is downloading or waiting for a restart:
  // another check would only fetch and stage the same update again.
  if (update.state === 'downloading' || update.state === 'ready') {
    shellLog(`[update] check skipped manual=${Boolean(manual)} — ${update.state} ${update.version}`);
    if (manual) await answerManualCheck(null);
    return;
  }
  checking = true;
  updateTray();
  shellLog(`[update] checking manual=${Boolean(manual)}`);
  let failure: string | null = null;
  try {
    await autoUpdater.checkForUpdates();
    // A check that got an answer clears any retry armed by an earlier failure.
    if (checkRetryTimer) {
      clearTimeout(checkRetryTimer);
      checkRetryTimer = null;
    }
  } catch (err) {
    failure = (err as Error).message;
    shellLog(`[update] check failed: ${failure}`);
    // 'idle' would be a claim of currency we have no evidence for.
    setUpdateStatus({ state: 'error', message: failure });
    if (!manual) armRetry();
  } finally {
    checking = false;
    lastCheckAt = Date.now();
    updateTray();
  }
  if (manual) await answerManualCheck(failure);
}

/** A single deferred retry, so a login-time network race is not a six-hour hole. */
function armRetry() {
  if (checkRetryTimer) return;
  checkRetryTimer = setTimeout(() => {
    checkRetryTimer = null;
    shellLog('[update] retrying after an earlier failure');
    void runCheck({});
  }, UPDATE_RETRY_MS);
  checkRetryTimer.unref();
}

/**
 * A manual check always answers with a modal, including "up to date".
 *
 * `focus({ steal: true })` because an LSUIElement app with no dock tile can put a
 * modal behind every other window — and a manual check that appears to do nothing
 * is the exact bug class this whole change exists to remove.
 */
async function answerManualCheck(failure: string | null) {
  app.focus({ steal: true });
  if (update.state === 'ready' && update.version) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Later', 'Restart now'],
      defaultId: 1,
      cancelId: 0,
      message: `Lines ${update.version} is ready to install`,
      detail: turnActive
        ? 'A session is still running, and restarting now stops it mid-turn.'
        : 'Lines restarts on the new version in a few seconds.',
    });
    if (response === 1) restartForUpdate();
    return;
  }
  if (update.state === 'downloading' && update.version) {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      message: `Downloading Lines ${update.version}`,
      detail: 'Lines asks you to restart once it is ready. Sessions keep running until then.',
    });
    return;
  }
  if (update.state === 'available' && update.version) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Later', 'Download'],
      defaultId: 1,
      cancelId: 0,
      message: `Lines ${update.version} is available`,
      detail: 'Sessions keep running until you install it.',
    });
    if (response === 1) void shell.openExternal(config.downloadUrl);
    return;
  }
  if (failure || update.state === 'error') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['OK', 'Open logs'],
      defaultId: 0,
      cancelId: 0,
      message: "Couldn't check for updates",
      detail: failure ?? update.message ?? 'The update feed could not be reached.',
    });
    if (response === 1) openLogs();
    return;
  }
  await dialog.showMessageBox({
    type: 'info',
    buttons: ['OK'],
    message: `Lines ${APP_VERSION} is up to date`,
  });
}

/**
 * The local-mode page's Content-Security-Policy: the hosted policy
 * (deploy/docker/web-nginx.conf), with this machine's loopback added to what
 * the page may connect to — the bridge, and a storage server running beside it
 * in dev. Images only from this origin, data:/blob: and Clerk's avatars, so an
 * image a page somehow renders cannot carry data to a host of an agent's
 * choosing; the markdown renderer already refuses to load any.
 */
function localModeCsp(): string {
  const remote = [config.storageUrl, config.relayUrl]
    .map((url) => {
      try {
        return new URL(url).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join(' ');
  const clerk = 'https://*.clerk.accounts.dev https://*.clerk.com';
  return [
    "default-src 'self'",
    `script-src 'self' blob: ${clerk} https://challenges.cloudflare.com`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://img.clerk.com",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:* ${remote} ${clerk}`,
    `frame-src 'self' blob: ${clerk} https://challenges.cloudflare.com`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
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
      res.writeHead(200, {
        'content-type': types[path.extname(file)] ?? 'application/octet-stream',
        // The same headers the hosted page gets from nginx.
        'content-security-policy': localModeCsp(),
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'strict-origin-when-cross-origin',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

/**
 * Where the app window points: our own server locally, the hosted app otherwise.
 * One function so both modes go through the same window code.
 */
function appUrl(): string {
  return LOCAL_MODE ? `http://127.0.0.1:${uiPort}/` : config.webUrl;
}

/**
 * The app URL for *our own* window, carrying an enrollment code whenever it
 * goes through the relay — which, in relay mode, is always, since every relayed
 * owner channel must be end-to-end encrypted from this machine's first launch.
 *
 * Why this exists: the desktop window is a browser on the hosted origin, so its
 * traffic goes out to the relay and back — it is not a local connection, and the
 * machine refuses it like any other unenrolled browser. Making the user read a
 * code off this machine's tray and type it into this machine's own window is
 * ceremony with no security value: the shell already holds the private key, and
 * a window it opened itself is not a party it needs to authenticate.
 *
 * So the shell hands its own window the code directly. In the **fragment**, so
 * the server never sees it, and the page consumes and strips it on arrival.
 *
 * A live code is reused rather than replaced: minting here would silently
 * invalidate a code the user is part-way through typing on their phone.
 *
 * The fragment also names this machine (`host=<deviceId>`), for the same
 * reason: the bridge sees a relayed socket and cannot tell this window from a
 * phone, so it would hide "Browse…" — a Finder dialog is only useless on a
 * screen nobody is at, and this window is on the host's screen.
 */
function appUrlForOwnWindow(): string {
  const params = new URLSearchParams();
  if (device) params.set('host', device.id);
  if (!LOCAL_MODE) {
    try {
      params.set('enroll', currentEnrollment()?.code ?? mintEnrollmentCode().code);
    } catch (err) {
      // A read-only home, say. The window still opens; the user can enrol by hand.
      shellLog(`[e2ee] could not prepare an enrollment code: ${(err as Error).message}`);
    }
  }
  const fragment = params.toString();
  return fragment ? `${appUrl()}#${fragment}` : appUrl();
}

/**
 * Origin of whatever `appUrl()` currently points at.
 *
 * A function, not a constant: `uiPort` is 0 until `startUiServer()` runs, so a
 * value captured at module load would be the wrong origin in local mode — and
 * trusting the hosted origin there let a link to it replace the local window.
 */
function appOrigin(): string {
  try {
    return new URL(appUrl()).origin;
  } catch {
    return '';
  }
}

/**
 * What the app's own pages may be granted besides the microphone: page alerts,
 * copy buttons, a full-screen view, and handing a link to the OS. Anything not
 * named here — geolocation, MIDI, screen capture, the file system, pointer lock
 * — the app never asks for, so a request for it is not ours to grant.
 */
const APP_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen', 'openExternal']);

/**
 * Voice input records through `getUserMedia`, which reaches this handler as a
 * `media` request. Electron grants every request by default; that is narrowed
 * to the app's own origin for everything: the microphone (and only it) for
 * media, and the short list above for the rest — a third-party page the window
 * wanders onto (an OAuth screen) gets nothing at all.
 *
 * On macOS the OS has its own gate on top: `askForMediaAccess` shows the system
 * prompt the first time, carrying NSMicrophoneUsageDescription from Info.plist,
 * and answers from the user's choice after that.
 */
function installMediaPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    let fromApp = false;
    try {
      fromApp = new URL(details.requestingUrl).origin === appOrigin();
    } catch {
      fromApp = false;
    }
    if (permission !== 'media') return callback(fromApp && APP_PERMISSIONS.has(permission));
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    if (!fromApp || mediaTypes.some((type) => type !== 'audio')) return callback(false);
    if (process.platform !== 'darwin') return callback(true);
    systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
  });
}

/**
 * Host of the *hosted* app, even in local mode: the identity hosts below belong
 * to the Clerk instance the web bundle was built against, which is the hosted
 * one no matter where the window points.
 */
const APP_HOST = hostLabel(config.webUrl);

/**
 * The domain the Clerk instance is bound to: APP_HOST less its first label
 * (`run.linesapp.cloud` → `linesapp.cloud`). Clerk's `clerk.` and `accounts.`
 * hosts hang off that, not off the app's own subdomain. A host with no
 * subdomain to drop — an IP, `localhost`, a bare domain — is left as is.
 */
function clerkDomain(host: string): string {
  const name = host.replace(/:\d+$/, '');
  if (/^[\d.]+$/.test(name) || name.startsWith('[')) return host;
  const labels = name.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : host;
}

const CLERK_DOMAIN = clerkDomain(APP_HOST);

/**
 * Hosts that are nothing but identity infrastructure, trusted host-wide.
 *
 * Nothing on them is content an agent would link to, so path-scoping is pure
 * downside — Microsoft's authorize path carries a tenant segment, Google has two
 * authorize paths, and every miss is a window with no way back.
 */
const IDENTITY_HOSTS = [
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  `accounts.${CLERK_DOMAIN}`,
  // Clerk's Frontend API host, which serves /v1/oauth_callback.
  `clerk.${CLERK_DOMAIN}`,
];

/** Clerk's Account Portal on development instances, with or without a `clerk.` label. */
function isIdentityHost(hostname: string): boolean {
  return IDENTITY_HOSTS.includes(hostname) || hostname.endsWith('.accounts.dev');
}

/**
 * OAuth entry points on hosts that are also content sites.
 *
 * `github.com` is the whole reason this file changed: allowing it host-wide made
 * every GitHub link in agent output replace the app. Keeping it the only scoped
 * host means this class of sign-in breakage has exactly one possible location.
 */
const OAUTH_ENTRY_PREFIXES: Record<string, string[]> = {
  'github.com': ['/login/oauth/'],
};

/** Schemes we are willing to hand to the real browser. */
const EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:'];

type WindowRole = 'app' | 'aux';

type Verdict =
  | { action: 'in-app'; rule?: 'identity' | 'oauth-entry' | 'continuation' }
  | { action: 'external' }
  | { action: 'drop' };

/**
 * Whether a navigation stays in the window, goes to the browser, or is dropped.
 *
 * Evaluated top to bottom, and the order is load-bearing:
 *
 * - The app-origin check precedes any scheme gate, because attachments are
 *   `blob:` object URLs minted by the web app — their origin is the app origin,
 *   and `shell.openExternal('blob:…')` does nothing, so a scheme gate placed
 *   first would silently break opening them.
 * - "Already off-app therefore mid-sign-in" is compared against the *app*
 *   origin, not against the identity list: mid-flow the window ends up on hosts
 *   nobody can enumerate (`idmsa.apple.com`, `login.live.com`) and the
 *   credential POST fires `will-navigate`. Requiring the current URL to parse as
 *   http/https is what stops the offline page (`data:`) or a fresh window (`''`)
 *   from counting as off-app and turning the whole policy permissive.
 */
function navigationVerdict(raw: string, currentUrl: string, role: WindowRole): Verdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { action: 'drop' };
  }
  // The pairing window is a data: URL showing a code. It navigates nowhere at
  // all, the app origin included — losing the code is the failure we are fixing.
  if (role === 'aux') {
    return EXTERNAL_SCHEMES.includes(url.protocol) ? { action: 'external' } : { action: 'drop' };
  }
  const origin = appOrigin();
  if (origin && url.origin === origin && ['http:', 'https:', 'blob:'].includes(url.protocol)) {
    return { action: 'in-app' };
  }
  if (url.protocol === 'https:') {
    if (isIdentityHost(url.hostname)) return { action: 'in-app', rule: 'identity' };
    const prefixes = OAUTH_ENTRY_PREFIXES[url.hostname];
    if (prefixes?.some((prefix) => url.pathname.startsWith(prefix))) {
      return { action: 'in-app', rule: 'oauth-entry' };
    }
  }
  if (isOffApp(currentUrl)) return { action: 'in-app', rule: 'continuation' };
  return EXTERNAL_SCHEMES.includes(url.protocol) ? { action: 'external' } : { action: 'drop' };
}

/** Whether the window is currently parked on a real page that is not ours. */
function isOffApp(currentUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    if (current.protocol !== 'http:' && current.protocol !== 'https:') return false;
    return current.origin !== appOrigin();
  } catch {
    return false;
  }
}

/**
 * Every window's navigation policy, and the only place `Verdict` is acted on.
 *
 * `will-redirect` is deliberately not handled. Electron emits it separately for
 * every 302, and every OAuth flow's intermediate hops arrive that way, so
 * guarding it is the single most likely way to break sign-in for all providers
 * at once. The residual hole — a page we already allowed can 302 the window
 * elsewhere — is what the "Back to Lines" pill and the tray reload cover.
 *
 * `will-frame-navigate` is likewise not added: it fires for the main frame too
 * and would double-handle everything, and `web/src` has no iframes. If an embed
 * ever lands, the hook is that event filtered on `!details.isMainFrame`.
 */
function attachNavigationGuards(w: BrowserWindow, role: WindowRole) {
  const contents = w.webContents;
  // Every window passes through here, popups included, so the menu rides along.
  attachContextMenu(contents);
  // A real child window in the same session, so cookies are shared — what a Clerk
  // OAuth popup needs. Anything else goes to the real browser.
  contents.setWindowOpenHandler(({ url }) => {
    const verdict = navigationVerdict(url, contents.getURL(), role);
    if (verdict.action === 'in-app') {
      if (verdict.rule) shellLog(`[window] in-app (${verdict.rule}) ${url}`);
      return { action: 'allow' };
    }
    if (verdict.action === 'drop') {
      shellLog(`[window] dropped ${schemeLabel(url)} navigation to ${url}`);
      return { action: 'deny' };
    }
    shellLog(`[window] external popup ${url}`);
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Popups we allowed are windows too, and until now they carried no guards at
  // all — a link inside one could wander anywhere.
  contents.on('did-create-window', (child) => attachNavigationGuards(child, 'app'));
  // Load-bearing: without it a `target="_self"` external link replaces the app
  // inside a chrome-less window with no way back, and with it Clerk's full-page
  // OAuth redirect survives. Every block is logged because the allowlist above
  // will be incomplete for some provider, and the log turns "sign-in is broken"
  // into a one-line fix.
  contents.on('will-navigate', (event, url) => {
    const verdict = navigationVerdict(url, contents.getURL(), role);
    if (verdict.action === 'in-app') {
      if (verdict.rule) shellLog(`[window] in-app (${verdict.rule}) ${url}`);
      return;
    }
    event.preventDefault();
    if (verdict.action === 'drop') {
      shellLog(`[window] dropped ${schemeLabel(url)} navigation to ${url}`);
      return;
    }
    shellLog(`[window] blocked navigation to ${url} — opening externally`);
    void shell.openExternal(url);
  });
  if (role === 'app') {
    contents.on('did-navigate', (_event, url) => {
      if (!isOffApp(url)) return;
      void injectBackToLines(contents);
    });
  }
}

/**
 * The right-click menu. Electron ships none, so without this the window has no
 * Cut/Copy/Paste or link actions at all. Link items never load anything in the
 * window — they copy, or hand `EXTERNAL_SCHEMES` URLs to the real browser — so
 * the navigation policy above stays the only way in. A custom web menu must
 * `preventDefault` its `contextmenu` event or this one pops up as well.
 */
function attachContextMenu(contents: Electron.WebContents) {
  contents.on('context-menu', (_event, params) => {
    const sections: MenuItemConstructorOptions[][] = [];
    if (params.misspelledWord && params.dictionarySuggestions.length) {
      sections.push(
        params.dictionarySuggestions.map((suggestion) => ({
          label: suggestion,
          click: () => contents.replaceMisspelling(suggestion),
        })),
      );
    }
    if (params.isEditable) {
      const flags = params.editFlags;
      sections.push(
        [
          { role: 'undo', enabled: flags.canUndo },
          { role: 'redo', enabled: flags.canRedo },
        ],
        [
          { role: 'cut', enabled: flags.canCut },
          { role: 'copy', enabled: flags.canCopy },
          { role: 'paste', enabled: flags.canPaste },
          { role: 'selectAll', enabled: flags.canSelectAll },
        ],
      );
    } else if (params.selectionText.trim()) {
      sections.push([{ role: 'copy' }]);
    }
    if (params.linkURL) {
      const link = params.linkURL;
      const items: MenuItemConstructorOptions[] = [
        { label: 'Copy Link', click: () => clipboard.writeText(link) },
      ];
      if (isExternalScheme(link)) {
        items.push({ label: 'Open Link in Browser', click: () => void shell.openExternal(link) });
      }
      sections.push(items);
    }
    if (params.mediaType === 'image' && params.srcURL) {
      sections.push([
        { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) },
      ]);
    }
    if (!app.isPackaged) {
      sections.push([
        { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) },
      ]);
    }
    const template = sections.flatMap((section, i) =>
      i === 0 ? section : [{ type: 'separator' as const }, ...section],
    );
    const owner = BrowserWindow.fromWebContents(contents);
    if (!template.length || !owner || owner.isDestroyed()) return;
    Menu.buildFromTemplate(template).popup({ window: owner });
  });
}

function isExternalScheme(raw: string): boolean {
  try {
    return EXTERNAL_SCHEMES.includes(new URL(raw).protocol);
  } catch {
    return false;
  }
}

/** Scheme of a URL for a log line, without assuming it parses. */
function schemeLabel(raw: string): string {
  try {
    return new URL(raw).protocol.replace(':', '');
  } catch {
    return 'unparseable';
  }
}

/**
 * A way home from an abandoned sign-in.
 *
 * The window has no address bar, so a provider page the user backs out of is a
 * dead end. `insertCSS` rather than an inline `style` attribute because a strict
 * CSP can strip the latter; a plain anchor to the app origin rather than IPC
 * because that navigation is allowed by the app-origin rule, which keeps the
 * window's no-preload/no-IPC contract intact. Idempotent on the element id, so
 * a redirect chain does not stack pills.
 */
async function injectBackToLines(contents: Electron.WebContents) {
  const href = appUrl();
  if (!href) return;
  try {
    await contents.insertCSS(`
      #lines-back-pill { position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
        display: inline-block; padding: 8px 14px; border-radius: 999px;
        background: #1a1b1e; color: #4dabf7; border: 1px solid #373a40;
        font: 13px -apple-system, system-ui, sans-serif; text-decoration: none;
        box-shadow: 0 2px 10px rgba(0,0,0,.35) }
    `);
    await contents.executeJavaScript(
      `(() => {
        if (document.getElementById('lines-back-pill')) return;
        const a = document.createElement('a');
        a.id = 'lines-back-pill';
        a.textContent = '← Back to Lines';
        a.href = ${JSON.stringify(href)};
        document.body.appendChild(a);
      })();`,
      true,
    );
  } catch (err) {
    // A page that refuses the injection is not worth failing over — the tray's
    // "Open Lines" still comes home.
    shellLog(`[window] back-to-Lines pill not injected: ${(err as Error).message}`);
  }
}

/**
 * The app in a native window.
 *
 * Deliberately zero-privilege: no preload, no IPC, `contextIsolation` on. That is
 * what makes loading a remote origin acceptable — the page gets nothing it would
 * not get in Safari. The hosted bundle takes its bridge URL from
 * `VITE_BRIDGE_WS_URL` and never probes `/__bridge`, so it needs nothing from us.
 */
function openWindow() {
  if (win && !win.isDestroyed()) {
    // "Open Lines" always comes home: a window abandoned mid-sign-in is parked
    // off-app with no address bar, and showing it as-is leaves it stuck.
    if (isOffApp(win.webContents.getURL())) void win.loadURL(appUrlForOwnWindow());
    win.show();
    win.focus();
    return;
  }
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Lines',
    // The web app's Mantine-dark background, so a slow hosted load is not a
    // white flash.
    backgroundColor: '#1a1b1e',
    // No background throttling: this window is the bridge's only source of
    // fresh Clerk tokens (the web app's 50s relayAuth timer), and a throttled
    // timer while minimized lets the ~60s token expire into a sync outage.
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  });
  win = w;
  void w.loadURL(appUrlForOwnWindow());
  attachNavigationGuards(w, 'app');
  w.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which every cancelled navigation reports.
    if (!isMainFrame || code === -3) return;
    shellLog(`[window] load failed ${code} ${description} ${url}`);
    void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadErrorHtml(description))}`);
  });
  mirrorRendererLog(w);
  w.on('closed', () => {
    if (win === w) win = null;
    syncDock();
  });
  syncDock();
  w.show();
  // The accessory -> regular dock transition leaves the window behind whatever
  // was in front, so focusing after the tile exists is not redundant.
  w.focus();
}

/**
 * The renderer's console, onto disk. This window has no devtools open and no
 * preload, so without this the web app's own record of a stuck connect — the
 * `[diag]` lines — never leaves it. Filtered: the app is chatty at info level,
 * and only the connection path and real warnings are worth the log's space.
 */
const MIRRORED_TAGS = /^\[(diag|ws|e2ee)\]/;

function mirrorRendererLog(w: BrowserWindow) {
  const wc = w.webContents;
  // Electron's legacy positional form: level 0 verbose, 1 info, 2 warning, 3 error.
  wc.on('console-message', (_event, level, message) => {
    if (level < 2 && !MIRRORED_TAGS.test(message)) return;
    shellLog(`[renderer] ${message.length > 2000 ? `${message.slice(0, 2000)}…` : message}`);
  });
  wc.on('did-finish-load', () => shellLog(`[window] loaded ${redactQuery(wc.getURL())}`));
  wc.on('render-process-gone', (_event, details) =>
    shellLog(`[window] renderer gone reason=${details.reason} exitCode=${details.exitCode}`),
  );
  w.on('unresponsive', () => shellLog('[window] unresponsive'));
  w.on('responsive', () => shellLog('[window] responsive again'));
}

/**
 * The web app's own wake signal (visibilitychange, pageshow[persisted]) never
 * fires in this window: it is never hidden and never bfcache-restored, so
 * `document.hidden` stays false straight through a sleep. Confirmed in the
 * field — after a real sleep/wake, the renderer logged nothing at all for
 * ~100s while the bridge/relay had already reconnected, until the user
 * reloaded by hand. This is the substitute: the one signal the web app
 * structurally cannot generate for itself, pushed in from outside.
 *
 * `visibilitychange` (not a custom event) so it reruns the exact handler
 * `wireConnectivity` already registers — no new listener needed in ws.ts.
 * Best-effort: no window, a destroyed one, or a page still loading must not
 * throw past this into the powerMonitor callback.
 */
function nudgeWindowAwake(reason: 'resume' | 'unlock-screen'): void {
  if (!win || win.isDestroyed()) return;
  win.webContents
    .executeJavaScript(`document.dispatchEvent(new Event('visibilitychange'))`)
    .catch((err: Error) => shellLog(`[window] wake nudge (${reason}) failed: ${err.message}`));
}

/** The app URL carries an enrollment code in its fragment; never write that to disk. */
function redactQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Offline used to be a white void. Shares the pairing window's styling. */
function loadErrorHtml(reason: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Lines</title>
<style>
  body { font: 14px -apple-system, system-ui, sans-serif; background:#1a1b1e; color:#c1c2c5;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0 }
  .card { text-align:center; max-width:420px; padding:0 24px }
  a { color:#4dabf7 }
  .hint { color:#909296; font-size:12px; margin-top:18px }
</style>
<div class="card">
  <h2>Can’t reach Lines</h2>
  <p>${escapeHtml(hostLabel(appUrl()))} did not respond.</p>
  <p class="hint">${escapeHtml(reason)}<br>
  Sessions on this machine keep running. Check your connection, then
  <a href="${escapeHtml(appUrl())}">try again</a>.</p>
</div>`;
}

/**
 * The dock tile follows the windows, in hosted mode.
 *
 * A visible window with no dock tile has no Cmd-Tab, no way back when it is
 * covered, and — the real problem — no application menu, so Cmd-C and Cmd-V do
 * not work. `LSUIElement` stays in the Info.plist; the tile is toggled at
 * runtime instead. Local mode always has a tile, set up in `start()`.
 */
function syncDock() {
  if (process.platform !== 'darwin' || LOCAL_MODE) return;
  const anyWindow = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed());
  if (anyWindow) {
    applyDockIcon();
    void app.dock?.show();
  } else {
    app.dock?.hide();
  }
}

/** "Open Lines", per the user's choice. Local mode has only the one route. */
function openLinesDefault() {
  if (RELAY_MODE && openIn === 'browser') void shell.openExternal(config.webUrl);
  else openWindow();
}

/**
 * The escape hatch for "I signed into the wrong account in a window with no
 * address bar" — the window's cookie jar is not the browser's, so there is
 * otherwise no way to sign out of it from outside.
 */
async function resetDesktopWindow() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Reset'],
    defaultId: 0,
    cancelId: 0,
    message: 'Sign out of the Lines desktop window?',
    detail:
      'Clears the cookies and local data of the desktop window only, and closes it. Your browser, this machine’s pairing and any running sessions are not touched.',
  });
  if (response !== 1) return;
  await session.defaultSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb'] });
  shellLog('[window] desktop window storage cleared');
  if (win && !win.isDestroyed()) win.close();
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
  <p>Enter this code in <a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>:</p>
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
    syncDock();
  });
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  attachNavigationGuards(w, 'aux');
  // Gives this window a dock tile and an app menu too, so the code is selectable
  // with Cmd-C — it never had either.
  syncDock();
  w.focus();
}

/**
 * Mint a one-time encryption code and put it on screen, as text and as a QR.
 *
 * This is the out-of-band step the whole threat model rests on: the code travels
 * through the *user*, from this machine's own screen to the browser, so the
 * server in the middle never sees it and cannot substitute a key. The QR is a
 * plain link into the web app with the code in the query, so a phone's own
 * camera opens it — no scanner in the bundle, and nothing to install.
 *
 * Deliberately one code, one device, fifteen minutes: a code left on a screen
 * would otherwise be a standing invitation to enrol.
 */
async function openEncryptionWindow(): Promise<void> {
  const { code, expiresAt } = mintEnrollmentCode();
  // Fragment, never a query string. A query string is sent to the server on the
  // very first request — and the server is precisely the party this code exists
  // to exclude, so putting it there would hand the secret to the attacker the
  // out-of-band exchange is defending against. A fragment never leaves the
  // browser.
  const link = `${config.webUrl}#enroll=${encodeURIComponent(code)}`;
  // Data URL, generated here: rendering it in the page would mean shipping a QR
  // library into a window that is otherwise inert HTML.
  const qr = await QRCode.toDataURL(link, { margin: 1, width: 240 }).catch(() => '');
  const minutes = Math.round(ENROLL_TTL_MS / 60_000);
  const grouped = code.replace(/(.{5})(?=.)/g, '$1 ');
  const html = `<!doctype html><meta charset="utf-8"><title>Encryption code</title>
<style>
  body { font: 14px -apple-system, system-ui, sans-serif; background:#1a1b1e; color:#c1c2c5;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0 }
  .card { text-align:center; max-width:440px; padding:0 24px }
  .code { font:600 22px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:3px;
          color:#fff; margin:16px 0; user-select:all }
  img { background:#fff; padding:8px; border-radius:8px }
  .hint { color:#909296; font-size:12px; margin-top:16px }
</style>
<div class="card">
  <h2>Enrol a browser on this machine</h2>
  <p>Every browser needs this once to connect. In Lines, enter it when asked, or under Settings → Encryption:</p>
  <div class="code">${escapeHtml(grouped)}</div>
  ${qr ? `<img src="${qr}" alt="Enrollment QR code" width="240" height="240">` : ''}
  <p class="hint">Scan with a phone to open Lines with the code filled in.<br>
  Works once, and expires in ${minutes} minutes. Anyone who reads this code before you use it
  could enrol their own browser, so treat it like a password.<br>
  Expires ${new Date(expiresAt).toLocaleTimeString()}.</p>
</div>`;
  if (enrollWindow && !enrollWindow.isDestroyed()) {
    void enrollWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    enrollWindow.show();
    enrollWindow.focus();
    return;
  }
  const w = new BrowserWindow({
    width: 520,
    height: 640,
    title: 'Encryption code',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  enrollWindow = w;
  w.on('closed', () => {
    if (enrollWindow === w) enrollWindow = null;
    syncDock();
  });
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  attachNavigationGuards(w, 'aux');
  syncDock();
  w.focus();
}

/**
 * Forget an enrolled browser, after confirming.
 *
 * The tray is deliberately a route to this that needs no browser: key pinning
 * plus a lost device is otherwise an unrecoverable state, and "revoke and
 * re-enrol from the machine itself" is the way back in.
 */
function revokeEnrolledPeer(peer: EnrolledPeer): void {
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Cancel', 'Revoke'],
    defaultId: 0,
    cancelId: 0,
    message: `Revoke ${peer.label}?`,
    detail:
      `That browser (${peer.fingerprint}) will be refused the next time it connects. ` +
      'It can be enrolled again with a new code.',
  });
  if (choice !== 1) return;
  revokePeer(peer.publicKey);
  updateTray();
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
    shellLog(pairingCode ? `[device] ${device.id} awaiting pairing` : `[device] ${device.id} already paired`);
  } catch (err) {
    // Not fatal: the bridge retries the relay forever, so a machine that
    // registers late still comes up once storage is reachable again.
    shellLog(`[device] register failed: ${(err as Error).message}`);
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
  // Logged on change only: the tray repaints every 2s but the link rarely moves.
  if (relay?.connected !== status.connected || relay?.code !== status.code) {
    relayChangedAt = Date.now();
    shellLog(
      status.connected
        ? '[relay-status] connected — settling'
        : `[relay-status] disconnected${status.code ? ` code=${status.code}` : ''}${status.reason ? ` ${status.reason}` : ''}`,
    );
  }
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
  if (firstTime) shellLog('[relay-status] verified (paired and attached)');
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

/** "3 minutes ago", roughly, for the last-checked row. */
function agoLabel(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The update row, which is always present.
 *
 * Taking this out of the old `state === 'available'` conditional is the single
 * change that makes a silent update outcome impossible: "no feed", "never
 * checked" and "the check failed" each now say so, where before all three
 * rendered as nothing at all — indistinguishable from up to date.
 *
 * An error is a plain row rather than the `' ●'` title marker on purpose. That
 * dot means "act on a new version"; one that lights up whenever you are offline
 * teaches the user to ignore the only signal that matters.
 */
function updateRow(): { label: string; enabled: boolean; click?: () => void } {
  // A staged or downloading version first, ahead of the checking and disabled
  // cases: runCheck skips while either is in progress, and an offered version is
  // what the user can act on (or wait for) whatever automatic checking is doing.
  // These, and 'available', are also the rows LINES_FAKE_UPDATE_VERSION exercises.
  if (update.state === 'ready') {
    return {
      label: `Restart to update to ${update.version}`,
      enabled: true,
      click: () => void confirmRestartForUpdate(),
    };
  }
  if (update.state === 'downloading') {
    return { label: `Downloading ${update.version}… ${update.progress ?? 0}%`, enabled: false };
  }
  if (checking) return { label: 'Checking for updates…', enabled: false };
  // From a build that cannot install it, or a download that failed: the manual way.
  if (update.state === 'available') {
    return {
      label: `Update available: ${update.version} — download`,
      enabled: true,
      click: () => void shell.openExternal(config.downloadUrl),
    };
  }
  if (!updatesEnabled) {
    return { label: `Automatic updates off — ${updatesDisabledReason ?? 'unknown reason'}`, enabled: false };
  }
  if (update.state === 'error') {
    // The message stays in the log: a menu item cannot wrap, and a truncated TLS
    // error tells the user nothing.
    return { label: 'Update check failed — open logs', enabled: true, click: openLogs };
  }
  if (lastCheckAt !== null) return { label: `Up to date · checked ${agoLabel(lastCheckAt)}`, enabled: false };
  return { label: 'No update check yet', enabled: false };
}

/** Signature of the last menu we actually installed; see {@link updateTray}. */
let trayMenuSignature: string | null = null;

function updateTray() {
  if (!tray) return;
  // A persistent marker beside the icon, so a pending update is visible without
  // opening the menu. `setTitle` is macOS-only, like applyDockIcon's guard; a
  // dock badge is not an option because hosted mode hides the dock tile when no
  // window is open. Setting '' on any other state is what clears it (including
  // available -> idle).
  const title = update.state === 'available' || update.state === 'ready' ? ' ●' : '';
  const alive = (c: ChildProcess | null) => Boolean(c && c.exitCode === null && !c.killed);
  // Read once per rebuild rather than per row: this runs every 2s, and the menu
  // is only reinstalled when its rendered text changes (see the signature below).
  const enrolledPeers = RELAY_MODE ? listPeers() : [];
  const template: MenuItemConstructorOptions[] = [
    // One row, always labelled the same, dispatching per the saved preference —
    // so the primary action never moves. The other route is the row below it.
    { label: 'Open Lines', click: openLinesDefault },
    ...(RELAY_MODE
      ? [
          openIn === 'browser'
            ? { label: 'Open Desktop Window', click: openWindow }
            : { label: 'Open in Browser', click: () => void shell.openExternal(config.webUrl) },
        ]
      : []),
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
    { type: 'separator' as const },
    // Its own group below the process rows: those answer "is it running", these
    // answer "is it current".
    { label: `Lines ${APP_VERSION}`, enabled: false },
    updateRow(),
    ...(updatesEnabled ? [{ label: 'Check for updates', click: () => void runCheck({ manual: true }) }] : []),
    { type: 'separator' as const },
    ...(RELAY_MODE
      ? [
          {
            label: 'Open Lines in the desktop window',
            type: 'checkbox' as const,
            checked: openIn === 'desktop',
            click: (item: { checked: boolean }) => {
              openIn = item.checked ? 'desktop' : 'browser';
              savePrefs();
              updateTray();
            },
          },
          { label: 'Reset desktop window…', click: () => void resetDesktopWindow() },
        ]
      : []),
    ...(RELAY_MODE
      ? [
          { type: 'separator' as const },
          {
            label: 'Show encryption code…',
            click: () => void openEncryptionWindow(),
          },
          ...(enrolledPeers.length
            ? [
                { label: 'Encrypted browsers', enabled: false },
                ...enrolledPeers.map((peer) => ({
                  label: `  ${peer.label} · ${peer.fingerprint}`,
                  toolTip: 'Click to revoke',
                  click: () => revokeEnrolledPeer(peer),
                })),
              ]
            : [{ label: 'No browser enrolled yet — enrol one to connect', enabled: false }]),
          { type: 'separator' as const },
        ]
      : []),
    {
      label: 'Start at login',
      type: 'checkbox' as const,
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item: { checked: boolean }) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        // Recorded so the boot-time default never overrides a deliberate off.
        loginItemDefaulted = true;
        savePrefs();
        updateTray();
      },
    },
    {
      // Read from `keepAwake`, not from the blocker id: the signature this menu
      // dedupes on is rebuilt every 2s, and a row that flickered with each turn
      // would reinstall the NSMenu under an open menu.
      label: 'Keep Mac awake during turns',
      type: 'checkbox' as const,
      checked: keepAwake,
      click: (item: { checked: boolean }) => {
        keepAwake = item.checked;
        savePrefs();
        // Apply to whatever is running right now rather than at the next turn.
        applyActivity(turnActive);
      },
    },
    { label: 'Open logs', click: openLogs },
    { label: 'Collect diagnostics…', click: () => void collectDiagnostics() },
    { type: 'separator' as const },
    { label: 'Quit Lines', click: () => app.quit() },
  ];
  // This runs every 2s. `JSON.stringify` drops the click closures, leaving exactly
  // the rendered fields, so an unchanged menu is not reinstalled — which both
  // stops ~43k pointless `setContextMenu` calls a day and, more importantly, stops
  // swapping the NSMenu out from under a menu the user has open. Relative-time
  // labels still refresh, because their text is part of the signature.
  const signature = `${title}\0${JSON.stringify(template)}`;
  if (signature === trayMenuSignature) return;
  trayMenuSignature = signature;
  if (process.platform === 'darwin') tray.setTitle(title);
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

/** Reveal the child log in Finder. Touched first, because `showItemInFolder` on a
 *  missing path silently does nothing. */
function openLogs() {
  appendLog('');
  shell.showItemInFolder(LOG_FILE);
}

/**
 * One zip holding everything needed to explain "the window won't connect":
 * shell + child logs, the runtime discovery files, the machine lock, and a
 * summary of what the shell believes right now. Built with the system's
 * `ditto`, so no archive dependency ships in the app.
 *
 * Secrets never go in: device.json's secret and every runtime file's `token`
 * are stripped before copying.
 */
async function collectDiagnostics(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(APP_ROOT, 'diagnostics');
  const staging = path.join(outDir, `lines-diag-${stamp}`);
  const zip = `${staging}.zip`;
  try {
    fs.mkdirSync(path.join(staging, 'logs'), { recursive: true });
    for (const file of [LOG_FILE, LOG_FILE.replace(/\.log$/, '.1.log')]) {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(staging, 'logs', path.basename(file)));
    }
    const runRoot = path.join(APP_ROOT, 'run');
    for (const instance of fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : []) {
      const dir = path.join(runRoot, instance);
      if (!fs.statSync(dir).isDirectory()) continue;
      fs.mkdirSync(path.join(staging, 'run', instance), { recursive: true });
      for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        const info = readJsonSafe(path.join(dir, name));
        if (info && typeof info === 'object') delete (info as Record<string, unknown>).token;
        fs.writeFileSync(path.join(staging, 'run', instance, name), JSON.stringify(info, null, 2));
      }
    }
    const lock = readJsonSafe(BRIDGE_LOCK_FILE);
    if (lock) fs.writeFileSync(path.join(staging, 'bridge.lock.json'), JSON.stringify(lock, null, 2));
    // The id only: the secret is the machine's relay credential.
    if (device) fs.writeFileSync(path.join(staging, 'device.json'), JSON.stringify({ id: device.id }, null, 2));
    const now = Date.now();
    const ago = (t: number) => (t ? `${Math.round((now - t) / 1000)}s ago` : null);
    const summary = {
      at: new Date(now).toISOString(),
      version: APP_VERSION,
      instance: INSTANCE,
      relayMode: RELAY_MODE,
      deviceId: device?.id ?? null,
      paired: !pairingCode,
      relay: { ...relay, verified: relayVerified, changed: ago(relayChangedAt) },
      standDown,
      children: {
        bridge: { pid: bridge?.pid ?? null, alive: !!bridge && bridge.exitCode === null, started: ago(childStartedAt.bridge) },
        worker: { pid: worker?.pid ?? null, alive: !!worker && worker.exitCode === null, started: ago(childStartedAt.worker) },
      },
      power: Object.fromEntries(Object.entries(lastPower).map(([k, t]) => [k, new Date(t).toISOString()])),
      uptimeSec: Math.round(process.uptime()),
      window: win && !win.isDestroyed() ? redactQuery(win.webContents.getURL()) : null,
    };
    fs.writeFileSync(path.join(staging, 'summary.json'), JSON.stringify(summary, null, 2));
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', staging, zip]);
    fs.rmSync(staging, { recursive: true, force: true });
    shellLog(`[diag] collected ${zip}`);
    shell.showItemInFolder(zip);
  } catch (err) {
    shellLog(`[diag] collect failed: ${(err as Error).message}`);
    dialog.showErrorBox('Could not collect diagnostics', (err as Error).message);
  }
}

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
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
    // Relaunching from Finder or Spotlight used to do nothing at all in hosted
    // mode, which reads as a broken app.
    if (pairingCode) openPairingWindow(pairingCode);
    else openLinesDefault();
  });
  // Clicking the dock tile with the window closed. Only reachable while a tile
  // exists, i.e. local mode or a hosted run that has a window open.
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())) openLinesDefault();
  });
  void start();
}

/**
 * Squirrel.Mac replaces the app where it sits, which it cannot do on the mounted
 * DMG or on the read-only copy macOS runs a quarantined download from. So a
 * packaged app outside Applications offers, once, to move itself there.
 * Declining is remembered; an update that then fails to install falls back to
 * the download page like any other failed install.
 *
 * True when the move is under way and the app is about to relaunch from there.
 */
async function offerMoveToApplications(): Promise<boolean> {
  if (!app.isPackaged || process.platform !== 'darwin' || moveToApplicationsDeclined) return false;
  if (app.isInApplicationsFolder()) return false;
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Move to Applications', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Move Lines to your Applications folder?',
    detail: 'Lines can only update itself from there. It reopens from Applications right away.',
  });
  if (response !== 0) {
    moveToApplicationsDeclined = true;
    savePrefs();
    shellLog('[shell] move to Applications declined');
    return false;
  }
  try {
    shellLog('[shell] moving to Applications');
    return app.moveToApplicationsFolder();
  } catch (err) {
    shellLog(`[shell] move to Applications failed: ${(err as Error).message}`);
    return false;
  }
}

async function start() {
  await app.whenReady();
  // Google refuses OAuth from anything it recognises as an embedded browser, and
  // it keys on this token. The standard workaround, not a guarantee. Set on the
  // app rather than per-webContents so OAuth popups carry the scrubbed UA too.
  app.userAgentFallback = app.userAgentFallback.replace(/ Electron\/\S+/, '');
  installMediaPermissions();
  // Before anything writes beneath it — the log line below is the first write.
  ensurePrivateAppRoot();
  loadPrefs();
  shellLog(`[shell] start v${APP_VERSION} instance=${INSTANCE} relayMode=${RELAY_MODE}`);
  // Before either child exists: a move relaunches the app from Applications.
  if (await offerMoveToApplications()) return;
  // Logging only. A post-sleep "won't connect" is unreadable without knowing
  // exactly when the machine slept and woke.
  for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen'] as const) {
    powerMonitor.on(event as 'suspend', () => {
      lastPower[event] = Date.now();
      shellLog(`[power] ${event}`);
      if (event === 'resume' || event === 'unlock-screen') nudgeWindowAwake(event);
    });
  }
  // "Leave it running" only holds if it comes back after a reboot, so the login
  // item is defaulted on — once. After that the checkbox is the user's, and a
  // deliberate off stays off.
  if (!loginItemDefaulted) {
    loginItemDefaulted = true;
    app.setLoginItemSettings({ openAtLogin: true });
    savePrefs();
  }
  // Hosted mode starts as a background app: no dock tile, no app switcher entry.
  // `syncDock` puts one up for as long as a window is open. Local mode has a real
  // window throughout, so it gets a tile with our own art — `show()` because the
  // packaged Info.plist carries LSUIElement, which would otherwise suppress it
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
  // The caveat belongs where the promise is made: a power-save blocker stops an
  // idle sleep, and does not survive the lid closing on battery.
  tray.setToolTip('Lines — stays awake while a turn runs (except with the lid closed on battery)');
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
  releasePowerBlocker();
  bridge?.kill('SIGTERM');
  worker?.kill('SIGTERM');
});
