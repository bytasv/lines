import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, StepContent, WorkflowDef } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { UserContext } from './userContext.ts';
import { DEFAULT_WORKFLOW, ForeignWorkflowError, WorkflowEngine } from './workflows.ts';
import * as commands from './workflowCommands.ts';
import type { StorageSyncClient } from './sync.ts';
import type { WorkerClient } from './workerClient.ts';

const USER = 'u1';

const content = (over: Partial<StepContent> = {}): StepContent => ({
  name: 'Plan',
  promptTemplate: 'Plan {task}',
  model: 'claude-opus-5',
  permissionMode: 'plan',
  autoAdvance: false,
  freshStart: false,
  ...over,
});

/** A real engine + store over a throwaway root, with sync calls recorded. */
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-cmd-'));
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (m) => broadcasts.push(m));
  sessions.attachWorker({ push: () => {}, close: () => {} } as unknown as WorkerClient);
  const workflows = new WorkflowEngine(store, sessions, (m) => broadcasts.push(m), USER);
  const syncCalls: string[] = [];
  const sync = {
    deleteWorkflow: (id: string) => syncCalls.push(`deleteWorkflow:${id}`),
    deleteStep: (id: string) => syncCalls.push(`deleteStep:${id}`),
    pullStepVersions: async () => null,
  } as unknown as StorageSyncClient;
  const ctx = { userId: USER, store, sessions, workflows, sync } as unknown as UserContext;
  return { ctx, workflows, sessions, store, broadcasts, syncCalls };
}

test('saveWorkflow stamps the owner and broadcasts, exactly as the WS case did', () => {
  const h = harness();
  const saved = commands.saveWorkflow(h.ctx, {
    workflow: { id: '', name: 'Mine', steps: [content()] } as WorkflowDef,
    ownerName: 'Ada',
  });

  assert.ok(saved.id, 'engine assigns an id');
  assert.equal(saved.ownerId, USER);
  assert.equal(saved.ownerName, 'Ada');
  assert.ok(saved.updatedAt);
  assert.ok(h.broadcasts.some((m) => m.type === 'workflows'));
  assert.ok(h.store.loadWorkflows().some((w) => w.id === saved.id), 'persisted');
});

/** Today's semantics: only an explicitly supplied ownerName touches the field. */
test('an absent ownerName leaves the existing label alone', () => {
  const h = harness();
  const first = commands.saveWorkflow(h.ctx, {
    workflow: { id: '', name: 'Mine', steps: [content()] } as WorkflowDef,
    ownerName: 'Ada',
  });
  const again = commands.saveWorkflow(h.ctx, { workflow: { ...first, name: 'Renamed' } });
  assert.equal(again.ownerName, 'Ada');
});

test('deleteWorkflow removes the row from storage as well as the engine', () => {
  const h = harness();
  const saved = commands.saveWorkflow(h.ctx, {
    workflow: { id: '', name: 'Mine', steps: [content()] } as WorkflowDef,
  });

  commands.deleteWorkflow(h.ctx, saved.id);

  assert.equal(h.workflows.list().some((w) => w.id === saved.id), false);
  // The 'workflows' broadcast only upserts what's left — the explicit delete is
  // the only thing that removes it remotely.
  assert.deepEqual(h.syncCalls, [`deleteWorkflow:${saved.id}`]);
});

test('saveStep versions the step and deleteStep removes it both places', () => {
  const h = harness();
  const step = commands.saveStep(h.ctx, { step: content(), published: true, ownerName: 'Ada' });
  assert.equal(step.version, 1);
  assert.equal(step.ownerId, USER);
  assert.equal(step.published, true);

  const edited = commands.saveStep(h.ctx, {
    step: content({ promptTemplate: 'changed' }),
    stepId: step.id,
    published: true,
  });
  assert.equal(edited.version, 2, 'a content change mints a new version');

  commands.deleteStep(h.ctx, step.id);
  assert.equal(h.workflows.listSteps().length, 0);
  assert.deepEqual(h.syncCalls, [`deleteStep:${step.id}`]);
  // The immutable versions stay cached for workflows pinned to them.
  assert.equal(h.workflows.listStepVersions(USER, step.id).length, 2);
});

test('resolveWorkflowRef matches by id and by unique case-insensitive name', () => {
  const h = harness();
  const saved = commands.saveWorkflow(h.ctx, {
    workflow: { id: '', name: 'MVP Flow', steps: [content()] } as WorkflowDef,
  });

  const byId = commands.resolveWorkflowRef(h.ctx, saved.id);
  assert.equal(byId.ok && byId.workflow.id, saved.id);

  const byName = commands.resolveWorkflowRef(h.ctx, 'mvp flow');
  assert.equal(byName.ok && byName.workflow.id, saved.id);
});

test('two workflows of the same name resolve as ambiguous, with both candidates', () => {
  const h = harness();
  const a = commands.saveWorkflow(h.ctx, {
    workflow: { id: '', name: 'Dup', steps: [content()] } as WorkflowDef,
  });
  const b = commands.saveWorkflow(h.ctx, {
    workflow: { id: '', name: 'Dup', steps: [content()] } as WorkflowDef,
  });

  const result = commands.resolveWorkflowRef(h.ctx, 'Dup');
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'ambiguous');
  assert.deepEqual(
    !result.ok ? result.candidates.map((c) => c.id).sort() : [],
    [a.id, b.id].sort(),
  );
});

test('an unknown reference reports not-found and lists what the user does own', () => {
  const h = harness();
  const result = commands.resolveWorkflowRef(h.ctx, 'nope');
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'not-found');
  // The engine seeds the default workflow, so there is always at least one candidate.
  assert.ok(!result.ok && result.candidates.some((c) => c.id === DEFAULT_WORKFLOW.id));
});

/**
 * resolveWorkflowRef is the good error message; the engine is the guard. Both
 * legs are asserted here — a caller that skips the check gets a throw, never a
 * successful-looking save of nothing.
 */
test('a foreign workflow is refused, by the check and by save() itself', () => {
  const h = harness();
  const foreign: WorkflowDef = {
    id: 'foreign-1',
    name: 'Someone Elses',
    steps: [content()],
    ownerId: 'u2',
    published: true,
  };
  h.workflows.setShared([foreign]);

  for (const ref of ['foreign-1', 'someone elses']) {
    const result = commands.resolveWorkflowRef(h.ctx, ref);
    assert.equal(result.ok, false, ref);
    assert.equal(!result.ok && result.reason, 'foreign', ref);
  }

  // And the engine refuses it outright rather than pretending to save it.
  const before = h.workflows.list().length;
  assert.throws(() => h.workflows.save({ ...foreign, name: 'Hijacked' }), ForeignWorkflowError);
  assert.equal(h.workflows.list().length, before, 'stored nothing');
});

test('readWorkflowView resolves pinned refs and reports the ones it cannot', () => {
  const h = harness();
  const published = commands.saveStep(h.ctx, {
    step: content({ name: 'Shared Plan' }),
    published: true,
  });
  const saved = commands.saveWorkflow(h.ctx, {
    workflow: {
      id: '',
      name: 'Pinned',
      steps: [
        { kind: 'ref', stepId: published.id, ownerId: USER, version: published.version },
        { kind: 'ref', stepId: 'ghost', ownerId: 'u2', version: 9 },
        content({ name: 'Inline' }),
      ],
    } as WorkflowDef,
  });

  const view = commands.readWorkflowView(h.ctx, saved);
  assert.equal(view.stepCount, 3);
  assert.deepEqual(view.steps.map((s) => s.name), ['Shared Plan', 'Inline']);
  assert.deepEqual(view.steps[0]!.pinned, { stepId: published.id, ownerId: USER, version: 1 });
  assert.deepEqual(view.unresolvedSteps, [{ index: 1, stepId: 'ghost', ownerId: 'u2', version: 9 }]);
});

test('list views scope to owned, shared, or both', () => {
  const h = harness();
  h.workflows.setShared([{ id: 'f1', name: 'Foreign', steps: [], ownerId: 'u2' }]);

  const owned = commands.listWorkflowsView(h.ctx, 'owned');
  assert.equal(owned.every((w) => w.owned), true);
  assert.equal(owned.some((w) => w.id === 'f1'), false);

  const shared = commands.listWorkflowsView(h.ctx, 'shared');
  assert.deepEqual(shared.map((w) => w.id), ['f1']);
  assert.equal(shared[0]!.owned, false);

  assert.equal(commands.listWorkflowsView(h.ctx, 'all').length, owned.length + 1);
});

test('a list limit is clamped rather than trusted', () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    commands.saveWorkflow(h.ctx, { workflow: { id: '', name: `w${i}`, steps: [content()] } as WorkflowDef });
  }
  assert.equal(commands.listWorkflowsView(h.ctx, 'owned', 2).length, 2);
  assert.equal(commands.listWorkflowsView(h.ctx, 'owned', 0).length, 6, 'zero means default');
  assert.equal(commands.listWorkflowsView(h.ctx, 'owned', 10_000).length, 6);
});

test('ownerDisplayName recovers the label from what the user already saved', () => {
  const h = harness();
  assert.equal(commands.ownerDisplayName(h.ctx), undefined);
  commands.saveStep(h.ctx, { step: content(), published: false, ownerName: 'Ada' });
  assert.equal(commands.ownerDisplayName(h.ctx), 'Ada');
});

test('workflowInUse names the sessions currently running a workflow', () => {
  const h = harness();
  const saved = commands.saveWorkflow(h.ctx, {
    workflow: { id: '', name: 'Live', steps: [content()] } as WorkflowDef,
  });
  const meta = h.sessions.createSession({
    name: 'S',
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
  });
  h.workflows.attach(meta.id, saved.id);

  assert.deepEqual(commands.workflowInUse(h.ctx, saved.id), [{ sessionId: meta.id, name: 'S' }]);
  assert.deepEqual(commands.workflowInUse(h.ctx, 'other'), []);
});

test('stepVersionsView falls back to the local cache when storage is offline', async () => {
  const h = harness();
  const step = commands.saveStep(h.ctx, { step: content(), published: true });
  commands.saveStep(h.ctx, { step: content({ promptTemplate: 'v2' }), stepId: step.id, published: true });

  const versions = await commands.stepVersionsView(h.ctx, USER, step.id);
  assert.deepEqual(versions.map((s) => s.version), [2, 1], 'newest first');
});
