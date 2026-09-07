/**
 * User-managed MCP servers, persisted via the injected Store and synced like the
 * guard allowlist — which this module is deliberately a structural copy of
 * (`autoGuard.ts` `GuardAllowlist`): a user-level, list-shaped setting with
 * intent-based edits, a never-auto-applied cross-machine review, and one
 * `onChange` hook the bridge hangs both the broadcast and the push off.
 *
 * The one thing it adds is a credential boundary. Header values are what an
 * HTTP MCP server authenticates with, so they live in a separate local-only
 * file: `blob()` (synced to storage) and the `mcpConnections` broadcast carry
 * header *names* only, and `serverConfigs()` — read on the bridge, on its way
 * into the worker — is the single place a value is ever attached.
 */
import {
  MCP_CONNECTIONS_MAX,
  diffConnections,
  normalizeConnection,
  type McpConnection,
  type McpConnectionError,
  type McpConnectionInput,
  type McpConnectionSecrets,
  type McpConnectionsBlob,
  type McpConnectionsReview,
} from '@lines/shared';
import type { McpSyncState, Store } from './store.ts';

export type McpAddResult =
  | { ok: true; connection: McpConnection }
  | { ok: false; reason: 'duplicate-name' | 'too-many' | 'not-found' | McpConnectionError };

/** Validate + dedupe an untrusted list (this disk, or a storage row) into canonical rows. */
function sanitizeConnections(raw: unknown): McpConnection[] {
  if (!Array.isArray(raw)) return [];
  const out: McpConnection[] = [];
  for (const item of raw) {
    const norm = normalizeConnection(item as McpConnectionInput);
    if ('error' in norm) continue;
    // The name is the MCP namespace and the id is the sync identity; a repeat of
    // either would make two rows claim one thing.
    if (out.some((c) => c.name === norm.connection.name || c.id === norm.connection.id)) continue;
    out.push(norm.connection);
    if (out.length === MCP_CONNECTIONS_MAX) break;
  }
  return out;
}

/** Order-insensitive set equality — the only comparison divergence detection uses. */
function setEqual(a: McpConnection[], b: McpConnection[]): boolean {
  const { added, removed } = diffConnections(a, b);
  return added.length === 0 && removed.length === 0;
}

/** The serializable SDK config one connection describes, or null when it is off. */
function serverConfig(
  connection: McpConnection,
  headers: Record<string, string> | undefined,
): Record<string, unknown> | null {
  if (!connection.enabled) return null;
  if (connection.transport === 'stdio') {
    return {
      type: 'stdio',
      command: connection.command,
      ...(connection.args ? { args: connection.args } : {}),
      ...(connection.env ? { env: connection.env } : {}),
      ...(connection.timeout ? { timeout: connection.timeout } : {}),
    };
  }
  // `alwaysLoad` is left unset on purpose: the default defers this server's tool
  // definitions behind tool search, so a connection the session has no use for
  // costs nothing in its context window (and does not block startup).
  return {
    type: connection.transport,
    url: connection.url,
    ...(headers && Object.keys(headers).length ? { headers } : {}),
    ...(connection.timeout ? { timeout: connection.timeout } : {}),
  };
}

/**
 * Per-store list of MCP servers the user added, plus the cross-machine review
 * lifecycle: a remote list is *never* applied silently. `reviewRemote` only
 * stages a diff; connections change solely through `add`, `update`, `remove`
 * and `acceptReview`.
 */
export class McpConnections {
  private connections: McpConnection[];
  private secrets: McpConnectionSecrets;
  private syncState: McpSyncState;

  /** Fired on every local list change — a UI edit or an accepted review. */
  onChange?: (connections: McpConnection[]) => void;
  /** Fired when a remote divergence is staged, recomputed, or cleared. */
  onReview?: (review: McpConnectionsReview | null) => void;

  constructor(private store: Store) {
    const raw = store.loadMcpConnections<unknown[]>([]);
    this.connections = sanitizeConnections(raw);
    // Load-time migration, as GuardAllowlist does: rewrite once, and only when
    // the sanitized form actually differs, so a second construction leaves the
    // file's bytes alone.
    if (JSON.stringify(raw) !== JSON.stringify(this.connections)) this.persistConnections();
    this.secrets = store.loadMcpSecrets();
    this.syncState = store.loadMcpSync();
    if (!this.syncState.updatedAt) {
      // No sync file yet. Stamp now, or the storage row would be written with a
      // 1970 timestamp and always lose its LWW.
      this.syncState = { ...this.syncState, updatedAt: Date.now() };
      this.persistSync();
    }
  }

  list(): McpConnection[] {
    return this.connections;
  }

  /** The synced form: connections (header names only) plus the ordering timestamp. */
  blob(): McpConnectionsBlob {
    return { connections: this.connections, updatedAt: this.syncState.updatedAt };
  }

  get pendingReview(): boolean {
    return this.syncState.pending !== null;
  }

  /**
   * Every enabled connection as SDK query options, keyed by MCP namespace, with
   * header values spliced in from the local-only secrets file. The only method
   * whose output holds a credential — see `buildQueryOptions`, which is its one
   * caller.
   */
  serverConfigs(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const connection of this.connections) {
      const config = serverConfig(connection, this.secrets[connection.id]);
      if (config) out[connection.name] = config;
    }
    return out;
  }

  /** Header names this machine actually holds a value for, so the UI can say what is missing. */
  secretKeys(id: string): string[] {
    return Object.keys(this.secrets[id] ?? {});
  }

  /**
   * Add a connection. `headers` are the secret values for its `headerKeys`;
   * they are written to the local-only file and never enter the list.
   */
  add(input: McpConnectionInput, headers?: Record<string, string>): McpAddResult {
    const norm = normalizeConnection(input);
    if ('error' in norm) return { ok: false, reason: norm.error };
    if (this.connections.length >= MCP_CONNECTIONS_MAX) return { ok: false, reason: 'too-many' };
    if (this.connections.some((c) => c.name === norm.connection.name)) {
      return { ok: false, reason: 'duplicate-name' };
    }
    this.connections = [...this.connections, norm.connection];
    this.writeSecrets(norm.connection, headers);
    this.commit();
    return { ok: true, connection: norm.connection };
  }

  /**
   * Replace one connection wholesale, keeping its id. `headers` omitted keeps
   * the stored values; a header name dropped from `headerKeys` drops its value
   * with it, so a removed credential does not linger on disk.
   */
  update(id: string, input: McpConnectionInput, headers?: Record<string, string>): McpAddResult {
    const existing = this.connections.find((c) => c.id === id);
    if (!existing) return { ok: false, reason: 'not-found' };
    const norm = normalizeConnection({ ...input, id });
    if ('error' in norm) return { ok: false, reason: norm.error };
    if (this.connections.some((c) => c.id !== id && c.name === norm.connection.name)) {
      return { ok: false, reason: 'duplicate-name' };
    }
    this.connections = this.connections.map((c) => (c.id === id ? norm.connection : c));
    this.writeSecrets(norm.connection, headers);
    this.commit();
    return { ok: true, connection: norm.connection };
  }

  /** Drop a connection and its stored header values; true when one matched. */
  remove(id: string): boolean {
    const next = this.connections.filter((c) => c.id !== id);
    if (next.length === this.connections.length) return false;
    this.connections = next;
    if (this.secrets[id]) {
      const rest = { ...this.secrets };
      delete rest[id];
      this.secrets = rest;
      this.persistSecrets();
    }
    this.commit();
    return true;
  }

  /**
   * Compare a pulled remote list against the local one and stage a review when
   * they differ. Detection is a set difference, not last-write-wins: a fresh
   * machine has an empty list and a *newer* timestamp than a populated cloud, and
   * it must still ask rather than erase it.
   *
   * Never mutates `connections`, so it is safe to call inside the syncer's
   * `applying` window — `onChange`, and with it the push, is unreachable here.
   */
  reviewRemote(remote: McpConnectionsBlob | null): void {
    // An empty cloud is not a divergence; the caller's push bootstraps the row.
    if (!remote) {
      this.clearPending();
      return;
    }
    // Security boundary: a tampered row must not smuggle an odd-shaped config —
    // or one named `lines` — as far as the UI, which is itself an attack surface.
    const connections = sanitizeConnections(remote.connections);
    if (setEqual(connections, this.connections)) {
      // Converged — also forget any rejection, so a later change prompts again.
      this.clearPending(true);
      return;
    }
    const rejected = this.syncState.rejected;
    if (rejected && setEqual(connections, rejected.connections)) {
      // "Keep mine" was already answered for exactly this remote content. Stay
      // quiet; the caller's push still retries overwriting the row.
      this.clearPending();
      return;
    }
    const pending = this.syncState.pending;
    this.syncState = {
      ...this.syncState,
      pending: {
        connections,
        remoteUpdatedAt: typeof remote.updatedAt === 'number' ? remote.updatedAt : 0,
        // Same remote content already pending: keep the original stamp, which is
        // the client's dedupe key for "don't re-open a modal I dismissed".
        detectedAt:
          pending && setEqual(pending.connections, connections) ? pending.detectedAt : Date.now(),
      },
      rejected: null, // remote moved on — an old answer no longer applies
    };
    this.persistSync();
    this.onReview?.(this.review());
  }

  /** The staged review with a freshly recomputed diff, so the UI never shows a stale one. */
  review(): McpConnectionsReview | null {
    const pending = this.syncState.pending;
    if (!pending) return null;
    const { added, removed } = diffConnections(this.connections, pending.connections);
    return { connections: pending.connections, added, removed, detectedAt: pending.detectedAt };
  }

  /** Install the reviewed remote list — exactly what the user was shown, re-sanitized. */
  acceptReview(): boolean {
    const pending = this.syncState.pending;
    if (!pending) return false;
    // reviewRemote already sanitized what it staged, but the pending blob
    // round-trips through disk (loadMcpSync is unvalidated), so re-run the gate:
    // the invariant "no odd-shaped or reserved-name row ever reaches list()"
    // holds locally.
    this.connections = sanitizeConnections(pending.connections);
    this.syncState = { updatedAt: Date.now(), pending: null, rejected: null };
    this.persistConnections();
    this.persistSync();
    this.onChange?.(this.connections);
    this.onReview?.(null);
    return true;
  }

  /** Keep the local list and remember the answer, keyed on the remote *content*. */
  rejectReview(): boolean {
    const pending = this.syncState.pending;
    if (!pending) return false;
    const now = Date.now();
    // Connections are untouched, but updatedAt advances on purpose: "keep mine"
    // only converges the fleet if this list wins the row's LWW and is pushed back
    // over the remote one.
    this.syncState = {
      updatedAt: now,
      pending: null,
      rejected: { connections: pending.connections, rejectedAt: now },
    };
    this.persistSync();
    this.onChange?.(this.connections); // idempotent client-side; also unblocks the push
    this.onReview?.(null); // closes the modal in this user's other tabs
    return true;
  }

  /**
   * Store the header values for one connection, dropping any whose name is no
   * longer declared. Absent `headers` leaves what is on disk alone, which is
   * what makes an edit that only renames a server keep working.
   */
  private writeSecrets(connection: McpConnection, headers?: Record<string, string>): void {
    const declared = new Set(connection.headerKeys ?? []);
    const merged: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.secrets[connection.id] ?? {})) {
      if (declared.has(name)) merged[name] = value;
    }
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        // Only declared names, and only non-empty values: an empty box in the
        // form means "leave it as it is", not "erase the token".
        if (!declared.has(name) || typeof value !== 'string' || !value) continue;
        merged[name] = value;
      }
    }
    const next = { ...this.secrets };
    if (Object.keys(merged).length) next[connection.id] = merged;
    else delete next[connection.id];
    this.secrets = next;
    this.persistSecrets();
  }

  /** Persist a local change, notify, and re-evaluate any review against the new list. */
  private commit(): void {
    this.syncState = { ...this.syncState, updatedAt: Date.now() };
    this.persistConnections();
    const pending = this.syncState.pending;
    // A local edit can resolve the divergence outright, or merely change the diff
    // being asked about. Either way the UI only ever renders diff(local, remote).
    if (pending && setEqual(this.connections, pending.connections)) {
      this.syncState = { ...this.syncState, pending: null, rejected: null };
      this.persistSync();
      this.onChange?.(this.connections);
      this.onReview?.(null);
      return;
    }
    this.persistSync();
    this.onChange?.(this.connections);
    if (pending) this.onReview?.(this.review());
  }

  /** Drop a staged review (and optionally the remembered rejection); notifies only on change. */
  private clearPending(alsoRejected = false): void {
    const hadPending = this.syncState.pending !== null;
    const hadRejected = this.syncState.rejected !== null;
    if (!hadPending && !(alsoRejected && hadRejected)) return;
    this.syncState = {
      ...this.syncState,
      pending: null,
      rejected: alsoRejected ? null : this.syncState.rejected,
    };
    this.persistSync();
    if (hadPending) this.onReview?.(null);
  }

  // Persistence is best-effort: a throw here would take down the whole
  // buildUserContext, and the in-memory list still governs this run.
  private persistConnections(): void {
    try {
      this.store.saveMcpConnections(this.connections);
    } catch (err) {
      console.warn('[mcp] could not persist connections:', err);
    }
  }

  private persistSync(): void {
    try {
      this.store.saveMcpSync(this.syncState);
    } catch (err) {
      console.warn('[mcp] could not persist connection sync state:', err);
    }
  }

  private persistSecrets(): void {
    try {
      this.store.saveMcpSecrets(this.secrets);
    } catch {
      // The error is swallowed rather than logged with its cause: fs errors quote
      // the path, and nothing about this file belongs in a log line.
      console.warn('[mcp] could not persist connection headers');
    }
  }
}
