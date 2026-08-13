import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Project, ServerMessage, SessionMeta } from '@lines/shared';
import type { ProjectKeyRegistry } from './projectKeys.ts';
import type { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { UserContext } from './userContext.ts';
import * as commands from './worktreeCommands.ts';
import { WORKTREE_ROOT } from './worktrees.ts';

const REPO = '/repo';

const meta = (id: string, cwd: string, archived?: true): SessionMeta =>
  ({ id, name: id, cwd, status: 'idle', createdAt: 1, ...(archived ? { archived } : {}) }) as SessionMeta;

/**
 * A real store over a throwaway root, with the two impure seams faked: git is a
 * call recorder and `repoRoot` always answers REPO. Nothing here needs a repo, so
 * every assertion is about validation, records, keys and broadcasts.
 */
function harness(projects: Project[], sessions: SessionMeta[] = [], gitFail?: (args: string[]) => string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-wt-'));
  const store = createStore(root);
  store.saveProjects(projects);
  const broadcasts: ServerMessage[] = [];
  const learned: string[] = [];
  const calls: string[][] = [];
  const ctx = {
    store,
    sessions: { list: () => sessions } as unknown as SessionManager,
    projectKeys: {
      learn: (cwd: string) => {
        learned.push(cwd);
        return null;
      },
    } as unknown as ProjectKeyRegistry,
    broadcast: (msg: ServerMessage) => broadcasts.push(msg),
  } as unknown as UserContext;
  const parents: string[] = [];
  const deps = {
    repoRoot: async () => REPO,
    // Recorded, never created: a unit test must not write into ~/.lines-app.
    ensureParent: (dir: string) => parents.push(dir),
    run: async (_cwd: string, args: string[]) => {
      calls.push(args);
      const message = gitFail?.(args);
      if (message) throw new Error(message);
      return '';
    },
  };
  return {
    root,
    store,
    ctx,
    deps,
    broadcasts,
    learned,
    calls,
    parents,
    projects: () => store.loadProjects(),
    only: () => store.loadProjects()[0],
  };
}

const createMsg = (over: Partial<{ project: string; branch: string; path: string }> = {}) =>
  ({ type: 'createWorktree' as const, project: '/p', branch: 'feature/x', ...over });

test('a created work tree is persisted, keyed and broadcast exactly once', async () => {
  const h = harness([{ path: '/p' }]);

  const info = await commands.createWorktree(h.ctx, createMsg({ path: '/wt/x' }), h.deps);

  assert.equal(info.path, '/wt/x');
  assert.equal(info.createdByLines, true);
  assert.deepEqual(h.only().worktrees?.map((w) => w.path), ['/wt/x']);
  // Resolves to the *parent's* key, which is what makes the session group into
  // this tab rather than a new one.
  assert.deepEqual(h.learned, ['/wt/x']);
  assert.equal(h.broadcasts.filter((m) => m.type === 'projects').length, 1);
  assert.deepEqual(h.calls, [['worktree', 'add', '-b', 'feature/x', '/wt/x']]);
});

/** Offering it there would invite opening it as its own tab, which double-counts
 *  every session in it — the work tree resolves to the parent's project key. */
test('a work tree is never added to the recent-directory list', async () => {
  const h = harness([{ path: '/p' }]);
  await commands.createWorktree(h.ctx, createMsg({ path: '/wt/x' }), h.deps);
  assert.deepEqual(h.store.loadRecentDirs(), []);
});

test('an untouched path field takes the managed default off the real repo root', async () => {
  const h = harness([{ path: '/p' }]);
  const info = await commands.createWorktree(h.ctx, createMsg(), h.deps);
  // REPO is '/repo', so the repo-name level is 'repo' and the leaf is the slug.
  assert.equal(info.path, path.join(WORKTREE_ROOT, 'repo', 'feature-x'));
});

test('a path another project already owns is refused, root or work tree alike', async () => {
  const h = harness([{ path: '/p' }, { path: '/other', extraRoots: ['/shared'] }]);

  await assert.rejects(
    () => commands.createWorktree(h.ctx, createMsg({ path: '/shared' }), h.deps),
    /Already a folder of \/other/,
  );
  const withTree = harness([
    { path: '/p' },
    { path: '/other', worktrees: [{ path: '/wt/taken' }] },
  ]);
  await assert.rejects(
    () => commands.createWorktree(withTree.ctx, createMsg({ path: '/wt/taken' }), withTree.deps),
    /Already a folder of \/other/,
  );
  assert.deepEqual(h.calls, [], 'git is never touched by a refused create');
});

test('a path nested in a root of this project is refused', async () => {
  const h = harness([{ path: '/p', extraRoots: ['/p-extra'] }]);
  await assert.rejects(
    () => commands.createWorktree(h.ctx, createMsg({ path: '/p-extra/inside' }), h.deps),
    /Overlaps an existing folder: \/p-extra/,
  );
});

test('a project that is not open, and a directory that is not a repo, both refuse', async () => {
  const h = harness([{ path: '/p' }]);
  await assert.rejects(
    () => commands.createWorktree(h.ctx, createMsg({ project: '/closed' }), h.deps),
    /Not an open project: \/closed/,
  );
  await assert.rejects(
    () => commands.createWorktree(h.ctx, createMsg(), { ...h.deps, repoRoot: async () => null }),
    /Not a git repository: \/p/,
  );
});

test('the auto path for a new session uniquifies instead of failing, and the branch follows it', async () => {
  const taken = path.join(WORKTREE_ROOT, 'repo', 'lines-wt-1');
  const h = harness([{ path: '/p', worktrees: [{ path: taken }] }]);

  const info = await commands.worktreeForNewSession(h.ctx, '/p', { branch: 'lines/wt-1' }, h.deps);

  assert.equal(info.path, `${taken}-2`);
  assert.equal(info.branch, 'lines/wt-1-2');
});

test('a per-session work tree starts detached — there is no prompt to name a branch after', async () => {
  const h = harness([{ path: '/p' }]);

  const info = await commands.worktreeForNewSession(h.ctx, '/p', {}, h.deps);

  assert.equal(info.branch, undefined);
  assert.equal('branch' in info, false, 'absent, not undefined — the record is persisted');
  assert.equal(h.calls[0][2], '--detach');
  assert.equal(h.calls[0].includes('-b'), false);
});

test('the title becomes the branch, cut inside the work tree so nothing is renamed', async () => {
  const h = harness([{ path: '/p', worktrees: [{ path: '/wt/x', createdByLines: true }] }]);

  await commands.nameWorktreeBranch(h.ctx, '/wt/x', 'Fix auth token expiry', h.deps);

  // Namespaced, so `git branch` says who made it.
  assert.deepEqual(h.calls, [['switch', '-c', 'lines/fix-auth-token-expiry']]);
  assert.equal(h.only().worktrees?.[0].branch, 'lines/fix-auth-token-expiry');
  assert.equal(h.broadcasts.filter((m) => m.type === 'projects').length, 1);
});

test('a taken branch name is stepped past, and the reserved id is the last resort', async () => {
  const h = harness(
    [{ path: '/p', worktrees: [{ path: '/wt/lines-wt-1', createdByLines: true }] }],
    [],
    (args) => (args[2] === 'lines/lines-wt-1' ? '' : "fatal: a branch named 'x' already exists"),
  );

  await commands.nameWorktreeBranch(h.ctx, '/wt/lines-wt-1', 'Fix auth', h.deps);

  assert.deepEqual(
    h.calls.map((c) => c[2]),
    ['lines/fix-auth', 'lines/fix-auth-2', 'lines/fix-auth-3', 'lines/lines-wt-1'],
  );
  assert.equal(h.only().worktrees?.[0].branch, 'lines/lines-wt-1');
});

/** Detached forever is worse than an ugly name, so a failed titler still names it. */
test('an empty title falls straight through to the reserved id', async () => {
  const h = harness([{ path: '/p', worktrees: [{ path: '/wt/lines-wt-9', createdByLines: true }] }]);

  await commands.nameWorktreeBranch(h.ctx, '/wt/lines-wt-9', '   ', h.deps);

  assert.deepEqual(h.calls, [['switch', '-c', 'lines/lines-wt-9']]);
});

test('a work tree that already has a branch is never re-cut', async () => {
  const h = harness([{ path: '/p', worktrees: [{ path: '/wt/x', branch: 'mine' }] }]);
  await commands.nameWorktreeBranch(h.ctx, '/wt/x', 'Some title', h.deps);
  assert.deepEqual(h.calls, []);
  assert.equal(h.only().worktrees?.[0].branch, 'mine');
});

test('a work tree git refuses to branch stays detached rather than half-recorded', async () => {
  const h = harness(
    [{ path: '/p', worktrees: [{ path: '/wt/x', createdByLines: true }] }],
    [],
    () => 'fatal: invalid reference',
  );

  await commands.nameWorktreeBranch(h.ctx, '/wt/x', 'Fix auth', h.deps);

  assert.equal(h.only().worktrees?.[0].branch, undefined);
  assert.equal(h.broadcasts.filter((m) => m.type === 'projects').length, 0);
});

/** An agent's own `git worktree add --detach` is its business, not ours to branch. */
test('an adopted work tree is left detached', async () => {
  const h = harness([{ path: '/p', worktrees: [{ path: '/wt/x' }] }]);
  await commands.nameWorktreeBranch(h.ctx, '/wt/x', 'Fix auth', h.deps);
  assert.deepEqual(h.calls, []);
});

test('attachSession names the session a work tree was cut for', () => {
  const h = harness([{ path: '/p', worktrees: [{ path: '/wt/x', createdByLines: true }] }]);
  commands.attachSession(h.ctx, '/wt/x', 's1');
  assert.equal(h.only().worktrees?.[0].sessionId, 's1');
});

test('removing a work tree drops the record, broadcasts, and keeps the learned key', async () => {
  const h = harness([{ path: '/p', worktrees: [{ path: '/wt/x', branch: 'b', createdByLines: true }] }]);

  await commands.removeWorktree(h.ctx, { type: 'removeWorktree', project: '/p', path: '/wt/x' }, h.deps);

  assert.equal('worktrees' in h.only(), false, 'the key is omitted once the last record goes');
  assert.equal(h.broadcasts.filter((m) => m.type === 'projects').length, 1);
  assert.deepEqual(h.calls, [['worktree', 'remove', '/wt/x']]);
  assert.deepEqual(h.learned, [], 'no key is forgotten — the registry never unlearns a path');
});

test('the branch goes only when asked, and never for a work tree Lines merely adopted', async () => {
  const mine = harness([{ path: '/p', worktrees: [{ path: '/wt/x', branch: 'b', createdByLines: true }] }]);
  await commands.removeWorktree(
    mine.ctx,
    { type: 'removeWorktree', project: '/p', path: '/wt/x', deleteBranch: true },
    mine.deps,
  );
  assert.deepEqual(mine.calls, [['worktree', 'remove', '/wt/x'], ['branch', '-d', 'b']]);

  const adopted = harness([{ path: '/p', worktrees: [{ path: '/wt/x', branch: 'b' }] }]);
  await commands.removeWorktree(
    adopted.ctx,
    { type: 'removeWorktree', project: '/p', path: '/wt/x', deleteBranch: true },
    adopted.deps,
  );
  assert.deepEqual(adopted.calls, [['worktree', 'remove', '/wt/x']]);
});

test('removal is refused while a live session runs inside, and the message names the count', async () => {
  const h = harness(
    [{ path: '/p', worktrees: [{ path: '/wt/x' }] }],
    [meta('s1', '/wt/x'), meta('s2', path.join('/wt/x', 'sub')), meta('s3', '/wt/x', true)],
  );

  await assert.rejects(
    () => commands.removeWorktree(h.ctx, { type: 'removeWorktree', project: '/p', path: '/wt/x' }, h.deps),
    // The archived one doesn't count: it can't be prompted, so it can't spawn.
    /2 sessions still run in this worktree/,
  );
  assert.deepEqual(h.calls, [], 'nothing is destroyed before the refusal');
  assert.deepEqual(h.only().worktrees?.length, 1);
});

test('force overrides the live-session refusal', async () => {
  const h = harness([{ path: '/p', worktrees: [{ path: '/wt/x' }] }], [meta('s1', '/wt/x')]);
  await commands.removeWorktree(
    h.ctx,
    { type: 'removeWorktree', project: '/p', path: '/wt/x', force: true },
    h.deps,
  );
  assert.deepEqual(h.calls, [['worktree', 'remove', '--force', '/wt/x']]);
});

test('removing an unknown record is idempotent rather than an error', async () => {
  const h = harness([{ path: '/p' }]);
  await commands.removeWorktree(h.ctx, { type: 'removeWorktree', project: '/p', path: '/wt/gone' }, h.deps);
  assert.equal(h.broadcasts.filter((m) => m.type === 'projects').length, 1);
  assert.deepEqual(h.calls, []);
});

test("git's refusal reaches the caller verbatim and the record survives it", async () => {
  const h = harness(
    [{ path: '/p', worktrees: [{ path: '/wt/x', branch: 'b', createdByLines: true }] }],
    [],
    (args) => (args[0] === 'worktree' ? 'fatal: contains modified or untracked files' : ''),
  );

  await assert.rejects(
    () => commands.removeWorktree(h.ctx, { type: 'removeWorktree', project: '/p', path: '/wt/x' }, h.deps),
    /modified or untracked/,
  );
  assert.equal(h.only().worktrees?.length, 1, 'a refused removal changes nothing');
});

test('reconcile prunes a record git no longer knows and adopts one it does', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-wt-live-'));
  const h = harness([{ path: '/p', worktrees: [{ path: '/wt/gone', createdByLines: true }] }]);
  const listing = `worktree ${REPO}\nbranch refs/heads/main\n\nworktree ${dir}\nbranch refs/heads/adopted\n`;

  await commands.reconcileWorktrees(h.ctx, '/p', {
    ...h.deps,
    run: async () => listing,
  });

  assert.deepEqual(h.only().worktrees, [{ path: dir, branch: 'adopted' }]);
  // No createdByLines: removal must never offer to delete a branch Lines didn't create.
  assert.equal(h.only().worktrees?.[0].createdByLines, undefined);
  assert.equal(h.broadcasts.filter((m) => m.type === 'projects').length, 1);
});

test('reconcile leaves the cache alone when git itself fails', async () => {
  const h = harness([{ path: '/p', worktrees: [{ path: '/wt/x' }] }]);
  await commands.reconcileWorktrees(h.ctx, '/p', {
    ...h.deps,
    run: async () => {
      throw new Error('git: command not found');
    },
  });
  assert.deepEqual(h.only().worktrees?.map((w) => w.path), ['/wt/x']);
  assert.deepEqual(h.broadcasts, []);
});
