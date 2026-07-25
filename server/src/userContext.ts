import { WebSocket } from 'ws';
import type { ServerMessage, UserUiSettings } from '@lines/shared';
import { createStore, type Store } from './store.ts';
import { AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { UsagePoller } from './usage.ts';
import { WorkflowEngine } from './workflows.ts';
import { StorageSyncClient } from './sync.ts';
import { ProjectKeyRegistry } from './projectKeys.ts';
import { MemorySyncer } from './memory.ts';
import type { WorkerClient } from './workerClient.ts';

const STORAGE_URL = process.env.STORAGE_URL ?? 'http://localhost:8790';

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
  usage: UsagePoller;
  /** cwd -> machine-independent project identity; groups sessions across installs. */
  projectKeys: ProjectKeyRegistry;
  /** This user's live browser connections; broadcast fans out to these only. */
  sockets: Set<WebSocket>;
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
  const sockets = new Set<WebSocket>();
  const sync = new StorageSyncClient(STORAGE_URL, () => ctx.clerkToken);
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
    const payload = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  };

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

  // Backfill: sessions that predate project keys (and any checkout opened while
  // the feature was off) get resolved once, from whatever exists on this disk.
  projectKeys.learnAll([...store.loadProjects(), ...sessions.list().map((s) => s.cwd)]);

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

  const syncNow = async () => {
    const pulled = await sync.pullAll();
    if (pulled) {
      sync.applying = true;
      try {
        for (const wf of pulled.workflows) workflows.applySynced(wf);
        workflows.applySyncedSteps(pulled.steps);
        for (const meta of pulled.sessions) sessions.adoptSynced(meta);
        const remote = pulled.settings as UserUiSettings | null;
        // Merged before the applying flag drops, so the union is pushed once below.
        const local = store.loadSettings();
        if (remote && (remote.updatedAt ?? 0) > (local?.updatedAt ?? 0)) {
          store.saveSettings(remote);
          broadcast({ type: 'settings', settings: remote });
        }
        projectKeys.merge(pulled.projectKeys);
        // Adopted sessions may name checkouts this machine has but has never opened.
        projectKeys.learnAll(sessions.list().map((s) => s.cwd));
        // Apply after key merge/learn so slug->key resolution is as complete as possible.
        if (pulled.memory) memory.applyRemote(pulled.memory);
      } finally {
        sync.applying = false;
      }
    }
    // Push local state up so a fresh storage server (or a migrated install)
    // becomes complete without waiting for each item to change locally.
    if (sync.enabled) {
      sync.pushWorkflows(workflows.list());
      sync.pushSteps(workflows.listOwnStepVersions());
      sync.pushSessions(sessions.list());
      sync.pushProjectKeys(projectKeys.all());
      sync.pushMemory(memory.collectAll());
      const local = store.loadSettings();
      if (local) sync.pushSettings(local);
    }
    // Populate other users' published workflows + step library on connect/reconnect.
    await refreshShared();
    await refreshSharedSteps();
  };

  const ctx: UserContext = {
    userId,
    store,
    auth,
    guard,
    sessions,
    workflows,
    usage,
    projectKeys,
    sockets,
    broadcast,
    clerkToken: null,
    sync,
    syncNow,
    refreshShared,
    refreshSharedSteps,
    touchedAt: Date.now(),
  };
  // After ctx exists — its async broadcasts reference ctx-bound state (sync token).
  usage.start();
  return ctx;
}
