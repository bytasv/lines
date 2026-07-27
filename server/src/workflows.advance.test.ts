import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SessionMeta, ServerMessage, WorkflowDef, WorkflowState } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { WorkflowEngine } from './workflows.ts';

const wfDef = (stepCount: number): WorkflowDef => ({
  id: 'wf1',
  name: 'test flow',
  steps: Array.from({ length: stepCount }, (_, n) => ({
    name: `Step ${n + 1}`,
    promptTemplate: `do step ${n + 1}{feedback}`,
    model: 'claude-sonnet-5',
    permissionMode: 'default' as const,
    autoAdvance: false,
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
 * `upserts` collects every broadcast session meta, in order — the wire the client sees.
 */
function harness(stepCount: number, workflow: Partial<WorkflowState> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-advance-'));
  const state: WorkflowState = {
    workflowId: 'wf1',
    started: true,
    stepIndex: 0,
    stepStatuses: Array.from({ length: stepCount }, (_, n) => (n === 0 ? 'waiting-approval' : 'pending')),
    ...workflow,
  };
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta(state)]));
  fs.writeFileSync(path.join(root, 'workflows.json'), JSON.stringify([wfDef(stepCount)]));

  const upserts: SessionMeta[] = [];
  const broadcast = (msg: ServerMessage) => {
    // Snapshot: metas are mutated in place, so the live object would show final state.
    if (msg.type === 'sessionUpsert') upserts.push(structuredClone(msg.session));
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
  return { root, sessions, workflows, upserts, s1: () => sessions.get('s1')! };
}

/** Let the void-ed advance() chain (and the runStep it queues) run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 0));

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
