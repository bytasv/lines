import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addWorktree,
  autoBranchName,
  defaultWorktreePath,
  parseWorktreeList,
  removeWorktree,
  slugifyBranch,
  switchToNewBranch,
  titleBranchName,
  uniqueWorktreePath,
  WORKTREE_ROOT,
} from './worktrees.ts';

/** A runner that records every (cwd, argv) it is asked to run. */
function recorder(fail?: (args: string[]) => string | undefined) {
  const calls: { cwd: string; args: string[] }[] = [];
  const run = async (cwd: string, args: string[]) => {
    calls.push({ cwd, args });
    const message = fail?.(args);
    if (message) throw new Error(message);
    return '';
  };
  return { run, calls, argv: () => calls.map((c) => c.args) };
}

const PORCELAIN = `worktree /repo
HEAD aaaa
branch refs/heads/main

worktree /repo-worktrees/feature-x
HEAD bbbb
branch refs/heads/feature/x
locked

worktree /repo-worktrees/loose
HEAD cccc
detached
prunable gitdir file points to non-existent location

worktree /mirror
bare
`;

test('parseWorktreeList drops the main checkout and any bare entry', () => {
  const entries = parseWorktreeList(PORCELAIN);
  assert.deepEqual(
    entries.map((e) => e.path),
    ['/repo-worktrees/feature-x', '/repo-worktrees/loose'],
  );
});

test('a branch is reported short, and a detached work tree has none at all', () => {
  const [feature, loose] = parseWorktreeList(PORCELAIN);
  assert.equal(feature.branch, 'feature/x');
  // Absent rather than 'HEAD' or '': the UI shows "detached" off exactly this.
  assert.equal('branch' in loose, false);
});

test('a trailing newline does not invent an empty entry', () => {
  assert.equal(parseWorktreeList(`${PORCELAIN}\n\n`).length, 2);
  assert.deepEqual(parseWorktreeList(''), []);
});

test('a branch name becomes one path segment, never a nested directory', () => {
  assert.equal(slugifyBranch('feature/Foo Bar'), 'feature-foo-bar');
  assert.equal(slugifyBranch('///'), 'worktree');
});

test('the default work-tree path is app state, grouped by repo, never inside the checkout', () => {
  const target = defaultWorktreePath('/home/me/lines', 'feature/x', '/managed');
  assert.equal(target, '/managed/lines/feature-x');
  // The invariant that keeps /tree, @mention and /find from double-listing files.
  assert.equal(target.startsWith('/home/me/lines/'), false);
});

test('two repos of the same name share a directory, which the uniquifier then settles', () => {
  assert.equal(
    defaultWorktreePath('/a/lines', 'x', '/managed'),
    defaultWorktreePath('/b/lines', 'x', '/managed'),
  );
});

test('the real default lands under the app root, not next to the user’s checkout', () => {
  const target = defaultWorktreePath('/home/me/lines', 'x');
  assert.ok(target.startsWith(WORKTREE_ROOT + '/'), target);
  assert.equal(target.endsWith('/lines/x'), true);
});

test('a taken path is suffixed -2, then -3', () => {
  const taken = new Set(['/wt/x']);
  const second = uniqueWorktreePath('/wt/x', (p) => taken.has(p));
  assert.equal(second, '/wt/x-2');
  taken.add(second);
  assert.equal(uniqueWorktreePath('/wt/x', (p) => taken.has(p)), '/wt/x-3');
});

test('every branch Lines mints is namespaced, so its origin is obvious in git branch', () => {
  assert.match(autoBranchName(1_700_000_000_000), /^lines\/wt-[a-z0-9]+$/);
  assert.equal(titleBranchName('Fix auth token expiry'), 'lines/fix-auth-token-expiry');
  // A title that slugifies to nothing still yields a legal, namespaced branch.
  assert.equal(titleBranchName('???'), 'lines/worktree');
});

test('addWorktree runs in the repo with the branch flag and no base ref', async () => {
  const r = recorder();
  await addWorktree({ repo: '/repo', path: '/wt/x', branch: 'feature/x' }, r.run);
  assert.deepEqual(r.argv(), [['worktree', 'add', '-b', 'feature/x', '/wt/x']]);
  assert.equal(r.calls[0].cwd, '/repo');
});

test('a base ref is passed last, and only when one was given', async () => {
  const r = recorder();
  await addWorktree({ repo: '/repo', path: '/wt/x', branch: 'b', baseRef: 'origin/main' }, r.run);
  assert.deepEqual(r.argv(), [['worktree', 'add', '-b', 'b', '/wt/x', 'origin/main']]);
});

test('an unnamed branch means --detach, so the checkout exists before the name does', async () => {
  const r = recorder();
  await addWorktree({ repo: '/repo', path: '/wt/x' }, r.run);
  assert.deepEqual(r.argv(), [['worktree', 'add', '--detach', '/wt/x']]);
});

test('the branch is cut inside the work tree, never in the repo', async () => {
  const r = recorder();
  await switchToNewBranch('/wt/x', 'fix-auth', r.run);
  assert.deepEqual(r.argv(), [['switch', '-c', 'fix-auth']]);
  // In the repo this would move the *main* checkout onto the new branch.
  assert.equal(r.calls[0].cwd, '/wt/x');
});

test("a failed add prunes the half-written registration and rethrows git's stderr", async () => {
  const r = recorder((args) => (args[1] === 'add' ? "fatal: '/wt/x' already exists" : undefined));
  await assert.rejects(
    () => addWorktree({ repo: '/repo', path: '/wt/x', branch: 'b' }, r.run),
    // The whole point of runGit: a mutating call must not inherit git()'s swallow.
    /already exists/,
  );
  assert.deepEqual(r.argv()[1], ['worktree', 'prune']);
});

test('removeWorktree deletes the branch only after the removal succeeded', async () => {
  const r = recorder();
  await removeWorktree({ repo: '/repo', path: '/wt/x', branch: 'b', deleteBranch: true }, r.run);
  assert.deepEqual(r.argv(), [
    ['worktree', 'remove', '/wt/x'],
    ['branch', '-d', 'b'],
  ]);
});

test('--force is passed only when asked, and the branch is left alone when it is not', async () => {
  const r = recorder();
  await removeWorktree({ repo: '/repo', path: '/wt/x', branch: 'b', force: true }, r.run);
  assert.deepEqual(r.argv(), [['worktree', 'remove', '--force', '/wt/x']]);
});

test('a refused removal never reaches the branch — it is still checked out there', async () => {
  const r = recorder((args) =>
    args[0] === 'worktree' ? "fatal: '/wt/x' contains modified or untracked files" : undefined,
  );
  await assert.rejects(
    () => removeWorktree({ repo: '/repo', path: '/wt/x', branch: 'b', deleteBranch: true }, r.run),
    /modified or untracked/,
  );
  assert.equal(r.calls.length, 1);
});

test('branch deletion is never forced: -D must not appear in any argv', async () => {
  const r = recorder();
  await removeWorktree(
    { repo: '/repo', path: '/wt/x', branch: 'b', deleteBranch: true, force: true },
    r.run,
  );
  assert.equal(
    r.argv().flat().includes('-D'),
    false,
    'an unmerged branch has to surface git’s refusal instead',
  );
});
