# MCP connections

Covers: `mcp-connections`, `mcp-connection-oauth`.

## Purpose

Let a user add a third-party MCP server (Figma, Linear, a local stdio server, …) from Settings,
see whether it connected in a given session, and authorize it — with the connection list synced
across machines like the guard allowlist, and header/credential values never leaving the machine
that holds them.

Before this feature, adding an MCP server meant hand-editing `.mcp.json` or `~/.claude/settings.json`
on disk and running the interactive `claude` CLI once to complete any OAuth handshake. That path
still works (`settingSources: ['user', 'project']` reaches every session unchanged) — this feature
is an additive, UI-managed way to do the same thing, not a replacement for it.

The Lines in-process MCP server (workflow tools; see
[workflow-mcp-tools](workflow-mcp-tools.md)) is unrelated and unchanged, except that the worker
had to stop *overwriting* `mcpServers` with it and start *merging* — see Architectural rules.

## Entry points

- Settings modal → **Connections** pane: add/edit/remove a connection, toggle it on/off, see its
  live status, authorize it.
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
  `describeConnection`, `diffConnections`; the `addMcpConnection`/`updateMcpConnection`/
  `removeMcpConnection`/`reviewMcpConnections`/`mcpServerStatus`/`authorizeMcpConnection` client
  messages and their `MESSAGE_AUTHZ` entries (all owner-only); the `mcpConnections`/
  `mcpConnectionsReview`/`mcpServerStatus`/`mcpAuthStarted`/`mcpAuthCompleted` server messages;
  `McpServerStatusInfo`, `McpElicitation`, and `PermissionRequestData.elicitation`.
- `server/src/mcpConnections.ts` — `McpConnections`, the store-backed list + review lifecycle
  class, structurally a copy of `GuardAllowlist` (`server/src/autoGuard.ts`).
- `server/src/mcpAuth.ts` — the OAuth shim: `normalizeAuthStart`, `unsupportedReason`,
  `McpAuthPending` (the pending-handshake map keyed by OAuth `state`), `inspectInstalledSdk`; also
  re-exports `MCP_AUTH_METHODS`/`mcpAuthSupport`/`McpAuthApi` from `workerProtocol.ts`.
- `server/src/workerProtocol.ts` — `mergeMcpServers` (the worker-side merge helper);
  `MCP_AUTH_METHODS`, `mcpAuthSupport`, `McpAuthApi`, `McpAuthSupport` (the runtime capability
  probe for the untyped SDK OAuth methods — see Architectural rules); `AskMethod` extended with
  `'mcpStatus' | 'mcpAuthStart' | 'mcpAuthCallback'`; `BridgeToWorker`'s `ask` message extended
  with an optional `params` field.
- `server/src/worker.ts` — `runAsk` (dispatches the four `AskMethod` values); `ensureSession`'s
  `mcpServers` merge.
- `server/src/workerClient.ts` — `WorkerClient.mcpStatus`, `.mcpAuthStart`, `.mcpAuthCallback`.
- `server/src/sessions.ts` — `buildQueryOptions`'s `mcpServers` block; `mcpServerStatus` (reads
  live status, falling back to the last `system:init` reading); `startMcpAuth`/`completeMcpAuth`
  (the two OAuth legs); `normalizeMcpStatuses`; the `system:init` handler stashing
  `LiveState.mcpServers`; `findPermissionRequest`'s `toolName || elicitation` predicate;
  `askPermission`'s `elicitation` parameter.
- `server/src/store.ts` — `loadMcpConnections`/`saveMcpConnections` (`mcp-connections.json`, a
  bare array), `loadMcpSync`/`saveMcpSync` (`mcp-connections-sync.json`, mirroring
  `GuardSyncState`), `loadMcpSecrets`/`saveMcpSecrets` (`mcp-secrets.json`, mode `0600`, **never**
  read by `sync.ts`).
- `server/src/sync.ts` — `PulledState.mcpConnections`, the `/mcp-connections` pull (caught on its
  own like `/guard-allowlist`, so an unmigrated storage server 500s only that one resource),
  `pushMcpConnections`.
- `server/src/userContext.ts` — wires `mcp.onChange`/`mcp.onReview` to broadcast + push, and calls
  `mcp.reviewRemote` before the push block in `syncNow`, mirroring the guard wiring exactly.
- `server/src/index.ts` — the six MCP message cases; `boundPort`, `MCP_OAUTH_CALLBACK_PATH`,
  `mcpAuthPending`, `handleOAuthCallback`, `oauthPage`; `onEnded`'s
  `mcpAuthPending.forgetSession` call.
- `storage/prisma/schema.prisma`, `storage/src/index.ts` — the `mcp_connections` table and its
  `GET`/`PUT /mcp-connections` routes (the `PUT` handler strips any `headers` field defensively,
  independent of the bridge already never sending one).
- `web/src/store.ts` — `mcpConnections`/`mcpReview`/`mcpStatus`/`mcpAuth` state, their actions, and
  the matching `ServerMessage` cases; deliberately absent from `pushSettings()`.
- `web/src/lib/mcpConnections.ts` — `mcpConnectionErrorText`, `mcpStatusMeta`,
  `MCP_STATUS_UNKNOWN`.
- `web/src/components/McpConnectionsSection.tsx` — the Settings pane: connection list, add form
  (client-side `normalizeConnection` before send), status dot, Authorize button.
- `web/src/components/McpConnectionsReviewModal.tsx` — accept/reject a divergent remote list.
- `web/src/components/SettingsModal.tsx` — the `'connections'` section, registered like
  `'allowlist'`.
- `web/src/components/PermissionPrompt.tsx` — `toolPresentation`'s `data.elicitation` branch
  (checked before `data.toolName`, since an elicitation carries no tool name).
- `web/src/lib/transcript.ts` — an unresolved elicitation permission item is a fold boundary, like
  `ExitPlanMode`.

## Symbols

- `McpConnection` — `{ id, name, transport, url?, command?, args?, env?, headerKeys?, timeout?,
  enabled }`. `headerKeys` is names only; values never appear on this type.
- `normalizeConnection(raw)` — the single validation gate every writer runs through (Settings
  form, wire handler, load migration, remote ingest): canonicalizes or returns an
  `McpConnectionError`. Mints an id when the input has none.
- `RESERVED_MCP_SERVER_NAMES` — `['lines']`; duplicated (not imported) from
  `server/src/mcpWorkflowTools.ts`'s `LINES_MCP_SERVER` because that module pulls in the whole
  bridge graph — `mcpConnections.test.ts` asserts the two agree.
- `McpConnections` (class) — `list()`, `blob()` (synced form, header names only), `serverConfigs()`
  (SDK-facing form, header **values** spliced in from the secrets file — the one place a
  credential value exists in a served object), `add`/`update`/`remove`, `reviewRemote`/`review`/
  `acceptReview`/`rejectReview`.
- `mergeMcpServers(fromOptions, linesServerName, linesServer)` — combines the user's connections
  with the Lines server, Lines spread **last** so it always wins a name collision. Lives in
  `workerProtocol.ts` (not `worker.ts`) so it is testable without a live query.
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
`mcpConnectionsReview`; connections are untouched until accept/reject.

### Reaching a session

`buildQueryOptions` calls `mcp.serverConfigs()` — enabled connections only, each with its header
values attached from the local secrets file — and includes the result as `mcpServers` in the
serialized options sent to the worker. `ensureSession` merges that map with the Lines in-process
server via `mergeMcpServers`, Lines last, and passes the combined map to `query()`.

### Status

`system:init` carries `mcp_servers: {name, status}[]` — cheap, always available, but lossy (no
`error`/`scope`/`tools`). `normalizeMcpStatuses` parses it onto `LiveState.mcpServers`. The
detailed read (`SessionManager.mcpServerStatus`) asks the worker for a live
`Query.mcpServerStatus()` (`AskMethod: 'mcpStatus'`) and falls back to the last-known `init`
reading when no query is live or the read comes back empty. The Settings pane requests it for
whichever session is currently open; there is no per-connection subscription.

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
   `mcpAuthPending` and answers `mcpAuthStarted` with the `authUrl`.
2. The user opens that URL (a plain link, not an auto-`window.open` — a popup blocker would eat
   it) and signs in with the provider.
3. **Leg 2** — the provider redirects the browser to the bridge's HTTP callback with `state` (and
   an authorization code the bridge never inspects). `handleOAuthCallback` claims the pending
   handshake by `state`, calls `SessionManager.completeMcpAuth` (worker `AskMethod:
   'mcpAuthCallback'` → `mcpSubmitOAuthCallbackUrl` → `reconnectMcpServer` → a fresh
   `mcpServerStatus()` read), and broadcasts `mcpAuthCompleted` with the result.

Both legs must run against the **same live query**: the PKCE verifier from leg 1 lives inside that
CLI process. `worker.onEnded` calls `mcpAuthPending.forgetSession` so a state whose session died
cannot be replayed against a query that no longer holds its verifier.

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
  edit with no `headers` argument keeps the stored value; load-time migration.
- `server/src/mcpConnections.sync.test.ts` — the review lifecycle, case-for-case with
  `autoGuard.sync.test.ts`: staging, a changed field on the same id counting as a divergence,
  set-equal reorder not counting, accept/reject, reject-remembered-by-content, restart
  persistence, and that an accepted remote connection has no secret until one is entered locally.
- `server/src/workerMcpMerge.test.ts` — `mergeMcpServers`: neighbours survive, Lines wins a name
  collision, malformed/absent input still yields the Lines server alone.
- `server/src/mcpAuth.contract.test.ts` — the two-directional SDK canary (see Architectural
  rules); `mcpAuthSupport` degrading instead of throwing; `normalizeAuthStart` against the real
  recorded Figma response shape, a renamed field, and a non-`http(s)` URL; `McpAuthPending`
  single-use claim, wrong-state rejection, and per-session forgetting.
- `server/src/store.test.ts` — round-trip for `mcp-connections.json`/`mcp-connections-sync.json`/
  `mcp-secrets.json`; the secrets file is `0600` and never appears in the connections file; a
  non-string secret value is dropped on load.
- `server/src/messageAuthz.test.ts` — the five MCP messages are owner-only at both `machine` and
  `session` scope.
- `server/src/broadcastScope.test.ts` — `mcpConnections`/`mcpConnectionsReview` are account-wide
  (`sessionIdOf` returns `null`), so a guest socket never receives them.
- `server/src/sync.availability.test.ts` — a `P2021` on `mcp_connections` degrades that one
  resource to `null` rather than aborting the whole pull.
- No web test runner covers `McpConnectionsSection.tsx`/`McpConnectionsReviewModal.tsx` — same
  acknowledged gap as `GuardAllowlistSection.tsx`.

## Business rules

- Header/credential **values** never sync and never reach a browser: `blob()`, the storage row,
  and every broadcast carry `headerKeys` (names) only; values live solely in the local
  `mcp-secrets.json` (mode `0600`). A connection synced to another machine arrives with its secret
  missing and shows `needs-auth` until re-entered there.
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
- A disabled connection is kept (so its configuration and secret survive) but contributes nothing
  to `serverConfigs()` — no session sees its tools while it's off.
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
  browser elsewhere cannot reach it, and the UI states this rather than hanging.
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
  three-file split (bare-array list, separate sync-state envelope, plus a third local-only secrets
  file this feature adds), same review lifecycle shape, same `onChange`/`onReview` wiring in
  `userContext.ts`. Any bug found in one is worth checking in the other.
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
