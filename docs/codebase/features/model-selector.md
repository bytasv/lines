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

- `ModelOption` — `{ id, label, description? }`
- `modelSelectData()` — maps `ModelOption[]` to Mantine `Select` data with descriptions; given `ensureId`, appends a disabled "No longer available" entry if that id isn't in `models`
- `renderModelOption` — alias of `renderOptionWithDescription` (Mantine `renderOption` renderer: label + dimmed description), shared with the [permission-mode-selector](permission-mode-selector.md) dropdowns
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
