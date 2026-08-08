import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RecipeContent, RecipeDef, RecipeRef } from '@lines/shared';
import { RECIPE_BUNDLE_MAX } from '@lines/shared';
import { RecipeEngine } from './recipes.ts';
import { createStore } from './store.ts';

const USER = 'u1';

const leaf = (title: string, over: Partial<RecipeContent> = {}): RecipeContent => ({
  title,
  description: `${title} description`,
  tags: [],
  images: [],
  prompt: `Do ${title}`,
  ...over,
});

const bundle = (title: string, members: RecipeRef[], over: Partial<RecipeContent> = {}): RecipeContent => ({
  title,
  description: `${title} description`,
  tags: [],
  images: [],
  prompt: '',
  members,
  ...over,
});

const ref = (r: RecipeDef): RecipeRef => ({ ownerId: r.ownerId, recipeId: r.id });

function engine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-recipe-comp-'));
  return new RecipeEngine(createStore(root), () => {}, USER);
}

/** Three published leaves plus the engine holding them. */
function trio() {
  const recipes = engine();
  const [a, b, c] = ['Infra', 'Auth', 'Database'].map((t) =>
    recipes.saveRecipe(leaf(t), undefined, true, undefined),
  );
  return { recipes, a, b, c };
}

// ---- invariants ----

test('a recipe carrying both a prompt and members is refused', () => {
  const { recipes, a, b } = trio();
  assert.throws(
    () => recipes.saveRecipe(bundle('Both', [ref(a), ref(b)], { prompt: 'also a prompt' }), undefined, false, undefined),
    /not both/,
  );
});

test('a recipe carrying neither is refused', () => {
  const recipes = engine();
  assert.throws(() => recipes.saveRecipe(leaf('Empty', { prompt: '   ' }), undefined, false, undefined), /needs either/);
});

test('a bundle of bundles is refused outright — no nesting, so no cycles or depth limits', () => {
  const { recipes, a, b, c } = trio();
  const inner = recipes.saveRecipe(bundle('Inner', [ref(a), ref(b)]), undefined, true, undefined);
  assert.throws(
    () => recipes.saveRecipe(bundle('Outer', [ref(inner), ref(c)]), undefined, false, undefined),
    /cannot contain another bundle/,
  );
});

test('a one-member bundle and an over-cap bundle are both refused', () => {
  const { recipes, a } = trio();
  assert.throws(() => recipes.saveRecipe(bundle('Thin', [ref(a)]), undefined, false, undefined), /at least two/);
  const many = Array.from({ length: RECIPE_BUNDLE_MAX + 1 }, (_, n) =>
    recipes.saveRecipe(leaf(`R${n}`), undefined, true, undefined),
  );
  assert.throws(
    () => recipes.saveRecipe(bundle('Fat', many.map(ref)), undefined, false, undefined),
    /at most/,
  );
});

test('duplicate members dedupe, preserving first position', () => {
  const { recipes, a, b, c } = trio();
  const saved = recipes.saveRecipe(
    bundle('Kit', [ref(a), ref(b), ref(a), ref(c)]),
    undefined,
    false,
    undefined,
  );
  assert.deepEqual(saved.members?.map((m) => m.recipeId), [a.id, b.id, c.id]);
});

test('an unknown member is refused', () => {
  const { recipes, a } = trio();
  assert.throws(
    () => recipes.saveRecipe(bundle('Kit', [ref(a), { ownerId: USER, recipeId: 'nope' }]), undefined, false, undefined),
    /Unknown recipe/,
  );
});

test('publishing a bundle requires every member published, and the error names them', () => {
  const { recipes, a, b } = trio();
  const priv = recipes.saveRecipe(leaf('Secret sauce'), undefined, false, undefined);
  assert.throws(
    () => recipes.saveRecipe(bundle('Kit', [ref(a), ref(b), ref(priv)]), undefined, true, undefined),
    /Secret sauce/,
  );
  // Unpublished, the same bundle saves fine.
  assert.ok(recipes.saveRecipe(bundle('Kit', [ref(a), ref(b), ref(priv)]), undefined, false, undefined));
});

// ---- version bumps ----

test('reordering members bumps — member order is execution order', () => {
  const { recipes, a, b, c } = trio();
  const v1 = recipes.saveRecipe(bundle('Kit', [ref(a), ref(b), ref(c)]), undefined, false, undefined);
  const v2 = recipes.saveRecipe(bundle('Kit', [ref(b), ref(a), ref(c)]), v1.id, false, undefined);
  assert.equal(v2.version, 2);
});

test('re-saving identical members does not bump; adding one does', () => {
  const { recipes, a, b, c } = trio();
  const v1 = recipes.saveRecipe(bundle('Kit', [ref(a), ref(b)]), undefined, false, undefined);
  const same = recipes.saveRecipe(bundle('Kit', [ref(a), ref(b)]), v1.id, false, undefined);
  assert.equal(same.version, 1);
  const v2 = recipes.saveRecipe(bundle('Kit', [ref(a), ref(b), ref(c)]), v1.id, false, undefined);
  assert.equal(v2.version, 2);
});

// ---- expansion ----

test('a single bundle ref expands to its members, in order', () => {
  const { recipes, a, b, c } = trio();
  const kit = recipes.saveRecipe(bundle('Kit', [ref(c), ref(a), ref(b)]), undefined, false, undefined);
  const { leaves, bundles } = recipes.expandForRun([{ ownerId: USER, recipeId: kit.id }]);
  assert.deepEqual(leaves.map((r) => r.title), ['Database', 'Infra', 'Auth']);
  assert.deepEqual(bundles.map((r) => r.id), [kit.id]);
});

test('a bundle inside an ad-hoc list is spliced in place', () => {
  const { recipes, a, b, c } = trio();
  const extra = recipes.saveRecipe(leaf('Payments'), undefined, true, undefined);
  const kit = recipes.saveRecipe(bundle('Kit', [ref(a), ref(b)]), undefined, false, undefined);
  const { leaves } = recipes.expandForRun([
    { ownerId: USER, recipeId: c.id },
    { ownerId: USER, recipeId: kit.id },
    { ownerId: USER, recipeId: extra.id },
  ]);
  assert.deepEqual(leaves.map((r) => r.title), ['Database', 'Infra', 'Auth', 'Payments']);
});

/** The gap publish-time validation cannot close: a member can be unpublished later. */
test('a member unpublished after the bundle was saved fails the run, naming it', () => {
  const recipes = engine();
  const mine = recipes.saveRecipe(leaf('Infra'), undefined, true, undefined);
  const foreign: RecipeDef = { ...leaf('Auth'), id: 'r9', ownerId: 'u2', version: 1, published: true };
  recipes.setSharedRecipes([foreign]);
  const kit = recipes.saveRecipe(
    bundle('Kit', [ref(mine), { ownerId: 'u2', recipeId: 'r9' }]),
    undefined,
    false,
    undefined,
  );
  // The author unpublishes their recipe: it leaves this bridge's corpus.
  recipes.setSharedRecipes([]);
  assert.throws(() => recipes.expandForRun([{ ownerId: USER, recipeId: kit.id }]), /Kit.*u2\/r9/s);
});

test('listBundlesContaining finds own bundles depending on a recipe', () => {
  const { recipes, a, b, c } = trio();
  const kit = recipes.saveRecipe(bundle('Kit', [ref(a), ref(b)]), undefined, false, undefined);
  assert.deepEqual(recipes.listBundlesContaining(USER, a.id).map((r) => r.id), [kit.id]);
  assert.deepEqual(recipes.listBundlesContaining(USER, c.id), []);
});

test('a bundle stores no prompt of its own', () => {
  const { recipes, a, b } = trio();
  const kit = recipes.saveRecipe(bundle('Kit', [ref(a), ref(b)]), undefined, false, undefined);
  assert.equal(kit.prompt, '');
});
