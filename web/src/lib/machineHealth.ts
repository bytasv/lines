import type { StorageStatus, WorkerStatus } from '@lines/shared';

/**
 * "Is that machine alive" — answerable before typing a prompt into it.
 *
 * There are three distinct states and conflating them is the trap:
 *
 *  1. **Not linked** — this browser holds no socket to the machine. Only the
 *     relay's presence report (`Device.online`, gated on `lastSeenAt` freshness by
 *     storage) says anything, and once that goes stale the honest answer is "last
 *     seen 2h ago", not a liveness claim.
 *  2. **Linked, bridge not attached** — the relay is reachable but the machine is
 *     asleep, off, or the app is quit. The relay's `deviceOffline` control frame
 *     is the fact behind this one.
 *  3. **Bridge attached** — only then is sub-health meaningful: the agent worker
 *     and cloud sync. Both already broadcast on every transition, so this module
 *     just classifies what the store already holds.
 *
 * Pure and store-free on purpose, exactly as `format.ts` is: the callers differ
 * (the settings list reads HTTP rows, the composer reads socket state) and both
 * must reach the same verdict.
 */

export type MachineHealthState =
  /** Bridge attached and everything under it is working. */
  | 'online'
  /** Bridge attached, but something under it is not — turns may not run. */
  | 'degraded'
  /** Known not to have a bridge attached. */
  | 'offline'
  /** No socket and no fresh presence report. Say when it was last seen instead. */
  | 'unknown';

export interface MachineHealth {
  state: MachineHealthState;
  /** Mantine colour for the dot. */
  color: string;
  /** Short label for a badge or a tooltip. */
  label: string;
  /**
   * Why a prompt must not be typed against this machine right now, or null when
   * it may. Non-null is what disables a composer *with a reason* — a prompt sent
   * to a machine that cannot run it is dropped by the relay in silence.
   */
  block: string | null;
}

/**
 * Client-side half of storage's freshness gate. Storage already refuses to
 * report `online` on a stale row; this covers the other staleness, where the
 * device list itself was fetched minutes ago and has sat in memory since.
 */
const PRESENCE_TTL_MS = 600_000;

/** Health of a machine this browser holds a live socket to. */
export function linkedMachineHealth(input: {
  /** The relay says a bridge is attached (i.e. not `deviceOffline`). */
  bridgeAttached: boolean;
  worker: WorkerStatus | null;
  storage: StorageStatus | null;
}): MachineHealth {
  if (!input.bridgeAttached) {
    return {
      state: 'offline',
      color: 'red',
      label: 'offline',
      block: 'This session’s machine is offline — start Lines on it to send this.',
    };
  }
  const { worker, storage } = input;
  if (worker?.connected === false) {
    return {
      state: 'degraded',
      color: 'orange',
      label: worker.mismatch ? 'worker version mismatch' : 'worker not responding',
      block: worker.mismatch
        ? `Agent worker speaks v${worker.mismatch.worker}, bridge speaks v${worker.mismatch.bridge} — restart the bridge to send this.`
        : 'The agent worker on this session’s machine isn’t responding — nothing can run there yet.',
    };
  }
  // Sync being down never blocks: turns still run, only cloud state lags. Same
  // precedence the banners use, where storage sits below worker.
  if (storage && storage.available === false) {
    return { state: 'degraded', color: 'yellow', label: 'sync unavailable', block: null };
  }
  return { state: 'online', color: 'green', label: 'online', block: null };
}

/**
 * Health of a machine this browser has no socket to, from the relay's presence
 * report. There is no sub-health here — the relay knows whether a bridge is
 * attached and nothing more — and a stale report is 'unknown', never 'online'.
 */
export function unlinkedMachineHealth(
  device: { online: boolean; lastSeenAt: string | null },
  now: number = Date.now(),
): MachineHealth {
  const seenMs = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : null;
  const fresh = seenMs !== null && now - seenMs <= PRESENCE_TTL_MS;
  if (!fresh) {
    return {
      state: 'unknown',
      color: 'gray',
      label: lastSeenLabel(device.lastSeenAt, now),
      block: null,
    };
  }
  return device.online
    ? { state: 'online', color: 'green', label: 'online', block: null }
    : { state: 'offline', color: 'red', label: 'offline', block: null };
}

/** Relative, because the exact timestamp of a heartbeat is never what you want to know. */
export function lastSeenLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never connected';
  const ms = now - new Date(iso).getTime();
  if (ms < 120_000) return 'seen just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `seen ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `seen ${hours}h ago`;
  return `seen ${Math.round(hours / 24)}d ago`;
}
