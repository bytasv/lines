# Model selector

## Purpose

Lets the user pick which Claude model a session or workflow step runs with. Each option
shows the model name plus a one-line description to help users pick between models.

## Entry points

- Session composer model dropdown
- New-session defaults in the settings modal's Sessions pane
- Workflow step editor and step library model dropdowns

## Important files

- `shared/types.ts` — `ModelOption` type, `DEFAULT_MODELS` list, `DEFAULT_MODEL`, `LEGACY_MODEL_MAP`, `resolveModelId`, `isKnownModel`
- `web/src/lib/modelSelect.tsx` — shared Mantine `Select` data/render helpers
- `web/src/components/Composer.tsx`
- `web/src/components/SettingsModal.tsx`
- `web/src/components/workflow/StepLibrary.tsx`
- `web/src/components/workflow/StepCard.tsx` — also renders the stale-model warning badge
- `web/src/store.ts` — client `models: ModelOption[]` state; resolves a stale persisted new-session default on load
- `server/src/index.ts` — serves `DEFAULT_MODELS` in the `hello` message
- `server/src/sessions.ts` — resolves a session/step's model id at query-build time and in `setModel()`

## Important symbols

- `ModelOption` — `{ id, label, description?, contextWindow? }`
- `modelSelectData()` — maps `ModelOption[]` to Mantine `Select` data with descriptions; given `ensureId`, appends a disabled "No longer available" entry if that id isn't in `models`
- `renderModelOption` — alias of `renderOptionWithDescription` (Mantine `renderOption` renderer: label + dimmed description), shared with the [permissions-and-plan-mode](permissions-and-plan-mode.md) dropdowns
- `modelComboboxProps` — widens the dropdown popover for narrow inputs without widening the input itself; also reused by the permission-mode workflow Selects
- `LEGACY_MODEL_MAP` — explicit map of retired model ids to their replacement
- `resolveModelId()` — known ids pass through; otherwise applies `LEGACY_MODEL_MAP`; unmapped unknown ids pass through unchanged
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

None recorded.

## Two providers

`ModelOption.provider` (`'anthropic' | 'openai'`) says which vendor's engine a model runs on.
It is **optional, and absent means `'anthropic'`** — the same convention `resolvedBy` uses — so
every pre-existing entry, every stored step model and every older client's copy of the list
means exactly what it meant before. `providerForModel(id)` resolves an id and answers
`'anthropic'` for anything unlisted, so a dated snapshot or a hand-typed id keeps behaving as
it did: a model has to be *listed* as OpenAI to be treated as one.

`modelSelectData()` stays the single entry point, and gained two options rather than letting
call sites filter their own lists:

- `providers` — which vendors this picker may offer. No caller narrows it today: the workflow
  step pickers and the recipe run modal used to pass `['anthropic']`, on the grounds that a
  step's model is applied with `setModel` and would flip a running workflow onto a provider
  holding none of its conversation. That was the right worry attached to the wrong control —
  the fix is to drop the conversation, not to hide the models, so a provider-changing step is
  now forced to be a fresh start. See
  [workflow-step-lifecycle](workflow-step-lifecycle.md).
- `unavailable` — render a provider's options disabled with a reason. Used for "connect an
  OpenAI account" and for "this session has already run on the other provider", so a blocked
  option still says why instead of vanishing.

**OpenAI models carry no `contextWindow`.** The number is not unknown — codex reports one per
thread on `thread/tokenUsage/updated`, and that reading wins over the table via
`ContextUsage.maxTokens`. A static value here would be a second, staler answer to a question
the engine already answers. See [openai-codex-sessions](openai-codex-sessions.md).

## Reasoning effort

A second, related control sits beside the model `Select` in every one of these entry points:
how hard the chosen model thinks, not just which model it is. It is its own feature — see
[reasoning-effort-selection](reasoning-effort-selection.md) — but reuses this file's
`modelComboboxProps` and `renderOptionWithDescription`, and its own `effortSelectData()` is
`web/src/lib/modelSelect.tsx`'s second entry point.
