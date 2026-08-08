import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RecipeContent } from '@lines/shared';
import { normalizeRecipeTag, RECIPE_TAG_MAX, RECIPE_TAG_MAX_LEN } from '@lines/shared';
import { RecipeEngine } from './recipes.ts';
import { createStore } from './store.ts';

const USER = 'u1';

const content = (over: Partial<RecipeContent> = {}): RecipeContent => ({
  title: 'Auth management',
  description: 'd',
  tags: [],
  images: [],
  prompt: 'p',
  ...over,
});

function engine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-recipe-tags-'));
  return new RecipeEngine(createStore(root), () => {}, USER);
}

test('normalizeRecipeTag folds case, whitespace and punctuation', () => {
  const cases: [string, string][] = [
    ['Auth Management', 'auth-management'],
    ['  Clerk  ', 'clerk'],
    ['AUTH', 'auth'],
    ['e-shop', 'e-shop'],
    ['next.js', 'next.js'],
    ['front_end', 'front_end'],
    ['C++ / Rust!', 'c-rust'],
    ['a   b', 'a-b'],
    ['   ', ''],
    ['!!!', ''],
    ['-lead-trail-', 'lead-trail'],
    ['x'.repeat(RECIPE_TAG_MAX_LEN + 10), 'x'.repeat(RECIPE_TAG_MAX_LEN)],
  ];
  for (const [raw, want] of cases) assert.equal(normalizeRecipeTag(raw), want, raw);
});

test('saveRecipe collapses casing variants into one tag', () => {
  const r = engine().saveRecipe(content({ tags: ['Auth', 'auth', 'AUTH'] }), undefined, false, undefined);
  assert.deepEqual(r.tags, ['auth']);
});

test('saveRecipe drops tags that normalize to nothing', () => {
  const r = engine().saveRecipe(content({ tags: ['  ', '!!!', 'clerk'] }), undefined, false, undefined);
  assert.deepEqual(r.tags, ['clerk']);
});

test('saveRecipe clamps to the tag cap', () => {
  const tags = Array.from({ length: RECIPE_TAG_MAX + 4 }, (_, n) => `tag${n}`);
  const r = engine().saveRecipe(content({ tags }), undefined, false, undefined);
  assert.equal(r.tags.length, RECIPE_TAG_MAX);
  assert.deepEqual(r.tags, tags.slice(0, RECIPE_TAG_MAX));
});

test('an empty tag list is accepted as-is, not defaulted', () => {
  const r = engine().saveRecipe(content({ tags: [] }), undefined, false, undefined);
  assert.deepEqual(r.tags, []);
});

/** The bypass-the-UI case: without server-side re-normalization one client
 *  reintroduces casing variants for everyone. */
test('a client that skips the TagsInput still gets normalized tags', () => {
  const r = engine().saveRecipe(
    content({ tags: ['Auth Management', ' Security ', 'CI/CD'] }),
    undefined,
    false,
    undefined,
  );
  assert.deepEqual(r.tags, ['auth-management', 'security', 'cicd']);
});
