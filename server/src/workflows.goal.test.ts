import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  GoalMarkerData,
  ServerMessage,
  SessionMeta,
  StepGoal,
  TranscriptEvent,
  TurnSource,
  WorkflowDef,
  WorkflowState,
} from '@lines/shared';
import { GOAL_MAX_TURNS_LIMIT, sanitizeStepGoal, sanitizeStepOverrides } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import type { GoalVerdict } from './goals.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { WorkflowEngine } from './workflows.ts';

const wfDef = (stepCount: number, autoAdvance = false): WorkflowDef => ({
  id: 'wf1',
  name: 'test flow',
  steps: Array.from({ length: stepCount }, (_, n) => ({
    name: `Step ${n + 1}`,
    promptTemplate: `do step ${n + 1}{feedback}`,
    model: 'claude-sonnet-5-5',
    permissionMode: 'default' as const,
    autoAdvance,
    freshStart: false,
  })),
});

/**
 * A manager + workflow engine over a throwaway store: one session with step 0 of a
 * `stepCount`-step workflow in `step0` state. `prompts` records every prompt (the
 * real one still runs, so the session goes 'running' as it would). The step-goal
 * judge answers from `judge.next`.
 */
function harness(
  stepCount: number,
  opts: {
    step0?: WorkflowState['stepStatuses'][number];
    workflow?: Partial<WorkflowState>;
    meta?: Partial<SessionMeta>;
    autoAdvance?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-stepgoal-'));
  const step0 = opts.step0 ?? 'running';
  const state: WorkflowState = {
    workflowId: 'wf1',
    started: true,
    stepIndex: 0,
    stepStatuses: Array.from({ length: stepCount }, (_, n) => (n === 0 ? step0 : 'pending')),
    ...opts.workflow,
  };
  const meta = {
    id: 's1',
    name: 's1',
    cwd: '/tmp',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    status: step0 === 'waiting-approval' ? 'waiting-approval' : 'idle',
    createdAt: 1,
    workflow: state,
    ...opts.meta,
  } as SessionMeta;
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta]));
  fs.writeFileSync(path.join(root, 'workflows.json'), JSON.stringify([wfDef(stepCount, opts.autoAdvance)]));

  const events: TranscriptEvent[] = [];
  const broadcast = (msg: ServerMessage) => {
    if (msg.type === 'event') events.push(msg.event);
  };
  const store = createStore(root);
  const sessions = new SessionManager(store, new GuardAllowlist(store), broadcast);
  sessions.attachWorker({
    push: () => {},
    interrupt: () => {},
    close: () => {},
    setModel: () => {},
    setPermissionMode: () => {},
    rpcResult: () => {},
  } as never);
  const prompts: { text: string; source: TurnSource }[] = [];
  const realPrompt = sessions.prompt.bind(sessions);
  sessions.prompt = ((id: string, text: string, source: TurnSource = 'user', ...rest: never[]) => {
    prompts.push({ text, source });
    return realPrompt(id, text, source, ...rest);
  }) as SessionManager['prompt'];
  const workflows = new WorkflowEngine(store, sessions, broadcast, 'u1');
  const judge = { next: { met: false, reason: 'tests still fail' } as GoalVerdict | null, calls: 0 };
  workflows.setGoalJudge(async () => {
    judge.calls++;
    return judge.next;
  });
  const s1 = () => sessions.get('s1')!;
  const goalMarkers = () => events.filter((e) => e.kind === 'goal').map((e) => (e.data as GoalMarkerData).event);
  /** Mark a turn live as `source`, the way prompt() would have. */
  const live = (source: TurnSource) => {
    s1().status = 'running';
    s1().turnSource = source;
  };
  const result = () => sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  return { root, store, sessions, workflows, prompts, judge, events, s1, goalMarkers, live, result };
}

const stepGoal = (extra: Partial<StepGoal> = {}): StepGoal => ({
  condition: 'e2e passes',
  maxTurns: 3,
  turnsUsed: 0,
  status: 'active',
  setAt: 1,
  stepIndex: 0,
  onMet: 'advance',
  ...extra,
});

/** Let the void-ed judge (and the advance/runStep it may start) run to completion. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

test('sanitizeStepGoal trims, clamps and defaults onMet', () => {
  assert.deepEqual(sanitizeStepGoal({ condition: '  works  ', maxTurns: 999 }), {
    condition: 'works',
    maxTurns: GOAL_MAX_TURNS_LIMIT,
    onMet: 'advance',
  });
  assert.equal(sanitizeStepGoal({ condition: '   ' }), null);
  assert.equal(sanitizeStepGoal(null), null);
  assert.equal(sanitizeStepGoal({ condition: 'x', onMet: 'wait' })?.onMet, 'wait');
});

test('sanitizeStepOverrides keeps a goal-only override', () => {
  const out = sanitizeStepOverrides([{ goal: { condition: 'x', maxTurns: 2 } }, { goal: { condition: '' } }], 2);
  assert.deepEqual(out, [{ goal: { condition: 'x', maxTurns: 2, onMet: 'advance' } }, null]);
});

test('without a goal a settled step parks exactly as before', async () => {
  const h = harness(2);
  h.live('workflow');
  h.result();
  await settle();
  assert.equal(h.judge.calls, 0);
  assert.equal(h.s1().workflow?.stepStatuses[0], 'waiting-approval');
});

test('an unmet step goal re-prompts the same step as a goal turn', async () => {
  const h = harness(2);
  h.s1().workflow!.stepGoal = stepGoal();
  h.live('workflow');
  h.result();
  await settle();
  assert.equal(h.judge.calls, 1);
  assert.equal(h.s1().workflow?.stepStatuses[0], 'running');
  assert.equal(h.s1().workflow?.stepGoal?.turnsUsed, 1);
  assert.equal(h.prompts.at(-1)?.source, 'goal');
  assert.equal(h.s1().turnSource, 'goal');
  assert.deepEqual(h.goalMarkers(), ['unmet']);

  // The goal turn is the step's own: its settle is judged again.
  h.judge.next = { met: false, reason: 'still red' };
  h.result();
  await settle();
  assert.equal(h.judge.calls, 2);
  assert.equal(h.s1().workflow?.stepGoal?.turnsUsed, 2);
});

test('a met goal with onMet advance moves to the next step', async () => {
  const h = harness(2);
  h.s1().workflow!.stepGoal = stepGoal();
  h.judge.next = { met: true, reason: 'green' };
  h.live('workflow');
  h.result();
  await settle();
  assert.equal(h.s1().workflow?.stepIndex, 1);
  assert.deepEqual(h.s1().workflow?.stepStatuses, ['done', 'running']);
  assert.equal(h.s1().workflow?.stepGoal, undefined, 'the goal was the finished step’s');
  assert.ok(h.goalMarkers().includes('met'));
});

test('a met goal with onMet wait parks for approval', async () => {
  const h = harness(2);
  h.s1().workflow!.stepGoal = stepGoal({ onMet: 'wait' });
  h.judge.next = { met: true, reason: 'green' };
  h.live('workflow');
  h.result();
  await settle();
  assert.equal(h.s1().workflow?.stepIndex, 0);
  assert.equal(h.s1().workflow?.stepStatuses[0], 'waiting-approval');
  assert.equal(h.s1().workflow?.stepGoal?.status, 'met');
});

test('the goal decides even on an autoAdvance step', async () => {
  const h = harness(2, { autoAdvance: true });
  h.s1().workflow!.stepGoal = stepGoal();
  h.live('workflow');
  h.result();
  await settle();
  assert.equal(h.s1().workflow?.stepIndex, 0, 'unmet: no advance');
  assert.equal(h.prompts.at(-1)?.source, 'goal');
});

test('an unmet goal at its cap parks with the goal paused', async () => {
  const h = harness(2);
  h.s1().workflow!.stepGoal = stepGoal({ maxTurns: 1, turnsUsed: 1 });
  h.live('goal');
  h.result();
  await settle();
  assert.equal(h.s1().workflow?.stepStatuses[0], 'waiting-approval');
  assert.equal(h.s1().workflow?.stepGoal?.status, 'paused');
  assert.equal(h.s1().workflow?.stepGoal?.pauseReason, 'cap');
});

test('a failed judge parks with judge-failed', async () => {
  const h = harness(2);
  h.s1().workflow!.stepGoal = stepGoal();
  h.judge.next = null;
  h.live('workflow');
  h.result();
  await settle();
  assert.equal(h.s1().workflow?.stepStatuses[0], 'waiting-approval');
  assert.equal(h.s1().workflow?.stepGoal?.pauseReason, 'judge-failed');
});

test('Stop parks the step and stops the goal without judging', async () => {
  const h = harness(2);
  h.s1().workflow!.stepGoal = stepGoal();
  h.live('workflow');
  h.sessions.interrupt('s1');
  h.result();
  await settle();
  assert.equal(h.judge.calls, 0);
  assert.equal(h.s1().workflow?.stepStatuses[0], 'waiting-approval');
  assert.equal(h.s1().workflow?.stepGoal?.status, 'stopped');
});

test('a failed turn parks failed and pauses the goal, no retry', async () => {
  const h = harness(2);
  h.s1().workflow!.stepGoal = stepGoal();
  h.live('workflow');
  h.sessions.handleWorkerEvent('s1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['boom'],
  });
  await settle();
  assert.equal(h.judge.calls, 0);
  assert.equal(h.s1().workflow?.stepFailure, 'turn');
  assert.equal(h.s1().workflow?.stepGoal?.pauseReason, 'turn-failed');
  assert.equal(h.prompts.length, 0);
});

test('a prompt queued while the judge runs iterates the step instead', async () => {
  const h = harness(2);
  h.s1().workflow!.stepGoal = stepGoal();
  let release!: (v: GoalVerdict) => void;
  h.workflows.setGoalJudge(() => new Promise((r) => (release = r)));
  h.live('workflow');
  h.result();
  assert.equal(h.s1().workflow?.stepGoal?.status, 'evaluating');
  // The step goal being judged makes the session busy, so this is queued.
  h.sessions.userPrompt('s1', 'mine first');
  assert.equal(h.s1().queued?.length, 1);
  release({ met: false, reason: 'no' });
  await settle();
  assert.equal(h.prompts.at(-1)?.text, 'mine first');
  assert.equal(h.s1().workflow?.stepGoal?.status, 'active');
  assert.equal(h.s1().workflow?.stepGoal?.turnsUsed, 0);
});

test('a plan-approval advance wins over an active goal', async () => {
  const h = harness(2, { workflow: { advanceOnComplete: true, advanceOnCompleteStep: 0 } });
  h.s1().workflow!.stepGoal = stepGoal();
  h.live('workflow');
  h.result();
  await settle();
  assert.equal(h.judge.calls, 0);
  assert.equal(h.s1().workflow?.stepIndex, 1);
  assert.equal(h.s1().workflow?.stepGoal, undefined);
});

test('setting a goal on a parked step sends it back to work', () => {
  const h = harness(2, { step0: 'waiting-approval' });
  assert.deepEqual(h.workflows.setStepGoal('s1', 'e2e passes', 4, 'wait'), { ok: true });
  assert.equal(h.s1().workflow?.stepStatuses[0], 'running');
  assert.equal(h.prompts.at(-1)?.source, 'goal');
  assert.equal(h.s1().workflow?.stepGoal?.onMet, 'wait');
  assert.equal(h.s1().workflow?.stepGoal?.maxTurns, 4);
});

test('setting a goal on a running step waits for its settle', () => {
  const h = harness(2);
  h.live('workflow');
  h.workflows.setStepGoal('s1', 'e2e passes', undefined, undefined);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.s1().workflow?.stepGoal?.status, 'active');
  assert.equal(h.s1().workflow?.stepGoal?.onMet, 'advance');
});

test('a goal planned in the overrides is seeded when its step starts', async () => {
  const h = harness(2, {
    step0: 'waiting-approval',
    workflow: { stepOverrides: [null, { goal: { condition: 'deployed', maxTurns: 2, onMet: 'wait' } }] },
  });
  h.workflows.approve('s1', 0);
  await settle();
  assert.equal(h.s1().workflow?.stepIndex, 1);
  assert.equal(h.s1().workflow?.stepGoal?.condition, 'deployed');
  assert.equal(h.s1().workflow?.stepGoal?.stepIndex, 1);
  assert.match(h.prompts.at(-1)!.text, /deployed/, 'the goal rides the step prompt');
});

test('clearing the goal falls back to the step’s own rule', async () => {
  const h = harness(2);
  h.s1().workflow!.stepGoal = stepGoal();
  h.workflows.clearStepGoal('s1');
  h.live('workflow');
  h.result();
  await settle();
  assert.equal(h.judge.calls, 0);
  assert.equal(h.s1().workflow?.stepStatuses[0], 'waiting-approval');
});

for (const status of ['active', 'evaluating'] as const) {
  test(`a persisted ${status} step goal loads paused with restart`, () => {
    const h = harness(2, { workflow: { stepGoal: stepGoal({ status }) } });
    assert.equal(h.s1().workflow?.stepGoal?.status, 'paused');
    assert.equal(h.s1().workflow?.stepGoal?.pauseReason, 'restart');
  });
}

test('adoptSynced keeps the local step goal and planned goals', () => {
  const h = harness(2, {
    workflow: { stepOverrides: [null, { goal: { condition: 'local', maxTurns: 2, onMet: 'advance' } }] },
  });
  const local = stepGoal({ condition: 'local', status: 'paused' });
  h.s1().workflow!.stepGoal = local;
  const remote = structuredClone(h.s1());
  remote.updatedAt = Date.now() + 10_000;
  remote.workflow!.stepGoal = stepGoal({ condition: 'remote' });
  remote.workflow!.stepOverrides = [
    { goal: { condition: 'remote', maxTurns: 2, onMet: 'advance' } },
    { model: 'claude-sonnet-5-5', goal: { condition: 'remote', maxTurns: 2, onMet: 'advance' } },
  ];
  h.sessions.adoptSynced(remote);
  assert.equal(h.s1().workflow?.stepGoal, local);
  assert.deepEqual(h.s1().workflow?.stepOverrides, [
    null,
    { model: 'claude-sonnet-5-5', goal: { condition: 'local', maxTurns: 2, onMet: 'advance' } },
  ]);
});
