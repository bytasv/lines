# Workflow step update popover

## Purpose

When a workflow step is pinned (`ref`) to a published step definition and a newer version exists, show a warning popover with a field-by-field diff (old vs new) and an action to update the step to the latest version.

## Entry points

- `web/src/components/workflow/StepCard.tsx` (`UpdatePopover`)

## Files

- `web/src/components/workflow/StepCard.tsx`
- `web/src/components/workflow/useWorkflowDraft.ts` (`updateFor`, `updateStepToLatest`)
- `web/src/components/workflow/WorkflowEditor.tsx` (wires `updateDef` prop)

## Symbols

- `UpdatePopover`
- `changedFields`
- `FIELD_LABELS`
- `useWorkflowDraft.updateFor`
- `useWorkflowDraft.updateStepToLatest`

## Data flow

`WorkflowEditor` computes `updateDef` via `wf.updateFor(step)` (version mismatch check) and passes it to `StepCard`. When set, `StepCard` renders `UpdatePopover`, which diffs the pinned `StepContent` against the head `StepDef` per field and calls `onUpdateToLatest` (bound to `updateStepToLatest`) on confirm.

## Tests

None.

## Business rules

- Diff list scrolls independently (`ScrollArea.Autosize`, max height 280px) when it exceeds the popover's height; the "Update to vN" button and popover title stay pinned outside the scroll area so the action is always reachable regardless of diff length.

## Architectural rules

None beyond existing Mantine popover/scroll-area usage (see `PermissionPrompt.tsx` for the same `ScrollArea.Autosize` + `mah` pattern).

## Related decisions

None.
