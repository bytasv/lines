/**
 * The new-session picker attaches a workflow to a session that already exists
 * but has not run anything. It must behave like a create-time attach (step 0
 * seeded, started by the first prompt), be swappable and undoable while the
 * session is fresh, and be refused once it is not.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, StepContent, WorkflowDef } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { WorkflowEngine } from './workflows.ts';
import type { WorkerClient } from './workerClient.ts';

const USER = 'u1';

const step = (over: Partial<StepContent> = {}): StepContent => ({
  name: 'Plan',
  promptTemplate: 'Plan {task}',
  model: 'claude-opus-5-5',
  permissionMode: 'plan',
  autoAdvance: false,
  freshStart: false,
  ...over,
});

const wf = (over: Partial<WorkflowDef> = {}): WorkflowDef => ({
  id: 'w1',
  name: 'Ship it',
  steps: [step(), step({ name: 'Build', promptTemplate: 'Build it', permissionMode: 'acceptEdits' })],
  ...over,
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-wf-pending-'));
  const store = createStore(root);
  store.saveProjects([{ path: root }]);
  const broadcast = (_m: ServerMessage) => {};
  const prompts: string[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), broadcast);
  sessions.attachWorker({
    push: () => {},
    close: () => {},
    interrupt: () => {},
    setModel: () => {},
    setPermissionMode: () => {},
  } as unknown as WorkerClient);
  const realPrompt = sessions.prompt.bind(sessions);
  sessions.prompt = ((id: string, text: string, ...rest: unknown[]) => {
    prompts.push(text);
    return realPrompt(id, text, ...(rest as []));
  }) as typeof sessions.prompt;
  const workflows = new WorkflowEngine(store, sessions, broadcast, USER);
  workflows.save(wf());
  workflows.save(
    wf({
      id: 'w2',
      name: 'Review',
      steps: [step({ name: 'Review', model: 'claude-sonnet-5-5', permissionMode: 'default', reasoningEffort: 'low' })],
    }),
  );
  const fresh = () =>
    sessions.createSession({
      name: 's',
      cwd: root,
      model: 'claude-haiku-5-5',
      permissionMode: 'acceptEdits',
      reasoningEffort: 'high',
    });
  return { store, sessions, workflows, prompts, fresh };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('attaching to a fresh session waits unstarted and seeds step 0', () => {
  const h = harness();
  const meta = h.fresh();
  h.workflows.attachPending(meta.id, { workflowId: 'w1' });
  const after = h.sessions.get(meta.id)!;
  assert.equal(after.workflow?.workflowId, 'w1');
  assert.equal(after.workflow?.started, false);
  assert.equal(after.workflow?.def?.steps.length, 2, 'rides a frozen copy, as a create-time attach does');
  assert.equal(after.model, 'claude-opus-5-5');
  assert.equal(after.permissionMode, 'plan');
});

test('a pending workflow can be swapped for another', () => {
  const h = harness();
  const meta = h.fresh();
  h.workflows.attachPending(meta.id, { workflowId: 'w1' });
  h.workflows.attachPending(meta.id, { workflowId: 'w2' });
  const after = h.sessions.get(meta.id)!;
  assert.equal(after.workflow?.workflowId, 'w2');
  assert.deepEqual(after.workflow?.stepStatuses, ['pending']);
  assert.equal(after.model, 'claude-sonnet-5-5');
  assert.equal(after.reasoningEffort, 'low');
});

test('detach restores the bare session’s model, mode and effort, even after a swap', () => {
  const h = harness();
  const meta = h.fresh();
  h.workflows.attachPending(meta.id, { workflowId: 'w1' });
  h.workflows.attachPending(meta.id, { workflowId: 'w2' });
  h.workflows.detachPending(meta.id);
  const after = h.sessions.get(meta.id)!;
  assert.equal(after.workflow, undefined);
  assert.equal(after.model, 'claude-haiku-5-5');
  assert.equal(after.permissionMode, 'acceptEdits');
  assert.equal(after.reasoningEffort, 'high');
});

test('an inline definition attaches like a library one', () => {
  const h = harness();
  const meta = h.fresh();
  h.workflows.attachPending(meta.id, { def: wf({ id: 'guest-wf', name: 'Guest' }) });
  const after = h.sessions.get(meta.id)!;
  assert.equal(after.workflow?.workflowId, 'guest-wf');
  assert.equal(after.workflow?.def?.name, 'Guest');
});

test('an unknown workflow is refused and leaves the session bare', () => {
  const h = harness();
  const meta = h.fresh();
  assert.throws(() => h.workflows.attachPending(meta.id, { workflowId: 'nope' }), /no longer exists/);
  assert.equal(h.sessions.get(meta.id)!.workflow, undefined);
  assert.equal(h.sessions.get(meta.id)!.model, 'claude-haiku-5-5');
});

test('the first prompt after attach runs step 0', async () => {
  const h = harness();
  const meta = h.fresh();
  h.workflows.attachPending(meta.id, { workflowId: 'w1' });
  assert.equal(h.workflows.startIfPending(meta.id, 'add dark mode'), true);
  await settle();
  const after = h.sessions.get(meta.id)!;
  assert.equal(after.workflow?.started, true);
  assert.equal(after.workflow?.task, 'add dark mode');
  assert.ok(h.prompts.some((p) => p.includes('Plan add dark mode')), 'step 0 rendered with the task');
});

test('refused once the workflow has started', async () => {
  const h = harness();
  const meta = h.fresh();
  h.workflows.attachPending(meta.id, { workflowId: 'w1' });
  h.workflows.startIfPending(meta.id, 'go');
  await settle();
  assert.throws(() => h.workflows.attachPending(meta.id, { workflowId: 'w2' }), /already started/);
  assert.throws(() => h.workflows.detachPending(meta.id), /already started/);
  assert.equal(h.sessions.get(meta.id)!.workflow?.workflowId, 'w1');
});

test('refused after the first turn of a bare session', () => {
  const h = harness();
  const meta = h.fresh();
  h.sessions.userPrompt(meta.id, 'hello');
  assert.throws(() => h.workflows.attachPending(meta.id, { workflowId: 'w1' }), /before the first prompt/);
  assert.equal(h.sessions.get(meta.id)!.workflow, undefined);
});

test('refused when the session already has a provider conversation', () => {
  const h = harness();
  const meta = h.fresh();
  h.sessions.get(meta.id)!.claudeSessionId = 'c1';
  assert.throws(() => h.workflows.attachPending(meta.id, { workflowId: 'w1' }), /before the first prompt/);
});

test('refused while a goal drives the session', () => {
  const h = harness();
  const meta = h.fresh();
  h.sessions.get(meta.id)!.goal = {
    condition: 'tests pass',
    maxTurns: 5,
    turnsUsed: 0,
    status: 'active',
    setAt: Date.now(),
  };
  assert.throws(() => h.workflows.attachPending(meta.id, { workflowId: 'w1' }), /goal/);
  assert.equal(h.sessions.get(meta.id)!.workflow, undefined);
});
