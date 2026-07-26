import type { MemoryFileMap, ProjectKeyMap, SessionMeta, StepDef, StepRef, StorageStatus, WorkflowDef } from '@lines/shared';
import type { SyncWatermarks } from './store.ts';

const PUSH_DEBOUNCE_MS = 2_000;
const PULL_MIN_SPACING_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

/** `pullAll` skipped this call because a pull happened less than PULL_MIN_SPACING_MS ago. */
export const THROTTLED = Symbol('throttled');
/** The server answered 304 — the caller's cached view is still current. */
const NOT_MODIFIED = Symbol('not-modified');

/** Endpoints that return an `x-sync-cursor`, mapped to the watermark they advance. */
const CURSOR_KEYS: Record<string, keyof SyncWatermarks> = {
  '/workflows': 'workflows',
  '/steps': 'steps',
  '/sessions': 'sessions',
  '/memory': 'memory',
};

export interface PulledState {
  workflows: WorkflowDef[];
  steps: StepDef[];
  sessions: SessionMeta[];
  settings: unknown;
  projectKeys: ProjectKeyMap;
  memory: MemoryFileMap | null;
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
  private lastPullAt = 0;
  /** Per-path spacing for the two cross-user scans, which are the most expensive queries we make. */
  private lastSharedPullAt = new Map<string, number>();
  /** Last ETag seen per path, so an unchanged shared view costs a 304 instead of a full scan. */
  private etags = new Map<string, string>();
  private pendingWorkflows: WorkflowDef[] | null = null;
  private pendingSteps: StepDef[] | null = null;
  private pendingSessions = new Map<string, SessionMeta>();
  private pendingMemory: MemoryFileMap | null = null;
  private wfTimer: NodeJS.Timeout | null = null;
  private stepTimer: NodeJS.Timeout | null = null;
  private sessTimer: NodeJS.Timeout | null = null;
  private memTimer: NodeJS.Timeout | null = null;

  /** Delta cursors, loaded from disk so a restart resumes instead of re-pulling everything. */
  private marks: SyncWatermarks;
  private marksDirty = false;

  constructor(
    private base: string,
    private tokenFn: () => string | null,
    private persistMarks: (marks: SyncWatermarks) => void = () => {},
    marks: SyncWatermarks = {},
  ) {
    this.marks = { ...marks };
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
      const [workflows, steps, sessions, settings, projectKeys, memory] = await Promise.all([
        this.req('GET', this.delta('/workflows', 'workflows')),
        this.req('GET', this.delta('/steps', 'steps')),
        this.req('GET', this.delta('/sessions', 'sessions')),
        this.req('GET', '/settings'),
        this.req('GET', '/project-keys'),
        this.req('GET', this.delta('/memory', 'memory')),
      ]);
      this.warned = false;
      // `body` guards against a 304 leaking into the applied state: only the two
      // shared routes are ETag-guarded today, but a symbol reaching applySyncedAll
      // would be an iteration crash rather than a no-op.
      const body = (v: unknown) => (v === NOT_MODIFIED ? null : v);
      return {
        workflows: (body(workflows) ?? []) as WorkflowDef[],
        steps: (body(steps) ?? []) as StepDef[],
        sessions: (body(sessions) ?? []) as SessionMeta[],
        settings: body(settings),
        projectKeys: (body(projectKeys) ?? {}) as ProjectKeyMap,
        memory: (body(memory) ?? null) as MemoryFileMap | null,
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
      return (shared ?? []) as WorkflowDef[];
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
      void this.req('PUT', '/workflows', body).catch((err) => this.warnOnce('push workflows', err));
    }, PUSH_DEBOUNCE_MS).unref() as unknown as NodeJS.Timeout;
  }

  /** Other users' published steps — the library. Rate-limited and ETag-guarded, as pullShared. */
  async pullSharedSteps(): Promise<StepDef[] | null> {
    if (!this.enabled || this.throttleShared('/steps/shared')) return null;
    try {
      const shared = await this.req('GET', '/steps/shared');
      if (shared === NOT_MODIFIED) return null;
      return (shared ?? []) as StepDef[];
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
    return since ? `${path}?since=${encodeURIComponent(since)}` : path;
  }

  /** True when this path was pulled less than PULL_MIN_SPACING_MS ago; stamps the clock otherwise. */
  private throttleShared(path: string): boolean {
    const now = Date.now();
    if (now - (this.lastSharedPullAt.get(path) ?? 0) < PULL_MIN_SPACING_MS) return true;
    this.lastSharedPullAt.set(path, now);
    return false;
  }

  /** Resolve the immutable versions a set of refs pin (any author). */
  async resolveSteps(refs: Pick<StepRef, 'ownerId' | 'stepId' | 'version'>[]): Promise<StepDef[] | null> {
    if (!this.enabled || refs.length === 0) return refs.length === 0 ? [] : null;
    try {
      const body = refs.map((r) => ({ ownerId: r.ownerId, id: r.stepId, version: r.version }));
      return ((await this.req('POST', '/steps/resolve', body)) ?? []) as StepDef[];
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
      return ((await this.req('GET', path)) ?? []) as StepDef[];
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
      void this.req('PUT', '/steps', body).catch((err) => this.warnOnce('push steps', err));
    }, PUSH_DEBOUNCE_MS).unref() as unknown as NodeJS.Timeout;
  }

  deleteStep(id: string): void {
    if (!this.enabled || this.applying) return;
    void this.req('DELETE', `/steps/${id}`).catch((err) => this.warnOnce('delete step', err));
  }

  pushSession(meta: SessionMeta): void {
    if (!this.enabled || this.applying) return;
    this.pendingSessions.set(meta.id, meta);
    this.sessTimer ??= setTimeout(() => {
      this.sessTimer = null;
      const batch = [...this.pendingSessions.values()];
      this.pendingSessions.clear();
      void this.req('PUT', '/sessions', batch).catch((err) => this.warnOnce('push sessions', err));
    }, PUSH_DEBOUNCE_MS).unref() as unknown as NodeJS.Timeout;
  }

  pushSessions(list: SessionMeta[]): void {
    for (const meta of list) this.pushSession(meta);
  }

  deleteSession(id: string): void {
    if (!this.enabled || this.applying) return;
    this.pendingSessions.delete(id);
    void this.req('DELETE', `/sessions/${id}`).catch((err) => this.warnOnce('delete session', err));
  }

  deleteWorkflow(id: string): void {
    if (!this.enabled || this.applying) return;
    void this.req('DELETE', `/workflows/${id}`).catch((err) => this.warnOnce('delete workflow', err));
  }

  pushSettings(blob: unknown): void {
    if (!this.enabled || this.applying) return;
    void this.req('PUT', '/settings', blob).catch((err) => this.warnOnce('push settings', err));
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

  /** Whole-map push; the server unions it into the stored map rather than replacing. */
  pushProjectKeys(keys: ProjectKeyMap): void {
    if (!this.enabled || this.applying) return;
    if (Object.keys(keys).length === 0) return;
    void this.req('PUT', '/project-keys', keys).catch((err) => this.warnOnce('push project keys', err));
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = this.tokenFn();
    if (!token) throw new Error('no token'); // disabled, not an outage — leave status untouched
    // Cursor/ETag bookkeeping is per resource, not per URL — `?since=` changes
    // every pull and would otherwise defeat both caches.
    const basePath = path.split('?')[0];
    const knownEtag = this.etags.get(basePath);
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(knownEtag ? { 'if-none-match': knownEtag } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      // Transport failure: storage process down, connection refused, or timeout.
      this.setAvailable(false, err instanceof Error ? err.message : String(err));
      throw err;
    }
    // 304: our cached view is current and the server sent no body at all.
    if (res.status === 304) {
      this.setAvailable(true);
      return NOT_MODIFIED;
    }
    if (!res.ok) {
      // A 500 carries the storage server's error body (Prisma/DB message) — surface it as the reason.
      const reason = await res.json().then((b) => (b as { error?: string })?.error).catch(() => undefined);
      this.setAvailable(false, reason ?? `storage ${method} ${path} → ${res.status}`);
      throw new Error(`storage ${method} ${path} → ${res.status}`);
    }
    this.setAvailable(true);
    const etag = res.headers.get('etag');
    if (etag) this.etags.set(basePath, etag);
    const cursorKey = CURSOR_KEYS[basePath];
    const cursor = res.headers.get('x-sync-cursor');
    // Absent header = the response held no rows, so the cursor we have still stands.
    if (cursorKey && cursor) {
      this.marks[cursorKey] = cursor;
      this.marksDirty = true;
    }
    return res.json();
  }

  /** Current bridge->storage link health for a fresh client's hello (null before first contact). */
  get status(): StorageStatus {
    return { available: this.available !== false, ...(this.reason ? { reason: this.reason } : {}) };
  }

  /** Flip availability and notify only on a transition, so the client sees one banner per outage. */
  private setAvailable(ok: boolean, reason?: string): void {
    if (this.available === ok) return;
    this.available = ok;
    this.reason = ok ? undefined : reason;
    if (ok) this.warned = false; // allow one fresh warn on the next outage
    this.onStatusChange?.(this.status);
  }

  /** One warning per outage, not one per debounced push. */
  private warnOnce(what: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[sync] ${what} failed (storage offline?):`, err instanceof Error ? err.message : String(err));
  }
}
