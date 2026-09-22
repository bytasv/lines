import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  ServerMessage,
  SessionMeta,
  TranscriptEvent,
  WorkflowDef,
  WorkflowMarkerData,
  WorkflowState,
} from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { WorkflowEngine } from './workflows.ts';

/** Three steps, each publishing a named output so the rollback's output pruning is visible. */
const wfDef: WorkflowDef = {
  id: 'wf1',
  name: 'test flow',
  steps: [0, 1, 2].map((n) => ({
    name: `Step ${n + 1}`,
    promptTemplate: `do step ${n + 1}{feedback}`,
    model: 'claude-sonnet-5',
    permissionMode: 'default' as const,
    outputName: `out${n}`,
    autoAdvance: false,
    freshStart: false,
  })),
};

const ev = (seq: number, kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent => ({
  seq,
  ts: seq,
  kind,
  data,
});
const marker = (seq: number, stepIndex: number, event: WorkflowMarkerData['event']) =>
  ev(seq, 'workflow', { stepIndex, stepName: `Step ${stepIndex + 1}`, event });
const assistant = (seq: number, uuid: string) =>
  ev(seq, 'sdk', { type: 'assistant', uuid, message: { content: [{ type: 'text', text: 'ok' }] } });

/**
 * A session two steps into the workflow. Step 0 ran and was approved, step 1 is
 * running. Seq 5 is step 1's prompt — the rewind target for most of these.
 */
const TRANSCRIPT: TranscriptEvent[] = [
  ev(0, 'user', { text: 'the task' }),
  marker(1, 0, 'started'),
  ev(2, 'user', { text: 'do step 1' }),
  assistant(3, 'uuid-step0'),
  marker(4, 1, 'started'),
  ev(5, 'user', { text: 'do step 2' }),
  assistant(6, 'uuid-step1'),
];

function harness(over: Partial<WorkflowState> = {}, events: TranscriptEvent[] = TRANSCRIPT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-wf-rewind-'));
  const workflow: WorkflowState = {
    workflowId: 'wf1',
    started: true,
    stepIndex: 1,
    stepStatuses: ['done', 'running', 'pending'],
    task: 'the task',
    outputs: { out0: 'step one output', out1: 'step two output' },
    stepCostsUsd: [0.5, 0.25, 0],
    lastStepOutput: 'step two output',
    ...over,
  };
  fs.writeFileSync(
    path.join(root, 'sessions.json'),
    JSON.stringify([
      {
        id: 's1',
        name: 's1',
        cwd: '/tmp',
        model: 'claude-opus-5-5',
        permissionMode: 'default',
        status: 'idle',
        createdAt: 1,
        claudeSessionId: 'cli-1',
        workflow,
      } as SessionMeta,
    ]),
  );
  fs.writeFileSync(path.join(root, 'workflows.json'), JSON.stringify([wfDef]));
  fs.mkdirSync(path.join(root, 'transcripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'transcripts', 's1.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

  const sent: ServerMessage[] = [];
  const broadcast = (msg: ServerMessage) => sent.push(msg);
  const store = createStore(root);
  const sessions = new SessionManager(store, new GuardAllowlist(store), broadcast);
  sessions.attachWorker({
    push: () => {},
    interrupt: () => {},
    close: () => {},
    setModel: () => {},
    setPermissionMode: () => {},
  } as never);
  // Registers the rewind listener in its constructor.
  const workflows = new WorkflowEngine(store, sessions, broadcast, 'u1');
  sessions.forkSession = async () => ({ sessionId: 'cli-2' });
  return { root, store, sessions, workflows, sent, s1: () => sessions.get('s1')! };
}

test('a rewind inside step 1 parks the workflow back on step 1', async () => {
  const h = harness();
  assert.equal((await h.sessions.rewindSession('s1', 5, { edit: true })).ok, true);
  const wf = h.s1().workflow!;
  assert.equal(wf.stepIndex, 1);
  assert.deepEqual(wf.stepStatuses, ['done', 'waiting-approval', 'pending']);
  // Parked, not idle: a typed prompt then iterates this same step and Approve
  // advances, which is the whole point of rewinding mid-workflow.
  assert.equal(h.s1().status, 'waiting-approval');
});

test('a rewind into an earlier step rolls the later steps back to pending', async () => {
  const h = harness();
  // Seq 2 is step 0's prompt, so step 1 never happened any more.
  assert.equal((await h.sessions.rewindSession('s1', 2)).ok, true);
  const wf = h.s1().workflow!;
  assert.equal(wf.stepIndex, 0);
  assert.deepEqual(wf.stepStatuses, ['waiting-approval', 'pending', 'pending']);
});

test('outputs published by rolled-back steps are dropped, earlier ones kept', async () => {
  const h = harness();
  await h.sessions.rewindSession('s1', 5);
  // out1 belongs to step 1, which is no longer finished; out0 is still earned.
  assert.deepEqual(h.s1().workflow!.outputs, { out0: 'step one output' });
});

test('a rollback past every step marker un-starts the workflow', async () => {
  const h = harness();
  // Seq 0 is the task description, before step 0's marker.
  assert.equal((await h.sessions.rewindSession('s1', 0)).ok, true);
  const wf = h.s1().workflow!;
  assert.equal(wf.started, false);
  assert.equal(wf.task, undefined);
  assert.equal(wf.stepIndex, 0);
  assert.deepEqual(wf.stepStatuses, ['pending', 'pending', 'pending']);
  assert.equal(wf.outputs, undefined);
  assert.equal(h.s1().status, 'idle', 'nothing to park on — the next prompt starts it again');
});

test('a pending advance and a failure verdict do not survive the rewind', async () => {
  const h = harness({
    advanceOnComplete: true,
    advanceOnCompleteStep: 1,
    advancing: true,
    stepFailure: 'turn',
  });
  await h.sessions.rewindSession('s1', 5);
  const wf = h.s1().workflow!;
  assert.equal(wf.advanceOnComplete, undefined);
  assert.equal(wf.advanceOnCompleteStep, undefined);
  assert.equal(wf.advancing, false);
  assert.equal(wf.stepFailure, undefined);
  // Absent, so the {previous} hand-off falls back to lastAssistantText over the
  // truncated transcript rather than a step output that was rewound away.
  assert.equal(wf.lastStepOutput, undefined);
});

/** The turns really ran, so their spend stays — same rule as a retry, which adds
 *  onto the same slot rather than resetting it. */
test('per-step spend is not rewound', async () => {
  const h = harness();
  await h.sessions.rewindSession('s1', 5);
  assert.deepEqual(h.s1().workflow!.stepCostsUsd, [0.5, 0.25, 0]);
});

/** findStepStart scans for the 'started' marker of the current step. If the
 *  rollback left stepIndex past the surviving markers it would return -1 and every
 *  hand-off would be cut from the wrong slice. */
test('the rolled-back step still has a start marker in the surviving transcript', async () => {
  const h = harness();
  await h.sessions.rewindSession('s1', 5);
  const kept = h.store.loadTranscript('s1');
  const stepIndex = h.s1().workflow!.stepIndex;
  const hasStart = kept.some(
    (e) =>
      e.kind === 'workflow' &&
      (e.data as WorkflowMarkerData).event === 'started' &&
      (e.data as WorkflowMarkerData).stepIndex === stepIndex,
  );
  assert.ok(hasStart, 'the parked step must still be findable by findStepStart');
});

/** The park marker is emitted after the truncation frame, so the client that just
 *  dropped everything at or after the cut still keeps it. */
test('the park marker is broadcast after the truncation', async () => {
  const h = harness();
  await h.sessions.rewindSession('s1', 5);
  const types = h.sent.map((m) => m.type);
  const truncated = types.indexOf('transcriptTruncated');
  assert.ok(truncated >= 0);
  const markerAt = h.sent.findIndex(
    (m, i) =>
      i > truncated &&
      m.type === 'event' &&
      m.event.kind === 'workflow' &&
      (m.event.data as WorkflowMarkerData).event === 'waiting-approval',
  );
  assert.ok(markerAt > truncated, 'the park marker must land after the truncation');
  // And it takes the seq the discarded tail freed up, so numbering stays dense.
  assert.equal(h.store.loadTranscript('s1').at(-1)!.seq, 5);
});

test('a rewind on a session with no workflow leaves it idle', async () => {
  const h = harness();
  delete h.s1().workflow;
  assert.equal((await h.sessions.rewindSession('s1', 5)).ok, true);
  assert.equal(h.s1().status, 'idle');
});
