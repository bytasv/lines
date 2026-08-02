import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDocLink } from '@lines/shared';

const PROJECT_ROOT = '/repo';
const DOCS_ROOT = '/repo/docs';
const CORPUS = new Set([
  'codebase/README.md',
  'codebase/features/guard-allowlist.md',
  'codebase/features/prompt-mentions.md',
]);

function resolve(href: string, fromRel = 'codebase/features/guard-allowlist.md') {
  return resolveDocLink({
    href,
    fromRel,
    docsRoot: DOCS_ROOT,
    projectRoot: PROJECT_ROOT,
    hasDoc: (rel) => CORPUS.has(rel),
  });
}

test('a sibling relative link resolves inside the docs tree', () => {
  assert.deepEqual(resolve('prompt-mentions.md'), {
    kind: 'doc',
    rel: 'codebase/features/prompt-mentions.md',
  });
});

test('a ../ link resolves against the parent doc directory', () => {
  assert.deepEqual(resolve('../README.md'), { kind: 'doc', rel: 'codebase/README.md' });
});

test('a link that escapes the docs root becomes a file preview path', () => {
  assert.deepEqual(resolve('../../../server/src/index.ts'), {
    kind: 'file',
    abs: '/repo/server/src/index.ts',
  });
});

test('an escaping link cannot climb above the project root', () => {
  assert.deepEqual(resolve('../../../../../../etc/passwd'), { kind: 'file', abs: '/repo/etc/passwd' });
});

test('an http link is external', () => {
  assert.deepEqual(resolve('https://example.com/x'), {
    kind: 'external',
    href: 'https://example.com/x',
  });
});

test('a windows-style drive href is treated as external', () => {
  assert.deepEqual(resolve('C:/Users/x/notes.md'), { kind: 'external', href: 'C:/Users/x/notes.md' });
});

test('a bare hash keeps the current doc', () => {
  assert.deepEqual(resolve('#business-rules'), {
    kind: 'doc',
    rel: 'codebase/features/guard-allowlist.md',
    hash: 'business-rules',
  });
});

test('query string and hash are stripped from the resolved doc path', () => {
  assert.deepEqual(resolve('../README.md?v=2#purpose'), {
    kind: 'doc',
    rel: 'codebase/README.md',
    hash: 'purpose',
  });
});

test('a relative link to source code resolves to an absolute file path', () => {
  assert.deepEqual(resolve('assets/diagram.png'), {
    kind: 'file',
    abs: '/repo/docs/codebase/features/assets/diagram.png',
  });
});

test('a missing markdown target still resolves as a doc so the reader can report it', () => {
  assert.deepEqual(resolve('gone.md'), { kind: 'doc', rel: 'codebase/features/gone.md' });
});
