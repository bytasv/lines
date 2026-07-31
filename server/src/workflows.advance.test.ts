import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  SessionMeta,
  ServerMessage,
  TranscriptEvent,
  WorkflowDef,
  WorkflowMarkerData,
  WorkflowState,
} from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { WorkflowEngine } from './workflows.ts';

const wfDef = (stepCount: number, autoAdvance = false): WorkflowDef => ({
  id: 'wf1',
  name: 'test flow',
  steps: Array.from({ length: stepCount }, (_, n) => ({
    name: `Step ${n + 1}`,
    promptTemplate: `do step ${n + 1}{feedback}`,
    model: 'claude-sonnet-5',
    permissionMode: 'default' as const,
    autoAdvance,
    // No fresh start: keeps runStep off the git/diff hand-off path in a temp dir.
    freshStart: false,
  })),
});

const meta = (workflow: WorkflowState): SessionMeta =>
  ({
    id: 's1',
    name: 's1',
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    caveman: { enabled: false, level: 'full' },
    status: 'waiting-approval',
    createdAt: 1,
    workflow,
  }) as SessionMeta;

/**
 * A manager + engine over a throwaway store holding one session parked mid-workflow.
 * `upserts` collects every broadcast session meta, in order — the wire the client sees;
 * `events` collects the transcript events alongside it (workflow markers included).
 */
function harness(stepCount: number, workflow: Partial<WorkflowState> = {}, autoAdvance = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-advance-'));
  const state: WorkflowState = {
    workflowId: 'wf1',
    started: true,
    stepIndex: 0,
    stepStatuses: Array.from({ length: stepCount }, (_, n) => (n === 0 ? 'waiting-approval' : 'pending')),
    ...workflow,
  };
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta(state)]));
  fs.writeFileSync(path.join(root, 'workflows.json'), JSON.stringify([wfDef(stepCount, autoAdvance)]));

  const upserts: SessionMeta[] = [];
  const events: TranscriptEvent[] = [];
  const broadcast = (msg: ServerMessage) => {
    // Snapshot: metas are mutated in place, so the live object would show final state.
    if (msg.type === 'sessionUpsert') upserts.push(structuredClone(msg.session));
    if (msg.type === 'event') events.push(msg.event);
  };
  const store = createStore(root);
  const sessions = new SessionManager(store, new GuardAllowlist(store), broadcast);
  sessions.attachWorker({
    push: () => {},
    interrupt: () => {},
    setModel: () => {},
    setPermissionMode: () => {},
  } as never);
  const workflows = new WorkflowEngine(store, sessions, broadcast, 'u1');
  return { root, store, sessions, workflows, upserts, events, s1: () => sessions.get('s1')! };
}

/** One session mid-step: step 0 running, and its turn live and workflow-sourced. */
function running(stepCount: number, opts: { autoAdvance?: boolean; workflow?: Partial<WorkflowState> } = {}) {
  const h = harness(
    stepCount,
    {
      stepIndex: 0,
      stepStatuses: Array.from({ length: stepCount }, (_, n) => (n === 0 ? 'running' : 'pending')),
      ...opts.workflow,
    },
    opts.autoAdvance,
  );
  const m = h.s1();
  m.status = 'running';
  m.turnSource = 'workflow';
  return h;
}

const markerEvents = (h: ReturnType<typeof harness>) =>
  h.events.filter((e) => e.kind === 'workflow').map((e) => (e.data as WorkflowMarkerData).event);

/** Let the void-ed advance() chain (and the runStep it queues) run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('approve raises the in-flight flag in the same tick as the click', () => {
  const h = harness(2);
  h.workflows.approve('s1', 0);

  // No await yet: the flag must already be on the wire, before consolidation.
  const flagged = h.upserts.filter((m) => m.workflow?.advancing === true);
  assert.equal(flagged.length, 1, 'exactly one advancing broadcast, synchronously');
  assert.equal(flagged[0].workflow!.stepStatuses[0], 'done', 'the finished step is already done');
});

test('the flag clears once the next step starts', async () => {
  const h = harness(2);
  h.workflows.approve('s1', 0);
  await settle();

  const last = h.upserts.at(-1)!;
  assert.equal(last.workflow?.advancing, false);
  assert.equal(last.workflow?.stepIndex, 1);
  assert.equal(last.workflow?.stepStatuses[1], 'running');
  // Nothing after the clear may still claim an advance is in flight.
  const flags = h.upserts.map((m) => m.workflow?.advancing);
  const lastFlagged = flags.lastIndexOf(true);
  const lastCleared = flags.lastIndexOf(false);
  assert.ok(lastCleared > lastFlagged, 'the terminal broadcast is the cleared one');
});

test('the flag clears when the last step finishes the workflow', async () => {
  const h = harness(1);
  h.workflows.approve('s1', 0);
  await settle();

  const last = h.upserts.at(-1)!;
  assert.equal(last.workflow?.advancing, false);
  assert.equal(last.status, 'idle');
});

test('a consolidation failure still clears the flag', async () => {
  const h = harness(2);
  h.sessions.consolidateStepOutput = async () => {
    throw new Error('one-shot query failed');
  };
  h.workflows.approve('s1', 0);
  await settle();

  assert.equal(h.s1().workflow?.advancing, false, 'in memory');
  assert.equal(h.upserts.at(-1)!.workflow?.advancing, false, 'and re-broadcast');
});

test('a flag persisted by a crashed process is cleared on load', () => {
  const h = harness(2, { advancing: true, stepStatuses: ['done', 'pending'] });
  assert.equal(h.s1().workflow?.advancing, false, 'cleared by the constructor load loop');
});

test('a hand-off from another instance never inherits the flag', () => {
  const h = harness(2);
  const synced = meta({
    workflowId: 'wf1',
    started: true,
    stepIndex: 0,
    stepStatuses: ['done', 'pending'],
    advancing: true,
  });
  synced.updatedAt = 999; // LWW: must beat the locally loaded copy to be adopted
  synced.status = 'running'; // and exercise the existing isSessionActive reset alongside
  h.sessions.adoptSynced(synced);
  assert.equal(h.s1().workflow?.advancing, false);
});

test('reconcile leaves a live advance alone', () => {
  // The rejected alternative: clearing in reconcileWithWorker would kill the flag
  // mid-consolidation on a healthy bridge, every time the worker reports in.
  const h = harness(2, { advancing: true, stepStatuses: ['done', 'pending'] });
  const m = h.s1();
  m.workflow!.advancing = true;
  m.status = 'running';
  h.sessions.reconcileWithWorker([{ sessionId: 's1', busy: true }]);
  assert.equal(h.s1().workflow?.advancing, true);
});

test('Stop does not flag an advance', async () => {
  const h = running(2);
  h.workflows.forceAdvanceSettleMs = 5;
  h.sessions.interrupt('s1');

  assert.equal(h.s1().workflow?.advanceOnComplete, undefined, 'Stop means stop, not "step done"');
  assert.equal(h.s1().status, 'idle');
  assert.equal(h.s1().workflow?.stepStatuses[0], 'running', 'still the current step until it settles');

  // Only an explicit force-advance arms the watchdog: a plain Stop must still park.
  await sleep(20);
  assert.equal(h.s1().workflow?.stepIndex, 0, 'no watchdog fired');
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  assert.equal(h.s1().workflow?.stepStatuses[0], 'waiting-approval');
});

test('a stopped step parks on the SDK result', () => {
  const h = running(2);
  h.sessions.interrupt('s1');
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });

  assert.deepEqual(h.s1().workflow?.stepStatuses, ['waiting-approval', 'pending']);
  assert.equal(h.s1().status, 'waiting-approval');
  assert.equal(h.s1().workflow?.stepIndex, 0);
});

test('a stopped step parks when the query ends without a result', () => {
  const h = running(2);
  h.sessions.interrupt('s1');
  h.sessions.handleWorkerEnded('s1');

  assert.deepEqual(h.s1().workflow?.stepStatuses, ['waiting-approval', 'pending']);
  assert.equal(h.s1().status, 'waiting-approval');
  assert.equal(h.s1().workflow?.stepIndex, 0);
});

test('Stop parks an autoAdvance step', () => {
  // Stop is explicit intent to halt: the toggle does not get to override it.
  const onResult = running(2, { autoAdvance: true });
  onResult.sessions.interrupt('s1');
  onResult.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });

  assert.equal(onResult.s1().workflow?.stepStatuses[0], 'waiting-approval');
  assert.equal(onResult.s1().workflow?.stepIndex, 0);

  // Same for a query that dies without emitting a final result.
  const onEnded = running(2, { autoAdvance: true });
  onEnded.sessions.interrupt('s1');
  onEnded.sessions.handleWorkerEnded('s1');

  assert.equal(onEnded.s1().workflow?.stepStatuses[0], 'waiting-approval');
  assert.equal(onEnded.s1().workflow?.stepIndex, 0);
});

test('Stop discards a pending plan-approval advance', () => {
  // The plan was approved, then the user stopped before the turn ended.
  const h = running(2, { workflow: { advanceOnComplete: true, advanceOnCompleteStep: 0 } });
  h.sessions.interrupt('s1');
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });

  assert.equal(h.s1().workflow?.stepStatuses[0], 'waiting-approval');
  assert.equal(h.s1().workflow?.stepIndex, 0);
  // Flag and stamp both gone, so no later settle can replay the advance.
  assert.equal(h.s1().workflow?.advanceOnComplete, undefined);
  assert.equal(h.s1().workflow?.advanceOnCompleteStep, undefined);
});

test('autoAdvance still advances on a normal settle', async () => {
  const h = running(2, { autoAdvance: true });
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  await settle();

  assert.equal(h.s1().workflow?.stepIndex, 1);
  assert.equal(h.s1().workflow?.stepStatuses[1], 'running');
});

test('a plan-approval advance still fires on a normal settle', async () => {
  const h = running(2, { workflow: { advanceOnComplete: true, advanceOnCompleteStep: 0 } });
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  await settle();

  assert.equal(h.s1().workflow?.stepIndex, 1);
  assert.equal(h.s1().workflow?.stepStatuses[1], 'running');
  assert.ok(markerEvents(h).includes('approved'));
});

test('a queued follow-up survives the park', () => {
  const h = running(2);
  h.sessions.userPrompt('s1', 'also do X');
  h.sessions.interrupt('s1');
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });

  assert.equal(h.s1().workflow?.stepStatuses[0], 'waiting-approval');
  assert.equal(h.s1().status, 'waiting-approval');
  // Held, not consumed: the park must not swallow the follow-up into a re-run.
  assert.equal(h.s1().queued?.length, 1);
  assert.equal(h.s1().queuePaused, true);
});

test('force-advance still advances a running step', async () => {
  const h = running(2);
  h.workflows.forceAdvance('s1', 0);

  assert.equal(h.s1().workflow?.advanceOnComplete, 'interrupted', 'flagged by forceAdvance itself');
  assert.equal(h.s1().status, 'idle', 'and the live turn is stopped');

  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  await settle();

  assert.equal(h.s1().workflow?.stepStatuses[0], 'done');
  assert.equal(h.s1().workflow?.stepIndex, 1);
  assert.equal(h.s1().workflow?.stepStatuses[1], 'running');
  assert.ok(markerEvents(h).includes('interrupted'), 'the stop-and-complete marker');
});

test("force-advance advances even when the live turn isn't the step's own", async () => {
  const h = running(2);
  h.s1().turnSource = 'user'; // e.g. a worker error skipped the settle, then the user typed
  h.workflows.forceAdvance('s1', 0);

  // The step stamp — not the turn source — is what keeps the flag off a later step.
  assert.equal(h.s1().workflow?.advanceOnComplete, 'interrupted');
  assert.equal(h.s1().workflow?.advanceOnCompleteStep, 0);

  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  await settle();

  assert.equal(h.s1().workflow?.stepIndex, 1);
  assert.equal(h.s1().workflow?.stepStatuses[1], 'running');
  assert.ok(markerEvents(h).includes('interrupted'));
});

test('a user prompt clears a pending force-advance flag', () => {
  const h = running(2);
  h.workflows.forceAdvance('s1', 0);
  h.sessions.prompt('s1', 'hold on', 'user');

  assert.equal(h.s1().workflow?.advanceOnComplete, undefined);
  assert.equal(h.s1().workflow?.advanceOnCompleteStep, undefined, 'the stamp goes with it');
});

test('a flag stamped for an earlier step is not honored', async () => {
  const h = harness(3, {
    stepIndex: 1,
    stepStatuses: ['done', 'running', 'pending'],
    advanceOnComplete: 'interrupted',
    advanceOnCompleteStep: 0, // left over from a step-0 force-advance
  });
  const m = h.s1();
  m.status = 'running';
  m.turnSource = 'workflow';
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  await settle();

  assert.equal(h.s1().workflow?.stepIndex, 1, 'the stale stamp advanced nothing');
  assert.equal(h.s1().workflow?.stepStatuses[1], 'waiting-approval', 'it parked normally instead');
});

test('the watchdog advances when the interrupted turn never settles', async () => {
  const h = running(2);
  h.workflows.forceAdvanceSettleMs = 5;
  h.workflows.forceAdvance('s1', 0);
  // No 'result', no 'ended' — a wedged worker.
  await sleep(20);
  await settle();

  assert.equal(h.s1().workflow?.stepIndex, 1);
  assert.equal(h.s1().workflow?.stepStatuses[1], 'running');
  assert.equal(h.s1().workflow?.advanceOnComplete, undefined, 'the flag was consumed, not left set');
  assert.ok(markerEvents(h).includes('interrupted'));
});

test('a late result after the watchdog advanced does not touch the next step', async () => {
  const h = running(2);
  h.workflows.forceAdvanceSettleMs = 5;
  // Hold the advance mid-consolidation, which is the window the abandoned turn's
  // result lands in: stepIndex already bumped, the next step not started yet.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  h.sessions.consolidateStepOutput = async () => {
    await held;
    return '';
  };
  h.workflows.forceAdvance('s1', 0);
  await sleep(20);
  assert.equal(h.s1().turnSource, undefined, 'the watchdog disowned the abandoned turn');

  // It finally reports in: source-less, stamp consumed — a no-op either way.
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  release();
  await settle();

  assert.equal(h.s1().workflow?.stepIndex, 1, 'the abandoned turn advanced nothing');
  assert.equal(h.s1().workflow?.stepStatuses[1], 'running', 'and parked nothing');
});

test('a consolidation that hangs still advances', async () => {
  const h = harness(2);
  // An iterated step (two user turns inside step 0) is the only shape that runs the
  // consolidation query — a single-turn step returns its text with no await at all.
  const ev = (seq: number, kind: TranscriptEvent['kind'], data: unknown) =>
    ({ seq, ts: seq, kind, data }) as TranscriptEvent;
  h.store.appendTranscript('s1', ev(0, 'workflow', { stepIndex: 0, stepName: 'Step 1', event: 'started' }));
  h.store.appendTranscript('s1', ev(1, 'user', { text: 'do step 1' }));
  h.store.appendTranscript('s1', ev(2, 'sdk', { type: 'assistant', message: { content: [{ type: 'text', text: 'first draft' }] } }));
  h.store.appendTranscript('s1', ev(3, 'user', { text: 'tighten it' }));
  h.store.appendTranscript('s1', ev(4, 'sdk', { type: 'assistant', message: { content: [{ type: 'text', text: 'tightened' }] } }));

  h.sessions.consolidateTimeoutMs = 5;
  // The query itself never resolves — the timeout is the only way out.
  (h.sessions as unknown as { consolidateQuery: () => Promise<string | null> }).consolidateQuery = () =>
    new Promise(() => {});
  h.workflows.approve('s1', 0);
  await sleep(20);
  await settle();

  assert.equal(h.s1().workflow?.advancing, false, 'the loader does not hang');
  assert.equal(h.s1().workflow?.stepIndex, 1);
  assert.equal(h.s1().workflow?.stepStatuses[1], 'running');
  // Fallback output, not an empty hand-off.
  assert.equal(h.s1().workflow?.lastStepOutput, 'tightened');
});

/** A workflow whose advance landed on step 1 but never queued its turn. */
function stalled() {
  const h = harness(2, { stepIndex: 1, stepStatuses: ['done', 'pending'] });
  h.s1().status = 'idle';
  return h;
}

test('startStep runs a step an advance left pending', () => {
  const h = stalled();
  h.workflows.startStep('s1', 1);

  assert.equal(h.s1().workflow?.stepStatuses[1], 'running');
  assert.equal(h.s1().status, 'running');
  assert.ok(markerEvents(h).includes('started'));
});

test('startStep ignores a step that is not stalled', () => {
  // Running: forceAdvance owns that step, not startStep.
  const r = running(2);
  r.workflows.startStep('s1', 0);
  assert.equal(r.s1().workflow?.stepStatuses[0], 'running');
  assert.equal(markerEvents(r).length, 0, 'no second turn was queued');

  // A live turn is already on its way to starting the step.
  const live = stalled();
  live.s1().status = 'running';
  live.workflows.startStep('s1', 1);
  assert.equal(live.s1().workflow?.stepStatuses[1], 'pending');

  // So is an advance mid-consolidation.
  const mid = stalled();
  mid.s1().workflow!.advancing = true;
  mid.workflows.startStep('s1', 1);
  assert.equal(mid.s1().workflow?.stepStatuses[1], 'pending');

  // A stale click from a tab showing an older stepper.
  const stale = stalled();
  stale.workflows.startStep('s1', 0);
  assert.equal(stale.s1().workflow?.stepStatuses[1], 'pending');
});

test('startStep does not run step 0 before the task description arrives', () => {
  const h = harness(2, { started: false, stepStatuses: ['pending', 'pending'] });
  h.s1().status = 'idle';
  h.workflows.startStep('s1', 0);

  assert.equal(h.s1().workflow?.stepStatuses[0], 'pending', 'the first prompt is what starts it');
});

/**
 * The state a bridge death mid-consolidation leaves behind: step 0 already marked 'done'
 * by advance(), `stepIndex` never bumped past it, and `advancing` cleared on load. The
 * session status is the stale 'waiting-approval' from the park before the approve.
 */
function halfAdvanced() {
  const h = harness(2, { stepIndex: 0, stepStatuses: ['done', 'pending'] });
  h.s1().workflow!.advancing = false;
  return h;
}

test('the bumped stepIndex is persisted before the next step is queued', async () => {
  const h = harness(2);
  // runStep is what normally broadcasts the bump; stub it out to prove the bump goes out
  // on its own rather than riding a later message that a bailing runStep never sends.
  (h.workflows as unknown as { runStep: () => Promise<void> }).runStep = async () => {};
  h.workflows.approve('s1', 0);
  await settle();

  assert.equal(h.upserts.at(-1)?.workflow?.stepIndex, 1, 'the bump reached the client');
  // The write itself is debounced like every other status write, so flush to read it.
  h.sessions.flushPersist();
  assert.equal(h.store.loadSessions()[0]?.workflow?.stepIndex, 1, 'and was queued for disk');
});

test('force-advance resumes an advance that died before bumping', async () => {
  const h = halfAdvanced();
  h.workflows.forceAdvance('s1', 0);
  await settle();

  assert.equal(h.s1().workflow?.stepIndex, 1, 'the stalled advance completed');
  assert.equal(h.s1().workflow?.stepStatuses[1], 'running');
  assert.ok(markerEvents(h).includes('started'));
});

test('force-advance leaves a done step alone when it is not a stall', async () => {
  // An advance genuinely in flight owns the step — nothing to recover.
  const mid = halfAdvanced();
  mid.s1().workflow!.advancing = true;
  mid.workflows.forceAdvance('s1', 0);
  await settle();
  assert.equal(mid.s1().workflow?.stepIndex, 0, 'the live advance was not disturbed');

  // The last step reading 'done' is a finished workflow, not a stall.
  const last = harness(2, { stepIndex: 1, stepStatuses: ['done', 'done'] });
  last.s1().status = 'idle';
  last.workflows.forceAdvance('s1', 1);
  await settle();
  assert.equal(last.s1().workflow?.stepIndex, 1);
  assert.equal(markerEvents(last).length, 0, 'the workflow was not re-finished');

  // A stale click from a tab showing an older stepper.
  const stale = halfAdvanced();
  stale.workflows.forceAdvance('s1', 1);
  await settle();
  assert.equal(stale.s1().workflow?.stepIndex, 0);
});

test('advancing clears on the wire when the workflow vanishes mid-advance', async () => {
  const h = harness(2);
  h.sessions.consolidateStepOutput = async () => {
    // e.g. the workflow was deleted from another tab while the output consolidated.
    h.workflows.delete('wf1');
    return '';
  };
  h.workflows.approve('s1', 0);
  await settle();

  const last = h.upserts.at(-1)!;
  assert.equal(last.workflow?.advancing, false, 'the cleared flag reached the client');
  assert.equal(last.workflow?.stepIndex, 1, 'and the bumped index with it');
});
