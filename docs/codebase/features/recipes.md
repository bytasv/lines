# Recipes

## Purpose

Publishable, versioned prompt documents — a shareable "prompt library" distinct
from workflow steps. A recipe has a title, description, tags, optional
screenshots, an author, a publish flag, a version, and a public run count.
Anyone browses everyone's published recipes (filtered by tag) and runs one,
which always spawns a brand-new session seeded with that recipe's prompt —
standalone, inside a chosen existing workflow, or (for more than one recipe, or
a saved bundle) as a freshly synthesized workflow. Recipes also compose into
**bundles**: a saved, publishable recipe whose content is an ordered list of
other recipes instead of a prompt (e.g. "Simple e-shop app" = infra + auth +
database + payments), runnable and browsable exactly like a leaf recipe.

## Entry points

- `web/src/components/recipe/RecipeLibrary.tsx` — the "Recipes" tab inside the
  workflow/step/recipe editor modal (`web/src/components/Sidebar.tsx`'s
  `IconBook` action).
- `web/src/components/recipe/RecipeRunModal.tsx` — run a selection (one recipe,
  several ad-hoc, or a saved bundle); reachable from a row's Run action or the
  library's multi-select basket.

## Important files

- `shared/types.ts` — `RecipeRef`, `RecipeContent`, `RecipeDef`, `isBundle`,
  `normalizeRecipeTag`, the `RECIPE_*` constants; the `saveRecipe` /
  `deleteRecipe` / `recipeVersions` / `uploadRecipeImage` / `runRecipe` client
  messages and the `recipes` / `sharedRecipes` / `recipeVersions` /
  `recipeStats` / `recipeImageUploaded` / `recipeRun` server messages; `hello`
  carries `recipes`, `sharedRecipes`, `recipeStats`.
- `server/src/recipes.ts` — `RecipeEngine`: in-memory heads/shared-corpus/version
  cache plus run-count cache, mirroring `WorkflowEngine`'s step-library machinery
  but as its own class (a recipe has no step/handoff/pin semantics).
- `server/src/recipeCommands.ts` — `runRecipe`, `recipeVersionsView`; the
  ordered, side-effecting run path, split out from `server/src/index.ts` the
  same way `server/src/workflowCommands.ts` is, so it is independently testable.
- `server/src/store.ts` — `recipes.json` (own heads), `recipe-versions.json`
  (own full history), `recipe-stats.json` (local run-count cache); `recipes`
  added to `SyncWatermarks`.
- `server/src/sync.ts` — `pullSharedRecipes`, `pullRecipeVersions`,
  `pushRecipes`, `deleteRecipe`, `incrementRecipeRuns`, `uploadRecipeImage`; the
  `req()` `softErrors` option (see Business rules).
- `server/src/userContext.ts` — constructs `RecipeEngine`; push-on-broadcast for
  `'recipes'`; `refreshSharedRecipes`; the `syncNow` pull/push legs.
- `server/src/userRegistry.ts` — third `fanoutSharedRefresh` branch for
  `'recipes'` broadcasts (debounced cross-user re-pull, same as workflows/steps).
- `server/src/index.ts` — `hello`'s three recipe fields; `saveRecipe` /
  `deleteRecipe` / `recipeVersions` / `uploadRecipeImage` / `runRecipe` cases.
- `storage/prisma/schema.prisma`, `storage/prisma/migrations/20260727000000_recipes/` —
  `RecipeVersion`, `RecipeStats` tables.
- `storage/src/index.ts` — `GET/PUT /recipes`, `GET /recipes/shared`,
  `GET /recipes/stats`, `POST /recipes/run`, `POST /recipes/images`,
  `GET /recipes/:ownerId/:id/versions`, `DELETE /recipes/:id`.
- `storage/src/r2.ts` — `r2Configured`, `r2PublicBaseWarning`, `putRecipeImage`;
  lazily-loaded `@aws-sdk/client-s3` client.
- `web/src/store.ts` — `recipes`, `sharedRecipes`, `recipeVersions`,
  `recipeStats`, `recipeUploads` state; `trackRecipeUpload`; the six recipe
  server-message cases.
- `web/src/components/recipe/RecipeLibrary.tsx`, `RecipeRunModal.tsx`,
  `RecipeImages.tsx`; `web/src/lib/recipeImage.ts` (client-side downscale before
  upload).
- `web/src/components/workflow/WorkflowEditor.tsx` — third `'recipes'`
  `SegmentedControl` view.

## Important symbols

- `RecipeEngine.saveRecipe(content, recipeId, published, ownerName)` — the sole
  write path; enforces every bundle/tag invariant (see Business rules) before
  bumping a version.
- `RecipeEngine.expandForRun(refs)` — resolves a requested selection to runnable
  leaf recipes, splicing any saved bundle's members in place; throws naming the
  first unresolvable ref.
- `RecipeEngine.resolveForRun(ownerId, recipeId, version?)` — own head, a
  foreign *published* head, or an explicit cached version; a foreign recipe that
  isn't published never resolves.
- `RecipeEngine.runAllowed(key)` — 5s per-recipe-set cooldown swallowing
  double-clicks.
- `recipeCommands.runRecipe(ctx, msg)` — validates, expands, synthesizes a
  workflow when the run is multi-leaf, creates the session, injects the first
  prompt, then (only after injection succeeds) bumps run counts and calls
  storage. Returns the new session id, or `null` if the cooldown swallowed it.
- `sameRecipeContent(a, b)` — version-bump gate; compares tags as a normalized
  sorted set (order-insensitive) and members as an ordered sequence
  (order-sensitive — member order is execution order).
- `normalizeRecipeTag(raw)` — shared client/server tag canonicalization
  (lowercase, trim, punctuation stripped, length-capped).

## Data flow

Mirrors the existing `StepVersion` publish-and-share stack end to end:
immutable `(ownerId, id, version)` rows, a promoted `published` column, a
`DISTINCT ON` head query, a bridge-side `RecipeEngine` plus a local JSON mirror
(`recipes.json` / `recipe-versions.json`), debounced push, throttled + ETag'd
shared pull.

Run counts are the one deliberate deviation: they live in a separate
`RecipeStats` table keyed by recipe *identity* (not version), so `PUT /recipes`
— an author's last-write-wins content push — can never clobber them, and a
content-only ETag on `/recipes/shared` can never freeze them. `GET
/recipes/stats` carries its own ETag over `sum(run_count)`, so re-running an
already-counted recipe still busts it.

A run (`runRecipe` message → `recipeCommands.runRecipe`) always creates a new
session:
1. Validate the request shape, then `RecipeEngine.expandForRun` resolves every
   ref and splices in any saved bundle's members — all-or-nothing; one
   unresolvable recipe aborts before any session or workflow exists.
2. A single leaf runs as a plain prompt (optionally inside a chosen existing
   `workflowId`). More than one leaf — ad-hoc or via a bundle — synthesizes and
   **saves** a real `WorkflowDef` (one inline step per recipe, `freshStart:
   false` so later steps see what earlier ones built), then attaches it to the
   new session exactly like a hand-authored workflow.
3. Only after prompt injection returns without throwing does it bump run counts
   (local optimistic increment, one broadcast, then one batched
   `POST /recipes/run` whose authoritative numbers replace the optimistic ones).

Recipe screenshots go browser → (WebSocket, base64) → bridge → (HTTP) → storage
→ R2 `PutObject`, reusing `Composer.tsx`'s attachment base64 idiom and
`StorageSyncClient`'s bearer transport — not a presigned direct-to-R2 upload
(the web client has no `STORAGE_URL`/R2 credentials, and storage has no CORS
middleware).

## Tests

- `server/src/recipes.version.test.ts` — version-bump gate: content changes,
  publish-toggle-only, image-reorder-bumps, tag-reorder/casing-does-not-bump.
- `server/src/recipes.tags.test.ts` — `normalizeRecipeTag` and save-time
  normalization/dedup/cap enforcement.
- `server/src/recipes.sync.test.ts` — LWW adoption, shared-corpus diffing,
  store round-trip.
- `server/src/recipes.run.test.ts` — `resolveForRun` matrix; single-recipe run
  ordering (prompt before count); rejected-cwd and unknown-recipe short
  circuits; cooldown.
- `server/src/recipes.bundle.test.ts` — synthesized-workflow shape and
  persistence; all-or-nothing failure with no partial session/workflow; batched
  and deduped run-count increments.
- `server/src/recipes.composite.test.ts` — bundle invariants (one of
  prompt/members, no nesting, member count bounds, publish requires published
  members) and `expandForRun` splicing.

## Business rules

- Exactly one of `prompt` / `members` is populated on a `RecipeContent`; a
  bundle's members must all be leaves (no nesting — this alone removes cycle
  detection, depth limits, and unbounded expansion); `2 ≤ members.length ≤
  RECIPE_BUNDLE_MAX` (8); publishing a bundle requires every member already
  published.
- Bundle members are **unversioned** (unlike a `StepRef`'s pinned version) — a
  recipe is prose advice, so the newest version of a member is the one wanted.
  Reproducibility instead lives at the run level: the synthesized workflow's
  inline steps freeze the exact prompt text that ran.
- A run's counter increments once per recipe at trigger time (not on step
  completion), only after the first prompt is successfully injected. A bundle
  and each of its expanded members count separately.
- Tags are freeform, normalized and re-normalized server-side on every save
  (client-side normalization is a preview only), deduped after normalizing,
  capped at 6, and may be empty. Tag filtering in the browser is client-side
  over the wholesale shared pull (same pattern as `sharedSteps`); the filter
  chip vocabulary is derived from the pulled corpus, not a fixed list.
- A run always spawns a **new** session — there is no inject-into-current-session
  path.
- A multi-recipe run cannot also specify an existing `workflowId` (a bundle
  already *is* a workflow); rejected server-side rather than silently resolved.
- Recipe images: R2 is optional. Unconfigured R2 answers `503` on upload and the
  recipe still saves without a screenshot; a misconfigured public base (pointed
  at the S3 API endpoint instead of a public `r2.dev`/custom domain) uploads
  successfully but the stored URL never renders in a browser — the storage
  server warns about this specific misconfiguration at boot
  (`r2PublicBaseWarning`).
- `StorageSyncClient.req`'s `softErrors` option (used by
  `incrementRecipeRuns`/`uploadRecipeImage`) treats a non-2xx response as that
  call's own failure rather than a storage-link outage, so an R2-unconfigured
  `503` or a "nothing runnable" `404` never raises the global
  "cloud sync unavailable" banner.

## Architectural rules

- `RecipeEngine` is a standalone class, not folded into `WorkflowEngine` —
  recipes have no step/handoff/pin semantics.
- All bundle/tag invariants are enforced only inside `RecipeEngine.saveRecipe`;
  storage treats `data` as an opaque JSON blob, so there is no second
  enforcement point to keep in sync.
- A multi-recipe run's synthesized workflow is **saved**, never ephemeral —
  every `WorkflowEngine` lifecycle method re-resolves the def by id on each
  transition and silently no-ops if it's missing, so an unpersisted def would
  make the session appear to swallow its first prompt with no error after a
  bridge restart.
- `RecipeEngine.expandForRun` is the only place bundle expansion happens; the
  client always sends refs, never a pre-flattened list, so a stale client can't
  run a bundle's old membership.

## Related decisions

- [workflow-step-versioning](workflow-step-versioning.md) — the
  `StepVersion` pattern this feature's storage/sync layer mirrors.
- [multi-root-projects](multi-root-projects.md) — `recipeCommands.ts` uses
  `findProject` for the cwd-membership check before creating a session.
