/**
 * The shared work-tree helpers, pinned from here because `shared/` has no test
 * runner of its own and `server` imports `@lines/shared` — the same arrangement
 * index.planFile.test.ts uses.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '@lines/shared';
import {
  findProject,
  findWorktree,
  projectPaths,
  projectRoots,
  rootsForCwd,
  worktreePaths,
} from '@lines/shared';

const WT = '/repo-worktrees/feature-x';
const projects: Project[] = [
  {
    path: '/repo',
    extraRoots: ['/docs'],
    worktrees: [{ path: WT, branch: 'feature/x', createdByLines: true }],
  },
];

test('a work-tree session is confined to its own checkout', () => {
  // The whole design rests on this: inheriting the parent's roots would let the
  // agent write in the parent checkout and undo the isolation.
  assert.deepEqual(rootsForCwd(projects, WT), [WT]);
});

test('projectRoots is unchanged by worktrees — the invariant the guard depends on', () => {
  // workspaceRoots, assessToolCall and additionalDirectories all read this. A
  // "simplification" that folded worktrees in here would silently widen all three.
  assert.deepEqual(projectRoots(projects[0]), ['/repo', '/docs']);
  assert.deepEqual(worktreePaths(projects[0]), [WT]);
});

test('attribution and capability are separate lookups over the same record', () => {
  assert.equal(findProject(projects, WT), null);
  const hit = findWorktree(projects, WT);
  assert.equal(hit?.project.path, '/repo');
  assert.equal(hit?.worktree.branch, 'feature/x');
});

test('projectPaths is roots first, then work trees', () => {
  assert.deepEqual(projectPaths(projects[0]), ['/repo', '/docs', WT]);
});

test('a project with no worktrees behaves exactly as before', () => {
  const plain: Project[] = [{ path: '/repo' }];
  assert.deepEqual(projectPaths(plain[0]), ['/repo']);
  assert.deepEqual(worktreePaths(plain[0]), []);
  assert.equal(findWorktree(plain, '/repo'), null);
  assert.deepEqual(rootsForCwd(plain, '/repo'), ['/repo']);
  // Never empty: an empty root list makes the guard escalate every file call.
  assert.deepEqual(rootsForCwd(plain, '/elsewhere'), ['/elsewhere']);
});
