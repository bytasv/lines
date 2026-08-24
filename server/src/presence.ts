import type { PresenceViewer, ShareProfile } from '@lines/shared';

/**
 * Who is watching which session, in memory, on the host.
 *
 * Deliberately ephemeral and bridge-local. Every viewer of a session — the owner
 * and every guest — attaches to the same host `UserContext`, so presence needs no
 * relay and no storage support: the people who should see it are exactly the
 * sockets already on this context.
 *
 * Nothing here is ever persisted. Presence must not touch `SessionMeta`: that
 * blob syncs to Postgres, and a focus toggle riding an `upsert()` would restamp
 * `updatedAt` and write a row per event.
 *
 * Keyed by connection, not by user, so two tabs of the same person are two
 * entries — closing one must not make them vanish from the other.
 */
export class PresenceTracker {
  private bySession = new Map<string, Map<string, PresenceViewer>>();

  /**
   * Record a signal. Returns the sessions whose viewer list actually changed, so
   * the caller broadcasts only for those — a repeated identical heartbeat costs
   * nothing.
   *
   * A connection can only ever be in one session at a time, so signalling for a
   * new one removes it from the previous: without that, clicking through ten
   * sessions would leave a trail of ghost viewers behind.
   */
  signal(
    input: {
      sessionId: string;
      connId: string;
      userId: string;
      profile: ShareProfile | null;
      viewing: boolean;
      focused: boolean;
    },
    now: number = Date.now(),
  ): string[] {
    const changed = new Set<string>();
    for (const sessionId of this.sessionsOf(input.connId)) {
      if (sessionId !== input.sessionId) {
        this.bySession.get(sessionId)?.delete(input.connId);
        changed.add(sessionId);
      }
    }

    if (!input.viewing) {
      // Left the session (navigated away, closed the tab's view of it).
      if (this.bySession.get(input.sessionId)?.delete(input.connId)) changed.add(input.sessionId);
      this.prune(input.sessionId);
      return [...changed];
    }

    const viewers = this.bySession.get(input.sessionId) ?? new Map<string, PresenceViewer>();
    const before = viewers.get(input.connId);
    viewers.set(input.connId, {
      userId: input.userId,
      connId: input.connId,
      profile: input.profile,
      viewing: true,
      focused: input.focused,
      lastSeenAt: now,
    });
    this.bySession.set(input.sessionId, viewers);
    // lastSeenAt alone is not a change worth a broadcast — only who is here and
    // whether they are focused.
    if (!before || before.focused !== input.focused) changed.add(input.sessionId);
    return [...changed];
  }

  /** A connection went away. Returns the sessions that need a fresh broadcast. */
  drop(connId: string): string[] {
    const changed: string[] = [];
    for (const sessionId of this.sessionsOf(connId)) {
      this.bySession.get(sessionId)?.delete(connId);
      this.prune(sessionId);
      changed.push(sessionId);
    }
    return changed;
  }

  viewers(sessionId: string): PresenceViewer[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])];
  }

  private sessionsOf(connId: string): string[] {
    const out: string[] = [];
    for (const [sessionId, viewers] of this.bySession) {
      if (viewers.has(connId)) out.push(sessionId);
    }
    return out;
  }

  private prune(sessionId: string): void {
    if (this.bySession.get(sessionId)?.size === 0) this.bySession.delete(sessionId);
  }
}
