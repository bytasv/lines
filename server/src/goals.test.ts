import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  GoalMarkerData,
  GoalState,
  ServerMessage,
  SessionMeta,
  TranscriptEvent,
  TurnSource,
  WorkflowState,
} from '@lines/shared';
import { clampGoalMaxTurns, GOAL_DEFAULT_MAX_TURNS, GOAL_MAX_TURNS_LIMIT } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { GoalEngine, goalContinuationText, parseGoalVerdict } from './goals.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { WorkflowEngine } from './workflows.ts';

const baseMeta = (extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 's1',
    name: 's1',
    cwd: '/tmp',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
    ...extra,
  }) as SessionMeta;

/**
 * A manager + goal engine over a throwaway store holding one session. The helper
 * (judge) answers from `judge`; `prompt` is replaced by a spy that records calls
 * and leaves the session as it was, so each test drives the settle by hand.
 */
function harness(extra: Partial<SessionMeta> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-goals-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([baseMeta(extra)]));
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
  sessions.prompt = ((_id: string, text: string, source: TurnSource = 'user') => {
    prompts.push({ text, source });
  }) as SessionManager['prompt'];
  const judge = { answer: '{"met": false, "reason": "tests still fail"}' as string | null, calls: 0 };
  sessions.helper = (async () => {
    judge.calls++;
    return judge.answer;
  }) as SessionManager['helper'];
  const goals = new GoalEngine(sessions);
  const s1 = () => sessions.get('s1')!;
  const markers = () => events.filter((e) => e.kind === 'goal').map((e) => (e.data as GoalMarkerData).event);
  return { root, store, sessions, goals, prompts, judge, events, s1, markers };
}

const activeGoal = (extra: Partial<GoalState> = {}): GoalState => ({
  condition: 'all tests pass',
  maxTurns: 3,
  turnsUsed: 0,
  status: 'active',
  setAt: 1,
  ...extra,
});

test('parseGoalVerdict reads strict JSON, fenced or bare, and nothing else', () => {
  assert.deepEqual(parseGoalVerdict('{"met": true, "reason": "done"}'), { met: true, reason: 'done' });
  assert.deepEqual(parseGoalVerdict('```json\n{"met": false, "reason": "no"}\n```'), { met: false, reason: 'no' });
  assert.equal(parseGoalVerdict(null), null);
  assert.equal(parseGoalVerdict('yes it is met'), null);
  assert.equal(parseGoalVerdict('{"met": "yes"}'), null);
  assert.equal(parseGoalVerdict('[true]'), null);
});

test('clampGoalMaxTurns clamps to 1..limit and defaults the unusable', () => {
  assert.equal(clampGoalMaxTurns(0), 1);
  assert.equal(clampGoalMaxTurns(-5), 1);
  assert.equal(clampGoalMaxTurns(500), GOAL_MAX_TURNS_LIMIT);
  assert.equal(clampGoalMaxTurns(7.6), 8);
  assert.equal(clampGoalMaxTurns(undefined), GOAL_DEFAULT_MAX_TURNS);
  assert.equal(clampGoalMaxTurns(Number.NaN), GOAL_DEFAULT_MAX_TURNS);
});

test('setGoal on an idle session starts the first turn as a goal turn and clamps maxTurns', () => {
  const h = harness();
  assert.deepEqual(h.goals.setGoal('s1', '  all tests pass  ', 999), { ok: true });
  assert.equal(h.s1().goal?.maxTurns, GOAL_MAX_TURNS_LIMIT);
  assert.equal(h.s1().goal?.condition, 'all tests pass');
  assert.equal(h.s1().goal?.status, 'active');
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].source, 'goal');
  assert.deepEqual(h.markers(), ['set']);
});

test('setGoal on a running session waits for the settle instead of prompting', () => {
  const h = harness({ status: 'running' });
  h.goals.setGoal('s1', 'x', undefined);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.s1().goal?.maxTurns, GOAL_DEFAULT_MAX_TURNS);
});

test('an unmet verdict re-prompts with source goal and counts the turn', async () => {
  const h = harness({ goal: activeGoal() });
  // The load loop pauses a persisted active goal (restart rule); re-arm it.
  h.s1().goal = activeGoal();
  await h.goals.onTurnComplete('s1', 'goal', false, false);
  assert.equal(h.judge.calls, 1);
  assert.equal(h.s1().goal?.turnsUsed, 1);
  assert.equal(h.s1().goal?.status, 'active');
  assert.equal(h.s1().goal?.lastVerdict?.met, false);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].source, 'goal');
  assert.equal(h.prompts[0].text, goalContinuationText('all tests pass', 'tests still fail'));
  assert.deepEqual(h.markers(), ['unmet']);
});

test('user-source turns are judged too', async () => {
  const h = harness();
  h.s1().goal = activeGoal();
  await h.goals.onTurnComplete('s1', 'user', false, false);
  assert.equal(h.judge.calls, 1);
  assert.equal(h.prompts.length, 1);
});

test('a met verdict marks the goal met and does not prompt', async () => {
  const h = harness();
  h.s1().goal = activeGoal();
  h.judge.answer = '{"met": true, "reason": "all green"}';
  await h.goals.onTurnComplete('s1', 'goal', false, false);
  assert.equal(h.s1().goal?.status, 'met');
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.markers(), ['met']);
});

test('reaching maxTurns with an unmet verdict pauses on the cap', async () => {
  const h = harness();
  h.s1().goal = activeGoal({ maxTurns: 2, turnsUsed: 2 });
  await h.goals.onTurnComplete('s1', 'goal', false, false);
  assert.equal(h.s1().goal?.status, 'paused');
  assert.equal(h.s1().goal?.pauseReason, 'cap');
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.markers(), ['paused']);
});

test('an interrupted turn stops the goal without judging or prompting', async () => {
  const h = harness();
  h.s1().goal = activeGoal();
  await h.goals.onTurnComplete('s1', 'goal', true, false);
  assert.equal(h.s1().goal?.status, 'stopped');
  assert.equal(h.judge.calls, 0);
  assert.equal(h.prompts.length, 0);
});

test('a failed turn pauses with turn-failed and is not retried', async () => {
  const h = harness();
  h.s1().goal = activeGoal();
  await h.goals.onTurnComplete('s1', 'goal', false, true);
  assert.equal(h.s1().goal?.status, 'paused');
  assert.equal(h.s1().goal?.pauseReason, 'turn-failed');
  assert.equal(h.judge.calls, 0);
  assert.equal(h.prompts.length, 0);
});

for (const answer of [null, 'not json']) {
  test(`a judge answer of ${JSON.stringify(answer)} pauses with judge-failed`, async () => {
    const h = harness();
    h.s1().goal = activeGoal();
    h.judge.answer = answer;
    await h.goals.onTurnComplete('s1', 'goal', false, false);
    assert.equal(h.s1().goal?.status, 'paused');
    assert.equal(h.s1().goal?.pauseReason, 'judge-failed');
    assert.equal(h.prompts.length, 0);
  });
}

test('a prompt queued while the judge runs wins over the auto-continue', async () => {
  const h = harness();
  h.s1().goal = activeGoal();
  h.sessions.helper = (async () => {
    // The user queued something while the judge was reading the turn.
    h.s1().queued = [{ id: 'q1', text: 'mine first', ts: 1 } as never];
    return '{"met": false, "reason": "no"}';
  }) as SessionManager['helper'];
  await h.goals.onTurnComplete('s1', 'goal', false, false);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.s1().goal?.status, 'active', 'judged again when that turn settles');
  assert.equal(h.s1().goal?.turnsUsed, 0);
});

test('clearing the goal while the judge runs drops the verdict', async () => {
  const h = harness();
  h.s1().goal = activeGoal();
  h.sessions.helper = (async () => {
    h.goals.clearGoal('s1');
    return '{"met": false, "reason": "no"}';
  }) as SessionManager['helper'];
  await h.goals.onTurnComplete('s1', 'goal', false, false);
  assert.equal(h.s1().goal, undefined);
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.markers(), ['cleared']);
});

test('setGoal on a paused goal resets turnsUsed and resumes it', () => {
  const h = harness();
  h.s1().goal = activeGoal({ status: 'paused', pauseReason: 'cap', turnsUsed: 3 });
  h.goals.setGoal('s1', 'all tests pass', 5);
  assert.equal(h.s1().goal?.status, 'active');
  assert.equal(h.s1().goal?.turnsUsed, 0);
  assert.equal(h.s1().goal?.pauseReason, undefined);
  assert.equal(h.prompts.length, 1);
});

const wfState = (statuses: WorkflowState['stepStatuses'], started = true): WorkflowState => ({
  workflowId: 'wf1',
  started,
  stepIndex: 0,
  stepStatuses: statuses,
});

test('setGoal is refused while a workflow is unfinished, allowed once it is done', () => {
  const h = harness({ workflow: wfState(['running', 'pending']) });
  const refused = h.goals.setGoal('s1', 'x', 3);
  assert.equal(refused.ok, false);
  assert.equal(h.s1().goal, undefined);
  h.s1().workflow = wfState(['done', 'done']);
  assert.equal(h.goals.setGoal('s1', 'x', 3).ok, true);
});

test('a workflow does not start while a goal is active', () => {
  const h = harness({ workflow: wfState(['pending'], false) });
  h.s1().goal = activeGoal();
  const workflows = new WorkflowEngine(h.store, h.sessions, () => {}, 'u1');
  assert.equal(workflows.startIfPending('s1', 'task'), false);
  assert.equal(h.s1().workflow?.started, false);
});

test('clearGoal removes the goal and marks it', () => {
  const h = harness();
  h.s1().goal = activeGoal();
  h.goals.clearGoal('s1');
  assert.equal(h.s1().goal, undefined);
  assert.deepEqual(h.markers(), ['cleared']);
});

test('every turn-complete listener fires, the setTurnCompleteListener alias included', () => {
  const h = harness();
  const seen: string[] = [];
  h.sessions.setTurnCompleteListener(() => seen.push('alias'));
  h.sessions.addTurnCompleteListener(() => seen.push('added'));
  (h.sessions as unknown as { onTurnComplete: (...a: unknown[]) => void }).onTurnComplete('s1', 'user', false, false);
  assert.deepEqual(seen, ['alias', 'added']);
});

for (const status of ['active', 'evaluating'] as const) {
  test(`a persisted ${status} goal loads paused with restart`, () => {
    const h = harness({ goal: activeGoal({ status }) });
    assert.equal(h.s1().goal?.status, 'paused');
    assert.equal(h.s1().goal?.pauseReason, 'restart');
  });
}

test('a met goal loads as it was', () => {
  const h = harness({ goal: activeGoal({ status: 'met' }) });
  assert.equal(h.s1().goal?.status, 'met');
});

test('adoptSynced keeps the local goal and never takes a remote one', () => {
  const h = harness();
  const local = activeGoal({ condition: 'local' });
  h.s1().goal = local;
  h.sessions.adoptSynced(baseMeta({ updatedAt: Date.now() + 10_000, goal: activeGoal({ condition: 'remote' }) }));
  assert.equal(h.s1().goal, local);

  const fresh = harness();
  fresh.sessions.adoptSynced(
    baseMeta({ id: 's2', updatedAt: Date.now() + 10_000, goal: activeGoal({ condition: 'remote' }) }),
  );
  assert.equal(fresh.sessions.get('s2')?.goal, undefined);
});

test('the session goal engine leaves a workflow session to its step goal', async () => {
  const h = harness({ workflow: wfState(['running', 'pending']) });
  h.s1().goal = activeGoal();
  await h.goals.onTurnComplete('s1', 'workflow', false, false);
  assert.equal(h.judge.calls, 0);
  assert.equal(h.prompts.length, 0);
});
