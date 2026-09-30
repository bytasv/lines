import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { grepFilesAcross } from './contentSearch.ts';

/**
 * Find-in-files reuses quick-open's candidate list, so the ignore behaviour is
 * the same one fileSearch.test.ts pins; these cover the content side — matching,
 * the skip rules and the caps.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-grep-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-grep-other-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-grep-repo-'));
after(() => {
  for (const dir of [root, other, repo]) fs.rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, rel: string, content: string | Buffer) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

write(root, 'a.ts', 'const needle = 1;\nno match here\nNeedle again\n');
write(root, 'sub/b.ts', 'function needles() {}\n');
write(root, 'binary.bin', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
write(root, 'big.txt', `needle\n${'x'.repeat(1024 * 1024)}`);
write(root, 'node_modules/dep/index.js', 'needle');
write(other, 'c.md', 'a needle in the other root\n');
write(repo, '.gitignore', 'secret.txt\n');
write(repo, 'secret.txt', 'needle\n');
write(repo, 'visible.txt', 'needle\n');
execFileSync('git', ['-C', repo, 'init', '--quiet'], { stdio: 'ignore' });

const rels = (res: Awaited<ReturnType<typeof grepFilesAcross>>) =>
  res.files.map((f) => `${path.basename(f.root)}:${f.rel}`).sort();

test('finds matches across roots, with 1-based line and column', async () => {
  const res = await grepFilesAcross([root, other], 'needle');
  const a = res.files.find((f) => f.rel === 'a.ts');
  assert.deepEqual(a?.matches, [
    { line: 1, col: 7, text: 'const needle = 1;' },
    { line: 3, col: 1, text: 'Needle again' },
  ]);
  assert.ok(res.files.some((f) => f.root === other && f.rel === 'c.md'));
  assert.equal(res.truncated, undefined);
});

test('binary, oversized and node_modules files are skipped', async () => {
  const res = await grepFilesAcross([root], 'needle');
  const found = res.files.map((f) => f.rel);
  assert.ok(!found.includes('binary.bin'));
  assert.ok(!found.includes('big.txt'));
  assert.ok(!found.some((f) => f.startsWith('node_modules')));
});

test('case, whole-word and regex flags', async () => {
  const cased = await grepFilesAcross([root], 'Needle', { caseSensitive: true });
  assert.deepEqual(cased.files.map((f) => [f.rel, f.matches.map((m) => m.line)]), [['a.ts', [3]]]);
  const word = await grepFilesAcross([root], 'needle', { wholeWord: true });
  assert.ok(!word.files.some((f) => f.rel === 'sub/b.ts'));
  const re = await grepFilesAcross([root], 'needle[s]\\(', { regex: true });
  assert.deepEqual(re.files.map((f) => f.rel), ['sub/b.ts']);
});

test('an invalid regex throws a SyntaxError', async () => {
  await assert.rejects(grepFilesAcross([root], '(', { regex: true }), SyntaxError);
});

test('gitignored files are excluded unless includeIgnored', async () => {
  assert.deepEqual(rels(await grepFilesAcross([repo], 'needle')), [`${path.basename(repo)}:visible.txt`]);
  assert.deepEqual(rels(await grepFilesAcross([repo], 'needle', { includeIgnored: true })), [
    `${path.basename(repo)}:secret.txt`,
    `${path.basename(repo)}:visible.txt`,
  ]);
});

test('caps stop the search and mark it truncated', async () => {
  const byFiles = await grepFilesAcross([root, other], 'needle', { maxFiles: 1 });
  assert.equal(byFiles.files.length, 1);
  assert.equal(byFiles.truncated, true);
  const byMatches = await grepFilesAcross([root], 'needle', { maxMatches: 1 });
  assert.equal(byMatches.files.flatMap((f) => f.matches).length, 1);
  assert.equal(byMatches.truncated, true);
});

test('an empty query matches nothing', async () => {
  assert.deepEqual(await grepFilesAcross([root], ''), { files: [] });
});

test('a long line is clipped around its match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-grep-long-'));
  try {
    write(dir, 'long.txt', `${'a'.repeat(500)}needle${'b'.repeat(500)}\n`);
    const [hit] = (await grepFilesAcross([dir], 'needle')).files;
    const { text, col } = hit.matches[0];
    assert.equal(col, 501);
    assert.ok(text.length <= 202);
    assert.ok(text.startsWith('…') && text.endsWith('…') && text.includes('needle'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
