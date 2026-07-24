# Workflow step version history

## Purpose

Let a step's full immutable version history be browsed and diffed, and reused two ways:

- **Workflow editor** — re-pin a `StepRef` to any past version of the step it points to (not just the latest).
- **Step library** — restore an old version's content into the editable draft; saving republishes it as a new head version (history is append-only, never rewritten).

## Entry points

- `web/src/components/workflow/StepCard.tsx` (`VersionHistoryPopover`, opened from the version `Badge` or the step's kebab menu "Version history" item)
- `web/src/components/workflow/StepLibrary.tsx` (`RestoreHistoryPopover`, opened from the history icon next to the step's version badge)

## Files

- `shared/types.ts` — `stepVersions` client/server message pair
- `storage/src/index.ts` — `GET /steps/:ownerId/:id/versions`
- `server/src/sync.ts` — `StorageSyncClient.pullStepVersions`
- `server/src/store.ts` — `step-versions.json`, `loadStepVersions`/`saveStepVersions`
- `server/src/workflows.ts` — `WorkflowEngine.listStepVersions`, `listOwnStepVersions`, `addStepVersions`, `persistSteps`
- `server/src/index.ts` — `stepVersions` message handler
- `web/src/store.ts` — `stepVersions` slice (`Record<"ownerId/stepId", StepDef[]>`)
- `web/src/components/workflow/useWorkflowDraft.ts` — `requestStepVersions`, `versionsFor`, `pinStepToVersion`, `versionMap`
- `web/src/components/workflow/StepCard.tsx` — `VersionHistoryPopover`, `FieldDiffList`, `relTime`
- `web/src/components/workflow/StepLibrary.tsx` — `RestoreHistoryPopover`

## Symbols

- `FieldDiffList` (exported from `StepCard.tsx`, reused by `UpdatePopover`, `VersionHistoryPopover`, `RestoreHistoryPopover`)
- `relTime` (exported from `StepCard.tsx`)
- `VersionHistoryPopover`
- `RestoreHistoryPopover`
- `useWorkflowDraft.requestStepVersions`
- `useWorkflowDraft.versionsFor`
- `useWorkflowDraft.pinStepToVersion`
- `WorkflowEngine.listStepVersions`
- `WorkflowEngine.listOwnStepVersions`
- `StorageSyncClient.pullStepVersions`

## Data flow

Opening either popover fires a `stepVersions` client message (`{ ownerId, stepId }`); no correlation id — the reply echoes the same keys so the store slots it by `${ownerId}/${stepId}`. The bridge (`server/src/index.ts`) pulls remote history via `sync.pullStepVersions` (storage route, own steps get every row, foreign steps get published rows only, capped at 200, newest first), merges it into the in-memory `stepVersions` map via `addStepVersions`, and replies with `listStepVersions` (best-effort local view — works even when storage is offline, since the map is also restored from `step-versions.json` on boot).

On the web side, `useWorkflowDraft.versionsFor` (workflow editor) and `StepLibrary`'s local `versionsFor` both union the fetched reply with whatever's already resolvable locally (`versionMap` / the step's head), so the currently pinned/current version always appears even mid-fetch or if storage can't serve it. `undefined` means "nothing known yet" and renders a loading state; both popovers fetch on open, not on mount.

Selecting a row previews a diff (`FieldDiffList`) of the pinned/current content against that version. Confirming:
- Workflow editor → `pinStepToVersion` mutates the draft's `ref.version` (and `ownerName`) — draft-only, takes effect on workflow Save.
- Step library → `restore` loads that version's `StepContent` into the draft — draft-only, `saveStep` on Save bumps a **new** head version with that content; the restored version's row itself is untouched.

## Persistence

`WorkflowEngine.persistSteps()` writes both the head list (`steps.json`, unchanged) and the full owned history (`step-versions.json`, via `saveStepVersions`) on every save — losing this would silently degrade "own step history" back to heads-only after a restart. The bridge also pushes the full owned history (not just heads) to the storage server on the `'steps'` broadcast and on reconnect, so the debounced push can't coalesce away an intermediate version before it reaches Postgres.

## Tests

None.

## Business rules

- Newest-first, gap-tolerant: version numbers can skip (e.g. debounced pushes), rendered as-is.
- Own steps: full history visible. Foreign (shared) steps: published versions only, but the exact pinned version is always unioned in client-side even if unpublished.
- "Pin to vN" / restoring the current version is disabled — re-selecting what's already active is a no-op the UI blocks rather than sends.
- Re-pin (workflow editor) is a metadata change only (same immutable content, different pointer). Restore (step library) creates a new version with old content — it is not a rewrite of history.
- Both popovers fetch their history on open (not on mount) and re-fetch every time they're reopened; the store slice is a plain overwrite per key, so races between repeated opens are harmless.

## Architectural rules

- New immutable versions are never deleted or edited in storage or on disk; only the head list and the `published` flag change identity.
- The storage route enforces the publish filter server-side (`storage/src/index.ts`); the client-side union in `versionsFor` never bypasses it — it only guarantees visibility of a version the caller already has another right to see (their own pin).

## Related decisions

None.
