# Conversational workflow/step editing (in-process MCP tools)

## Purpose

Lets a Lines session discuss and edit its own workflows and reusable steps in
plain conversation — "what workflows do we have?", "add a review step to the
MVP flow" — instead of requiring the browser's `WorkflowEditor` modal. Backed by
an in-process MCP server (`mcp__lines__*`) exposed to every session; writes are
permission-gated through the existing card, reads are not.

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

## Related decisions

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
