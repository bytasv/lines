import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type {
  FileRequestKind,
  FileRequestParams,
  InlineStep,
  SessionMeta,
  SocketAccess,
  StepDef,
  WorkflowDef,
} from '@lines/shared';
import { OWNER_ACCESS, capsForPreset } from '@lines/shared';
import { handleFileRequest } from './fileRoutes.ts';
import {
  clampPermissionMode,
  guestCwdAllowed,
  guestLibrary,
  permissionAnswerFor,
  prepareInlineWorkflow,
} from './guestWorkflows.ts';
import { jwtSubject, tokenFitsContext, tokenRefreshAction } from './connectionPolicy.ts';
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

  test('the file route enforces the clamp, not just the resolver', async () => {
    const read = (p: string, access: SocketAccess) =>
      handleFileRequest(ctx(), 'file', { paths: [p] }, access);

    assert.equal((await read(path.join(shared, 'ok.txt'), sessionGuest)).status, 200);
    // 403, not 404: the path exists and is readable — it is simply not theirs.
    assert.equal((await read(path.join(private_, 'secret.txt'), sessionGuest)).status, 403);
    assert.equal((await read(path.join(private_, 'secret.txt'), OWNER_ACCESS)).status, 200);
  });

  test('find refuses a root outside the grant rather than searching the rest', async () => {
    // A partial result would read as "no matches in that folder", quietly hiding
    // the refusal — so any out-of-scope root fails the whole request.
    const res = await handleFileRequest(ctx(), 'find', { paths: [shared, private_], q: 'x' }, sessionGuest);
    assert.equal(res.status, 403);
  });

  test('the sync log is owner-only', async () => {
    // It is the host's storage-link history, and a guest has no store here at all.
    assert.equal((await handleFileRequest(ctx(), 'syncLog', {}, sessionGuest)).status, 403);
    assert.equal((await handleFileRequest(ctx(), 'syncLog', {}, machineGuest)).status, 403);
  });

  test('writing is owner-only, even at Full and inside the guest’s own root', async () => {
    const target = path.join(shared, 'ok.txt');
    const write = (access: SocketAccess) =>
      handleFileRequest(ctx(), 'writeFile', { paths: [target], content: 'guest was here' }, access);
    const fullSession: SocketAccess = { ...sessionGuest, caps: capsForPreset('full', 'session') };
    const fullMachineGuest: SocketAccess = { scope: 'machine', caps: capsForPreset('full', 'machine') };
    assert.equal((await write(fullSession)).status, 403);
    assert.equal((await write(fullMachineGuest)).status, 403);
    assert.equal(fs.readFileSync(target, 'utf8'), 'readable');
  });

  test('the owner’s reach beyond every root does not extend to a guest', async () => {
    // The owner may open, preview and save any path on the host; a guest's
    // single-file kinds stay inside their session cwds.
    const beyond = path.join(tmp, 'beyond');
    fs.mkdirSync(beyond, { recursive: true });
    fs.writeFileSync(path.join(beyond, 'out.md'), 'host only');
    fs.writeFileSync(path.join(beyond, 'shot.png'), 'png');
    fs.writeFileSync(path.join(private_, 'shot.png'), 'png');
    const kinds = (dir: string, file: string): [FileRequestKind, FileRequestParams][] => [
      ['file', { paths: [path.join(dir, file)] }],
      ['media', { paths: [path.join(dir, 'shot.png')] }],
      ['writeFile', { paths: [path.join(dir, file)], content: 'guest was here' }],
    ];

    for (const [kind, params] of kinds(beyond, 'out.md')) {
      assert.equal((await handleFileRequest(ctx(), kind, params, sessionGuest)).status, 403, `session ${kind}`);
      assert.equal((await handleFileRequest(ctx(), kind, params, machineGuest)).status, 403, `machine ${kind}`);
    }
    // The host's project, but not one of the session guest's sessions.
    for (const [kind, params] of kinds(private_, 'secret.txt')) {
      assert.equal((await handleFileRequest(ctx(), kind, params, sessionGuest)).status, 403, `session ${kind}`);
    }
    for (const attempt of ['/etc/hosts', path.join(os.homedir(), '.ssh', 'id_rsa'), '~/.ssh/id_rsa']) {
      assert.equal((await handleFileRequest(ctx(), 'file', { paths: [attempt] }, sessionGuest)).status, 403);
      assert.equal((await handleFileRequest(ctx(), 'file', { paths: [attempt] }, machineGuest)).status, 403);
    }
    assert.equal(fs.readFileSync(path.join(beyond, 'out.md'), 'utf8'), 'host only');
    assert.equal(fs.readFileSync(path.join(private_, 'secret.txt'), 'utf8'), 'not for the guest');

    assert.equal((await handleFileRequest(ctx(), 'file', { paths: [path.join(beyond, 'out.md')] }, OWNER_ACCESS)).status, 200);
  });
});

// ---------------------------------------------------------------------------
// Workflows on a shared machine
// ---------------------------------------------------------------------------

const step = (over: Partial<InlineStep> = {}): InlineStep => ({
  name: 'Plan',
  promptTemplate: 'Do {task}',
  model: 'claude-sonnet-5-5',
  permissionMode: 'default',
  autoAdvance: false,
  freshStart: false,
  ...over,
});

const hostWorkflow: WorkflowDef = { id: 'wf-host', name: 'Host flow', steps: [step()] };
const otherWorkflow: WorkflowDef = { id: 'wf-other', name: 'Other flow', steps: [step()] };
const sharedWorkflow: WorkflowDef = {
  id: 'wf-shared',
  name: 'Shared flow',
  steps: [{ kind: 'ref', stepId: 'st-1', ownerId: 'u-3', version: 2 }],
};
const pin = { id: 'st-1', ownerId: 'u-3', version: 2, ...step() } as StepDef;
const unrelatedPin = { id: 'st-9', ownerId: 'u-3', version: 1, ...step() } as StepDef;

/** Only the members guestLibrary, clampPermissionMode and prepareInlineWorkflow read. */
const libraryCtx = (newSessionMode?: string) =>
  ({
    store: {
      loadSettings: () =>
        newSessionMode ? { newSessionDefaults: { model: 'claude-sonnet-5-5', permissionMode: newSessionMode } } : null,
    },
    workflows: {
      list: () => [hostWorkflow, otherWorkflow],
      listShared: () => [sharedWorkflow],
      listSteps: () => [unrelatedPin],
      listSharedSteps: () => [pin, unrelatedPin],
      listPinnedSteps: () => [pin],
    },
  }) as unknown as UserContext;

const withWorkflow = (id: string, workflowId: string, def?: WorkflowDef): SessionMeta =>
  ({ id, cwd: shared, workflow: { workflowId, stepIndex: 0, stepStatuses: ['pending'], started: false, def } }) as SessionMeta;

const fullMachine: SocketAccess = { scope: 'machine', caps: capsForPreset('full', 'machine') };

describe('guest workflow library', () => {
  test('a machine guest who may create sessions gets the whole library', () => {
    const lib = guestLibrary(libraryCtx(), machineGuest, []);
    assert.deepEqual(lib.workflows.map((w) => w.id), ['wf-host', 'wf-other']);
    assert.deepEqual(lib.sharedWorkflows.map((w) => w.id), ['wf-shared']);
    assert.equal(lib.pinnedSteps.length, 1);
  });

  test('a session guest gets only the workflows its sessions run, and their pins', () => {
    const lib = guestLibrary(libraryCtx(), sessionGuest, [withWorkflow('s-shared', 'wf-shared')]);
    assert.deepEqual(lib.workflows, []);
    assert.deepEqual(lib.sharedWorkflows.map((w) => w.id), ['wf-shared']);
    assert.deepEqual(lib.sharedSteps.map((s) => s.id), ['st-1']);
    assert.deepEqual(lib.steps, []);
  });

  test('a session guest with no workflow sessions gets nothing', () => {
    const lib = guestLibrary(libraryCtx(), sessionGuest, [session('s-shared', shared)]);
    assert.deepEqual(lib, { workflows: [], sharedWorkflows: [], steps: [], sharedSteps: [], pinnedSteps: [] });
  });

  test('an inline snapshot needs no library row', () => {
    const lib = guestLibrary(libraryCtx(), sessionGuest, [withWorkflow('s-shared', 'wf-host', hostWorkflow)]);
    assert.deepEqual(lib.workflows, []);
  });

  test('a machine guest without createSessions is treated like a session guest', () => {
    const viewer: SocketAccess = { scope: 'machine', caps: capsForPreset('view', 'machine') };
    const lib = guestLibrary(libraryCtx(), viewer, [withWorkflow('s1', 'wf-host')]);
    assert.deepEqual(lib.workflows.map((w) => w.id), ['wf-host']);
  });
});

describe('guest permission mode at creation', () => {
  test('a guest without setPermissionMode gets the host’s new-session default', () => {
    assert.equal(clampPermissionMode(libraryCtx('plan'), machineGuest, 'bypassPermissions'), 'plan');
    assert.equal(clampPermissionMode(libraryCtx(), machineGuest, 'bypassPermissions'), 'default');
  });

  test('Full access and the owner pick their own', () => {
    assert.equal(clampPermissionMode(libraryCtx('plan'), fullMachine, 'bypassPermissions'), 'bypassPermissions');
    assert.equal(clampPermissionMode(libraryCtx('plan'), OWNER_ACCESS, 'acceptEdits'), 'acceptEdits');
  });
});

describe('a guest’s own workflow', () => {
  const own: WorkflowDef = { id: 'wf-mine', name: 'Mine', steps: [step({ permissionMode: 'bypassPermissions' })] };

  test('a ref step is refused: it would resolve against the host’s library', () => {
    const verdict = prepareInlineWorkflow(libraryCtx(), machineGuest, sharedWorkflow);
    assert.equal(verdict.ok, false);
  });

  test('it passes the editor’s validation, Claude-only steps included', () => {
    const openai: WorkflowDef = { ...own, steps: [step({ model: 'gpt-6-sol' })] };
    assert.equal(prepareInlineWorkflow(libraryCtx(), fullMachine, openai).ok, false);
    assert.equal(prepareInlineWorkflow(libraryCtx(), fullMachine, { ...own, steps: [] }).ok, false);
  });

  test('step permission modes are clamped without setPermissionMode', () => {
    const verdict = prepareInlineWorkflow(libraryCtx('plan'), machineGuest, own);
    assert.ok(verdict.ok);
    assert.equal((verdict.def.steps[0] as InlineStep).permissionMode, 'plan');
  });

  test('Full access keeps the step’s own mode', () => {
    const verdict = prepareInlineWorkflow(libraryCtx('plan'), fullMachine, own);
    assert.ok(verdict.ok);
    assert.equal((verdict.def.steps[0] as InlineStep).permissionMode, 'bypassPermissions');
  });

  test('a grant without manageWorkflow cannot run one', () => {
    const prompter: SocketAccess = { scope: 'machine', caps: { ...capsForPreset('prompt', 'machine'), createSessions: true } };
    assert.equal(prepareInlineWorkflow(libraryCtx(), prompter, own).ok, false);
  });
});

describe('what a guest’s permission answer may also write', () => {
  test('a guest’s Always allow and Allow as read are dropped: they are the host’s settings', () => {
    for (const guest of [sessionGuest, machineGuest, fullMachine]) {
      assert.deepEqual(permissionAnswerFor(guest, { alwaysAllow: true, allowAsRead: true }), {
        alwaysAllow: false,
        allowAsRead: false,
      });
    }
  });

  test('the owner’s pass through, and only when actually set', () => {
    assert.deepEqual(permissionAnswerFor(OWNER_ACCESS, { alwaysAllow: true, allowAsRead: true }), {
      alwaysAllow: true,
      allowAsRead: true,
    });
    assert.deepEqual(permissionAnswerFor(OWNER_ACCESS, {}), { alwaysAllow: false, allowAsRead: false });
  });
});

describe('where a guest may start a session', () => {
  test('inside one of the host’s open projects, at any depth', () => {
    assert.equal(guestCwdAllowed(ctx(), fullMachine, shared), true);
    assert.equal(guestCwdAllowed(ctx(), fullMachine, path.join(shared, 'not', 'yet', 'there')), true);
  });

  test('not the host’s home, the filesystem root, or a sibling of a project', () => {
    assert.equal(guestCwdAllowed(ctx(), fullMachine, os.homedir()), false);
    assert.equal(guestCwdAllowed(ctx(), fullMachine, '/'), false);
    assert.equal(guestCwdAllowed(ctx(), fullMachine, tmp), false);
    assert.equal(guestCwdAllowed(ctx(), fullMachine, `${shared}-evil`), false);
    assert.equal(guestCwdAllowed(ctx(), fullMachine, path.join(shared, '..', 'elsewhere')), false);
    assert.equal(guestCwdAllowed(ctx(), fullMachine, 'relative/path'), false);
  });

  test('a symlink inside a project cannot carry the session out of it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-guest-outside-'));
    const link = path.join(shared, 'escape');
    fs.symlinkSync(outside, link);
    try {
      assert.equal(guestCwdAllowed(ctx(), fullMachine, link), false);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('the owner may open anything', () => {
    assert.equal(guestCwdAllowed(ctx(), OWNER_ACCESS, os.homedir()), true);
  });
});

/** An unsigned JWT-shaped token with the given subject: the bridge reads, never verifies, the claim. */
const tokenFor = (sub: string) =>
  ['e30', Buffer.from(JSON.stringify({ sub })).toString('base64url'), 'sig'].join('.');

describe('a guest’s token never becomes the host’s storage credential', () => {
  test('a refresh on a guest link is ignored, relayed or not', () => {
    assert.equal(tokenRefreshAction({ owner: false, relayed: true }, false), 'ignore');
    assert.equal(tokenRefreshAction({ owner: false, relayed: true }, true), 'ignore');
  });

  test('a token naming someone else does not fit the host’s context', () => {
    assert.equal(jwtSubject(tokenFor('user_guest')), 'user_guest');
    assert.equal(tokenFitsContext(tokenFor('user_guest'), 'user_host', 'local'), false);
    assert.equal(tokenFitsContext(tokenFor('user_host'), 'user_host', 'local'), true);
    // Not a JWT at all names nobody, so it fits no account context either.
    assert.equal(tokenFitsContext('opaque', 'user_host', 'local'), false);
  });

  test('the single-tenant context takes a token only where the exemption is passed in (the dev relay)', () => {
    assert.equal(tokenFitsContext(tokenFor('user_anyone'), 'local', 'local'), true);
    // Everywhere else it takes none: a relay pushing its own account's token onto
    // it would otherwise collect everything that context syncs.
    assert.equal(tokenFitsContext(tokenFor('user_anyone'), 'local', null), false);
  });
});
