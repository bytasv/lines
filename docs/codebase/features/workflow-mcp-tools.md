# Conversational workflow/step editing (in-process MCP tools)

## Purpose

Lets a Lines session discuss and edit its own workflows and reusable steps in
plain conversation — "what workflows do we have?", "add a review step to the
MVP flow" — instead of requiring the browser's `WorkflowEditor` modal. Backed by
an MCP server (`mcp__lines__*`) exposed to every session; writes are
permission-gated through the existing card, reads are not.

The server is hosted **two different ways**, one per engine, because the engines
offer different hooks — see "Two front doors" below. The tool manifest and every
handler are shared; only the hosting differs.

## Entry points

- Any session prompt that names or implies a workflow/step change — the model
  decides when to call a tool, there is no explicit user action that "opens" this
  surface.
- `web/src/components/PermissionPrompt.tsx` — the card a write tool raises.

## Important files

- `server/src/workerProtocol.ts` — `PROTOCOL_VERSION` 3, `RpcKind` `'mcpTool'`,
  `JsonSchemaNode`/`McpToolSpec`/`McpToolManifest`/`McpToolResult`, `push.tools?`
- `server/src/workerMcp.ts` — worker-side, workflow-agnostic: JSON-Schema→Zod
  conversion (`jsonSchemaToZod`, `jsonSchemaToZodShape`) and `buildMcpServer`
- `server/src/worker.ts` — `ensureSession(sessionId, options, tools?)` wires
  `mcpServers` into the SDK query; `MCP_TOOL_FALLBACK_MS` / `RPC_FALLBACK` table
- `server/src/workerClient.ts` — `push(sessionId, message, options, tools?)`
- `server/src/workflowCommands.ts` — the mutation/read/resolution layer shared by
  the WebSocket path and the MCP path
- `server/src/mcpWorkflowTools.ts` — `LINES_TOOL_MANIFEST`, `createMcpDispatcher`
  (bridge-side, hot-reloadable tool names/descriptions/schemas)
- `shared/workflowValidation.ts` — `validateWorkflow`, `validateStepContent`,
  `formatWorkflowIssues` (re-exported from `shared/types.ts`)
- `shared/formatTime.ts` — `formatTimestamp` (also re-exported from
  `shared/types.ts`), the one `YYYY-MM-DD HH:MM` local-time format every
  `createdAt`/`updatedAt` in a tool result is rendered through
- `storage/prisma/schema.prisma` — `Workflow.createdAt`, `StepVersion.createdAt`,
  the Postgres-side half of workflow/step creation-time durability
- `server/src/sessions.ts` — `handlePreToolUse`/`handleCanUseTool` gating on the
  `mcp__lines__*` namespace
- `server/src/index.ts` — `handleMcpToolRpc`, and the four `saveWorkflow`/
  `deleteWorkflow`/`saveStep`/`deleteStep` WS cases now call `workflowCommands.ts`
- `web/src/components/PermissionPrompt.tsx` — `workflowToolPresentation`

## Important symbols

- `McpToolManifest` / `McpToolSpec` / `McpToolResult` — the JSON-Schema-shaped
  wire types the bridge sends and the worker converts, never a live SDK type
- `buildMcpServer(manifest, invoke)` — worker-side; every tool handler forwards
  to `invoke`, which is `rpcCall(sessionId, 'mcpTool', ...)`
- `LINES_TOOL_MANIFEST` — server name `lines`, so tools appear as
  `mcp__lines__list_workflows`, `..._get_workflow`, `..._list_steps`,
  `..._get_step`, `..._list_step_versions` (reads), and `..._create_workflow`,
  `..._update_workflow`, `..._delete_workflow`, `..._save_step`,
  `..._delete_step` (writes)
- `resolveWorkflowRef(ctx, ref)` — id or unique case-insensitive name match among
  **owned** workflows only; returns `{ok:false, reason:'not-found'|'ambiguous'|
  'foreign', candidates}` instead of guessing
- `ForeignWorkflowError` (`server/src/workflows.ts`) — thrown by
  `WorkflowEngine.save()` for an id it classifies as foreign (see Business rules)
- `isLinesMcpTool` / `isReadOnlyLinesTool` — read the manifest's `readOnly` flag,
  the single source of truth for which tools skip the permission card
- `formatTimestamp` (`shared/formatTime.ts`) — ms epoch → `YYYY-MM-DD HH:MM`
  local time, `''` for undefined
- `StepView` / `stepView` (`workflowCommands.ts`) — a `StepDef` with
  `createdAt`/`updatedAt` formatted for a tool result; applied at the MCP
  boundary (`get_step`, `list_step_versions`, `save_step`'s returned step), never
  inside `stepVersionsView` itself
- `createdAtOf` (`storage/src/index.ts`) — the blob's `createdAt`, else its
  `updatedAtOf`, for `PUT /workflows`'s insert
- `earliest` (`server/src/workflows.ts`) — the creation-time merge rule: the
  smallest of the values given, ignoring absent ones

## Data flow

1. Every session push (`server/src/sessions.ts` `pushWithToken`) carries
   `LINES_TOOL_MANIFEST` alongside the SDK options.
2. The worker's `ensureSession` builds one `McpServer` instance **per session**
   (never a cached singleton — the handler closes over `sessionId` so the rpc
   routes to the right `UserContext`) via `buildMcpServer`.
3. A tool call becomes `rpcCall(sessionId, 'mcpTool', {tool, args})`; `index.ts`'s
   `onRpc` callback routes `kind === 'mcpTool'` to `handleMcpToolRpc` (not
   `sessions.handleWorkerRpc`, which stays for `canUseTool`/`preToolUse`), which
   calls `createMcpDispatcher(ctx)(tool, args)` and answers via `worker.rpcResult`.
4. `PreToolUse`/`canUseTool` gate on the tool name first: `mcp__lines__*` reads
   auto-allow in **every** permission mode (including `auto`, bypassing the
   normal guard entirely); writes always escalate to the permission card,
   including in `auto` mode.
5. A write dispatcher call validates (`shared/workflowValidation.ts`,
   `strictModel: true`) before calling into `workflowCommands.ts`, which is the
   same code the WS `saveWorkflow`/`deleteWorkflow`/`saveStep`/`deleteStep`
   cases call — so an MCP-originated save and a browser-originated save produce
   identical `WorkflowEngine` state and storage broadcasts.
6. The card (`web/src/components/PermissionPrompt.tsx` `workflowToolPresentation`)
   renders the target workflow/step name, a numbered step list (name / model /
   permission mode) for `steps`, and the raw prompt template in a code block —
   not a JSON dump of the tool arguments.

## Dependencies

- `@anthropic-ai/claude-agent-sdk`'s `createSdkMcpServer`/`tool` (worker-side
  only — `McpSdkServerConfigWithInstance` holds a live object and cannot cross
  the bridge↔worker socket, which is why the manifest is JSON-Schema data instead)
- `zod` (new server dependency, `server/package.json`) — only inside
  `workerMcp.ts`
- Reuses the existing `canUseTool`/`PreToolUse` hook path (no new hook
  mechanism) and the existing `WorkflowEngine`/`ctx.sync` write path via
  `workflowCommands.ts`

## Tests

- `server/src/workerMcp.test.ts`
- `server/src/workflowCommands.test.ts`
- `server/src/workflowValidation.test.ts`
- `server/src/mcpWorkflowTools.test.ts`
- `server/src/sessions.mcpGating.test.ts`
- `server/src/workflows.timestamps.test.ts` — `createdAt` stamping, the
  earliest-wins merge, and boot-time healing of rows written before it existed
- `storage/src/workflows.createdAt.test.ts` — opt-in, needs
  `STORAGE_TEST_DATABASE_URL` (with migrations applied): the Postgres-level
  `LEAST` merge and the lineage-minimum read on `step_versions`

## Business rules

- Mutations address a workflow by id, or by a name unique among **owned**
  workflows (case-insensitive); a name match against another user's published
  workflow is refused as read-only, never silently forked.
- `create_workflow`/`update_workflow`/`save_step` are rejected before they reach
  `WorkflowEngine.save()` if they fail `shared/workflowValidation.ts` — missing
  step refs, duplicate output names, forward `{outputs.*}` references, or an
  unknown model/permission mode all produce one actionable error string rather
  than a partial write.
- `update_workflow`'s `steps` argument replaces the whole list; there is no
  patch-by-index. Reading via `get_workflow` first is expected practice — the
  manifest's `instructions` field says so.
- `WorkflowEngine.save()` throws `ForeignWorkflowError` for an id it classifies
  as foreign — an id owned only by the shared map, never by the own map and
  never stamped with this user's own id. `resolveWorkflowRef` should still run
  **before** `saveWorkflow`, for the better, candidate-naming error message;
  the throw is the guard of last resort, not the primary UX.
- "Foreign" is own-beats-shared: an id present in *both* maps (a stale shared
  snapshot of the user's own published row, or the same id republished under a
  second identity of theirs) is writable. See
  [workflow-step-versioning](workflow-step-versioning.md) for the full
  ownership-classification rule this shares with the browser editor.
- Every list/read tool caps its result at 100 rows (default 50) so an answer
  cannot blow out the model's context.
- A bridge that goes away mid-tool-call answers after `MCP_TOOL_FALLBACK_MS`
  (30s) with an error result, not an indefinitely parked turn — the SDK's own
  MCP tool timeout is effectively unbounded by default.
- Every workflow/step read tool reports `createdAt`/`updatedAt` as
  `YYYY-MM-DD HH:MM` local-time strings, not raw ms epochs — a raw epoch in a
  tool result is a conversion the model would otherwise have to do by hand.
  `stepVersionsView` itself is the one exception: it stays numeric, because its
  other caller is the browser's version popover, which needs ms for `relTime`.
- A workflow's `createdAt` is stamped once, on its first save, and never
  restamped; a fresh (empty) id always mints a new one now, so `duplicate()` and
  `create_workflow` can never inherit the source's birthday even though both
  build the new workflow by spreading an existing one.
- A step's `createdAt` is the *lineage's* creation — when the step id was first
  created — not the mint time of whichever version is being read; every version
  of one step reports the same `createdAt`; that version's own mint time is its
  `updatedAt`. Identical `createdAt` values down a `list_step_versions` result
  are correct, not a bug.
- Creation time only ever moves earlier, never later (`earliest`/`LEAST`
  everywhere it merges) — idempotent and order-independent across peers, and it
  means a client or blob that omits `createdAt` can never erase a known one.

## Architectural rules

- Tool *definitions* (names, descriptions, JSON-Schema shapes) live entirely on
  the bridge (`mcpWorkflowTools.ts`) and are hot-reloadable under `tsx watch`;
  only the worker-side conversion (`workerMcp.ts`) and the protocol shape
  (`workerProtocol.ts`) sit in the worker's minimal, restart-triggering import
  graph — and both are deliberately workflow-agnostic, holding no domain
  knowledge, so they change about as rarely as the protocol itself.
- `PROTOCOL_VERSION` bumped 2→3 for the new optional `push.tools` field, purely
  so a new-bridge/old-worker skew routes to the existing loud
  `protocol mismatch` log instead of silently producing sessions with no tools.
- `RPC_FALLBACK` is a per-`RpcKind` table (`preToolUse`, `mcpTool`); `canUseTool`
  is deliberately absent — the SDK parks it with no deadline, and a permission
  request is exactly the thing that must wait for a human, not fail closed.
- `workflowCommands.ts` imports `UserContext` type-only, to avoid a runtime
  cycle with `userContext.ts` (which builds the `WorkflowEngine`/`sync` this
  module drives).
- `shared/workflowValidation.ts` is re-exported from `shared/types.ts` as that
  file's **last statement** — the two form an intentional import cycle, safe
  only because `workflowValidation.ts` reads `types.ts` bindings inside function
  bodies, never at its own top level. Moving the re-export earlier, or adding a
  top-level read in `workflowValidation.ts`, reintroduces a TDZ failure that
  only manifests depending on import order.
- The web `WorkflowEditor` draft (`useWorkflowDraft.ts`) still has its own,
  separately-encoded `validate()` — it was **not** migrated onto
  `shared/workflowValidation.ts` in this change. Drift between the two is a
  known, currently-accepted risk.

## Two front doors

The Claude SDK lets a client host an MCP server **in process** (`createSdkMcpServer`),
so `workerMcp.ts` builds one inside the worker and points every handler back at the
bridge. Codex has no such hook: it spawns every MCP server as a child process named
in its `config.toml`. The same tool surface therefore needs a second front door.

`server/src/linesMcpStdio.ts` is that door — a real stdio MCP server, spawned by
codex, that is a **proxy and not a second implementation**. It asks the bridge for
the manifest and forwards each call to it over `POST /lines-mcp`. That is what keeps
the two doors from drifting: one description of the surface
(`LINES_TOOL_MANIFEST`), one implementation behind it (`createMcpDispatcher`), and
rewording a tool still restarts nothing.

| | Claude | codex |
| --- | --- | --- |
| hosting | in-process, built in the worker | child process, spawned by codex |
| built by | `workerMcp.ts` (`buildMcpServer`) | `linesMcpStdio.ts` |
| schema form | manifest → Zod (`tool()` wants Zod) | manifest → JSON Schema (MCP wants JSON Schema) |
| call path | worker → `rpcCall('mcpTool')` → bridge | child → `POST /lines-mcp` → bridge |
| merged in | `mergeMcpServers` in the worker | `mergeMcpServers` in `buildCodexOptions` |

Both merges put the Lines entry **last**, which is load-bearing in both: a user
connection named `lines` would otherwise take over the `mcp__lines__*` namespace
with no error anywhere.

### How the child authenticates

`POST /lines-mcp` takes the per-boot runtime token as a bearer, compared in constant
time. That token already gates the worker's control channel, lives in a 0600 file
and changes on every restart — so a child left behind by an old bridge fails closed
rather than acting on a new one. The child re-reads the run file on **every** call
rather than caching it: codex keeps the process for the life of the thread, and the
bridge rebinds its port on every hot reload.

The request names a user, because one bridge can serve several and each has its own
`CODEX_HOME`. It is resolved with `registry.peek`, never `get` — `get` would build a
context, and a store directory, for any string handed to it.

### What the codex door cannot do

Codex names one MCP server for the whole `CODEX_HOME`, so a tool call arriving at
the bridge cannot say which *thread* made it. The two session-scoped tools therefore
decline rather than guess: `authorize_mcp_connection` refuses and names Settings →
Connections instead, and `list_mcp_connections` omits per-session status. The other
eleven are unaffected — they are about stored data, not about the calling session.

## Related decisions

- [smart-turn-routing](smart-turn-routing.md) — `save_step`/`create_workflow`/`update_workflow`
  also accept a step-level `routing` field (rule + allowed models/efforts), validated the same way
  as `model`/`reasoningEffort` via `shared/workflowValidation.ts` before it reaches
  `WorkflowEngine.save()`.
- [permissions-and-plan-mode](permissions-and-plan-mode.md) —
  same `PreToolUse`/`canUseTool` hook path this feature adds a namespace branch
  to; no new hook mechanism was introduced.
- [context-window](context-window.md) — the other feature
  that extended `workerProtocol.ts`/`worker.ts`/`workerClient.ts` for a new
  bridge↔worker request shape (`ask`/`askResult`) without a protocol bump; this
  feature's `push.tools` field follows the same "additive field, not a new
  message type" instinct where possible, but still bumped the version since an
  old worker silently running with no tools was judged worse than a loud
  mismatch.
- [workflow-step-versioning](workflow-step-versioning.md) — the own-beats-shared
  ownership classification and `StepRef.ownerId` drift-healing that
  `WorkflowEngine.save()`/`ForeignWorkflowError` share with the browser editor.
