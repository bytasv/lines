import type { ServerMessage, UserUiSettings } from '@lines/shared';
import { projectRoots } from '@lines/shared';
import { createStore, type Store } from './store.ts';
import { AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { UsagePoller } from './usage.ts';
import { WorkflowEngine } from './workflows.ts';
import { RecipeEngine } from './recipes.ts';
import { StorageSyncClient, THROTTLED } from './sync.ts';
import { ProjectKeyRegistry } from './projectKeys.ts';
import { MemorySyncer } from './memory.ts';
import type { WorkerClient } from './workerClient.ts';

const STORAGE_URL = process.env.STORAGE_URL ?? 'http://localhost:8790';

/**
 * The whole surface the bridge uses on a browser connection — structural, not
 * `ws.WebSocket`, so a connection can arrive over something other than a direct
 * socket (a relay channel) and still be handed to the same `handleConnection`.
 * A real `ws.WebSocket` satisfies this as-is.
 *
 * Keep it to what the bridge genuinely calls. Every addition is one more thing
 * an alternative transport has to implement.
 */
export interface BrowserLink {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Drop without a close handshake; used only by the shutdown path. */
  terminate(): void;
  on(event: 'message', cb: (raw: unknown) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  /** Compared against OPEN (1) numerically, so no ws constant is needed.
   *  `close()` must move this off OPEN synchronously — broadcast relies on it to
   *  avoid closing the same slow link on every subsequent message. */
  readonly readyState: number;
  /** Bytes queued but not yet flushed to the peer — the backpressure signal
   *  broadcast() uses. An implementation with no queue may report 0. */
  readonly bufferedAmount: number;
}

/** `WebSocket.OPEN`, inlined so BrowserLink implementations need no ws import. */
export const LINK_OPEN = 1;

/**
 * Backpressure thresholds for the broadcast fan-out, mirroring the worker's
 * OUTBOX_CAP policy at the other end of the pipe.
 *
 * `ws.send()` buffers without limit. On loopback the socket drains instantly, so
 * nothing ever queued and these never trip; over a relay a suspended laptop makes
 * bridge memory climb without bound. Deliberately generous — normal use must
 * never reach them.
 */
const SEND_HIGH_WATER = 4 * 1024 * 1024;
const SEND_HARD_LIMIT = 32 * 1024 * 1024;

/**
 * Stream deltas are the only droppable traffic: they are never persisted, and
 * the browser refetches the transcript on reconnect, so losing one costs a
 * partially-typed token — not state. Exactly the worker's rule in worker.ts.
 */
function isDroppable(msg: ServerMessage): boolean {
  return (
    msg.type === 'event' &&
    msg.event.kind === 'sdk' &&
    (msg.event.data as { type?: string } | null)?.type === 'stream_event'
  );
}

/**
 * What to do with one message for one link, given how much that link already has
 * queued. Pure so the policy is testable without a socket:
 *
 * - `send`  — normal case, and every critical message under the hard limit
 * - `skip`  — a stream delta for a link that is falling behind
 * - `close` — even critical traffic is backing up; drop the client and let it
 *             resync from `hello`
 */
export function linkSendAction(msg: ServerMessage, bufferedAmount: number): 'send' | 'skip' | 'close' {
  if (bufferedAmount > SEND_HARD_LIMIT) return 'close';
  if (bufferedAmount > SEND_HIGH_WATER && isDroppable(msg)) return 'skip';
  return 'send';
}

/**
 * Everything the bridge holds for one user. Isolation is structural: each
 * context's SessionManager/WorkflowEngine only ever contain the owner's
 * state, so a client-supplied sessionId from another user no-ops for free.
 */
export interface UserContext {
  userId: string;
  store: Store;
  auth: AuthManager;
  guard: GuardAllowlist;
  sessions: SessionManager;
  workflows: WorkflowEngine;
  recipes: RecipeEngine;
  usage: UsagePoller;
  /** cwd -> machine-independent project identity; groups sessions across installs. */
  projectKeys: ProjectKeyRegistry;
  /** This user's live browser connections; broadcast fans out to these only. */
  sockets: Set<BrowserLink>;
  broadcast: (msg: ServerMessage) => void;
  /** Freshest verified Clerk token (handshake or relay); null in local no-auth mode. */
  clerkToken: string | null;
  /** Storage-server sync; inert until clerkToken is set. */
  sync: StorageSyncClient;
  /** Pull remote state and LWW-merge it in, then push local state up. Fire-and-forget. */
  syncNow: () => Promise<void>;
  /** Re-pull other users' published workflows and broadcast if they changed. */
  refreshShared: () => Promise<void>;
  /** Re-pull the shared step library, resolve pins, and broadcast if changed. */
  refreshSharedSteps: () => Promise<void>;
  /** Re-pull other users' published recipes and broadcast if they changed. */
  refreshSharedRecipes: () => Promise<void>;
  touchedAt: number;
}

/**
 * Construct one user's full stack and wire the same crosslinks the bridge
 * previously wired for its singletons (auth change/refresh handlers, the
 * usage-refresh-on-result hook, worker attachment).
 *
 * `observe` sees every broadcast before the socket fan-out — the registry
 * uses it to track session ownership from upsert/delete messages.
 */
export function buildUserContext(
  userId: string,
  storeRoot: string,
  worker: WorkerClient,
  observe?: (msg: ServerMessage) => void,
): UserContext {
  const store = createStore(storeRoot);
  const guard = new GuardAllowlist(store);
  const sockets = new Set<BrowserLink>();
  const sync = new StorageSyncClient(
    STORAGE_URL,
    () => ctx.clerkToken,
    (marks) => store.saveSyncWatermarks(marks),
    store.loadSyncWatermarks(),
    // Why sync went down, on disk: the bridge console isn't reachable on a
    // desktop/VPS install, so the `syncLog` file request reads this back.
    (entry) => store.appendSyncLog(entry),
  );
  // Storage/Supabase reachability flips → tell this user's browsers so they can
  // show the "cloud sync unavailable" notice (local persistence still works).
  sync.onStatusChange = (storage) => broadcast({ type: 'storageStatus', storage });

  const broadcast = (msg: ServerMessage) => {
    observe?.(msg);
    // Push-on-persist: every state change surfaces as a broadcast, so this one
    // hook covers all persist paths. No-ops while pulled state is applied.
    if (msg.type === 'sessionUpsert') sync.pushSession(msg.session);
    else if (msg.type === 'sessionDeleted') sync.deleteSession(msg.sessionId);
    else if (msg.type === 'workflows') sync.pushWorkflows(msg.workflows);
    // Push the full own history, not just the heads in msg.steps — else the debounce
    // coalesces intermediate versions away and storage never records them.
    else if (msg.type === 'steps') sync.pushSteps(workflows.listOwnStepVersions());
    // Same reason as steps: heads alone would let the debounce coalesce
    // intermediate versions away before they ever reach Postgres.
    else if (msg.type === 'recipes') sync.pushRecipes(recipes.listOwnRecipeVersions());
    const payload = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState !== LINK_OPEN) continue;
      const action = linkSendAction(msg, ws.bufferedAmount);
      if (action === 'skip') continue;
      if (action === 'close') {
        // Even critical messages are backing up, so this client is wedged rather
        // than merely slow. Dropping it is safe: `hello` is a complete state
        // snapshot, so whatever it missed arrives whole when it reconnects.
        console.warn(`[ws] dropping a client backed up by ${Math.round(ws.bufferedAmount / 1e6)}MB`);
        ws.close(1013, 'too slow');
        // No sockets.delete here — the 'close' handler owns removal, and
        // readyState has already left OPEN so the next broadcast skips it.
        continue;
      }
      ws.send(payload);
    }
  };

  // Push is suppressed while a review is pending: overwriting the remote row would
  // destroy the very state the user is being asked about, which is itself a silent
  // decision. A reject unblocks it (and is what converges the fleet).
  const pushGuard = () => {
    if (!guard.pendingReview) sync.pushGuardAllowlist(guard.blob());
  };
  guard.onChange = (entries) => {
    broadcast({ type: 'guardAllowlist', entries });
    pushGuard();
  };
  guard.onReview = (review) => broadcast({ type: 'guardAllowlistReview', review });

  const projectKeys = new ProjectKeyRegistry(store, (keys) => {
    sync.pushProjectKeys(keys);
    broadcast({ type: 'projectKeys', projectKeys: keys });
  });

  // Cross-machine agent memory: disk is the SDK-facing cache, storage is the
  // shared source of truth. Pushed on turn end (below) and on connect (syncNow).
  const memory = new MemorySyncer(store, projectKeys);

  const auth = new AuthManager(store);
  const usage = new UsagePoller(broadcast, auth);

  const sessions = new SessionManager(
    store,
    guard,
    (msg) => {
      broadcast(msg);
      // A result message means plan usage just changed — refresh the poller soon.
      if (
        msg.type === 'event' &&
        msg.event.kind === 'sdk' &&
        (msg.event.data as { type?: string } | null)?.type === 'result'
      ) {
        usage.refreshSoon();
        // Turn end is when the agent may have written memory; the mtime-diff also
        // catches hand-edits made outside a turn for free.
        const changed = memory.collectChanged();
        if (changed) sync.pushMemory(changed);
      }
    },
    auth,
  );
  sessions.attachWorker(worker);

  const workflows = new WorkflowEngine(store, sessions, broadcast, userId);
  const recipes = new RecipeEngine(store, broadcast, userId);

  // Backfill: sessions that predate project keys (and any checkout opened while
  // the feature was off) get resolved once, from whatever exists on this disk.
  projectKeys.learnAll([
    ...store.loadProjects().flatMap(projectRoots),
    ...sessions.list().map((s) => s.cwd),
  ]);

  // Login/logout: tell this user's browsers, restart idle queries so their next
  // turn uses (or drops) the app-managed token, and re-check plan usage.
  auth.onChange = (status) => {
    broadcast({ type: 'authStatus', auth: status });
    sessions.recycleIdleQueries();
    usage.refreshSoon();
  };
  // Token refresh: idle queries hold the old token in their spawn env.
  auth.onRefresh = () => sessions.recycleIdleQueries();

  const refreshShared = async () => {
    const list = await sync.pullShared();
    if (list && workflows.setShared(list)) {
      broadcast({ type: 'sharedWorkflows', workflows: list });
    }
  };

  /** Re-pull the shared step library, resolve any pins not yet cached, and broadcast. */
  const refreshSharedSteps = async () => {
    const shared = await sync.pullSharedSteps();
    // Resolve any pinned versions this bridge hasn't cached (foreign pins, older versions).
    const missing = workflows.unresolvedRefs();
    if (missing.length) {
      const resolved = await sync.resolveSteps(missing);
      if (resolved) workflows.addStepVersions(resolved);
    }
    if (shared) {
      workflows.setSharedSteps(shared);
      broadcast({
        type: 'sharedSteps',
        sharedSteps: workflows.listSharedSteps(),
        pinnedSteps: workflows.listPinnedSteps(),
      });
    }
  };

  /** Re-pull the published recipe corpus and broadcast it. Nothing pins recipes,
   *  so there is no resolveSteps analogue to run alongside. */
  const refreshSharedRecipes = async () => {
    const shared = await sync.pullSharedRecipes();
    if (shared && recipes.setSharedRecipes(shared)) {
      broadcast({ type: 'sharedRecipes', sharedRecipes: recipes.listSharedRecipes() });
    }
  };

  const syncNow = async () => {
    const pulled = await sync.pullAll();
    // A pull this recent already ran the whole routine — pushing and re-pulling
    // the shared views again would just burn egress. The browser reconnects
    // every 1.5s while a link is flapping, so this is the common path.
    if (pulled === THROTTLED) return;
    if (pulled) {
      sync.applying = true;
      try {
        workflows.applySyncedAll(pulled.workflows);
        workflows.applySyncedSteps(pulled.steps);
        recipes.applySyncedRecipes(pulled.recipes);
        recipes.applyStats(pulled.recipeStats);
        for (const row of pulled.sessions) {
          // A soft-deleted row is a tombstone to adopt, not a session: adopting it as
          // one is what made a delete on another machine come straight back here.
          if (row.deletedAt) sessions.applyRemoteDelete(row.id, row.deletedAt);
          else sessions.adoptSynced(row);
        }
        const remote = pulled.settings as UserUiSettings | null;
        // Merged before the applying flag drops, so the union is pushed once below.
        const local = store.loadSettings();
        if (remote && (remote.updatedAt ?? 0) > (local?.updatedAt ?? 0)) {
          // Field merge, not a whole-blob replace: remote still wins per field it
          // carries, but a client that predates a setting can't erase it by simply
          // omitting it from its payload. The trade-off is that clearing a key now
          // needs an explicit value — an omission no longer unsets anything.
          const merged = { ...local, ...remote };
          store.saveSettings(merged);
          broadcast({ type: 'settings', settings: merged });
        }
        // Stage (never apply) a divergent remote allowlist. Ordering is
        // load-bearing: this has to run before the push block below, or a fresh
        // machine's first pull would upload its empty list over the populated row
        // it is about to ask the user about. reviewRemote never mutates entries,
        // so it cannot push from inside this applying window.
        guard.reviewRemote(pulled.guardAllowlist);
        projectKeys.merge(pulled.projectKeys);
        // Adopted sessions may name checkouts this machine has but has never opened.
        projectKeys.learnAll(sessions.list().map((s) => s.cwd));
        // Apply after key merge/learn so slug->key resolution is as complete as possible.
        if (pulled.memory) memory.applyRemote(pulled.memory);
      } finally {
        sync.applying = false;
      }
      // Everything pulled is now on disk, so the delta cursors it advanced are
      // safe to keep across a restart.
      sync.commitCursors();
    }
    // Push local state up so a fresh storage server (or a migrated install)
    // becomes complete without waiting for each item to change locally.
    if (sync.enabled) {
      sync.pushWorkflows(workflows.list());
      sync.pushSteps(workflows.listOwnStepVersions());
      sync.pushRecipes(recipes.listOwnRecipeVersions());
      sync.pushSessions(sessions.list());
      sync.pushProjectKeys(projectKeys.all());
      sync.pushMemory(memory.collectAll());
      const local = store.loadSettings();
      if (local) sync.pushSettings(local);
      pushGuard();
    }
    // Populate other users' published workflows + step library on connect/reconnect.
    await refreshShared();
    await refreshSharedSteps();
    await refreshSharedRecipes();
  };

  const ctx: UserContext = {
    userId,
    store,
    auth,
    guard,
    sessions,
    workflows,
    recipes,
    usage,
    projectKeys,
    sockets,
    broadcast,
    clerkToken: null,
    sync,
    syncNow,
    refreshShared,
    refreshSharedSteps,
    refreshSharedRecipes,
    touchedAt: Date.now(),
  };
  // After ctx exists — its async broadcasts reference ctx-bound state (sync token).
  usage.start();
  return ctx;
}
