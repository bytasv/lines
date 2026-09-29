import type { PushSubscriptionJson, VapidKeyPair } from '@lines/shared';

/**
 * Web Push plumbing: the push-only service worker (`public/sw.js`), and this
 * device's subscription.
 *
 * The device mints its own VAPID keypair rather than taking one from a bridge.
 * One browser registration holds one subscription, tied to one application
 * server key — so with several machines, every bridge has to sign with the same
 * key, and the only party common to all of them is this device.
 */

const VAPID_KEY = 'lines.pushVapid';

/** Whether this browser can do Web Push at all (iOS: only from the home screen). */
export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window
  );
}

/**
 * Register `sw.js` once, at boot, and route its `openSession` messages (a
 * notification click on an already-open window) to `onOpenSession`.
 */
export function registerServiceWorker(onOpenSession: (sessionId: string) => void): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: string; sessionId?: unknown } | null;
    if (data?.type === 'openSession' && typeof data.sessionId === 'string') onOpenSession(data.sessionId);
  });
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
    console.warn('[push] service worker registration failed', err);
  });
}

/** The active registration, or null without waiting when there is none. */
export async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration('/')) ?? null;
  } catch {
    return null;
  }
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/**
 * This device's VAPID keypair, minted with WebCrypto on first use and kept in
 * localStorage. Public key: the raw uncompressed P-256 point; private key: the
 * JWK `d` scalar — both base64url, the encoding web-push expects.
 */
export async function getVapidKeys(): Promise<VapidKeyPair> {
  const raw = localStorage.getItem(VAPID_KEY);
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Partial<VapidKeyPair>;
      if (typeof keys.publicKey === 'string' && typeof keys.privateKey === 'string') {
        return { publicKey: keys.publicKey, privateKey: keys.privateKey };
      }
    } catch {
      // corrupt — mint a fresh pair below
    }
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const keys: VapidKeyPair = { publicKey, privateKey: jwk.d! };
  localStorage.setItem(VAPID_KEY, JSON.stringify(keys));
  return keys;
}

function toJson(sub: PushSubscription): PushSubscriptionJson | null {
  const json = sub.toJSON();
  const { p256dh, auth } = json.keys ?? {};
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

const sameKey = (a: ArrayBuffer | null, b: Uint8Array): boolean => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/**
 * This device's push subscription, created if needed. Null when push is
 * unsupported, permission is not granted, or the browser refuses.
 *
 * A subscription made under a different key (localStorage cleared, say) is
 * replaced: the bridges could not sign for it.
 */
export async function ensurePushSubscription(): Promise<
  { subscription: PushSubscriptionJson; vapid: VapidKeyPair } | null
> {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  try {
    // Bounded: `ready` never settles when registration failed, and this is
    // awaited from the Settings toggle.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no service worker')), 10_000)),
    ]);
    const vapid = await getVapidKeys();
    const key = fromB64url(vapid.publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const subscription = toJson(sub);
    return subscription ? { subscription, vapid } : null;
  } catch (err) {
    console.warn('[push] subscribe failed', err);
    return null;
  }
}

/** Drop this device's subscription; resolves to its endpoint, or null if there was none. */
export async function removePushSubscription(): Promise<string | null> {
  const reg = pushSupported() ? await serviceWorkerRegistration() : null;
  if (!reg) return null;
  try {
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return null;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    return endpoint;
  } catch {
    return null;
  }
}

/** Running on iOS/iPadOS, where push needs the home-screen app. */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  // iPadOS reports itself as a Mac; touch points tell it apart.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Launched from the home screen rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
