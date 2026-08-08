import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RecipeContent, ServerMessage } from '@lines/shared';
import { RecipeEngine } from './recipes.ts';
import { createStore } from './store.ts';

const USER = 'u1';

const content = (over: Partial<RecipeContent> = {}): RecipeContent => ({
  title: 'Auth management',
  description: 'Wire up Clerk auth',
  tags: [],
  images: [],
  prompt: 'Add Clerk auth to this app.',
  ...over,
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-recipe-ver-'));
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const recipes = new RecipeEngine(store, (m) => broadcasts.push(m), USER);
  return { root, store, recipes, broadcasts };
}

test('a first save is version 1 and stamps the owner', () => {
  const h = harness();
  const saved = h.recipes.saveRecipe(content(), undefined, false, 'Ada');
  assert.equal(saved.version, 1);
  assert.equal(saved.ownerId, USER);
  assert.equal(saved.ownerName, 'Ada');
  assert.equal(saved.published, false);
  assert.ok(saved.updatedAt);
  assert.ok(h.broadcasts.some((m) => m.type === 'recipes'));
});

test('a content change bumps the version and keeps the older one', () => {
  const h = harness();
  const v1 = h.recipes.saveRecipe(content(), undefined, false, undefined);
  const v2 = h.recipes.saveRecipe(content({ prompt: 'Add Clerk auth, with orgs.' }), v1.id, false, undefined);
  assert.equal(v2.version, 2);
  assert.deepEqual(
    h.recipes.listRecipeVersions(USER, v1.id).map((r) => r.version),
    [2, 1],
  );
  assert.equal(h.recipes.listRecipes().length, 1, 'one head, two versions');
});

test('toggling published alone keeps the version', () => {
  const h = harness();
  const v1 = h.recipes.saveRecipe(content(), undefined, false, undefined);
  const same = h.recipes.saveRecipe(content(), v1.id, true, undefined);
  assert.equal(same.version, 1);
  assert.equal(same.published, true);
});

test('reordering images bumps — display order is content an old version must keep', () => {
  const h = harness();
  const v1 = h.recipes.saveRecipe(content({ images: ['a.png', 'b.png'] }), undefined, false, undefined);
  const v2 = h.recipes.saveRecipe(content({ images: ['b.png', 'a.png'] }), v1.id, false, undefined);
  assert.equal(v2.version, 2);
});

test('reordering tags does NOT bump — tags are a set, not a sequence', () => {
  const h = harness();
  const v1 = h.recipes.saveRecipe(content({ tags: ['clerk', 'security'] }), undefined, false, undefined);
  const same = h.recipes.saveRecipe(content({ tags: ['security', 'clerk'] }), v1.id, false, undefined);
  assert.equal(same.version, 1);
});

test('adding a tag does bump', () => {
  const h = harness();
  const v1 = h.recipes.saveRecipe(content({ tags: ['clerk'] }), undefined, false, undefined);
  const v2 = h.recipes.saveRecipe(content({ tags: ['clerk', 'security'] }), v1.id, false, undefined);
  assert.equal(v2.version, 2);
});

/**
 * The comparison has to run on *normalized* tags. Comparing raw ones while the
 * engine stores normalized ones bumps a version on every save where the author
 * typed mixed case, filling an append-only table with identical rows.
 */
test('a casing-only tag edit does not bump', () => {
  const h = harness();
  const v1 = h.recipes.saveRecipe(content({ tags: ['Auth'] }), undefined, false, undefined);
  assert.deepEqual(v1.tags, ['auth']);
  const same = h.recipes.saveRecipe(content({ tags: ['auth'] }), v1.id, false, undefined);
  assert.equal(same.version, 1);
});
