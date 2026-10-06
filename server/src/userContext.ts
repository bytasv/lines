import { devRuntime } from './devRuntime.ts';
import type { ServerMessage, SocketAccess, UserUiSettings } from '@lines/shared';
import { findWorktree, projectRoots } from '@lines/shared';
import { createStore, type Store } from './store.ts';
import { AuthManager } from './auth.ts';
import { OpenaiAuthManager } from './openaiAuth.ts';
import { OpenaiUsagePoller } from './openaiUsage.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { McpConnections } from './mcpConnections.ts';
import { SessionManager } from './sessions.ts';
import { SpendHistory } from './spendHistory.ts';
import { PushNotifier } from './pushNotifier.ts';
import { UsagePoller } from './usage.ts';
import { WorkflowEngine } from './workflows.ts';
import { RecipeEngine } from './recipes.ts';
import { StorageSyncClient, THROTTLED } from './sync.ts';
import { ProjectKeyRegistry } from './projectKeys.ts';
import { PresenceTracker } from './presence.ts';
import * as worktreeCommands from './worktreeCommands.ts';
import * as workflowCommands from './workflowCommands.ts';
import { ownSigningKey } from './syncSignature.ts';
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
/*
 * Raised by a third when end-to-end encryption landed. The thresholds are read
 * off the *socket's* queue, and an encrypted frame is base64 — the relay's own
 * envelope is JSON, so the payload has to survive JSON — which inflates every
 * byte by ~33%. Left unchanged, an encrypted link would start shedding stream
 * deltas at three quarters of the traffic an unencrypted one tolerated, purely
 * because of the encoding.
 *
 * Still deliberately generous: normal use must never reach them.
 */
const SEND_HIGH_WATER = 5.5 * 1024 * 1024;
const SEND_HARD_LIMIT = 43 * 1024 * 1024;

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
 * Which session a broadcast is about, or null when it is about the user rather
 * than one of their sessions.
 *
 * The distinction is the whole of the fan-out rule below, so it is derived from
 * the message shape in one place: anything carrying a `sessionId` is per-session,
 * and everything else — settings, workflows, usage, auth, the guard allowlist,
 * project lists, update status — describes the account.
 */
export function sessionIdOf(msg: ServerMessage): string | null {
  return 'sessionId' in msg && typeof msg.sessionId === 'string'
    ? msg.sessionId
    : msg.type === 'sessionUpsert'
      ? msg.session.id
      : null;
}

/**
 * May this socket receive this broadcast?
 *
 * Default-deny for anything account-wide: a guest is on someone else's machine,
 * so `settings`, `workflows`, `usage`, `authStatus` and friends are none of their
 * business — and several would leak the host's project paths or Claude account.
 *
 * The exceptions are the machine's own health, `workerStatus` and
 * `storageStatus` — a guest whose turns are about to fail needs to know why, and
 * neither carries anything private — and, for a machine share only, `projects`
 * and `projectKeys`, plus the workflow library when the grant may create sessions.
 */
export function mayReceive(
  msg: ServerMessage,
  sessionId: string | null,
  access: SocketAccess,
): boolean {
  if (access.scope === 'owner') return true;
  if (sessionId) {
    // A machine grant covers every session on the machine; a session share
    // covers exactly its own.
    return access.scope === 'machine' || !!access.sessionIds?.includes(sessionId);
  }
  // A machine share lends the projects too (see `buildHello`), so their changes
  // follow live rather than waiting for the guest's next `hello`.
  if (access.scope === 'machine' && (msg.type === 'projects' || msg.type === 'projectKeys')) {
    return true;
  }
  // A machine guest who may start sessions sees the host's workflow library (see
  // `buildHello`) so they can start one with a workflow; it follows live too.
  // Read only — authoring stays owner-only in MESSAGE_AUTHZ.
  if (
    access.scope === 'machine' &&
    access.caps.createSessions &&
    (msg.type === 'workflows' || msg.type === 'sharedWorkflows')
  ) {
    return true;
  }
  return msg.type === 'workerStatus' || msg.type === 'storageStatus' || msg.type === 'pong';
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
  /** The connected OpenAI (ChatGPT) account, for sessions on a Codex model.
   *  Its own manager, not a mode of `auth`: the two share no tokens, no refresh
   *  model and no wire messages. */
  openaiAuth: OpenaiAuthManager;
  /** ChatGPT plan usage, the OpenAI mirror of `usage`. */
  openaiUsage: OpenaiUsagePoller;
  guard: GuardAllowlist;
  /** User-managed MCP servers, spliced into every session's query options. */
  mcp: McpConnections;
  /** Cross-machine agent memory, and the review gate in front of its writes. */
  memory: MemorySyncer;
  sessions: SessionManager;
  workflows: WorkflowEngine;
  recipes: RecipeEngine;
  usage: UsagePoller;
  /** This machine's day-resolution spend ledger, for the hello snapshot. */
  spendHistory: SpendHistory;
  /** This user's subscribed devices, and the Web Push of session alerts to them. */
  pushNotifier: PushNotifier;
  /** cwd -> machine-independent project identity; groups sessions across installs. */
  projectKeys: ProjectKeyRegistry;
  /**
   * Who is watching which of this user's sessions. In memory only, and reset by a
   * bridge restart — which is correct: nobody is watching anything across one.
   */
  presence: PresenceTracker;
  /**
   * This user's live browser connections, each with what it may see.
   *
   * A Map rather than a Set because the fan-out is now scoped: a guest socket
   * must not receive messages about sessions outside its grant, nor any of the
   * owner's account-wide state. The access lives here rather than on BrowserLink
   * — that interface is a deliberately minimal structural contract (see
   * browserLink.test.ts) and access data has no business in it.
   */
  sockets: Map<BrowserLink, SocketAccess>;
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
  const mcp = new McpConnections(store);
  const sockets = new Map<BrowserLink, SocketAccess>();
  const presence = new PresenceTracker();
  const sync = new StorageSyncClient(
    STORAGE_URL,
    () => ctx.clerkToken,
    (marks) => store.saveSyncWatermarks(marks),
    store.loadSyncWatermarks(),
    // Why sync went down, on disk: the bridge console isn't reachable on a
    // desktop/VPS install, so the `syncLog` file request reads this back.
    (entry) => store.appendSyncLog(entry),
    // Bound into every workflow, step and recipe it signs: one machine key signs
    // for every account on this machine, so the signature has to say whose row it is.
    { account: userId },
  );
  // Storage/Supabase reachability flips → tell this user's browsers so they can
  // show the "cloud sync unavailable" notice (local persistence still works).
  sync.onStatusChange = (storage) => broadcast({ type: 'storageStatus', storage });
  const pushNotifier = new PushNotifier(store);

  const broadcast = (msg: ServerMessage) => {
    observe?.(msg);
    // Push-on-persist: every state change surfaces as a broadcast, so this one
    // hook covers all persist paths. No-ops while pulled state is applied.
    if (msg.type === 'sessionUpsert') {
      sync.pushSession(msg.session);
      // Not while pulled state is applied: `adoptSynced` upserts sessions that ran
      // on another machine, reset to idle here — that machine pushes for them.
      if (!sync.applying) pushNotifier.onSessionUpsert(msg.session);
    } else if (msg.type === 'sessionDeleted') {
      sync.deleteSession(msg.sessionId);
      pushNotifier.forget(msg.sessionId);
    }
    else if (msg.type === 'workflows') sync.pushWorkflows(msg.workflows);
    // Push the full own history, not just the heads in msg.steps — else the debounce
    // coalesces intermediate versions away and storage never records them.
    else if (msg.type === 'steps') sync.pushSteps(workflows.listOwnStepVersions());
    // Same reason as steps: heads alone would let the debounce coalesce
    // intermediate versions away before they ever reach Postgres.
    else if (msg.type === 'recipes') sync.pushRecipes(recipes.listOwnRecipeVersions());
    const payload = JSON.stringify(msg);
    const sessionId = sessionIdOf(msg);
    for (const [ws, access] of sockets) {
      if (ws.readyState !== LINK_OPEN) continue;
      if (!mayReceive(msg, sessionId, access)) continue;
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

  // Same three lines, same reasoning as the guard's — including the suppression
  // of the push while a review is pending.
  const pushMcp = () => {
    if (!mcp.pendingReview) sync.pushMcpConnections(mcp.blob());
  };
  mcp.onChange = (connections) => {
    broadcast({ type: 'mcpConnections', connections });
    pushMcp();
    // The guard has no equivalent of this third line: its entries are read per
    // decision, while `mcpServers` is frozen into a query when it is created. So
    // without pushing the new list onto the live ones, a connection added here
    // would not exist for any running session — and, reporting no status, could
    // never be authorized either.
    void sessions.applyMcpServers();
  };
  mcp.onReview = (review) => broadcast({ type: 'mcpConnectionsReview', review });

  const projectKeys = new ProjectKeyRegistry(store, (keys) => {
    sync.pushProjectKeys(keys);
    broadcast({ type: 'projectKeys', projectKeys: keys });
  });

  // Cross-machine agent memory: disk is the SDK-facing cache, storage is the
  // shared source of truth. Pushed on turn end (below) and on connect (syncNow).
  const memory = new MemorySyncer(store, projectKeys);
  // Same shape as the guard's and the MCP list's: a pulled change is staged and
  // announced, never applied. Agent memory is read into every session's prompt
  // on this machine, so an unreviewed write is prompt injection that persists.
  memory.onReview = (review) => broadcast({ type: 'memoryReview', review });

  const auth = new AuthManager(store);
  const openaiAuth = new OpenaiAuthManager(store);
  const usage = new UsagePoller(broadcast, auth);
  // Reads codex's own credential per request; see openaiUsage.ts for why that is
  // safe when writing it a second time would not be.
  const openaiUsage = new OpenaiUsagePoller(broadcast, store);

  // Before the SessionManager, which is its only writer.
  const spendHistory = new SpendHistory(store, broadcast);

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
        // Both pollers are nudged rather than the one matching the turn's provider:
        // this hook sees a settled `result` with no provider on it, and both are
        // debounced and rate-limited, so the wrong one is a no-op rather than a
        // request.
        openaiUsage.refreshSoon();
        // Turn end is when the agent may have written memory; the mtime-diff also
        // catches hand-edits made outside a turn for free.
        const changed = memory.collectChanged();
        if (changed) sync.pushMemory(changed);
      }
    },
    auth,
    mcp,
    openaiAuth,
    userId,
    spendHistory,
  );
  sessions.attachWorker(worker);

  const workflows = new WorkflowEngine(store, sessions, broadcast, userId);
  // Codex only: a plan step's turn is already settled when its card is answered,
  // so the advance has to be asked for rather than fall out of the settle.
  sessions.onPlanApproved = (sessionId, stepIndex) => workflows.approve(sessionId, stepIndex);
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

  // Connect/disconnect of the OpenAI account. No `recycleIdleQueries` and no
  // `usage.refreshSoon` counterpart: a codex turn carries no cached credential
  // (it reads `$CODEX_HOME/auth.json` per child), and the plan-usage poller is
  // Claude's.
  openaiAuth.onChange = (status) => {
    broadcast({ type: 'openaiAuthStatus', auth: status });
    // A connect makes a reading possible for the first time; a disconnect has to
    // clear the one on screen.
    openaiUsage.refreshSoon();
  };
  // A device-code login fails long after the click that started it, so the
  // failure needs a channel of its own.
  openaiAuth.onError = (message) => broadcast({ type: 'openaiAuthError', message });

  const refreshShared = async () => {
    const list = await sync.pullShared();
    // The engine's view, not the raw pull: it drops rows that are really this
    // user's own (see WorkflowEngine.listShared), and broadcasting `list` would
    // hand the client back exactly the ones just filtered out.
    if (list && workflows.setShared(list)) {
      broadcast({ type: 'sharedWorkflows', workflows: workflows.listShared() });
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
        // Same ordering requirement, same never-mutates guarantee.
        mcp.reviewRemote(pulled.mcpConnections);
        projectKeys.merge(pulled.projectKeys);
        // Adopted sessions may name checkouts this machine has but has never opened.
        projectKeys.learnAll(sessions.list().map((s) => s.cwd));
        // Apply after key merge/learn so slug->key resolution is as complete as possible.
        // Stage, never write. `reviewRemote` touches no file, so it is safe
        // inside this applying window for the same reason the two above are.
        memory.reviewRemote(pulled.memory ?? {});
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
      pushMcp();
    }
    // Populate other users' published workflows + step library on connect/reconnect.
    await refreshShared();
    await refreshSharedSteps();
    await refreshSharedRecipes();
    // A fresh machine mints its signing key on its first sync, after the `hello`
    // that would have shown it: announce it once, so the fingerprint the user
    // compares between machines is on screen without a reconnect.
    const own = ownSigningKey();
    if (own !== announcedSigningKey) {
      announcedSigningKey = own;
      broadcast({ type: 'syncSigning', info: workflowCommands.syncSigningInfo(ctx, own) });
    }
  };
  let announcedSigningKey = ownSigningKey();

  const ctx: UserContext = {
    userId,
    store,
    auth,
    openaiAuth,
    openaiUsage,
    guard,
    mcp,
    memory,
    sessions,
    workflows,
    recipes,
    usage,
    spendHistory,
    pushNotifier,
    projectKeys,
    sockets,
    presence,
    broadcast,
    clerkToken: null,
    sync,
    syncNow,
    refreshShared,
    refreshSharedSteps,
    refreshSharedRecipes,
    touchedAt: Date.now(),
  };
  // Wired after ctx exists, since the command layer takes the whole context. A
  // work tree cut for a session starts detached on purpose — this is where it gets
  // the branch, once the title the branch should carry is known. Fire-and-forget:
  // failing to name a branch must never disturb the turn that is already running.
  sessions.onAutoNamed = (session, title) => {
    if (!findWorktree(store.loadProjects(), session.cwd)) return;
    void devRuntime.run(() => worktreeCommands.nameWorktreeBranch(ctx, session.cwd, title)).catch((err) => {
      console.warn('[worktrees] branch naming failed:', err);
    });
  };
  // After ctx exists — their async broadcasts reference ctx-bound state (sync token).
  usage.start();
  openaiUsage.start();
  return ctx;
}
