import assert from 'node:assert/strict';
import { test } from 'node:test';
import { docSummary, docTitle, searchDocs } from '@lines/shared';

const GUARD = {
  path: 'codebase/features/guard-allowlist.md',
  content: [
    '# Guard allowlist',
    '',
    '## Purpose',
    '',
    'Let the user pre-approve tool calls the auto-mode guard would otherwise stop.',
    '',
    '## Entry points',
    '',
    '- server/src/autoGuard.ts',
  ].join('\n'),
};

const MENTIONS = {
  path: 'codebase/features/prompt-mentions.md',
  content: ['# Prompt mentions', '', 'The composer offers an allowlist of roots.', ''].join('\n'),
};

test('the h1 heading is the doc title', () => {
  assert.equal(docTitle(GUARD.content, GUARD.path), 'Guard allowlist');
});

test('the file name is the title when there is no heading', () => {
  assert.equal(docTitle('no heading here', 'codebase/features/app-data-root.md'), 'app-data-root');
});

test('the purpose section supplies the summary', () => {
  assert.equal(
    docSummary(GUARD.content),
    'Let the user pre-approve tool calls the auto-mode guard would otherwise stop.',
  );
});

test('the first paragraph is the summary when there is no purpose section', () => {
  assert.equal(docSummary(MENTIONS.content), 'The composer offers an allowlist of roots.');
});

test('a title match outranks a body match', () => {
  const hits = searchDocs([MENTIONS, GUARD], 'allowlist', 10);

  assert.deepEqual(
    hits.map((h) => h.path),
    [GUARD.path, MENTIONS.path],
  );
  assert.equal(hits[0].rank, 0);
  assert.equal(hits[1].rank, 2);
});

test('search is case-insensitive across the corpus', () => {
  const hits = searchDocs([MENTIONS, GUARD], 'AUTO-MODE', 10);

  assert.deepEqual(
    hits.map((h) => h.path),
    [GUARD.path],
  );
});

test('at most three snippets per doc, with 1-indexed line numbers', () => {
  const doc = {
    path: 'a.md',
    content: ['needle', 'needle', 'needle', 'needle'].join('\n'),
  };

  const [hit] = searchDocs([doc], 'needle', 10);

  assert.equal(hit.matches.length, 3);
  assert.deepEqual(
    hit.matches.map((m) => m.line),
    [1, 2, 3],
  );
});

test('an empty query returns no hits', () => {
  assert.deepEqual(searchDocs([GUARD, MENTIONS], '   ', 10), []);
});
