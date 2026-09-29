# Smart turn routing (JEV)

## Purpose

Before each turn, optionally ask TypeSafe's JEV classifier ("System One Model") which of an
allowed set of models and reasoning efforts that turn should run on, given a plain-language rule.
Model and reasoning-effort selection ([model-selector](model-selector.md),
[reasoning-effort-selection](reasoning-effort-selection.md)) are otherwise fixed for a whole
session or workflow step — this lets an easy follow-up run cheap and a hard turn run at full
effort, without the user hand-tuning either every time.

Global, three modes: `off` (default — JEV is never called), `auto` (a confident pick is applied
silently), `ask` (the turn is held until the user accepts or declines the suggestion). A workflow
step may carry its own rule, overriding the global one while that step runs.

## Entry points

- Settings modal, "Smart routing" section (`web/src/components/SettingsModal.tsx`) — mode and one
  rule per connected provider
- Workflow step editor, "Own routing rule" (`web/src/components/workflow/StepCard.tsx`)
- Composer badge and ask-mode suggestion card (`web/src/components/Composer.tsx`)
- `save_step`/`create_workflow`/`update_workflow` MCP tools' `routing` field
  (`server/src/mcpWorkflowTools.ts`)

## Important files

- `shared/types.ts` — `RoutingMode`, `RoutingRule`, `RoutingPick`, `StepContent.routing`,
  `SessionMeta.routingSuggestion`/`lastRouting`/`routingPaused`, `UserUiSettings.smartRouting`,
  the `routingChoice`/`setRoutingPaused` `ClientMessage`s and their `MESSAGE_AUTHZ` rows,
  `ServerMessage['hello'].smartRoutingAvailable`
- `shared/workflowValidation.ts` — `validateRoutingRule`, called from step validation and from
  the settings save path
- `server/src/jev.ts` — `decideTurn`, the only code that calls TypeSafe; `jevConfigured`
- `server/src/turnRouting.ts` — `resolveRule`, `acceptPick`, `smartRoutingIssues` (pure, no I/O)
- `server/src/sessions.ts` — the hook in `SessionManager.pushTurn`/`routeTurn`, `heldTurns`,
  `routingChoice`, `applyRouting`, `pauseRoutingForManualChange`, `setRoutingPaused`, `markRetry`,
  the reconcile cleanup for an orphaned `routingSuggestion`
- `server/src/workflows.ts` — `sameContent`'s `routing` comparison, `stepRouting` (the
  `StepRoutingProvider` registered on `SessionManager`), clearing `routingPaused` on step entry
- `server/src/index.ts` — `routingChoice`/`setRoutingPaused` message handlers, pausing routing on
  a manual `setModel`/`setReasoningEffort`, `smartRoutingAvailable` on `hello`,
  `smartRoutingIssues` gating `saveSettings`
- `server/src/mcpWorkflowTools.ts` — the `routing` schema property, `toRoutingRule`
- `web/src/components/RoutingRuleFields.tsx` — the shared rule/models/efforts editor, used by
  both Settings and the step editor
- `web/src/components/Composer.tsx` — the "auto"/"auto off" badge and the ask-mode suggestion card
- `web/src/store.ts` — `smartRouting`, `setSmartRouting`, `smartRoutingAvailable`

## Important symbols

- `RoutingRule` — `{ rule, models, efforts, minConfidence? }`; every model is on one provider,
  `efforts` a subset of that provider's own list
- `RoutingPick` — `{ model, effort?, confidence, at }`, the shape of both `lastRouting` and
  `routingSuggestion`
- `decideTurn(input, deps?)` — one JEV call per turn: a `choice` question for the model, a
  `score` question for the effort, each with its own confidence; never throws, answers `null` on
  a missing key, non-2xx, malformed body or timeout
- `resolveRule(meta, settings, stepRule?)` — the rule for this session's next turn: the step rule
  if given, else the global rule for the session's provider; `undefined` when the mode is `off`,
  routing is paused, or the session is in plan mode
- `acceptPick(pick, rule, current)` — the change to apply, or `null` when the pick is out of the
  rule's allowlist, below its confidence floor, or equal to the session's current setting; model
  and effort are gated independently
- `SessionManager.routeTurn` — calls `decideTurn`/`acceptPick` and, on a change, either applies it
  (`auto`) or parks the turn in `heldTurns` and sets `routingSuggestion` (`ask`)
- `SessionManager.routingChoice(sessionId, accept)` — releases a held turn, switching to the
  suggestion first when accepted

## Data flow

Every turn that starts through `SessionManager.prompt()` — a user send, a queue flush, a workflow
step, Retry, Continue, a hand-off — passes through `pushTurn`, which resolves the applicable rule
(`resolveRule`) before either engine's push. An interjection (`intoLiveTurn`) is never routed: it
joins a turn already running. With a rule in hand, `routeTurn` calls JEV with the turn's prompt
text and a few plain-line signals (current model/effort, turn source, whether the last turn
failed, whether it's a retry with feedback, the step name) — never the transcript, never tool
output.

- **`auto`**: `applyRouting` calls `setModel`/`setReasoningEffort` and records `lastRouting`, then
  the turn pushes normally. Because this runs before `pushWithToken`'s stale-query check, an
  applied effort/model change recycles the Claude query on *this* same push, once. Codex rebuilds
  its options from the meta on every push and needs nothing extra.
- **`ask`**: the SDK-shaped message is parked in the bridge-memory `heldTurns` map,
  `routingSuggestion` is set and broadcast, and nothing is pushed. Status stays `running`, so a
  prompt sent meanwhile queues behind it through the existing `queued` path. `routingChoice`
  releases it: accept applies the suggestion first, decline sends unchanged; either way the
  message is re-pushed through `pushTurn` (unrouted) so the CLI check and token refresh run fresh
  for a hold that may have outlived them. `interrupt` while a turn is held drops it and settles
  the turn through `failTurn`, so Retry re-sends the prompt.
- A workflow step's own `StepContent.routing` reaches `SessionManager` through
  `stepRouting`/`StepRoutingProvider`, registered by `WorkflowEngine` the same way
  `TurnCompleteListener` is — `SessionManager` learns nothing else about workflows.
- A manual `setModel`/`setReasoningEffort` from the client-message path (never routing's own
  calls) sets `routingPaused`; `WorkflowEngine.runStep` clears it on step entry.
- A bridge restart loses `heldTurns`; boot-time reconcile clears any leftover
  `routingSuggestion` and the orphaned `running` turn lands on the normal Continue/Retry path.

## Dependencies

TypeSafe's official System One Model API — `POST https://api.typesafe.ai/v1/systemone`
(docs.typesafe.ai), never a third-party proxy. `TYPESAFE_API_KEY` (bridge env; optional
`TYPESAFE_MODEL`, default `jev-latest`). The base URL is a source constant, not env, so a config
mistake cannot redirect a session's prompt text to an unverified endpoint.

## Tests

- `server/src/turnRouting.test.ts` — rule precedence (step, then global, then none), off/paused/
  plan-mode giving no rule, a rule naming another provider's model never applying,
  `acceptPick`'s allowlist/confidence/no-op gates, `smartRoutingIssues`
- `server/src/jev.test.ts` — no key, timeout, non-2xx and malformed-body cases all answer `null`;
  the official endpoint and body shape, and the safe-id→model-id mapping
- `server/src/sessions.routing.test.ts` — `auto` applying a pick and recycling the query exactly
  once; a `null` answer pushing unchanged; an interjection skipping JEV; `ask` holding, accepting,
  declining and interrupting a turn; a queued prompt during a hold; a codex session routed within
  its own provider; a workflow step's rule overriding the global one; reconcile clearing an
  orphaned suggestion
- `server/src/workflows.providers.test.ts` — a step routing rule naming a cross-provider model is
  rejected by `validateStepContent`
- `server/src/workflows.advance.test.ts` — step entry clears `routingPaused`
- `server/src/messageAuthz.test.ts` — `routingChoice`/`setRoutingPaused` require the `setModel`
  capability, same as `setReasoningEffort`

## Business rules

- **`off` never calls JEV**, and the mode defaults to `off` — no session is routed, and no prompt
  text leaves the bridge, until a user opts in.
- **Plan mode is never routed.** Plan mode already has its own global effort
  (`UserUiSettings.planReasoningEffort`, see [reasoning-effort-selection](reasoning-effort-selection.md)),
  and that keeps winning.
- **A routing rule never crosses providers.** Every model in `RoutingRule.models` must be on the
  rule's own provider (`validateRoutingRule`); a rule that somehow names another provider's model
  is treated as absent rather than applied, so routing can never hit `setModel`'s cross-provider
  refusal.
- **Model and effort are gated independently.** Each of JEV's two answers carries its own
  confidence, so a confident effort bump can apply while an unsure model pick is skipped, or the
  reverse.
- **A pick equal to the session's current setting is a no-op** — no query recycle, no
  `lastRouting` update.
- **A manual model or effort change pauses routing for that session** until the composer's badge
  is clicked to resume it, or the next workflow step starts (`WorkflowEngine.runStep` clears the
  pause on step entry, regardless of whether the session was in `ask` or `auto`).
- **A step's own `routing` overrides the global rule for its provider** while that step runs; the
  step's `model`/`reasoningEffort` stay the turn's starting point, same as before this existed —
  routing may then move a turn away from them per-turn (see the update to
  [reasoning-effort-selection](reasoning-effort-selection.md)'s "absolute, not additive" rule).
- **No LLM fallback.** With no `TYPESAFE_API_KEY`, a non-2xx response, a malformed body or a
  timeout (~1.5s, short because this sits on every routed turn's critical path), the turn runs on
  its current settings — the same fail-open contract `runHelperQuery` uses for title generation.
- **Only the turn's own prompt text is sent to JEV**, capped in length, plus a few plain-line
  signals — never the transcript and never tool output. This bounds both what TypeSafe sees and
  what a prompt injection in the conversation could steer; the pick is constrained to the rule's
  allowlist either way.

## Architectural rules

- **The hook lives in `SessionManager.pushTurn`**, the single async point every turn passes
  through — user prompt, queue flush, workflow step, retry, hand-off — inserted after the
  `intoLiveTurn` early return (interjections are never routed) and before the codex branch and
  `pushWithToken`.
- **The step rule reaches `SessionManager` through an injected callback** (`StepRoutingProvider`),
  registered by `WorkflowEngine` in its constructor — the same injection style
  `TurnCompleteListener` already uses. `SessionManager` never imports anything workflow-specific
  for this.
- **`heldTurns` is bridge-memory only**, never persisted; a restart loses it by design, and boot
  reconcile clears the matching `routingSuggestion` so the UI doesn't show a suggestion nothing
  can answer.
- **A held turn's release goes back through `pushTurn`, not straight to `pushWithToken`** — a long
  ask-mode hold can outlive the access token, so the normal CLI check and token refresh have to
  run again on release.
- **Routing's own `setModel`/`setReasoningEffort` calls never set `routingPaused`** — the pause is
  set only from the client-message handler path (`server/src/index.ts`), not inside
  `SessionManager.setModel`/`setReasoningEffort` themselves, so routing does not pause itself.
- **`server/src/jev.ts` only ever calls the official TypeSafe endpoint**, hardcoded as a source
  constant rather than read from env — a config typo cannot route a session's prompts through an
  unverified third-party proxy.
- **`sameContent` (workflow versioning) compares `routing` too**, via a stable (key-sorted) JSON
  serialization — otherwise a routing-only step edit would never mint a new immutable version.

## Related decisions

- [reasoning-effort-selection](reasoning-effort-selection.md) — the effort control this can now
  override per turn; its "a step's effort is absolute" rule is qualified by this feature.
- [model-selector](model-selector.md) — the model control this can now move within the session's
  provider, per turn.
- [workflow-step-lifecycle](workflow-step-lifecycle.md) — `WorkflowEngine.runStep` clears
  `routingPaused` on step entry, alongside its existing `stepFailure` reset.
- [workflow-mcp-tools](workflow-mcp-tools.md) — the `routing` field on the `save_step`/
  `create_workflow`/`update_workflow` tool schemas.
- [session-collaboration](session-collaboration.md) — `MESSAGE_AUTHZ`, the table
  `routingChoice`/`setRoutingPaused` are classified in; both reuse the `setModel` `ShareCaps`
  capability, the same way `setReasoningEffort` does (see
  [reasoning-effort-selection](reasoning-effort-selection.md)).
- [openai-codex-sessions](openai-codex-sessions.md) — codex rebuilds its turn options from the
  session meta on every push, so an applied routing change needs no stale-query mechanism there.

## Unresolved / left open

- The TypeSafe API key lives in bridge env (`TYPESAFE_API_KEY`) only; a per-user secret is not
  implemented.
- The default `minConfidence` (0.7) is uncalibrated against real JEV answers.
- The ~1.5s timeout has not been measured against real-world JEV latency.
- TypeSafe's data-retention policy for `state` text has not been reviewed.
