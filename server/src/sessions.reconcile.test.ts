import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  ContextCompactData,
  PermissionRequestData,
  SessionMeta,
  SessionStatus,
  TranscriptEvent,
  UserUiSettings,
} from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import { withQueuedPushes } from './workerClient.ts';

const meta = (status: SessionStatus, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 's1',
    name: 's1',
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    compressResponses: false,
    status,
    createdAt: 1,
    ...extra,
  }) as SessionMeta;

/**
 * A transcript stands for "this machine ran this session". Reconcile skips
 * sessions with no local execution history — a row adopted from another machine's
 * storage sync — so a session that is meant to be reconciled has to look like one
 * that ran here.
 */
const ranHere: TranscriptEvent[] = [
  { seq: 0, ts: 0, kind: 'sdk', data: { type: 'assistant' } } as TranscriptEvent,
];

/**
 * A manager over a throwaway store seeded with `metas`. `throwFor` makes the
 * worker push throw for that session, standing in for any per-session failure
 * on the resume path.
 */
function managerOver(
  metas: SessionMeta[],
  settings?: UserUiSettings,
  throwFor?: string,
  events?: TranscriptEvent[],
  opts: { adoptedFromElsewhere?: boolean } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-reconcile-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(metas));
  if (settings) fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
  fs.mkdirSync(path.join(root, 'transcripts'), { recursive: true });
  const writeTranscript = (id: string, list: TranscriptEvent[]) =>
    fs.writeFileSync(
      path.join(root, 'transcripts', `${id}.jsonl`),
      list.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  if (opts.adoptedFromElsewhere) {
    // Deliberately no transcript: nothing here has ever executed these.
  } else if (events?.length) {
    writeTranscript(metas[0].id, events);
  } else {
    for (const m of metas) writeTranscript(m.id, ranHere);
  }
  const store = createStore(root);
  const sessions = new SessionManager(store, new GuardAllowlist(store), () => {});
  const pushed: string[] = [];
  sessions.attachWorker({
    push: (id: string) => {
      if (id === throwFor) throw new Error('cannot build query options');
      pushed.push(id);
    },
    interrupt: () => {},
    close: () => {},
  } as never);
  return {
    sessions,
    pushed,
    get: (id: string) => sessions.get(id)!,
    cards: (id: string) =>
      store
        .loadTranscript(id)
        .filter((e) => e.kind === 'permission')
        .map((e) => e.data as PermissionRequestData),
    compactions: (id: string) =>
      store
        .loadTranscript(id)
        .filter((e) => e.kind === 'context-compact')
        .map((e) => e.data as ContextCompactData),
  };
}

/** A manager over a throwaway store seeded with one session in `status`. */
function harness(
  status: SessionStatus,
  extra: Partial<SessionMeta> = {},
  settings?: UserUiSettings,
  events?: TranscriptEvent[],
) {
  const m = managerOver([meta(status, extra)], settings, undefined, events);
  return { ...m, s1: () => m.get('s1') };
}

test('a busy session is promoted back to running from a stale idle', () => {
  const h = harness('idle', { interruptedAt: 5 });
  h.sessions.reconcileWithWorker([{ sessionId: 's1', busy: true }]);

  const m = h.s1();
  assert.equal(m.status, 'running');
  assert.equal(m.turnSource, 'user');
  assert.equal(m.interruptedAt, undefined);
  assert.ok((m.turnStartedAt ?? 0) > 0);
});

test('promotion keeps a known turn start rather than restamping it', () => {
  const h = harness('idle', { turnStartedAt: 1234 });
  h.sessions.reconcileWithWorker([{ sessionId: 's1', busy: true }]);
  assert.equal(h.s1().turnStartedAt, 1234);
});

test('a busy session mid-workflow-step is promoted as a workflow turn', () => {
  const h = harness('idle', {
    workflow: {
      workflowId: 'wf1',
      started: true,
      stepIndex: 1,
      stepStatuses: ['done', 'running'],
    },
  });
  h.sessions.reconcileWithWorker([{ sessionId: 's1', busy: true }]);
  assert.equal(h.s1().turnSource, 'workflow');
});

test('an already-active session is left alone by a busy report', () => {
  const h = harness('waiting-permission', { pendingPermissionTool: 'Bash', turnSource: 'workflow' });
  h.sessions.reconcileWithWorker([{ sessionId: 's1', busy: true }]);

  const m = h.s1();
  assert.equal(m.status, 'waiting-permission');
  assert.equal(m.pendingPermissionTool, 'Bash');
  assert.equal(m.turnSource, 'workflow');
});

// Demotion in isolation: auto-continue off, or it would resume these right back.
const noAutoContinue: UserUiSettings = { autoContinueInterrupted: false };

test('a live-but-finished query demotes a running session to idle', () => {
  const h = harness('running', { turnSource: 'user', turnStartedAt: 9 }, noAutoContinue);
  h.sessions.reconcileWithWorker([{ sessionId: 's1', busy: false }]);

  const m = h.s1();
  assert.equal(m.status, 'idle');
  assert.equal(m.turnSource, undefined);
  assert.equal(m.turnStartedAt, undefined);
  assert.ok((m.interruptedAt ?? 0) > 0);
});

test('a bridge death mid-compaction re-parks the step instead of demoting it', () => {
  // The only turn that runs on a step already reading 'waiting-approval' is a manual
  // compaction. Demoting to idle would put a Continue banner on a session nobody
  // interrupted — and auto-continue would then nudge a step nobody approved.
  const h = harness(
    'running',
    {
      turnSource: 'user',
      turnStartedAt: 9,
      workflow: {
        workflowId: 'wf1',
        started: true,
        stepIndex: 0,
        stepStatuses: ['waiting-approval', 'pending'],
      },
    },
    autoContinue,
  );
  h.sessions.reconcileWithWorker([{ sessionId: 's1', busy: false }]);

  const m = h.s1();
  assert.equal(m.status, 'waiting-approval');
  assert.equal(m.turnSource, undefined);
  assert.equal(m.turnStartedAt, undefined);
  assert.equal(m.interruptedAt, undefined, 'no Continue banner');
  assert.equal(m.workflow?.stepStatuses[0], 'waiting-approval');
});

test('a session missing from the live list is still demoted', () => {
  const h = harness('running', {}, noAutoContinue);
  h.sessions.reconcileWithWorker([]);
  assert.equal(h.s1().status, 'idle');
});

test('a turn being re-driven survives a worker that reports no query', () => {
  // A transparent recovery deliberately leaves the session with no query for the
  // length of its backoff (see beginRecovery). Demoting it there would stamp a
  // Continue banner — and auto-continue would nudge a turn that is about to resume
  // on its own, on top of the one already coming.
  const h = harness('running', { turnSource: 'user', turnStartedAt: 9 }, autoContinue);
  h.sessions.emitEvent('s1', 'user', { text: 'go on', source: 'user' });
  h.sessions.handleWorkerEvent('s1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
  });
  h.sessions.reconcileWithWorker([{ sessionId: 's1', busy: false }]);

  const m = h.s1();
  assert.equal(m.status, 'running');
  assert.equal(m.turnSource, 'user');
  assert.equal(m.interruptedAt, undefined, 'no Continue banner');
  assert.deepEqual(h.pushed, [], 'and no auto-continue nudge');
});

test('an old worker (no busy field) demotes only, never promotes', () => {
  const running = harness('running');
  running.sessions.reconcileWithWorker([{ sessionId: 's1' }]);
  assert.equal(running.s1().status, 'running', 'present in live => left alone, as before');

  const idle = harness('idle');
  idle.sessions.reconcileWithWorker([{ sessionId: 's1' }]);
  assert.equal(idle.s1().status, 'idle', 'no busy flag is not proof of a live turn');
});

test('an SDK event on an idle session heals the status', () => {
  for (const type of ['assistant', 'user', 'stream_event', 'system']) {
    const h = harness('idle');
    h.sessions.handleWorkerEvent('s1', { type });
    assert.equal(h.s1().status, 'running', `${type} should heal`);
  }
});

test('a result on an idle session does not resurrect the turn', () => {
  const h = harness('idle');
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  assert.equal(h.s1().status, 'idle');
});

test('events trailing a Stop do not undo the interrupt', () => {
  const h = harness('running');
  h.sessions.interrupt('s1');
  assert.equal(h.s1().status, 'idle');

  h.sessions.handleWorkerEvent('s1', { type: 'assistant', message: {} });
  assert.equal(h.s1().status, 'idle');
});

const autoContinue: UserUiSettings = { autoContinueInterrupted: true };

test('auto-continue resumes a turn that this pass flagged', () => {
  const h = harness('running', { claudeSessionId: 'c1' }, autoContinue);
  h.sessions.reconcileWithWorker([]);

  const m = h.s1();
  assert.deepEqual(h.pushed, ['s1'], 'exactly one resume push');
  assert.equal(m.status, 'running');
  assert.equal(m.interruptedAt, undefined, 'resumed, so no banner');
});

test('auto-continue is on with no settings file at all', () => {
  const h = harness('running');
  h.sessions.reconcileWithWorker([]);

  assert.deepEqual(h.pushed, ['s1'], 'absent setting means enabled');
  assert.equal(h.s1().interruptedAt, undefined);
});

test('an explicit false leaves the turn for the Continue button', () => {
  const h = harness('running', {}, { autoContinueInterrupted: false });
  h.sessions.reconcileWithWorker([]);

  assert.deepEqual(h.pushed, [], 'only `false` turns it off');
  assert.ok((h.s1().interruptedAt ?? 0) > 0);
});

test('auto-continue ignores a flag left over from an earlier crash', () => {
  const h = harness('idle', { interruptedAt: 5 });
  h.sessions.reconcileWithWorker([]);

  assert.deepEqual(h.pushed, [], 'a stale flag still waits for the click');
  assert.equal(h.s1().interruptedAt, 5);
});

test('auto-continue resumes a mid-workflow-step turn as a workflow turn', () => {
  const h = harness(
    'running',
    {
      turnSource: 'workflow',
      workflow: { workflowId: 'wf1', started: true, stepIndex: 1, stepStatuses: ['done', 'running'] },
    },
    autoContinue,
  );
  h.sessions.reconcileWithWorker([]);

  assert.deepEqual(h.pushed, ['s1']);
  assert.equal(h.s1().turnSource, 'workflow', 'so its result still parks the step');
});

let cardSeq = 0;
const card = (requestId: string, toolName: string): TranscriptEvent =>
  ({ seq: cardSeq++, ts: 0, kind: 'permission', data: { requestId, toolName, input: {} } }) as TranscriptEvent;
const answeredCard = (requestId: string): TranscriptEvent =>
  ({
    seq: cardSeq++,
    ts: 0,
    kind: 'permission',
    data: { requestId, toolName: '', input: {}, resolution: 'allow', resolvedBy: 'user' },
  }) as TranscriptEvent;

const waitingOnPlan: Partial<SessionMeta> = {
  claudeSessionId: 'c1',
  pendingPermissionTool: 'ExitPlanMode',
};

test('a session holding an unanswered plan card is parked, not auto-continued', () => {
  const h = harness('waiting-permission', waitingOnPlan, autoContinue, [card('p1', 'ExitPlanMode')]);
  h.sessions.reconcileWithWorker([]);

  const m = h.s1();
  assert.deepEqual(h.pushed, [], 'nudging it would read as an approval nobody gave');
  assert.ok((m.interruptedAt ?? 0) > 0, 'the Continue banner still appears');
  assert.equal(m.status, 'idle');
  // The card stays clickable: a late click recovers through resolvePermission.
  assert.deepEqual(h.cards('s1').map((c) => c.resolution), [undefined]);
});

test('the same session auto-continues once the plan card is answered', () => {
  const h = harness('waiting-permission', waitingOnPlan, autoContinue, [
    card('p1', 'ExitPlanMode'),
    answeredCard('p1'),
  ]);
  h.sessions.reconcileWithWorker([]);

  assert.deepEqual(h.pushed, ['s1']);
  assert.equal(h.s1().interruptedAt, undefined);
});

test('an unanswered card for an ordinary tool does not park the session', () => {
  const h = harness('waiting-permission', { claudeSessionId: 'c1', pendingPermissionTool: 'Bash' }, autoContinue, [
    card('b1', 'Bash'),
  ]);
  h.sessions.reconcileWithWorker([]);

  assert.deepEqual(h.pushed, ['s1']);
  // continueTurn closes it, so a later click can't inject into the new turn.
  assert.deepEqual(h.cards('s1').map((c) => [c.resolution, c.resolvedBy]), [
    [undefined, undefined],
    ['expired', 'interrupt-expire'],
  ]);
});

test('continueTurn expires ordinary cards but leaves an always-ask one open', () => {
  const h = harness('idle', { interruptedAt: 5, claudeSessionId: 'c1' }, noAutoContinue, [
    card('b1', 'Bash'),
    card('p1', 'ExitPlanMode'),
  ]);
  h.sessions.continueTurn('s1');

  const expired = h.cards('s1').filter((c) => c.resolution === 'expired');
  assert.deepEqual(expired.map((c) => c.requestId), ['b1']);
});

test('one session failing to resume does not stop the others', async () => {
  const m = managerOver(
    [meta('running', { id: 'bad', name: 'bad' }), meta('running', { id: 'good', name: 'good' })],
    undefined,
    'bad',
  );
  assert.doesNotThrow(() => m.sessions.reconcileWithWorker([]));

  assert.deepEqual(m.pushed, ['good']);
  // The push leaves the bridge through pushTurnSafely, so a worker throw surfaces as
  // a rejected promise rather than out of continueTurn: the recovery is failTurn's,
  // one tick later — a synthetic failed result and an error status carrying Retry.
  await new Promise((r) => setImmediate(r));
  const bad = m.get('bad');
  assert.equal(bad.status, 'error', 'the failed one must not be left looking live');
  assert.match(bad.errorMessage ?? '', /cannot build query options/);
});

test('a result clears a Continue flag stamped for a turn that had finished', () => {
  const h = harness('idle', { interruptedAt: 5 });
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  assert.equal(h.s1().interruptedAt, undefined);
});

test('putting a session away answers the Continue banner', () => {
  const archived = harness('idle', { interruptedAt: 5 });
  archived.sessions.archiveSession('s1');
  assert.equal(archived.s1().interruptedAt, undefined);

  const completed = harness('idle', { interruptedAt: 5 });
  completed.sessions.completeSession('s1');
  assert.equal(completed.s1().interruptedAt, undefined);
});

test('worker lost, never returns: idles the session but does not auto-continue', () => {
  const h = harness('running', { claudeSessionId: 'c1' }, autoContinue);
  h.sessions.reconcileWithWorker([], { autoContinue: false });

  const m = h.s1();
  assert.equal(m.status, 'idle');
  assert.ok((m.interruptedAt ?? 0) > 0, 'the Continue banner appears');
  assert.deepEqual(h.pushed, [], 'no worker to push a resumed turn to');
});

test('a session adopted from another machine is left alone', () => {
  // It only exists here because storage sync pulled it: no live query, no local
  // transcript. Demoting it restamps and re-broadcasts a turn this machine never
  // owned — once per reconcile, per session, which is the storm that fed the loop.
  const h = managerOver([meta('running', { claudeSessionId: 'c1' })], autoContinue, undefined, undefined, {
    adoptedFromElsewhere: true,
  });
  h.sessions.reconcileWithWorker([]);

  const m = h.get('s1');
  assert.equal(m.status, 'running', 'its status belongs to the machine actually running it');
  assert.equal(m.interruptedAt, undefined, "no Continue banner for another machine's turn");
  assert.deepEqual(h.pushed, [], 'and certainly no auto-continue');
});

test('a worker report still reconciles a session with no local transcript', () => {
  // The skip is scoped to "no evidence at all": a live report is evidence.
  const h = managerOver([meta('running')], noAutoContinue, undefined, undefined, {
    adoptedFromElsewhere: true,
  });
  h.sessions.reconcileWithWorker([{ sessionId: 's1', busy: false }]);
  assert.equal(h.get('s1').status, 'idle');
});

test('a queued push counts as live so its session survives reconcile', () => {
  const live = withQueuedPushes(
    [{ sessionId: 'a', claudeSessionId: 'c-a', busy: true }],
    [
      { type: 'push', sessionId: 'b', message: {}, options: {} },
      { type: 'push', sessionId: 'a', message: {}, options: {} },
      { type: 'interrupt', sessionId: 'z' },
    ],
  );
  assert.deepEqual(live, [
    { sessionId: 'a', claudeSessionId: 'c-a', busy: true },
    { sessionId: 'b', busy: true },
  ]);
});

/**
 * A rewind drops the session's query and truncates its transcript. The reconcile
 * that follows must read that as an ordinary settled session, not as a turn that
 * died with the app — otherwise the Continue banner offers to resume a turn the
 * user deliberately discarded.
 */
test('a rewound session reconciles cleanly', async () => {
  const events: TranscriptEvent[] = [
    { seq: 0, ts: 0, kind: 'user', data: { text: 'first' } },
    { seq: 1, ts: 1, kind: 'sdk', data: { type: 'assistant', uuid: 'uuid-1' } },
    { seq: 2, ts: 2, kind: 'user', data: { text: 'the oversized one' } },
    { seq: 3, ts: 3, kind: 'sdk', data: { type: 'assistant', uuid: 'uuid-2' } },
  ];
  const h = harness(
    'error',
    { claudeSessionId: 'cli-1', errorKind: 'context', errorMessage: 'Prompt is too long' },
    noAutoContinue,
    events,
  );
  h.sessions.forkSession = async () => ({ sessionId: 'cli-2' });
  assert.equal((await h.sessions.rewindSession('s1', 2)).ok, true);

  // The worker has no query for this session any more — the rewind closed it.
  h.sessions.reconcileWithWorker([]);

  const m = h.s1();
  assert.equal(m.status, 'idle');
  assert.equal(m.interruptedAt, undefined, 'nothing was interrupted — the turns were discarded');
  assert.equal(m.claudeSessionId, 'cli-2');
  assert.deepEqual(h.cards('s1'), [], 'the discarded query leaves no orphaned permission cards');
});

/**
 * A manual compaction is a turn like any other, so it dies with the worker. The
 * reconcile that follows has to close its span: the marker renders from the span
 * (an unmatched 'requested' reads as still compacting), and `compacting` refuses a
 * second compaction for as long as the entry stands — which outlives the worker,
 * because the set lives on the bridge.
 */
test('a compaction that died with the worker is closed by the reconcile', () => {
  const workflow = {
    workflowId: 'wf1',
    started: true,
    stepIndex: 1,
    stepStatuses: ['done', 'waiting-approval'],
  };
  const contextUsage = {
    inputTokens: 120_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    model: 'claude-opus-5',
  };
  const h = harness(
    'waiting-approval',
    { claudeSessionId: 'cli-1', contextUsage, workflow } as never,
    noAutoContinue,
  );
  assert.equal(h.sessions.compactContext('s1').ok, true);
  assert.equal(h.s1().status, 'running', 'the compaction covers the park with its own turn');

  h.sessions.reconcileWithWorker([]);

  const m = h.s1();
  assert.equal(m.status, 'waiting-approval', 'the park is put back');
  assert.equal(m.interruptedAt, undefined, 'a parked step gets no Continue banner');
  const spans = h.compactions('s1');
  assert.equal(spans.length, 2);
  assert.deepEqual(
    { phase: spans[1].phase, ok: spans[1].ok, error: spans[1].error },
    { phase: 'done', ok: false, error: 'worker-lost' },
  );
  assert.equal(h.sessions.compactContext('s1').ok, true, 'and a retry is allowed');
});
