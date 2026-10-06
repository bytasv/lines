import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isServedRecipeImage } from './r2.ts';

/**
 * A recipe is one author's content rendered for everyone else, and an image
 * loads on sight. Only URLs under this deployment's own bucket — where uploads
 * land — may be stored, so a recipe cannot make its viewers' browsers call a
 * host of the author's choosing.
 */
const BASE = 'https://pub-example.r2.dev';
let saved: string | undefined;
before(() => {
  saved = process.env.R2_PUBLIC_BASE_URL;
  process.env.R2_PUBLIC_BASE_URL = `${BASE}/`;
});
after(() => {
  if (saved === undefined) delete process.env.R2_PUBLIC_BASE_URL;
  else process.env.R2_PUBLIC_BASE_URL = saved;
});

test('an upload’s own URL is accepted, whoever uploaded it', () => {
  assert.equal(isServedRecipeImage(`${BASE}/recipes/user_a/0f6c.png`), true);
  // A duplicated recipe keeps its original author's images, under their prefix.
  assert.equal(isServedRecipeImage(`${BASE}/recipes/user_b/9a1d.webp`), true);
});

test('anything else is refused', () => {
  for (const url of [
    'https://evil.example/recipes/x.png?leak=1',
    `${BASE}.evil.example/recipes/x.png`,
    `${BASE}/other/x.png`,
    `${BASE}/recipes/../secrets.png`,
    'data:image/png;base64,AAAA',
    '//evil.example/x.png',
    42,
    null,
  ]) {
    assert.equal(isServedRecipeImage(url), false, String(url));
  }
});

test('with no bucket configured, no image URL is one of ours', () => {
  const base = process.env.R2_PUBLIC_BASE_URL;
  delete process.env.R2_PUBLIC_BASE_URL;
  try {
    assert.equal(isServedRecipeImage(`${BASE}/recipes/user_a/0f6c.png`), false);
  } finally {
    process.env.R2_PUBLIC_BASE_URL = base;
  }
});
