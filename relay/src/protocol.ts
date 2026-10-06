/**
 * Relay wire protocol.
 *
 * The relay is a byte pipe between a browser and one paired local bridge. It
 * multiplexes many browser connections ("channels") over the single outbound
 * WebSocket the bridge dials, and it forwards `payload` **without reading it**.
 *
 * That opacity is deliberate and load-bearing. The relay terminates TLS, so it
 * could read prompts, file contents and transcripts. Keeping the payload a
 * blob behind a separate routing header means end-to-end encryption can be
 * added later by encrypting `payload` alone — no codec rewrite, no change to
 * the multiplexer. Nothing here may start parsing it.
 *
 * The single exception is a guest's token refresh: a frame a guest sends toward
 * the bridge is parsed for its `type`, and an `auth` one is dropped rather than
 * handing the guest's Clerk token to the host's machine (DeviceHub.fromClient).
 * It reads nothing the relay could not already see — a current client seals its
 * guest frames end to end, so those read only as `e2ee*`, and an older client's
 * plaintext was visible anyway — and an owner's frame is never looked at.
 *
 * Kept dependency-free so both the relay and the bridge can import it.
 */

/** Bumped only for changes to the frames below, not to the app messages inside. */
export const RELAY_PROTOCOL_VERSION = 1;

/** Clerk token on `/client`, device secret on `/agent`. */
export const RELAY_DEVICE_HEADER = 'x-lines-device';
/**
 * The device secret a bridge presents on `/agent`. A header, never the URL: a URL
 * is what proxies and access logs record. The bridge mirrors this name in
 * relayClient.ts, so renaming it unpairs every bridge already installed.
 */
export const RELAY_SECRET_HEADER = 'x-lines-device-secret';

/**
 * Interactive traffic and bulk transfers ride separate links.
 *
 * One socket for everything means a multi-megabyte transcript or docs bundle
 * head-of-line-blocks the stream deltas of every other channel behind it. Two
 * links is far simpler than interleaving chunks with a scheduler.
 */
export type LinkClass = 'ctrl' | 'bulk';

/** Channel id, unique per agent connection. Assigned by the relay. */
export type ChannelId = string;

/**
 * A grant the relay attested, riding the `open` frame.
 *
 * Optional on purpose: an older bridge ignores unknown fields, so adding this
 * needs no RELAY_PROTOCOL_VERSION bump. What stops such a bridge being shared is
 * the relay's COLLAB_MIN_PROTOCOL check, not the wire format.
 *
 * `caps` is a loose record rather than the typed ShareCaps: this module stays
 * dependency-free, and the bridge re-parses it through parseShareCaps() — which
 * denies anything not explicitly `true` — so a malformed blob cannot widen a
 * grant on the way through.
 */
export interface AttestedGrant {
  /** Whose context the bridge must serve this channel from — the *host*, not the guest. */
  hostUserId: string;
  scope: 'owner' | 'machine' | 'session';
  caps?: Record<string, boolean>;
  /** Session scope only. */
  sessionIds?: string[];
  /** Display identity of the host, so a guest's UI can name whose machine it is. */
  profile?: { userId: string; email: string | null; name: string | null; imageUrl: string | null } | null;
  /** The connecting user's own identity, for presence and prompt attribution. */
  viewerProfile?: { userId: string; email: string | null; name: string | null; imageUrl: string | null } | null;
}

/** Relay -> bridge. */
export type RelayToAgent =
  /** A browser connected. `userId` is relay-attested; see the note in relayClient. */
  | {
      t: 'open';
      ch: ChannelId;
      userId: string;
      /**
       * The owner's Clerk token, which storage sync runs on. Always null on a
       * guest channel: the host's bridge has no use for a guest's, and it would be
       * a live credential for the guest's account on someone else's machine.
       */
      token: string | null;
      /** Absent for an owner connection — the unchanged, unshared fast path. */
      grant?: AttestedGrant;
    }
  /** One app message, verbatim. */
  | { t: 'data'; ch: ChannelId; payload: string }
  /** The browser went away, or the relay gave up on it. */
  | { t: 'close'; ch: ChannelId }
  /** The owner's freshest Clerk token, re-pushed after a bridge reconnect. Never a guest's. */
  | { t: 'token'; userId: string; token: string }
  | { t: 'ping' };

/** Bridge -> relay. */
export type AgentToRelay =
  | { t: 'hello'; version: number; appProtocol: number }
  | { t: 'data'; ch: ChannelId; payload: string }
  | { t: 'close'; ch: ChannelId }
  | { t: 'pong' };

/** Relay -> browser. Control frames are distinguishable from app messages by
 *  their `type`, which no ServerMessage uses. */
export type RelayToClient =
  /** No bridge is currently connected for this device. */
  | { type: 'deviceOffline' }
  /** A bridge attached; the client should expect its `hello` next. */
  | { type: 'deviceOnline' };

export function encode(frame: RelayToAgent | AgentToRelay): string {
  return JSON.stringify(frame);
}

/** Returns null on anything unparseable — a peer sending junk is not a crash. */
export function decode<T>(raw: unknown): T | null {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}
