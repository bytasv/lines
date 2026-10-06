# Workflow step versioning

Covers: `workflow-step-version-history`, `workflow-step-version-ui`,
`workflow-step-update-popover`, `workflow-draft-selection`.

## Purpose

Shared diff-popover UI for warning a pinned step is stale and for browsing/restoring/re-pinning
any past step version, plus the rules governing which workflow the editor's draft reflects while
all that is happening.

When a workflow step is pinned (`ref`) to a published step definition and a newer version exists,
show a warning popover with a field-by-field diff (old vs new) and an action to update the step
to the latest version. A banner in the workflow overview pane (shown when no step is selected) also
lets the user update every outdated step at once, without reviewing each diff.

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

Synced workflows and step versions this machine has not verified carry an `UntrustedMark` (see
[end-to-end-encryption](end-to-end-encryption.md)): they are listed with a badge and kept, but
refused by every path that would run them until the owner reviews exactly what they run — the
review gate lives here, beside the version UI it shares a pane with.

## Entry points

- `web/src/components/workflow/StepCard.tsx` (`UpdatePopover`; `VersionHistoryPopover`, opened
  from the version `Badge` or the step's kebab menu "Version history" item)
- `web/src/components/workflow/StepLibrary.tsx` (`RestoreHistoryPopover`, opened from the history
  icon next to the step's version badge)
- `web/src/components/workflow/WorkflowEditor.tsx` (overview-pane "Update all" banner; the editor
  modal whose draft selection is governed here)
- `web/src/components/workflow/StepOutline.tsx` (the flow outline: step rows, per-step update dot,
  drag/Move up/Move down reorder, gate and start-mode links between steps)
- `web/src/components/workflow/StepLibrary.tsx` (the detail-header `Created`/`Updated` lines,
  read from the live store row rather than the draft)
- `web/src/components/workflow/UntrustedReview.tsx` (`UntrustedReviewModal`, opened from the
  **Review** banner in the workflow overview pane or the step library's detail pane; the
  `UntrustedBadge` on list rows and version rows)

## Files

- `web/src/components/workflow/StepCard.tsx` (the selected step's pane: banners, prompt, actions)
- `web/src/components/workflow/StepSettings.tsx` (model/effort/permission, output name, gate and
  start mode, own routing rule — shared by the workflow editor and the step library)
- `web/src/components/workflow/StepPane.tsx`, `web/src/components/workflow/StepOutline.tsx`
- `web/src/components/workflow/StepLibrary.tsx`
- `web/src/components/workflow/useWorkflowDraft.ts` (`contentOf`, `selectStep`, `detachStep`,
  `updateFor`, `updateStepToLatest`,
  `updateAllToLatest`, `requestStepVersions`, `versionsFor`, `pinStepToVersion`, `versionMap`;
  init effect, id-reconciliation effect, `loadFrom`, `doNew`, `save`, `duplicate`;
  `DraftWorkflow.heldMark`)
- `web/src/components/workflow/WorkflowEditor.tsx` (wires `updateDef` prop and the overview banner's
  bulk-update button; the overview's unverified banner and review modal)
- `web/src/components/workflow/WorkflowList.tsx`, `web/src/components/Sidebar.tsx` (filter
  "Shared by others" against the owned list; `WorkflowList`'s per-row badge via `markOf`)
- `web/src/components/workflow/UntrustedReview.tsx` (`UntrustedBadge`, `UntrustedReviewModal`,
  `workflowReviewItems`, `stepReviewItem`, `isHeld`, `needsReview`)
- `shared/types.ts` (`stepVersions` client/server message pair; `UntrustedMark`, `trustSyncedItem`)
- `storage/src/index.ts` (`GET /steps/:ownerId/:id/versions`, `POST /steps/resolve`)
- `storage/src/stepRows.ts` (`resolveWhere`, `resolveStepVersions` — the visibility rule
  `POST /steps/resolve` calls through to)
- `server/src/sync.ts` (`StorageSyncClient.pullStepVersions`, `resolveSteps`)
- `server/src/store.ts` (`step-versions.json`, `loadStepVersions`/`saveStepVersions`)
- `server/src/workflows.ts` (`WorkflowEngine.listStepVersions`, `listOwnStepVersions`,
  `addStepVersions`, `persistSteps`; `untrustedParts`, `assertRunnable`, `trustWorkflow`,
  `trustStep`, `resettleMarks`, `UntrustedWorkflowError`)
- `server/src/workflowCommands.ts` (`stepVersionsView`, `trustSyncedItem`)
- `server/src/index.ts` (`stepVersions` and `trustSyncedItem` message handlers)
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
- `WorkflowEngine.addStepVersions(list, requested)` — adopts only the step history asked for
- `StorageSyncClient.resolveSteps` / `resolveStepVersions` / `resolveWhere`
  (`storage/src/stepRows.ts`)
- `WorkflowEngine.untrustedParts` / `assertRunnable` / `trustWorkflow` / `trustStep`;
  `UntrustedWorkflowError`
- `UntrustedReviewModal`, `UntrustedBadge`, `workflowReviewItems`, `stepReviewItem`

## Data flow

### Update popover (stale-pin warning)

`WorkflowEditor` computes `updateDef` via `wf.updateFor(step)` (version mismatch check) and
passes it to `StepCard` for the selected step (the outline row shows only an update dot). When set,
`StepCard` renders `UpdatePopover`, which diffs the pinned
`StepContent` against the head `StepDef` per field and calls `onUpdateToLatest` (bound to
`updateStepToLatest`) on confirm. The banner counts steps where `updateFor` returns a value and,
on "Update all", calls `updateAllToLatest`, which re-pins every ref step whose head version is
newer than its pinned version in one pass.

### Version history / restore

Opening either the `VersionHistoryPopover` or `RestoreHistoryPopover` fires a `stepVersions`
client message (`{ ownerId, stepId }`); no correlation id — the reply echoes the same keys so the
store slots it by `${ownerId}/${stepId}`. The bridge (`server/src/index.ts` →
`stepVersionsView`) pulls remote history via `sync.pullStepVersions` (storage route, own steps get
every row, foreign steps get published rows only, capped at 200, newest first, each row's
`ownerId`/`id` set from the route rather than the blob; every row signature-checked like any
pulled item), merges only that step's rows into the in-memory `stepVersions` map via
`addStepVersions(list, [{ ownerId, id }])`, and replies with `listStepVersions` (best-effort local
view — works even when storage is offline, since the map is also restored from
`step-versions.json` on boot).

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
  itself is untouched. A version that needs review shows its badge in the list and cannot be
  restored: the new head would be saved — and signed — by this machine, so unverified content
  would come out the other side trusted without anyone allowing it.

### Pin resolution

Pinned versions the bridge has not cached (another user's, or older own ones) are fetched on every
shared-steps refresh: `refreshSharedSteps` sends `workflows.unresolvedRefs()` to
`POST /steps/resolve`, which calls `resolveStepVersions` (`storage/src/stepRows.ts`). A ref for the
caller's own step matches the row whatever its flag; anyone else's matches a **published** row
only — a ref they may not see is left out exactly as a missing one is, so the answer never confirms
that a private version exists. Refs are type-checked before they reach the Prisma `where` (an
object in place of a string, `{ not: '' }`, would match every owner), capped at 500 per batch,
and each answer's `ownerId` comes from the row's `user_id`, not the blob. On the bridge,
`resolveSteps` checks every row and keeps only the exact `ownerId/stepId/version` triples it asked
for before `addStepVersions` files them.

The consequence for someone else's unpublished version: a pin to one — never published, or
unpublished since (`deleteStep` flips every version's flag off, which is now a revocation for other
users' pins) — resolves only from what this bridge already holds in memory. Foreign pins are not
persisted (`step-versions.json` holds own history only), so after a restart, or on another
machine, it is an unresolved pin: `runStep` parks the step with "the shared step version it pins
is not available on this bridge", Approve can still skip past it, and the version-history union
cannot show it either. The owner's own pins are unaffected.

### Held-back workflows and steps

A workflow or step version arrives marked when this machine did not sign it, or — another user's
— has not reviewed it (see [end-to-end-encryption](end-to-end-encryption.md)). The engine keeps
and lists it; `untrustedParts(wf)` collects what a run would execute that is still held back (the
workflow's own mark, which covers its inline steps, plus each pinned version's) and every way into
a run refuses on it: `assertRunnable` before a session is created (`createSession`, a recipe run's
`workflowId`), `attach` before anything is seeded, and `runStep` — the authoritative gate, since a
pull can mark content mid-run — which parks the step `pre-run` like an unresolved pin, with Retry
re-rendering it once reviewed.

The web reads trust off the *saved* row the bridge sent, never the draft. `WorkflowList` badges a
workflow by its first mark (its own or a pinned step's), the overview pane shows a Review banner
counting the parts that need review, and the step library shows one for a held-back version.
Review opens `UntrustedReviewModal` with the full text that would run — inline prompts, each
exact pinned version (never the resolver's latest-version fallback), and their permission mode,
model and gate. "Allow on this machine" sends one `trustSyncedItem` per held-back item, each
echoing the digest that was on screen; the bridge (`trustWorkflow`/`trustStep`) records it and
clears only the copy whose mark carries that digest. Where another machine's signature is the only
thing holding something back, the modal also offers "Trust this machine…" behind a confirmation
that says to compare the fingerprint first.

Copies keep marks: Duplicate (reading the mark off the live row, since the draft may predate a
review) and "Make an editable copy" of a held-back pinned step (`detachStep`) set
`DraftWorkflow.heldMark`, which the
next save sends once as `untrusted`; `StepLibrary`'s Duplicate does the same with its own
`heldMark`. `toWire` never echoes a loaded row's `untrusted` back. On the bridge, `setSharedSteps`
keeps the reviewed content of a version an author rewrote in place (the library shows the new head
as unreviewed, but a pin to that number keeps running what was reviewed), an unverified copy never
displaces a trusted version with the same number, and an own-table row naming another owner is
refused (`applySyncedSteps`) or, for a workflow, held back as someone else's (`applySyncedAll`).

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

### Editor layout and step selection

The Workflows view is three columns: workflow list, flow outline, and a pane. The outline lists
every step with a one-line summary and the gate/start-mode link between neighbours; the pane shows
the one selected step (`selectedStep`, set by `selectStep`) or, when none is selected, the workflow
overview (name, sharing switch, "Update all"). Selection is by the step's draft uid, and removing
the selected step moves it to a neighbour. A pinned step is read-only in the pane and offers
update, "Edit in library" and "Make an editable copy" (`detachStep`, which replaces the ref in place
with an inline copy recording `copiedFrom`). Saving a workflow whose steps came from "Edit in
library" with unpublished library edits asks for confirmation rather than blocking.

The step library reuses the same pane and `StepSettings`, so both editors write the same
`StepContent` fields; `contentOf` is the single field list for loading, saving, publishing and
duplicating (guarded by `satisfies Record<keyof StepContent, unknown>`), which is what keeps
`reasoningEffort` and `routing` from being dropped on any of those paths.

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
- `server/src/workflows.trust.test.ts` — held-back workflows and steps: listed but refused before
  any session state is touched; a review must echo the digest it showed; a workflow attached
  before a pull marked it does not run its first step; a re-pull of the same content (keys
  reordered by jsonb, or renamed) stays trusted; approving one item approves that content only,
  and a step version only the copy carrying it; an edit is not a review and a client cannot clear
  a mark; a copy of an unverified workflow is unverified; another user's workflow or pinned step
  runs only once reviewed, and again only after its author changes it; an author rewriting a
  reviewed version in place cannot change what a pin runs; a version history adopts only the step
  it asked for; an unverified copy never displaces a trusted version.
- `server/src/sync.items.test.ts` — `resolveSteps` keeps only the versions it asked for.
- `storage/src/steps.resolve.test.ts` — `resolveWhere`'s query shape (always runs): another
  user's ref matches a published row only, the caller's own whatever its flag, malformed refs
  (including Prisma filter objects) never reach the query, a batch is capped; and against a
  scratch Postgres (**opt-in**, `STORAGE_TEST_DATABASE_URL`): another user's private version comes
  back exactly as a missing one does, unpublishing hides a version from everyone but its owner,
  and `ownerId` is the row's whatever the blob claims.

The web draft/editor side (`useWorkflowDraft.ts`, `WorkflowEditor.tsx`, `StepCard.tsx`,
`StepLibrary.tsx`, `UntrustedReview.tsx`) has no test runner — unchanged from before.

## Business rules

- Diff list scrolls independently (`ScrollArea.Autosize`, max height 280px) when it exceeds the
  popover's height; the action button ("Update to vN" / "Pin to vN" / restore) and popover title
  stay pinned outside the scroll area so it is always reachable regardless of diff length.
- "Update all" re-pins every outdated ref step directly, skipping the per-field diff review the
  individual popover provides.
- Newest-first, gap-tolerant version list: version numbers can skip (e.g. debounced pushes),
  rendered as-is.
- Own steps show full history; foreign (shared) steps show published versions only, with the
  exact pinned version unioned in client-side whenever the bridge holds it — which, for someone
  else's version that is not published, is only a copy cached while it was still visible.
- `POST /steps/resolve` answers only the caller's own versions and anyone's **published** ones; a
  ref to another user's private version comes back exactly as a missing one does. A pin is not a
  grant, and unpublishing is a revocation: a pin to another user's version that is not published
  stops resolving for everyone but its owner and is treated as any other unresolved pin.
- A version history or resolve answer is adopted only for what was asked: `addStepVersions` takes
  only the requested step's rows and `resolveSteps` only the requested `ownerId/stepId/version`
  triples, because a version is filed under the owner it names — a row claiming the caller would
  join their own history and be pushed back to storage as theirs.
- Pin/restore is disabled for the currently active version — re-selecting what's already active
  is a no-op the UI blocks rather than sends. Restore is also disabled for a version that needs
  review, since the restored head is saved and signed by this machine.
- A held-back workflow or step version is kept and listed with a badge but refused by every path
  that would run it until reviewed; approving sends the digest that was shown, and a stale one is
  refused. Edits and copies (Duplicate, "Make an editable copy") never clear a mark. The review
  dialog freezes what it shows when it opens: content that changes while it is open is refused by
  the bridge rather than re-rendered and confirmed unseen.
- Workflow re-pin changes only which immutable version a ref points to (metadata only, same
  immutable content, different pointer); step-library restore creates a brand-new head version
  with old content — it is not a rewrite of history, and history is never rewritten.
- Both popovers fetch their history on open (not on mount) and re-fetch every time they're
  reopened; the store slice is a plain overwrite per key, so races between repeated opens are
  harmless.
- A `workflows`/`sharedWorkflows` length change while the modal is already open with a live draft
  must not re-trigger the "pick a workflow" fallback — only the open transition (or no-draft
  state) does.
- `loadFrom` selects no step of the loaded workflow (the pane shows the overview); a step opens
  only via explicit selection (`selectStep`). There is one selected step at a time, not per-step
  expand/collapse.
- Every version of one step reports the same `createdAt` (the lineage's, not the version's); a
  content change or a publish-toggle-only save both keep it, and it only ever moves earlier
  (`earliest`/`LEAST`), never later — a peer or older client that omits the field can't erase it.

## Architectural rules

- Immutable step versions are never deleted or edited, on disk or in storage — only the head list
  and the `published` flag change identity.
- Storage enforces the foreign-publish filter server-side, on `GET /steps/:ownerId/:id/versions`
  and on `POST /steps/resolve` (`storage/src/stepRows.ts`), which used to answer any
  `{ ownerId, id, version }` to any signed-in user — a private version was one counted-up number
  away from anyone who had seen its step's id. The client-side version union in `versionsFor`
  never bypasses it: it only adds a version the bridge already holds.
- The resolve visibility rule lives in `storage/src/stepRows.ts` rather than inline in the route
  so it is testable without a Clerk token; the route is a thin wrapper.
- Cross-user step rows are keyed by the row, never the blob: storage sets `ownerId` (and on the
  history route `id`) from the row, and the bridge additionally drops anything it did not ask for
  — two independent halves of the same guard.
- Trust is read off the saved workflow the bridge sent, never the draft: the draft is what the
  user is typing, and what runs is the stored row and the exact versions it pins. A held-back
  pin's mark survives "Make an editable copy" through `heldMark`, sent once and then dropped so a
  later save after a review does not re-mark what the review cleared.
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

- [end-to-end-encryption](end-to-end-encryption.md) — the per-item signing and trust model a
  held-back workflow or step comes from.
- [workflow-mcp-tools](workflow-mcp-tools.md) — shares the own-vs-shared classification above.
