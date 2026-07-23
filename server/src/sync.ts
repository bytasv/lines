import type { ProjectKeyMap, SessionMeta, WorkflowDef } from '@claude-ui/shared';

const PUSH_DEBOUNCE_MS = 2_000;
const PULL_MIN_SPACING_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface PulledState {
  workflows: WorkflowDef[];
  sessions: SessionMeta[];
  settings: unknown;
  projectKeys: ProjectKeyMap;
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

  private warned = false;
  private lastPullAt = 0;
  private pendingWorkflows: WorkflowDef[] | null = null;
  private pendingSessions = new Map<string, SessionMeta>();
  private wfTimer: NodeJS.Timeout | null = null;
  private sessTimer: NodeJS.Timeout | null = null;

  constructor(
    private base: string,
    private tokenFn: () => string | null,
  ) {}

  get enabled(): boolean {
    return Boolean(this.base && this.tokenFn());
  }

  /** Pull everything for a context build / reconnect; rate-limited; null on failure. */
  async pullAll(): Promise<PulledState | null> {
    if (!this.enabled) return null;
    if (Date.now() - this.lastPullAt < PULL_MIN_SPACING_MS) return null;
    this.lastPullAt = Date.now();
    try {
      const [workflows, sessions, settings, projectKeys] = await Promise.all([
        this.req('GET', '/workflows'),
        this.req('GET', '/sessions'),
        this.req('GET', '/settings'),
        this.req('GET', '/project-keys'),
      ]);
      this.warned = false;
      return {
        workflows: (workflows ?? []) as WorkflowDef[],
        sessions: (sessions ?? []) as SessionMeta[],
        settings,
        projectKeys: (projectKeys ?? {}) as ProjectKeyMap,
      };
    } catch (err) {
      this.warnOnce('pull', err);
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

  /** Whole-map push; the server unions it into the stored map rather than replacing. */
  pushProjectKeys(keys: ProjectKeyMap): void {
    if (!this.enabled || this.applying) return;
    if (Object.keys(keys).length === 0) return;
    void this.req('PUT', '/project-keys', keys).catch((err) => this.warnOnce('push project keys', err));
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = this.tokenFn();
    if (!token) throw new Error('no token');
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`storage ${method} ${path} → ${res.status}`);
    return res.json();
  }

  /** One warning per outage, not one per debounced push. */
  private warnOnce(what: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[sync] ${what} failed (storage offline?):`, err instanceof Error ? err.message : String(err));
  }
}
