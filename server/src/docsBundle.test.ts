import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectDocs } from './docsBundle.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lines-docs-'));
}

/** Create `<root>/<rel>` (and its parents) with `body`. */
function write(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

test('collects markdown recursively with posix paths relative to the docs root', () => {
  const root = tmp();
  write(root, 'README.md', '# readme');
  write(root, 'codebase/features/guard.md', '# guard');
  write(root, 'codebase/index.md', '# index');

  const { docs, truncated } = collectDocs(root);

  assert.deepEqual(
    docs.map((d) => d.path),
    ['README.md', 'codebase/features/guard.md', 'codebase/index.md'],
  );
  assert.equal(docs[1].content, '# guard');
  assert.ok(docs[1].bytes > 0);
  assert.ok(docs[1].mtime > 0);
  assert.equal(truncated, false);
});

test('skips non-markdown files, dotfiles and ignored directories', () => {
  const root = tmp();
  write(root, 'keep.md', '# keep');
  write(root, 'codebase/index.json', '{}');
  write(root, '.hidden.md', '# hidden');
  write(root, 'node_modules/pkg/readme.md', '# dep');
  write(root, 'img.png', 'binary');

  const { docs } = collectDocs(root);

  assert.deepEqual(
    docs.map((d) => d.path),
    ['keep.md'],
  );
});

test('does not follow symlinked directories', () => {
  const root = tmp();
  write(root, 'a.md', '# a');
  fs.symlinkSync(root, path.join(root, 'loop'), 'dir');

  const { docs } = collectDocs(root);

  assert.deepEqual(
    docs.map((d) => d.path),
    ['a.md'],
  );
});

test('does not read symlinked markdown files', () => {
  const root = tmp();
  const secret = path.join(root, 'outside.md');
  fs.writeFileSync(secret, 'private key');
  const docsRoot = path.join(root, 'docs');
  fs.mkdirSync(docsRoot);
  write(docsRoot, 'a.md', '# a');
  fs.symlinkSync(secret, path.join(docsRoot, 'leak.md'));

  const { docs } = collectDocs(docsRoot);

  assert.deepEqual(
    docs.map((d) => d.path),
    ['a.md'],
  );
});

test('flags truncation and skips a file over the per-file byte cap', () => {
  const root = tmp();
  write(root, 'small.md', '# small');
  write(root, 'big.md', 'x'.repeat(500));

  const { docs, truncated } = collectDocs(root, { maxFileBytes: 100 });

  assert.deepEqual(
    docs.map((d) => d.path),
    ['small.md'],
  );
  assert.equal(truncated, true);
});

test('flags truncation when the total byte budget is exhausted', () => {
  const root = tmp();
  write(root, 'a.md', 'x'.repeat(60));
  write(root, 'b.md', 'y'.repeat(60));

  const { docs, truncated } = collectDocs(root, { maxTotalBytes: 100 });

  // Which of the two lands depends on directory order; the budget stops the second.
  assert.equal(docs.length, 1);
  assert.equal(truncated, true);
});

test('stops at the file-count limit', () => {
  const root = tmp();
  write(root, 'a.md', '# a');
  write(root, 'b.md', '# b');
  write(root, 'c.md', '# c');

  const { docs, truncated } = collectDocs(root, { maxFiles: 2 });

  assert.equal(docs.length, 2);
  assert.equal(truncated, true);
});

test('stops descending past the depth limit', () => {
  const root = tmp();
  write(root, 'top.md', '# top');
  write(root, 'a/b/c/deep.md', '# deep');

  const { docs, truncated } = collectDocs(root, { maxDepth: 1 });

  assert.deepEqual(
    docs.map((d) => d.path),
    ['top.md'],
  );
  assert.equal(truncated, true);
});

test('returns an empty bundle for a docs directory with no markdown', () => {
  const root = tmp();
  write(root, 'notes.txt', 'plain');

  assert.deepEqual(collectDocs(root), { docs: [], truncated: false });
});

test('skips an unreadable subdirectory instead of throwing', () => {
  const root = tmp();
  write(root, 'a.md', '# a');
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'b.md'), '# b');
  fs.chmodSync(locked, 0o000);

  try {
    const { docs } = collectDocs(root);
    assert.deepEqual(
      docs.map((d) => d.path),
      ['a.md'],
    );
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});
