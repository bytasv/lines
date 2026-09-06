import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileChange } from '@lines/shared';
import { renderChanged, type ChangedRepo } from './workflows.ts';

/**
 * Pure tests for the `{changed}` renderer — no git repo needed, same style as
 * git.sessionDiff.test.ts. `renderChanged` is what makes "the commit step cannot
 * miss a changed file" a property of the engine: it never collapses to '', unlike
 * a truncated {diff}.
 */

const file = (rel: string, status: FileChange['status']): FileChange => ({
  rel,
  status,
  added: 1,
  removed: 0,
});

const repo = (over: Partial<ChangedRepo> = {}): ChangedRepo => ({
  repo: '/repo',
  branch: 'main',
  baseline: 'workflow',
  files: [],
  untrackedOmitted: 0,
  ...over,
});

test('no commit units at all reads as the explicit sentence, not empty', () => {
  assert.equal(renderChanged([]), 'No files changed since this workflow run started.');
});

test('a single repo with no changes still reads as the explicit sentence', () => {
  const out = renderChanged([repo()]);
  assert.equal(out, 'No files changed since this workflow run started.');
});

test('a single repo emits no `# repo:` header', () => {
  const out = renderChanged([repo({ files: [file('src/a.ts', 'M')] })]);
  assert.doesNotMatch(out, /# repo:/);
  assert.match(out, /^M src\/a\.ts$/m);
  assert.match(out, /1 file changed since this workflow run started\./);
});

test('two repos each get their own `# repo:` section', () => {
  const out = renderChanged([
    repo({ repo: '/repo-a', files: [file('a.ts', 'A')] }),
    repo({ repo: '/repo-b', branch: 'feat', files: [file('b.ts', 'D')] }),
  ]);
  assert.match(out, /# repo: \/repo-a \(main\)/);
  assert.match(out, /# repo: \/repo-b \(feat\)/);
  assert.match(out, /^A a\.ts$/m);
  assert.match(out, /^D b\.ts$/m);
});

test('A/M/D statuses render as the raw git status column', () => {
  const out = renderChanged([
    repo({ files: [file('new.ts', 'A'), file('edit.ts', 'M'), file('gone.ts', 'D')] }),
  ]);
  assert.match(out, /^A new\.ts$/m);
  assert.match(out, /^M edit\.ts$/m);
  assert.match(out, /^D gone\.ts$/m);
  assert.match(out, /3 files changed since this workflow run started\./);
});

test('a non-zero untrackedOmitted produces a loud incomplete-list line', () => {
  const out = renderChanged([repo({ files: [file('a.ts', 'A')], untrackedOmitted: 3 })]);
  assert.match(out, /WARNING:.*3 further new files are present.*INCOMPLETE/);
});

test('a synthetic or stale baseline produces the no-recorded-baseline line', () => {
  const synthetic = renderChanged([repo({ baseline: 'synthetic', files: [file('a.ts', 'A')] })]);
  assert.match(synthetic, /WARNING: no baseline was recorded/);
  const stale = renderChanged([repo({ baseline: 'stale', files: [file('a.ts', 'A')] })]);
  assert.match(stale, /WARNING: no baseline was recorded/);
});

test('a session or workflow baseline with files present emits no baseline warning', () => {
  const out = renderChanged([repo({ baseline: 'session', files: [file('a.ts', 'A')] })]);
  assert.doesNotMatch(out, /WARNING: no baseline/);
});
