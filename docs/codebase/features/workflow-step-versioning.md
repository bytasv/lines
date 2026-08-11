# Workflow step versioning

Covers: `workflow-step-version-history`, `workflow-step-version-ui`,
`workflow-step-update-popover`, `workflow-draft-selection`.

## Purpose

Shared diff-popover UI for warning a pinned step is stale and for browsing/restoring/re-pinning
any past step version, plus the rules governing which workflow the editor's draft reflects while
all that is happening.

When a workflow step is pinned (`ref`) to a published step definition and a newer version exists,
show a warning popover with a field-by-field diff (old vs new) and an action to update the step
to the latest version. A banner above the step list also lets the user update every outdated step
at once, without reviewing each diff.

Separately, let a step's full immutable version history be browsed and diffed, and reused two
ways:

- **Workflow editor** — re-pin a `StepRef` to any past version of the step it points to (not just
  the latest).
- **Step library** — restore an old version's content into the editable draft; saving republishes
  it as a new head version (history is append-only, never rewritten).

Both features share the same field-diff list component and popover conventions.

Draft selection governs which workflow the editor's draft reflects while the modal is open,
across three triggers: opening the modal, an incoming `workflows` broadcast, and reconciling a
just-saved new workflow with its server-assigned id. It prevents a live draft from being silently
replaced by an unrelated workflow.

## Entry points

- `web/src/components/workflow/StepCard.tsx` (`UpdatePopover`; `VersionHistoryPopover`, opened
  from the version `Badge` or the step's kebab menu "Version history" item)
- `web/src/components/workflow/StepLibrary.tsx` (`RestoreHistoryPopover`, opened from the history
  icon next to the step's version badge)
- `web/src/components/workflow/WorkflowEditor.tsx` (outdated-steps banner "Update all" button;
  the editor modal whose draft selection is governed here)

## Files

- `web/src/components/workflow/StepCard.tsx`
- `web/src/components/workflow/StepLibrary.tsx`
- `web/src/components/workflow/useWorkflowDraft.ts` (`updateFor`, `updateStepToLatest`,
  `updateAllToLatest`, `requestStepVersions`, `versionsFor`, `pinStepToVersion`, `versionMap`;
  init effect, id-reconciliation effect, `loadFrom`, `doNew`, `save`)
- `web/src/components/workflow/WorkflowEditor.tsx` (wires `updateDef` prop and the banner's
  bulk-update button)
- `shared/types.ts` (`stepVersions` client/server message pair)
- `storage/src/index.ts` (`GET /steps/:ownerId/:id/versions`)
- `server/src/sync.ts` (`StorageSyncClient.pullStepVersions`)
- `server/src/store.ts` (`step-versions.json`, `loadStepVersions`/`saveStepVersions`)
- `server/src/workflows.ts` (`WorkflowEngine.listStepVersions`, `listOwnStepVersions`,
  `addStepVersions`, `persistSteps`)
- `server/src/index.ts` (`stepVersions` message handler)
- `web/src/store.ts` (`stepVersions` slice, `Record<"ownerId/stepId", StepDef[]>`)

## Symbols

- `UpdatePopover`
- `FieldDiffList` (exported from `StepCard.tsx`; shared by `UpdatePopover`,
  `VersionHistoryPopover`, `RestoreHistoryPopover`)
- `changedFields`
- `FIELD_LABELS`
- `relTime` (exported from `StepCard.tsx`)
- `VersionHistoryPopover`
- `RestoreHistoryPopover`
- `useWorkflowDraft.updateFor`
- `useWorkflowDraft.updateStepToLatest`
- `useWorkflowDraft.updateAllToLatest`
- `useWorkflowDraft.requestStepVersions`
- `useWorkflowDraft.versionsFor`
- `useWorkflowDraft.pinStepToVersion`
- `useWorkflowDraft` (init `useEffect`, reconciliation `useEffect`, `prevOpened` ref)
- `WorkflowEngine.listStepVersions`
- `WorkflowEngine.listOwnStepVersions`
- `StorageSyncClient.pullStepVersions`

## Data flow

### Update popover (stale-pin warning)

`WorkflowEditor` computes `updateDef` via `wf.updateFor(step)` (version mismatch check) and
passes it to `StepCard`. When set, `StepCard` renders `UpdatePopover`, which diffs the pinned
`StepContent` against the head `StepDef` per field and calls `onUpdateToLatest` (bound to
`updateStepToLatest`) on confirm. The banner counts steps where `updateFor` returns a value and,
on "Update all", calls `updateAllToLatest`, which re-pins every ref step whose head version is
newer than its pinned version in one pass.

### Version history / restore

Opening either the `VersionHistoryPopover` or `RestoreHistoryPopover` fires a `stepVersions`
client message (`{ ownerId, stepId }`); no correlation id — the reply echoes the same keys so the
store slots it by `${ownerId}/${stepId}`. The bridge (`server/src/index.ts`) pulls remote history
via `sync.pullStepVersions` (storage route, own steps get every row, foreign steps get published
rows only, capped at 200, newest first), merges it into the in-memory `stepVersions` map via
`addStepVersions`, and replies with `listStepVersions` (best-effort local view — works even when
storage is offline, since the map is also restored from `step-versions.json` on boot).

On the web side, `useWorkflowDraft.versionsFor` (workflow editor) and `StepLibrary`'s local
`versionsFor` both union the fetched reply with whatever's already resolvable locally
(`versionMap` / the step's head), so the currently pinned/current version always appears even
mid-fetch or if storage can't serve it. `undefined` means "nothing known yet" and renders a
loading state; both popovers fetch on open, not on mount.

Selecting a row previews a diff (`FieldDiffList`) of the pinned/current content against that
version. Confirming:

- Workflow editor → `pinStepToVersion` mutates the draft's `ref.version` (and `ownerName`) —
  draft-only, takes effect on workflow Save.
- Step library → `restore` loads that version's `StepContent` into the draft — draft-only,
  `saveStep` on Save bumps a **new** head version with that content; the restored version's row
  itself is untouched.

### Persistence

`WorkflowEngine.persistSteps()` writes both the head list (`steps.json`, unchanged) and the full
owned history (`step-versions.json`, via `saveStepVersions`) on every save — losing this would
silently degrade "own step history" back to heads-only after a restart. The bridge also pushes
the full owned history (not just heads) to the storage server on the `'steps'` broadcast and on
reconnect, so the debounced push can't coalesce away an intermediate version before it reaches
Postgres.

### Draft selection

On modal open, an effect picks the previously-selected workflow (or first owned one) and calls
`loadFrom`. Saving a brand-new workflow (`draft.id === ''`) sends `saveWorkflow`; the server's
subsequent `workflows` broadcast is matched back to the draft by name + deep step equality in a
separate reconciliation effect, which stitches the server-assigned id onto the draft.

## Tests

None.

## Business rules

- Diff list scrolls independently (`ScrollArea.Autosize`, max height 280px) when it exceeds the
  popover's height; the action button ("Update to vN" / "Pin to vN" / restore) and popover title
  stay pinned outside the scroll area so it is always reachable regardless of diff length.
- "Update all" re-pins every outdated ref step directly, skipping the per-field diff review the
  individual popover provides.
- Newest-first, gap-tolerant version list: version numbers can skip (e.g. debounced pushes),
  rendered as-is.
- Own steps show full history; foreign (shared) steps show published versions only, with the
  exact pinned version always unioned in client-side even if unpublished.
- Pin/restore is disabled for the currently active version — re-selecting what's already active
  is a no-op the UI blocks rather than sends.
- Workflow re-pin changes only which immutable version a ref points to (metadata only, same
  immutable content, different pointer); step-library restore creates a brand-new head version
  with old content — it is not a rewrite of history, and history is never rewritten.
- Both popovers fetch their history on open (not on mount) and re-fetch every time they're
  reopened; the store slice is a plain overwrite per key, so races between repeated opens are
  harmless.
- A `workflows`/`sharedWorkflows` length change while the modal is already open with a live draft
  must not re-trigger the "pick a workflow" fallback — only the open transition (or no-draft
  state) does.
- `loadFrom` collapses every step of the loaded workflow by default; a step only opens later via
  explicit selection (`selectStep`), keeping the editor compact for workflows with many steps.

## Architectural rules

- Immutable step versions are never deleted or edited, on disk or in storage — only the head list
  and the `published` flag change identity.
- The storage route enforces the foreign-publish filter server-side (`storage/src/index.ts`); the
  client-side version union in `versionsFor` never bypasses it — it only guarantees visibility of
  a version the caller already has another right to see (their own pin).
- Nothing beyond existing Mantine popover/scroll-area usage for the popovers themselves (see
  `PermissionPrompt.tsx` for the same `ScrollArea.Autosize` + `mah` pattern).
- The init effect tracks `opened` via a `prevOpened` ref and skips its `workflows[0]` fallback
  whenever a draft already exists and this isn't the open transition — otherwise a post-save
  server broadcast races the id-reconciliation effect and clobbers the just-saved draft with an
  unrelated workflow (`workflows[0]`).
- New-workflow id reconciliation matches by name + deep step equality (`JSON.stringify` of
  wire-format steps), not just step count, to avoid mismatching workflows that share a name and
  step count.

## Related decisions

None.
