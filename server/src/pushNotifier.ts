/**
 * Web Push for session alerts: the bridge is the one piece of Lines that stays
 * awake while a phone has the app backgrounded (iOS suspends the page and its
 * socket), so it is the bridge that tells the push service to wake the device's
 * service worker.
 *
 * One per user, fed from that user's `broadcast` — the same place `sync` hooks
 * into — and holding its own last-seen status per session, because the session
 * manager mutates `SessionMeta` in place and the previous status is already gone
 * by the time the upsert is broadcast.
 *
 * Subscriptions are bridge-local and never synced: each device registers with
 * every machine it owns (see `registerPush`), so each bridge pushes for its own
 * sessions — the same "not scoped to the primary machine" rule as web `maybeAlert`.
 */
import webpush from 'web-push';
import { alertBody, isAlertTransition } from '@lines/shared';
import type {
  PushPayload,
  PushRegistration,
  PushSubscriptionJson,
  SessionMeta,
  SessionStatus,
  VapidKeyPair,
} from '@lines/shared';
import type { Store } from './store.ts';

/**
 * VAPID `sub` claim. Push services want a way to reach whoever operates the
 * sender; `mailto:` or `https:` both satisfy the spec, and Apple rejects neither.
 */
const VAPID_SUBJECT = process.env.LINES_PUSH_SUBJECT ?? 'https://github.com/bytasv/lines';

/** A push for a session that settled more than an hour ago is noise, not news. */
const PUSH_TTL_SECONDS = 3600;

/**
 * Hosts a subscription endpoint may point at. The bridge POSTs to whatever URL
 * the client hands it, so without this an owner link (or anything that can
 * impersonate one) could aim it at the bridge's own network. Suffix entries
 * match subdomains only.
 */
const PUSH_HOSTS = ['fcm.googleapis.com'];
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];

/** Is this a push-service endpoint the bridge is willing to POST to? */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // A push service never needs credentials or a non-default port in the URL.
  if (url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

/** Push-service status codes that mean the subscription is gone for good. */
const EXPIRED_STATUSES = new Set([404, 410]);

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Decoded byte length of a base64url string, or -1 when it is not one. */
function b64urlBytes(s: unknown): number {
  if (typeof s !== 'string' || !B64URL.test(s)) return -1;
  return Buffer.from(s, 'base64url').length;
}

/**
 * A registration the bridge can actually send with, or null. Everything comes
 * from the wire (or a hand-edited file), so shapes are checked rather than trusted.
 */
export function parseRegistration(raw: {
  subscription?: Partial<PushSubscriptionJson> | null;
  vapid?: Partial<VapidKeyPair> | null;
}): PushRegistration | null {
  const sub = raw.subscription;
  const vapid = raw.vapid;
  if (!sub || !vapid || typeof sub.endpoint !== 'string') return null;
  if (!isAllowedPushEndpoint(sub.endpoint)) return null;
  const keys = sub.keys;
  // p256dh is an uncompressed P-256 point, auth a 16-byte secret.
  if (!keys || b64urlBytes(keys.p256dh) !== 65 || b64urlBytes(keys.auth) !== 16) return null;
  // Same shapes web-push's own VAPID validation insists on.
  if (b64urlBytes(vapid.publicKey) !== 65 || b64urlBytes(vapid.privateKey) !== 32) return null;
  return {
    subscription: { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh!, auth: keys.auth! } },
    vapid: { publicKey: vapid.publicKey!, privateKey: vapid.privateKey! },
  };
}

/** Sends one push; injected so tests never reach the network. Rejects with a
 *  `statusCode` on an upstream refusal, as `webpush.sendNotification` does. */
export type PushSender = (reg: PushRegistration, payload: string) => Promise<unknown>;

const webPushSender: PushSender = (reg, payload) =>
  webpush.sendNotification(reg.subscription, payload, {
    vapidDetails: { subject: VAPID_SUBJECT, ...reg.vapid },
    TTL: PUSH_TTL_SECONDS,
  });

/** What gets pushed for this session, or null when its status alerts on nothing. */
export function pushPayload(session: SessionMeta): PushPayload | null {
  const body = alertBody(session);
  return body ? { sessionId: session.id, title: session.name, body } : null;
}

export class PushNotifier {
  private regs: PushRegistration[];
  private lastStatus = new Map<string, SessionStatus>();

  constructor(
    private store: Pick<Store, 'loadPushSubscriptions' | 'savePushSubscriptions'>,
    private send: PushSender = webPushSender,
  ) {
    this.regs = store
      .loadPushSubscriptions()
      .map((r) => parseRegistration(r))
      .filter((r): r is PushRegistration => r !== null);
  }

  /** Subscribed devices, for tests and diagnostics. */
  get registrations(): readonly PushRegistration[] {
    return this.regs;
  }

  /** Upsert by endpoint. False when the registration is malformed or its endpoint
   *  is not a known push service — the caller reports that, nothing is stored. */
  register(raw: Parameters<typeof parseRegistration>[0]): boolean {
    const reg = parseRegistration(raw);
    if (!reg) return false;
    const i = this.regs.findIndex((r) => r.subscription.endpoint === reg.subscription.endpoint);
    if (i >= 0) {
      const cur = this.regs[i];
      // The client resends on every hello; an identical row is not worth a write.
      if (JSON.stringify(cur) === JSON.stringify(reg)) return true;
      this.regs[i] = reg;
    } else {
      this.regs.push(reg);
    }
    this.save();
    return true;
  }

  unregister(endpoint: string): void {
    const next = this.regs.filter((r) => r.subscription.endpoint !== endpoint);
    if (next.length === this.regs.length) return;
    this.regs = next;
    this.save();
  }

  /**
   * Called for every `sessionUpsert` this bridge broadcasts about its own
   * sessions — never for sessions adopted from sync, which ran elsewhere and are
   * reset to idle here. Pushes on the same transitions web `maybeAlert` chimes on.
   */
  onSessionUpsert(session: SessionMeta): void {
    const prev = this.lastStatus.get(session.id);
    this.lastStatus.set(session.id, session.status);
    if (!this.regs.length || !isAlertTransition(prev, session)) return;
    const payload = pushPayload(session);
    if (!payload) return;
    void this.pushAll(JSON.stringify(payload));
  }

  /** A deleted session must not keep its status around to compare against. */
  forget(sessionId: string): void {
    this.lastStatus.delete(sessionId);
  }

  private async pushAll(payload: string): Promise<void> {
    await Promise.all(
      this.regs.map(async (reg) => {
        try {
          await this.send(reg, payload);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status != null && EXPIRED_STATUSES.has(status)) {
            // The device unsubscribed, or the push service expired it.
            this.unregister(reg.subscription.endpoint);
            return;
          }
          // The endpoint's host only: the path is the device's capability URL.
          console.warn(
            `[push] send to ${new URL(reg.subscription.endpoint).host} failed:`,
            status ?? (err as Error).message,
          );
        }
      }),
    );
  }

  private save(): void {
    this.store.savePushSubscriptions(this.regs);
  }
}
