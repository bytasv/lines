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

Ownership classification decides, both here and in
[workflow-mcp-tools](workflow-mcp-tools.md), whether a workflow/step is treated as the user's own
or as someone else's read-only publish. Own always beats shared: an id or step present in both
the own and shared maps — a stale `/workflows/shared` (or `/steps/shared`) snapshot of the user's
own row, or the same id republished under a second Clerk identity of theirs — is owned, editable,
and never rendered under "Shared by others". A `StepRef.ownerId` that drifted from the id the
bridge itself stamps (mismatched Clerk-vs-bridge identity, or Clerk disabled in the web build) is
healed rather than left permanently unresolvable: `updateFor`/re-pin fall back to an own-head
lookup by `stepId` alone, and every `WorkflowEngine.save()` (plus a one-time pass at boot)
rewrites such a ref's `ownerId` back to the owner once the exact pinned version is confirmed in
that user's own step history.

## Entry points

- `web/src/components/workflow/StepCard.tsx` (`UpdatePopover`; `VersionHistoryPopover`, opened
  from the version `Badge` or the step's kebab menu "Version history" item)
- `web/src/components/workflow/StepLibrary.tsx` (`RestoreHistoryPopover`, opened from the history
  icon next to the step's version badge)
- `web/src/components/workflow/WorkflowEditor.tsx` (outdated-steps banner "Update all" button;
  the editor modal whose draft selection is governed here)
- `web/src/components/workflow/StepLibrary.tsx` (the detail-header `Created`/`Updated` lines,
  read from the live store row rather than the draft)

## Files

- `web/src/components/workflow/StepCard.tsx`
- `web/src/components/workflow/StepLibrary.tsx`
- `web/src/components/workflow/useWorkflowDraft.ts` (`updateFor`, `updateStepToLatest`,
  `updateAllToLatest`, `requestStepVersions`, `versionsFor`, `pinStepToVersion`, `versionMap`;
  init effect, id-reconciliation effect, `loadFrom`, `doNew`, `save`)
- `web/src/components/workflow/WorkflowEditor.tsx` (wires `updateDef` prop and the banner's
  bulk-update button)
- `web/src/components/workflow/WorkflowList.tsx`, `web/src/components/Sidebar.tsx` (filter
  "Shared by others" against the owned list)
- `shared/types.ts` (`stepVersions` client/server message pair)
- `storage/src/index.ts` (`GET /steps/:ownerId/:id/versions`)
- `server/src/sync.ts` (`StorageSyncClient.pullStepVersions`)
- `server/src/store.ts` (`step-versions.json`, `loadStepVersions`/`saveStepVersions`)
- `server/src/workflows.ts` (`WorkflowEngine.listStepVersions`, `listOwnStepVersions`,
  `addStepVersions`, `persistSteps`)
- `server/src/index.ts` (`stepVersions` message handler)
- `web/src/store.ts` (`stepVersions` slice, `Record<"ownerId/stepId", StepDef[]>`)
- `server/src/workflows.ts` (`ForeignWorkflowError`, `isOwnRow`, `isForeign`, `normalizeRefs` —
  the own-beats-shared classification and ref-healing this feature's "own vs. shared" UI reflects;
  also `earliest`, `lineageCreatedAt` — the creation-time merge and lookup)
- `storage/prisma/schema.prisma` (`StepVersion.createdAt` — this row's own insert time, distinct
  from the lineage value the blob carries)

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

### Creation time

`StepDef.createdAt` is when the step *id* was first created, carried forward unchanged across
every version bump — not the mint time of any one version, which is that immutable row's own
`updatedAt`. `WorkflowEngine.saveStep` stamps it once (first save, or `lineageCreatedAt` recovered
from cached versions if the head was deleted and re-created) and every later version of that id
keeps it.

In Postgres this is a lineage value, not a column: `step_versions.created_at` stays each row's own
insert time (needed to reconstruct the lineage minimum), while the wire blob's `createdAt` is
`min(created_at)` over `(user_id, id)`, injected on `GET /steps` via a joined subquery (not a
window function — under `?since=` a window would only see rows inside the delta and report too
recent a birth). `PUT /steps` therefore feeds its `created_at` column from `updatedAtOf`, not the
blob's `createdAt`: the bridge re-pushes the whole version history on every step change, and
writing the lineage value into every row would erase the very evidence the minimum is computed
from.

`StepLibrary`'s detail header reads `createdAt`/`updatedAt` off the live store row (`steps` /
`sharedSteps`), not the draft — `save()` reloads the draft it just sent, so a draft read would show
the pre-save version and time until the broadcast happened to replace it. Same wart as the
`v{draft.version ?? 1}` badge next to it, left alone for the same reason.

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

A save otherwise stays dirty (baseline unchanged) until that same matching finds the draft's own
id in a `workflows` broadcast — the bridge can refuse a write (a genuinely foreign id throws
`ForeignWorkflowError`), and an optimistically-advanced baseline used to render a dropped save as
"Saved" with no error visible. The content key used to match excludes a ref's `ownerId`/
`ownerName` on purpose: `WorkflowEngine.save()` can heal a drifted ref as part of the same write,
so the echoed workflow is never byte-identical to what was sent.

### Ownership classification

`readOnly` is true only when the draft's id is absent from the user's own `workflows` list *and*
present in `sharedWorkflows` — own beats shared, matching `WorkflowEngine.resolve()`/`isForeign`.
`updateFor`/`updateStepToLatest`/`updateAllToLatest`/`pinStepToVersion` resolve a ref's head via
`${ownerId}/${stepId}` first, falling back to an own-head lookup by `stepId` alone so a drifted
`ownerId` still surfaces its update; all four write the resolved head's `ownerId` back onto the
ref, which is what lets a save heal the drift permanently. `WorkflowList`/`StepLibrary`/`Sidebar`
each filter their "Shared by others" section against the owned list for the same reason — an id
in both must render once, under Owned.

## Tests

- `server/src/workflows.ownership.test.ts` — the own-beats-shared classification and ref-healing
  this feature's ownership rules build on (`WorkflowEngine` side only).

The web draft/editor side (`useWorkflowDraft.ts`, `WorkflowEditor.tsx`, `StepCard.tsx`,
`StepLibrary.tsx`) has no test runner — unchanged from before.

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
- Every version of one step reports the same `createdAt` (the lineage's, not the version's); a
  content change or a publish-toggle-only save both keep it, and it only ever moves earlier
  (`earliest`/`LEAST`), never later — a peer or older client that omits the field can't erase it.

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
