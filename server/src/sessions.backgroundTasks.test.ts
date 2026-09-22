import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta, SessionStatus, TranscriptEvent } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';

const meta = (status: SessionStatus, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 's1',
    name: 's1',
    cwd: '/tmp',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    status,
    createdAt: 1,
    ...extra,
  }) as SessionMeta;

/** Reconcile skips sessions with no local execution history, so a session that is
 *  meant to be reconciled has to look like one that ran here. */
const ranHere: TranscriptEvent[] = [
  { seq: 0, ts: 0, kind: 'sdk', data: { type: 'assistant' } } as TranscriptEvent,
];

/** A manager over a throwaway store seeded with `metas`, plus a worker stub that
 *  records what it was told to close and stop. */
function managerOver(metas: SessionMeta[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-bgtasks-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(metas));
  fs.mkdirSync(path.join(root, 'transcripts'), { recursive: true });
  for (const m of metas) {
    fs.writeFileSync(
      path.join(root, 'transcripts', `${m.id}.jsonl`),
      ranHere.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }
  const store = createStore(root);
  const upserts: SessionMeta[] = [];
  const sessions = new SessionManager(store, new GuardAllowlist(store), (msg: ServerMessage) => {
    if (msg.type === 'sessionUpsert') upserts.push(msg.session);
  });
  const closed: string[] = [];
  const stopped: [string, string][] = [];
  sessions.attachWorker({
    push: () => {},
    interrupt: () => {},
    stopTask: (id: string, taskId: string) => stopped.push([id, taskId]),
    close: (id: string) => closed.push(id),
  } as never);
  return { sessions, store, closed, stopped, upserts, get: (id: string) => sessions.get(id)! };
}

/** A manager over one session in `status`. */
function harness(status: SessionStatus, extra: Partial<SessionMeta> = {}) {
  const m = managerOver([meta(status, extra)]);
  return { ...m, s1: () => m.get('s1') };
}

const changed = (...tasks: { task_id: string; task_type: string; description: string }[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
});

const task = (id: string, description = `task ${id}`, type = 'subagent') => ({
  task_id: id,
  task_type: type,
  description,
});

const notification = (id: string, status = 'completed') => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: id,
  status,
  summary: `${id} done`,
});

test('background_tasks_changed replaces the set wholesale', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a'), task('b')));
  assert.deepEqual(h.s1().backgroundTasks?.map((t) => t.id), ['a', 'b']);

  // Fewer entries shrink it rather than merging.
  h.sessions.handleWorkerEvent('s1', changed(task('b')));
  assert.deepEqual(h.s1().backgroundTasks?.map((t) => t.id), ['b']);

  // An empty payload empties it.
  h.sessions.handleWorkerEvent('s1', changed());
  assert.equal(h.s1().backgroundTasks, undefined);
});

test('the records carry the description and type, not just the id', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a', 'code review', 'subagent')));
  assert.deepEqual(h.s1().backgroundTasks, [
    { id: 'a', type: 'subagent', description: 'code review' },
  ]);
});

test('a CLI (re)start clears the set', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  h.sessions.handleWorkerEvent('s1', { type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
  assert.equal(h.s1().backgroundTasks, undefined);
});

test('a dead query clears the set', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  h.sessions.handleWorkerEnded('s1');
  assert.equal(h.s1().backgroundTasks, undefined);
});

test('resetClaudeSession clears the set', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  h.sessions.resetClaudeSession('s1');
  assert.equal(h.s1().backgroundTasks, undefined);
});

test('the meta is broadcast on a membership change, and only on one', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  const after = h.upserts.length;
  // Same ids again: the level signal fires per transition, and re-broadcasting
  // would re-render every sidebar row for nothing.
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  assert.equal(h.upserts.length, after);

  h.sessions.handleWorkerEvent('s1', changed(task('a'), task('b')));
  assert.ok(h.upserts.length > after);
});

test('a settled session owning a background task is never recycled', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  h.sessions.recycleIdleQueries();
  assert.deepEqual(h.closed, []);

  // …and is recycled again once the task settles.
  h.sessions.handleWorkerEvent('s1', changed());
  h.sessions.recycleIdleQueries();
  assert.deepEqual(h.closed, ['s1']);
});

test('a settled session with no background task is still recycled', () => {
  const h = harness('done');
  h.sessions.recycleIdleQueries();
  assert.deepEqual(h.closed, ['s1']);
});

/**
 * The second reason a settled query must sometimes survive recycling, alongside
 * the background tasks above: an MCP OAuth handshake in flight. The PKCE verifier
 * lives in that CLI process, so recycling it between leg 1 and the browser
 * redirect leaves the callback with nothing to complete against.
 */

test('a session under an auth hold is never recycled, and is once released', () => {
  const h = harness('done');
  h.sessions.holdForAuth('s1');
  h.sessions.recycleIdleQueries();
  assert.deepEqual(h.closed, []);

  h.sessions.releaseAuthHold('s1');
  h.sessions.recycleIdleQueries();
  assert.deepEqual(h.closed, ['s1']);
});

test('an abandoned handshake stops pinning the query open once its hold ages out', () => {
  // Otherwise a user who closes the sign-in tab keeps a CLI child alive for the
  // rest of the bridge's life, immune to every token refresh.
  const h = harness('done');
  h.sessions.holdForAuth('s1');
  const realNow = Date.now;
  try {
    // Just past the shared handshake TTL (mcpAuth.ts PENDING_TTL_MS, 10 minutes).
    Date.now = () => realNow() + 10 * 60 * 1000 + 1;
    h.sessions.recycleIdleQueries();
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(h.closed, ['s1']);
});

test('releasing a hold that was never taken is a no-op', () => {
  // handleWorkerEnded and the OAuth callback both release unconditionally.
  const h = harness('done');
  h.sessions.releaseAuthHold('s1');
  h.sessions.releaseAuthHold('nosuch');
  h.sessions.recycleIdleQueries();
  assert.deepEqual(h.closed, ['s1']);
});

test('stopBackgroundTasks stops each live task and clears the set', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a'), task('b')));
  h.sessions.stopBackgroundTasks('s1');
  assert.deepEqual(h.stopped, [
    ['s1', 'a'],
    ['s1', 'b'],
  ]);
  // Cleared optimistically: a task the CLI already forgot sends no level signal,
  // and the user would otherwise have no way to clear the strip at all.
  assert.equal(h.s1().backgroundTasks, undefined);

  // A task that really is still alive comes back on the next level emission —
  // the recoverable flicker this trades the wedge for.
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  assert.deepEqual(h.s1().backgroundTasks?.map((t) => t.id), ['a']);
});

test('a task_notification removes its own id and leaves the others', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a'), task('b')));
  const before = h.upserts.length;
  h.sessions.handleWorkerEvent('s1', notification('a'));
  assert.deepEqual(h.s1().backgroundTasks?.map((t) => t.id), ['b']);
  assert.equal(h.upserts.length, before + 1);
});

test('a task_notification for an unknown id is a strict no-op', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  const before = h.upserts.length;
  // The set only ever shrinks: a notification may never add an id the level
  // signal never named.
  h.sessions.handleWorkerEvent('s1', notification('zzz'));
  assert.deepEqual(h.s1().backgroundTasks?.map((t) => t.id), ['a']);
  assert.equal(h.upserts.length, before);
});

test('the last task_notification empties the set', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  h.sessions.handleWorkerEvent('s1', notification('a'));
  assert.equal(h.s1().backgroundTasks, undefined);
});

test('a result with live tasks still settles the turn', () => {
  const h = harness('running', { turnSource: 'user' });
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success' });
  assert.equal(h.s1().status, 'done');
  assert.equal(h.s1().turnSource, undefined);
  assert.deepEqual(h.s1().backgroundTasks?.map((t) => t.id), ['a']);
});

test('a persisted set does not come back from disk', () => {
  const h = harness('done', {
    backgroundTasks: [{ id: 'a', type: 'subagent', description: 'from a dead process' }],
  });
  assert.equal(h.s1().backgroundTasks, undefined);
});

test('reconcile repopulates the set from the worker', () => {
  const h = harness('done');
  h.sessions.reconcileWithWorker([
    { sessionId: 's1', busy: false, backgroundTasks: [task('a', 'code review')] },
  ]);
  assert.deepEqual(h.s1().backgroundTasks, [
    { id: 'a', type: 'subagent', description: 'code review' },
  ]);
});

test('a worker too old to report background tasks leaves the set alone', () => {
  const h = harness('done');
  h.sessions.handleWorkerEvent('s1', changed(task('a')));
  h.sessions.reconcileWithWorker([{ sessionId: 's1', busy: false }]);
  assert.deepEqual(h.s1().backgroundTasks?.map((t) => t.id), ['a']);
});

test('the ephemeral system subtypes are broadcast but never written to disk', () => {
  const h = harness('done');
  const before = h.store.loadTranscript('s1').length;
  for (const subtype of [
    'task_progress',
    'task_updated',
    'thinking_tokens',
    'status',
    'hook_started',
    'hook_response',
  ]) {
    h.sessions.handleWorkerEvent('s1', { type: 'system', subtype });
  }
  assert.equal(h.store.loadTranscript('s1').length, before);
});

test('a status carrying a compact verdict is still persisted', () => {
  const h = harness('done');
  const before = h.store.loadTranscript('s1').length;
  h.sessions.handleWorkerEvent('s1', {
    type: 'system',
    subtype: 'status',
    compact_result: { result: 'success' },
  });
  assert.equal(h.store.loadTranscript('s1').length, before + 1);
});

test('task_started and task_notification are still persisted', () => {
  const h = harness('done');
  const before = h.store.loadTranscript('s1').length;
  // `task_started` is now the only durable proof a call was backgrounded, and the
  // notification is what resolves the card it opened.
  h.sessions.handleWorkerEvent('s1', {
    type: 'system',
    subtype: 'task_started',
    task_id: 'a',
    tool_use_id: 'toolu_1',
  });
  h.sessions.handleWorkerEvent('s1', notification('a'));
  assert.equal(h.store.loadTranscript('s1').length, before + 2);
});
