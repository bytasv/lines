/**
 * Who owns what, and what follows from that: an owned workflow must never be
 * presented (or refused) as somebody else's, and a write the engine drops must
 * be visible as a failure rather than reported as a save.
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
import { ForeignWorkflowError, WorkflowEngine } from './workflows.ts';
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

const stepDef = (over: Partial<StepDef> = {}): StepDef => ({
  ...content(),
  id: 's1',
  ownerId: 'u2',
  version: 1,
  published: true,
  ...over,
});

/** An engine over a throwaway root; `root` is handed back for on-disk assertions. */
function harness(root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-own-'))) {
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (m) => broadcasts.push(m));
  sessions.attachWorker({ push: () => {}, close: () => {} } as unknown as WorkerClient);
  const workflows = new WorkflowEngine(store, sessions, (m) => broadcasts.push(m), USER);
  return { root, store, sessions, workflows, broadcasts };
}

test('setShared drops rows this user owns, by ownerId and by own-map membership', () => {
  const h = harness();
  const mine = h.workflows.save({ id: '', name: 'Mine', steps: [content()] } as WorkflowDef);

  const changed = h.workflows.setShared([
    { id: 'self-stamped', name: 'Also mine', steps: [content()], ownerId: USER, published: true },
    { ...mine, ownerId: 'u2', published: true }, // same id, pulled back as a stranger's
    { id: 'theirs', name: 'Theirs', steps: [content()], ownerId: 'u2', published: true },
  ]);

  assert.equal(changed, true);
  assert.deepEqual(
    h.workflows.listShared().map((w) => w.id),
    ['theirs'],
  );
});

test('a delta made up only of self-owned rows does not rebroadcast', () => {
  const h = harness();
  assert.equal(
    h.workflows.setShared([{ id: 'theirs', name: 'Theirs', steps: [content()], ownerId: 'u2', published: true }]),
    true,
  );
  // Same foreign row, plus rows that filter out: the surviving view is unchanged.
  assert.equal(
    h.workflows.setShared([
      { id: 'theirs', name: 'Theirs', steps: [content()], ownerId: 'u2', published: true },
      { id: 'self-stamped', name: 'Mine', steps: [content()], ownerId: USER, published: true },
    ]),
    false,
  );
});

test('a shared row that becomes owned is filtered at read time, with no second pull', () => {
  const h = harness();
  // The stale-snapshot case: storage is unreachable afterwards, so setShared is
  // never called again and only a read-time filter can recover.
  h.workflows.setShared([
    { id: 'w9', name: 'Implement v2', steps: [content()], ownerId: 'u2', published: true },
  ]);
  assert.deepEqual(h.workflows.listShared().map((w) => w.id), ['w9']);

  h.workflows.applySyncedAll([
    { id: 'w9', name: 'Implement v2', steps: [content()], ownerId: USER, updatedAt: 1 } as WorkflowDef,
  ]);

  assert.deepEqual(h.workflows.listShared(), [], 'own beats shared without a re-pull');
  const saved = h.workflows.save({ id: 'w9', name: 'Implement v2 edited', steps: [content()] } as WorkflowDef);
  assert.equal(saved.ownerId, USER);
  assert.equal(h.workflows.list().find((w) => w.id === 'w9')?.name, 'Implement v2 edited');
});

test('setSharedSteps drops a self-owned head, and it never reaches the own history', () => {
  const h = harness();
  const changed = h.workflows.setSharedSteps([
    stepDef({ id: 'mine', ownerId: USER }),
    stepDef({ id: 'theirs', ownerId: 'u2' }),
  ]);

  assert.equal(changed, true);
  assert.deepEqual(h.workflows.listSharedSteps().map((s) => s.id), ['theirs']);
  assert.deepEqual(
    h.workflows.listOwnStepVersions().map((s) => s.id),
    [],
    'a shared-library row is never pushed up as ours',
  );
});

test('save() throws for a genuinely foreign id, and writes one held in both maps', () => {
  const h = harness();
  const foreign: WorkflowDef = {
    id: 'f1',
    name: 'Theirs',
    steps: [content()],
    ownerId: 'u2',
    published: true,
  };
  h.workflows.setShared([foreign]);

  assert.throws(() => h.workflows.save({ ...foreign, name: 'Hijacked' }), ForeignWorkflowError);
  assert.equal(h.workflows.listShared()[0]!.name, 'Theirs');
  assert.equal(h.workflows.list().some((w) => w.id === 'f1'), false, 'nothing written');

  // The same id, now also owned: writable, and no longer offered as shared.
  h.workflows.applySyncedAll([{ ...foreign, ownerId: USER, updatedAt: 1 }]);
  const saved = h.workflows.save({ ...foreign, name: 'Mine now' });
  assert.equal(saved.name, 'Mine now');
  assert.equal(h.workflows.list().find((w) => w.id === 'f1')?.name, 'Mine now');
});

test('save() heals a drifted ref owner, and leaves a genuinely foreign pin alone', () => {
  const h = harness();
  const own = h.workflows.saveStep(content({ name: 'Implementation Agent' }), undefined, false, 'Ada');
  h.workflows.setSharedSteps([stepDef({ id: 'theirs', ownerId: 'u2', version: 3 })]);

  const saved = h.workflows.save({
    id: '',
    name: 'Drifted',
    steps: [
      // Stamped by a browser that guessed the owner (Clerk id, or '' with Clerk off).
      { kind: 'ref', stepId: own.id, ownerId: '', version: own.version },
      { kind: 'ref', stepId: 'theirs', ownerId: 'u2', version: 3 },
    ],
  } as WorkflowDef);

  assert.deepEqual(
    saved.steps.map((s) => (s as { ownerId: string }).ownerId),
    [USER, 'u2'],
  );
  // Healed refs resolve, which is what makes the pin visible to the version check.
  assert.deepEqual(h.workflows.listPinnedSteps().map((s) => s.id).sort(), ['theirs', own.id].sort());
});

test('save() does not rename an owner for a version this user does not hold', () => {
  const h = harness();
  const own = h.workflows.saveStep(content(), undefined, false, undefined); // version 1

  const saved = h.workflows.save({
    id: '',
    name: 'Future pin',
    steps: [{ kind: 'ref', stepId: own.id, ownerId: 'u2', version: 7 }],
  } as WorkflowDef);

  assert.equal((saved.steps[0] as { ownerId: string }).ownerId, 'u2', 'no version 7 in own history');
});

test('a drifted ref in workflows.json is healed once, at boot', () => {
  const first = harness();
  const own = first.workflows.saveStep(content({ name: 'Implementation Agent' }), undefined, false, undefined);
  // Written straight to disk so the engine sees the drift on load rather than
  // through save(), which would have healed it already.
  first.store.saveWorkflows([
    {
      id: 'w1',
      name: 'Implement v2',
      ownerId: USER,
      steps: [{ kind: 'ref', stepId: own.id, ownerId: '', version: own.version }],
    } as WorkflowDef,
  ]);

  const rebooted = harness(first.root);
  const step = rebooted.workflows.list().find((w) => w.id === 'w1')!.steps[0] as { ownerId: string };
  assert.equal(step.ownerId, USER);
  assert.equal(
    (rebooted.store.loadWorkflows().find((w) => w.id === 'w1')!.steps[0] as { ownerId: string }).ownerId,
    USER,
    'rewritten on disk, not just in memory',
  );
  // And the pin now resolves, so the step's newer versions can be offered.
  assert.deepEqual(rebooted.workflows.listPinnedSteps().map((s) => s.id), [own.id]);
});
