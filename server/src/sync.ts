import type { ProjectKeyMap, SessionMeta, StepDef, StepRef, WorkflowDef } from '@claude-ui/shared';

const PUSH_DEBOUNCE_MS = 2_000;
const PULL_MIN_SPACING_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface PulledState {
  workflows: WorkflowDef[];
  steps: StepDef[];
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
  private pendingSteps: StepDef[] | null = null;
  private pendingSessions = new Map<string, SessionMeta>();
  private wfTimer: NodeJS.Timeout | null = null;
  private stepTimer: NodeJS.Timeout | null = null;
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
      const [workflows, steps, sessions, settings, projectKeys] = await Promise.all([
        this.req('GET', '/workflows'),
        this.req('GET', '/steps'),
        this.req('GET', '/sessions'),
        this.req('GET', '/settings'),
        this.req('GET', '/project-keys'),
      ]);
      this.warned = false;
      return {
        workflows: (workflows ?? []) as WorkflowDef[],
        steps: (steps ?? []) as StepDef[],
        sessions: (sessions ?? []) as SessionMeta[],
        settings,
        projectKeys: (projectKeys ?? {}) as ProjectKeyMap,
      };
    } catch (err) {
      this.warnOnce('pull', err);
      return null;
    }
  }

  /** Other users' published workflows. Not rate-limited — small payload, needs to be near-live. */
  async pullShared(): Promise<WorkflowDef[] | null> {
    if (!this.enabled) return null;
    try {
      const shared = await this.req('GET', '/workflows/shared');
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

  /** Other users' published steps — the library. Not rate-limited (small, near-live). */
  async pullSharedSteps(): Promise<StepDef[] | null> {
    if (!this.enabled) return null;
    try {
      return ((await this.req('GET', '/steps/shared')) ?? []) as StepDef[];
    } catch (err) {
      this.warnOnce('pull shared steps', err);
      return null;
    }
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
