# MCP connections

Covers: `mcp-connections`, `mcp-connection-oauth`.

## Purpose

Let a user add a third-party MCP server (Figma, Linear, a local stdio server, …) from Settings,
see whether it connected in a given session, and authorize it — with the connection list synced
across machines like the guard allowlist, and credential values (HTTP header values, a stdio
server's environment values) never leaving the machine that holds them.

Before this feature, adding an MCP server meant hand-editing `.mcp.json` or `~/.claude/settings.json`
on disk and running the interactive `claude` CLI once to complete any OAuth handshake. That path
still works (`settingSources: ['user', 'project']` reaches every session unchanged) — this feature
is an additive, UI-managed way to do the same thing, not a replacement for it.

The Lines in-process MCP server (workflow tools; see
[workflow-mcp-tools](workflow-mcp-tools.md)) is unrelated and unchanged, except that the worker
had to stop *overwriting* `mcpServers` with it and start *merging* — see Architectural rules.

## Entry points

- Settings modal → **Connections** pane: add/edit/remove a connection, toggle it on/off, see its
  live status, authorize it. Authorizing needs no running turn and no particular status reading —
  see Data flow → OAuth: authorize.
- `web/src/components/McpConnectionsReviewModal.tsx`, mounted at the app root (not inside
  Settings) — a divergent connection list pulled from another machine.
- `server/src/sessions.ts` `buildQueryOptions` — every session push includes the enabled
  connections' server configs.
- `server/src/worker.ts` `ensureSession` — merges the user's `mcpServers` with the Lines server
  before calling `query()`.
- `server/src/index.ts` `handleOAuthCallback` — the bridge's `/mcp-oauth/callback` HTTP route, the
  landing page an OAuth provider redirects a browser back to.
- `web/src/components/PermissionPrompt.tsx` — a permission card rendered from
  `PermissionRequestData.elicitation` (`mode: 'url'` only) when a connected server asks the user
  to sign in mid-session.

## Files

- `shared/types.ts` — `McpConnection`, `McpTransport`, `McpConnectionsBlob`,
  `McpConnectionsReview`, `McpConnectionError`, `McpConnectionInput`, `McpConnectionSecrets`,
  `RESERVED_MCP_SERVER_NAMES`, `MCP_CONNECTIONS_MAX`; `normalizeConnection`, `sameConnection`,
  `describeConnection`, `diffConnections`, `isMcpEnvName`; `McpConnection.envKeys`/
  `envValuesHeld`; the `addMcpConnection`/`updateMcpConnection`/
  `removeMcpConnection`/`reviewMcpConnections`/`mcpServerStatus`/`authorizeMcpConnection` client
  messages and their `MESSAGE_AUTHZ` entries (all owner-only); the `mcpConnections`/
  `mcpConnectionsReview`/`mcpServerStatus`/`mcpAuthStarted`/`mcpAuthCompleted` server messages
  (`mcpServerStatus` carries an optional `warm`; `mcpAuthStarted` an optional `alreadyAuthorized`),
  plus the account-wide `mcpStatuses`;
  `McpServerStatusInfo`, `McpElicitation`, and `PermissionRequestData.elicitation`.
- `server/src/mcpConnections.ts` — `McpConnections`, the store-backed list + review lifecycle
  class, structurally a copy of `GuardAllowlist` (`server/src/autoGuard.ts`); the env-value split
  (`envSecrets`, `writeEnv`, `mergeCredentials`, `declaredValues`), the load migration that moves
  inline env values out, and `scrubbedSyncState`.
- `server/src/mcpAuth.ts` — the OAuth shim: `normalizeAuthStart`, `unsupportedReason`,
  `McpAuthPending` (the pending-handshake map keyed by OAuth `state`), `PENDING_TTL_MS` (exported,
  because `SessionManager` bounds its query hold on the same clock), `inspectInstalledSdk`; also
  re-exports `MCP_AUTH_METHODS`/`mcpAuthSupport`/`McpAuthApi` from `workerProtocol.ts`.
- `server/src/workerProtocol.ts` — `mergeMcpServers` (the worker-side merge helper),
  `staleDynamicServers` (which live servers a replace left behind — see Symbols);
  `MCP_AUTH_METHODS`, `mcpAuthSupport`, `McpAuthApi`, `McpAuthSupport` (the runtime capability
  probe for the untyped SDK OAuth methods — see Architectural rules); `AskMethod` extended with
  `'mcpStatus' | 'mcpAuthStart' | 'mcpAuthCallback' | 'mcpSetServers' | 'mcpWarm'`;
  `BridgeToWorker`'s `ask` message extended with an optional `params` field.
- `server/src/worker.ts` — `runAsk` (dispatches the `AskMethod` values, `mcpSetServers` among
  them); `handleAsk`'s `mcpWarm` branch, ahead of the liveness check because creating the query is
  what it does; `ensureSession`'s `mcpServers` merge and its `SessionState.linesServer` stash.
- `server/src/workerClient.ts` — `WorkerClient.mcpStatus`, `.mcpAuthStart`, `.mcpAuthCallback`,
  `.mcpSetServers`, `.mcpWarm`.
- `server/src/sessions.ts` — `buildQueryOptions`'s `mcpServers` block; `applyMcpServers` (push
  the list onto live queries); `warmQuery` (bring a query up with no turn); `mcpServerStatus`
  (reads live status, warming only when asked, falling back to the last `system:init` reading);
  `startMcpAuth`/`completeMcpAuth` (the two OAuth legs); `authHolds`/`holdForAuth`/
  `releaseAuthHold`/`heldForAuth` and `recycleIdleQueries`' skip for them;
  `normalizeMcpStatuses`; the `system:init` handler stashing `LiveState.mcpServers`;
  `findPermissionRequest`'s `toolName || elicitation` predicate; `askPermission`'s `elicitation`
  parameter.
- `server/src/store.ts` — `loadMcpConnections`/`saveMcpConnections` (`mcp-connections.json`, a
  bare array), `loadMcpSync`/`saveMcpSync` (`mcp-connections-sync.json`, mirroring
  `GuardSyncState`), `loadMcpSecrets`/`saveMcpSecrets` (`mcp-secrets.json`) and
  `loadMcpEnv`/`saveMcpEnv` (`mcp-env.json`) — both **never** read by `sync.ts` —
  `writeMcpFile` (every MCP file written `0600`), `secureMcpFiles` (the startup chmod).
- `server/src/sync.ts` — `PulledState.mcpConnections`, the `/mcp-connections` pull (caught on its
  own like `/guard-allowlist`, so an unmigrated storage server 500s only that one resource),
  `pushMcpConnections`; `withoutMcpValues`, applied to both.
- `server/src/userContext.ts` — wires `mcp.onChange`/`mcp.onReview` to broadcast + push, and calls
  `mcp.reviewRemote` before the push block in `syncNow`, mirroring the guard wiring — plus one line
  the guard has no equivalent of, `sessions.applyMcpServers()` (see Data flow → Reaching a
  session).
- `server/src/index.ts` — the six MCP message cases (`authorizeMcpConnection` answering
  `alreadyAuthorized`, and taking a query hold beside `mcpAuthPending.start`); `boundPort`,
  `MCP_OAUTH_CALLBACK_PATH`, `mcpAuthPending`, `handleOAuthCallback` (releasing the hold on every
  settle path), `oauthPage`; `onEnded`'s `mcpAuthPending.forgetSession` and `releaseAuthHold`
  calls.
- `storage/prisma/schema.prisma`, `storage/src/index.ts` — the `mcp_connections` table and its
  `GET`/`PUT /mcp-connections` routes: `PUT` drops any `headers` field and reduces a stdio `env`
  to its names (`mcpEnvKeys`), independent of the bridge already never sending either, and `GET`
  serves a values-free copy of any row still holding them (`servedMcpConnections`).
- `storage/prisma/migrations/20261006010000_mcp_env_names_only/migration.sql` — scrubs the rows
  written before names-only sync: a non-empty `env` map becomes its names (sorted) as `envKeys`,
  an empty or malformed one is dropped, and a row with no `env` is not touched.
- `web/src/store.ts` — `mcpConnections`/`mcpReview`/`mcpStatus`/`mcpAuth` state, their actions
  (`requestMcpStatus` takes a `warm` flag), and the matching `ServerMessage` cases; deliberately
  absent from `pushSettings()`.
- `web/src/lib/mcpConnections.ts` — `mcpConnectionErrorText`, `mcpStatusMeta`,
  `MCP_STATUS_UNKNOWN`.
- `web/src/components/McpConnectionsSection.tsx` — the Settings pane: connection list, add form
  (client-side `normalizeConnection` before send), status dot, Authorize button (offered on status
  alone no longer — see Business rules), Refresh (the one warming caller); write-only stdio env
  editing (`EnvFields` in the add form, `EnvSummary`/`EnvEditor` on a row, `envDraftIssue`,
  `withoutHeldMarks`).
- `web/src/components/McpConnectionsReviewModal.tsx` — accept/reject a divergent remote list.
- `web/src/components/SettingsModal.tsx` — the `'connections'` section, registered like
  `'allowlist'`.
- `web/src/components/PermissionPrompt.tsx` — `toolPresentation`'s `data.elicitation` branch
  (checked before `data.toolName`, since an elicitation carries no tool name).
- `web/src/lib/transcript.ts` — an unresolved elicitation permission item is a fold boundary, like
  `ExitPlanMode`.

## Symbols

- `McpConnection` — `{ id, name, transport, url?, command?, args?, envKeys?, envValuesHeld?,
  headerKeys?, timeout?, enabled }`. `headerKeys` and `envKeys` are names only; values never
  appear on this type. `envValuesHeld` names which `envKeys` *this* machine holds a value for —
  set by the bridge on what it sends its own browsers, never synced, dropped on the way in.
  `McpConnectionInput.env` is the one place a value may ride, on its way *into* the bridge.
- `normalizeConnection(raw)` — the single validation gate every writer runs through (Settings
  form, wire handler, load migration, remote ingest): canonicalizes or returns an
  `McpConnectionError`. Mints an id when the input has none. `review()` also re-runs it (via
  `sanitizeConnections`) on the pending blob before returning it, since that blob round-trips
  through `mcp-connections-sync.json`, which is validated only on `updatedAt` — a hand-edited or
  half-written file is otherwise the one path by which an unvalidated row would reach the review
  modal.
- `RESERVED_MCP_SERVER_NAMES` — `['lines']`; duplicated (not imported) from
  `server/src/mcpWorkflowTools.ts`'s `LINES_MCP_SERVER` because that module pulls in the whole
  bridge graph — `mcpConnections.test.ts` asserts the two agree.
- `McpConnections` (class) — `list()` (the canonical rows plus each stdio row's `envValuesHeld`,
  for this machine's browsers), `blob()` (synced form, header and env names only, built from the
  canonical rows and never from `list()`), `serverConfigs()` (SDK-facing form, header and stdio
  env **values** spliced in from the two local files — with its codex twin `codexServerConfigs()`,
  the one place a credential value exists in a served object), `add`/`update`/`remove`,
  `reviewRemote`/`review`/`acceptReview`/`rejectReview`.
- `withoutMcpValues(blob)` (`sync.ts`) — a connection list with every credential value taken out:
  `headers` dropped, an `env` map reduced to its names in `envKeys`; a row with nothing to take
  out keeps its exact shape.
- `isMcpEnvName(name)` — whether `normalizeConnection` keeps an env var name (anything but `=` and
  NUL, up to 128 characters); it skips any other silently, so the form checks first and says why.
- `mergeMcpServers(fromOptions, linesServerName, linesServer)` — combines the user's connections
  with the Lines server, Lines spread **last** so it always wins a name collision. Lives in
  `workerProtocol.ts` (not `worker.ts`) so it is testable without a live query. Used twice: at
  query creation, and in every `setMcpServers` payload.
- `staleDynamicServers(statuses, payload)` — the names a replace left running. `setMcpServers`
  adds, updates, and destroys an omitted **in-process** server, but does *not* remove an omitted
  **process-based** one, so a disabled or deleted connection has to be switched off by name.
  Filters on `scope === 'dynamic'`, which is the SDK's marker for "added by this client": a
  settings-file or `claudeai-proxy` server is the user's own and is never touched.
- `applyMcpServers()` — pushes `serverConfigs()` onto every session that already has a live query,
  so a Settings edit reaches running sessions. Never warms: an edit must not spawn a CLI child per
  session, and `no-live-session` is a no-op here.
- `warmQuery(sessionId)` — brings a session's query up without running a turn, and answers with its
  MCP status. Goes through the same token resolution a push does and records `queryTokens`, or the
  next real turn would recycle the query it just created.
- `authHolds` / `holdForAuth` / `releaseAuthHold` — sessions whose query must survive
  `recycleIdleQueries` for the length of an OAuth handshake. Timestamped and bounded by
  `PENDING_TTL_MS`, so an abandoned handshake stops pinning a CLI child open.
- `mcpAuthSupport(q)` — runtime probe: does this `Query` handle still expose
  `mcpAuthenticate`/`mcpSubmitOAuthCallbackUrl`? Returns `{ ok: false, missing }` instead of
  throwing when the SDK has changed shape.
- `normalizeAuthStart(raw)` — validates the undocumented `mcpAuthenticate` response; tolerates an
  `authorizationUrl` rename, refuses a non-`http(s)` `authUrl`.
- `McpAuthPending` — in-memory map of OAuth `state` → `{ userId, sessionId, serverName }`,
  single-use, TTL-bounded, constant-time compared, per-bridge (a restart forgets every pending
  handshake, which is correct — see Business rules).
- `unsupportedReason(missing)` — the one place the "this SDK build no longer exposes X" copy is
  written, so the client-visible string and the throw site cannot drift apart.

## Data flow

### Connection sync (mirrors [permissions-and-plan-mode](permissions-and-plan-mode.md)'s guard
allowlist exactly)

A local change (Settings add/edit/remove) calls `McpConnections.add`/`update`/`remove`, which
persists to `mcp-connections.json`, fires `onChange` (broadcast `mcpConnections` + push to
storage unless a review is pending), and re-evaluates any staged review.

On connect/reconnect, `syncNow` pulls `/mcp-connections` and calls
`mcp.reviewRemote(pulled.mcpConnections)` **before** the push block — a fresh machine's empty list
must not silently overwrite a populated cloud row before the user has been asked. If the remote
list (re-validated) differs from the local one by content, a review is staged and broadcast as
`mcpConnectionsReview`; connections are untouched until accept/reject. `review()` re-validates
again on every read (see Business rules), so a review reported to the client is sanitized twice
over: once when it was staged, once when it is served.

### Credential values stay on their machine

A connection carries header and env var *names* (`headerKeys`, `envKeys`); the values live in
this machine's `mcp-secrets.json` and `mcp-env.json`, keyed by connection id, and only
`serverConfigs()`/`codexServerConfigs()` attach them. `normalizeConnection` keeps only the names
of whatever `env` map arrives, so every shape built from canonical rows — `blob()`, the
`mcpConnections` broadcast, a staged review — is value-free however a row got in; `add`/`update`
read a client's typed values off the raw input first and file them locally (`writeEnv`, through
the same `mergeCredentials` rule header values follow). `sync.ts` strips again with
`withoutMcpValues` on both sides of the storage boundary — before `req` signs a push, so the
signature covers exactly the bytes storage keeps, and after a pull verifies — and storage itself
drops values on `PUT` and serves a values-free copy on `GET`. Migration
`20261006010000_mcp_env_names_only` scrubbed the rows already written; a scrubbed row's signature
no longer verifies, so the bridge refuses it as forged, treats the resource as empty, and pushes
its own names-only copy on the same sync.

Because values are per machine, accepting a remote list takes no value from it — this machine's
own stay in its files, keyed by id, so a connection both sides have keeps working — and
`sameConnection` compares env names, so a pull from a machine without the values is no divergence.
What a form can learn is `envValuesHeld`: `list()` adds it to what this bridge sends its own
browsers (hello and the broadcast), and `normalizeConnection` never keeps it, so no client or
remote row can claim a value this machine does not hold.

The constructor runs the migrations an older build makes necessary, each a one-time rewrite:
`secureMcpFiles` chmods every MCP file to `0600` first (a file an older build left `0644` keeps
that mode until rewritten, and an unchanged connections file never is); env values kept inline on
a connection move to `mcp-env.json` *before* the connections file is rewritten without them, and
that rewrite is skipped if the move did not land, so a failed write costs a retry, never the key;
and `scrubbedSyncState` reduces a staged or rejected review to names, dropping a pending one that
differed from the local list only by values.

### Reaching a session

`buildQueryOptions` calls `mcp.serverConfigs()` — enabled connections only, each with its header
values or stdio env values attached from the local secrets and env files — and includes the
result as `mcpServers` in the
serialized options sent to the worker. `ensureSession` merges that map with the Lines in-process
server via `mergeMcpServers`, Lines last, and passes the combined map to `query()`.

That covers query *creation*, and `ensureSession` is idempotent — it returns an existing session
and discards the freshly built options. So a connection added afterwards reaches nothing that is
already running. `McpConnections.onChange` therefore also fires `SessionManager.applyMcpServers`,
which asks each live query to `setMcpServers` the current list. Two things make that call correct
rather than obvious:

- The payload goes through `mergeMcpServers` as well, because `setMcpServers` **destroys** an
  in-process server omitted from it — omitting `lines` returns `removed: ['lines']` and takes the
  workflow tools down with it.
- A replace cannot remove a process-based server it omits (an omitted http server keeps running on
  its old config), so the worker follows it with `toggleMcpServer(name, false)` for everything
  `staleDynamicServers` names. Both of that call's throws are expected and neither means failure:
  an unknown name throws `Server not found`, and a *successful* toggle throws
  `Server status: needs-auth`. The status read after the sweep is the answer, not the throw.

The resulting readings go out as one account-wide `mcpStatuses` message, not as N
`mcpServerStatus` ones. That is a scoping requirement, not a batching preference: `mcpServerStatus`
carries a top-level `sessionId`, so `sessionIdOf` classifies it as session-scoped and the fan-out
would hand a session guest the names, error text and statuses of the host's third-party servers.
Keying the sessions *inside* the payload makes it account-wide, which is owner-only.

Without this, the Connections pane was a dead end: a just-added connection was in no live query,
so it reported no status, so nothing offered to authorize it.

### Status

`system:init` carries `mcp_servers: {name, status}[]` — cheap, always available, but lossy (no
`error`/`scope`/`tools`). `normalizeMcpStatuses` parses it onto `LiveState.mcpServers`. The
detailed read (`SessionManager.mcpServerStatus`) asks the worker for a live
`Query.mcpServerStatus()` (`AskMethod: 'mcpStatus'`) and falls back to the last-known `init`
reading when no query is live or the read comes back empty. The Settings pane requests it for
whichever session is currently open; there is no per-connection subscription.

`warm: true` on the request additionally permits `warmQuery`, which is the only way to get a real
reading for a session that has never run a turn. Sent by the pane's Refresh button and nothing
else — opening Settings must not spawn a CLI child as a side effect.

### OAuth: elicitation (in-session, mid-turn)

A **connected** server can ask the user for something via the SDK's `onElicitation` callback,
which the worker forwards as an `elicitation` rpc. Only `mode: 'url'` is surfaced as a card
(`SessionManager.handleElicitation`) — `mode: 'form'` is declined outright, since Lines has no
form-rendering surface and answering with empty content would be answering *for* the user. The
card reuses the ordinary permission-card machinery (`askPermission`, resolution provenance, resend
replay) with `toolName: ''` and an `elicitation` payload instead of a tool call.

### OAuth: authorize (bootstrapping the first token)

Elicitation cannot bootstrap the *initial* authorization of a server reporting `needs-auth`: such
a server has not completed its MCP transport handshake, so there is no live MCP session to elicit
through. That gap is closed by a first-class flow that does not go through `onElicitation` at all:

1. **Leg 1** — the user clicks Authorize in the Connections pane. `authorizeMcpConnection` asks
   `SessionManager.startMcpAuth`, which asks the worker (`AskMethod: 'mcpAuthStart'`) to call
   `Query.mcpAuthenticate(serverName, redirectUri)` on the session's live query, with `redirectUri`
   pointed at this bridge's own `/mcp-oauth/callback`. The bridge registers the returned `state` in
   `mcpAuthPending`, takes a query hold, and answers `mcpAuthStarted` with the `authUrl`.

   If the session has no query — the normal state of a session the user added a connection for and
   has not run — `startMcpAuth` calls `warmQuery` and retries once, rather than making the user
   start a turn they do not want in order to sign in. A worker too old to implement `mcpWarm`
   answers `no-live-session` for a session it holds nothing for, which is exactly the pre-warm
   situation, so that path degrades to the old "start a turn first" copy.

   A `callbackExpected: false` answer means the CLI already holds a token for this server: there is
   no URL to visit and no callback coming, so it is reported as `alreadyAuthorized` and **no**
   pending state is registered. Read as an error, this announced a working setup as "the SDK
   returned no authorization URL".
2. The user opens that URL (a plain link, not an auto-`window.open` — a popup blocker would eat
   it) and signs in with the provider.
3. **Leg 2** — the provider redirects the browser to the bridge's HTTP callback with `state` (and
   an authorization code the bridge never inspects). `handleOAuthCallback` claims the pending
   handshake by `state`, calls `SessionManager.completeMcpAuth` (worker `AskMethod:
   'mcpAuthCallback'` → `mcpSubmitOAuthCallbackUrl` → `reconnectMcpServer` → a fresh
   `mcpServerStatus()` read), and broadcasts `mcpAuthCompleted` with the result.

Both legs must run against the **same live query**: the PKCE verifier from leg 1 lives inside that
CLI process. Two guards follow from that, in opposite directions. `worker.onEnded` calls
`mcpAuthPending.forgetSession` so a state whose session died cannot be replayed against a query
that no longer holds its verifier. And `holdForAuth` exempts the session from
`recycleIdleQueries` — which closes every settled query on a token refresh — so the verifier is
not thrown away *while* the user is still at the provider's sign-in page. The hold is released on
every settle path (both callback outcomes, a provider refusal, and the query ending) and ages out
on `PENDING_TTL_MS` regardless, so an abandoned sign-in cannot pin a CLI child open.

## Dependencies

- Storage server `mcp_connections` table, one JSON blob per user — same shape and precedent as
  `guard_allowlist` (see [agent-memory-sync](agent-memory-sync.md) for the row-per-item
  alternative this scale doesn't need).
- The permission-card infrastructure ([permissions-and-plan-mode](permissions-and-plan-mode.md)) —
  the elicitation card is a second shape of `PermissionRequestData`, not a parallel
  pending-request mechanism.
- The SDK's untyped runtime methods `Query.mcpAuthenticate`/`mcpSubmitOAuthCallbackUrl` (present
  in `sdk.mjs`, absent from `sdk.d.ts`) — guarded by `mcpAuthSupport` and pinned by
  `server/src/mcpAuth.contract.test.ts`, which fails on an SDK upgrade in either direction (see
  Architectural rules).
- [workflow-mcp-tools](workflow-mcp-tools.md) — the Lines in-process server this feature's worker
  merge must never let a same-named connection shadow.

## Tests

- `server/src/mcpConnections.test.ts` — validators through `serverConfigs()` (the real SDK config
  shape, not string comparison); reserved-name refusal, matched against
  `mcpWorkflowTools.LINES_MCP_SERVER`; CRUD + duplicate-name refusal; secret round-trip through a
  dedicated file, absent from `blob()`/`list()`; dropping a header name drops its stored value; an
  edit with no `headers` argument keeps the stored value; load-time migration. Env values: they
  reach `serverConfigs()` but never `blob()`/`list()`; they live in their own file and every MCP
  file is `0600`; an update carrying names only, or an empty value, keeps the stored one; dropping
  a name drops its value and its held mark; `envValuesHeld` rides `list()` and the broadcast, never
  `blob()`; a value entered for a name that arrived bare is held from then on; removing a
  connection removes its values; values an older build kept inline move to their own file on load;
  world-readable MCP files are tightened at startup.
- `server/src/mcpConnections.sync.test.ts` — the review lifecycle, case-for-case with
  `autoGuard.sync.test.ts`: staging, a changed field on the same id counting as a divergence,
  set-equal reorder not counting, accept/reject, reject-remembered-by-content, restart
  persistence, and that an accepted remote connection has no secret until one is entered locally;
  a connection differing only by env values is no divergence; accepting takes no env value from
  the remote and keeps this machine's own; held marks stay local (a remote row cannot claim one, a
  review carries none); a review an older build staged loses its env values on load, and one that
  differed only by them is dropped.
- `server/src/sync.credentials.test.ts` — MCP connections leave with credential names only, signed
  over exactly what was sent; a verified row still carrying env values hands this machine names
  only; a legacy row whose values storage scrubbed is refused as forged, so the push replaces it.
- `storage/src/schema.credentials.test.ts` — opt-in on a scratch Postgres
  (`STORAGE_TEST_DATABASE_URL`, migrations applied): the env-scrub migration's own SQL turns env
  values into names and changes nothing else in the row, and leaves a row with no `env` untouched.
- `server/src/workerMcpMerge.test.ts` — `mergeMcpServers`: neighbours survive, Lines wins a name
  collision, malformed/absent input still yields the Lines server alone. Plus
  `staleDynamicServers`: an omitted dynamic server is named, a settings-file or `claudeai` server
  never is, Lines is never swept (the merge re-includes it), an already-disabled server is not
  toggled twice, `needs-auth` still counts as live, and a malformed status read yields no toggles.
- `server/src/sessions.mcpLive.test.ts` — `applyMcpServers` reaches every session and broadcasts
  the returned statuses as a single account-wide message (and nothing at all when no session had a
  query); it sends `serverConfigs()` (header values attached), not the synced blob;
  one session with no query does not stop the others; it never warms. And `warmQuery` through its
  callers: a status read warms only when asked, `startMcpAuth` warms once and completes on the
  retry, a worker too old to warm degrades to the pre-warm copy, `callbackExpected: false` is
  `alreadyAuthorized`, and `worker-unavailable` is reported rather than retried.
- `server/src/sessions.backgroundTasks.test.ts` — the query hold, alongside the background-task
  skip it parallels: a held session is never recycled, is once released, and stops being held once
  the hold ages past `PENDING_TTL_MS`; releasing a hold never taken is a no-op.
- `server/src/mcpAuth.contract.test.ts` — the two-directional SDK canary (see Architectural
  rules); `mcpAuthSupport` degrading instead of throwing; `normalizeAuthStart` against the real
  recorded Figma response shape, a renamed field, a non-`http(s)` URL, and a
  `callbackExpected: false` answer (already-authorized, and winning even over a stale URL);
  `McpAuthPending` single-use claim, wrong-state rejection, and per-session forgetting.
- `server/src/store.test.ts` — round-trip for `mcp-connections.json`/`mcp-connections-sync.json`/
  `mcp-secrets.json`; the secrets file is `0600` and never appears in the connections file; a
  non-string secret value is dropped on load.
- `server/src/messageAuthz.test.ts` — the six MCP messages are owner-only at both `machine` and
  `session` scope. Two of them now reach further than they read: authorizing signs the *host* in to
  a third-party account, and a warming status read brings a CLI child up on the host's machine.
- `server/src/broadcastScope.test.ts` — `mcpConnections`/`mcpConnectionsReview`/`mcpStatuses` are
  account-wide (`sessionIdOf` returns `null`), so a guest socket never receives them.
- `server/src/sync.availability.test.ts` — a `P2021` on `mcp_connections` degrades that one
  resource to `null` rather than aborting the whole pull.
- No web test runner covers `McpConnectionsSection.tsx`/`McpConnectionsReviewModal.tsx` — same
  acknowledged gap as `GuardAllowlistSection.tsx`.

## Business rules

- Header and stdio env **values** never sync and never reach a browser: `blob()`, the storage
  row, and every broadcast carry `headerKeys`/`envKeys` (names) only; values live solely in the
  local `mcp-secrets.json` and `mcp-env.json` (mode `0600`). A connection synced to another
  machine arrives without them — an http one shows `needs-auth`, a stdio one lists the env values
  "not set on this machine" — until they are entered there.
- Env values are write-only in the UI, like header values and a password field: a saved one shows
  as an empty box that says it is saved, an empty box on save keeps the stored value (the client
  never holds one to send back), and removing a variable's row drops its value on the bridge. A
  name `normalizeConnection` would silently skip is refused in the form (`isMcpEnvName`) rather
  than lost on save with the value typed beside it.
- `envValuesHeld` is about one machine: set only on what the bridge sends its own browsers, never
  in the synced blob, and never taken from a client or a remote row — the Settings toggle sends a
  connection back without it (`withoutHeldMarks`).
- Accepting a remote list never takes a credential value from it, and a difference only in values
  is not a divergence (`sameConnection` compares env names).
- Storage keeps names only: `PUT /mcp-connections` drops header and env values whatever a bridge
  sends — a bridge predating names-only sync is answered as usual, not with a 400, which would
  only stop its whole list syncing — and logs that it did, never what; `GET` serves a values-free
  copy of any row still holding them.
- Every MCP file (`mcp-connections.json`, `mcp-connections-sync.json`, `mcp-secrets.json`,
  `mcp-env.json`) is written `0600` and tightened to `0600` at startup: beyond the two credential
  files, the connections and sync files hold command lines and URLs, and an older build's inline
  env values until the load migration moves them out.
- Scrubbing storage is not un-leaking: an API key synced inside a stdio connection's `env` before
  names-only sync should be rotated.
- The Lines server always wins a name collision in the worker's `mcpServers` merge — a user
  connection named `lines` is refused by `normalizeConnection` (`reserved-name`) before it can
  even reach that point.
- A remote connection list is never applied automatically; a divergence is always shown as an
  explicit added/removed diff.
- Divergence detection is a set difference (`sameConnection` on full content, ids included), never
  an `updatedAt` comparison — a fresh machine's empty list is otherwise "newer" than a populated
  cloud row.
- Push to storage is suppressed while a review is pending, so the push itself cannot destroy the
  state being reviewed.
- `review()` re-sanitizes the pending list on every call (via `sanitizeConnections`) rather than
  trusting what `reviewRemote` staged, and recomputes the added/removed diff off that sanitized
  list — the pending blob round-trips through `mcp-connections-sync.json`, which `loadMcpSync`
  validates only on `updatedAt`, so this is the one path by which an unvalidated row could
  otherwise reach the review modal.
- A disabled connection is kept (so its configuration and secret survive) but contributes nothing
  to `serverConfigs()` — no session sees its tools while it's off. On a *live* query that also
  takes an explicit `toggleMcpServer(name, false)`: dropping it from the replace payload is not
  enough (see Data flow → Reaching a session).
- A connection edit reaches sessions that are already running, not only the next new one. The
  reverse — a session picking up an edit made while it was mid-turn — is the same mechanism and is
  equally intended.
- Authorizing is offered for any enabled `http`/`sse` connection, whatever its status reading says,
  and is absent for `stdio` (which takes its credentials from its env values). It used to appear
  only on a `needs-auth` reading, which made it unreachable in the one case that matters: a
  connection the user has just added is in no live query, so it reports no status at all. A wasted
  click on an already-working server is the cheaper failure.
- Authorizing needs a session selected, but not a running turn: leg 1 warms the query if there is
  none.
- "Already authorized" is a distinct outcome from an error — the CLI holds a token, nothing failed
  and there is nothing to visit.
- `alwaysLoad` is left unset on every generated server config, so a connection's tools defer
  behind tool search by default and cost nothing in a session with no use for them.
- Only `mode: 'url'` elicitations render a card; `mode: 'form'` is declined without ever reaching
  the user.
- An elicitation whose query has already died resolves `'expired'` with no injected model prompt —
  the OAuth exchange belonged to that dead CLI process and cannot be retried by talking to the
  model.
- Authorizing a server, editing/removing a connection, and reading MCP status are all owner-only,
  permanently — no share preset reaches them.
- OAuth's redirect URI is always `http://127.0.0.1:<this bridge's bound port>/mcp-oauth/callback`.
  Authorizing therefore only works from a browser on the same machine as the bridge; a relayed
  browser elsewhere cannot reach it. The pane states this beside the control, always and not only
  when something has already gone wrong — but does not block the click, since a relayed
  deployment's browser may well be on that machine and that is the user's call.
- The callback route's `state` parameter is the only credential on it (an OAuth redirect cannot
  carry the app's own token): single-use, TTL-bounded (`McpAuthPending`), and compared with
  `timingSafeEqual`. Unknown, expired, and already-claimed states all produce one identical
  message, so the route cannot be used to enumerate which states exist. A provider response with
  no `state` is refused outright rather than accepted unauthenticated.
- A dead session's pending OAuth handshakes are forgotten (`onEnded` → `forgetSession`) — the PKCE
  verifier died with that CLI process, so the state could never have completed anyway.

## Architectural rules

- Validators (`normalizeConnection`, `sameConnection`, `describeConnection`, `diffConnections`)
  live in `shared/types.ts`, so the web client runs the exact same rules before ever sending a
  connection to the bridge — the same posture `normalizeAllowEntry` established for the guard
  allowlist.
- Connection edits are intent messages (`addMcpConnection`/`updateMcpConnection`/
  `removeMcpConnection`/`reviewMcpConnections`), never a whole-list save — the bridge is the only
  writer that also holds secret values, and a stale tab's whole-blob save would either clobber
  them or leak nothing useful in place of them.
- The connection list is deliberately **not** part of `UserUiSettings`/`pushSettings()` — same
  reasoning as the guard allowlist: a whole-settings push from a stale tab must not be able to
  clobber server-authoritative, security-relevant state.
- `mergeMcpServers` lives in `server/src/workerProtocol.ts`, not `worker.ts`: the merge itself
  needs no live `Query`, so keeping it in the protocol module (already in the worker's minimal
  import graph — see the header comment on `worker.ts`) makes it importable and testable without
  spawning a CLI.
- `MCP_AUTH_METHODS`/`mcpAuthSupport`/`McpAuthApi` are defined once, in `workerProtocol.ts` — the
  worker is the only side holding a `Query` and must probe it there; `mcpAuth.ts` re-exports them
  rather than redefining them, so the canary test and the call site can never disagree about what
  is being relied on.
- `Query.setMcpServers`/`toggleMcpServer`/`mcpServerStatus`/`reconnectMcpServer` **are** declared
  in `sdk.d.ts`, so they are called directly and the compiler is their tripwire — a rename or
  removal fails `npm run typecheck`. Only the two undeclared OAuth methods go behind
  `mcpAuthSupport`. Wrapping the typed ones in a runtime probe too would trade a compile error for
  a runtime string, which is strictly worse.
- `staleDynamicServers` lives in `workerProtocol.ts` next to `mergeMcpServers`, for the same
  reason: it is a decision about protocol shape, needs no live `Query`, and is the part of the
  `mcpSetServers` handler with logic worth asserting.
- `'mcpSetServers'` and `'mcpWarm'` are `AskMethod` values, not new `BridgeToWorker` message types,
  and so are **not** protocol bumps — the existing rule above `AskMethod`. That is a deliberate
  choice and not just convenience: `workerProtocol.ts` is inside the worker's tsx-watch graph, so
  bumping `PROTOCOL_VERSION` restarts the worker and kills every live query. A feature about
  keeping a query alive must not ship by killing them all.
- `'mcpWarm'` is handled in `handleAsk`, ahead of its `no-live-session` check, rather than in
  `runAsk`. It is the one ask that *creates* the query the others read, so the check it would
  otherwise fail is the very condition it exists to fix. It funnels through the same
  `ensureSession` a push does, so on a single-threaded worker the two creation paths cannot race.
- A warmed query is readable but silent: the CLI answers control requests while it waits for input
  and emits nothing — not even `system:init` — until a user message arrives. So `warmQuery` must
  not wait for `init`, and a warmed session must not be marked `busy`. Verified empirically; the
  lazy-init behaviour is not documented anywhere.
- `PENDING_TTL_MS` is exported from `mcpAuth.ts` and imported by `sessions.ts` rather than
  duplicated: a query hold that outlived the handshake it protects would pin a CLI child open for
  a flow that can no longer complete.
- `Query.mcpAuthenticate`/`mcpSubmitOAuthCallbackUrl` are called only behind `mcpAuthSupport(q)`,
  never directly — they exist in the SDK's runtime bundle but not in `sdk.d.ts`, so nothing
  type-checks a call to them. `mcpAuth.contract.test.ts` is the tripwire: it fails if the methods
  disappear from the runtime bundle (the feature is broken, follow the replacement API) **and**
  fails if they start appearing in `sdk.d.ts` (the shim is obsolete — delete it and call the typed
  API so the compiler checks the call). Both directions were verified to actually discriminate
  (a typed method reads as typed; a fictional one reads absent both ways) before relying on the
  test.
- Adding a `params` field to the `ask` `BridgeToWorker` message, and adding `'mcpAuthStart'` /
  `'mcpAuthCallback'` to `AskMethod`, are not protocol bumps — same rule as the pre-existing
  `AskMethod` comment: an older worker that doesn't read a field or doesn't implement a method
  simply falls through to its default case.
- `McpConnections` is a structural copy of `GuardAllowlist` (`server/src/autoGuard.ts`): same
  split (bare-array list, separate sync-state envelope) plus the two local-only credential files
  this feature adds — header values in `mcp-secrets.json`, stdio env values in `mcp-env.json`, a
  file of its own rather than a second namespace inside the secrets file, whose shape an older
  build reads directly — same review lifecycle shape, same `onChange`/`onReview` wiring in
  `userContext.ts`. Any bug found in one is worth checking in the other.
- Names-only starts at the validator: `normalizeConnection` reduces any
  `env` to `envKeys`, so every shape built from canonical rows is value-free by construction, and
  `blob()` is built from those rows, never from `list()`, so one machine's `envValuesHeld` cannot
  tell another it holds a key it does not.
- `withoutMcpValues` runs on both sides of the storage boundary because that boundary is what the
  guarantee is about: outbound before `req` signs, so the signature still verifies after storage's
  own filtering; inbound after verification, so a legacy row hands this machine names only.
- `findPermissionRequest`'s "is this a request, not a resolution" predicate is
  `toolName || elicitation`, not `toolName` alone — an elicitation request legitimately carries no
  tool name, and without the widened predicate it would look like an already-resolved event to
  every reader that scans the transcript for the original request.
- `handleOAuthCallback`'s HTTP surface is added to the bridge's existing bare `http.createServer`
  (previously only a status JSON page), routed by a path prefix check — deliberately not a new
  server or port, since the OAuth redirect URI has to be a fixed, publishable value
  (`boundPort` + `MCP_OAUTH_CALLBACK_PATH`).

## Related decisions

- [permissions-and-plan-mode](permissions-and-plan-mode.md) — the permission-card machinery an
  elicitation card reuses (resolution provenance, resend replay, dedupe of a second answer); the
  guard-allowlist review lifecycle this feature's sync model is a structural copy of.
- [agent-memory-sync](agent-memory-sync.md) — the one-blob-per-user storage precedent.
- [workflow-mcp-tools](workflow-mcp-tools.md) — the Lines in-process server the worker's merge
  must never let a same-named connection shadow.

## On a codex session

Connections **do** apply to a session on an OpenAI model, by a different route. Codex takes its
MCP servers from its own `config.toml` rather than from per-session options, so the bridge
translates the enabled connections into codex's shape (`McpConnections.codexServerConfigs`) and
the worker hands them over with codex's own `config/batchWrite` RPC.

Lines never writes that file itself. Keeping codex the single writer of its own config is the
same rule `auth.json` follows, and for the same reason. The whole `mcp_servers` table is written
as one `replace`, so a removed or disabled connection actually goes away — safe because this
`$CODEX_HOME` is Lines-owned (`~/.lines-app/users/<id>/codex/`) and nothing else puts a server
in it.

Three things are narrower than on the Claude path, and all three are visible to the user rather
than silent:

- **Only stdio and bearer-token HTTP.** Codex models an HTTP server's credential as a bearer
  token and nothing else, so a connection carrying an `X-Api-Key` (or any non-`Authorization`
  header) cannot be expressed. An SSE endpoint cannot either — codex's `url` server speaks
  streamable HTTP only. Both are reported on the connection row by
  `codexUnsupportedReason` (`web/src/lib/mcpConnections.ts`) rather than dropped.
- **The token is passed by env-var name.** Codex reads it from a variable named in
  `config.toml` (`bearer_token_env_var`), so the value never lands on disk — a better boundary
  than the Claude path's inline `headers`. The name is derived from the connection *id*, so a
  rename cannot orphan the variable the app-server was spawned with.
- **A changed token waits for an idle moment.** A child's environment is fixed at spawn and one
  child serves every codex session, so respawning to pick up a new token would kill another
  session's in-flight turn. It happens at the first push that finds the child idle.

**Status** comes from codex's own `mcpServerStatus/list`, which answers for the whole
`CODEX_HOME` rather than per thread. That makes it cheaper than the Claude reading, not dearer:
there is nothing to warm, so it needs no Refresh click and works for a session that has never
run a turn. `SessionManager.mcpServerStatus` short-circuits to it before the `warm` check.

The mapping has one trap worth knowing about. `runtimeStatus` is *thread*-runtime state: a
server that started fine and listed every one of its tools still reports it as `null` whenever
no thread is running, which is exactly the case when Settings asks. Reading the dot off it alone
showed every working connection as "pending" forever. The catalog is the fallback evidence —
codex documents `toolsError` as null whenever a catalog came back, so a server that answered a
tool listing has demonstrably connected. `normalizeCodexMcpStatuses` encodes that, and
`sessions.codexMcpStatus.test.ts` pins each state.

Lines' own `lines` server is filtered out of the list: it is how the tools get there, not a
connection the user added, and showing it would invite them to remove it.

`$CODEX_HOME` being Lines-owned also means it **shadows the user's own `~/.codex/config.toml`**
— servers they configured for their terminal codex do not apply inside Lines. Adding them to
this pane is how they get in. See [openai-codex-sessions](openai-codex-sessions.md).
