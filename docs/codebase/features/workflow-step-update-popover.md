# Workflow step update popover

## Purpose

When a workflow step is pinned (`ref`) to a published step definition and a newer version exists, show a warning popover with a field-by-field diff (old vs new) and an action to update the step to the latest version. A banner above the step list also lets the user update every outdated step at once, without reviewing each diff.

## Entry points

- `web/src/components/workflow/StepCard.tsx` (`UpdatePopover`)
- `web/src/components/workflow/WorkflowEditor.tsx` (outdated-steps banner "Update all" button)

## Files

- `web/src/components/workflow/StepCard.tsx`
- `web/src/components/workflow/useWorkflowDraft.ts` (`updateFor`, `updateStepToLatest`, `updateAllToLatest`)
- `web/src/components/workflow/WorkflowEditor.tsx` (wires `updateDef` prop and the banner's bulk-update button)

## Symbols

- `UpdatePopover`
- `changedFields`
- `FIELD_LABELS`
- `useWorkflowDraft.updateFor`
- `useWorkflowDraft.updateStepToLatest`
- `useWorkflowDraft.updateAllToLatest`

## Data flow

`WorkflowEditor` computes `updateDef` via `wf.updateFor(step)` (version mismatch check) and passes it to `StepCard`. When set, `StepCard` renders `UpdatePopover`, which diffs the pinned `StepContent` against the head `StepDef` per field and calls `onUpdateToLatest` (bound to `updateStepToLatest`) on confirm. The banner counts steps where `updateFor` returns a value and, on "Update all", calls `updateAllToLatest`, which re-pins every ref step whose head version is newer than its pinned version in one pass.

## Tests

None.

## Business rules

- Diff list scrolls independently (`ScrollArea.Autosize`, max height 280px) when it exceeds the popover's height; the "Update to vN" button and popover title stay pinned outside the scroll area so the action is always reachable regardless of diff length.
- "Update all" re-pins every outdated ref step directly, skipping the per-field diff review the individual popover provides.

## Architectural rules

None beyond existing Mantine popover/scroll-area usage (see `PermissionPrompt.tsx` for the same `ScrollArea.Autosize` + `mah` pattern).

## Related decisions

None.
