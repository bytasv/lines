/**
 * Whether a machine's relay-reported `online` flag may be believed.
 *
 * `Device.online` is written only by the relay, on hub attach and detach. That
 * makes it accurate while the relay is healthy and permanently wrong if it is
 * not: a crash between attach and detach leaves every machine that was up at the
 * time reading online forever, and a UI that confidently points at dead machines
 * is worse than one that admits it does not know.
 *
 * `lastSeenAt` is the mitigation. The relay refreshes it on every device
 * re-verify (RELAY_REVERIFY_MS, 300s by default) for as long as a bridge stays
 * attached, so a stale timestamp means nothing has re-verified this machine in
 * that window — whatever the flag says. Two re-verify periods of slack, so an
 * ordinary late sweep does not flap a live machine to unknown.
 */
export const DEVICE_PRESENCE_TTL_MS = Number(process.env.DEVICE_PRESENCE_TTL_MS ?? 600_000);

/** The flag, gated on freshness. Never expose the raw column to a client. */
export function presenceOf(
  device: { online: boolean; lastSeenAt: Date | null },
  now: number = Date.now(),
): boolean {
  if (!device.online) return false;
  if (!device.lastSeenAt) return false;
  return now - device.lastSeenAt.getTime() <= DEVICE_PRESENCE_TTL_MS;
}
