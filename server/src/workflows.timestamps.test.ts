/**
 * Creation and update times on workflows and reusable steps, and the one rule
 * that makes them durable: `updatedAt` is last-write-wins, `createdAt` only ever
 * moves earlier. A peer, an older client or an MCP spread that drops the field
 * must never be able to erase or postpone a birthday.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, StepContent, StepDef, WorkflowDef } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { DEFAULT_WORKFLOW, WorkflowEngine } from './workflows.ts';
import type { WorkerClient } from './workerClient.ts';

const USER = 'u1';

const content = (over: Partial<StepContent> = {}): StepContent => ({
  name: 'Plan',
  promptTemplate: 'Plan {task}',
  model: 'claude-opus-5-5',
  permissionMode: 'plan',
  autoAdvance: false,
  freshStart: false,
  ...over,
});

/** An engine over a throwaway root; pass `root` back in to reboot on the same disk. */
function harness(root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-ts-'))) {
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (m) => broadcasts.push(m));
  sessions.attachWorker({ push: () => {}, close: () => {} } as unknown as WorkerClient);
  const workflows = new WorkflowEngine(store, sessions, (m) => broadcasts.push(m), USER);
  return { root, store, sessions, workflows, broadcasts };
}

const newWorkflow = (over: Partial<WorkflowDef> = {}): WorkflowDef =>
  ({ id: '', name: 'Mine', steps: [content()], ...over }) as WorkflowDef;

// ---------------------------------------------------------------------------
// workflows
// ---------------------------------------------------------------------------

test('save stamps createdAt once; later saves advance only updatedAt', () => {
  const h = harness();
  const first = h.workflows.save(newWorkflow());
  assert.ok(first.createdAt, 'a first save records a creation time');

  const again = h.workflows.save({ ...first, name: 'Renamed' });
  assert.equal(again.createdAt, first.createdAt);
  // Same-millisecond saves are legitimate, so this is >= rather than >.
  assert.ok(again.updatedAt! >= first.updatedAt!);
});

test('a caller-supplied createdAt on a fresh id is ignored, so a duplicate has its own birthday', () => {
  const h = harness();
  const before = Date.now();
  // What `duplicate()` in the editor and `create_workflow` both send: a spread of
  // an existing workflow with the id cleared.
  const copy = h.workflows.save(newWorkflow({ createdAt: 1_000 }));
  assert.notEqual(copy.createdAt, 1_000);
  assert.ok(copy.createdAt! >= before);
});

test('a save that dropped createdAt keeps the stored value', () => {
  const h = harness();
  const saved = h.workflows.save(newWorkflow());
  const again = h.workflows.save({ ...saved, createdAt: undefined, name: 'Edited' });
  assert.equal(again.createdAt, saved.createdAt);
});

test('an earlier caller createdAt is adopted, a later one is not', () => {
  const h = harness();
  const saved = h.workflows.save(newWorkflow());

  const earlier = h.workflows.save({ ...saved, createdAt: 5_000 });
  assert.equal(earlier.createdAt, 5_000);

  const later = h.workflows.save({ ...earlier, createdAt: Date.now() + 60_000 });
  assert.equal(later.createdAt, 5_000, 'creation time never moves forward');
});

test('applySyncedAll adopts newer content without losing createdAt, and takes an earlier one', () => {
  const h = harness();
  const saved = h.workflows.save(newWorkflow());

  // A peer (or an older bridge) pushing a newer row that carries no birthday.
  h.workflows.applySyncedAll([
    { ...saved, name: 'From peer', createdAt: undefined, updatedAt: saved.updatedAt! + 1_000 },
  ]);
  let row = h.workflows.list().find((w) => w.id === saved.id)!;
  assert.equal(row.name, 'From peer', 'content is last-write-wins');
  assert.equal(row.createdAt, saved.createdAt, 'the birthday survives');

  h.workflows.applySyncedAll([
    { ...saved, name: 'Older birthday', createdAt: 42, updatedAt: saved.updatedAt! + 2_000 },
  ]);
  row = h.workflows.list().find((w) => w.id === saved.id)!;
  assert.equal(row.createdAt, 42, 'an earlier remote createdAt wins');
});

test('the seeded default workflow gets a createdAt without stamping the module constant', () => {
  const h = harness();
  const seeded = h.workflows.list().find((w) => w.id === DEFAULT_WORKFLOW.id)!;
  assert.ok(seeded.createdAt);
  // The seed is inserted as a copy: stamping the shared constant would leak one
  // user's timestamps into every other UserContext in the process.
  assert.equal(DEFAULT_WORKFLOW.createdAt, undefined);
  assert.equal(DEFAULT_WORKFLOW.updatedAt, undefined);
});

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

test('every version of one step carries the same createdAt', () => {
  const h = harness();
  const v1 = h.workflows.saveStep(content(), undefined, true, 'Ada');
  assert.equal(v1.version, 1);
  assert.ok(v1.createdAt);

  const v2 = h.workflows.saveStep(content({ promptTemplate: 'changed' }), v1.id, true, 'Ada');
  assert.equal(v2.version, 2, 'a content change mints a version');
  assert.equal(v2.createdAt, v1.createdAt, 'the lineage keeps one birthday');
  assert.ok(v2.updatedAt! >= v1.updatedAt!);

  // A publish toggle is not a content change: same version, same birthday.
  const toggled = h.workflows.saveStep(content({ promptTemplate: 'changed' }), v1.id, false, 'Ada');
  assert.equal(toggled.version, 2);
  assert.equal(toggled.createdAt, v1.createdAt);

  assert.deepEqual(
    h.workflows.listStepVersions(USER, v1.id).map((s) => s.createdAt),
    [v1.createdAt, v1.createdAt],
  );
});

test('applySyncedSteps and addStepVersions preserve a known createdAt', () => {
  const h = harness();
  const step = h.workflows.saveStep(content(), undefined, true, 'Ada');

  h.workflows.applySyncedSteps([
    { ...step, version: step.version + 1, promptTemplate: 'from peer', createdAt: undefined },
  ]);
  const head = h.workflows.listSteps().find((s) => s.id === step.id)!;
  assert.equal(head.promptTemplate, 'from peer');
  assert.equal(head.createdAt, step.createdAt);

  // A pin resolved through POST /steps/resolve arrives as a bare blob.
  h.workflows.addStepVersions([{ ...step, createdAt: undefined }]);
  const v1 = h.workflows.listStepVersions(USER, step.id).find((s) => s.version === step.version)!;
  assert.equal(v1.createdAt, step.createdAt);
});

test('a step whose head was deleted keeps its lineage birthday when it is saved again', () => {
  const h = harness();
  const step = h.workflows.saveStep(content(), undefined, true, 'Ada');
  h.workflows.deleteStep(step.id);

  const again = h.workflows.saveStep(content({ promptTemplate: 'back' }), step.id, true, 'Ada');
  assert.equal(again.createdAt, step.createdAt, 'the cached versions still know');
});

// ---------------------------------------------------------------------------
// durability
// ---------------------------------------------------------------------------

test('both timestamps survive a reboot from disk', () => {
  const h = harness();
  const wf = h.workflows.save(newWorkflow());
  const step = h.workflows.saveStep(content(), undefined, true, 'Ada');
  h.workflows.saveStep(content({ promptTemplate: 'v2' }), step.id, true, 'Ada');

  const rebooted = harness(h.root);
  const wfRow = rebooted.workflows.list().find((w) => w.id === wf.id)!;
  assert.equal(wfRow.createdAt, wf.createdAt);
  assert.equal(wfRow.updatedAt, wf.updatedAt);

  const head = rebooted.workflows.listSteps().find((s) => s.id === step.id)!;
  assert.equal(head.version, 2);
  assert.equal(head.createdAt, step.createdAt);
  assert.deepEqual(
    rebooted.workflows.listStepVersions(USER, step.id).map((s) => s.createdAt),
    [step.createdAt, step.createdAt],
  );
});

test('boot heals rows written without a createdAt, and rewrites them to disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-ts-heal-'));
  const seed = createStore(root);
  // Rows exactly as an older build left them: no creation time anywhere.
  seed.saveWorkflows([
    { id: 'w1', name: 'Old', steps: [content()], updatedAt: 1_700_000_000_000 } as WorkflowDef,
  ]);
  const version = (v: number, updatedAt: number): StepDef => ({
    ...content(),
    id: 's1',
    ownerId: USER,
    version: v,
    published: true,
    updatedAt,
  });
  seed.saveSteps([version(2, 1_700_000_002_000)]);
  seed.saveStepVersions([version(1, 1_700_000_001_000), version(2, 1_700_000_002_000)]);

  const h = harness(root);
  const wf = h.workflows.list().find((w) => w.id === 'w1')!;
  assert.equal(wf.createdAt, 1_700_000_000_000, 'a workflow falls back to its last edit');
  const head = h.workflows.listSteps().find((s) => s.id === 's1')!;
  assert.equal(head.createdAt, 1_700_000_001_000, "a step head takes its lineage's oldest version");

  // Durable, not derived per boot: `updatedAt` moves, so a read-time guess would
  // answer differently every time.
  const disk = createStore(root);
  assert.equal(disk.loadWorkflows().find((w) => w.id === 'w1')?.createdAt, 1_700_000_000_000);
  assert.equal(disk.loadSteps().find((s) => s.id === 's1')?.createdAt, 1_700_000_001_000);
});
