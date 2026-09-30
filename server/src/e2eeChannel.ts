/**
 * The bridge side of the encrypted channel, and the gate in front of it.
 *
 * A relay channel arrives with an identity the relay *asserted*. Until this
 * module existed the bridge simply believed it — `handleConnection` took
 * `attested.userId` and granted owner access, so anyone who controlled the relay
 * process could open a channel as any user and drive an agent. That is the hole
 * this closes: a channel that carries no key the machine has pinned locally does
 * not become an owner connection, whatever the relay says about it.
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
}

/** The real policy: the three 0600 files under `~/.lines-app`. Injectable so the
 *  adversarial harness can drive this without a home directory. */
export const filePolicy: ChannelPolicy = {
  isEnrolled: (key) => isEnrolled(key),
  enroll: (identity, clientKey, proof) => enrollPeer(identity, clientKey, proof, 'browser'),
  touch: (key) => touchPeer(key),
};

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

  constructor(
    private raw: BrowserLink,
    private identity: Identity,
    private required: boolean,
    private policy: ChannelPolicy,
    /** Called once the channel may carry app traffic. */
    private onReady: (link: BrowserLink, peerKey: PublicKeyB64 | null) => void,
  ) {
    this.raw.on('message', (frame) => {
      void this.handleFrame(frame).catch((err) => {
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
    // The bridge speaks first: `handleConnection` sends `hello` the moment it is
    // given a channel, and the browser waits for it. So a channel that does not
    // have to authenticate — only a guest's, which has no key to offer — is
    // handed over straight away; anything else deadlocks, each side waiting for
    // the other's first frame. An owner channel is always required, so it
    // reaches the bridge only after the handshake below.
    if (!this.required) this.handOver(null);
  }

  /** Give the bridge this channel, exactly once. */
  private handOver(peerKey: PublicKeyB64 | null): void {
    if (this.handedOver) return;
    this.handedOver = true;
    this.onReady(this, peerKey);
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

    switch (msg.type) {
      case 'e2eeHello': {
        // The pin check lives inside `acceptHandshake`, which refuses a key this
        // machine has not enrolled before deriving anything from it.
        this.handshake = await acceptHandshake(this.identity, msg.offer, (key) => this.policy.isEnrolled(key));
        this.sendPlain({ type: 'e2eeAccept', accept: this.handshake.accept });
        return;
      }
      case 'e2eeConfirm': {
        if (!this.handshake) return this.refuse('confirm without an offer');
        // Opening this proves the peer holds the private half of the pinned key.
        // Until it does, an offer is just a public key anyone could copy.
        this.session = await this.handshake.finish(msg.confirm);
        this.handshake = null;
        this.policy.touch(this.session.peerPublicKey);
        console.log(`[e2ee] channel authenticated as ${this.session.peerPublicKey.slice(0, 12)}…`);
        // Sent in the clear on purpose: it carries only our public key, which is
        // public, and it is what lets the client notice a bridge that answered
        // with a key other than the one it pinned.
        this.sendPlain({ type: 'e2eeReady', bridgeKey: this.identity.publicKey });
        // The first handover for an owner channel. Were this ever a channel the
        // bridge already held, it would only upgrade it in place — every later
        // frame is sealed either way.
        this.handOver(this.session.peerPublicKey);
        return;
      }
      case 'e2eeEnroll': {
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
        this.forward(await this.session.open({ n: msg.n, d: msg.d }));
        return;
      }
      default: {
        // Plaintext app traffic. Permitted only on a guest channel, which has no
        // key to present; an owner channel is always end-to-end encrypted, and a
        // plaintext frame on one is refused, whether or not anything is enrolled.
        // The frame type is named on purpose: a bare "requires encryption" says
        // nothing about which client, or which of its writers, skipped the seal,
        // and that is the one thing you need to fix it.
        if (this.required) {
          return this.refuse(
            `this machine requires an end-to-end encrypted channel (got a plaintext '${msg.type}' frame)`,
          );
        }
        this.forward(String(frame));
      }
    }
  }

}

/**
 * Wrap a relay channel, and call `onReady` when — and only when — it may carry
 * app traffic.
 *
 * Owner channels must always authenticate first, from the machine's first
 * launch: with nothing enrolled, the only thing an owner channel can do is
 * enrol. Guest channels are unchanged: v1 enrolls owner devices only, so a guest has no
 * key to present, and their identity stays as relay-forgeable as it is today.
 * That gap is real and is written down rather than papered over.
 */
export function guardRelayChannel(
  raw: BrowserLink,
  identity: Identity,
  isGuest: boolean,
  onReady: (link: BrowserLink, peerKey: PublicKeyB64 | null) => void,
  policy: ChannelPolicy = filePolicy,
): void {
  const required = !isGuest;
  new SecureChannel(raw, identity, required, policy, onReady);
}
