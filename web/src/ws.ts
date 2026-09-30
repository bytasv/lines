import type {
  ClientMessage,
  FileRequestKind,
  FileRequestParams,
  HandshakeAccept,
  HandshakeConfirm,
  SecureSession,
  ServerMessage,
} from '@lines/shared';
import { APP_PROTOCOL_VERSION, enrollProof, startHandshake } from '@lines/shared';
import { useStore } from './store';
import { refreshDevices } from './lib/devices';
import { cryptoUnavailable, deviceIdentity, pinKey, pinnedKey } from './lib/e2ee';
import { WAKE_PROBE_TIMEOUT_MS, probeExpired, shouldReviveIdle, wakeAction, wakeDebounced } from './lib/wake';
import {
  diag,
  diagEntries,
  flushDiag,
  hasUnsentStall,
  lastDiagSentAt,
  markDiagSent,
  redactUrl,
  withTimeout,
} from './lib/diag';
import { DEVICE_PAIRING_ENABLED, sendDiagnostics } from './lib/storage';

/**
 * One link per machine.
 *
 * This module used to hold a single module-level socket, because the client
 * talked to exactly one machine and `switchDevice` tore everything down to move.
 * Sharing breaks that: your own sessions and a colleague's shared one have to be
 * on screen together, which means holding both machines at once.
 *
 * Every piece of per-socket state that used to be a module global — the socket,
 * its generation, the retry/heartbeat/auth timers, the in-flight fileRequests —
 * now lives on a {@link MachineLink}, and every frame is tagged with the link it
 * arrived on. `socketGeneration` survives *per link*: cross-machine
 * misattribution is now structural rather than guarded, but a reconnect within
 * one link still delivers frames from the socket it replaced.
 */

/**
 * Where the bridge lives. Hosted builds set VITE_BRIDGE_WS_URL and never probe;
 * in dev the bridge binds an ephemeral port, so the URL is resolved from the dev
 * server's /__bridge endpoint (see web/vite.config.ts) on every connect attempt —
 * a restarted bridge comes back on a different port.
 */
const ENV_WS_URL = import.meta.env.VITE_BRIDGE_WS_URL as string | undefined;

/**
 * Frames the relay itself sends, about the machine rather than from it. Mirrors
 * `RelayToClient` in relay/src/protocol.ts; not imported, because a browser bundle
 * must not depend on the relay package. No ServerMessage uses either `type`.
 */
type RelayControlMessage = { type: 'deviceOffline' } | { type: 'deviceOnline' };

let WS_URL = ENV_WS_URL ?? '';

/**
 * Resolve where the bridge is listening. A failure leaves WS_URL empty, which
 * surfaces as an ordinary failed connection and retry rather than a boot error.
 */
async function resolveBridgeUrl(): Promise<void> {
  if (ENV_WS_URL) return;
  try {
    const res = await fetch('/__bridge', { cache: 'no-store' });
    const { port } = (await res.json()) as { port: number | null };
    if (!port) return;
    WS_URL = `ws://${location.hostname}:${port}`;
  } catch {
    console.warn('[ws] bridge discovery failed — is the bridge running?');
  }
}

const PING_INTERVAL_MS = 1000;
// Declare the link dead after this long without a pong (~10 missed pings). Generous
// on purpose: pings are sent and pongs are handled on the main thread, so a long
// render blocks both and a tight timeout kills a perfectly healthy socket.
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 1500;
// Slower than an ordinary reconnect: a 1008 is usually a state that needs
// something to change elsewhere (sign in again, start the machine), not a blip.
const UNAUTHORIZED_RETRY_DELAY_MS = 5000;
// A fresh Clerk mint that has not answered by now is treated as hung. Clerk's
// getToken has no deadline of its own, and a connect awaiting it forever creates
// no socket and schedules no retry — the stuck "connecting" screen.
const TOKEN_TIMEOUT_MS = 10_000;
const CACHED_TOKEN_TIMEOUT_MS = 5_000;
// Re-send a fresh Clerk token before its ~60s expiry.
const AUTH_RELAY_INTERVAL_MS = 50_000;
/**
 * How many machines this client will hold links to at once, and how long a
 * non-primary one may sit unused.
 *
 * Each link heartbeats independently (1s ping), so N links is N pings a second.
 * Fine for the two to four machines this realistically serves, which is exactly
 * why the cap and the idle disconnect exist rather than connecting to everything
 * shared with you.
 */
const LINK_CAP = 4;
const IDLE_DISCONNECT_MS = 5 * 60_000;

/** Everything one machine's socket needs. Nothing here is shared between links. */
interface MachineLink {
  /** '' for a direct bridge, which serves exactly one machine — its own. */
  deviceId: string;
  socket: WebSocket | null;
  /** Monotonic per socket, so a replaced socket's in-flight frames are dropped. */
  generation: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  authRelayTimer: ReturnType<typeof setInterval> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
  /**
   * When a wake probe's ping went out, or null if none is in flight.
   *
   * Kept apart from `lastPongAt` because the heartbeat re-baselines that one on
   * a stalled tick — which a resumed tab's first tick always is. See lib/wake.ts.
   */
  awaitingProbeSince: number | null;
  /** In-flight fileRequests for *this* machine, keyed by reqId. */
  pending: Map<string, { resolve: (r: { status: number; body?: unknown }) => void; reject: (e: Error) => void }>;
  /** In-flight voice transcriptions for this machine, keyed by requestId. */
  transcriptions: Map<string, { resolve: (text: string) => void; reject: (e: Error) => void }>;
  reqCounter: number;
  /** Set while an intentional close is in flight, so it does not schedule a retry. */
  closing: boolean;
  /**
   * The established encrypted session with this machine, once the handshake has
   * completed. Null on a direct bridge socket, and on a machine this browser has
   * not enrolled with — both of which fall back to plaintext over TLS.
   */
  secure: SecureSession | null;
  /**
   * This link owes the bridge a handshake and has not finished one yet.
   *
   * Set synchronously when the socket opens, because `beginHandshake` is async —
   * it awaits the IndexedDB identity before it can set `finishHandshake`, and a
   * frame written inside that window would otherwise find neither a session nor
   * a handshake in flight and go out in the clear.
   */
  expectsSecure: boolean;
  /** Second half of the handshake, held between our offer and the bridge's accept. */
  finishHandshake:
    | ((accept: HandshakeAccept) => Promise<{ session: SecureSession; confirm: HandshakeConfirm }>)
    | null;
  /**
   * Messages written while the handshake was still in flight. Sending them in
   * the clear would be the downgrade the handshake exists to prevent, and
   * dropping them would lose a prompt, so they wait.
   */
  outbox: string[];
  /**
   * Orders outbound frames. `seal` takes its counter synchronously and encrypts
   * asynchronously; the bridge refuses a counter it has already passed, so two
   * sends resolving out of order would look like a replay rather than a race.
   */
  sending: Promise<void>;
  /** Resolver for an enrollment in flight on this link, if any. */
  enrollWaiter:
    | ((msg: { type: 'e2eeEnrolled'; bridgeKey: string; proof: string } | { type: 'e2eeError'; reason: string }) => void)
    | null;
  /** When the connect in flight started (awaiting a token or the bridge URL), or null. */
  connectingSince: number | null;
  /** Connect attempts since this link last received a `hello`. */
  attempts: number;
  /** When the current socket was created, for open/close/hello timings. */
  dialedAt: number;
  openedAt: number | null;
  lastClose: { code: number; reason: string; at: number } | null;
}

const links = new Map<string, MachineLink>();
let connectivityWired = false;

/**
 * Machines that have refused this browser for want of an enrolled key.
 *
 * Remembered because the recovery needs a *quiet* socket: the bridge refuses the
 * first plaintext app frame it sees, and the heartbeat is a plaintext app frame
 * one second in. So for a machine known to require a key, the link opens and
 * says nothing at all, leaving the channel alive long enough for the user to
 * type the code from that machine's screen.
 */
const needsEnrollment = new Set<string>();

/**
 * The machine the UI is "on": the one whose account-wide state (settings,
 * projects, workflows) the app shows, and the default target for anything not
 * tied to a session. Null before a device is chosen, and '' when talking
 * straight to a local bridge.
 */
let primaryDeviceId: string | null = null;

/** Set by main.tsx once Clerk is active; null means local no-auth mode. */
let tokenProvider: (() => Promise<string | null>) | null = null;

export function setTokenProvider(fn: () => Promise<string | null>) {
  tokenProvider = fn;
}

/**
 * Clerk's memoised token, used only when a fresh mint hangs. Possibly the stale
 * one the bridge refused (why the primary provider skips the cache), but the
 * relay only needs it to admit the socket; the auth relay mints fresh after.
 */
let cachedTokenProvider: (() => Promise<string | null>) | null = null;

export function setCachedTokenProvider(fn: () => Promise<string | null>) {
  cachedTokenProvider = fn;
}

/**
 * The token for one connect, never hanging: a fresh mint, then the cached one.
 * `undefined` when both failed, so the caller schedules a retry rather than
 * dialling with nothing. Each fallback is logged.
 */
async function connectToken(link: MachineLink): Promise<string | null | undefined> {
  if (!tokenProvider) return null;
  const fresh = await withTimeout(tokenProvider(), TOKEN_TIMEOUT_MS);
  if (fresh.ok) {
    if (fresh.ms > 2000) diag('token-slow', { device: link.deviceId, ms: fresh.ms });
    return fresh.value;
  }
  diag(fresh.reason === 'timeout' ? 'token-timeout' : 'token-error', {
    device: link.deviceId,
    ms: fresh.ms,
    error: fresh.error instanceof Error ? fresh.error.message : null,
  });
  if (!cachedTokenProvider) return undefined;
  const cached = await withTimeout(cachedTokenProvider(), CACHED_TOKEN_TIMEOUT_MS);
  diag('token-cached', { device: link.deviceId, ok: cached.ok, ms: cached.ms });
  return cached.ok ? cached.value : undefined;
}

/** What the connecting screen shows about a link, and what a report carries. */
export interface LinkDiagnostics {
  phase: 'connecting' | 'socket-connecting' | 'open' | 'closed' | 'none';
  since: number | null;
  attempts: number;
  lastClose: { code: number; reason: string; at: number } | null;
}

export function linkDiagnostics(deviceId: string): LinkDiagnostics {
  const link = links.get(deviceId);
  if (!link) return { phase: 'none', since: null, attempts: 0, lastClose: null };
  const rs = link.socket?.readyState;
  const phase =
    link.connectingSince !== null
      ? 'connecting'
      : rs === WebSocket.CONNECTING
        ? 'socket-connecting'
        : rs === WebSocket.OPEN
          ? 'open'
          : link.socket
            ? 'closed'
            : 'none';
  const since =
    phase === 'connecting'
      ? link.connectingSince
      : phase === 'socket-connecting'
        ? link.dialedAt
        : phase === 'open'
          ? link.openedAt
          : (link.lastClose?.at ?? null);
  return { phase, since, attempts: link.attempts, lastClose: link.lastClose };
}

function linkFor(deviceId: string): MachineLink {
  let link = links.get(deviceId);
  if (!link) {
    link = {
      deviceId,
      socket: null,
      generation: 0,
      retryTimer: null,
      heartbeatTimer: null,
      authRelayTimer: null,
      idleTimer: null,
      lastPongAt: 0,
      awaitingProbeSince: null,
      pending: new Map(),
      transcriptions: new Map(),
      reqCounter: 0,
      closing: false,
      secure: null,
      expectsSecure: false,
      finishHandshake: null,
      outbox: [],
      sending: Promise.resolve(),
      enrollWaiter: null,
      connectingSince: null,
      attempts: 0,
      dialedAt: 0,
      openedAt: null,
      lastClose: null,
    };
    links.set(deviceId, link);
  }
  return link;
}

/**
 * Which paired machine to reach, in a relayed deployment. The relay refuses a
 * connection without it (`1008 device required`) because one user may have
 * several machines and it has no basis to guess.
 */
export function setDeviceId(id: string | null) {
  primaryDeviceId = id;
  if (id !== null) useStore.getState().setPrimaryMachine(id);
}

/**
 * Point the UI at a different machine.
 *
 * No teardown and no `clearBootstrap()` any more: the previous machine's link
 * stays open and its sessions stay in the store, which is the whole point of
 * holding several. Frames are tagged with their link, so nothing can be
 * misattributed while both are live.
 */
export function switchDevice(id: string) {
  const previous = primaryDeviceId;
  primaryDeviceId = id;
  // Re-derives the banner scalars from the machine now in front of the user,
  // instead of leaving them describing the one they just left.
  useStore.getState().setPrimaryMachine(id);
  if (previous !== null && previous !== id) {
    // It is no longer the machine in front of you, so start its idle clock.
    armIdleDisconnect(linkFor(previous));
  }
  const link = linkFor(id);
  cancelIdleDisconnect(link);
  if (link.socket && link.socket.readyState !== WebSocket.CLOSED) return;
  void connectMachine(id);
}

/** Open a link to a machine without making it the one the UI is on. */
export async function connectMachine(deviceId: string): Promise<void> {
  const link = linkFor(deviceId);
  cancelIdleDisconnect(link);
  if (link.socket && link.socket.readyState !== WebSocket.CLOSED) return;
  // The cap is a real limit, not a suggestion — and a silently dropped machine
  // reads as "connected to everything" when it is not, so say so.
  const open = [...links.values()].filter((l) => l.socket && l.socket.readyState !== WebSocket.CLOSED);
  if (open.length >= LINK_CAP && deviceId !== primaryDeviceId) {
    console.warn(`[ws] link cap (${LINK_CAP}) reached — not connecting ${deviceId}`);
    return;
  }
  await openSocket(link);
}

/** Close a link deliberately. Its sessions stay in the store, flagged not-linked. */
export function disconnectMachine(deviceId: string): void {
  const link = links.get(deviceId);
  if (!link) return;
  cancelIdleDisconnect(link);
  clearTimers(link);
  link.closing = true;
  link.socket?.close();
  link.socket = null;
  rejectPending(link);
  useStore.getState().setConnectionStatus('reconnecting', deviceId);
}

function armIdleDisconnect(link: MachineLink) {
  cancelIdleDisconnect(link);
  link.idleTimer = setTimeout(() => {
    if (link.deviceId === primaryDeviceId) return;
    console.log(`[ws] ${link.deviceId} idle for ${IDLE_DISCONNECT_MS}ms — disconnecting`);
    disconnectMachine(link.deviceId);
  }, IDLE_DISCONNECT_MS);
}

function cancelIdleDisconnect(link: MachineLink) {
  if (link.idleTimer) clearTimeout(link.idleTimer);
  link.idleTimer = null;
}

/**
 * Re-dial the machine in front of the user now, instead of waiting out its retry.
 *
 * `switchDevice` cannot serve this: it does nothing when the id has not changed,
 * which is exactly the case here. Non-destructive — nothing is revoked and
 * nothing is forgotten; the socket is simply replaced.
 */
export function reconnectNow() {
  if (primaryDeviceId === null) return;
  reconnectMachine(primaryDeviceId);
}

/**
 * Re-dial one named machine, whoever the UI is currently pointed at.
 *
 * Enrollment needs this rather than {@link reconnectNow}: it happens on the
 * connect-time gate, where the link being enrolled is named explicitly and
 * `primaryDeviceId` may be a different machine entirely (or unset, before any
 * `hello` has landed). Re-dialling the primary there leaves the enrolled link
 * sitting on its old, keyless socket — which the machine refuses, forever.
 */
export function reconnectMachine(deviceId: string) {
  const link = linkFor(deviceId);
  if (link.retryTimer) clearTimeout(link.retryTimer);
  link.retryTimer = null;
  if (link.socket && link.socket.readyState !== WebSocket.CLOSED) link.socket.close();
  else void openSocket(link);
}

/**
 * Read a workspace file/tree/docs bundle, search files, or fetch an attachment,
 * over the already-authenticated socket.
 *
 * Takes the machine, because a shared session's file tree, mentions and docs live
 * on the *host's* disk — asking the wrong bridge would either 403 or, worse,
 * answer with a same-named file from the wrong computer.
 */
export function fileRequest(
  kind: FileRequestKind,
  params: FileRequestParams,
  deviceId?: string,
): Promise<{ status: number; body?: unknown }> {
  // Defaults to the machine hosting the *selected* session, not the primary.
  // Every session-scoped reader here — the file tree, @mention search, docs, a
  // clicked path — is driven by that session's cwd, so with a shared session
  // open the paths only exist on the host's disk. Falling back to the primary
  // would 403 at best and, on a same-named path, answer from the wrong computer.
  const link = links.get(deviceId ?? machineForSelectedSession() ?? primaryDeviceId ?? '');
  if (link?.socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Not connected to the bridge.'));
  }
  const reqId = `f${++link.reqCounter}`;
  return new Promise((resolve, reject) => {
    link.pending.set(reqId, { resolve, reject });
    writeToLink(link, JSON.stringify({ type: 'fileRequest', reqId, kind, params } satisfies ClientMessage));
  });
}

/** The machine hosting whatever session is on screen, if it is known. */
function machineForSelectedSession(): string | undefined {
  const { selectedSessionId, sessionMachine } = useStore.getState();
  return selectedSessionId ? sessionMachine[selectedSessionId] : undefined;
}

function rejectPending(link: MachineLink) {
  for (const [, p] of link.pending) p.reject(new Error('Connection lost.'));
  link.pending.clear();
  for (const [, p] of link.transcriptions) p.reject(new Error('Connection lost.'));
  link.transcriptions.clear();
}

/** Longer than the bridge's own whisper timeout plus a full queue ahead of it,
 *  so the bridge's answer — which says *why* — normally arrives first. */
const TRANSCRIBE_DEADLINE_MS = 180_000;

/**
 * Send dictated audio (raw base64 WAV) to a machine's whisper.cpp and resolve
 * with the text.
 *
 * Takes the machine for the reason `fileRequest` does: the session's host is
 * the one that transcribes, and its install is the one the mic button reflects.
 * Rides the link like any other message, so it is end-to-end encrypted wherever
 * prompts are.
 */
export function transcribeAudio(
  audio: string,
  options: { language?: string; translate?: boolean } = {},
  deviceId?: string,
): Promise<string> {
  const link = links.get(deviceId ?? machineForSelectedSession() ?? primaryDeviceId ?? '');
  if (link?.socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Not connected to the bridge.'));
  }
  const requestId = `t${++link.reqCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      link.transcriptions.delete(requestId);
      reject(new Error('Transcription timed out.'));
    }, TRANSCRIBE_DEADLINE_MS);
    link.transcriptions.set(requestId, {
      resolve: (text) => {
        clearTimeout(timer);
        resolve(text);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    writeToLink(link, JSON.stringify({ type: 'transcribe', requestId, audio, ...options } satisfies ClientMessage));
  });
}

function clearTimers(link: MachineLink) {
  if (link.heartbeatTimer) clearInterval(link.heartbeatTimer);
  if (link.authRelayTimer) clearInterval(link.authRelayTimer);
  if (link.retryTimer) clearTimeout(link.retryTimer);
  link.heartbeatTimer = null;
  link.authRelayTimer = null;
  link.retryTimer = null;
}

/**
 * One fresh Clerk token per link per interval. N links means N mints, which is
 * acceptable, but the relay has to be told per socket — each carries its own.
 */
function startAuthRelay(link: MachineLink) {
  if (link.authRelayTimer) clearInterval(link.authRelayTimer);
  link.authRelayTimer = null;
  if (!tokenProvider) return;
  link.authRelayTimer = setInterval(() => void relayAuth(link), AUTH_RELAY_INTERVAL_MS);
}

/**
 * Mint and relay one fresh token now. The bridge's storage client only ever
 * sees a token a browser relayed, so this is also how a stale-token storage
 * outage heals: a relay while storage is down makes the bridge probe at once.
 */
async function relayAuth(link: MachineLink) {
  if (link.socket?.readyState !== WebSocket.OPEN) return;
  const token = await tokenProvider?.().catch(() => null);
  if (token) writeToLink(link, JSON.stringify({ type: 'auth', token } satisfies ClientMessage));
}

/** The storage banner's Retry: a fresh token to the primary bridge is the retry. */
export function retryStorage() {
  const link = links.get(primaryDeviceId ?? '');
  if (link) void relayAuth(link);
}

function startHeartbeat(link: MachineLink) {
  if (link.heartbeatTimer) clearInterval(link.heartbeatTimer);
  link.lastPongAt = Date.now();
  // A fresh heartbeat supersedes any probe still counting down against the
  // socket it replaced.
  link.awaitingProbeSince = null;
  let expectedTick = Date.now() + PING_INTERVAL_MS;
  link.heartbeatTimer = setInterval(() => {
    const now = Date.now();
    // How late this tick itself ran = how long the main thread was blocked. Pongs
    // arriving during that block were never processed, so the silence says nothing
    // about the link — skip the liveness check and re-baseline instead of closing.
    const stalledMs = now - expectedTick;
    expectedTick = now + PING_INTERVAL_MS;
    if (link.socket?.readyState !== WebSocket.OPEN) return;
    writeToLink(link, JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    if (stalledMs > PING_INTERVAL_MS) {
      link.lastPongAt = now;
      return;
    }
    // No pong for a while means the socket is dead even if the OS never told us.
    if (now - link.lastPongAt > PONG_TIMEOUT_MS) link.socket.close();
  }, PING_INTERVAL_MS);
}

/** Re-send prompts queued while offline, dropping any whose session vanished. Runs after `hello`. */
function flushQueue() {
  const queued = useStore.getState().drainQueuedPrompts();
  for (const p of queued) {
    if (useStore.getState().sessions[p.sessionId]) {
      send({ type: 'prompt', sessionId: p.sessionId, text: p.text, attachments: p.attachments, mentions: p.mentions });
    } else {
      console.warn('dropped queued prompt, session gone', p.sessionId);
    }
  }
}

/**
 * Write one already-serialised message to a machine.
 *
 * Three states, and the middle one is the security-relevant one: with a session
 * established everything is sealed; while a handshake is in flight nothing goes
 * out at all (sending in the clear would be exactly the downgrade the handshake
 * prevents); with no enrollment at all it is plaintext over TLS, which is where
 * every install starts and what enrolling a device upgrades.
 *
 * Every client frame but the handshake's own goes through here. That includes
 * the ones written by a timer rather than by the user — the heartbeat ping and
 * the auth relay — which is not a detail: they used to call `socket.send`
 * directly, so the first ping after a successful handshake arrived at the bridge
 * as plaintext, the bridge read it as a downgrade and closed the channel, and the
 * link reconnected into the same loop a second later.
 */
function writeToLink(link: MachineLink, payload: string): boolean {
  if (link.socket?.readyState !== WebSocket.OPEN) return false;
  if (link.secure) {
    const session = link.secure;
    const socket = link.socket;
    link.sending = link.sending
      .then(async () => {
        const sealed = await session.seal(payload);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'e2eeData', ...sealed } satisfies ClientMessage));
        }
      })
      .catch((err) => console.warn('[e2ee] send failed', err));
    return true;
  }
  if (link.expectsSecure) {
    link.outbox.push(payload);
    return true;
  }
  link.socket.send(payload);
  return true;
}

/** Everything held back during the handshake, in the order it was written. */
function flushOutbox(link: MachineLink) {
  const held = link.outbox;
  link.outbox = [];
  for (const payload of held) writeToLink(link, payload);
}

/**
 * Open an encrypted channel to a machine this browser has enrolled with.
 *
 * The pinned key is passed *in* rather than read off the wire: believing the
 * key the connection offers would authenticate the connection against itself,
 * which is no authentication at all. If the peer cannot produce a matching key
 * confirmation the handshake throws, and the link is closed rather than
 * downgraded.
 */
async function beginHandshake(link: MachineLink, bridgeKey: string): Promise<void> {
  const identity = await deviceIdentity();
  const { offer, finish } = await startHandshake(identity, bridgeKey);
  link.finishHandshake = finish as MachineLink['finishHandshake'];
  link.socket?.send(JSON.stringify({ type: 'e2eeHello', offer } satisfies ClientMessage));
}

/**
 * Bind this browser to a machine, using a code read off the host's own screen.
 *
 * The code never travels — only MACs computed under it do — and the bridge's
 * answer is itself MAC'd over both public keys, so the key this pins cannot be
 * substituted by anything in the middle. That is the whole reason enrollment is
 * out-of-band: it is the one moment the two ends can agree on a key without a
 * server they would otherwise have to trust.
 */
export async function enrollWithCode(deviceId: string, code: string): Promise<{ error?: string }> {
  // Checked before anything else, and answered rather than thrown: on an
  // insecure origin every call below rejects, and an unhandled rejection at the
  // call site is a button that spins for ever with no explanation.
  const blocked = cryptoUnavailable();
  if (blocked) return { error: blocked };
  try {
    return await runEnrollment(deviceId, code);
  } catch (err) {
    // Nothing in here is worth crashing a screen over: IndexedDB can be blocked
    // in a private window, and the socket can die mid-exchange.
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function runEnrollment(deviceId: string, code: string): Promise<{ error?: string }> {
  const link = linkFor(deviceId);
  // A refused link is closed and on a 5s retry, so the socket is usually down at
  // the moment the user presses Enrol. Nudge it and wait, rather than answering
  // "not connected" to somebody looking straight at the machine they mean.
  if (link.socket?.readyState !== WebSocket.OPEN) {
    if (link.retryTimer) clearTimeout(link.retryTimer);
    link.retryTimer = null;
    void openSocket(link);
    const deadline = Date.now() + 10_000;
    while (link.socket?.readyState !== WebSocket.OPEN && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (link.socket?.readyState !== WebSocket.OPEN) return { error: 'Not connected to that machine.' };
  const identity = await deviceIdentity();
  const proof = await enrollProof(code, 'enroll', identity.publicKey);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      link.enrollWaiter = null;
      resolve({ error: 'That machine did not answer. Try again.' });
    }, 15_000);
    link.enrollWaiter = async (msg) => {
      clearTimeout(timer);
      link.enrollWaiter = null;
      if (msg.type === 'e2eeError') return resolve({ error: msg.reason });
      const expected = await enrollProof(code, 'enrolled', identity.publicKey, msg.bridgeKey);
      if (expected !== msg.proof) {
        // Either the code was wrong on the far side or something rewrote the key
        // in flight. Pinning anyway would pin the attacker's key, permanently.
        return resolve({ error: 'That machine answered with a key the code does not vouch for.' });
      }
      pinKey(deviceId, msg.bridgeKey);
      needsEnrollment.delete(deviceId);
      useStore.getState().setE2eeRefusal(null);
      resolve({});
      // This link, by name — not the primary. See reconnectMachine.
      reconnectMachine(deviceId);
    };
    link.socket!.send(JSON.stringify({ type: 'e2eeEnroll', clientKey: identity.publicKey, proof } satisfies ClientMessage));
  });
}

/**
 * Build the connect URL, preserving whatever path WS_URL carries.
 *
 * Parsed rather than concatenated: the relay matches its endpoint path exactly
 * (`/client`), so appending "/?token=" — as this once did — turns a valid URL
 * into `/client/` and the socket closes with 1008. A bridge ignores the path
 * entirely, so both cases come out right.
 */
function socketUrl(token: string | null, deviceId: string): string {
  const url = new URL(WS_URL);
  if (token) url.searchParams.set('token', token);
  if (deviceId) url.searchParams.set('device', deviceId);
  return url.toString();
}

/** Connect the machine the UI is on. Kept as the entry point main.tsx already calls. */
export async function connect() {
  await connectMachine(primaryDeviceId ?? '');
}

async function openSocket(link: MachineLink) {
  if (link.socket && link.socket.readyState !== WebSocket.CLOSED) return;
  // One connect in flight per link: wake, online and retry can all ask at once.
  if (link.connectingSince !== null) return;
  // This attempt supersedes any scheduled one. Also forgets a timer that already
  // fired, which would otherwise read as "retry pending" to handleWake forever.
  if (link.retryTimer) clearTimeout(link.retryTimer);
  link.retryTimer = null;
  wireConnectivity();
  link.connectingSince = Date.now();
  const attempt = ++link.attempts;
  let token: string | null | undefined;
  try {
    // Re-resolve on every attempt, not just the first: a restarted bridge comes
    // back on a different ephemeral port, and this is what finds it.
    await resolveBridgeUrl();
    if (!WS_URL) {
      diag('no-bridge-url', { device: link.deviceId, attempt });
      useStore.getState().setConnectionStatus('reconnecting', link.deviceId);
      if (link.retryTimer) clearTimeout(link.retryTimer);
      link.retryTimer = setTimeout(() => void openSocket(link), RECONNECT_DELAY_MS);
      return;
    }
    // Mint a fresh token for every (re)connect — a stale one fails the handshake.
    token = await connectToken(link);
  } finally {
    link.connectingSince = null;
  }
  if (link.socket && link.socket.readyState !== WebSocket.CLOSED) return; // raced a parallel connect
  if (token === undefined) {
    // No token from either source. Returning here with nothing scheduled is
    // exactly the stuck spinner, so the ordinary retry takes over.
    diag('token-unavailable', { device: link.deviceId, attempt });
    useStore.getState().setConnectionStatus('reconnecting', link.deviceId);
    if (link.retryTimer) clearTimeout(link.retryTimer);
    link.retryTimer = setTimeout(() => void openSocket(link), RECONNECT_DELAY_MS);
    return;
  }
  link.closing = false;
  const url = socketUrl(token, link.deviceId);
  const socket = new WebSocket(url);
  link.socket = socket;
  link.dialedAt = Date.now();
  link.openedAt = null;
  const generation = ++link.generation;
  diag('dial', { device: link.deviceId, attempt, url: redactUrl(url), token: !!token });

  socket.onopen = () => {
    link.openedAt = Date.now();
    diag('open', { device: link.deviceId, attempt, ms: link.openedAt - link.dialedAt });
    useStore.getState().setConnectionStatus('connected', link.deviceId);
    link.awaitingProbeSince = null;
    link.secure = null;
    link.finishHandshake = null;
    // Whatever the previous socket could not deliver describes a state this one
    // has already left, so it is dropped rather than replayed.
    link.outbox = [];
    link.sending = Promise.resolve();
    const bridgeKey = pinnedKey(link.deviceId);
    link.expectsSecure = !!bridgeKey;
    if (!bridgeKey && needsEnrollment.has(link.deviceId)) {
      // Deliberately silent: no heartbeat, no auth relay, no app traffic. This
      // machine refuses the first plaintext frame it sees, and the heartbeat is
      // one a second in — so the socket is held open saying nothing, which is
      // what leaves a window for the enrollment frame the gate screen sends.
      console.warn(
        `[e2ee] ${link.deviceId || 'bridge'} requires an enrolled browser — holding the socket for enrollment`,
      );
      return;
    }
    if (bridgeKey) {
      // Heartbeat and auth relay start only once the channel is authenticated:
      // both write, and a write before the handshake would be refused by the
      // bridge, which never accepts a plaintext owner channel over the relay.
      void beginHandshake(link, bridgeKey).catch((err) => {
        console.warn('[e2ee] handshake could not start', err);
        socket.close();
      });
      return;
    }
    startHeartbeat(link);
    startAuthRelay(link);
  };

  socket.onmessage = (e) => {
    // A superseded socket's frames describe a state we have already left.
    if (generation !== link.generation) return;
    try {
      const msg = JSON.parse(e.data as string) as ServerMessage | RelayControlMessage;
      // The encrypted channel's own frames, handled before anything reads them
      // as app state: they are what establishes whether this connection may
      // carry app state at all.
      if (
        msg.type === 'e2eeAccept' ||
        msg.type === 'e2eeReady' ||
        msg.type === 'e2eeEnrolled' ||
        msg.type === 'e2eeError' ||
        msg.type === 'e2eeData'
      ) {
        void handleE2eeFrame(link, generation, msg);
        return;
      }
      handleServerMessage(link, msg);
    } catch (err) {
      console.error('bad server message', err);
    }
  };

  socket.onclose = (e) => {
    clearTimers(link);
    rejectPending(link);
    const now = Date.now();
    link.lastClose = { code: e.code, reason: e.reason, at: now };
    diag('close', {
      device: link.deviceId,
      attempt,
      code: e.code,
      reason: e.reason || null,
      openMs: link.openedAt ? now - link.openedAt : null,
      sinceDialMs: now - link.dialedAt,
      deliberate: link.closing,
    });
    // A deliberate disconnect must not immediately dial back.
    if (link.closing) {
      link.closing = false;
      return;
    }
    // 1008 = rejected. Against a bridge that means the token; through a relay it
    // also means "that machine has not attached yet", or that a share was revoked
    // — all of which recover on their own if they are going to, so this retries
    // rather than parking, but slowly, so a genuinely bad token does not hammer
    // the gate.
    if (e.code === 1008) {
      console.warn(
        `[ws] ${link.deviceId || 'bridge'} rejected (1008) — retrying slowly; check sign-in, ` +
          'that the machine is running, and that the share is still granted',
      );
      useStore.getState().setConnectionStatus('reconnecting', link.deviceId);
      // A revoked machine is indistinguishable from a sleeping one at this layer,
      // so re-read the list: if it is gone, the gate shows the pairing screen
      // instead of retrying a machine that will now be refused forever.
      if (link.deviceId) refreshDevices();
      link.retryTimer = setTimeout(() => void openSocket(link), UNAUTHORIZED_RETRY_DELAY_MS);
      return;
    }
    useStore
      .getState()
      .setConnectionStatus(navigator.onLine ? 'reconnecting' : 'offline', link.deviceId);
    link.retryTimer = setTimeout(() => void openSocket(link), RECONNECT_DELAY_MS);
  };

  socket.onerror = () => socket.close();
}

/**
 * Apply one decrypted (or plaintext) server message to this link.
 *
 * Split out of `socket.onmessage` when encryption landed: a message now arrives
 * either straight off the socket or out of an `e2eeData` envelope, and both have
 * to run exactly the same path — a second copy is how the two would drift.
 */
function handleServerMessage(link: MachineLink, msg: ServerMessage | RelayControlMessage) {
  // Relay control frames, not app messages: the socket is healthy, the machine
  // behind it is not. Handled here with the other non-app frames because the
  // reducer has no case for them and would drop them silently.
  if (msg.type === 'deviceOffline' || msg.type === 'deviceOnline') {
    diag(msg.type, { device: link.deviceId });
    useStore.getState().setMachineOffline(msg.type === 'deviceOffline', link.deviceId);
    return;
  }
  if (msg.type === 'pong') {
    link.lastPongAt = Date.now();
    return;
  }
  if (msg.type === 'fileResponse') {
    // Point-to-point reply, not app state — settled here, never in the store,
    // and only against this link's own in-flight requests.
    const pending = link.pending.get(msg.reqId);
    link.pending.delete(msg.reqId);
    pending?.resolve({ status: msg.status, body: msg.body });
    return;
  }
  if (msg.type === 'transcription') {
    // Point-to-point, like fileResponse: settled against this link only.
    const pending = link.transcriptions.get(msg.requestId);
    link.transcriptions.delete(msg.requestId);
    if ('error' in msg) pending?.reject(new Error(msg.error));
    else pending?.resolve(msg.text);
    return;
  }
  // Which project (if any) this pick adds a root to — read before the reducer
  // clears it below.
  const folderPickTarget =
    msg.type === 'folderPicked' ? useStore.getState().folderPickTarget : null;
  // Tagged with the link: this is what lets the reducer keep two machines'
  // sessions apart instead of letting the newest `hello` win.
  useStore.getState().applyServerMessage(msg, link.deviceId);
  // Flush only after the hello reducer ran: sessions are fresh and transcripts reset.
  if (msg.type === 'hello') {
    diag('hello', {
      device: link.deviceId,
      attempts: link.attempts,
      sinceDialMs: Date.now() - link.dialedAt,
      bridge: msg.bridge?.version ?? null,
    });
    link.attempts = 0;
    uploadStallIfAny(link.deviceId);
    if (useStore.getState().protocolSkew) {
      console.warn(
        `[ws] protocol skew: bridge speaks v${msg.bridge?.appProtocol ?? '<pre-versioning>'}, ` +
          `this client speaks v${APP_PROTOCOL_VERSION}. Unknown messages are ignored.`,
      );
    }
    flushQueue();
  }
  // Pop the Claude approval page; the login modal keeps a link as the popup-blocked fallback.
  if (msg.type === 'authLoginStarted') {
    window.open(msg.authorizeUrl, '_blank', 'noopener');
  }
  // Same treatment for the OpenAI device-code page. The code itself stays in
  // the modal — this only saves the user navigating there by hand.
  if (msg.type === 'openaiLoginStarted') {
    window.open(msg.verificationUrl, '_blank', 'noopener');
  }
  // The native folder picker either opens a project or widens one, depending on
  // where the pick was started from. Adding a root leaves the active tab alone —
  // the tab the root lands in need not be the one in front.
  if (msg.type === 'folderPicked' && msg.path) {
    if (folderPickTarget) {
      send({ type: 'addProjectRoot', project: folderPickTarget, path: msg.path });
    } else {
      send({ type: 'openProject', path: msg.path });
      useStore.getState().setActiveProject(msg.path);
    }
  }
}

/**
 * A stuck-connecting episode is only worth anything if it reaches whoever is
 * debugging it, and the moment the link is healthy again is the first moment an
 * upload can be trusted to get through. Once per episode.
 */
function uploadStallIfAny(deviceId: string) {
  if (!DEVICE_PAIRING_ENABLED) return;
  const sentAt = lastDiagSentAt();
  if (!hasUnsentStall(diagEntries(), sentAt)) return;
  const at = Date.now();
  markDiagSent(at); // before the await: a second hello must not race a duplicate upload
  sendDiagnostics(deviceId).catch((err: unknown) => {
    markDiagSent(sentAt);
    console.warn('[diag] upload failed', err);
  });
}

/**
 * The handshake, enrollment answer, and encrypted traffic.
 *
 * A failure anywhere here closes the socket rather than falling back to
 * plaintext. That is deliberate: every failure mode this can see — a peer that
 * cannot confirm the pinned key, a replayed frame, a refusal — is either an
 * attack or a state a reconnect fixes, and a silent downgrade would turn the
 * first into the second.
 */
async function handleE2eeFrame(
  link: MachineLink,
  generation: number,
  msg: Extract<ServerMessage, { type: `e2ee${string}` }>,
): Promise<void> {
  try {
    if (msg.type === 'e2eeAccept') {
      const finish = link.finishHandshake;
      if (!finish) return;
      const { session, confirm } = await finish(msg.accept);
      if (generation !== link.generation) return; // the socket was replaced mid-handshake
      link.finishHandshake = null;
      link.secure = session;
      link.socket?.send(JSON.stringify({ type: 'e2eeConfirm', confirm } satisfies ClientMessage));
      return;
    }
    if (msg.type === 'e2eeReady') {
      // Belt and braces: the handshake already failed if the peer held a
      // different key, so a mismatch here means something rewrote this frame.
      if (msg.bridgeKey !== pinnedKey(link.deviceId)) {
        console.warn('[e2ee] the machine answered with an unpinned key — closing');
        link.socket?.close();
        return;
      }
      link.expectsSecure = false;
      startHeartbeat(link);
      startAuthRelay(link);
      flushOutbox(link);
      return;
    }
    if (msg.type === 'e2eeEnrolled' || msg.type === 'e2eeError') {
      const waiter = link.enrollWaiter;
      if (waiter) {
        waiter(msg);
        return;
      }
      if (msg.type === 'e2eeError') {
        console.warn(`[e2ee] ${link.deviceId || 'bridge'} refused the channel: ${msg.reason}`);
        // A refusal for want of a key is recoverable *here*, from the connecting
        // gate — every other refusal is not, so only this one arms the quiet
        // reconnect that makes enrollment possible.
        if (/end-to-end encrypted channel/.test(msg.reason)) needsEnrollment.add(link.deviceId);
        useStore.getState().setE2eeRefusal(msg.reason);
      }
      return;
    }
    // e2eeData: an ordinary server message, sealed.
    if (!link.secure) return;
    const plaintext = await link.secure.open({ n: msg.n, d: msg.d });
    if (generation !== link.generation) return;
    handleServerMessage(link, JSON.parse(plaintext) as ServerMessage | RelayControlMessage);
  } catch (err) {
    console.warn('[e2ee] frame rejected', err);
    link.socket?.close();
  }
}


/** When the last wake event was acted on, so the two that fire together count once. */
let lastWakeAt = 0;

/**
 * The tab is back in front of the user. Find out whether its links survived.
 *
 * A closed socket is re-dialled immediately rather than waiting out the
 * heartbeat's pong timeout plus a retry delay — most of the "connecting to your
 * machine" wait after a resume was that, not the connect itself. An open socket
 * is only *probed*: it is usually healthy, and closing it to check would cost
 * every tab switch a reconnect and a fresh `hello`.
 *
 * A link with no socket at all was idle-disconnected on purpose
 * (IDLE_DISCONNECT_MS); reviving it on every tab switch would undo that.
 */
function handleWake() {
  const now = Date.now();
  if (wakeDebounced(lastWakeAt, now)) return;
  lastWakeAt = now;
  diag('wake', { links: links.size });
  for (const link of links.values()) {
    const socket = link.socket;
    if (!socket) {
      const revive = shouldReviveIdle({
        isPrimary: link.deviceId === primaryDeviceId,
        hasSocket: false,
        retryPending: link.retryTimer !== null,
        connecting: link.connectingSince !== null,
      });
      diag('wake-no-socket', {
        device: link.deviceId,
        revive,
        connectingMs: link.connectingSince === null ? null : now - link.connectingSince,
        retryPending: link.retryTimer !== null,
      });
      if (revive) void openSocket(link);
      continue;
    }
    const state = {
      readyState: socket.readyState,
      awaitingProbeSince: link.awaitingProbeSince,
      lastPongAt: link.lastPongAt,
    };
    const action = wakeAction(state, now);
    if (action !== 'probe') diag('wake-link', { device: link.deviceId, action, readyState: socket.readyState });
    if (action === 'none') continue;
    if (action === 'redial') {
      link.awaitingProbeSince = null;
      reconnectMachine(link.deviceId);
      continue;
    }
    const generation = link.generation;
    link.awaitingProbeSince = now;
    // writeToLink, never socket.send: on an enrolled machine a raw frame is the
    // plaintext downgrade the bridge closes the channel over.
    writeToLink(link, JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    // A hidden tab stops relaying, so the bridge's token has likely expired;
    // relaying now heals a stale-token storage outage without waiting a tick.
    void relayAuth(link);
    setTimeout(() => {
      if (link.generation !== generation) return; // the socket was replaced meanwhile
      const settled = {
        readyState: socket.readyState,
        awaitingProbeSince: link.awaitingProbeSince,
        lastPongAt: link.lastPongAt,
      };
      if (!probeExpired(settled, Date.now())) return;
      diag('wake-probe-expired', { device: link.deviceId });
      link.awaitingProbeSince = null;
      reconnectMachine(link.deviceId);
    }, WAKE_PROBE_TIMEOUT_MS);
  }
}

/** Register once: react to the OS network toggling so we don't wait out the heartbeat. */
function wireConnectivity() {
  if (connectivityWired) return;
  connectivityWired = true;
  // Lifecycle listeners live here rather than in a component effect: reconnect
  // policy is this module's, and a component would register one per mount.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      diag('visibility', { hidden: document.hidden });
      if (!document.hidden) handleWake();
      else flushDiag();
    });
  }
  window.addEventListener('pagehide', () => flushDiag());
  // bfcache restore, which on iOS Safari may not come with a visibility change
  // at all. `persisted` is what separates it from an ordinary load.
  window.addEventListener('pageshow', (e) => {
    diag('pageshow', { persisted: (e as PageTransitionEvent).persisted });
    if ((e as PageTransitionEvent).persisted) handleWake();
  });
  window.addEventListener('offline', () => {
    diag('offline');
    for (const link of links.values()) {
      useStore.getState().setConnectionStatus('offline', link.deviceId);
      link.socket?.close();
    }
  });
  window.addEventListener('online', () => {
    diag('online');
    // Every link, not just the primary: a shared machine that was up when the
    // network went is still expected on screen when it comes back.
    for (const link of links.values()) {
      if (link.retryTimer) clearTimeout(link.retryTimer);
      link.retryTimer = null;
      void openSocket(link);
    }
  });
}

/**
 * Which link a message belongs to.
 *
 * A session-scoped message goes to the machine hosting that session — sending a
 * prompt for a shared session to your own bridge would either be refused or, if
 * the id happened to collide, run on the wrong computer. Everything else is about
 * the machine the UI is on.
 *
 * One helper owns the routing so no call site outside this module needs to know
 * about devices at all.
 */
function linkForMessage(msg: ClientMessage): MachineLink | undefined {
  const sessionId = 'sessionId' in msg ? (msg as { sessionId?: string }).sessionId : undefined;
  const deviceId = sessionId
    ? (useStore.getState().sessionMachine[sessionId] ?? primaryDeviceId)
    : primaryDeviceId;
  return links.get(deviceId ?? '');
}

/**
 * Send to one machine's link, bypassing `linkForMessage`'s routing. For messages
 * every owned machine has to receive (push registration), not just the primary.
 * Silent when the link is down: callers resend on that machine's next `hello`.
 */
export function sendToMachine(deviceId: string, msg: ClientMessage): boolean {
  const link = links.get(deviceId);
  return !!link && writeToLink(link, JSON.stringify(msg));
}

/** False when the message was dropped — the caller can then say so instead of
 *  leaving the user with a button that appears to do nothing. */
export function send(msg: ClientMessage): boolean {
  const link = linkForMessage(msg);
  // Through `writeToLink`, never straight at the socket: this is the path every
  // prompt and control message takes, so writing it raw put the app's entire
  // payload past the relay in the clear — and the bridge,
  // correctly, closed the channel over it.
  // One exception to that routing: a prompt written while the handshake is still
  // in flight goes to the durable queue below instead of the link's outbox. The
  // outbox is dropped if that socket dies before the handshake finishes, and a
  // lost prompt is the single failure the queue exists to prevent.
  const buffersOnly = !!link?.expectsSecure && !link.secure;
  if (link && !(msg.type === 'prompt' && buffersOnly) && writeToLink(link, JSON.stringify(msg))) return true;
  if (msg.type === 'prompt') {
    // Only prompts are safe to replay blind; other control messages depend on live state.
    useStore.getState().enqueuePrompt({
      id: crypto.randomUUID(),
      sessionId: msg.sessionId,
      text: msg.text,
      attachments: msg.attachments,
      mentions: msg.mentions,
      queuedAt: Date.now(),
    });
    return true;
  }
  console.warn('ws not connected, dropped', msg.type);
  // Not only a console line: a silently dropped control message is exactly what
  // "delete does nothing" looked like from the outside.
  useStore
    .getState()
    .setActionError(`Not connected to your machine — that action wasn't sent. Try again once it reconnects.`);
  return false;
}
