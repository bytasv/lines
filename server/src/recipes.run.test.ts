import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ClientMessage, RecipeContent, RecipeDef, ServerMessage } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { RecipeEngine } from './recipes.ts';
import * as commands from './recipeCommands.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { StorageSyncClient } from './sync.ts';
import { runnableDigest } from './syncSignature.ts';
import type { UserContext } from './userContext.ts';
import type { WorkerClient } from './workerClient.ts';
import { WorkflowEngine } from './workflows.ts';

const USER = 'u1';

const content = (over: Partial<RecipeContent> = {}): RecipeContent => ({
  title: 'Auth management',
  description: 'Wire up Clerk auth',
  tags: [],
  images: [],
  prompt: 'Add Clerk auth to this app.',
  ...over,
});

/**
 * A full run path over a throwaway store: real session/workflow/recipe engines,
 * a worker whose pushes are recorded, and a sync client that records the
 * increment call. `calls` holds both in one ordered list, which is what makes the
 * "count only after the prompt landed" ordering assertable.
 */
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-recipe-run-'));
  const store = createStore(root);
  store.saveProjects([{ path: root }]);
  const broadcasts: ServerMessage[] = [];
  const calls: string[] = [];
  const broadcast = (m: ServerMessage) => broadcasts.push(m);
  const sessions = new SessionManager(store, new GuardAllowlist(store), broadcast);
  sessions.attachWorker({
    push: () => calls.push('prompt'),
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
      calls.push('increment');
      increments.push(pairs);
      return null;
    },
    pullRecipeVersions: async () => null,
  } as unknown as StorageSyncClient;
  const ctx = { userId: USER, store, sessions, workflows, recipes, sync, broadcast } as unknown as UserContext;
  return { root, ctx, store, sessions, workflows, recipes, broadcasts, calls, increments };
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
  model: 'claude-opus-5-5',
  permissionMode: 'default',
  ...over,
});

test('resolveForRun: own head resolves whether published or not', () => {
  const h = harness();
  const own = h.recipes.saveRecipe(content(), undefined, false, undefined);
  assert.equal(h.recipes.resolveForRun(USER, own.id)?.id, own.id);
});

test('resolveForRun: a foreign published head resolves, an unpublished one does not', () => {
  const h = harness();
  const foreign: RecipeDef = { ...content(), id: 'r9', ownerId: 'u2', version: 1, published: true };
  h.recipes.setSharedRecipes([foreign]);
  assert.equal(h.recipes.resolveForRun('u2', 'r9')?.id, 'r9');

  // Cached as a version but never published — not runnable by anyone else.
  h.recipes.addRecipeVersions([{ ...foreign, id: 'r8', version: 1, published: false }]);
  assert.equal(h.recipes.resolveForRun('u2', 'r8', 1), undefined);
});

test('resolveForRun: an explicit version comes from the cached history, unknown ids are undefined', () => {
  const h = harness();
  const v1 = h.recipes.saveRecipe(content(), undefined, false, undefined);
  h.recipes.saveRecipe(content({ prompt: 'newer' }), v1.id, false, undefined);
  assert.equal(h.recipes.resolveForRun(USER, v1.id, 1)?.prompt, 'Add Clerk auth to this app.');
  assert.equal(h.recipes.resolveForRun(USER, v1.id)?.prompt, 'newer');
  assert.equal(h.recipes.resolveForRun(USER, 'nope'), undefined);
});

test('a single recipe runs as a plain session named after it, and counts once after the prompt', () => {
  const h = harness();
  const r = h.recipes.saveRecipe(content(), undefined, false, undefined);
  const sessionId = commands.runRecipe(h.ctx, runMsg(h, [{ ownerId: USER, recipeId: r.id }]));

  assert.ok(sessionId);
  const meta = h.sessions.get(sessionId!)!;
  assert.equal(meta.name, 'Auth management');
  assert.equal(meta.nameAuto, false, 'the auto-titler must not overwrite a deliberate name');
  assert.equal(meta.workflow, undefined, 'one leaf and no workflowId = a plain session');
  // The counter must never lead the prompt: a run that failed to inject must not count.
  assert.deepEqual(h.calls, ['prompt', 'increment']);
  assert.deepEqual(h.increments, [[{ ownerId: USER, id: r.id }]]);
  assert.equal(h.recipes.allStats()[`${USER}/${r.id}`], 1);
  const stats = h.broadcasts.filter((m) => m.type === 'recipeStats');
  assert.equal(stats.length, 1);
});

test('a rejected cwd creates no session and counts nothing', () => {
  const h = harness();
  const r = h.recipes.saveRecipe(content(), undefined, false, undefined);
  assert.throws(
    () => commands.runRecipe(h.ctx, runMsg(h, [{ ownerId: USER, recipeId: r.id }], { cwd: '/not/open' })),
    /Open a project first/,
  );
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sessions.list(), []);
  assert.deepEqual(h.recipes.allStats(), {});
});

test('an unknown recipe aborts before anything is created', () => {
  const h = harness();
  assert.throws(() => commands.runRecipe(h.ctx, runMsg(h, [{ ownerId: USER, recipeId: 'nope' }])), /not available/);
  assert.deepEqual(h.sessions.list(), []);
  assert.deepEqual(h.calls, []);
});

test('the cooldown swallows an immediate second run of the same set', () => {
  const h = harness();
  const r = h.recipes.saveRecipe(content(), undefined, false, undefined);
  assert.ok(commands.runRecipe(h.ctx, runMsg(h, [{ ownerId: USER, recipeId: r.id }])));
  assert.equal(commands.runRecipe(h.ctx, runMsg(h, [{ ownerId: USER, recipeId: r.id }])), null);
  assert.equal(h.sessions.list().length, 1);
  assert.equal(h.increments.length, 1);
});

test('one recipe plus a chosen workflow attaches it and hands the prompt over as the task', () => {
  const h = harness();
  const r = h.recipes.saveRecipe(content(), undefined, false, undefined);
  const wf = h.workflows.save({
    id: '',
    name: 'Existing',
    steps: [
      {
        name: 'Do',
        promptTemplate: 'work on {task}',
        model: 'claude-opus-5-5',
        permissionMode: 'default',
        autoAdvance: false,
        freshStart: false,
      },
    ],
  });
  const sessionId = commands.runRecipe(
    h.ctx,
    runMsg(h, [{ ownerId: USER, recipeId: r.id }], { workflowId: wf.id }),
  )!;
  const meta = h.sessions.get(sessionId)!;
  assert.equal(meta.workflow?.workflowId, wf.id);
  assert.equal(meta.workflow?.task, content().prompt);
});

// ---- someone else's recipe, and an unverified one of your own ----

const theirs = (over: Partial<RecipeDef> = {}): RecipeDef => ({
  ...content({ title: 'Stranger’s setup', prompt: 'Install their tooling.' }),
  id: 'r9',
  ownerId: 'u2',
  ownerName: 'Ada',
  version: 1,
  published: true,
  ...over,
});

test('someone else’s recipe does not run until its exact prompt is confirmed', () => {
  const h = harness();
  h.recipes.setSharedRecipes([theirs()]);
  const ref = [{ ownerId: 'u2', recipeId: 'r9' }];

  assert.throws(() => commands.runRecipe(h.ctx, runMsg(h, ref)), /confirm it before running/);
  // A confirmation of other text is not a confirmation of this one.
  assert.throws(
    () => commands.runRecipe(h.ctx, runMsg(h, ref, { confirmedPrompts: ['Install nothing.'] })),
    /confirm it before running/,
  );
  assert.deepEqual(h.sessions.list(), []);
  assert.deepEqual(h.calls, []);

  // The refusals did not start the cooldown, so the confirmed retry runs at once.
  const sessionId = commands.runRecipe(h.ctx, runMsg(h, ref, { confirmedPrompts: ['Install their tooling.'] }));
  assert.ok(sessionId);
  assert.deepEqual(h.calls, ['prompt', 'increment']);
});

test('a confirmed stranger’s recipe runs in Assist at most, whatever the runner’s default', () => {
  const bypass = harness();
  bypass.recipes.setSharedRecipes([theirs()]);
  const ran = commands.runRecipe(
    bypass.ctx,
    runMsg(bypass, [{ ownerId: 'u2', recipeId: 'r9' }], {
      permissionMode: 'bypassPermissions',
      confirmedPrompts: ['Install their tooling.'],
    }),
  )!;
  assert.equal(bypass.sessions.get(ran)!.permissionMode, 'auto');

  const plan = harness();
  plan.recipes.setSharedRecipes([theirs()]);
  const planned = commands.runRecipe(
    plan.ctx,
    runMsg(plan, [{ ownerId: 'u2', recipeId: 'r9' }], { permissionMode: 'plan', confirmedPrompts: ['Install their tooling.'] }),
  )!;
  assert.equal(plan.sessions.get(planned)!.permissionMode, 'plan', 'plan mode is already safe and is kept');
});

test('a run with a stranger’s recipe in it parks after every step and never escalates', () => {
  const h = harness();
  h.recipes.setSharedRecipes([theirs()]);
  const mine = h.recipes.saveRecipe(content(), undefined, false, undefined);
  const sessionId = commands.runRecipe(
    h.ctx,
    runMsg(h, [{ ownerId: USER, recipeId: mine.id }, { ownerId: 'u2', recipeId: 'r9' }], {
      permissionMode: 'acceptEdits',
      autoAdvance: true,
      confirmedPrompts: [content().prompt, 'Install their tooling.'],
    }),
  )!;

  const wf = h.workflows.list().find((w) => w.id === h.sessions.get(sessionId)!.workflow?.workflowId)!;
  assert.equal(wf.steps.length, 2);
  for (const step of wf.steps) {
    assert.ok(!('kind' in step && step.kind === 'ref'));
    assert.equal((step as { autoAdvance: boolean }).autoAdvance, false, 'each next prompt waits for the user');
    assert.equal((step as { permissionMode: string }).permissionMode, 'auto');
  }
});

test('a stranger’s recipe cannot run inside one of your workflows', () => {
  const h = harness();
  h.recipes.setSharedRecipes([theirs()]);
  const wf = h.workflows.save({
    id: '',
    name: 'Mine',
    steps: [{ name: 'Do', promptTemplate: '{task}', model: 'claude-opus-5-5', permissionMode: 'bypassPermissions', autoAdvance: true, freshStart: false }],
  });
  assert.throws(
    () =>
      commands.runRecipe(
        h.ctx,
        runMsg(h, [{ ownerId: 'u2', recipeId: 'r9' }], { workflowId: wf.id, confirmedPrompts: ['Install their tooling.'] }),
      ),
    /session of its own/,
  );
  assert.deepEqual(h.sessions.list(), []);
});

test('an own recipe this machine has not verified is refused until it is reviewed', () => {
  const h = harness();
  const pulled: RecipeDef = { ...content(), id: 'r1', ownerId: USER, version: 1, published: false };
  const digest = runnableDigest('recipe', pulled);
  h.recipes.applySyncedRecipes([{ ...pulled, untrusted: { reason: 'unsigned', digest } }]);
  const ref = [{ ownerId: USER, recipeId: 'r1' }];

  assert.throws(() => commands.runRecipe(h.ctx, runMsg(h, ref)), /not been verified on this machine/);
  assert.deepEqual(h.sessions.list(), []);

  h.recipes.trustRecipe(USER, 'r1', 1, digest);
  assert.ok(commands.runRecipe(h.ctx, runMsg(h, ref)), 'runs straight after the review');
});

test('a stranger’s recipe run sets no ceiling, but a legacy one still holds', () => {
  const h = harness();
  h.recipes.setSharedRecipes([theirs()]);
  const ran = commands.runRecipe(
    h.ctx,
    runMsg(h, [{ ownerId: 'u2', recipeId: 'r9' }], { permissionMode: 'plan', confirmedPrompts: ['Install their tooling.'] }),
  )!;
  // Approving its plan resumes in `auto`, which foreign runs may now use.
  assert.equal(h.sessions.get(ran)!.permissionCeiling, undefined);
  // A session an older bridge started still carries the `default` ceiling the
  // plan-approval switch reads (sessions.resolvePermission).
  h.sessions.get(ran)!.permissionCeiling = 'default';

  const mine = h.recipes.saveRecipe(content({ prompt: 'Mine.' }), undefined, false, undefined);
  const own = commands.runRecipe(h.ctx, runMsg(h, [{ ownerId: USER, recipeId: mine.id }], { permissionMode: 'plan' }))!;
  assert.equal(h.sessions.get(own)!.permissionCeiling, undefined, 'the user’s own recipe keeps the usual switch');

  // A synced copy of the session can neither lift the ceiling nor bring one.
  h.sessions.adoptSynced({ ...structuredClone(h.sessions.get(ran)!), permissionCeiling: undefined, updatedAt: Date.now() + 60_000 });
  assert.equal(h.sessions.get(ran)!.permissionCeiling, 'default');
  h.sessions.adoptSynced({ ...structuredClone(h.sessions.get(own)!), permissionCeiling: 'default', updatedAt: Date.now() + 60_000 });
  assert.equal(h.sessions.get(own)!.permissionCeiling, undefined);
});
