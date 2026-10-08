import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { protectedSubdirs, searchFilesAcross } from './fileSearch.ts';

/**
 * Ranking is what the composer's `@mention` menu and `/find` both show, so these
 * pin the order, not merely the membership, of the results.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-filesearch-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-filesearch-other-'));
// The ignore rules only exist inside a repo, so that half needs a real one.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-filesearch-repo-'));
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function write(dir: string, rels: string[]) {
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
  }
}

write(root, [
  'shared/types.ts',
  'web/src/lib/prettyTypes.ts',
  'web/src/components/MentionInput.tsx',
  'web/src/components/Composer.tsx',
  'web/src/lib/webSocketConfig.ts',
  'web/src/lib/deeply/nested/mainIndex.ts',
  'mnt/inp/tools.ts',
  'zzalphaBeta.ts',
  'alphaxbeta.ts',
  '.github/workflows/ci.yml',
  '.env.example',
]);
write(other, ['shared/types.ts']);
write(repo, ['.gitignore', 'secret.txt', 'visible.txt']);
fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.txt\n');
execFileSync('git', ['-C', repo, 'init', '--quiet'], { stdio: 'ignore' });

/** Result paths in rank order, for the single-root tree above. */
function find(query: string, limit = 20): string[] {
  return searchFilesAcross([root], query, limit).map((h) => h.rel);
}

test('a query typed as two words still matches the file name', () => {
  assert.equal(find('mention input')[0], 'web/src/components/MentionInput.tsx');
});

test('a backslash in the query is read as a path separator', () => {
  assert.deepEqual(find('src\\components'), [
    'web/src/components/Composer.tsx',
    'web/src/components/MentionInput.tsx',
  ]);
});

test('a whitespace-only query matches nothing', () => {
  assert.deepEqual(find('   '), []);
});

test('a basename prefix outranks a basename substring', () => {
  assert.deepEqual(find('types'), ['shared/types.ts', 'web/src/lib/prettyTypes.ts']);
});

test('a subsequence in the file name outranks one smeared across the path', () => {
  const hits = find('mntinpt');

  assert.deepEqual(hits, ['web/src/components/MentionInput.tsx', 'mnt/inp/tools.ts']);
});

test('a subsequence in the file name outranks one across directory names', () => {
  const hits = find('wsc');

  assert.ok(
    hits.indexOf('web/src/lib/webSocketConfig.ts') < hits.indexOf('web/src/components/Composer.tsx'),
    `expected the webSocketConfig basename hit first, got ${hits.join(', ')}`,
  );
});

test('a tighter subsequence outranks a shorter path', () => {
  const hits = find('mi');

  assert.ok(
    hits.indexOf('web/src/lib/deeply/nested/mainIndex.ts') <
      hits.indexOf('web/src/components/MentionInput.tsx'),
    `expected the tighter mainIndex match first, got ${hits.join(', ')}`,
  );
});

test('a match on a camelCase hump outranks one landing mid-word', () => {
  assert.deepEqual(find('ab'), ['zzalphaBeta.ts', 'alphaxbeta.ts']);
});

test('a dot-file is a candidate', () => {
  assert.deepEqual(find('env.example'), ['.env.example']);
});

test('a file inside a dot-directory is a candidate', () => {
  assert.deepEqual(find('ci.yml'), ['.github/workflows/ci.yml']);
});

test('the limit caps the result list', () => {
  assert.equal(find('types', 1).length, 1);
});

test('a gitignored file is left out by default', () => {
  const hits = searchFilesAcross([repo], 'txt', 10);

  assert.deepEqual(hits.map((h) => h.rel), ['visible.txt']);
});

test('includeIgnored brings the gitignored file back', () => {
  const hits = searchFilesAcross([repo], 'txt', 10, true);

  assert.deepEqual(hits.map((h) => h.rel).sort(), ['secret.txt', 'visible.txt']);
});

test('an equally good match in the primary root wins', () => {
  const hits = searchFilesAcross([root, other], 'types.ts', 10);

  assert.equal(hits[0].root, root);
  assert.equal(hits[1].root, other);
});

/**
 * Lines' children are attributed to Lines for macOS privacy (TCC), so a search
 * rooted at or above home must never list the guarded folders. A fake home per
 * case keeps the candidate cache, which is keyed by root, from leaking between them.
 */
const homeLayout = [
  'Library/Containers/app/x.txt',
  'Documents/d.txt',
  'Desktop/k.txt',
  'Downloads/dl.txt',
  'src/keep.txt',
];

function fakeHome(t: TestContext, git: boolean): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-filesearch-home-'));
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  write(home, homeLayout);
  if (git) execFileSync('git', ['-C', home, 'init', '--quiet'], { stdio: 'ignore' });
  t.mock.method(os, 'homedir', () => home);
  return home;
}

const darwinOnly = { skip: process.platform !== 'darwin' };

test('a walk from home skips the macOS-protected folders', darwinOnly, (t) => {
  const home = fakeHome(t, false);
  assert.deepEqual(searchFilesAcross([home], 'txt', 20).map((h) => h.rel), ['src/keep.txt']);
});

test('a git listing from home skips the macOS-protected folders', darwinOnly, (t) => {
  const home = fakeHome(t, true);
  assert.deepEqual(searchFilesAcross([home], 'txt', 20).map((h) => h.rel), ['src/keep.txt']);
});

test('a root inside a protected folder is searched normally', darwinOnly, (t) => {
  const home = fakeHome(t, false);
  const proj = path.join(home, 'Documents', 'proj');
  write(proj, ['a.txt', 'Library/b.txt']);
  assert.deepEqual(searchFilesAcross([proj], 'txt', 20).map((h) => h.rel).sort(), [
    'Library/b.txt',
    'a.txt',
  ]);
});

test('protectedSubdirs lists only folders strictly inside the root', () => {
  assert.deepEqual(protectedSubdirs('/Users/me', '/Users/me', 'darwin'), [
    'Library',
    'Desktop',
    'Documents',
    'Downloads',
  ]);
  assert.deepEqual(protectedSubdirs('/Users', '/Users/me', 'darwin'), [
    'me/Library',
    'me/Desktop',
    'me/Documents',
    'me/Downloads',
  ]);
  assert.deepEqual(protectedSubdirs('/tmp/proj', '/Users/me', 'darwin'), []);
  assert.deepEqual(protectedSubdirs('/Users/me/Documents', '/Users/me', 'darwin'), []);
  assert.deepEqual(protectedSubdirs('/Users/me/Documents/proj', '/Users/me', 'darwin'), []);
});

test('protectedSubdirs is empty off macOS', () => {
  assert.deepEqual(protectedSubdirs('/home/me', '/home/me', 'linux'), []);
});
