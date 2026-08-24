import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { SessionMeta, SocketAccess } from '@lines/shared';
import { OWNER_ACCESS, capsForPreset } from '@lines/shared';
import { handleFileRequest } from './fileRoutes.ts';
import type { UserContext } from './userContext.ts';
import { resolveWorkspacePath, workspaceRoots } from './workspacePaths.ts';

/**
 * What a guest may read off the host's disk.
 *
 * A guest with `readFiles` is reading someone else's computer, so the clamp is
 * the whole of the protection: the host's other repos, their other sessions'
 * checkouts, and their `~/.claude/plans` are all one path parameter away.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-guest-'));
/** Two separate checkouts, each with a session in it. */
const shared = path.join(tmp, 'shared-repo');
const private_ = path.join(tmp, 'private-repo');
fs.mkdirSync(shared, { recursive: true });
fs.mkdirSync(private_, { recursive: true });
fs.writeFileSync(path.join(shared, 'ok.txt'), 'readable');
fs.writeFileSync(path.join(private_, 'secret.txt'), 'not for the guest');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const session = (id: string, cwd: string): SessionMeta => ({ id, cwd }) as SessionMeta;

/** Only the members the clamp and the file routes read. */
const ctx = () =>
  ({
    store: {
      // Both checkouts are open projects of the host's.
      loadProjects: () => [{ path: shared }, { path: private_ }],
      attachmentsRoot: path.join(tmp, 'attachments'),
    },
    sessions: {
      list: () => [session('s-shared', shared), session('s-private', private_)],
    },
  }) as unknown as UserContext;

/** A guest holding exactly the `s-shared` session, at Collaborator. */
const sessionGuest: SocketAccess = {
  scope: 'session',
  caps: capsForPreset('collaborator', 'session'),
  sessionIds: ['s-shared'],
};

const machineGuest: SocketAccess = {
  scope: 'machine',
  caps: capsForPreset('collaborator', 'machine'),
};

describe('guest file scope', () => {
  test('the owner still reaches every project root', () => {
    assert.deepEqual(workspaceRoots(ctx()), [shared, private_, shared, private_]);
    assert.equal(resolveWorkspacePath(ctx(), path.join(private_, 'secret.txt')), path.join(private_, 'secret.txt'));
  });

  test('a session guest is clamped to that session’s checkout', () => {
    assert.deepEqual(workspaceRoots(ctx(), sessionGuest), [shared]);
    assert.equal(
      resolveWorkspacePath(ctx(), path.join(shared, 'ok.txt'), sessionGuest),
      path.join(shared, 'ok.txt'),
    );
    // The host's other repo is one path parameter away, and must not resolve.
    assert.equal(resolveWorkspacePath(ctx(), path.join(private_, 'secret.txt'), sessionGuest), null);
  });

  test('a machine guest reaches session checkouts but not the whole project list', () => {
    // Both sessions, because a machine grant covers them — but derived from the
    // sessions, not from `loadProjects`, so a project root with no session of the
    // guest's in it stays out.
    assert.deepEqual(workspaceRoots(ctx(), machineGuest), [shared, private_]);
  });

  test('a guest cannot read the host’s plans directory', () => {
    // The auto-approve exception for `~/.claude/plans` predates sharing: it
    // crossed OS users, and extending it across *people* is a different thing.
    const plan = path.join(os.homedir(), '.claude', 'plans', 'some-plan.md');
    assert.equal(resolveWorkspacePath(ctx(), plan), plan, 'still allowed for the owner');
    assert.equal(resolveWorkspacePath(ctx(), plan, sessionGuest), null);
    assert.equal(resolveWorkspacePath(ctx(), plan, machineGuest), null);
  });

  test('traversal out of the granted root is refused', () => {
    for (const attempt of [
      path.join(shared, '..', 'private-repo', 'secret.txt'),
      `${shared}-other/secret.txt`,
      '/etc/passwd',
      path.join(os.homedir(), '.ssh', 'id_rsa'),
      '',
    ]) {
      assert.equal(resolveWorkspacePath(ctx(), attempt, sessionGuest), null, `${attempt} must not resolve`);
    }
  });

  test('the file route enforces the clamp, not just the resolver', () => {
    const read = (p: string, access: SocketAccess) =>
      handleFileRequest(ctx(), 'file', { paths: [p] }, access);

    assert.equal(read(path.join(shared, 'ok.txt'), sessionGuest).status, 200);
    // 403, not 404: the path exists and is readable — it is simply not theirs.
    assert.equal(read(path.join(private_, 'secret.txt'), sessionGuest).status, 403);
    assert.equal(read(path.join(private_, 'secret.txt'), OWNER_ACCESS).status, 200);
  });

  test('find refuses a root outside the grant rather than searching the rest', () => {
    // A partial result would read as "no matches in that folder", quietly hiding
    // the refusal — so any out-of-scope root fails the whole request.
    const res = handleFileRequest(ctx(), 'find', { paths: [shared, private_], q: 'x' }, sessionGuest);
    assert.equal(res.status, 403);
  });

  test('the sync log is owner-only', () => {
    // It is the host's storage-link history, and a guest has no store here at all.
    assert.equal(handleFileRequest(ctx(), 'syncLog', {}, sessionGuest).status, 403);
    assert.equal(handleFileRequest(ctx(), 'syncLog', {}, machineGuest).status, 403);
  });
});
