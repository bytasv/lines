/**
 * Pairing and multiplexing, with no transport or auth in it — so the whole
 * routing surface is testable without sockets or Clerk.
 *
 * One `DeviceHub` per paired device. Browsers attach as channels; at most one
 * bridge ("agent") is attached at a time, newest wins.
 */
import {
  encode,
  type AgentToRelay,
  type AttestedGrant,
  type ChannelId,
  type LinkClass,
  type RelayToAgent,
} from './protocol.ts';

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

export type EventDetail = Record<string, string | number | boolean | null>;
export interface DeviceEvent {
  /** ms epoch */
  t: number;
  kind: string;
  detail?: EventDetail;
}

/**
 * A short per-device history of what the relay decided, for triage of "my
 * browser never connects": attaches, detaches, channel opens and every refusal
 * with its reason. Current hub state alone cannot answer that question — by the
 * time anyone looks, the refused browser has left and the idle hub was swept.
 *
 * Kept apart from the hubs for exactly that reason, and bounded twice: a fixed
 * number of events per device, and a fixed number of devices, least recently
 * touched evicted first. Holds no payloads and no tokens.
 */
export class DeviceEvents {
  private byDevice = new Map<string, DeviceEvent[]>();

  constructor(
    private readonly perDevice = 50,
    private readonly maxDevices = 1000,
  ) {}

  record(deviceId: string, kind: string, detail?: EventDetail): void {
    let list = this.byDevice.get(deviceId);
    if (list) this.byDevice.delete(deviceId); // re-inserted below: Map order is the LRU
    else list = [];
    list.push(detail ? { t: Date.now(), kind, detail } : { t: Date.now(), kind });
    if (list.length > this.perDevice) list.splice(0, list.length - this.perDevice);
    this.byDevice.set(deviceId, list);
    while (this.byDevice.size > this.maxDevices) {
      const oldest = this.byDevice.keys().next().value as string;
      this.byDevice.delete(oldest);
    }
  }

  get(deviceId: string): DeviceEvent[] {
    return [...(this.byDevice.get(deviceId) ?? [])];
  }

  /** Every device with history, including ones whose hub has been swept. */
  snapshot(): Record<string, DeviceEvent[]> {
    return Object.fromEntries([...this.byDevice].map(([id, list]) => [id, [...list]]));
  }

  get size(): number {
    return this.byDevice.size;
  }
}

interface Channel {
  id: ChannelId;
  userId: string;
  cls: LinkClass;
  sink: Sink;
  /**
   * The grant this channel was opened under. Absent means owner — the fast path,
   * which consults no share table and is re-checked only by the device's own
   * re-verify. Present means a guest, whose grant is re-authorized on a much
   * shorter clock so a revoke lands on a live socket.
   */
  grant?: AttestedGrant;
}

/**
 * Whether a frame is the browser's token refresh, `{type:'auth', token}` — the
 * one app message that carries a Clerk token.
 *
 * Parsed in full rather than matched as text, because the bridge parses it in
 * full: a reordered key, a space or a `\u0061uth` escape slips past a text match
 * yet still reads as `auth` on the other side. Anything unparseable is not one
 * and is forwarded exactly as before — the relay is not a validator.
 */
function isTokenRefresh(payload: string): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(payload);
  } catch {
    return false;
  }
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'auth';
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
  /** ms epoch of the last time the bridge went away; 0 if it never has. */
  lastDetachAt = 0;
  /**
   * Browser<->bridge contract the attached bridge speaks, from its `hello`.
   * Null before one arrives. Non-owner access requires a bridge new enough to
   * enforce a grant, so this is what the /client gate reads.
   */
  appProtocol: number | null = null;
  private agent: Sink | null = null;
  /** Resolved by {@link attachAgent}; see {@link waitForAgent}. */
  private agentWaiters = new Set<() => void>();
  private channels = new Map<ChannelId, Channel>();
  private nextId = 0;
  /**
   * Last Clerk token seen per user, re-pushed when a bridge (re)attaches.
   *
   * The owner's only. A bridge needs its owner's token for storage sync; a
   * guest's would be a live credential for the guest's own account, handed to a
   * machine someone else controls and which has no use for it. A browser's
   * refresh mid-connection rides inside its channel, so it never lands here.
   */
  private tokens = new Map<string, string>();

  constructor(
    readonly deviceId: string,
    private readonly record: (kind: string, detail?: EventDetail) => void = () => {},
  ) {}

  get online(): boolean {
    return this.agent !== null;
  }

  /**
   * Whether a guest has to be refused because the attached bridge is too old to
   * enforce a grant.
   *
   * Only while a bridge is attached: with none, `appProtocol` is null because
   * `detachAgent` forgot it, not because anything old is running. Reading that
   * null as "too old" refuses an authorized guest with the same
   * `1008 unauthorized` a revoke produces, so a sleeping host is
   * indistinguishable from lost access. Offline is the hub's own answer —
   * `openChannel` sends `deviceOffline` — and this must not pre-empt it.
   */
  guestNeedsNewerBridge(minProtocol: number): boolean {
    return this.online && (this.appProtocol === null || this.appProtocol < minProtocol);
  }

  /**
   * Wait for a bridge to attach, resolving true if one does inside the deadline.
   *
   * Exists for one race: after a relay restart the browser reconnects about a
   * second before the bridge finishes `verifyDevice`, so `ownerId` is still null
   * and the machine's own user is classified as a guest and refused `1008`. The
   * browser then backs off five seconds and tries again, and with the bridge
   * flapping that repeats — which is what turned a reload into a minute of
   * "connecting to your machine".
   *
   * A wait rather than trusting storage for ownership: `ownerId` is null until a
   * bridge proves the device secret, and that is the property the /client gate
   * rests on. This only gives the proof a moment to arrive.
   */
  waitForAgent(timeoutMs: number): Promise<boolean> {
    if (this.agent) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.agentWaiters.delete(done);
        resolve(true);
      };
      // Deliberately not unref'd: an unref'd timer lets an otherwise-idle event
      // loop drain before the deadline, so the promise never settles at all.
      // It is cleared the moment a bridge attaches, and is seconds long at most.
      const timer = setTimeout(() => {
        this.agentWaiters.delete(done);
        resolve(false);
      }, timeoutMs);
      this.agentWaiters.add(done);
    });
  }

  get channelCount(): number {
    return this.channels.size;
  }

  /**
   * Whether a browser is parked in {@link waitForAgent} on this hub.
   *
   * A waiting browser holds no channel yet, so without this the sweep can drop
   * the hub out from under it — the bridge would then attach to a fresh one and
   * the waiter would time out against a hub nothing will ever attach to.
   */
  get hasPendingClients(): boolean {
    return this.agentWaiters.size > 0;
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
   * Every existing channel is closed first, so its browser redials the new
   * bridge. Owner channels are end-to-end encrypted, and that session lives in
   * the bridge process that just went away — replaying `open` to its successor
   * hands over a channel with no session, which the browser, believing it has
   * one, can never use. Guests are dropped for a reason of their own, below.
   *
   * Returns the sink it superseded, so the caller can log a duplicate attach —
   * which is otherwise indistinguishable from a first one.
   */
  attachAgent(sink: Sink): Sink | null {
    // Guests are dropped rather than replayed, and before the new bridge is in
    // place so it never hears about them. It has not said `hello` yet, so its app
    // protocol is unknown here, and a bridge too old to understand `grant` would
    // ignore the field and serve the guest as the owner — exactly what the
    // /client version gate exists to prevent, at the one moment it cannot run.
    // Closing 1008 makes the browser reconnect on its own and take that gate
    // again, by which time the `hello` has landed. The cost is a blip for the
    // guest; the alternative is a silent promotion.
    for (const { id } of this.guestChannels()) {
      this.dropChannel(id, 'bridge reattached');
    }
    // 1012, not 1008: an owner has nothing to re-check, so the browser takes its
    // ordinary quick redial rather than the slow "rejected" one.
    for (const id of [...this.channels.keys()]) {
      this.dropChannel(id, 'bridge reattached', 1012);
    }

    const previous = this.agent;
    this.agent = sink;
    this.agentAttaches++;
    this.lastAttachAt = Date.now();
    this.record(previous && previous !== sink ? 'agent-supersede' : 'agent-attach', {
      attach: this.agentAttaches,
      channels: this.channels.size,
      waiters: this.agentWaiters.size,
    });
    if (previous && previous !== sink) {
      previous.close(1012, 'superseded');
      // And then hang up on it: a close handshake on a socket whose peer is gone
      // never completes, and until it does the loser still looks OPEN here.
      previous.terminate?.();
    }

    // Re-push the owner's token, which the new bridge needs for storage sync
    // before any browser has redialled. Filtered even though a guest's is never
    // kept: `ownerId` is the claim this bridge has just proved, and a token held
    // for anyone else — whoever owned this device id before it was re-registered,
    // and may be a guest on it now — is not this bridge's to have.
    for (const [userId, token] of this.tokens) {
      if (userId === this.ownerId) sink.send(encode({ t: 'token', userId, token }));
    }
    this.broadcastToClients({ type: 'deviceOnline' });
    // Last, so anyone released here sees a hub that is fully attached. The
    // caller has already set `ownerId`, which is the whole point of the wait.
    for (const wake of [...this.agentWaiters]) wake();
    return previous && previous !== sink ? previous : null;
  }

  /** The bridge went away. Channels stay open and are told, so the UI can say so. */
  detachAgent(sink: Sink): void {
    if (this.agent !== sink) return; // a superseded predecessor closing late
    this.agent = null;
    this.lastDetachAt = Date.now();
    this.record('agent-detach', { channels: this.channels.size });
    // Forgotten with the bridge: a stale version from a process that is gone must
    // not vouch for whatever attaches next.
    this.appProtocol = null;
    this.broadcastToClients({ type: 'deviceOffline' });
  }

  /** Register a browser. Returns its channel id, or null if the id space is exhausted. */
  openChannel(
    userId: string,
    cls: LinkClass,
    sink: Sink,
    token: string | null,
    grant?: AttestedGrant,
  ): ChannelId {
    const id = `c${++this.nextId}`;
    this.channels.set(id, { id, userId, cls, sink, grant });
    this.record('channel-open', { ch: id, userId, guest: !!grant, agentOnline: this.agent !== null });
    // A guest's token stops here, neither forwarded nor kept for a re-push. The
    // relay has verified it, which is all it was ever for: the bridge serves a
    // guest from the host's context and never syncs as them, so on the host's
    // machine it is only a live credential for someone else's account. Stripped
    // here rather than left to the bridge to ignore, because the bridge is code
    // the host runs — the guest has no say in what it does with what it is sent.
    const ownerToken = grant ? null : token;
    if (ownerToken) this.tokens.set(userId, ownerToken);
    if (this.agent) {
      this.agent.send(encode({ t: 'open', ch: id, userId, token: ownerToken, ...(grant ? { grant } : {}) }));
    } else {
      // Told immediately rather than left hanging: the client renders a
      // "device offline" state instead of an indefinite spinner.
      sink.send(JSON.stringify({ type: 'deviceOffline' }));
    }
    return id;
  }

  closeChannel(id: ChannelId): void {
    if (!this.channels.delete(id)) return;
    this.record('channel-close', { ch: id, by: 'client' });
    this.agent?.send(encode({ t: 'close', ch: id }));
  }

  /** Live guest channels, for the re-authorization sweep. Owners are not re-checked here. */
  guestChannels(): { id: ChannelId; userId: string; grant: AttestedGrant }[] {
    return [...this.channels.values()]
      .filter((ch): ch is Channel & { grant: AttestedGrant } => !!ch.grant)
      .map(({ id, userId, grant }) => ({ id, userId, grant }));
  }

  /** Drop one channel and tell its browser why. Used when a grant is revoked or narrowed. */
  dropChannel(id: ChannelId, reason: string, code = 1008): void {
    const ch = this.channels.get(id);
    if (!ch) return;
    this.channels.delete(id);
    this.record('channel-drop', { ch: id, reason });
    this.agent?.send(encode({ t: 'close', ch: id }));
    ch.sink.close(code, reason);
  }

  /**
   * Browser -> bridge. Dropped silently when no bridge is attached.
   *
   * One frame is never forwarded: a guest's token refresh. The browser relays a
   * fresh Clerk token over its links on a timer, and on a guest link that is the
   * very credential `openChannel` strips, minted afresh every ~50s. Dropping it
   * here covers every bridge already installed and every tab still running an
   * older client, whatever either does with it — and an older bridge even
   * installs it as the *host's* storage credential. Nothing waits on the frame:
   * the bridge never answers one.
   *
   * Only a guest's frame is looked at, and only its `type`. An owner channel is
   * end-to-end encrypted and passes through untouched, as it always has. A
   * current client's guest channel is end-to-end encrypted too — its frames read
   * as `e2ee*` here and pass straight through — so what this still catches is an
   * older client's plaintext refresh, which the relay could already read.
   */
  fromClient(id: ChannelId, payload: string): void {
    const ch = this.channels.get(id);
    if (!ch) return;
    if (ch.grant && isTokenRefresh(payload)) return;
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
      if (ch) this.record('channel-close', { ch: frame.ch, by: 'bridge' });
      ch?.sink.close(1000, 'closed by bridge');
    }
  }

  /**
   * Record a freshly verified token so a reconnecting bridge gets it. The owner's
   * only, for the reason on `tokens`: there is no channel here to read a grant
   * off, and the device's owner is the one user whose token a bridge needs.
   */
  setToken(userId: string, token: string): void {
    if (userId !== this.ownerId) return;
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
  readonly events: DeviceEvents;

  constructor(events = new DeviceEvents()) {
    this.events = events;
  }

  get(deviceId: string): DeviceHub {
    let hub = this.hubs.get(deviceId);
    if (!hub) {
      hub = new DeviceHub(deviceId, (kind, detail) => this.events.record(deviceId, kind, detail));
      this.hubs.set(deviceId, hub);
    }
    return hub;
  }

  peek(deviceId: string): DeviceHub | undefined {
    return this.hubs.get(deviceId);
  }

  /** Hubs holding at least one guest channel — the only ones the re-auth sweep costs anything for. */
  withGuests(): { deviceId: string; hub: DeviceHub }[] {
    return [...this.hubs.entries()]
      .filter(([, hub]) => hub.guestChannels().length > 0)
      .map(([deviceId, hub]) => ({ deviceId, hub }));
  }

  sweep(): void {
    for (const [id, hub] of this.hubs) {
      if (!hub.online && hub.channelCount === 0 && !hub.hasPendingClients) this.hubs.delete(id);
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
    lastDetachAt: number;
    pendingClients: boolean;
    ownerId: string | null;
    appProtocol: number | null;
  }> {
    return [...this.hubs.values()].map((hub) => ({
      deviceId: hub.deviceId,
      online: hub.online,
      channels: hub.channelCount,
      agentAttaches: hub.agentAttaches,
      lastAttachAt: hub.lastAttachAt,
      lastDetachAt: hub.lastDetachAt,
      pendingClients: hub.hasPendingClients,
      // Both gate inputs for /client. A connection refused as an unauthorized
      // guest is otherwise indistinguishable from one refused for a stale
      // bridge, and the logs cannot say which without them.
      ownerId: hub.ownerId,
      appProtocol: hub.appProtocol,
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
