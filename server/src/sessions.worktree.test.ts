import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient } from './workerClient.ts';
import type { Project, ServerMessage, SessionMeta } from '@lines/shared';

const REPO = '/repo';
const WT = '/repo-worktrees/feature-x';

const meta = (id: string, cwd: string): SessionMeta =>
  ({
    id,
    name: id,
    cwd,
    model: 'claude-opus-5',
    permissionMode: 'default',
    compressResponses: false,
    status: 'idle',
    createdAt: 1,
  }) as SessionMeta;

interface Push {
  sessionId: string;
  options: Record<string, unknown>;
}

/** The sessions.spawn.test harness, with a projects.json holding the work tree. */
function harness(projects: Project[], sessions: SessionMeta[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-wt-spawn-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(sessions));
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify(projects));
  const store = createStore(root);
  const auth = {
    getAccessTokenSync: () => 'tok',
    ensureFreshToken: async () => 'tok',
    handleTokenRejected: async () => ({ outcome: 'refreshed' }),
  } as unknown as AuthManager;
  const broadcasts: ServerMessage[] = [];
  const manager = new SessionManager(store, new GuardAllowlist(store), (m) => broadcasts.push(m), auth);
  const pushes: Push[] = [];
  manager.attachWorker({
    push: (sessionId: string, _message: unknown, options: Record<string, unknown>) =>
      pushes.push({ sessionId, options }),
    close: () => {},
  } as unknown as WorkerClient);
  return { manager, pushes };
}

/** Let the fire-and-forget pushTurn chain settle (no timers involved). */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const PROJECTS: Project[] = [
  { path: REPO, extraRoots: ['/docs'], worktrees: [{ path: WT, branch: 'feature/x' }] },
];

test('a work-tree session spawns confined to the work tree, with no additional directories', async () => {
  const h = harness(PROJECTS, [meta('s1', WT)]);

  h.manager.prompt('s1', 'hello');
  await settle();

  const options = h.pushes[0]!.options;
  assert.equal(options.cwd, WT);
  // Absent, not `[]`: the parent checkout and its extra roots must not be writable
  // from here, and an empty key would still be a change in the serialized options.
  assert.ok(!('additionalDirectories' in options), 'a work tree inherits no roots');
});

test('a session in the parent checkout gets the extra roots and never a work-tree path', async () => {
  const h = harness(PROJECTS, [meta('s1', REPO)]);

  h.manager.prompt('s1', 'hello');
  await settle();

  const options = h.pushes[0]!.options;
  assert.equal(options.cwd, REPO);
  assert.deepEqual(options.additionalDirectories, ['/docs']);
});
