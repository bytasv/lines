# Permission mode selector

## Purpose

Lets the user pick how much a session or workflow step's tool calls are gated by the
permission guard. Every picker (composer toolbar, settings defaults, workflow step
editor/library) shows the same five modes with the same labels and descriptions.

## Entry points

- Session composer permission-mode segmented control
- New-session defaults in the settings modal's Sessions pane
- Workflow step editor and step library permission-mode dropdowns

## Important files

- `shared/types.ts` — `PermissionMode` type (`default` | `auto` | `acceptEdits` | `plan` | `bypassPermissions`)
- `web/src/lib/permissionModes.tsx` — shared mode list, segmented-control data, dropdown render helper
- `web/src/lib/modelSelect.tsx` — `renderOptionWithDescription` (label + dimmed description renderer, shared with the model selector), `modelComboboxProps` (popover widener, shared)
- `web/src/components/Composer.tsx`
- `web/src/components/SettingsModal.tsx`
- `web/src/components/workflow/StepLibrary.tsx`
- `web/src/components/workflow/StepCard.tsx` — also shows the collapsed step's mode label
- `server/src/sessions.ts` — `'auto'` runs the SDK in `acceptEdits` while the bridge guard approves/prompts per tool call

## Important symbols

- `PERMISSION_MODES` — `{ value, label, description }[]`, single source of truth for all four pickers
- `PERMISSION_MODE_SEGMENTS` — `PERMISSION_MODES` mapped to Mantine `SegmentedControl` data, each label wrapped in a `Tooltip` showing the description
- `permissionModeLabel()` — label lookup by value, raw value fallback (used by the collapsed step card)
- `renderPermissionModeOption` — alias of `renderOptionWithDescription`, used as the workflow Select's `renderOption`

## Data flow

`PERMISSION_MODES` (web/src/lib/permissionModes.tsx) feeds both pickers directly — there
is no server round-trip for the mode list, unlike the model selector. The composer/settings
segmented controls use `PERMISSION_MODE_SEGMENTS`; the workflow Selects use `PERMISSION_MODES`
+ `renderPermissionModeOption`.

The chosen value is UI/storage-level only. `'auto'` is a client-and-guard concept: the SDK
session actually runs in `acceptEdits`, and the bridge guard decides per tool call whether to
auto-approve or prompt (see the `PermissionMode` doc comment in `shared/types.ts`). The guard's
exceptions to that per-call decision are a user-visible, editable list — see
[guard-allowlist](guard-allowlist.md).

## Dependencies

Mantine `@mantine/core` `SegmentedControl` (ReactNode label) and `Select` (`renderOption`,
`comboboxProps`).

## Tests

None. No web test infrastructure covers UI components at time of writing.

## Business rules

All five `PermissionMode` values stay selectable everywhere, including `acceptEdits` — preset
workflows (`web/src/lib/workflowPresets.ts`, `server/src/workflows.ts`) ship steps with
`permissionMode: 'acceptEdits'`, so dropping it from the option list would blank those Selects.

`default` displays as **Manual** — the stored value is unchanged, only the label differs.

## Architectural rules

Single shared `PERMISSION_MODES` list — no component defines its own label/description array.
Editing a label or description here changes every picker at once.

Mantine `SegmentedControl` has no per-segment tooltip prop, so per-item tooltips are attached
by wrapping each segment's `label` in a `Tooltip`-wrapped `span` (`display:block; width:100%`
so the hover target fills the segment instead of shrinking to the text).

## Related decisions

None recorded.
