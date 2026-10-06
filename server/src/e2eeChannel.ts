/**
 * The bridge side of the encrypted channel, and the gate in front of it.
 *
 * A relay channel arrives with an identity the relay *asserted*. Until this
 * module existed the bridge simply believed it — `handleConnection` took
 * `attested.userId` and granted owner access, so anyone who controlled the relay
 * process could open a channel as any user and drive an agent. That is the hole
 * this closes: a channel that carries no key the machine has pinned locally does
 * not become an owner connection, whatever the relay says about it — and one the
 * relay calls a guest's is admitted only on a grant this machine minted itself.
 *
 * Sits between `RelayClient` and `handleConnection` rather than inside either:
 * the bridge's message switch should not grow a crypto branch, and the relay
 * client should stay a transport. What comes out is an ordinary
 * {@link BrowserLink}, which is why nothing downstream changed.
 */
import {
  acceptHandshake,
  type ClientMessage,
  type Identity,
  type PublicKeyB64,
  type SecureSession,
  type ServerMessage,
} from '@lines/shared';
import { enrollPeer, isEnrolled, touchPeer } from './e2eeIdentity.ts';
import { redeemGuestGrant, type GuestGrantRecord } from './guestGrants.ts';
import type { BrowserLink } from './userContext.ts';

/**
 * A channel presented to the bridge, with the crypto folded in.
 *
 * `BrowserLink` by construction: the bridge registers exactly one `message`
 * handler on a link (RelayChannel stores one callback, not a list), so this
 * cannot be a second listener on the raw channel — it has to *be* the link the
 * bridge is handed.
 */
export interface ChannelPolicy {
  /** Is this client key on this machine's enrolled list? The pin check. */
  isEnrolled(key: PublicKeyB64): boolean;
  /** Bind a new device against a code the host displayed. */
  enroll(identity: Identity, clientKey: PublicKeyB64, proof: string): Promise<{ proof: string } | { error: string }>;
  /** Note that a pinned device connected. Best-effort bookkeeping. */
  touch(key: PublicKeyB64): void;
  /** The grant a guest's admission token redeems for this caller, or null. See guestGrants.ts. */
  redeemGuest(token: string, guestUserId: string): GuestGrantRecord | null;
}

/** The real policy: the 0600 files under `~/.lines-app`. Injectable so the
 *  adversarial harness can drive this without a home directory. */
export const filePolicy: ChannelPolicy = {
  isEnrolled: (key) => isEnrolled(key),
  enroll: (identity, clientKey, proof) => enrollPeer(identity, clientKey, proof, 'browser'),
  touch: (key) => touchPeer(key),
  redeemGuest: (token, guestUserId) => redeemGuestGrant(token, guestUserId),
};

/**
 * What a guest channel is refused with when it skips the grant. Worded for the
 * person, and deliberately not containing "end-to-end encrypted channel": the
 * client keys its owner enrollment gate on that phrase, and a guest has nothing
 * to enrol — they need the link.
 */
const GUEST_NEEDS_LINK =
  'this machine admits a guest only through the invite link its owner shared — open that link again to connect';

/** More than any real guest holds for one machine; the rest are ignored rather than redeemed. */
const MAX_GRANT_TOKENS = 32;

class SecureChannel implements BrowserLink {
  private onMessage: ((raw: unknown) => void) | null = null;
  private onClose: (() => void) | null = null;
  /** App frames that arrived before the bridge listened; replayed in order on `on('message')`. */
  private early: string[] = [];
  private session: SecureSession | null = null;
  /**
   * Serialises outbound frames. `seal` assigns a counter synchronously but
   * encrypts asynchronously, and the receiver refuses a counter it has already
   * passed — so two sends resolving out of order would drop a message and, worse,
   * would read as a replay attack rather than as a race.
   */
  private sending: Promise<void> = Promise.resolve();
  private handshake: Awaited<ReturnType<typeof acceptHandshake>> | null = null;
  private closed = false;
  /** Whether the bridge already holds this channel. See `handOver`. */
  private handedOver = false;
  /**
   * Inbound frames, one at a time. Opening a sealed frame is asynchronous, and
   * two of them in flight at once could finish out of order — which would let a
   * guest's later `ping` overtake the grant it must lead with, or reorder an
   * owner's two prompts past the counter check.
   */
  private inbound: Promise<void> = Promise.resolve();

  constructor(
    private raw: BrowserLink,
    private identity: Identity,
    /** Set for a channel the relay says is a guest's: who it says is calling. */
    private guest: { userId: string } | null,
    private policy: ChannelPolicy,
    /** Called once the channel may carry app traffic; the grants a guest was admitted on, none for the owner. */
    private onReady: (link: BrowserLink, peerKey: PublicKeyB64, grants: GuestGrantRecord[]) => void,
  ) {
    this.raw.on('message', (frame) => {
      this.inbound = this.inbound
        .then(() => (this.closed ? undefined : this.handleFrame(frame)))
        .catch((err) => {
          this.refuse(err instanceof Error ? err.message : String(err));
        });
    });
    this.raw.on('close', () => {
      this.closed = true;
      this.onClose?.();
    });
    this.raw.on('error', () => {
      /* the relay owns socket failure; it surfaces as a close */
    });
    // Nothing is handed over here. Every relay channel authenticates first — an
    // owner's against a key this machine pinned, a guest's with a grant this
    // machine minted — and only then reaches the bridge, which speaks first
    // (`hello`) the moment it is given one.
  }

  /** Give the bridge this channel, exactly once. */
  private handOver(peerKey: PublicKeyB64, grants: GuestGrantRecord[]): void {
    if (this.handedOver) return;
    this.handedOver = true;
    this.onReady(this, peerKey, grants);
  }

  // --- BrowserLink -------------------------------------------------------

  send(data: string): void {
    if (this.closed) return;
    if (!this.session) {
      this.raw.send(data);
      return;
    }
    const session = this.session;
    this.sending = this.sending
      .then(async () => {
        const sealed = await session.seal(data);
        this.raw.send(JSON.stringify({ type: 'e2eeData', ...sealed } satisfies ServerMessage));
      })
      .catch((err) => {
        console.warn('[e2ee] send failed:', err instanceof Error ? err.message : String(err));
      });
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.raw.close(code, reason);
  }

  terminate(): void {
    this.closed = true;
    this.raw.terminate();
  }

  on(event: 'message' | 'close' | 'error', cb: (arg: never) => void): this {
    if (event === 'message') {
      this.onMessage = cb as (raw: unknown) => void;
      const early = this.early;
      this.early = [];
      for (const frame of early) this.onMessage(frame);
    } else if (event === 'close') this.onClose = cb as () => void;
    return this;
  }

  get readyState(): number {
    return this.closed ? 3 : this.raw.readyState;
  }

  get bufferedAmount(): number {
    return this.raw.bufferedAmount;
  }

  // --- the gate ----------------------------------------------------------

  private forward(frame: string): void {
    if (this.onMessage) this.onMessage(frame);
    else if (!this.closed) this.early.push(frame);
  }

  /** Send in the clear. Only for the handshake itself, which has no key yet. */
  private sendPlain(msg: ServerMessage): void {
    this.raw.send(JSON.stringify(msg));
  }

  private refuse(reason: string): void {
    console.warn(`[e2ee] refusing channel: ${reason}`);
    this.sendPlain({ type: 'e2eeError', reason });
    // 1008, the same code the bridge uses for an unverified direct socket: the
    // client's reconnect path already treats it as "check your credentials"
    // rather than as a blip to hammer.
    this.close(1008, 'unauthorized');
  }

  private async handleFrame(frame: unknown): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(frame)) as ClientMessage;
    } catch {
      return;
    }

    // One handshake per channel, and no enrolment once one has begun. A second
    // hello would replace the session under a channel the bridge already holds:
    // on a guest channel, which takes any client key, that is the relay swapping
    // itself in as the admitted guest, with the guest's grant and none of their
    // keys. Refused like any other attempt to author traffic.
    if (
      (msg.type === 'e2eeHello' || msg.type === 'e2eeConfirm' || msg.type === 'e2eeEnroll') &&
      (this.session || (this.handshake && msg.type !== 'e2eeConfirm'))
    ) {
      return this.refuse('a second handshake on one channel');
    }

    switch (msg.type) {
      case 'e2eeHello': {
        // The pin check lives inside `acceptHandshake`, which refuses a key this
        // machine has not enrolled before deriving anything from it. A guest's
        // browser key is never on that list and is not meant to be: the guest
        // checks *our* key against the one in their invite link, which is what
        // keeps the relay out of the middle, and what admits them is the grant
        // they must present next, sealed. Their key alone opens nothing.
        this.handshake = await acceptHandshake(this.identity, msg.offer, (key) =>
          this.guest ? true : this.policy.isEnrolled(key),
        );
        this.sendPlain({ type: 'e2eeAccept', accept: this.handshake.accept });
        return;
      }
      case 'e2eeConfirm': {
        if (!this.handshake) return this.refuse('confirm without an offer');
        // Opening this proves the peer holds the private half of the key it
        // offered. Until it does, an offer is just a public key anyone could copy.
        this.session = await this.handshake.finish(msg.confirm);
        this.handshake = null;
        if (!this.guest) this.policy.touch(this.session.peerPublicKey);
        console.log(
          `[e2ee] channel authenticated as ${this.session.peerPublicKey.slice(0, 12)}…${this.guest ? ' (guest, awaiting grant)' : ''}`,
        );
        // Sent in the clear on purpose: it carries only our public key, which is
        // public, and it is what lets the client notice a bridge that answered
        // with a key other than the one it pinned.
        this.sendPlain({ type: 'e2eeReady', bridgeKey: this.identity.publicKey });
        // The first handover for an owner channel. A guest's waits for the grant,
        // which must be the first sealed frame (see e2eeData).
        if (!this.guest) this.handOver(this.session.peerPublicKey, []);
        return;
      }
      case 'e2eeEnroll': {
        // Enrolling adds an *owner* device. Whatever code a guest holds, a channel
        // the relay labelled a guest's is not where that happens.
        if (this.guest) return this.refuse('a guest cannot enrol a device on this machine');
        const result = await this.policy.enroll(this.identity, msg.clientKey, msg.proof);
        if ('error' in result) {
          // Not `refuse`: a mistyped code is a retry, not a hostile channel, and
          // closing the socket would make the user re-open the whole page.
          this.sendPlain({ type: 'e2eeError', reason: result.error });
          return;
        }
        console.log('[e2ee] enrolled a new device key');
        this.sendPlain({ type: 'e2eeEnrolled', bridgeKey: this.identity.publicKey, proof: result.proof });
        return;
      }
      case 'e2eeData': {
        if (!this.session) return this.refuse('encrypted frame before the handshake');
        // A failure here is a forged, replayed or reordered frame — the relay
        // trying to author traffic. It is not recoverable and must not be
        // ignored: the counter check is only protection if a violation ends the
        // channel rather than skipping one message.
        const plaintext = await this.session.open({ n: msg.n, d: msg.d });
        if (this.guest && !this.handedOver) return this.admitGuest(this.session.peerPublicKey, plaintext);
        this.forward(plaintext);
        return;
      }
      default: {
        // Plaintext app traffic, refused on every relay channel: an owner's is
        // end-to-end encrypted whether or not anything is enrolled, and a guest's
        // is too, against the key in their invite link. The frame type is named on
        // purpose: a bare "requires encryption" says nothing about which client,
        // or which of its writers, skipped the seal, and that is the one thing you
        // need to fix it.
        if (this.guest) return this.refuse(`${GUEST_NEEDS_LINK} (got a plaintext '${msg.type}' frame)`);
        return this.refuse(
          `this machine requires an end-to-end encrypted channel (got a plaintext '${msg.type}' frame)`,
        );
      }
    }
  }

  /**
   * A guest's first sealed frame: their grants, and nothing else. Each token is
   * redeemed against what this machine minted for the user the relay says is
   * calling; one that does not redeem is skipped (a share since revoked), but
   * with none left — or another frame first — the channel ends before the
   * bridge ever sees it.
   */
  private admitGuest(peerKey: PublicKeyB64, plaintext: string): void {
    let first: { type?: unknown; tokens?: unknown };
    try {
      first = JSON.parse(plaintext) as typeof first;
    } catch {
      return this.refuse(GUEST_NEEDS_LINK);
    }
    if (first?.type !== 'guestGrant' || !Array.isArray(first.tokens)) return this.refuse(GUEST_NEEDS_LINK);
    const grants = first.tokens
      .slice(0, MAX_GRANT_TOKENS)
      .filter((t): t is string => typeof t === 'string')
      .map((token) => this.policy.redeemGuest(token, this.guest!.userId))
      .filter((g): g is GuestGrantRecord => g !== null);
    // One machine has one host, so grants for two are not something this bridge
    // ever minted for one channel.
    if (!grants.length || grants.some((g) => g.hostUserId !== grants[0].hostUserId)) {
      return this.refuse(
        'this invite link is not valid on this machine any more — ask its owner for a new one',
      );
    }
    console.log(
      `[e2ee] guest ${this.guest!.userId} admitted on ${grants.length} grant(s): ${grants.map((g) => g.id.slice(0, 8)).join(', ')}`,
    );
    this.handOver(peerKey, grants);
  }

}

/**
 * Wrap a relay channel, and call `onReady` when — and only when — it may carry
 * app traffic.
 *
 * Every channel authenticates first, from the machine's first launch. An
 * owner's against a key this machine pinned: with nothing enrolled, the only
 * thing an owner channel can do is enrol. A guest's (`guest` set — the relay's
 * word that this is one, and who) against the machine key from their invite
 * link, and then with a grant this machine minted, presented sealed: the relay's
 * word picks which check applies and can no longer stand in for either.
 *
 * What remains relay-attested for a guest is narrowing only — their access is
 * the grant intersected with what the relay says storage holds today (see
 * guestGrants.ts) — and their identity for attribution: the token proves they
 * hold the link, not which account they signed in with.
 */
export function guardRelayChannel(
  raw: BrowserLink,
  identity: Identity,
  guest: { userId: string } | null,
  onReady: (link: BrowserLink, peerKey: PublicKeyB64, grants: GuestGrantRecord[]) => void,
  policy: ChannelPolicy = filePolicy,
): void {
  new SecureChannel(raw, identity, guest, policy, onReady);
}
