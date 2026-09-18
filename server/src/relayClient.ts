/**
 * Outbound connection to the relay, so a hosted web app can reach this machine
 * without it accepting any inbound connection.
 *
 * Each browser the relay pairs with us arrives as a channel, which this module
 * turns into a {@link BrowserLink} and hands to the bridge's ordinary
 * `handleConnection`. There is deliberately no second message path: a relayed
 * client is the same client, over a different pipe.
 */
import { WebSocket } from 'ws';
import { APP_PROTOCOL_VERSION } from '@lines/shared';
import type { BrowserLink } from './userContext.ts';
import type { RelayLinkStatus } from './updates.ts';

/** Mirrors relay/src/protocol.ts. Duplicated rather than imported: the bridge
 *  ships to users' machines and must not depend on the relay package. */
export const RELAY_PROTOCOL_VERSION = 1;

/**
 * A grant the relay attested, riding the `open` frame. Optional: an owner
 * connection carries none, and that is the unchanged fast path.
 *
 * `caps` is a loose record, exactly as on the relay side. The bridge re-parses it
 * through parseShareCaps(), which denies anything not explicitly `true`, so a
 * malformed or hostile blob cannot widen a grant on the way in.
 */
export interface AttestedGrant {
  hostUserId: string;
  scope: 'owner' | 'machine' | 'session';
  caps?: Record<string, boolean>;
  sessionIds?: string[];
  profile?: { userId: string; email: string | null; name: string | null; imageUrl: string | null } | null;
  /** The connecting user's own identity, for presence and prompt attribution. */
  viewerProfile?: { userId: string; email: string | null; name: string | null; imageUrl: string | null } | null;
}

type RelayToAgent =
  | { t: 'open'; ch: string; userId: string; token: string | null; grant?: AttestedGrant }
  | { t: 'data'; ch: string; payload: string }
  | { t: 'close'; ch: string }
  | { t: 'token'; userId: string; token: string }
  | { t: 'ping' };

/**
 * Identity the relay vouched for — a *routing hint*, not an authorization
 * decision. Which user's context to open, and the token storage sync runs on.
 * Owner authority is established separately, by the pinned-key handshake in
 * e2eeChannel.ts.
 */
export interface AttestedIdentity {
  userId: string;
  clerkToken: string | null;
  /** Absent for the machine's owner; present means this connection is a guest. */
  grant?: AttestedGrant;
}

export interface RelayClientCallbacks {
  /** A browser attached. Wire it up exactly like a local socket. */
  onChannel(link: BrowserLink, identity: AttestedIdentity): void;
  /** A freshly verified token for a user, so storage sync keeps working. */
  onToken(userId: string, token: string): void;
  /**
   * The link came up or went down. Optional: only the desktop shell cares, and
   * only so its tray can report whether this machine is actually reachable
   * rather than whether our child processes happen to be alive.
   *
   * Deliberately raw — the relay verifies the device *after* accepting the
   * socket, so an `open` here is not proof of a claim. Interpreting that (a
   * 1008 close means unpaired; a connection that stays up means the claim
   * landed) is the shell's job, where the pairing state lives.
   */
  onStatus?(status: RelayLinkStatus): void;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

/**
 * How long a socket must survive before it counts as a working link.
 *
 * Resetting the backoff on `open` alone is what let a supersede war run at the
 * retry floor forever: the relay accepts every dial, so each one "succeeded" right
 * before being kicked, and the exponent never accumulated. Env-tunable so tests
 * can compress it (see LINES_RELAY_IDLE_MS above for the same reason).
 */
const RELAY_STABLE_MS = Number(process.env.LINES_RELAY_STABLE_MS ?? 10_000);
/** Consecutive 1012 closes that mean "another bridge is claiming this device",
 *  not "the relay restarted". */
const SUPERSEDE_LIMIT = Number(process.env.LINES_SUPERSEDE_LIMIT ?? 5);
/** The re-dial cap once that threshold is crossed. Two bridges fighting over one
 *  identity then cost ~12 log lines an hour instead of two a second. */
const SUPERSEDE_CAP_MS = Number(process.env.LINES_SUPERSEDE_CAP_MS ?? 300_000);

/**
 * Silence that means the socket is dead even though the OS never said so.
 *
 * The relay pings every 20s, so a link with nothing to say still delivers a frame
 * well inside this window; only a half-open connection goes quiet. Without this
 * the bridge can sit on a socket that reports OPEN forever — after a sleep, a
 * Wi-Fi change or a NAT rebind — and the retry logic below never gets its chance.
 *
 * This is also the macOS-sleep fix: the tick uses wall clock, so on wake it fires
 * late, the delta is enormous, and the stale socket is replaced immediately.
 */
const RELAY_IDLE_MS = Number(process.env.LINES_RELAY_IDLE_MS ?? 60_000);
/** Derived, so compressing the timeout in a test compresses the check with it. */
const RELAY_HEALTH_MS = Math.max(1_000, Math.min(15_000, Math.floor(RELAY_IDLE_MS / 4)));

/**
 * One relay channel, presented to the bridge as a BrowserLink.
 *
 * A plain object with stored callbacks rather than an EventEmitter: an
 * unhandled `'error'` on an EventEmitter throws and takes the process down, and
 * there is no reason to inherit that hazard here.
 */
class RelayChannel implements BrowserLink {
  private onMessage: ((raw: unknown) => void) | null = null;
  private onClose: (() => void) | null = null;
  private closed = false;

  constructor(
    readonly id: string,
    private write: (payload: string) => void,
    private requestClose: (id: string) => void,
    /** The relay socket's queue depth — see `bufferedAmount` below. */
    private bufferedOf: () => number,
  ) {}

  send(data: string): void {
    if (!this.closed) this.write(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.requestClose(this.id);
    this.onClose?.();
  }

  /** No half-open state to skip on a multiplexed channel; same as close. */
  terminate(): void {
    this.close();
  }

  on(event: 'message' | 'close' | 'error', cb: (arg: never) => void): this {
    if (event === 'message') this.onMessage = cb as (raw: unknown) => void;
    else if (event === 'close') this.onClose = cb as () => void;
    // 'error' is accepted and ignored: a channel has no independent error
    // condition — the relay socket owns failure, and it surfaces as a close.
    return this;
  }

  get readyState(): number {
    return this.closed ? 3 : 1; // CLOSED : OPEN
  }

  /**
   * The relay socket's queue, shared by every channel on it. Coarse on purpose:
   * per-channel accounting would need the relay to report drain, and a shared
   * signal is the honest one anyway — one wedged channel really does hold up
   * the socket everyone else is riding.
   */
  get bufferedAmount(): number {
    return this.bufferedOf();
  }

  /** Relay said this channel is gone. Fires close without echoing back. */
  remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  deliver(payload: string): void {
    this.onMessage?.(payload);
  }
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private channels = new Map<string, RelayChannel>();
  private retryTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  /** When the relay last said anything at all. 0 until the first frame arrives. */
  private lastFrameAt = 0;
  private attempt = 0;
  private disposed = false;
  /** How many times the relay has hung up on us as superseded. Logged, because a
   *  single takeover is normal (a restart) and a climbing count is not: it means
   *  another process on this machine is claiming the same device. */
  private supersededCount = 0;
  /** Supersedes with no stable socket in between — the run this backs off on. */
  private consecutiveSupersedes = 0;
  /** So the escalation is announced on the crossing, not on every re-dial. */
  private escalated = false;
  /** When the current socket opened, 0 if none is open. */
  private openedAt = 0;

  constructor(
    private url: string,
    private deviceId: string,
    private secret: string,
    private callbacks: RelayClientCallbacks,
  ) {
    this.connect();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopHealthCheck();
    this.dropAllChannels();
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Exponential backoff with jitter. A flat retry across every user's bridge
   * turns one relay restart into a synchronised stampede.
   */
  private retry(): void {
    if (this.disposed || this.retryTimer) return;
    // A run of supersedes is not a flap the relay will recover from on its own:
    // something else on this machine holds the same identity, and only stopping it
    // helps. So the cap goes up instead of the log filling.
    const escalating = this.consecutiveSupersedes >= SUPERSEDE_LIMIT;
    if (escalating && !this.escalated) {
      this.escalated = true;
      console.warn(
        `[relay] superseded ${this.consecutiveSupersedes} times with no stable link — another bridge ` +
          `on this machine is claiming device ${this.deviceId}. Backing off to ` +
          `${Math.round(SUPERSEDE_CAP_MS / 1000)}s between dials; stop that bridge (see ` +
          '~/.lines-app/bridge.lock) and this recovers on the next dial.',
      );
    }
    const cap = escalating ? SUPERSEDE_CAP_MS : RECONNECT_CAP_MS;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt++, cap);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  /**
   * Every open channel must be closed when the socket drops. Without this the
   * bridge's `ctx.sockets` keeps dead links forever and `broadcast` serialises
   * JSON into them on every state change.
   */
  private stopHealthCheck(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /**
   * Terminate a socket that has gone silent, and only that: this client is a
   * peripheral, never a supervisor. It re-dials its own connection and leaves the
   * bridge and the worker — which may be mid-turn — completely alone.
   */
  private startHealthCheck(ws: WebSocket): void {
    this.stopHealthCheck();
    this.lastFrameAt = Date.now();
    this.healthTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastFrameAt <= RELAY_IDLE_MS) return;
      console.warn(`[relay] no frame for >${RELAY_IDLE_MS}ms — terminating and re-dialling`);
      // terminate, not close: a close handshake on a half-open socket waits for a
      // peer that is gone. The 'close' handler drops channels and retries.
      ws.terminate();
    }, RELAY_HEALTH_MS);
    this.healthTimer.unref();
  }

  private dropAllChannels(): void {
    for (const ch of this.channels.values()) ch.remoteClosed();
    this.channels.clear();
  }

  private connect(): void {
    if (this.disposed) return;
    // Never two live sockets from one client: the relay would see two attaches for
    // this device and supersede one of them. The single-flight retryTimer makes
    // this defensive today. Listeners come off first — the old socket's `close`
    // would otherwise drop the channels this connection is about to rebuild and
    // schedule a competing re-dial.
    if (this.ws) {
      const stale = this.ws;
      this.ws = null;
      stale.removeAllListeners();
      // An 'error' with no listener throws and takes the bridge down.
      stale.on('error', () => {});
      stale.close();
      this.dropAllChannels();
    }
    const url = `${this.url}/agent?device=${encodeURIComponent(this.deviceId)}&secret=${encodeURIComponent(this.secret)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      // Deliberately no `attempt = 0` here: see RELAY_STABLE_MS. The close handler
      // resets it, and only for a socket that lasted.
      this.openedAt = Date.now();
      // APP_PROTOCOL_VERSION, never a literal: the relay reads this to decide
      // whether this bridge is new enough to be shared into (COLLAB_MIN_PROTOCOL).
      // Hardcoded, it silently advertises an old contract and every guest
      // connection is refused 1008 while the bridge itself looks healthy.
      ws.send(
        JSON.stringify({ t: 'hello', version: RELAY_PROTOCOL_VERSION, appProtocol: APP_PROTOCOL_VERSION }),
      );
      this.startHealthCheck(ws);
      this.callbacks.onStatus?.({ connected: true });
    });

    ws.on('message', (raw) => {
      this.lastFrameAt = Date.now();
      let frame: RelayToAgent;
      try {
        frame = JSON.parse(String(raw)) as RelayToAgent;
      } catch {
        return;
      }
      this.dispatch(frame);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      // Only the current socket's watchdog: a superseded predecessor closing late
      // must not clear the timer belonging to the connection that replaced it.
      if (this.ws === ws) {
        this.ws = null;
        this.stopHealthCheck();
      }
      // A policy close is a configuration error, not a blip: the relay answers
      // 1008 for an unknown endpoint (RELAY_URL carrying a path — it appends
      // /agent itself) and for a device it cannot verify. Retrying cannot fix
      // either, so it must not be silent. Backoff bounds the log volume.
      const text = reason.toString();
      // A link that lasted is the only evidence the dial actually worked, so it is
      // the only thing that clears the backoff. A supersede is by definition a
      // short-lived socket, which is what makes the exponent accumulate at all.
      if (this.openedAt && Date.now() - this.openedAt >= RELAY_STABLE_MS) {
        this.attempt = 0;
        this.consecutiveSupersedes = 0;
        this.escalated = false;
      }
      this.openedAt = 0;
      if (code === 1012) {
        this.supersededCount++;
        this.consecutiveSupersedes++;
      }
      if (code !== 1000) {
        // The supersede count is the bridge-side tell for two processes sharing one
        // device identity: one line per takeover looks like an ordinary restart.
        const tally = code === 1012 ? ` (superseded ${this.supersededCount} times)` : '';
        console.warn(`[relay] closed ${code} ${text || '(no reason)'}${tally} — dialling ${this.url}/agent`);
      }
      this.callbacks.onStatus?.({ connected: false, code, ...(text ? { reason: text } : {}) });
      this.dropAllChannels();
      this.retry();
    });

    ws.on('error', (err) => {
      console.warn('[relay] socket error:', err.message);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    });
  }

  private dispatch(frame: RelayToAgent): void {
    switch (frame.t) {
      case 'open': {
        // Every agent attach replays `open` for all live channels, so a takeover
        // (or any re-announcement) re-delivers ids we already serve. Idempotent, so
        // that a repeat costs nothing: handling it again would build a second
        // BrowserLink for one browser and push it a second full `hello` snapshot,
        // which is how a relay flap turned into a session-flicker loop. A genuine
        // reconnect can't land here — `ws.on('close')` already dropped the channels.
        if (this.channels.has(frame.ch)) {
          console.warn(`[relay] duplicate open for channel ${frame.ch} — keeping the existing link`);
          break;
        }
        const ch = new RelayChannel(
          frame.ch,
          (payload) => this.ws?.send(JSON.stringify({ t: 'data', ch: frame.ch, payload })),
          (id) => {
            this.channels.delete(id);
            this.ws?.send(JSON.stringify({ t: 'close', ch: id }));
          },
          () => this.ws?.bufferedAmount ?? 0,
        );
        this.channels.set(frame.ch, ch);
        // The relay verified this Clerk token and the bridge does not re-verify
        // it: a second verifier would mean two failure modes, and would make
        // every relayed connection depend on this machine reaching Clerk's JWKS.
        //
        // What that token is NOT is permission to drive this machine. It says
        // which user's context to open and it authorizes storage sync; owner
        // authority comes from the key exchange in e2eeChannel.ts, which this
        // channel passes through before the bridge ever sees it. The relay used
        // to be the auth edge here — that is precisely the hole that closed.
        this.callbacks.onChannel(ch, {
          userId: frame.userId,
          clerkToken: frame.token,
          // Straight through, unexamined: the relay attested it, and the bridge is
          // what enforces it. An absent grant means the owner's own connection.
          ...(frame.grant ? { grant: frame.grant } : {}),
        });
        break;
      }
      case 'data':
        this.channels.get(frame.ch)?.deliver(frame.payload);
        break;
      case 'close': {
        const ch = this.channels.get(frame.ch);
        this.channels.delete(frame.ch);
        ch?.remoteClosed();
        break;
      }
      case 'token':
        this.callbacks.onToken(frame.userId, frame.token);
        break;
      case 'ping':
        this.ws?.send(JSON.stringify({ t: 'pong' }));
        break;
    }
  }
}
