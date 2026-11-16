/**
 * Per-machine connect refusals, and how a refused link backs off.
 *
 * Pure, so the server's runner can test it (server/src/connectRefusal.test.ts).
 */

/** Why one machine refused this browser's channel. */
export interface ConnectRefusal {
  deviceId: string;
  reason: string;
}

/**
 * The refusal reason that belongs to `deviceId`, or null.
 *
 * A refusal belongs to the machine that sent it. The window holds links to
 * several machines at once, and a secondary one refusing (a shared machine with
 * no invite grant, say) used to put the enroll form on the connecting screen of
 * a different machine — one this browser was already enrolled with.
 */
export function refusalFor(refusal: ConnectRefusal | null, deviceId: string): string | null {
  return refusal?.deviceId === deviceId ? refusal.reason : null;
}

/**
 * The refusal left after clearing `deviceId`'s: another machine's stays put.
 */
export function clearRefusalFor(refusal: ConnectRefusal | null, deviceId: string): ConnectRefusal | null {
  return refusal?.deviceId === deviceId ? null : refusal;
}

export const REFUSED_RETRY_BASE_MS = 1_500;
export const REFUSED_RETRY_CAP_MS = 5 * 60_000;

/**
 * Re-dial delay for a link refused for a reason waiting cannot fix.
 *
 * `refusals` counts consecutive refusals (1 for the first). Doubles from the
 * ordinary reconnect delay up to five minutes, instead of retrying a refusal
 * every 1.5s forever.
 */
export function refusedReconnectDelay(refusals: number): number {
  const n = Math.max(1, Math.floor(refusals));
  return Math.min(REFUSED_RETRY_CAP_MS, REFUSED_RETRY_BASE_MS * 2 ** Math.min(n - 1, 20));
}
