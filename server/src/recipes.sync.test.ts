import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RecipeDef, ServerMessage } from '@lines/shared';
import { RecipeEngine } from './recipes.ts';
import { createStore } from './store.ts';

const USER = 'u1';

const def = (over: Partial<RecipeDef> = {}): RecipeDef => ({
  id: 'r1',
  ownerId: USER,
  version: 1,
  published: false,
  title: 'Auth',
  description: 'd',
  tags: [],
  images: [],
  prompt: 'p',
  ...over,
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-recipe-sync-'));
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const recipes = new RecipeEngine(store, (m) => broadcasts.push(m), USER);
  return { root, store, recipes, broadcasts };
}

test('applySyncedRecipes is last-write-wins on version and never broadcasts', () => {
  const h = harness();
  h.recipes.applySyncedRecipes([def({ version: 3, title: 'v3' })]);
  assert.equal(h.recipes.listRecipes()[0].title, 'v3');
  // A lower version is a stale row from another install — ignored.
  h.recipes.applySyncedRecipes([def({ version: 2, title: 'v2' })]);
  assert.equal(h.recipes.listRecipes()[0].title, 'v3');
  // Equal is adopted: two installs can hold the same version with different blobs.
  h.recipes.applySyncedRecipes([def({ version: 3, title: 'v3b' })]);
  assert.equal(h.recipes.listRecipes()[0].title, 'v3b');
  // Broadcasting would push this straight back up — it came *from* storage.
  assert.equal(h.broadcasts.length, 0);
});

test('setSharedRecipes reports whether the corpus changed', () => {
  const h = harness();
  const foreign = def({ id: 'r9', ownerId: 'u2', published: true });
  assert.equal(h.recipes.setSharedRecipes([foreign]), true);
  assert.equal(h.recipes.setSharedRecipes([foreign]), false, 'same version, no change');
  assert.equal(h.recipes.setSharedRecipes([{ ...foreign, version: 2 }]), true);
  assert.equal(h.recipes.setSharedRecipes([]), true, 'an unpublish is a change');
  assert.deepEqual(h.recipes.listSharedRecipes(), []);
});

test('foreign heads become resolvable versions', () => {
  const h = harness();
  h.recipes.setSharedRecipes([def({ id: 'r9', ownerId: 'u2', version: 4, published: true })]);
  assert.equal(h.recipes.listRecipeVersions('u2', 'r9')[0].version, 4);
});

test('heads, own history and counts round-trip through the store', () => {
  const h = harness();
  const v1 = h.recipes.saveRecipe(
    { title: 'Auth', description: 'd', tags: ['clerk'], images: [], prompt: 'p' },
    undefined,
    true,
    'Ada',
  );
  h.recipes.saveRecipe(
    { title: 'Auth', description: 'd', tags: ['clerk'], images: [], prompt: 'p2' },
    v1.id,
    true,
    'Ada',
  );
  h.recipes.bumpStat(`${USER}/${v1.id}`);

  assert.deepEqual(h.store.loadRecipes().map((r) => r.version), [2]);
  assert.deepEqual(
    h.store.loadRecipeVersions().map((r) => r.version).sort(),
    [1, 2],
  );
  assert.deepEqual(h.store.loadRecipeStats(), { [`${USER}/${v1.id}`]: 1 });

  // A fresh engine over the same root rehydrates all three.
  const reborn = new RecipeEngine(h.store, () => {}, USER);
  assert.equal(reborn.listRecipes()[0].version, 2);
  assert.deepEqual(reborn.listRecipeVersions(USER, v1.id).map((r) => r.version), [2, 1]);
  assert.equal(reborn.allStats()[`${USER}/${v1.id}`], 1);
});

test('applyStats merges rather than replaces', () => {
  const h = harness();
  h.recipes.applyStats({ 'u2/a': 5 });
  h.recipes.applyStats({ 'u2/b': 2 });
  assert.deepEqual(h.recipes.allStats(), { 'u2/a': 5, 'u2/b': 2 });
});

test('deleteRecipe drops the head but keeps the cached versions resolvable', () => {
  const h = harness();
  const r = h.recipes.saveRecipe(
    { title: 'Auth', description: 'd', tags: [], images: [], prompt: 'p' },
    undefined,
    true,
    undefined,
  );
  h.recipes.deleteRecipe(r.id);
  assert.deepEqual(h.recipes.listRecipes(), []);
  assert.equal(h.recipes.listRecipeVersions(USER, r.id).length, 1);
});
