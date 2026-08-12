/**
 * Pairing and multiplexing, with no transport or auth in it — so the whole
 * routing surface is testable without sockets or Clerk.
 *
 * One `DeviceHub` per paired device. Browsers attach as channels; at most one
 * bridge ("agent") is attached at a time, newest wins.
 */
import { encode, type AgentToRelay, type ChannelId, type LinkClass, type RelayToAgent } from './protocol.ts';

/** The bit of a socket the hub uses; keeps this module transport-free. */
export interface Sink {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /**
   * Hard drop, skipping the close handshake. Optional so a test sink need not
   * implement it. Used on supersede: a predecessor is by definition dead or
   * being replaced, and a graceful close waits on a reply from a peer that may
   * be gone — leaving the loser's socket OPEN on the relay for minutes.
   */
  terminate?(): void;
}

interface Channel {
  id: ChannelId;
  userId: string;
  cls: LinkClass;
  sink: Sink;
}

export class DeviceHub {
  /**
   * Clerk userId this device belongs to, learned when its bridge authenticates.
   * Null means no bridge has ever attached, so no browser may be paired to it:
   * the /client gate compares against this.
   */
  ownerId: string | null = null;
  /**
   * How many bridges have ever attached to this device. Diagnostics, exposed
   * through the relay's health payload: on an idle paired machine this stays at
   * 1, so a climbing counter is two processes fighting over one identity.
   */
  agentAttaches = 0;
  /** ms epoch of the newest attach; 0 before the first one. */
  lastAttachAt = 0;
  private agent: Sink | null = null;
  private channels = new Map<ChannelId, Channel>();
  private nextId = 0;
  /** Last Clerk token seen per user, re-pushed when a bridge (re)attaches. */
  private tokens = new Map<string, string>();

  constructor(readonly deviceId: string) {}

  get online(): boolean {
    return this.agent !== null;
  }

  get channelCount(): number {
    return this.channels.size;
  }

  /**
   * Whether this socket is still the device's bridge. Every per-socket timer and
   * handler on the relay has to ask: a superseded socket that keeps acting owns
   * nothing, and its actions land on the connection that replaced it.
   */
  isAgent(sink: Sink): boolean {
    return this.agent === sink;
  }

  /**
   * Attach a bridge. Newest wins — a reconnecting bridge must be able to take
   * over from a half-dead predecessor the relay hasn't noticed yet.
   *
   * Existing channels are *not* closed: the browser stays connected across a
   * bridge restart and simply gets a fresh `hello` once it re-opens them.
   *
   * Returns the sink it superseded, so the caller can log a duplicate attach —
   * which is otherwise indistinguishable from a first one.
   */
  attachAgent(sink: Sink): Sink | null {
    const previous = this.agent;
    this.agent = sink;
    this.agentAttaches++;
    this.lastAttachAt = Date.now();
    if (previous && previous !== sink) {
      previous.close(1012, 'superseded');
      // And then hang up on it: a close handshake on a socket whose peer is gone
      // never completes, and until it does the loser still looks OPEN here.
      previous.terminate?.();
    }

    // Re-announce every live channel so the new bridge builds its own state,
    // and re-push tokens, which the bridge needs for storage sync.
    for (const [userId, token] of this.tokens) {
      sink.send(encode({ t: 'token', userId, token }));
    }
    for (const ch of this.channels.values()) {
      sink.send(encode({ t: 'open', ch: ch.id, userId: ch.userId, token: this.tokens.get(ch.userId) ?? null }));
    }
    this.broadcastToClients({ type: 'deviceOnline' });
    return previous && previous !== sink ? previous : null;
  }

  /** The bridge went away. Channels stay open and are told, so the UI can say so. */
  detachAgent(sink: Sink): void {
    if (this.agent !== sink) return; // a superseded predecessor closing late
    this.agent = null;
    this.broadcastToClients({ type: 'deviceOffline' });
  }

  /** Register a browser. Returns its channel id, or null if the id space is exhausted. */
  openChannel(userId: string, cls: LinkClass, sink: Sink, token: string | null): ChannelId {
    const id = `c${++this.nextId}`;
    this.channels.set(id, { id, userId, cls, sink });
    if (token) this.tokens.set(userId, token);
    if (this.agent) {
      this.agent.send(encode({ t: 'open', ch: id, userId, token }));
    } else {
      // Told immediately rather than left hanging: the client renders a
      // "device offline" state instead of an indefinite spinner.
      sink.send(JSON.stringify({ type: 'deviceOffline' }));
    }
    return id;
  }

  closeChannel(id: ChannelId): void {
    if (!this.channels.delete(id)) return;
    this.agent?.send(encode({ t: 'close', ch: id }));
  }

  /** Browser -> bridge. Dropped silently when no bridge is attached. */
  fromClient(id: ChannelId, payload: string): void {
    if (!this.channels.has(id)) return;
    this.agent?.send(encode({ t: 'data', ch: id, payload }));
  }

  /**
   * Bridge -> browser. Forwarded synchronously by the caller's message handler:
   * introducing an await here would let two frames race and reorder a stream.
   *
   * `sink` is the socket the frame arrived on, and only the current bridge is
   * allowed to speak: a superseded one that is still writing would inject its own
   * (older) state into live browser channels, and its `close` frames would delete
   * channels owned by the bridge that replaced it.
   */
  fromAgent(frame: AgentToRelay, sink: Sink): void {
    if (this.agent !== sink) return;
    if (frame.t === 'data') {
      this.channels.get(frame.ch)?.sink.send(frame.payload);
      return;
    }
    if (frame.t === 'close') {
      const ch = this.channels.get(frame.ch);
      this.channels.delete(frame.ch);
      ch?.sink.close(1000, 'closed by bridge');
    }
  }

  /** Record a freshly verified token so a reconnecting bridge gets it. */
  setToken(userId: string, token: string): void {
    this.tokens.set(userId, token);
    this.agent?.send(encode({ t: 'token', userId, token }));
  }

  /** Drop everything — used when a device is revoked. */
  shutdown(reason: string): void {
    for (const ch of this.channels.values()) ch.sink.close(1008, reason);
    this.channels.clear();
    this.agent?.close(1008, reason);
    this.agent = null;
    this.tokens.clear();
  }

  private broadcastToClients(msg: unknown): void {
    const payload = JSON.stringify(msg);
    for (const ch of this.channels.values()) ch.sink.send(payload);
  }
}

/**
 * All hubs, keyed by device. A hub is created on first use and dropped once it
 * has neither a bridge nor any channel, so an idle relay holds nothing.
 */
export class HubRegistry {
  private hubs = new Map<string, DeviceHub>();

  get(deviceId: string): DeviceHub {
    let hub = this.hubs.get(deviceId);
    if (!hub) {
      hub = new DeviceHub(deviceId);
      this.hubs.set(deviceId, hub);
    }
    return hub;
  }

  peek(deviceId: string): DeviceHub | undefined {
    return this.hubs.get(deviceId);
  }

  sweep(): void {
    for (const [id, hub] of this.hubs) {
      if (!hub.online && hub.channelCount === 0) this.hubs.delete(id);
    }
  }

  get size(): number {
    return this.hubs.size;
  }

  /**
   * Per-device summary for the secret-gated half of the health endpoint. Triage
   * only: it says how many bridges have claimed each device and when, which is
   * the one thing the logs could not answer during a takeover flap.
   */
  list(): Array<{
    deviceId: string;
    online: boolean;
    channels: number;
    agentAttaches: number;
    lastAttachAt: number;
  }> {
    return [...this.hubs.values()].map((hub) => ({
      deviceId: hub.deviceId,
      online: hub.online,
      channels: hub.channelCount,
      agentAttaches: hub.agentAttaches,
      lastAttachAt: hub.lastAttachAt,
    }));
  }

  /** Revoke: tear the hub down and forget it. */
  drop(deviceId: string, reason: string): void {
    this.hubs.get(deviceId)?.shutdown(reason);
    this.hubs.delete(deviceId);
  }
}

/** Re-exported so the relay's socket layer has one import for frame types. */
export type { RelayToAgent };
