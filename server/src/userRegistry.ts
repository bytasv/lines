import type { ServerMessage } from '@claude-ui/shared';
import type { LiveSessionInfo } from './workerProtocol.ts';
import type { WorkerClient } from './workerClient.ts';
import { buildUserContext, type UserContext } from './userContext.ts';

/**
 * Lazily-built map of userId → UserContext plus the server-built session
 * ownership index that routes worker callbacks to the owning context.
 *
 * Sessions the bridge has never seen (or that predate ownership tracking)
 * fall back to `defaultUserId` — with the auth gate off everything runs as
 * the implicit 'local' user, which is exactly the old single-tenant behavior.
 */
export class UserRegistry {
  private contexts = new Map<string, UserContext>();
  private sessionOwner = new Map<string, string>();
  /** Worker's live sessions from its last hello, kept so a context built later can reconcile its slice. */
  private lastWorkerLive: LiveSessionInfo[] | null = null;

  constructor(
    private worker: WorkerClient,
    private storeRootFor: (userId: string) => string,
    private defaultUserId: string,
  ) {}

  get(userId: string): UserContext {
    let ctx = this.contexts.get(userId);
    if (!ctx) {
      ctx = buildUserContext(userId, this.storeRootFor(userId), this.worker, (msg) =>
        this.observe(userId, msg),
      );
      this.contexts.set(userId, ctx);
      // Everything already persisted in this user's store is theirs.
      for (const meta of ctx.sessions.list()) this.sessionOwner.set(meta.id, userId);
      // The worker may have said hello before this context existed.
      if (this.lastWorkerLive) ctx.sessions.reconcileWithWorker(this.sliceFor(userId));
    }
    ctx.touchedAt = Date.now();
    return ctx;
  }

  /** Route a worker callback to the context owning the session. */
  forSession(sessionId: string): UserContext {
    return this.get(this.sessionOwner.get(sessionId) ?? this.defaultUserId);
  }

  /**
   * Pre-populate ownership without building contexts (boot-time scan of the
   * per-user stores), so worker events for a not-yet-connected user's live
   * sessions route to their context instead of the default fallback.
   */
  seedOwnership(sessionId: string, userId: string) {
    if (!this.sessionOwner.has(sessionId)) this.sessionOwner.set(sessionId, userId);
  }

  all(): Iterable<UserContext> {
    return this.contexts.values();
  }

  /** Worker (re)connected: cache its live view and re-partition it across contexts. */
  onWorkerLive(live: LiveSessionInfo[]) {
    this.lastWorkerLive = live;
    for (const ctx of this.contexts.values()) {
      ctx.sessions.reconcileWithWorker(this.sliceFor(ctx.userId));
    }
  }

  /** Keep the ownership index current from each context's own broadcasts. */
  private observe(userId: string, msg: ServerMessage) {
    if (msg.type === 'sessionUpsert') this.sessionOwner.set(msg.session.id, userId);
    else if (msg.type === 'sessionDeleted') this.sessionOwner.delete(msg.sessionId);
  }

  private sliceFor(userId: string): LiveSessionInfo[] {
    return (this.lastWorkerLive ?? []).filter(
      (l) => (this.sessionOwner.get(l.sessionId) ?? this.defaultUserId) === userId,
    );
  }
}
