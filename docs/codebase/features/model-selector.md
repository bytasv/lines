# Model selector

## Purpose

Lets the user pick which Claude model a session or workflow step runs with. Each option
shows the model name plus a one-line description to help users pick between models.

## Entry points

- Session composer model dropdown
- New-session defaults in the settings modal's Sessions pane
- Workflow step editor and step library model dropdowns
- Per-run step overrides: `WorkflowRunModal`, opened by Cmd/Ctrl+click on a new-session entry or the stepper's tune icon

## Important files

- `shared/types.ts` — `ModelOption` type, `DEFAULT_MODELS` list, `DEFAULT_MODEL`, `LEGACY_MODEL_MAP`, `resolveModelId`, `isKnownModel`
- `web/src/lib/modelSelect.tsx` — shared Mantine `Select` data/render helpers
- `web/src/components/Composer.tsx`
- `web/src/components/SettingsModal.tsx`
- `web/src/components/workflow/StepLibrary.tsx`
- `web/src/components/workflow/WorkflowRunModal.tsx` — per-step model/effort picker for one run
- `web/src/components/workflow/StepCard.tsx` — also renders the stale-model warning badge
- `web/src/store.ts` — client `models: ModelOption[]` state; resolves a stale persisted new-session default on load
- `server/src/index.ts` — serves `DEFAULT_MODELS` in the `hello` message
- `server/src/sessions.ts` — resolves a session/step's model id at query-build time and in `setModel()`

## Important symbols

- `ModelOption` — `{ id, label, description?, contextWindow?, price?, provider? }`
- `modelSelectData()` — maps `ModelOption[]` to Mantine `Select` data with descriptions; given `ensureId`, appends a disabled "No longer available" entry if that id isn't in `models`. Takes `providers`/`unavailable`/`warn` — see Two providers.
- `renderModelOption` — alias of `describedOptionRenderer()` with no click handler (Mantine `renderOption` renderer: label + dimmed description + optional warning icon), shared with the [permissions-and-plan-mode](permissions-and-plan-mode.md) dropdowns
- `describedOptionRenderer(onWarningClick?)` — the renderer factory; a handler makes an
  actionable warning's icon a link. `describedOptionStyles` pairs with it, overriding
  Mantine's disabled-option opacity so the icon does not dim with the row.
- `modelComboboxProps` — widens the dropdown popover for narrow inputs without widening the input itself; also reused by the permission-mode workflow Selects
- `LEGACY_MODEL_MAP` — explicit map of retired model ids to their replacement
- `resolveModelId()` — known ids pass through; otherwise applies `LEGACY_MODEL_MAP`; unmapped unknown ids pass through unchanged. The lookup is a single hop, not a chain: retiring a model must repoint every `LEGACY_MODEL_MAP` entry that targeted it, or those entries resolve to an id no longer in `DEFAULT_MODELS` and `priceFor`/`contextWindowFor` silently answer `undefined` for them.
- `isKnownModel()` — true if an id is in `DEFAULT_MODELS`

## Data flow

`DEFAULT_MODELS` (shared/types.ts) → server `hello` message → client store `models` →
each Select via `modelSelectData()` + `renderModelOption`.

A session/step's stored `model` id is resolved at the point of use — `resolveModelId()` in
`buildQueryOptions()` and `setModel()` (server/src/sessions.ts) — not migrated on disk. The
Select components pass the current value as `ensureId` so an unknown persisted id still shows
(disabled, labeled "No longer available") instead of a blank input.

## Dependencies

Mantine `@mantine/core` `Select` (`renderOption`, `comboboxProps`).

## Tests

None. No web test infrastructure covers UI components at time of writing.

## Business rules

`description` is optional — server-supplied models without one render label-only, no fallback text.

A step/session referencing a retired model id keeps that id in storage (no migration); a
yellow warning badge on the step card (`StepCard.tsx`) flags it so the user can update it.
For read-only pinned refs the tooltip points to update/re-pin/duplicate instead of an inline
model change. At runtime, `resolveModelId()` transparently substitutes the mapped replacement
so the step/session still runs; an unmapped unknown id is passed to the SDK as-is rather than
forced to a default.

## Architectural rules

Reuse `modelSelectData()` / `renderModelOption` for every model `Select` instead of inlining
`data={models.map(...)}` per component, to keep dropdown appearance consistent. Pass the
current stored model id as `ensureId` so a stale/unknown id always renders instead of leaving
the Select blank.

Legacy-model resolution lives in `shared/types.ts` as a static explicit map, not a tier-prefix
heuristic or live Models-API lookup — the repo has no Models-API infra, and an explicit map
can't misfire on a valid dated snapshot id.

## Related decisions

- [cross-provider-model-switching](cross-provider-model-switching.md) — the confirm-dialog
  path a cross-provider pick takes on a session that has run.
- [settings-updates-pane](settings-updates-pane.md) — the CLI-availability status the `warn`
  option and its Updates-pane link read.

## Two providers

`ModelOption.provider` (`'anthropic' | 'openai'`) says which vendor's engine a model runs on.
It is **optional, and absent means `'anthropic'`** — the same convention `resolvedBy` uses — so
every pre-existing entry, every stored step model and every older client's copy of the list
means exactly what it meant before. `providerForModel(id)` resolves an id and answers
`'anthropic'` for anything unlisted, so a dated snapshot or a hand-typed id keeps behaving as
it did: a model has to be *listed* as OpenAI to be treated as one.

`modelSelectData()` stays the single entry point, and has three options rather than letting
call sites filter their own lists:

- `providers` — which vendors this picker may offer. Only `WorkflowRunModal` narrows it today (to `['anthropic']`, for per-run step overrides). The workflow
  step pickers and the recipe run modal used to pass `['anthropic']`, on the grounds that a
  step's model is applied with `setModel` and would flip a running workflow onto a provider
  holding none of its conversation. That was the right worry attached to the wrong control —
  the fix is to drop the conversation, not to hide the models, so a provider-changing step is
  now forced to be a fresh start. See
  [workflow-step-lifecycle](workflow-step-lifecycle.md).
- `unavailable` — render a provider's options **disabled** with a reason, shown as a warning
  icon beside the label (`describedOptionRenderer`) rather than as the option's description.
  Used for "connect an OpenAI account" and for whatever
  [`providerSwitchBlock`](cross-provider-model-switching.md) currently refuses on a session
  that has run (a workflow step consolidating, a queued message written against the old
  conversation) — **not** "this session has already run on the other provider": picking the
  other provider on a session that has run no longer disables the option, it opens a confirm
  dialog (see below).
- `warn` — render a provider's options disabled for a reason the *app* cannot fix, with the
  warning icon rendered as a link rather than a plain tooltip: clicking it opens Settings →
  Updates instead of doing nothing. Used for a provider whose CLI is not installed or is too
  old on this machine (`ClaudeCliStatus`/`CodexCliStatus`, see
  [settings-updates-pane](settings-updates-pane.md)) — an account can be connected but the
  turn still cannot run without the binary.

`describedOptionRenderer(onWarningClick?)` is the renderer both `unavailable` and `warn`
options go through: the row itself stays at full opacity (Mantine's default disabled-option
`opacity: 0.35` is overridden via `describedOptionStyles`, since it would otherwise dim the
warning icon along with everything else) and only the label text dims, so the icon is what
stands out. The icon is a click target — `pointerEvents: 'auto'` against the disabled row's
`cursor: not-allowed` — only when `onWarningClick` is supplied and the option's
`warningActionable` flag is set (true for `warn` entries, never for `unavailable` ones: an
account to connect is not fixed in the Updates pane). `renderModelOption` remains
`describedOptionRenderer()` with no handler, for the callers with nowhere to send anyone
(the workflow step editor, the recipe run modal).

**Picking the other provider on a session that has already run opens a confirm dialog
instead of dispatching `setModel`.** The composer's `onChange` checks
`providerForModel(v) !== provider` on a session with `hasRun`; if so it stages the target
model and shows `ConfirmModal` naming what is dropped, what is kept (the visible transcript),
and — on a workflow session — what the next step will do, before sending
`{ type: 'switchProvider', ... }`. See
[cross-provider-model-switching](cross-provider-model-switching.md) for the whole mechanism;
this file only owns the picker's own presentation of it.

**OpenAI models carry no `contextWindow`.** The number is not unknown — codex reports one per
thread on `thread/tokenUsage/updated`, and that reading wins over the table via
`ContextUsage.maxTokens`. A static value here would be a second, staler answer to a question
the engine already answers. See [openai-codex-sessions](openai-codex-sessions.md).

**`ModelOption.price` is filled for every model, both providers.** Unlike `contextWindow`, it is
never read for display here — the selector has no cost column — and it is never a substitute for
a reported cost: it exists purely so a provider whose capability table says `cost: false` can have
its turns priced from something. See [usage-and-cost](usage-and-cost.md) for `priceFor` /
`estimateSpendUsd` and the `~` marking that keeps an estimated figure from looking like a
provider-reported one.

## Per-run overrides

A workflow run can pick a model (and effort) per step without editing the workflow:
`WorkflowRunModal` lists one row per step, defaulting to the step's own values, and emits only the
rows that differ as `WorkflowState.stepOverrides`. The override layers over the stored step at
`runStep` time and is resolved with `resolveModelId` like any step model, so a stale id in an
override renders disabled via `ensureId` and still runs. It is Claude-only: `sanitizeStepOverrides`
drops any other provider's model. See [workflow-step-lifecycle](workflow-step-lifecycle.md).

## Reasoning effort

A second, related control sits beside the model `Select` in every one of these entry points:
how hard the chosen model thinks, not just which model it is. It is its own feature — see
[reasoning-effort-selection](reasoning-effort-selection.md) — but reuses this file's
`modelComboboxProps` and `renderOptionWithDescription`, and its own `effortSelectData()` is
`web/src/lib/modelSelect.tsx`'s second entry point.

## Smart routing

The model a session or step is set to is otherwise fixed until someone changes it by hand. With
[smart-turn-routing](smart-turn-routing.md) turned on, a per-turn classifier (JEV) may move an
individual turn to another model within an allowed list — never across providers, never outside
that list — before the turn is pushed. The composer shows this with a small "auto" badge beside
the model picker; the picker itself, `modelSelectData()`, and `setModel`'s cross-provider refusal
are all unchanged.
