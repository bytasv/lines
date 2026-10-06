/**
 * User-managed MCP servers, persisted via the injected Store and synced like the
 * guard allowlist — which this module is deliberately a structural copy of
 * (`autoGuard.ts` `GuardAllowlist`): a user-level, list-shaped setting with
 * intent-based edits, a never-auto-applied cross-machine review, and one
 * `onChange` hook the bridge hangs both the broadcast and the push off.
 *
 * The one thing it adds is a credential boundary. Header values are what an
 * HTTP MCP server authenticates with, and env values what a stdio one does, so
 * both live in local-only files of their own: `blob()` (synced to storage) and
 * the `mcpConnections` broadcast carry header and env var *names* only, and
 * `serverConfigs()` — read on the bridge, on its way into the worker — is the
 * single place a value is ever attached (with `codexServerConfigs()`, its codex
 * twin).
 *
 * Env values used to ride on the connection itself, and were synced to storage
 * with it. The constructor moves any it still finds there into the env file —
 * see the load migration — and nothing writes them back.
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

/**
 * Validate + dedupe an untrusted list (this disk, or a storage row) into
 * canonical rows, which carry env var names and never a value.
 *
 * `inlineEnv`, when given, collects the values a row did carry, keyed by the id
 * it ended up with: that is how the load migration keeps the keys an older
 * build stored inline. Remote ingest passes nothing, so a value in a pulled row
 * — one written before names-only sync, or a tampered one — goes nowhere.
 */
function sanitizeConnections(raw: unknown, inlineEnv?: McpConnectionSecrets): McpConnection[] {
  if (!Array.isArray(raw)) return [];
  const out: McpConnection[] = [];
  for (const item of raw) {
    const norm = normalizeConnection(item as McpConnectionInput);
    if ('error' in norm) continue;
    // The name is the MCP namespace and the id is the sync identity; a repeat of
    // either would make two rows claim one thing.
    if (out.some((c) => c.name === norm.connection.name || c.id === norm.connection.id)) continue;
    out.push(norm.connection);
    if (inlineEnv) {
      const values = declaredValues((item as McpConnectionInput | null)?.env, norm.connection.envKeys);
      if (values) inlineEnv[norm.connection.id] = values;
    }
    if (out.length === MCP_CONNECTIONS_MAX) break;
  }
  return out;
}

/** Order-insensitive set equality — the only comparison divergence detection uses. */
function setEqual(a: McpConnection[], b: McpConnection[]): boolean {
  const { added, removed } = diffConnections(a, b);
  return added.length === 0 && removed.length === 0;
}

/**
 * The sync file as loaded, re-run through the gate. A build that predates
 * names-only sync staged pulled rows with their env values in them, and kept
 * them on disk for as long as the review — or a rejection of it — lived;
 * sanitizing reduces those to names. A pending list that differed from `local`
 * only by such values is no divergence any more, so it is dropped rather than
 * served as a review with nothing in it.
 */
function scrubbedSyncState(loaded: McpSyncState, local: McpConnection[]): McpSyncState {
  const pending = loaded.pending && {
    ...loaded.pending,
    connections: sanitizeConnections(loaded.pending.connections),
  };
  const rejected = loaded.rejected && {
    ...loaded.rejected,
    connections: sanitizeConnections(loaded.rejected.connections),
  };
  return {
    // No sync file yet. Stamp now, or the storage row would be written with a
    // 1970 timestamp and always lose its LWW.
    updatedAt: loaded.updatedAt || Date.now(),
    pending: pending && !setEqual(pending.connections, local) ? pending : null,
    rejected,
  };
}

/** The string values `stored` holds for the names a connection declares; undefined when none. */
function declaredValues(
  stored: unknown,
  declared: string[] | undefined,
): Record<string, string> | undefined {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  const out: Record<string, string> = {};
  for (const name of declared ?? []) {
    const value = (stored as Record<string, unknown>)[name];
    if (typeof value === 'string') out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * One connection's credential values after an edit: only `declared` names
 * survive, and an incoming non-empty string replaces the stored one. Absent or
 * empty means "leave it as it is" — the client never holds a stored value to
 * send back, so an empty box in the form cannot mean "erase the token".
 */
function mergeCredentials(
  stored: Record<string, string> | undefined,
  declared: string[] | undefined,
  incoming: unknown,
): Record<string, string> {
  const names = new Set(declared ?? []);
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(stored ?? {})) {
    if (names.has(name)) merged[name] = value;
  }
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    for (const [name, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (!names.has(name) || typeof value !== 'string' || !value) continue;
      merged[name] = value;
    }
  }
  return merged;
}

/** `all` with one connection's values replaced — or its entry gone, once none are left. */
function withValues(
  all: McpConnectionSecrets,
  id: string,
  values: Record<string, string>,
): McpConnectionSecrets {
  const next = { ...all };
  if (Object.keys(values).length) next[id] = values;
  else delete next[id];
  return next;
}

/** The serializable SDK config one connection describes, or null when it is off. */
function serverConfig(
  connection: McpConnection,
  headers: Record<string, string> | undefined,
  env: Record<string, string> | undefined,
): Record<string, unknown> | null {
  if (!connection.enabled) return null;
  if (connection.transport === 'stdio') {
    const vars = declaredValues(env, connection.envKeys);
    return {
      type: 'stdio',
      command: connection.command,
      ...(connection.args ? { args: connection.args } : {}),
      ...(vars ? { env: vars } : {}),
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
 * The environment variable a codex-hosted connection reads its bearer token from.
 *
 * Codex takes an HTTP server's credential as the *name* of an environment
 * variable (`bearer_token_env_var`), never as a literal in `config.toml` — which
 * is a better trust boundary than the Claude path's inline `headers`, and the
 * reason the token still never lands on disk. The name is derived from the
 * connection id, not its display name, so renaming a connection cannot orphan a
 * variable the app-server was spawned with.
 */
export function codexBearerEnvVar(id: string): string {
  return `LINES_MCP_BEARER_${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/** Why a connection the user enabled cannot be handed to codex. */
export type CodexMcpSkip = 'headers-unsupported' | 'sse-unsupported';

export interface CodexMcpConfig {
  /** `mcp_servers` in codex's `config.toml` shape — the whole table, verbatim. */
  servers: Record<string, unknown>;
  /** Bearer tokens, keyed by the env var name codex was told to read. */
  env: Record<string, string>;
  /** Enabled connections deliberately left out, so the UI can say why. */
  skipped: { name: string; reason: CodexMcpSkip }[];
}

/**
 * One connection in codex's `config.toml` shape.
 *
 * The shape is the CLI's own, confirmed against `codex mcp add` on 0.154.0
 * rather than taken from docs: stdio servers carry `command`/`args`/`env`, and
 * streamable-HTTP servers carry `url`/`bearer_token_env_var`. There is no
 * `type` discriminator and no `timeout` — codex infers the transport from which
 * keys are present, so emitting a stray key makes it reject the whole table.
 */
function codexServerConfig(
  connection: McpConnection,
  headers: Record<string, string> | undefined,
  env: Record<string, string> | undefined,
): { config: Record<string, unknown> } | { skip: CodexMcpSkip } {
  if (connection.transport === 'stdio') {
    const vars = declaredValues(env, connection.envKeys);
    return {
      config: {
        command: connection.command,
        ...(connection.args?.length ? { args: connection.args } : {}),
        ...(vars ? { env: vars } : {}),
      },
    };
  }
  // Legacy SSE is not streamable HTTP. Codex 0.154's `url` server speaks the
  // latter only, so pointing it at an SSE endpoint fails at handshake with a
  // message about the initialize response — worse than declining it here.
  if (connection.transport === 'sse') return { skip: 'sse-unsupported' };
  const names = Object.keys(headers ?? {});
  const bearer = names.find((name) => name.toLowerCase() === 'authorization');
  // Codex models an HTTP server's credential as a bearer token and nothing else.
  // A connection carrying any other header (an `X-Api-Key`, a tenant id) cannot
  // be expressed, and shipping it without them would connect as the wrong
  // principal or not at all.
  if (names.some((name) => name.toLowerCase() !== 'authorization')) {
    return { skip: 'headers-unsupported' };
  }
  return {
    config: {
      url: connection.url,
      ...(bearer ? { bearer_token_env_var: codexBearerEnvVar(connection.id) } : {}),
    },
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
  /** Header values, by connection id. */
  private secrets: McpConnectionSecrets;
  /** Stdio env values, by connection id. */
  private envSecrets: McpConnectionSecrets;
  private syncState: McpSyncState;

  /** Fired on every local list change — a UI edit or an accepted review — with `list()`. */
  onChange?: (connections: McpConnection[]) => void;
  /** Fired when a remote divergence is staged, recomputed, or cleared. */
  onReview?: (review: McpConnectionsReview | null) => void;

  constructor(private store: Store) {
    // First, so a file an older build wrote 0644 is owner-only even when this
    // run never has a reason to rewrite it.
    store.secureMcpFiles();
    const raw = store.loadMcpConnections<unknown[]>([]);
    const inlineEnv: McpConnectionSecrets = {};
    this.connections = sanitizeConnections(raw, inlineEnv);
    this.secrets = store.loadMcpSecrets();
    this.envSecrets = store.loadMcpEnv();
    // Env values an older build kept on the connection itself — which is how
    // they reached storage — move to the env file (a value found inline wins: it
    // is either the only copy, or a hand edit). Moved *before* the connections
    // file is rewritten without them, and that rewrite skipped if the move did
    // not land: a failed write may cost a retry next start, never the key.
    let moved = true;
    if (Object.keys(inlineEnv).length) {
      const next = { ...this.envSecrets };
      for (const [id, values] of Object.entries(inlineEnv)) next[id] = { ...next[id], ...values };
      this.envSecrets = next;
      moved = this.persistEnv();
    }
    // Load-time migration, as GuardAllowlist does: rewrite once, and only when
    // the sanitized form actually differs, so a second construction leaves the
    // file's bytes alone.
    if (moved && JSON.stringify(raw) !== JSON.stringify(this.connections)) this.persistConnections();
    // The sync file gets the same once-only rewrite, for the same reason.
    const loaded = store.loadMcpSync();
    this.syncState = scrubbedSyncState(loaded, this.connections);
    if (JSON.stringify(this.syncState) !== JSON.stringify(loaded)) this.persistSync();
  }

  /**
   * The list as this machine's browsers get it (hello, and the broadcast via
   * `onChange`): each stdio row carries `envValuesHeld`, the env names this
   * machine has a value for, so the form can say "saved" about a value it is
   * never sent. Names only, like everything else here.
   */
  list(): McpConnection[] {
    return this.connections.map((connection) => {
      const held = declaredValues(this.envSecrets[connection.id], connection.envKeys);
      return held ? { ...connection, envValuesHeld: Object.keys(held) } : connection;
    });
  }

  /**
   * The synced form: connections (header and env var names only) plus the
   * ordering timestamp. Built from the canonical rows, never from `list()`: which
   * values a machine holds is that machine's business, and another one reading
   * this machine's marks would say "saved" about a key it does not have.
   */
  blob(): McpConnectionsBlob {
    return { connections: this.connections, updatedAt: this.syncState.updatedAt };
  }

  get pendingReview(): boolean {
    return this.syncState.pending !== null;
  }

  /**
   * Every enabled connection as SDK query options, keyed by MCP namespace, with
   * header values and stdio env values spliced in from the local-only files. The
   * only method whose output holds a credential — see `buildQueryOptions`, which
   * is its one caller.
   */
  serverConfigs(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const connection of this.connections) {
      const config = serverConfig(
        connection,
        this.secrets[connection.id],
        this.envSecrets[connection.id],
      );
      if (config) out[connection.name] = config;
    }
    return out;
  }


  /**
   * Every enabled connection in codex's `config.toml` shape, plus the bearer
   * tokens the app-server child must be spawned with.
   *
   * The codex twin of `serverConfigs()`, and the only other method whose output
   * holds a credential. Two things make it a translation rather than a rename:
   * codex takes a token by env-var *name*, and it supports a narrower set of
   * connections than the Claude path does — see `codexServerConfig`. Anything it
   * cannot express is reported in `skipped` rather than dropped silently.
   */
  codexServerConfigs(): CodexMcpConfig {
    const servers: Record<string, unknown> = {};
    const env: Record<string, string> = {};
    const skipped: { name: string; reason: CodexMcpSkip }[] = [];
    for (const connection of this.connections) {
      if (!connection.enabled) continue;
      const headers = this.secrets[connection.id];
      const result = codexServerConfig(connection, headers, this.envSecrets[connection.id]);
      if ('skip' in result) {
        skipped.push({ name: connection.name, reason: result.skip });
        continue;
      }
      servers[connection.name] = result.config;
      const bearer = Object.entries(headers ?? {}).find(
        ([name]) => name.toLowerCase() === 'authorization',
      );
      if (bearer) env[codexBearerEnvVar(connection.id)] = bearer[1];
    }
    return { servers, env, skipped };
  }

  /** Header names this machine actually holds a value for, so the UI can say what is missing. */
  secretKeys(id: string): string[] {
    return Object.keys(this.secrets[id] ?? {});
  }

  /**
   * Add a connection. `headers` are the secret values for its `headerKeys`, and
   * `input.env` the values for its env var names; both are written to local-only
   * files and never enter the list.
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
    this.writeEnv(norm.connection, input.env);
    this.commit();
    return { ok: true, connection: norm.connection };
  }

  /**
   * Replace one connection wholesale, keeping its id. `headers` omitted keeps
   * the stored values, and so does an `input.env` that leaves a name out — which
   * is what the Settings toggle sends, holding names only; a name dropped from
   * `headerKeys` or `envKeys` drops its value with it, so a removed credential
   * does not linger on disk.
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
    this.writeEnv(norm.connection, input.env);
    this.commit();
    return { ok: true, connection: norm.connection };
  }

  /** Drop a connection and its stored header and env values; true when one matched. */
  remove(id: string): boolean {
    const next = this.connections.filter((c) => c.id !== id);
    if (next.length === this.connections.length) return false;
    this.connections = next;
    if (this.secrets[id]) {
      this.secrets = withValues(this.secrets, id, {});
      this.persistSecrets();
    }
    if (this.envSecrets[id]) {
      this.envSecrets = withValues(this.envSecrets, id, {});
      this.persistEnv();
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
    // Nor a credential: env values in a row written before names-only sync are
    // reduced to their names here, so they are neither staged nor compared.
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
    // Sanitized for the same reason acceptReview does it: reviewRemote staged a
    // clean list, but the pending blob round-trips through disk and loadMcpSync
    // validates only `updatedAt`. Unsanitized, an edited (or half-written)
    // mcp-connections-sync.json puts a row missing `enabled` straight on the wire,
    // where the review modal reads `.enabled` off it and throws.
    const connections = sanitizeConnections(pending.connections);
    const { added, removed } = diffConnections(this.connections, connections);
    return { connections, added, removed, detectedAt: pending.detectedAt };
  }

  /** Install the reviewed remote list — exactly what the user was shown, re-sanitized. */
  acceptReview(): boolean {
    const pending = this.syncState.pending;
    if (!pending) return false;
    // reviewRemote already sanitized what it staged, but the pending blob
    // round-trips through disk (loadMcpSync is unvalidated), so re-run the gate:
    // the invariant "no odd-shaped or reserved-name row ever reaches list()"
    // holds locally. No credential comes from the remote list — it holds names
    // only — and this machine's own values stay in its files, keyed by id, so a
    // connection both sides have keeps working here.
    this.connections = sanitizeConnections(pending.connections);
    this.syncState = { updatedAt: Date.now(), pending: null, rejected: null };
    this.persistConnections();
    this.persistSync();
    this.onChange?.(this.list());
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
    this.onChange?.(this.list()); // idempotent client-side; also unblocks the push
    this.onReview?.(null); // closes the modal in this user's other tabs
    return true;
  }

  /**
   * Store the header values for one connection, dropping any whose name is no
   * longer declared. Absent `headers` leaves what is on disk alone, which is
   * what makes an edit that only renames a server keep working.
   */
  private writeSecrets(connection: McpConnection, headers?: Record<string, string>): void {
    const merged = mergeCredentials(this.secrets[connection.id], connection.headerKeys, headers);
    this.secrets = withValues(this.secrets, connection.id, merged);
    this.persistSecrets();
  }

  /**
   * The same for a stdio connection's env values, against its `envKeys`. Written
   * only when something changed, so editing an HTTP connection does not create
   * the env file.
   */
  private writeEnv(connection: McpConnection, env: unknown): void {
    const stored = this.envSecrets[connection.id];
    const merged = mergeCredentials(stored, connection.envKeys, env);
    if (JSON.stringify(merged) === JSON.stringify(stored ?? {})) return;
    this.envSecrets = withValues(this.envSecrets, connection.id, merged);
    this.persistEnv();
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
      this.onChange?.(this.list());
      this.onReview?.(null);
      return;
    }
    this.persistSync();
    this.onChange?.(this.list());
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

  /** True when the write landed — the load migration strips inline values only once it has. */
  private persistEnv(): boolean {
    try {
      this.store.saveMcpEnv(this.envSecrets);
      return true;
    } catch {
      // Swallowed without its cause, for the reason persistSecrets gives.
      console.warn('[mcp] could not persist connection env values');
      return false;
    }
  }
}
