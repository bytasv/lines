/**
 * A session follows its workflow as it was when attached: `attach` freezes the
 * library row onto `meta.workflow.def`, so a later edit (a step inserted, say)
 * reaches only new sessions and never renumbers a run's steps, statuses or costs.
 * Pinned step refs stay refs, so the per-step trust gate still guards them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta, StepContent, StepDef, UntrustedMark, WorkflowDef } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { RecipeEngine } from './recipes.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { runnableDigest, syncKeyFingerprint } from './syncSignature.ts';
import type { UserContext } from './userContext.ts';
import * as commands from './workflowCommands.ts';
import { WorkflowEngine } from './workflows.ts';
import type { WorkerClient } from './workerClient.ts';

const USER = 'u1';
const MACHINE_B = Buffer.from('machine b public key').toString('base64');

const content = (n: number, over: Partial<StepContent> = {}): StepContent => ({
  name: `Step ${n}`,
  promptTemplate: `do step ${n}`,
  model: 'claude-opus-5-5',
  permissionMode: 'default',
  autoAdvance: false,
  // No fresh start: keeps runStep off the hand-off path.
  freshStart: false,
  ...over,
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-snapshot-'));
  const store = createStore(root);
  store.saveProjects([{ path: root }]);
  const prompts: string[] = [];
  const broadcast = (_m: ServerMessage) => {};
  const sessions = new SessionManager(store, new GuardAllowlist(store), broadcast);
  sessions.attachWorker({
    push: () => {},
    close: () => {},
    interrupt: () => {},
    setModel: () => {},
    setPermissionMode: () => {},
    rpcResult: () => {},
  } as unknown as WorkerClient);
  // What each step sends: worker.push takes the session id first, so a mock of
  // it would see no prompt text.
  const realPrompt = sessions.prompt.bind(sessions);
  sessions.prompt = ((id: string, text: string, ...rest: unknown[]) => {
    prompts.push(text);
    return realPrompt(id, text, ...(rest as []));
  }) as typeof sessions.prompt;
  const workflows = new WorkflowEngine(store, sessions, broadcast, USER);
  const recipes = new RecipeEngine(store, broadcast, USER);
  const ctx = { userId: USER, store, sessions, workflows, recipes, broadcast } as unknown as UserContext;
  const newSession = (): SessionMeta => {
    const meta = sessions.createSession({ name: 's', cwd: root, model: 'claude-opus-5-5', permissionMode: 'default' });
    // A deliberate name: the auto-titler would query a model.
    meta.nameAuto = false;
    return meta;
  };
  return { root, store, sessions, workflows, ctx, prompts, newSession };
}

/** Park a session on `stepIndex`, its step finished and awaiting approval. */
function parkOn(h: ReturnType<typeof harness>, sessionId: string, stepIndex: number) {
  const meta = h.sessions.get(sessionId)!;
  meta.status = 'waiting-approval';
  meta.workflow!.started = true;
  meta.workflow!.stepIndex = stepIndex;
  meta.workflow!.stepStatuses = meta.workflow!.stepStatuses.map((_, n) =>
    n < stepIndex ? 'done' : n === stepIndex ? 'waiting-approval' : 'pending',
  );
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('a step inserted after attach reaches only new sessions', async () => {
  const h = harness();
  const saved = h.workflows.save({ id: '', name: 'Flow', steps: [content(1), content(2), content(3)] });
  const meta = h.newSession();
  h.workflows.attach(meta.id, saved.id);

  h.workflows.save({ ...saved, steps: [content(0, { promptTemplate: 'do inserted step' }), ...saved.steps] });

  const attached = h.sessions.get(meta.id)!.workflow!;
  assert.deepEqual(attached.def?.steps, saved.steps, 'the snapshot keeps the original list');
  assert.equal(attached.stepStatuses.length, 3);

  parkOn(h, meta.id, 0);
  h.workflows.approve(meta.id, 0);
  await settle();
  assert.equal(h.sessions.get(meta.id)!.workflow?.stepIndex, 1);
  assert.match(h.prompts.join('\n'), /do step 2/, 'the original step 2 runs');
  assert.doesNotMatch(h.prompts.join('\n'), /do inserted step|do step 1\b/);

  const fresh = h.newSession();
  h.workflows.attach(fresh.id, saved.id);
  assert.equal(h.sessions.get(fresh.id)!.workflow?.stepStatuses.length, 4, 'a new session sees the edit');
});

test('the snapshot drops a provenance-only mark, so the run is not refused', async () => {
  const h = harness();
  const row = { id: 'wb', name: 'From B', steps: [content(1)], ownerId: USER, updatedAt: 100 } satisfies WorkflowDef;
  const mark: UntrustedMark = { reason: 'unknown-signer', digest: runnableDigest('workflow', row), signer: MACHINE_B };
  h.workflows.applySyncedAll([{ ...row, untrusted: mark }]);
  commands.trustSigner(h.ctx, { type: 'trustSigner', key: MACHINE_B, fingerprint: syncKeyFingerprint(MACHINE_B) });
  assert.equal(h.workflows.list().find((w) => w.id === 'wb')?.untrusted?.held, false, 'provenance kept on the row');

  const meta = h.newSession();
  h.workflows.attach(meta.id, 'wb');
  assert.equal(h.sessions.get(meta.id)!.workflow?.def?.untrusted, undefined);

  assert.equal(h.workflows.startIfPending(meta.id, 'the task'), true);
  await settle();
  assert.equal(h.sessions.get(meta.id)!.workflow?.stepFailure, undefined);
  assert.match(h.prompts.join('\n'), /do step 1/);
});

test('a pinned version held back after attach is still refused in the snapshot', async () => {
  const h = harness();
  const version: StepDef = { ...content(1, { promptTemplate: 'pinned step' }), id: 's1', ownerId: USER, version: 1, published: false };
  h.workflows.applySyncedSteps([
    { ...version, untrusted: { reason: 'unknown-signer', digest: runnableDigest('step', version), signer: MACHINE_B } },
  ]);
  commands.trustSigner(h.ctx, { type: 'trustSigner', key: MACHINE_B, fingerprint: syncKeyFingerprint(MACHINE_B) });
  const saved = h.workflows.save({
    id: '',
    name: 'Pinned',
    steps: [{ kind: 'ref', stepId: 's1', ownerId: USER, version: 1 }],
  });
  const meta = h.newSession();
  h.workflows.attach(meta.id, saved.id);
  assert.deepEqual(h.sessions.get(meta.id)!.workflow?.def?.steps, saved.steps, 'the ref stays a ref');

  commands.untrustSigner(h.ctx, { type: 'untrustSigner', key: MACHINE_B });

  assert.equal(h.workflows.startIfPending(meta.id, 'the task'), true);
  await settle();
  const after = h.sessions.get(meta.id)!;
  assert.equal(after.workflow?.stepFailure, 'pre-run');
  assert.match(String(after.errorMessage), /pinned step/);
  assert.deepEqual(h.prompts, [], 'nothing reached the worker');
});

test('a session attached before snapshots still follows the live row', async () => {
  const h = harness();
  const saved = h.workflows.save({ id: '', name: 'Flow', steps: [content(1), content(2)] });
  const meta = h.newSession();
  h.workflows.attach(meta.id, saved.id);
  // What a pre-snapshot attach left on the meta: the id and nothing else.
  delete h.sessions.get(meta.id)!.workflow!.def;

  h.workflows.save({ ...saved, steps: [content(1), content(2, { promptTemplate: 'do edited step 2' })] });

  parkOn(h, meta.id, 0);
  h.workflows.approve(meta.id, 0);
  await settle();
  assert.match(h.prompts.join('\n'), /do edited step 2/);
});
