import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNameStatus, parseNumstat } from './git.ts';

/**
 * The two parsers behind the session review diff, against real `git diff` output
 * shapes. Pure by design so they are testable without a repo — the same split
 * `parseWorktreeList` uses in worktrees.ts. `refExists` is exercised through the
 * routes rather than by shelling out here.
 */

test('parseNameStatus: adds, edits and deletes', () => {
  assert.deepEqual(parseNameStatus('A\tnew.ts\nM\tsrc/a.ts\nD\tgone.ts\n'), [
    { rel: 'new.ts', status: 'A' },
    { rel: 'src/a.ts', status: 'M' },
    { rel: 'gone.ts', status: 'D' },
  ]);
});

test('parseNameStatus: a rename is the old path leaving and the new one arriving', () => {
  // The review list is a list of paths; it has no rename row to put `R100` in.
  assert.deepEqual(parseNameStatus('R100\told.ts\tnew.ts\n'), [
    { rel: 'old.ts', status: 'D' },
    { rel: 'new.ts', status: 'A' },
  ]);
  // A copy leaves the source in place, so only the new path is a change.
  assert.deepEqual(parseNameStatus('C75\tsrc.ts\tcopy.ts\n'), [{ rel: 'copy.ts', status: 'A' }]);
});

test('parseNameStatus: typechange and unmerged read as modifications', () => {
  assert.deepEqual(parseNameStatus('T\tlink.ts\nU\tconflict.ts\n'), [
    { rel: 'link.ts', status: 'M' },
    { rel: 'conflict.ts', status: 'M' },
  ]);
});

test('parseNameStatus: blank lines and trailing newlines are not entries', () => {
  assert.deepEqual(parseNameStatus(''), []);
  assert.deepEqual(parseNameStatus('\n\n'), []);
});

test('parseNumstat: line counts, keyed by path', () => {
  const stats = parseNumstat('12\t3\tsrc/a.ts\n0\t7\tdrop.ts\n');
  assert.deepEqual(stats.get('src/a.ts'), { added: 12, removed: 3 });
  assert.deepEqual(stats.get('drop.ts'), { added: 0, removed: 7 });
});

test('parseNumstat: a binary file is 0/0, never NaN', () => {
  // git prints `-` for binary: it counts bytes there, not lines.
  assert.deepEqual(parseNumstat('-\t-\tlogo.png\n').get('logo.png'), { added: 0, removed: 0 });
});

test('parseNumstat: a rename is keyed on the new path', () => {
  // Both spellings git uses — the plain arrow, and the braced common-prefix form.
  assert.deepEqual(parseNumstat('1\t2\told.ts => new.ts\n').get('new.ts'), { added: 1, removed: 2 });
  assert.deepEqual(parseNumstat('1\t2\tsrc/{a => b}.ts\n').get('src/b.ts'), { added: 1, removed: 2 });
  // An empty side of the brace would otherwise leave a doubled separator.
  assert.deepEqual(parseNumstat('1\t0\tsrc/{ => sub}/f.ts\n').get('src/sub/f.ts'), {
    added: 1,
    removed: 0,
  });
});

test('parseNumstat: a path containing a tab survives', () => {
  assert.deepEqual(parseNumstat('1\t0\tweird\tname.ts\n').get('weird\tname.ts'), {
    added: 1,
    removed: 0,
  });
});
