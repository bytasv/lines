import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SessionMeta } from '@lines/shared';
import type { UserContext } from './userContext.ts';
import { resolveWorkspacePath, workspaceRoots } from './workspacePaths.ts';

const cwd = '/Users/x/Projects/lines';
const home = os.homedir();

/** Only the two members workspaceRoots/resolveWorkspacePath read. */
function ctxWith(sessionCwds: string[], projectRoot?: string): UserContext {
  return {
    // projectRoots reads `path` (+ optional extraRoots).
    store: { loadProjects: () => (projectRoot ? [{ path: projectRoot }] : []) },
    sessions: { list: () => sessionCwds.map((c) => ({ cwd: c }) as SessionMeta) },
  } as unknown as UserContext;
}

test('workspaceRoots covers project roots and session cwds', () => {
  assert.deepEqual(workspaceRoots(ctxWith(['/tmp/session'], cwd)), [cwd, '/tmp/session']);
});

test('a file inside a session cwd resolves', () => {
  const ctx = ctxWith([cwd]);
  assert.equal(resolveWorkspacePath(ctx, `${cwd}/server/src/index.ts`), `${cwd}/server/src/index.ts`);
  assert.equal(resolveWorkspacePath(ctx, cwd), cwd);
});

test('a home-plans path resolves even with no matching root', () => {
  const plan = path.join(home, '.claude', 'plans', 'my-plan.md');
  // No sessions at all: ~/.claude/plans is cwd-independent, so the card can still read it.
  assert.equal(resolveWorkspacePath(ctxWith([]), plan), plan);
  // Also via the `~` shorthand the route accepts.
  assert.equal(resolveWorkspacePath(ctxWith([]), '~/.claude/plans/my-plan.md'), plan);
});

test("a session's project-local plans directory resolves", () => {
  const plan = path.join(cwd, '.claude', 'plans', 'my-plan.md');
  // Reachable through the root check too; assert it against a ctx with a *different*
  // session cwd so only the plan-path exception can allow it.
  assert.equal(resolveWorkspacePath(ctxWith([cwd]), plan), plan);
  assert.equal(resolveWorkspacePath(ctxWith(['/tmp/other']), plan), null);
});

test('an out-of-root path is still rejected', () => {
  const ctx = ctxWith([cwd]);
  assert.equal(resolveWorkspacePath(ctx, '/etc/passwd'), null);
  assert.equal(resolveWorkspacePath(ctx, path.join(home, '.ssh', 'id_rsa')), null);
  assert.equal(resolveWorkspacePath(ctx, ''), null);
  // A sibling directory whose name merely prefixes a root must not pass.
  assert.equal(resolveWorkspacePath(ctx, `${cwd}-other/secret.md`), null);
});

test('traversal out of a plans directory is rejected', () => {
  const ctx = ctxWith([cwd]);
  assert.equal(resolveWorkspacePath(ctx, `${home}/.claude/plans/../../.ssh/id_rsa`), null);
  assert.equal(resolveWorkspacePath(ctx, '~/.claude/plans/../../.ssh/id_rsa'), null);
  assert.equal(resolveWorkspacePath(ctx, '/tmp/x/.claude/plans/../../../../etc/hosts'), null);
});
