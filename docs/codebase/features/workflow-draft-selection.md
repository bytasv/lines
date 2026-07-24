# Workflow editor draft selection

## Purpose

Govern which workflow the editor's draft reflects while the modal is open, across three triggers: opening the modal, an incoming `workflows` broadcast, and reconciling a just-saved new workflow with its server-assigned id. Prevents a live draft from being silently replaced by an unrelated workflow.

## Entry points

- `web/src/components/workflow/WorkflowEditor.tsx`

## Files

- `web/src/components/workflow/useWorkflowDraft.ts` (init effect, id-reconciliation effect, `loadFrom`, `doNew`, `save`)

## Symbols

- `useWorkflowDraft` (init `useEffect`, reconciliation `useEffect`, `prevOpened` ref)

## Data flow

On modal open, an effect picks the previously-selected workflow (or first owned one) and calls `loadFrom`. Saving a brand-new workflow (`draft.id === ''`) sends `saveWorkflow`; the server's subsequent `workflows` broadcast is matched back to the draft by name + deep step equality in a separate reconciliation effect, which stitches the server-assigned id onto the draft.

## Tests

None.

## Business rules

- A `workflows`/`sharedWorkflows` length change while the modal is already open with a live draft must not re-trigger the "pick a workflow" fallback — only the open transition (or no-draft state) does.

## Architectural rules

- The init effect tracks `opened` via a `prevOpened` ref and skips its `workflows[0]` fallback whenever a draft already exists and this isn't the open transition — otherwise a post-save server broadcast races the id-reconciliation effect and clobbers the just-saved draft with an unrelated workflow (`workflows[0]`).
- New-workflow id reconciliation matches by name + deep step equality (`JSON.stringify` of wire-format steps), not just step count, to avoid mismatching workflows that share a name and step count.

## Related decisions

None.
