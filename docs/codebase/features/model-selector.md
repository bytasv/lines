# Model selector

## Purpose

Lets the user pick which Claude model a session or workflow step runs with. Each option
shows the model name plus a one-line description to help users pick between models.

## Entry points

- Session composer model dropdown
- New-session defaults in the settings modal
- Workflow step editor and step library model dropdowns

## Important files

- `shared/types.ts` — `ModelOption` type, `DEFAULT_MODELS` list, `DEFAULT_MODEL`
- `web/src/lib/modelSelect.tsx` — shared Mantine `Select` data/render helpers
- `web/src/components/Composer.tsx`
- `web/src/components/SettingsModal.tsx`
- `web/src/components/workflow/StepLibrary.tsx`
- `web/src/components/workflow/StepCard.tsx`
- `web/src/store.ts` — client `models: ModelOption[]` state
- `server/src/index.ts` — serves `DEFAULT_MODELS` in the `hello` message

## Important symbols

- `ModelOption` — `{ id, label, description? }`
- `modelSelectData()` — maps `ModelOption[]` to Mantine `Select` data with descriptions
- `renderModelOption` — Mantine `renderOption` renderer (label + dimmed description)
- `modelComboboxProps` — widens the dropdown popover for narrow inputs without widening the input itself

## Data flow

`DEFAULT_MODELS` (shared/types.ts) → server `hello` message → client store `models` →
each Select via `modelSelectData()` + `renderModelOption`.

## Dependencies

Mantine `@mantine/core` `Select` (`renderOption`, `comboboxProps`).

## Tests

None. No web test infrastructure covers UI components at time of writing.

## Business rules

`description` is optional — server-supplied models without one render label-only, no fallback text.

## Architectural rules

Reuse `modelSelectData()` / `renderModelOption` for every model `Select` instead of inlining
`data={models.map(...)}` per component, to keep dropdown appearance consistent.

## Related decisions

None recorded.
