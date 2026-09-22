import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  ReasoningEffort,
  ServerMessage,
  SessionMeta,
  WorkflowDef,
  WorkflowState,
} from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { WorkflowEngine } from './workflows.ts';

/**
 * Workflow steps across providers.
 *
 * The rule under test is not "which models are allowed" but "what happens to the
 * conversation": nothing links a `claudeSessionId` to a `codexThreadId`, so a
 * step that changes provider has to start a fresh one. A step that says it will
 * inherit the previous step's conversation *and* change provider is the
 * contradiction the runner has to catch, because letting it start would hand the
 * new model a transcript it cannot read.
 */

/** Per-step reasoning effort, absent on both steps unless a test sets one. */
interface StepEfforts {
  first?: ReasoningEffort;
  second?: ReasoningEffort;
}

const twoStep = (
  secondModel: string,
  secondFreshStart: boolean,
  efforts: StepEfforts = {},
): WorkflowDef => ({
  id: 'wf1',
  name: 'cross-provider flow',
  steps: [
    {
      name: 'Step 1',
      promptTemplate: 'do step 1',
      model: 'claude-sonnet-5',
      permissionMode: 'default',
      autoAdvance: false,
      freshStart: false,
      ...(efforts.first ? { reasoningEffort: efforts.first } : {}),
    },
    {
      name: 'Step 2',
      promptTemplate: 'do step 2',
      model: secondModel,
      permissionMode: 'default',
      autoAdvance: false,
      freshStart: secondFreshStart,
      ...(efforts.second ? { reasoningEffort: efforts.second } : {}),
    },
  ],
});

function harness(secondModel: string, secondFreshStart: boolean, efforts: StepEfforts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-wf-provider-'));
  const state: WorkflowState = {
    workflowId: 'wf1',
    started: true,
    stepIndex: 0,
    stepStatuses: ['waiting-approval', 'pending'],
  };
  const session = {
    id: 's1',
    name: 's1',
    cwd: '/tmp',
    model: 'claude-sonnet-5',
    permissionMode: 'default',
    status: 'waiting-approval',
    createdAt: 1,
    workflow: state,
    // What step 1 left behind, so a step that sets no effort of its own can be
    // seen clearing it rather than inheriting.
    ...(efforts.first ? { reasoningEffort: efforts.first } : {}),
    // The conversation the second step would have to strand.
    claudeSessionId: 'claude-abc',
  } as SessionMeta;
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([session]));
  fs.writeFileSync(
    path.join(root, 'workflows.json'),
    JSON.stringify([twoStep(secondModel, secondFreshStart, efforts)]),
  );

  const broadcast = (_msg: ServerMessage) => {};
  const store = createStore(root);
  const sessions = new SessionManager(store, new GuardAllowlist(store), broadcast);
  const prompts: string[] = [];
  sessions.attachWorker({
    push: () => {},
    interrupt: () => {},
    close: () => {},
    setModel: () => {},
    setPermissionMode: () => {},
  } as never);
  const realPrompt = sessions.prompt.bind(sessions);
  sessions.prompt = ((id: string, text: string, ...rest: unknown[]) => {
    prompts.push(text);
    return realPrompt(id, text, ...(rest as []));
  }) as typeof sessions.prompt;
  const workflows = new WorkflowEngine(store, sessions, broadcast, 'u1');
  return { workflows, sessions, prompts, s1: () => sessions.get('s1')! };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A fresh-start step collects a git diff before it prompts, so its prompt lands
 *  a few macrotasks later than a plain one's. Poll rather than guess a delay. */
async function settleUntil(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
}

test('a step that changes provider without a fresh start is refused, not started', async () => {
  const h = harness('gpt-5.6-terra', false);
  h.workflows.approve('s1', 0);
  await settle();

  const m = h.s1();
  assert.equal(m.workflow!.stepFailure, 'pre-run');
  assert.equal(m.workflow!.stepStatuses[1], 'waiting-approval');
  assert.match(m.errorMessage ?? '', /cannot move between providers/);
  // The conversation is still there: a refused step must not have dropped it.
  assert.equal(m.claudeSessionId, 'claude-abc');
});

test('a fresh-start step may change provider, and the old conversation is dropped', async () => {
  const h = harness('gpt-5.6-terra', true);
  h.workflows.approve('s1', 0);
  await settle();

  const m = h.s1();
  assert.notEqual(m.workflow!.stepFailure, 'pre-run');
  assert.equal(m.workflow!.stepStatuses[1], 'running');
  assert.equal(m.model, 'gpt-5.6-terra');
  // Dropped before setModel, which would otherwise refuse the switch outright.
  assert.equal(m.claudeSessionId, undefined);
  await settleUntil(() => h.prompts.length > 0);
  assert.equal(h.prompts.length, 1);
});

test('a step applies its own reasoning effort to the session', async () => {
  const h = harness('claude-opus-5-5', false, { first: 'high', second: 'xhigh' });
  h.workflows.approve('s1', 0);
  await settle();

  assert.equal(h.s1().reasoningEffort, 'xhigh');
});

test('a step with no effort clears the previous step’s', async () => {
  // The leak: apply it only when the step names one and a single high-effort step
  // silently sets the price of every step after it.
  const h = harness('claude-opus-5-5', false, { first: 'high' });
  assert.equal(h.s1().reasoningEffort, 'high');

  h.workflows.approve('s1', 0);
  await settle();

  assert.equal(h.s1().reasoningEffort, undefined);
});

test('changing only the effort does not strand the conversation', async () => {
  // Unlike a model change, effort never crosses a provider — so there is nothing
  // to refuse and nothing to reset.
  const h = harness('claude-opus-5-5', false, { second: 'max' });
  h.workflows.approve('s1', 0);
  await settle();

  const m = h.s1();
  assert.equal(m.workflow!.stepStatuses[1], 'running');
  assert.equal(m.claudeSessionId, 'claude-abc');
});

test('an inheriting step after a manual provider switch starts fresh, not parked', async () => {
  // The wedge this flag exists to prevent: the user switched the session to codex
  // by hand, so the next Claude step *is* crossing providers while set to inherit
  // — the shape runStep refuses. But the conversation it would inherit is one the
  // switch already replaced, so there is nothing left to protect, and parking here
  // would strand the run behind an error only a workflow edit could clear.
  const h = harness('claude-opus-5-5', false);
  const m = h.s1();
  m.claudeSessionId = undefined;
  m.codexThreadId = 'th_1';
  m.model = 'gpt-5.6-terra';
  m.workflow!.providerSwitched = true;
  h.workflows.approve('s1', 0);
  await settle();

  const after = h.s1();
  assert.notEqual(after.workflow!.stepFailure, 'pre-run');
  assert.equal(after.workflow!.stepStatuses[1], 'running');
  assert.equal(after.model, 'claude-opus-5-5', 'the step took its own model back');
  assert.equal(after.codexThreadId, undefined, 'and the switched conversation was dropped');
  // One-shot: the step that consumed it must not leave it armed for the next one.
  assert.equal(after.workflow!.providerSwitched, undefined);
  await settleUntil(() => h.prompts.length > 0);
  assert.equal(h.prompts.length, 1, 'the step really ran');
});

test('without that flag, the same step still parks', async () => {
  // The guard the flag narrows is otherwise untouched: an authoring mistake — a
  // crossing step set to inherit, with nobody having switched anything — still
  // refuses to start.
  const h = harness('claude-opus-5-5', false);
  const m = h.s1();
  m.claudeSessionId = undefined;
  m.codexThreadId = 'th_1';
  m.model = 'gpt-5.6-terra';
  h.workflows.approve('s1', 0);
  await settle();

  assert.equal(h.s1().workflow!.stepFailure, 'pre-run');
  assert.match(h.s1().errorMessage ?? '', /cannot move between providers/);
});

test('a same-provider step still inherits the conversation', async () => {
  const h = harness('claude-opus-5-5', false);
  h.workflows.approve('s1', 0);
  await settle();

  const m = h.s1();
  assert.equal(m.workflow!.stepStatuses[1], 'running');
  assert.equal(m.model, 'claude-opus-5-5');
  assert.equal(m.claudeSessionId, 'claude-abc', 'no provider change, so nothing to drop');
});
