import type { GuardAllowlistBlob, McpConnectionsBlob, MemoryFileMap, ProjectKeyMap, RecipeDef, SessionMeta, StepDef, StepRef, StorageErrorKind, StorageStatus, SyncLogEntry, WorkflowDef } from '@lines/shared';
import type { UntrustedMark } from '@lines/shared';
import type { SyncWatermarks } from './store.ts';
import {
  canonicalize,
  fileSignerStore,
  itemPayload,
  runnableDigest,
  signBlob,
  settledHold,
  signItems,
  signingIdentity,
  SIGNATURE_KEY,
  stripSignature,
  strictSync,
  verifyBlob,
  verifyItem,
  type BlobSignature,
  type ItemVerdict,
  type SignerStore,
  type SigningIdentity,
  type TrustKind,
} from './syncSignature.ts';

const PUSH_DEBOUNCE_MS = 2_000;
const PULL_MIN_SPACING_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
/**
 * How long auth failures must persist before they count as an outage. The
 * browser relays a fresh Clerk token every 50s and those tokens live ~60s, so a
 * hidden tab (whose `setInterval` the browser throttles) routinely leaves the
 * bridge holding an expired one — every push then 401s. Waiting this out keeps
 * routine token turnover off the banner while a genuinely revoked session still
 * surfaces within the window.
 */
const AUTH_GRACE_MS = 90_000;
/** How often to re-probe storage while the link is down, so recovery is noticed. */
const PROBE_INTERVAL_MS = 15_000;
/** Storage error bodies can be whole Prisma dumps; the log keeps a usable prefix. */
const REASON_MAX_CHARS = 300;
/** Headroom under the storage server's 2mb JSON body limit, as memory.ts keeps for its map. */
const SESSIONS_PUSH_MAX_BYTES = 1.5 * 1024 * 1024;

/** `pullAll` skipped this call because a pull happened less than PULL_MIN_SPACING_MS ago. */
export const THROTTLED = Symbol('throttled');
/** The server answered 304 — the caller's cached view is still current. */
const NOT_MODIFIED = Symbol('not-modified');

/**
 * Resources whose blob travels as an envelope the storage server keeps intact,
 * so a signature can ride inside it (see syncSignature.ts).
 *
 * The rest are deliberately absent rather than forgotten. `/memory` and
 * `/project-keys` are *maps*, merged per key in SQL — a reserved signature key
 * would be filtered out on the way in, and there is nowhere else to put one
 * without a storage column. `/sessions` is an array, for the same reason. Those
 * resources are covered today by the review gate in front of pulled memory and
 * by the field stripping in `adoptSynced`; carrying signatures for them needs a
 * per-row column, which is a migration on a running deployment and is the next
 * step here, not this one.
 *
 * `/workflows`, `/steps` and `/recipes` are arrays too, but each of their rows
 * keeps its own JSON whole in a `data` column, so every item carries its own
 * signature instead (`signForPush` / `checkItems`) — those prompts are run.
 */
const SIGNED_PATHS = new Set(['/settings', '/guard-allowlist', '/mcp-connections']);

/** Endpoints that return an `x-sync-cursor`, mapped to the watermark they advance. */
const CURSOR_KEYS: Record<string, keyof SyncWatermarks> = {
  '/workflows': 'workflows',
  '/steps': 'steps',
  '/recipes': 'recipes',
  '/sessions': 'sessions',
  '/memory': 'memory',
};

/** `[{ownerId, id, runCount}]` rows -> the `ownerId/recipeId` map the engine keeps. */
function statsMap(rows: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows as { ownerId?: string; id?: string; runCount?: number }[]) {
    if (!row?.ownerId || !row?.id || typeof row.runCount !== 'number') continue;
    out[`${row.ownerId}/${row.id}`] = row.runCount;
  }
  return out;
}

/** A library item without its signature or a wire-supplied verdict, neither of which an engine may keep. */
function cleanItem<T extends object>(item: T): T {
  const { [SIGNATURE_KEY]: _sig, untrusted: _verdict, ...rest } = item as T & {
    [SIGNATURE_KEY]?: unknown;
    untrusted?: unknown;
  };
  return rest as T;
}

/** The object rows of a pulled list body, as they arrived. A non-array body is no rows rather than a cast. */
function objectRows<T extends object>(raw: unknown): T[] {
  return Array.isArray(raw) ? raw.filter((i): i is T => !!i && typeof i === 'object') : [];
}

/**
 * Other users' items, cleaned but not checked: whose machine signed someone
 * else's workflow says nothing this machine can use, so the engines mark them
 * foreign on owner alone.
 */
function cleanItems<T extends object>(raw: unknown): T[] {
  return objectRows<T>(raw).map((i) => cleanItem(i));
}

/**
 * The verdict a pulled item carries into the engine, from the crypto alone:
 * nothing for this machine's own signature, a mark for anything else. Whether
 * the owner already approved that exact content is the engine's to settle
 * (`ItemTrust`), as is everything about items that are not the user's own.
 *
 * Unsigned and forged items are marked even under `LINES_E2EE_STRICT=0`, where
 * the mark does not hold them back (`settledHold`): what it still does there is
 * keep this machine from ever signing them as its own on the next push.
 */
function provisionalMark(
  kind: TrustKind,
  item: object,
  verdict: ItemVerdict,
  ownKey: string | null,
): UntrustedMark | undefined {
  if (verdict.ok && verdict.signer === ownKey) return undefined;
  const digest = runnableDigest(kind, item);
  return settledHold(
    verdict.ok ? { reason: 'unknown-signer', digest, signer: verdict.signer } : { reason: verdict.reason, digest },
  );
}

/** The kind of item a library route carries. */
const KIND_OF_PATH: Record<string, TrustKind> = { '/workflows': 'workflow', '/steps': 'step', '/recipes': 'recipe' };

/**
 * The account a row from a cross-user route (version history, pin resolution)
 * was signed for: the owner it names — storage fills that from the row's
 * `user_id` there. Only an own row's verdict is used anyway (the engines mark
 * anyone else's on owner alone), and for it this is the user's own id.
 */
const rowOwner = (item: object): string => {
  const owner = (item as { ownerId?: unknown }).ownerId;
  return typeof owner === 'string' ? owner : '';
};

/** Failure class for an HTTP status the storage server actually answered with. */
export function classifyStatus(status: number): StorageErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  return 'client';
}

/** Failure class for a transport throw. `AbortSignal.timeout` rejects with a TimeoutError. */
export function classifyError(err: unknown): StorageErrorKind {
  const name = err instanceof Error ? err.name : '';
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
}

function truncate(reason: string): string {
  return reason.length > REASON_MAX_CHARS ? `${reason.slice(0, REASON_MAX_CHARS)}…` : reason;
}

/**
 * A session as storage receives it: without the fields that are this machine's
 * own record. `permissionCeiling` is one — a foreign recipe run's limit on what
 * an approved plan resumes in, which `adoptSynced` never takes from a row — so
 * it does not leave the machine either. Stripped on the copy that is sent, never
 * on the live meta, which keeps it.
 */
function sessionForSync(meta: SessionMeta): SessionMeta {
  if (meta.permissionCeiling === undefined) return meta;
  const { permissionCeiling: _local, ...rest } = meta;
  return rest;
}

/** LWW stamp for a meta; undefined when it carries neither timestamp (legacy rows). */
function sessionStamp(meta: SessionMeta): number | undefined {
  if (typeof meta.updatedAt === 'number') return meta.updatedAt;
  if (typeof meta.createdAt === 'number') return meta.createdAt;
  return undefined;
}

/**
 * One row from `GET /sessions`. `deletedAt` (ms epoch) marks a tombstone: storage
 * soft-deletes sessions and keeps serving them in the delta window, which is how a
 * peer learns about a delete instead of pushing the row back.
 */
export type PulledSession = SessionMeta & { deletedAt?: number };

export interface PulledState {
  workflows: WorkflowDef[];
  steps: StepDef[];
  recipes: RecipeDef[];
  /** Authoritative run counts, keyed `ownerId/recipeId`. */
  recipeStats: Record<string, number>;
  sessions: PulledSession[];
  settings: unknown;
  projectKeys: ProjectKeyMap;
  memory: MemoryFileMap | null;
  /** null = no row yet (or this one request failed); never applied without a review. */
  guardAllowlist: GuardAllowlistBlob | null;
  /** Same contract as `guardAllowlist`. Header and env *values* are never in this blob. */
  mcpConnections: McpConnectionsBlob | null;
}

/**
 * An MCP connection list with every credential *value* taken out: header values
 * dropped outright (only `headerKeys` names may travel), stdio env values reduced
 * to their names in `envKeys`, as `normalizeConnection` reduces them.
 *
 * Applied on both sides of the storage boundary, because that boundary is what
 * the guarantee is about. Outbound it runs before `req` signs the blob, so the
 * signature covers exactly the bytes storage keeps; inbound it runs after
 * verification, so a row written before names-only sync — or by a bridge that
 * predates it — hands this machine no value either. A row with nothing to take
 * out keeps its exact shape.
 */
function withoutMcpValues(blob: McpConnectionsBlob | null): McpConnectionsBlob | null {
  if (!blob || typeof blob !== 'object' || !Array.isArray(blob.connections)) return blob;
  return {
    ...blob,
    connections: blob.connections.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const { env, headers: _headers, ...rest } = raw as McpConnectionsBlob['connections'][number] & {
        env?: unknown;
        headers?: unknown;
      };
      if (!env || typeof env !== 'object' || Array.isArray(env)) return rest;
      const names = Array.isArray(rest.envKeys) ? rest.envKeys.filter((k) => typeof k === 'string') : [];
      for (const name of Object.keys(env)) if (!names.includes(name)) names.push(name);
      return names.length ? { ...rest, envKeys: names } : rest;
    }),
  };
}

/**
 * Bridge-side client for the storage server. One per user context; carries the
 * context's freshest Clerk token. Everything is best-effort and non-blocking:
 * a slow or absent storage server must never stall a turn — local flat JSON
 * stays the source of truth, pushes are debounced fire-and-forget, and a
 * failed push simply retries on the next change.
 */
export class StorageSyncClient {
  /** True while pulled state is being applied, so the resulting broadcasts don't push back up. */
  applying = false;

  /** Fired on every availability transition, so the bridge can broadcast a storageStatus. */
  onStatusChange?: (status: StorageStatus) => void;

  private warned = false;
  /** null = never contacted (unknown/disabled); true/false = last request outcome. */
  private available: boolean | null = null;
  private reason?: string;
  private kind?: StorageErrorKind;
  /** ms epoch the current outage began; undefined while up. */
  private downSince?: number;
  /** Consecutive failed requests, reset by any 2xx/304. */
  private failures = 0;
  /** ms epoch of the first auth failure not yet cleared by a success; null = none pending. */
  private authFailingSince: number | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private lastPullAt = 0;
  /** Per-path spacing for the two cross-user scans, which are the most expensive queries we make. */
  private lastSharedPullAt = new Map<string, number>();
  /** Last ETag seen per path, so an unchanged shared view costs a 304 instead of a full scan. */
  private etags = new Map<string, string>();
  private pendingWorkflows: WorkflowDef[] | null = null;
  private pendingSteps: StepDef[] | null = null;
  private pendingRecipes: RecipeDef[] | null = null;
  private pendingSessions = new Map<string, SessionMeta>();
  /**
   * Sessions deleted locally whose DELETE storage has not confirmed yet. Held
   * rather than fired-and-forgotten, because a delete has three ways to be lost: it
   * can arrive while pulled state is being applied, before there is a token to send
   * it with, or while a push carrying that very row is already in flight.
   */
  private pendingDeletes = new Set<string>();
  private pendingMemory: MemoryFileMap | null = null;
  private wfTimer: NodeJS.Timeout | null = null;
  private stepTimer: NodeJS.Timeout | null = null;
  private recipeTimer: NodeJS.Timeout | null = null;
  private sessTimer: NodeJS.Timeout | null = null;
  private memTimer: NodeJS.Timeout | null = null;

  /** Delta cursors, loaded from disk so a restart resumes instead of re-pulling everything. */
  private marks: SyncWatermarks;
  private marksDirty = false;

  /** Injected like `persistMarks`, so this module keeps no `fs` import and tests can collect rows. */
  private appendLog: (entry: SyncLogEntry) => void;
  private readonly authGraceMs: number;
  private readonly probeMs: number;

  /**
   * Where signer pins and counters live. Injected so a test can drive the
   * signature policy without a home directory, exactly as `appendLog` is.
   */
  private signers: SignerStore;
  private identity: () => Promise<SigningIdentity>;
  /** The account this client syncs, bound into every library item it signs (see `ItemScope`). */
  private account: string;
  /**
   * The signature last pushed per library row, with the payload it covers, so a
   * row that has not changed is re-sent with the signature it already has rather
   * than re-signed (and re-counted) on every push of the list it belongs to.
   */
  private itemSignatures = new Map<string, { payload: string; sig: BlobSignature }>();

  constructor(
    private base: string,
    private tokenFn: () => string | null,
    private persistMarks: (marks: SyncWatermarks) => void = () => {},
    marks: SyncWatermarks = {},
    appendLog: (entry: SyncLogEntry) => void = () => {},
    opts?: {
      authGraceMs?: number;
      probeMs?: number;
      signers?: SignerStore;
      /** This machine's signing key; injected so a test never touches `~/.lines-app`. */
      identity?: () => Promise<SigningIdentity>;
      /** The user id this client syncs for — the bridge's `ctx.userId`. */
      account?: string;
    },
  ) {
    this.signers = opts?.signers ?? fileSignerStore;
    this.identity = opts?.identity ?? (() => signingIdentity());
    this.account = opts?.account ?? '';
    this.marks = { ...marks };
    this.appendLog = appendLog;
    this.authGraceMs = opts?.authGraceMs ?? AUTH_GRACE_MS;
    this.probeMs = opts?.probeMs ?? PROBE_INTERVAL_MS;
  }

  get enabled(): boolean {
    return Boolean(this.base && this.tokenFn());
  }

  /** Pull everything for a context build / reconnect; null on failure, THROTTLED if too soon. */
  async pullAll(): Promise<PulledState | typeof THROTTLED | null> {
    if (!this.enabled) return null;
    if (Date.now() - this.lastPullAt < PULL_MIN_SPACING_MS) return THROTTLED;
    this.lastPullAt = Date.now();
    try {
      const [workflows, steps, recipes, recipeStats, sessions, settings, projectKeys, memory, guardAllowlist, mcpConnections] = await Promise.all([
        this.req('GET', this.delta('/workflows', 'workflows')),
        this.req('GET', this.delta('/steps', 'steps')),
        this.req('GET', this.delta('/recipes', 'recipes')),
        // Counts ride their own route, never the head lists: /recipes/shared is
        // ETag'd on content, so a 304 there must not be able to freeze them.
        this.req('GET', '/recipes/stats'),
        this.req('GET', this.delta('/sessions', 'sessions')),
        this.req('GET', '/settings'),
        this.req('GET', '/project-keys'),
        this.req('GET', this.delta('/memory', 'memory')),
        // Caught on its own rather than joining the bare Promise.all: this is the
        // newest table, so a storage server running without its migration answers
        // 500 — and that would otherwise abort the whole pull and stop workflows,
        // steps, sessions, settings, project keys and memory from syncing too.
        this.req('GET', '/guard-allowlist').catch(() => null),
        // Individually caught for the same reason, and more sharply: this is the
        // newest table of all, so every storage server that has not run the
        // migration yet answers 500 here.
        this.req('GET', '/mcp-connections').catch(() => null),
      ]);
      this.warned = false;
      // `body` guards against a 304 leaking into the applied state: only the two
      // shared routes are ETag-guarded today, but a symbol reaching applySyncedAll
      // would be an iteration crash rather than a no-op.
      const body = (v: unknown) => (v === NOT_MODIFIED ? null : v);
      return {
        // Each item's signature checked here, before anything adopts it; one
        // that did not come from this machine arrives marked (see checkItems).
        workflows: await this.checkItems<WorkflowDef>('workflow', '/workflows', body(workflows), this.ownTable),
        steps: await this.checkItems<StepDef>('step', '/steps', body(steps), this.ownTable),
        recipes: await this.checkItems<RecipeDef>('recipe', '/recipes', body(recipes), this.ownTable),
        recipeStats: statsMap(body(recipeStats)),
        sessions: (body(sessions) ?? []) as PulledSession[],
        settings: body(settings),
        projectKeys: (body(projectKeys) ?? {}) as ProjectKeyMap,
        memory: (body(memory) ?? null) as MemoryFileMap | null,
        guardAllowlist: (body(guardAllowlist) ?? null) as GuardAllowlistBlob | null,
        mcpConnections: withoutMcpValues((body(mcpConnections) ?? null) as McpConnectionsBlob | null),
      };
    } catch (err) {
      this.warnOnce('pull', err);
      return null;
    }
  }

  /**
   * Other users' published workflows — a cross-user scan, so it is rate-limited
   * like `pullAll` and ETag-guarded on top: the common case (nothing published
   * since last time) is a 304 with no body. `null` = no new data to apply,
   * whether that was a throttle, a 304, or a failure; the caller only needs to
   * know whether it has something fresh to broadcast.
   */
  async pullShared(): Promise<WorkflowDef[] | null> {
    if (!this.enabled || this.throttleShared('/workflows/shared')) return null;
    try {
      const shared = await this.req('GET', '/workflows/shared');
      if (shared === NOT_MODIFIED) return null;
      return cleanItems<WorkflowDef>(shared);
    } catch (err) {
      this.warnOnce('pull shared', err);
      return null;
    }
  }

  pushWorkflows(list: WorkflowDef[]): void {
    if (!this.enabled || this.applying) return;
    this.pendingWorkflows = list;
    this.wfTimer ??= setTimeout(() => {
      this.wfTimer = null;
      const body = this.pendingWorkflows;
      this.pendingWorkflows = null;
      void this.signForPush('/workflows', body)
        .then((signed) => this.req('PUT', '/workflows', signed))
        .catch((err) => this.warnOnce('push workflows', err));
    }, PUSH_DEBOUNCE_MS).unref() as unknown as NodeJS.Timeout;
  }

  /** Other users' published steps — the library. Rate-limited and ETag-guarded, as pullShared. */
  async pullSharedSteps(): Promise<StepDef[] | null> {
    if (!this.enabled || this.throttleShared('/steps/shared')) return null;
    try {
      const shared = await this.req('GET', '/steps/shared');
      if (shared === NOT_MODIFIED) return null;
      return cleanItems<StepDef>(shared);
    } catch (err) {
      this.warnOnce('pull shared steps', err);
      return null;
    }
  }

  /**
   * Persist the cursors advanced by the last pull. Called by the caller *after*
   * it has applied that pull, never before: a crash between advancing a cursor
   * and writing the rows it covered would otherwise skip them for good.
   */
  commitCursors(): void {
    if (!this.marksDirty) return;
    this.marksDirty = false;
    this.persistMarks(this.marks);
  }

  /** Append the stored delta cursor for a resource, if we have one. */
  private delta(path: string, key: keyof SyncWatermarks): string {
    const since = this.marks[key];
    // A cursor-less /sessions pull means we're starting from nothing against this
    // storage server (fresh or migrated install), so what it already has is
    // unknown — drop the push mark too and let the next bulk push be complete.
    if (!since && key === 'sessions' && this.marks.sessionsPushed) {
      delete this.marks.sessionsPushed;
      this.marksDirty = true;
    }
    return since ? `${path}?since=${encodeURIComponent(since)}` : path;
  }

  /** True when this path was pulled less than PULL_MIN_SPACING_MS ago; stamps the clock otherwise. */
  private throttleShared(path: string): boolean {
    const now = Date.now();
    if (now - (this.lastSharedPullAt.get(path) ?? 0) < PULL_MIN_SPACING_MS) return true;
    this.lastSharedPullAt.set(path, now);
    return false;
  }

  /**
   * Resolve the immutable versions a set of refs pin (any author). Rows are
   * checked like any pulled item, and only the versions that were asked for come
   * back: the engine files a version under the owner it names, so a row naming
   * anyone else would land in their slot — this user's own history included,
   * from where it is pushed back to storage as theirs.
   */
  async resolveSteps(refs: Pick<StepRef, 'ownerId' | 'stepId' | 'version'>[]): Promise<StepDef[] | null> {
    if (!this.enabled || refs.length === 0) return refs.length === 0 ? [] : null;
    try {
      const body = refs.map((r) => ({ ownerId: r.ownerId, id: r.stepId, version: r.version }));
      const rows = await this.checkItems<StepDef>(
        'step',
        '/steps/resolve',
        await this.req('POST', '/steps/resolve', body),
        rowOwner,
      );
      const wanted = new Set(refs.map((r) => `${r.ownerId}/${r.stepId}/${r.version}`));
      return rows.filter((s) => wanted.has(`${s.ownerId}/${s.id}/${s.version}`));
    } catch (err) {
      this.warnOnce('resolve steps', err);
      return null;
    }
  }

  /** Full version history for one step (any author). null = storage offline/disabled. */
  async pullStepVersions(ownerId: string, stepId: string): Promise<StepDef[] | null> {
    if (!this.enabled) return null;
    try {
      const path = `/steps/${encodeURIComponent(ownerId)}/${encodeURIComponent(stepId)}/versions`;
      // Checked here, because a pinned older version is exactly what a workflow
      // runs; which rows to keep is the engine's call (`addStepVersions`).
      return await this.checkItems<StepDef>('step', path, await this.req('GET', path), rowOwner);
    } catch (err) {
      this.warnOnce('pull step versions', err);
      return null;
    }
  }

  pushSteps(list: StepDef[]): void {
    if (!this.enabled || this.applying) return;
    this.pendingSteps = list;
    this.stepTimer ??= setTimeout(() => {
      this.stepTimer = null;
      const body = this.pendingSteps;
      this.pendingSteps = null;
      void this.signForPush('/steps', body)
        .then((signed) => this.req('PUT', '/steps', signed))
        .catch((err) => this.warnOnce('push steps', err));
    }, PUSH_DEBOUNCE_MS).unref() as unknown as NodeJS.Timeout;
  }

  deleteStep(id: string): void {
    if (!this.enabled || this.applying) return;
    void this.req('DELETE', `/steps/${id}`).catch((err) => this.warnOnce('delete step', err));
  }

  // ---- recipes ----

  /** Other users' published recipes — the browsable corpus. Rate-limited and ETag-guarded. */
  async pullSharedRecipes(): Promise<RecipeDef[] | null> {
    if (!this.enabled || this.throttleShared('/recipes/shared')) return null;
    try {
      const shared = await this.req('GET', '/recipes/shared');
      if (shared === NOT_MODIFIED) return null;
      return cleanItems<RecipeDef>(shared);
    } catch (err) {
      this.warnOnce('pull shared recipes', err);
      return null;
    }
  }

  /** Full version history for one recipe (any author). null = storage offline/disabled. */
  async pullRecipeVersions(ownerId: string, recipeId: string): Promise<RecipeDef[] | null> {
    if (!this.enabled) return null;
    try {
      const path = `/recipes/${encodeURIComponent(ownerId)}/${encodeURIComponent(recipeId)}/versions`;
      return await this.checkItems<RecipeDef>('recipe', path, await this.req('GET', path), rowOwner);
    } catch (err) {
      this.warnOnce('pull recipe versions', err);
      return null;
    }
  }

  pushRecipes(list: RecipeDef[]): void {
    if (!this.enabled || this.applying) return;
    this.pendingRecipes = list;
    this.recipeTimer ??= setTimeout(() => {
      this.recipeTimer = null;
      const body = this.pendingRecipes;
      this.pendingRecipes = null;
      void this.signForPush('/recipes', body)
        .then((signed) => this.req('PUT', '/recipes', signed))
        .catch((err) => this.warnOnce('push recipes', err));
    }, PUSH_DEBOUNCE_MS).unref() as unknown as NodeJS.Timeout;
  }

  deleteRecipe(id: string): void {
    if (!this.enabled || this.applying) return;
    void this.req('DELETE', `/recipes/${id}`).catch((err) => this.warnOnce('delete recipe', err));
  }

  /**
   * Count one run per pair, in one call — a bundle of six must not be six round
   * trips. Returns the authoritative counts for the pairs that were accepted, so
   * the caller can replace its optimistic numbers; null when storage said no.
   *
   * `softErrors`: a 404 here means "none of these keys were runnable", which is a
   * per-request answer, not a storage outage — without it every browser of this
   * user would raise the global "cloud sync unavailable" banner.
   */
  async incrementRecipeRuns(
    pairs: { ownerId: string; id: string }[],
  ): Promise<Record<string, number> | null> {
    if (!this.enabled || pairs.length === 0) return null;
    try {
      return statsMap(await this.req('POST', '/recipes/run', pairs, { softErrors: true }));
    } catch (err) {
      this.warnOnce('increment recipe runs', err);
      return null;
    }
  }

  /**
   * Upload one recipe screenshot and get its public URL back. `softErrors` again:
   * an install with no R2 answers 503, and that is a missing optional feature
   * rather than the storage link being down.
   */
  async uploadRecipeImage(image: { name: string; mediaType: string; data: string }): Promise<string> {
    const res = (await this.req('POST', '/recipes/images', image, { softErrors: true })) as {
      url?: string;
    } | null;
    if (!res?.url) throw new Error('image upload returned no url');
    return res.url;
  }

  // ---- library item signatures ----

  /**
   * A pulled list of workflows, steps or recipes as an engine may adopt it:
   * every item's signature checked and stripped, and a provisional mark on each
   * one this machine did not sign (see `provisionalMark`). Nothing is dropped —
   * an unverified item is kept and shown, held back from running until the
   * owner has looked at it — and nothing a row says about its own trust is kept.
   */
  private async checkItems<T extends object>(
    kind: TrustKind,
    path: string,
    raw: unknown,
    /** Whose account each row's signature has to be bound to (see `ItemScope`). */
    accountOf: (item: T) => string,
  ): Promise<T[]> {
    const items = objectRows<T>(raw);
    if (items.length === 0) return [];
    // A key that cannot be loaded leaves every signature looking foreign, which
    // holds items back rather than letting them through.
    const ownKey = await this.identity().then((i) => i.publicKey, () => null);
    const marked = new Map<string, number>();
    const out = await Promise.all(
      items.map(async (item) => {
        const clean = cleanItem(item) as T;
        const verdict = await verifyItem(item, { kind, account: accountOf(item) });
        const mark = provisionalMark(kind, clean, verdict, ownKey);
        if (!mark) return clean;
        marked.set(mark.reason, (marked.get(mark.reason) ?? 0) + 1);
        return { ...clean, untrusted: mark } as T;
      }),
    );
    if (marked.size > 0) {
      const counts = [...marked].map(([reason, n]) => `${reason} ×${n}`).join(', ');
      const outcome = strictSync() ? 'held for review' : 'marked (unsigned and forged still run: LINES_E2EE_STRICT=0)';
      // The sync log is where a user (or support) can see why an item stopped
      // running; `fail`/`client` as for a refused blob — the request was fine,
      // the content was not.
      this.log({ event: 'fail', kind: 'client', method: 'GET', path, reason: `signature ${counts} — ${outcome}` });
      console.warn(`[sync] ${path}: ${counts} ${outcome}`);
    }
    return out;
  }

  /** The account of a row from this user's own table: this user's, whatever the row says. */
  private ownTable = (): string => this.account;

  /**
   * This machine's library rows as `PUT` sends them: signed when this machine
   * vouches for them, reusing the signature a row already carries when its
   * payload has not changed.
   *
   * A marked row is never signed. Doing so would launder it — content this
   * machine never vouched for, turned into a row that runs on every peer as this
   * machine's own. What happens instead depends on what the row has to lose:
   *
   * - **unsigned or forged** — no valid signature to keep, so it travels without
   *   one, and a local edit still reaches the other machines (where it is held
   *   back exactly as here). This is what keeps a `LINES_E2EE_STRICT=0` fleet
   *   syncing without promoting anything an old bridge wrote.
   * - **another machine's signature, or someone else's content** — not pushed:
   *   an unsigned copy would strip the signature of the machine that wrote it,
   *   or re-publish another user's prompt from this account.
   */
  private async signForPush<T extends object & { id?: string; version?: number; untrusted?: UntrustedMark }>(
    path: string,
    list: T[] | null,
  ): Promise<T[]> {
    const travels = (item: T) =>
      !item.untrusted || item.untrusted.reason === 'unsigned' || item.untrusted.reason === 'forged';
    const items = (list ?? []).filter(travels);
    const rows = items.map((item) => cleanItem(item));
    if (rows.length === 0) return [];
    const scope = { kind: KIND_OF_PATH[path]!, account: this.account };
    const vouched = items.map((item) => !item.untrusted);
    const keyOf = (item: T) => `${path}\0${item.id ?? ''}\0${item.version ?? ''}`;
    const payloads = rows.map((item) => canonicalize({ account: scope.account, item: itemPayload(item) }));
    const misses = rows.flatMap((item, i) =>
      vouched[i] && this.itemSignatures.get(keyOf(item))?.payload !== payloads[i] ? [i] : [],
    );
    if (misses.length > 0) {
      const signed = await signItems(misses.map((i) => rows[i]), scope, await this.identity(), this.signers);
      misses.forEach((i, n) => {
        this.itemSignatures.set(keyOf(rows[i]), { payload: payloads[i], sig: signed[n][SIGNATURE_KEY] });
      });
    }
    return rows.map((item, i) =>
      vouched[i] ? { ...item, [SIGNATURE_KEY]: this.itemSignatures.get(keyOf(item))!.sig } : item,
    );
  }

  pushSession(meta: SessionMeta): void {
    if (!this.enabled || this.applying) return;
    // Deleted here already; pushing it would ask storage to undo that.
    if (this.pendingDeletes.has(meta.id)) return;
    this.pendingSessions.set(meta.id, meta);
    this.sessTimer ??= setTimeout(() => {
      this.sessTimer = null;
      const batch = [...this.pendingSessions.values()];
      this.pendingSessions.clear();
      void this.flushSessions(batch);
    }, PUSH_DEBOUNCE_MS).unref() as unknown as NodeJS.Timeout;
  }

  /**
   * Bulk push (a reconnect's whole list). Storage rows are LWW upserts, so
   * re-sending metas it already holds is pure bytes: filter to the ones newer
   * than the last accepted push. Per-session `pushSession` calls stay unfiltered
   * — those are already deltas.
   */
  pushSessions(list: SessionMeta[]): void {
    if (!this.enabled || this.applying) return;
    // Every reconnect/sync passes through here, so it doubles as the retry point for
    // deletes that had nowhere to go when they were issued.
    this.drainDeletes();
    const since = Number(this.marks.sessionsPushed ?? 0);
    for (const meta of list) {
      const stamp = sessionStamp(meta);
      if (stamp === undefined || stamp > since) this.pushSession(meta);
    }
  }

  /**
   * Send one debounced batch as chunks that each stay under the body limit,
   * sequentially so a failure doesn't strand the rest silently. The watermark
   * only advances when every chunk was accepted; a failed chunk goes back into
   * `pendingSessions` (merged, never overwriting a meta that arrived meanwhile)
   * and rides along with the next push.
   */
  private async flushSessions(batch: SessionMeta[]): Promise<void> {
    let allOk = true;
    for (const chunk of this.chunkSessions(batch)) {
      // Re-checked per chunk rather than once up front: the batch was drained before
      // the first await, so a delete issued while an earlier chunk was in flight
      // would otherwise be undone by a later one.
      const live = chunk.filter((meta) => !this.pendingDeletes.has(meta.id));
      if (live.length === 0) continue;
      try {
        await this.req('PUT', '/sessions', live.map(sessionForSync));
      } catch (err) {
        allOk = false;
        for (const meta of live) if (!this.pendingSessions.has(meta.id)) this.pendingSessions.set(meta.id, meta);
        this.warnOnce('push sessions', err);
      }
    }
    // A delete that raced this push has to land after it, or storage keeps the row.
    this.drainDeletes();
    if (!allOk) return;
    const since = Number(this.marks.sessionsPushed ?? 0);
    let newest = since;
    for (const meta of batch) newest = Math.max(newest, sessionStamp(meta) ?? 0);
    if (newest > since) {
      this.marks.sessionsPushed = String(newest);
      this.marksDirty = true;
      this.commitCursors();
    }
  }

  /**
   * Split a batch into bodies under SESSIONS_PUSH_MAX_BYTES. A single meta over
   * budget can't be chunked, so it is dropped with a warning, as memory.ts does
   * with an oversized file — the local copy is untouched, only its cloud copy lags.
   */
  private chunkSessions(batch: SessionMeta[]): SessionMeta[][] {
    const chunks: SessionMeta[][] = [];
    let chunk: SessionMeta[] = [];
    let bytes = 2; // the enclosing `[]`
    for (const meta of batch) {
      const size = Buffer.byteLength(JSON.stringify(meta)) + 1; // + the separating comma
      if (size + 2 > SESSIONS_PUSH_MAX_BYTES) {
        this.warnSkipOnce(`session ${meta.id} is ${size} bytes — over the push budget, not sent to storage`);
        continue;
      }
      if (chunk.length > 0 && bytes + size > SESSIONS_PUSH_MAX_BYTES) {
        chunks.push(chunk);
        chunk = [];
        bytes = 2;
      }
      chunk.push(meta);
      bytes += size;
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
  }

  deleteSession(id: string): void {
    this.pendingSessions.delete(id);
    this.pendingDeletes.add(id);
    // Queued, not dropped. `applying` (pulled state being written) and `!enabled` (no
    // token yet) both used to lose the delete outright with nothing to retry it, so
    // the row survived in storage and came back on the next pull.
    if (!this.enabled || this.applying) return;
    this.sendDelete(id);
  }

  /** Retry every unconfirmed delete. Storage's soft delete is idempotent. */
  private drainDeletes(): void {
    if (!this.enabled || this.applying) return;
    for (const id of this.pendingDeletes) this.sendDelete(id);
  }

  private sendDelete(id: string): void {
    void this.req('DELETE', `/sessions/${id}`)
      .then(() => this.pendingDeletes.delete(id))
      .catch((err) => this.warnOnce('delete session', err));
  }

  deleteWorkflow(id: string): void {
    if (!this.enabled || this.applying) return;
    void this.req('DELETE', `/workflows/${id}`).catch((err) => this.warnOnce('delete workflow', err));
  }

  pushSettings(blob: unknown): void {
    if (!this.enabled || this.applying) return;
    void this.req('PUT', '/settings', blob).catch((err) => this.warnOnce('push settings', err));
  }

  /** Undebounced like settings: allowlist edits are human-paced and few. */
  pushGuardAllowlist(blob: GuardAllowlistBlob): void {
    if (!this.enabled || this.applying) return;
    void this.req('PUT', '/guard-allowlist', blob).catch((err) => this.warnOnce('push guard allowlist', err));
  }

  /**
   * Undebounced like the allowlist: connection edits are human-paced and few.
   *
   * `blob` is `McpConnections.blob()`, which carries header and env var names
   * only. Values are stripped here regardless (see `withoutMcpValues`): this is
   * the last point before storage, so it is where "no credential leaves this
   * machine" has to hold whatever a caller hands in — and it runs before `req`
   * signs, so the signature still verifies after storage's own filtering.
   */
  pushMcpConnections(blob: McpConnectionsBlob): void {
    if (!this.enabled || this.applying) return;
    void this.req('PUT', '/mcp-connections', withoutMcpValues(blob)).catch((err) => this.warnOnce('push mcp connections', err));
  }

  /**
   * Debounced memory push. Pending maps are *merged* (not replaced), so quick
   * consecutive turns each contributing different files can't drop one another;
   * the server then per-file LWW-merges into the stored blob.
   */
  pushMemory(map: MemoryFileMap): void {
    if (!this.enabled || this.applying) return;
    if (Object.keys(map).length === 0) return;
    this.pendingMemory = Object.assign(this.pendingMemory ?? {}, map);
    this.memTimer ??= setTimeout(() => {
      this.memTimer = null;
      const body = this.pendingMemory;
      this.pendingMemory = null;
      void this.req('PUT', '/memory', body).catch((err) => this.warnOnce('push memory', err));
    }, PUSH_DEBOUNCE_MS).unref() as unknown as NodeJS.Timeout;
  }

  /**
   * The ids of every bridge grant behind a live share or invite on `deviceId`,
   * as storage records them — or null when storage cannot say (no token, an
   * error, or a server too old to record grant ids). Null is never "none": the
   * caller reconciles only against an answer.
   */
  async liveGrantIds(deviceId: string): Promise<Set<string> | null> {
    if (!this.enabled) return null;
    let body: {
      grantTracking?: unknown;
      granted?: { deviceId?: unknown; grantId?: unknown }[];
      invites?: { deviceId?: unknown; grantId?: unknown }[];
    };
    try {
      // Soft: a failure here is this request's alone and must not raise the
      // storage-outage banner. Not signed — it is a list of who has access, read to
      // take access away, and an unsigned answer can only drop grants.
      body = (await this.req('GET', '/v1/shares', undefined, { softErrors: true })) as typeof body;
    } catch {
      return null;
    }
    if (!body || typeof body !== 'object' || body.grantTracking !== true) return null;
    const ids = new Set<string>();
    for (const row of [...(body.granted ?? []), ...(body.invites ?? [])]) {
      if (row?.deviceId === deviceId && typeof row.grantId === 'string') ids.add(row.grantId);
    }
    return ids;
  }

  /** Whole-map push; the server unions it into the stored map rather than replacing. */
  pushProjectKeys(keys: ProjectKeyMap): void {
    if (!this.enabled || this.applying) return;
    if (Object.keys(keys).length === 0) return;
    void this.req('PUT', '/project-keys', keys).catch((err) => this.warnOnce('push project keys', err));
  }

  /**
   * @param opts.softErrors Treat an HTTP error as this request's own failure
   *   rather than a storage outage — it still throws, but the availability flag
   *   (and therefore every browser's sync-outage banner) is left alone. For
   *   routes whose non-2xx answers are normal operating states: an
   *   R2-unconfigured 503, a "nothing runnable" 404.
   */
  private async req(
    method: string,
    path: string,
    body?: unknown,
    opts?: { softErrors?: boolean },
  ): Promise<unknown> {
    const token = this.tokenFn();
    if (!token) throw new Error('no token'); // disabled, not an outage — leave status untouched
    // Cursor/ETag bookkeeping is per resource, not per URL — `?since=` changes
    // every pull and would otherwise defeat both caches.
    const basePath = path.split('?')[0];
    const knownEtag = this.etags.get(basePath);
    const started = Date.now();
    // Signed on the way out, so a peer can tell this machine's writes from
    // anything the database grew on its own. Objects only: the list endpoints
    // (`PUT /workflows`) take arrays, which have nowhere to carry a signature —
    // those are covered per-row by the modules that build them.
    const outgoing =
      SIGNED_PATHS.has(basePath) && body !== undefined && body !== null && typeof body === 'object'
        ? await signBlob(body as object, await signingIdentity(), this.signers)
        : body;
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(knownEtag ? { 'if-none-match': knownEtag } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(outgoing) } : {}),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      // Transport failure: storage process down, connection refused, or timeout.
      this.recordFailure({
        kind: classifyError(err),
        method,
        path: basePath,
        ms: Date.now() - started,
        reason: truncate(err instanceof Error ? err.message : String(err)),
      });
      throw err;
    }
    // 304: our cached view is current and the server sent no body at all.
    if (res.status === 304) {
      this.recordSuccess();
      return NOT_MODIFIED;
    }
    if (!res.ok) {
      // A 500 carries the storage server's error body (Prisma/DB message) — surface it as the reason.
      const reason = await res.json().then((b) => (b as { error?: string })?.error).catch(() => undefined);
      if (opts?.softErrors) {
        // The link itself is fine — the server answered — so only this call fails.
        // Not recordSuccess(): a soft 401 is still no evidence the token is good.
        this.setAvailable(true);
        throw new Error(reason ?? `storage ${method} ${path} → ${res.status}`);
      }
      this.recordFailure({
        kind: classifyStatus(res.status),
        method,
        path: basePath,
        status: res.status,
        ms: Date.now() - started,
        reason: truncate(reason ?? `storage ${method} ${path} → ${res.status}`),
      });
      throw new Error(`storage ${method} ${path} → ${res.status}`);
    }
    this.recordSuccess();
    const etag = res.headers.get('etag');
    if (etag) this.etags.set(basePath, etag);
    const cursorKey = CURSOR_KEYS[basePath];
    const cursor = res.headers.get('x-sync-cursor');
    // Absent header = the response held no rows, so the cursor we have still stands.
    if (cursorKey && cursor) {
      this.marks[cursorKey] = cursor;
      this.marksDirty = true;
    }
    const payload = await res.json();
    return SIGNED_PATHS.has(basePath) ? this.checkSignature(basePath, payload) : payload;
  }

  /**
   * Verify a pulled blob, and decide what to do about a failure.
   *
   * A *forged* or *rolled back* blob is always refused — those are things only
   * an attacker produces, and accepting one is the whole risk this closes. An
   * *unsigned* blob is refused too, by default: it is what a storage server
   * authoring rows on its own would write. `LINES_E2EE_STRICT=0` accepts it with
   * a warning, for recovering a fleet with a bridge too old to sign.
   *
   * A refusal does not strand the resource. It comes back as null, which the
   * pull treats as an empty cloud, and `syncNow` pushes this machine's copy
   * straight after — signed — so the refused row is overwritten on the same
   * round trip rather than refused on every pull from then on.
   */
  private async checkSignature(resource: string, body: unknown): Promise<unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const verdict = await verifyBlob(resource, body, this.signers);
    if (verdict.ok) return stripSignature(body);

    const refuse = verdict.reason !== 'unsigned' || strictSync();
    if (refuse) {
      // `fail` with a client kind: the request itself succeeded, the *content*
      // did not, and this log is the only place a user can see why a resource
      // stopped applying. Only refusals: an unsigned blob accepted under
      // `LINES_E2EE_STRICT=0` still applies, so a row for it is noise.
      this.appendLog({
        at: Date.now(),
        event: 'fail',
        kind: 'client',
        method: 'GET',
        path: resource,
        reason: `signature ${verdict.reason} — refused`,
      });
      console.warn(`[sync] refusing ${resource}: signature ${verdict.reason}`);
      // Null, not a throw: one unverifiable resource must not abort a pull that
      // also carries five verifiable ones.
      return null;
    }
    return stripSignature(body);
  }

  /** Current bridge->storage link health for a fresh client's hello (null before first contact). */
  get status(): StorageStatus {
    if (this.available !== false) return { available: true };
    return {
      available: false,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.kind ? { kind: this.kind } : {}),
      ...(this.downSince ? { since: this.downSince } : {}),
      ...(this.failures ? { failures: this.failures } : {}),
    };
  }

  /** A 2xx/304: the link is up *and* the token was accepted, so the auth grace resets too. */
  private recordSuccess(): void {
    this.authFailingSince = null;
    // Before the counter reset, so the `up` row can report how many requests failed.
    this.setAvailable(true);
    this.failures = 0;
  }

  /**
   * One failed request: always logged, but only sometimes an outage. An `auth`
   * failure inside AUTH_GRACE_MS is a token that went stale between relays, not
   * a broken link, so the banner waits it out (see AUTH_GRACE_MS).
   */
  private recordFailure(fail: { kind: StorageErrorKind } & Omit<SyncLogEntry, 'at' | 'event' | 'kind' | 'failures'>): void {
    this.failures += 1;
    this.log({ event: 'fail', ...fail, failures: this.failures });
    if (fail.kind === 'auth' && this.available !== false) {
      const now = Date.now();
      this.authFailingSince ??= now;
      if (now - this.authFailingSince < this.authGraceMs) return;
    }
    this.setAvailable(false, fail.reason, fail.kind);
  }

  /** Flip availability and notify only on a transition, so the client sees one banner per outage. */
  private setAvailable(ok: boolean, reason?: string, kind?: StorageErrorKind): void {
    if (this.available === ok) return;
    const wasDown = this.available === false;
    this.available = ok;
    this.reason = ok ? undefined : reason;
    this.kind = ok ? undefined : kind;
    if (ok) {
      // `wasDown` and not `available !== null`: the first successful request of a
      // process is not a recovery and has no outage to measure.
      if (wasDown) {
        this.log({
          event: 'up',
          ...(this.downSince !== undefined ? { downMs: Date.now() - this.downSince } : {}),
          failures: this.failures,
        });
      }
      this.downSince = undefined;
      this.stopProbe();
      this.warned = false; // allow one fresh warn on the next outage
    } else {
      this.downSince = Date.now();
      this.log({ event: 'down', kind, reason, failures: this.failures });
      // The one warning this outage gets. `warned` is claimed here so the
      // callers' warnOnce doesn't add a second, less informative line.
      this.warned = true;
      console.warn(`[sync] storage unavailable (${kind ?? 'unknown'}): ${reason ?? 'no reason given'}`);
      this.startProbe();
    }
    this.onStatusChange?.(this.status);
  }

  /**
   * While the link is down, retry on our own: pushes only fire on local change
   * and pullAll is spaced 30s, so without this the banner can outlive the outage
   * by minutes. `/settings` rather than `/health` — health sits *above* storage's
   * Clerk gate, so it would clear an auth outage that is still real.
   */
  private startProbe(): void {
    if (this.probeTimer) return;
    this.probeTimer = setInterval(() => void this.probe(), this.probeMs).unref() as unknown as NodeJS.Timeout;
  }

  private probe(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.req('GET', '/settings').then(() => {}, () => {});
  }

  /**
   * Probe now instead of waiting for the next tick: a freshly relayed token is
   * the usual fix for an auth outage, and the timer would keep sending the stale
   * one for up to probeMs. A no-op while the link is up, so the periodic relay
   * adds no storage traffic on the happy path.
   */
  retryNow(): Promise<void> {
    if (this.available !== false) return Promise.resolve();
    return this.probe();
  }

  private stopProbe(): void {
    if (!this.probeTimer) return;
    clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /** Diagnostics are best-effort: a failing log must never break a sync path. */
  private log(entry: Omit<SyncLogEntry, 'at'>): void {
    try {
      this.appendLog({ at: Date.now(), ...entry });
    } catch {
      // ignored
    }
  }

  /** As warnOnce, for a local skip that says nothing about the link's health. */
  private warnSkipOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[sync] ${msg}`);
  }

  /** One warning per outage, not one per debounced push. */
  private warnOnce(what: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[sync] ${what} failed (storage offline?):`, err instanceof Error ? err.message : String(err));
  }
}
