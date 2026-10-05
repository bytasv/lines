/**
 * What a resumed tab should do with a link it already holds.
 *
 * A backgrounded tab is throttled: timers run late or not at all, and a socket
 * the OS tore down while the tab slept is only noticed by the heartbeat, which
 * needs a full pong timeout (plus a retry delay) to get there. Worse, the
 * heartbeat's own stall guard re-baselines `lastPongAt` whenever a tick runs
 * late — correct for a blocked render, and exactly wrong here, because the first
 * tick after a resume is *always* late. So the wake path cannot reuse the
 * heartbeat's liveness test; it takes its own timestamp before it pings and
 * judges the answer against that.
 *
 * Pure and dependency-free on purpose: this is the part worth testing, and the
 * `web` workspace has no test runner (see server/src/wakeRedial.test.ts).
 */

/** Collapses the `visibilitychange` + `pageshow` double-fire, and rapid tab flicking. */
export const WAKE_DEBOUNCE_MS = 1000;
/** How long a wake probe waits for its pong before the link is declared dead. */
export const WAKE_PROBE_TIMEOUT_MS = 2500;

// Mirrors the WebSocket readyState constants. Inlined rather than read off the
// global so this module can be imported by a Node test with no DOM.
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Just enough of a link to decide, so the decision is testable without a socket. */
export type LinkProbeState = {
  readyState: number;
  /** When the current wake probe's ping went out, or null if none is in flight. */
  awaitingProbeSince: number | null;
  lastPongAt: number;
};

/** True when this wake event is far enough from the last one to act on. */
export function wakeDebounced(lastWakeAt: number, now: number): boolean {
  return now - lastWakeAt < WAKE_DEBOUNCE_MS;
}

/**
 * Whether a probe in flight has gone unanswered long enough to call it dead.
 *
 * The comparison is against the probe's own stamp, not against
 * `PONG_TIMEOUT_MS`: the heartbeat writes `lastPongAt = now` when it detects a
 * stall, so a naive "how long since the last pong" check is satisfied by a
 * socket that has answered nothing at all.
 */
export function probeExpired(s: LinkProbeState, now: number): boolean {
  if (s.awaitingProbeSince === null) return false;
  if (s.lastPongAt >= s.awaitingProbeSince) return false; // the probe was answered
  return now - s.awaitingProbeSince >= WAKE_PROBE_TIMEOUT_MS;
}

/**
 * What to do with one link on wake.
 *
 * `probe` rather than `redial` for an open socket is the whole point: a healthy
 * link is the common case, and closing it to find out would cost every resumed
 * tab a reconnect and a fresh `hello`.
 */
export function wakeAction(s: LinkProbeState, now: number): 'redial' | 'probe' | 'none' {
  if (s.readyState === CLOSED || s.readyState === CLOSING) return 'redial';
  if (s.readyState !== OPEN) return 'none'; // CONNECTING: already on its way
  if (s.awaitingProbeSince !== null) return probeExpired(s, now) ? 'redial' : 'none';
  return 'probe';
}

/**
 * Whether a link holding no socket should be dialled on wake.
 *
 * Only the primary: a non-primary link with no socket was idle-disconnected on
 * purpose (IDLE_DISCONNECT_MS). The primary is never idle-disconnected, so no
 * socket there means a connect that never got as far as creating one — the
 * stuck-spinner case — and nothing else will ever retry it.
 */
export function shouldReviveIdle(s: {
  isPrimary: boolean;
  hasSocket: boolean;
  retryPending: boolean;
  connecting: boolean;
}): boolean {
  return s.isPrimary && !s.hasSocket && !s.retryPending && !s.connecting;
}

/**
 * Whether boot can dial the remembered machine before the device list lands, and
 * whether an already-dialled one has to be dropped once it does.
 *
 * The dial is free latency: the remembered id is a localStorage read, while the
 * list is a network round trip that the socket would otherwise queue behind.
 *
 * The drop is the safety half. `chooseDevice` falls back to the most recently
 * seen machine when the remembered one is gone, so an optimistic link can end up
 * pointed at a revoked machine while the gate settles on a different one — and
 * every 1008 retry re-reads the device list, which is a refresh loop nobody
 * asked for.
 */
export function bootDial(
  remembered: string | null,
  devices: { id: string }[] | null,
  dialed: string | null,
): { dial: string | null; drop: string | null } {
  if (devices === null) {
    // Still in flight: dial the remembered machine, once.
    return { dial: remembered && !dialed ? remembered : null, drop: null };
  }
  // The list is authoritative now, and the gate's own effect owns the choice
  // from here — all this can still do is take back a guess that was wrong.
  if (dialed && !devices.some((d) => d.id === dialed)) return { dial: null, drop: dialed };
  return { dial: null, drop: null };
}

/**
 * How long the link may read `reconnecting` before the red transport pill shows.
 *
 * A resumed PWA almost always redials — iOS kills the sockets of suspended
 * apps — and that redial is RECONNECT_DELAY_MS (1.5s) plus a token mint and a
 * dial. Without a grace every resume flashed "Disconnected" for a second or
 * two. The probe-expired path spends its WAKE_PROBE_TIMEOUT_MS while the status
 * still reads `connected`, so that wait does not count against this.
 */
export const DISCONNECT_BANNER_GRACE_MS = 3000;

/**
 * Whether the transport pill should be visible.
 *
 * Display-only: `connectionStatus` itself is untouched, so everything else that
 * reads it still reacts at once. `offline` skips the grace — `navigator.onLine`
 * said so, which is real and actionable rather than a flap.
 */
export function showDisconnectBanner(s: {
  status: 'connected' | 'reconnecting' | 'offline';
  /** When the status left `connected`, or null while it is `connected`. */
  downSince: number | null;
  now: number;
}): boolean {
  if (s.status === 'connected') return false;
  if (s.status === 'offline') return true;
  return s.downSince !== null && s.now - s.downSince >= DISCONNECT_BANNER_GRACE_MS;
}
