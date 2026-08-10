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
import type { BrowserLink } from './userContext.ts';

/** Mirrors relay/src/protocol.ts. Duplicated rather than imported: the bridge
 *  ships to users' machines and must not depend on the relay package. */
export const RELAY_PROTOCOL_VERSION = 1;

type RelayToAgent =
  | { t: 'open'; ch: string; userId: string; token: string | null }
  | { t: 'data'; ch: string; payload: string }
  | { t: 'close'; ch: string }
  | { t: 'token'; userId: string; token: string }
  | { t: 'ping' };

/** Identity the relay vouched for, in place of a Clerk verification here. */
export interface AttestedIdentity {
  userId: string;
  clerkToken: string | null;
}

export interface RelayClientCallbacks {
  /** A browser attached. Wire it up exactly like a local socket. */
  onChannel(link: BrowserLink, identity: AttestedIdentity): void;
  /** A freshly verified token for a user, so storage sync keeps working. */
  onToken(userId: string, token: string): void;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

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
  private attempt = 0;
  private disposed = false;

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
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt++, RECONNECT_CAP_MS);
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
  private dropAllChannels(): void {
    for (const ch of this.channels.values()) ch.remoteClosed();
    this.channels.clear();
  }

  private connect(): void {
    if (this.disposed) return;
    const url = `${this.url}/agent?device=${encodeURIComponent(this.deviceId)}&secret=${encodeURIComponent(this.secret)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      ws.send(JSON.stringify({ t: 'hello', version: RELAY_PROTOCOL_VERSION, appProtocol: 1 }));
    });

    ws.on('message', (raw) => {
      let frame: RelayToAgent;
      try {
        frame = JSON.parse(String(raw)) as RelayToAgent;
      } catch {
        return;
      }
      this.dispatch(frame);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws === ws) this.ws = null;
      // A policy close is a configuration error, not a blip: the relay answers
      // 1008 for an unknown endpoint (RELAY_URL carrying a path — it appends
      // /agent itself) and for a device it cannot verify. Retrying cannot fix
      // either, so it must not be silent. Backoff bounds the log volume.
      if (code !== 1000) {
        const text = reason.toString() || '(no reason)';
        console.warn(`[relay] closed ${code} ${text} — dialling ${this.url}/agent`);
      }
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
        // The relay is the auth edge and already verified this token, so the
        // bridge does not re-verify: a second verifier would mean two failure
        // modes, and would make every relayed connection depend on this machine
        // being able to reach Clerk's JWKS.
        this.callbacks.onChannel(ch, { userId: frame.userId, clerkToken: frame.token });
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
