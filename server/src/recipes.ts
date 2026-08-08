import { randomUUID } from 'node:crypto';
import type { RecipeContent, RecipeDef, RecipeRef, ServerMessage } from '@lines/shared';
import { isBundle, normalizeRecipeTag, RECIPE_BUNDLE_MAX, RECIPE_TAG_MAX } from '@lines/shared';
import type { Store } from './store.ts';

const recipeKey = (ownerId: string, id: string) => `${ownerId}/${id}`;
const versionKey = (ownerId: string, id: string, version: number) => `${ownerId}/${id}/${version}`;

/** Swallows double-clicks on Run without needing UI state; per recipe identity. */
const RUN_COOLDOWN_MS = 5_000;

/**
 * True when two recipe contents are identical, so a save that only re-flags
 * `published` keeps its version.
 *
 * Two deliberate asymmetries: **image order is content** (an immutable version
 * must keep rendering its own image set in its own order), while **tag order is
 * not** (tags are a set, hence the sort). Members ARE compared in order, because
 * member order is execution order.
 *
 * Tags must be compared in their normalized form — comparing raw tags while
 * `saveRecipe` stores normalized ones would bump a version on every save where
 * the author typed mixed case, filling an append-only table with identical rows.
 */
export function sameRecipeContent(a: RecipeContent, b: RecipeContent): boolean {
  const tags = (r: RecipeContent) => [...normalizeTags(r.tags)].sort().join('\0');
  const members = (r: RecipeContent) => (r.members ?? []).map((m) => recipeKey(m.ownerId, m.recipeId)).join('\0');
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.prompt === b.prompt &&
    a.images.join('\0') === b.images.join('\0') &&
    tags(a) === tags(b) &&
    members(a) === members(b)
  );
}

/**
 * Normalize, drop empties, dedupe *after* normalizing (so `Auth` and `auth`
 * collapse to one), clamp. An empty result is legal — a recipe with no tags just
 * surfaces with no filter active or via text search.
 */
function normalizeTags(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const tag of raw ?? []) {
    const clean = normalizeRecipeTag(typeof tag === 'string' ? tag : '');
    if (!clean || out.includes(clean)) continue;
    out.push(clean);
    if (out.length === RECIPE_TAG_MAX) break;
  }
  return out;
}

/** Dedupe members preserving first position — position is execution order. */
function dedupeMembers(members: RecipeRef[]): RecipeRef[] {
  const seen = new Set<string>();
  const out: RecipeRef[] = [];
  for (const m of members) {
    const key = recipeKey(m.ownerId, m.recipeId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ownerId: m.ownerId, recipeId: m.recipeId });
  }
  return out;
}

/**
 * Publishable, versioned prompt documents — this user's own recipes plus the
 * corpus everyone else published. A separate class from `WorkflowEngine` on
 * purpose: recipes have no step, hand-off or pin semantics, and nothing here
 * touches a running session.
 *
 * Version rows are immutable and the local JSON files mirror the storage tables,
 * exactly as the step library does, so an offline bridge still lists, edits and
 * runs recipes.
 */
export class RecipeEngine {
  /** Own heads, keyed by recipe id. */
  private recipes = new Map<string, RecipeDef>();
  /** Other users' published heads, keyed `${ownerId}/${id}`. */
  private sharedRecipes = new Map<string, RecipeDef>();
  /** Every resolved immutable version (own history + foreign heads), keyed by versionKey. */
  private recipeVersions = new Map<string, RecipeDef>();
  /** Public run counts, keyed `${ownerId}/${id}`. */
  private stats: Record<string, number>;
  /** Last run per recipe identity, for the cooldown. */
  private lastRunAt = new Map<string, number>();

  constructor(
    private store: Store,
    private broadcast: (msg: ServerMessage) => void,
    /** Owner's Clerk userId, stamped onto recipes this user saves. */
    private userId: string,
  ) {
    for (const r of this.store.loadRecipes()) {
      this.recipes.set(r.id, r);
      this.recipeVersions.set(versionKey(r.ownerId, r.id, r.version), r);
    }
    // Heads are already in above; the history file adds the older versions back.
    for (const r of this.store.loadRecipeVersions()) {
      this.recipeVersions.set(versionKey(r.ownerId, r.id, r.version), r);
    }
    this.stats = this.store.loadRecipeStats();
  }

  listRecipes(): RecipeDef[] {
    return [...this.recipes.values()];
  }

  listSharedRecipes(): RecipeDef[] {
    return [...this.sharedRecipes.values()];
  }

  /** Every immutable version this user owns — the durable history, not just heads. */
  listOwnRecipeVersions(): RecipeDef[] {
    return [...this.recipeVersions.values()].filter((r) => r.ownerId === this.userId);
  }

  /** Cached versions of one recipe, newest first (best-effort local view). */
  listRecipeVersions(ownerId: string, recipeId: string): RecipeDef[] {
    return [...this.recipeVersions.values()]
      .filter((r) => r.ownerId === ownerId && r.id === recipeId)
      .sort((a, b) => b.version - a.version);
  }

  /** Adopt resolved immutable versions (own history from a pull, or a foreign history view). */
  addRecipeVersions(list: RecipeDef[]): void {
    for (const r of list) {
      if (!r?.id || !r.ownerId || typeof r.version !== 'number') continue;
      this.recipeVersions.set(versionKey(r.ownerId, r.id, r.version), r);
    }
  }

  /**
   * Save or update a recipe. A content change bumps the (immutable) version;
   * toggling `published` alone keeps it and just re-flags the head.
   *
   * Every invariant a recipe has is enforced here, because this is the only write
   * path that can be: storage treats `data` as opaque and a client can send
   * anything. Do not add a second write path that skips it.
   */
  saveRecipe(
    content: RecipeContent,
    recipeId: string | undefined,
    published: boolean,
    ownerName: string | undefined,
  ): RecipeDef {
    const bundle = isBundle(content);
    const prompt = (content.prompt ?? '').trim();
    // Both populated (or neither) would be a record whose run behaviour depends
    // on read order — rejected rather than resolved by precedence.
    if (bundle && prompt) throw new Error('A recipe is either a prompt or a bundle of recipes, not both');
    if (!bundle && !prompt) throw new Error('A recipe needs either a prompt or at least two member recipes');

    let members: RecipeRef[] | undefined;
    if (bundle) {
      members = dedupeMembers(content.members ?? []);
      if (members.length < 2) throw new Error('A bundle needs at least two different recipes');
      if (members.length > RECIPE_BUNDLE_MAX) {
        throw new Error(`A bundle holds at most ${RECIPE_BUNDLE_MAX} recipes`);
      }
      const unresolved: string[] = [];
      const nested: string[] = [];
      const unpublished: string[] = [];
      for (const m of members) {
        const target = this.resolveForRun(m.ownerId, m.recipeId);
        if (!target) {
          unresolved.push(recipeKey(m.ownerId, m.recipeId));
          continue;
        }
        // No nesting: rejecting a bundle of bundles outright is what removes
        // cycle detection, depth limits and unbounded expansion in one stroke.
        if (isBundle(target)) nested.push(target.title);
        // Checked on the save that publishes: otherwise a stranger browsing the
        // bundle gets members that aren't in their shared pull and cannot resolve.
        if (published && !target.published) unpublished.push(target.title);
      }
      if (unresolved.length) throw new Error(`Unknown recipe in this bundle: ${unresolved.join(', ')}`);
      if (nested.length) throw new Error(`A bundle cannot contain another bundle: ${nested.join(', ')}`);
      if (unpublished.length) {
        throw new Error(`Publish these member recipes first: ${unpublished.join(', ')}`);
      }
    }

    const normalized: RecipeContent = {
      title: content.title,
      description: content.description,
      // Re-normalized server-side even though the editor already previews the
      // same strings: one client bypassing the TagsInput would otherwise
      // reintroduce casing variants for everyone.
      tags: normalizeTags(content.tags),
      images: [...(content.images ?? [])],
      prompt: bundle ? '' : prompt,
      ...(members ? { members } : {}),
    };

    const id = recipeId || randomUUID();
    const head = this.recipes.get(id);
    const contentChanged = !head || !sameRecipeContent(head, normalized);
    const version = head ? (contentChanged ? head.version + 1 : head.version) : 1;
    const recipe: RecipeDef = {
      ...normalized,
      id,
      ownerId: this.userId, // authoritative — never trust a client-sent owner
      ownerName,
      version,
      published,
      updatedAt: Date.now(),
    };
    this.recipes.set(id, recipe);
    this.recipeVersions.set(versionKey(recipe.ownerId, id, version), recipe);
    this.persistRecipes();
    this.broadcast({ type: 'recipes', recipes: this.listRecipes() });
    return recipe;
  }

  /** Drop a recipe from this user's library; cached versions stay resolvable. */
  deleteRecipe(recipeId: string): void {
    if (!this.recipes.delete(recipeId)) return;
    this.persistRecipes();
    this.broadcast({ type: 'recipes', recipes: this.listRecipes() });
  }

  private persistRecipes() {
    this.store.saveRecipes(this.listRecipes());
    // Heads alone would lose intermediate versions across a restart.
    this.store.saveRecipeVersions(this.listOwnRecipeVersions());
  }

  /**
   * Adopt own recipes pulled from storage — LWW on version, one persist, and no
   * broadcast: this is state that just came *from* storage, so re-broadcasting it
   * would push it straight back up (and fan a shared re-pull out to every other
   * live context).
   */
  applySyncedRecipes(list: RecipeDef[]): void {
    let changed = false;
    for (const r of list) {
      if (!r?.id) continue;
      const cur = this.recipes.get(r.id);
      if (!cur || r.version >= cur.version) {
        this.recipes.set(r.id, r);
        this.recipeVersions.set(versionKey(r.ownerId, r.id, r.version), r);
        changed = true;
      }
    }
    if (changed) this.persistRecipes();
  }

  /** Replace the shared corpus from a storage pull; returns true if it changed. */
  setSharedRecipes(list: RecipeDef[]): boolean {
    const next = new Map(
      list.filter((r) => r?.id && r.ownerId).map((r) => [recipeKey(r.ownerId, r.id), r] as const),
    );
    const changed =
      next.size !== this.sharedRecipes.size ||
      [...next].some(([k, r]) => (this.sharedRecipes.get(k)?.version ?? -1) !== r.version);
    this.sharedRecipes = next;
    // Foreign heads are resolvable versions too.
    for (const r of next.values()) this.recipeVersions.set(versionKey(r.ownerId, r.id, r.version), r);
    return changed;
  }

  /**
   * The recipe a run should use: an explicitly requested version, else the head
   * (own, or a foreign published one). A foreign recipe that isn't published is
   * not resolvable — it never reached this bridge's corpus legitimately.
   */
  resolveForRun(ownerId: string, recipeId: string, version?: number): RecipeDef | undefined {
    const found =
      version !== undefined
        ? this.recipeVersions.get(versionKey(ownerId, recipeId, version))
        : ownerId === this.userId
          ? this.recipes.get(recipeId)
          : this.sharedRecipes.get(recipeKey(ownerId, recipeId));
    if (!found) return undefined;
    if (found.ownerId !== this.userId && !found.published) return undefined;
    return found;
  }

  /**
   * Resolve a requested selection to the leaf recipes that will actually run,
   * splicing any saved bundle's members in place (one level only, guaranteed by
   * the no-nesting invariant). This is the ONLY place expansion happens: the
   * client sends refs, never a flattened list, so a stale client cannot run a
   * bundle's old membership.
   *
   * All-or-nothing — a member deleted or unpublished since the bundle was
   * authored throws, naming it, before any workflow or session exists. Half a
   * configured app is worse than a clear failure.
   *
   * `bundles` are the bundles that were expanded, so the caller can name the
   * synthesized workflow after one and count all of them as triggered.
   */
  expandForRun(
    refs: { ownerId: string; recipeId: string; version?: number }[],
  ): { leaves: RecipeDef[]; bundles: RecipeDef[] } {
    const leaves: RecipeDef[] = [];
    const bundles: RecipeDef[] = [];
    for (const ref of refs) {
      const found = this.resolveForRun(ref.ownerId, ref.recipeId, ref.version);
      if (!found) throw new Error(`Recipe not available: ${recipeKey(ref.ownerId, ref.recipeId)}`);
      if (!isBundle(found)) {
        leaves.push(found);
        continue;
      }
      bundles.push(found);
      for (const m of found.members ?? []) {
        // No version on a member: bundles compose identities, so this picks up
        // the member's current content (see the unversioned-members decision).
        const target = this.resolveForRun(m.ownerId, m.recipeId);
        if (!target || isBundle(target)) {
          throw new Error(`"${found.title}" needs a recipe that is no longer available: ${recipeKey(m.ownerId, m.recipeId)}`);
        }
        leaves.push(target);
      }
    }
    return { leaves, bundles };
  }

  /** Own bundles referencing a recipe — used to warn before unpublishing a dependency. */
  listBundlesContaining(ownerId: string, recipeId: string): RecipeDef[] {
    return this.listRecipes().filter((r) =>
      (r.members ?? []).some((m) => m.ownerId === ownerId && m.recipeId === recipeId),
    );
  }

  allStats(): Record<string, number> {
    return { ...this.stats };
  }

  /** Adopt authoritative counts from storage (a partial map is fine — this merges). */
  applyStats(map: Record<string, number>): void {
    let changed = false;
    for (const [key, count] of Object.entries(map)) {
      if (typeof count !== 'number' || this.stats[key] === count) continue;
      this.stats[key] = count;
      changed = true;
    }
    if (changed) this.store.saveRecipeStats(this.stats);
  }

  /** Optimistic local increment so an offline run still shows n+1; returns the new count. */
  bumpStat(key: string): number {
    this.stats[key] = (this.stats[key] ?? 0) + 1;
    this.store.saveRecipeStats(this.stats);
    return this.stats[key];
  }

  /** False while `key` is inside its cooldown — a repeated Run click, not a second run. */
  runAllowed(key: string): boolean {
    const now = Date.now();
    if (now - (this.lastRunAt.get(key) ?? 0) < RUN_COOLDOWN_MS) return false;
    this.lastRunAt.set(key, now);
    return true;
  }
}
