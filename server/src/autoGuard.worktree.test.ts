import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessToolCall } from './autoGuard.ts';

const ROOTS = ['/repo'];
const verdict = (command: string, allowlist: { tool: string; prefix?: string }[] = []) =>
  assessToolCall('Bash', { command }, ROOTS, allowlist);

test('removing a work tree escalates, because its working files go with it', () => {
  const v = verdict('git worktree remove ../lines-worktrees/feature-x');
  assert.equal(v.dangerous, true);
  assert.match(v.reason ?? '', /deletes its working files/);
});

test('pruning work trees escalates for the same reason', () => {
  assert.equal(verdict('git worktree prune').dangerous, true);
});

test('deleting a branch escalates even in its safe -d form', () => {
  // -D was already covered; -d can still fail-and-lose in the merged case, and it
  // is the exact command the removal checkbox runs.
  const v = verdict('git branch -d feature/x');
  assert.equal(v.dangerous, true);
  assert.equal(v.reason, 'Deleting a branch');
  assert.equal(verdict('git branch --delete feature/x').dangerous, true);
});

test('creating and listing work trees stay auto-approved', () => {
  // add is creative, and flagging it would be inconsistent with `mkdir` outside the
  // roots already being allowed.
  assert.equal(verdict('git worktree add -b feature/x ../wt/feature-x').dangerous, false);
  assert.equal(verdict('git worktree list --porcelain').dangerous, false);
  assert.equal(verdict('git branch -a').dangerous, false);
});

test('a harmless first segment does not smuggle a removal past the rules', () => {
  const v = verdict('git status && git worktree remove ../wt/x');
  assert.equal(v.dangerous, true);
});

test('an allowlist entry still wins over the new rules', () => {
  // `git worktree` doesn't name the dangerous part, so it extends to removal…
  assert.equal(verdict('git worktree remove ../wt/x', [{ tool: 'Bash', prefix: 'git worktree' }]).dangerous, false);
  // …while a prefix the rule itself names covers only that exact command, never
  // every worktree it could be pointed at.
  const exact = [{ tool: 'Bash', prefix: 'git worktree remove ../wt/x' }];
  assert.equal(verdict('git worktree remove ../wt/x', exact).dangerous, false);
  assert.equal(verdict('git worktree remove ../wt/y', [{ tool: 'Bash', prefix: 'git worktree remove' }]).dangerous, true);
});
