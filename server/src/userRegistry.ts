import type { ServerMessage } from '@lines/shared';
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
/**
 * Delay before re-pulling shared workflows after a user's workflow change.
 * Longer than the sync client's push debounce (2s) so the storage server has
 * already stored the published change by the time other contexts re-pull it.
 */
const SHARED_REFRESH_DELAY_MS = 3_000;

export class UserRegistry {
  private contexts = new Map<string, UserContext>();
  private sessionOwner = new Map<string, string>();
  /** Per-context debounce timers coalescing a burst of workflow changes into one re-pull. */
  private sharedRefreshTimers = new Map<string, NodeJS.Timeout>();
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
    // A user saved/published/deleted a workflow or step: their published set may
    // have changed, so every other live context re-pulls its shared view.
    else if (msg.type === 'workflows') this.fanoutSharedRefresh(userId, 'wf', (ctx) => ctx.refreshShared());
    else if (msg.type === 'steps') this.fanoutSharedRefresh(userId, 'step', (ctx) => ctx.refreshSharedSteps());
  }

  /** Schedule a debounced shared re-pull on every context except the source. */
  private fanoutSharedRefresh(sourceUserId: string, tag: string, refresh: (ctx: UserContext) => Promise<void>) {
    for (const [otherId, ctx] of this.contexts) {
      if (otherId === sourceUserId) continue;
      const key = `${otherId}:${tag}`;
      clearTimeout(this.sharedRefreshTimers.get(key));
      const timer = setTimeout(() => {
        this.sharedRefreshTimers.delete(key);
        void refresh(ctx);
      }, SHARED_REFRESH_DELAY_MS);
      timer.unref?.();
      this.sharedRefreshTimers.set(key, timer);
    }
  }

  private sliceFor(userId: string): LiveSessionInfo[] {
    return (this.lastWorkerLive ?? []).filter(
      (l) => (this.sessionOwner.get(l.sessionId) ?? this.defaultUserId) === userId,
    );
  }
}
