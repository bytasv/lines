# Manual reasoning-effort selection

## Purpose

Let a user (or a workflow step) pick how hard a model thinks, not just which model runs — beside
the model picker in the composer, on a workflow step, as a new-session default, and as a global
effort for plan-mode turns specifically. Before this, both providers' engines exposed the control
and Lines ignored it on both; a "rename this variable" turn and a "design the migration" turn cost
the same thinking budget.

## Entry points

- Session composer, next to the model `Select` (`web/src/components/Composer.tsx`)
- New-session defaults and the global plan-mode effort in the settings modal's Sessions/Plan-mode
  panes (`web/src/components/SettingsModal.tsx`)
- Workflow step editor and step library (`web/src/components/workflow/StepCard.tsx`,
  `web/src/components/workflow/StepLibrary.tsx`)
- `save_step`/`create_workflow`/`update_workflow` MCP tools (`server/src/mcpWorkflowTools.ts`)

## Important files

- `shared/types.ts` — `ReasoningEffort`, `REASONING_EFFORTS`, `isReasoningEffort`;
  `SessionMeta.reasoningEffort`, `StepContent.reasoningEffort`,
  `UserUiSettings.newSessionDefaults.reasoningEffort`, `UserUiSettings.planReasoningEffort`; the
  `setReasoningEffort` `ClientMessage` and its `MESSAGE_AUTHZ` rule
- `shared/providers.ts` — `ProviderCapabilities.reasoningEfforts`, the per-provider list
- `shared/workflowValidation.ts` — validates a step's effort against Anthropic's list
- `server/src/sessions.ts` — `resolveReasoningEffort`, `SessionManager.setReasoningEffort`, the
  stale-query mechanism, and both option builders
- `server/src/codexPlanMode.ts` — `codexCollaborationMode`'s third parameter
- `server/src/workerCodex.ts` — `applyModePreset` (a non-null effort passes through untouched)
- `server/src/workflows.ts` — per-step apply/clear, `attach`, `sameContent`
- `server/src/mcpWorkflowTools.ts` — the `reasoningEffort` schema property, three call sites
- `web/src/lib/modelSelect.tsx` — `effortSelectData`, `AUTO_EFFORT`, `STEP_EFFORTS`
- `web/src/store.ts` — `NewSessionDefaults.reasoningEffort`, `planReasoningEffort`,
  `setPlanReasoningEffort`

## Important symbols

- `ReasoningEffort` — `'low' | 'medium' | 'high' | 'xhigh' | 'max'`
- `REASONING_EFFORTS` — every level any provider accepts, weakest first
- `ProviderCapabilities.reasoningEfforts` — which of those levels *this* engine accepts; empty
  hides the control the way `linesTools`/`rewind` already do
- `resolveReasoningEffort(meta, settings, allowed)` — the one precedence rule both option builders
  call: plan mode with a global plan effort set wins, else the session's own effort, else
  `undefined`; a level `allowed` does not contain is dropped
- `SessionManager.setReasoningEffort(sessionId, effort | null)` — stores it and, on a Claude
  session, marks the live query stale
- `codexCollaborationMode(planMode, model, effort?)` — the codex seam; `effort` absent leaves
  `reasoning_effort: null` for `applyModePreset` to fill from codex's own preset
- `effortSelectData(efforts, ensureValue?)` — the effort picker's single entry point, mirroring
  `modelSelectData`; always leads with an explicit "Auto" row (`AUTO_EFFORT`)

## Data flow

Composer/Settings/StepCard write `SessionMeta.reasoningEffort` / `StepContent.reasoningEffort` /
`UserUiSettings.newSessionDefaults.reasoningEffort` / `UserUiSettings.planReasoningEffort` via
`setReasoningEffort` / `saveSettings` / a workflow save, exactly like the model picker does. Both
of `SessionManager`'s option builders (`buildQueryOptions` for Claude, `buildCodexOptions` for
codex) call `resolveReasoningEffort` fresh on every push — nothing is cached beyond the meta/store
fields themselves — and filter the result against that provider's own
`ProviderCapabilities.reasoningEfforts` before it ever reaches the wire.

- **Claude**: a resolved effort becomes `options.effort`; absent means the key is not present at
  all, so an untouched session's serialized options are byte-identical to before this existed.
- **Codex**: the resolved effort rides the `collaborationMode` object every turn already carries
  (`collaborationMode.settings.reasoning_effort`), not `turn/start.effort` — see Architectural
  rules. Absent leaves it `null`, which `applyModePreset` (in the worker) fills from
  `collaborationMode/list`, exactly as it did before manual selection existed.

A workflow step's effort is applied by `WorkflowEngine.runStep` beside `setModel`/
`setPermissionMode`, and by `attach` for step 0 up front (mirroring `meta.model = step0.model`).

## Dependencies

The Agent SDK's top-level `effort` option (`Options.effort`); codex's `collaborationMode` /
`collaborationMode/list` app-server methods (see
[openai-codex-sessions](openai-codex-sessions.md)).

## Tests

- `server/src/sessions.effort.test.ts` — the resolution precedence, the Claude push carrying no
  `effort` key until one is chosen, and the stale-query mechanism (a changed effort rebuilds the
  query on the *next* push, an unrelated turn does not close it)
- `server/src/codexPlanMode.test.ts` — `codexCollaborationMode`/`applyModePreset` pure-function
  coverage: unset stays null, a chosen effort passes through, a failed `collaborationMode/list`
  still keeps Plan off null
- `server/src/sessions.codex.test.ts` — a chosen effort riding the collaboration mode on a real
  push, and plan mode preferring the global plan effort over the session's own
- `server/src/workflows.providers.test.ts` — a step applying its own effort, and a following step
  with none clearing it (the leak this feature has to avoid)
- `server/src/messageAuthz.test.ts` — `setReasoningEffort` denied for a Can-prompt guest, allowed
  for a collaborator (it reuses the `setModel` capability)

## Business rules

- **Absent means the provider's own default**, everywhere — never a sentinel and never `null` on
  the wire for Claude. Codex still receives an explicit `null` when nothing is chosen, but that
  `null` means "ask codex for its preset" (see `codexPlanMode.ts`), not "the user chose nothing";
  a user-chosen value must never itself be sent as `null`.
- **No `minimal`.** OpenAI's own config reference lists it, but a live `codex app-server` turn
  sent with `reasoning_effort: 'minimal'` fails outright — *"Unsupported value: 'minimal' is not
  supported with the '\<model>' model. Supported values are: 'none', 'low', 'medium', 'high',
  'xhigh', and 'max'."* — measured directly against the app-server, not assumed from docs. Both
  providers' `reasoningEfforts` lists are `low..max` today.
- **Plan mode has its own global effort**, `UserUiSettings.planReasoningEffort`, mirroring codex's
  own `plan_mode_reasoning_effort` config key. It overrides the session's own effort only while
  that session is in plan mode; an ordinary turn in the same session is unaffected.
- **A workflow step's effort is absolute, not additive.** A step with no effort *clears* the
  session back to the provider default rather than inheriting the previous step's — `setModel`'s
  sibling call is made every step start, including when the step's own effort is `undefined`.
- **No cross-provider refusal.** Unlike `setModel`, changing effort never strands a conversation,
  so `setReasoningEffort` has no verdict to report and no fresh-start machinery.
- **Filtered at push time, not at write time.** A stored effort the session's current provider
  does not offer (reachable via a pre-first-turn provider switch) is silently dropped rather than
  sent — the alternative is the provider rejecting the whole turn.
- **Effect lands on the next turn, never the running one** — same promise the model pill already
  makes.

## Architectural rules

- **The Claude query-reuse trap.** The worker's `ensureSession` returns an already-live query
  early and discards the options of every later push. An effort change therefore cannot simply
  change what the *next* `buildQueryOptions()` call returns — the live query has to be torn down
  first. Rather than closing it immediately (which would kill whatever the session is doing),
  `setReasoningEffort` marks the query stale (`SessionManager.staleQueries`), and `pushWithToken` —
  the one funnel every Claude turn already goes through — drops it there before the next push.
  This reuses the exact three exemptions `recycleIdleQueries` already has (busy, holding
  background tasks, held for an MCP OAuth handshake) for free, since a busy session's next push
  only happens once its current turn settles.
- **Codex rides `collaborationMode`, not `turn/start.effort`.** The typed field exists, but
  `collaborationMode` is already built and sent on *every* turn (plan or not) for the plan-mode
  feature, so this is one code path instead of two — and a collaboration mode carrying its own
  effort alongside a separate `turn/start.effort` would be two dials with no documented
  precedence.
- **Reuses the `setModel` capability rather than minting a new one.** Effort is strictly weaker
  than model choice — anyone who may switch the model may say how hard it thinks — so a new
  `ShareCaps` flag would only add a row nobody reasons about. `setReasoningEffort` is still a
  distinct `ClientMessage`, because `setModel` carries a cross-provider refusal verdict effort has
  no analogue for.
- **`effortSelectData` is the single entry point** every effort `Select` goes through, mirroring
  `modelSelectData`/`renderModelOption` — it always leads with an explicit "Auto" row rather than
  leaving the Select's value empty for "unset".
- Workflow steps validate against Anthropic's list only (`shared/workflowValidation.ts`), because
  a step is already refused outright for naming an OpenAI model — codex's vocabulary is
  unreachable from a step by construction.

## Related decisions

- **The plan's assumed codex vocabulary (`minimal`) was wrong**, and would have shipped a picker
  whose weakest option 400s on every codex turn — corrected after probing a real `codex
  app-server` directly rather than trusting OpenAI's published config reference.
- **`docs/proposals/reasoning-effort-selection.md`** predates this and is now stale: it claims the
  two vocabularies differ in shape (`low..xhigh..max` vs `minimal..xhigh`) and that codex takes
  `effort` on `thread/start`. Neither is true — see [openai-codex-sessions](openai-codex-sessions.md)
  and [permissions-and-plan-mode](permissions-and-plan-mode.md) for the mechanism actually used.
