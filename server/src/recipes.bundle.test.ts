import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CavemanConfig, ClientMessage, RecipeContent, ServerMessage } from '@lines/shared';
import { isStepRef, RECIPE_BUNDLE_MAX } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { RecipeEngine } from './recipes.ts';
import * as commands from './recipeCommands.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { StorageSyncClient } from './sync.ts';
import type { UserContext } from './userContext.ts';
import type { WorkerClient } from './workerClient.ts';
import { WorkflowEngine } from './workflows.ts';

const USER = 'u1';
const CAVEMAN: CavemanConfig = { enabled: false, level: 'full' };

const content = (title: string, over: Partial<RecipeContent> = {}): RecipeContent => ({
  title,
  description: `${title} description`,
  tags: [],
  images: [],
  prompt: `Do ${title}`,
  ...over,
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-recipe-bundle-'));
  const store = createStore(root);
  store.saveProjects([{ path: root }]);
  const broadcasts: ServerMessage[] = [];
  const broadcast = (m: ServerMessage) => broadcasts.push(m);
  const sessions = new SessionManager(store, new GuardAllowlist(store), broadcast);
  sessions.attachWorker({
    push: () => {},
    close: () => {},
    interrupt: () => {},
    setModel: () => {},
    setPermissionMode: () => {},
  } as unknown as WorkerClient);
  const workflows = new WorkflowEngine(store, sessions, broadcast, USER);
  const recipes = new RecipeEngine(store, broadcast, USER);
  const increments: { ownerId: string; id: string }[][] = [];
  const sync = {
    incrementRecipeRuns: async (pairs: { ownerId: string; id: string }[]) => {
      increments.push(pairs);
      return null;
    },
  } as unknown as StorageSyncClient;
  const ctx = { userId: USER, store, sessions, workflows, recipes, sync, broadcast } as unknown as UserContext;
  return { root, ctx, store, sessions, workflows, recipes, broadcasts, increments };
}

const runMsg = (
  h: ReturnType<typeof harness>,
  refs: { ownerId: string; recipeId: string; version?: number }[],
  over: Partial<Extract<ClientMessage, { type: 'runRecipe' }>> = {},
): Extract<ClientMessage, { type: 'runRecipe' }> => ({
  type: 'runRecipe',
  runId: 'run1',
  recipes: refs,
  cwd: h.root,
  model: 'claude-sonnet-5',
  permissionMode: 'acceptEdits',
  caveman: CAVEMAN,
  ...over,
});

/** Three saved leaf recipes, in the order a "new app setup" would run them. */
function trio(h: ReturnType<typeof harness>) {
  return ['Infra', 'Auth', 'Database'].map((t) => h.recipes.saveRecipe(content(t), undefined, true, undefined));
}

test('a multi-recipe run synthesizes a saved workflow with one step per recipe, in order', () => {
  const h = harness();
  const [infra, auth, db] = trio(h);
  const sessionId = commands.runRecipe(
    h.ctx,
    runMsg(
      h,
      [infra, auth, db].map((r) => ({ ownerId: USER, recipeId: r.id })),
      { bundleName: 'New app setup', autoAdvance: true },
    ),
  )!;

  const wf = h.workflows.list().find((w) => w.name === 'New app setup');
  assert.ok(wf, 'the synthesized workflow is in the library');
  assert.deepEqual(
    wf!.steps.map((s) => (isStepRef(s) ? s.stepId : s.name)),
    ['Infra', 'Auth', 'Database'],
  );
  for (const step of wf!.steps) {
    assert.equal(isStepRef(step), false, 'bundle steps are inline copies, not pins');
    if (isStepRef(step)) continue;
    // Cumulative by definition: step N must see what step N-1 built.
    assert.equal(step.freshStart, false);
    assert.equal(step.autoAdvance, true);
    assert.equal(step.model, 'claude-sonnet-5');
    assert.equal(step.permissionMode, 'acceptEdits');
  }
  // The property the whole design hinges on: an unsaved def would make every
  // engine transition a silent no-op after a restart.
  assert.ok(h.store.loadWorkflows().some((w) => w.id === wf!.id), 'persisted to workflows.json');
  const meta = h.sessions.get(sessionId)!;
  assert.equal(meta.workflow?.workflowId, wf!.id);
  assert.equal(meta.workflow?.started, true, 'startIfPending resolved the def and kicked off step 0');
  assert.equal(meta.name, 'New app setup');
});

test('"review between recipes" rides through as autoAdvance false', () => {
  const h = harness();
  const [a, b] = trio(h);
  commands.runRecipe(
    h.ctx,
    runMsg(h, [a, b].map((r) => ({ ownerId: USER, recipeId: r.id })), { autoAdvance: false }),
  );
  const wf = h.workflows.list().find((w) => w.steps.length === 2)!;
  for (const step of wf.steps) if (!isStepRef(step)) assert.equal(step.autoAdvance, false);
});

test('an ad-hoc run with no name falls back to a summary', () => {
  const h = harness();
  const [a, b] = trio(h);
  commands.runRecipe(h.ctx, runMsg(h, [a, b].map((r) => ({ ownerId: USER, recipeId: r.id }))));
  assert.ok(h.workflows.list().some((w) => w.name === 'Infra +1 more'));
});

test('a multi-recipe run cannot also pick a workflow', () => {
  const h = harness();
  const [a, b] = trio(h);
  assert.throws(
    () =>
      commands.runRecipe(
        h.ctx,
        runMsg(h, [a, b].map((r) => ({ ownerId: USER, recipeId: r.id })), { workflowId: 'wf-x' }),
      ),
    /already is a workflow/,
  );
  assert.deepEqual(h.sessions.list(), []);
});

/** All-or-nothing: this is the failure that would otherwise leave a half-configured app. */
test('one unresolvable recipe in a set of four creates no workflow and no session', () => {
  const h = harness();
  const [a, b, c] = trio(h);
  const before = h.workflows.list().length;
  assert.throws(
    () =>
      commands.runRecipe(
        h.ctx,
        runMsg(h, [
          { ownerId: USER, recipeId: a.id },
          { ownerId: USER, recipeId: b.id },
          { ownerId: 'u2', recipeId: 'gone' },
          { ownerId: USER, recipeId: c.id },
        ]),
      ),
    /not available/,
  );
  assert.equal(h.workflows.list().length, before);
  assert.deepEqual(h.sessions.list(), []);
  assert.deepEqual(h.increments, []);
});

test('four recipes produce exactly one batched increment carrying four pairs', () => {
  const h = harness();
  const [a, b, c] = trio(h);
  const d = h.recipes.saveRecipe(content('Payments'), undefined, true, undefined);
  commands.runRecipe(h.ctx, runMsg(h, [a, b, c, d].map((r) => ({ ownerId: USER, recipeId: r.id }))));
  assert.equal(h.increments.length, 1);
  assert.deepEqual(h.increments[0].map((p) => p.id), [a.id, b.id, c.id, d.id]);
});

test('the same recipe listed twice sends one deduped pair', () => {
  const h = harness();
  const [a, b] = trio(h);
  commands.runRecipe(
    h.ctx,
    runMsg(h, [
      { ownerId: USER, recipeId: a.id },
      { ownerId: USER, recipeId: b.id },
      { ownerId: USER, recipeId: a.id },
    ]),
  );
  // `ON CONFLICT DO UPDATE` cannot touch the same row twice in one statement.
  const ids = h.increments[0].map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a run cannot exceed the bundle cap', () => {
  const h = harness();
  const many = Array.from({ length: RECIPE_BUNDLE_MAX + 1 }, (_, n) =>
    h.recipes.saveRecipe(content(`R${n}`), undefined, true, undefined),
  );
  assert.throws(
    () => commands.runRecipe(h.ctx, runMsg(h, many.map((r) => ({ ownerId: USER, recipeId: r.id })))),
    /at most/,
  );
  assert.deepEqual(h.sessions.list(), []);
});

test('an empty selection is refused', () => {
  const h = harness();
  assert.throws(() => commands.runRecipe(h.ctx, runMsg(h, [])), /Nothing to run/);
});
