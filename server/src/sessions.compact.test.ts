import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SessionMeta, TranscriptEvent, WorkflowState } from '@lines/shared';
import { contextCompactBlock, effectiveContextTokens } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import {
  SessionManager,
  collectTurns,
  extractCompactBoundary,
  extractCompactStatus,
  findStepStart,
  withoutCompactSpans,
} from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient } from './workerClient.ts';

let seq = 0;
const ev = (kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent => ({
  seq: seq++,
  ts: seq,
  kind,
  data,
});
const user = (text: string) => ev('user', { text });
const assistant = (text: string) => ev('sdk', { type: 'assistant', message: { content: [{ type: 'text', text }] } });
const requested = () => ev('context-compact', { phase: 'requested', trigger: 'manual' });
const done = () => ev('context-compact', { phase: 'done', trigger: 'manual', ok: true });

// ---------------------------------------------------------------------------
// withoutCompactSpans
// ---------------------------------------------------------------------------

test('a matched compact span and its markers are removed', () => {
  const events = [user('a'), assistant('A'), requested(), assistant('summary'), done(), assistant('B')];
  const kept = withoutCompactSpans(events);
  assert.deepEqual(
    kept.map((e) => e.kind),
    ['user', 'sdk', 'sdk'],
  );
  assert.equal(collectTurns(kept, 0).length, 1);
  assert.equal(collectTurns(kept, 0)[0].output, 'B');
});

test('an unmatched requested marker drops only up to the next user event', () => {
  const events = [user('a'), requested(), assistant('summary'), user('b'), assistant('B')];
  const kept = withoutCompactSpans(events);
  assert.deepEqual(
    kept.map((e) => e.kind),
    ['user', 'user', 'sdk'],
  );
  // Never to end-of-array: a crash mid-compaction must not swallow the transcript.
  assert.equal(collectTurns(kept, 0).at(-1)?.output, 'B');
});

test('an auto-compaction (lone done marker) drops nothing but itself', () => {
  const events = [user('a'), assistant('A'), done(), assistant('B')];
  assert.deepEqual(
    withoutCompactSpans(events).map((e) => e.kind),
    ['user', 'sdk', 'sdk'],
  );
});

test('stripping keeps findStepStart and collectTurns on the same array', () => {
  const events = [
    ev('workflow', { event: 'started', stepIndex: 0, stepName: 's' }),
    user('do it'),
    assistant('done it'),
    requested(),
    assistant('a compaction summary'),
    done(),
  ];
  const kept = withoutCompactSpans(events);
  const turns = collectTurns(kept, findStepStart(kept, 0));
  // One attempt, not two — and its output is the step's, not the summary's.
  assert.equal(turns.length, 1);
  assert.equal(turns[0].output, 'done it');
});

// ---------------------------------------------------------------------------
// extractCompactBoundary
// ---------------------------------------------------------------------------

test('compact_boundary metadata is parsed', () => {
  assert.deepEqual(
    extractCompactBoundary({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 150_000, post_tokens: 20_000 },
    }),
    { trigger: 'auto', preTokens: 150_000, postTokens: 20_000 },
  );
});

test('post_tokens is optional and stays undefined', () => {
  const got = extractCompactBoundary({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 90_000 },
  });
  assert.equal(got?.postTokens, undefined);
  assert.equal(got?.preTokens, 90_000);
});

test('an unknown trigger is left undefined for the caller to decide', () => {
  const got = extractCompactBoundary({ type: 'system', subtype: 'compact_boundary' });
  assert.deepEqual(got, { trigger: undefined, preTokens: undefined, postTokens: undefined });
});

test('other messages are not boundaries', () => {
  assert.equal(extractCompactBoundary({ type: 'system', subtype: 'init' }), undefined);
  assert.equal(extractCompactBoundary({ type: 'assistant' }), undefined);
});

// ---------------------------------------------------------------------------
// extractCompactStatus
// ---------------------------------------------------------------------------

test('a failed status carries the SDK error text', () => {
  assert.deepEqual(
    extractCompactStatus({
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'failed',
      compact_error: 'compaction is disabled',
    }),
    { result: 'failed', error: 'compaction is disabled' },
  );
});

test('a success status with no error text leaves error undefined', () => {
  assert.deepEqual(extractCompactStatus({ type: 'system', subtype: 'status', compact_result: 'success' }), {
    result: 'success',
    error: undefined,
  });
});

test('a status message with no compact verdict is not an outcome', () => {
  assert.equal(extractCompactStatus({ type: 'system', subtype: 'status', status: 'requesting' }), undefined);
  assert.equal(
    extractCompactStatus({ type: 'system', subtype: 'status', compact_result: 'maybe' }),
    undefined,
  );
});

test('other messages are not statuses', () => {
  assert.equal(
    extractCompactStatus({ type: 'system', subtype: 'compact_boundary', compact_result: 'success' }),
    undefined,
  );
  assert.equal(extractCompactStatus({ type: 'assistant' }), undefined);
});

test('an over-long compact_error is capped before it reaches the meta', () => {
  const got = extractCompactStatus({
    type: 'system',
    subtype: 'status',
    compact_result: 'failed',
    compact_error: 'x'.repeat(500),
  });
  assert.equal(got?.error?.length, 200);
});

// ---------------------------------------------------------------------------
// effectiveContextTokens
// ---------------------------------------------------------------------------

const usage = (at: number) => ({
  inputTokens: 10,
  cacheReadTokens: 1_000,
  cacheCreationTokens: 100,
  outputTokens: 20,
  model: 'claude-opus-5',
  at,
});

test('the four-component sum is the baseline', () => {
  assert.deepEqual(effectiveContextTokens({ contextUsage: usage(100) }), {
    used: 1_130,
    fromCompaction: false,
  });
});

test('a newer compaction with postTokens wins', () => {
  assert.deepEqual(
    effectiveContextTokens({
      contextUsage: usage(100),
      contextCompact: { at: 200, trigger: 'auto', preTokens: 1_130, postTokens: 300, ok: true },
    }),
    { used: 300, fromCompaction: true },
  );
});

test('an older, failed, or postTokens-less compaction does not win', () => {
  const base = { contextUsage: usage(100) };
  assert.equal(
    effectiveContextTokens({
      ...base,
      contextCompact: { at: 50, trigger: 'auto', postTokens: 300, ok: true },
    })?.used,
    1_130,
  );
  assert.equal(
    effectiveContextTokens({
      ...base,
      contextCompact: { at: 200, trigger: 'manual', postTokens: 300, ok: false },
    })?.used,
    1_130,
  );
  assert.equal(
    effectiveContextTokens({ ...base, contextCompact: { at: 200, trigger: 'auto', ok: true } })?.used,
    1_130,
  );
});

test('no reading at all is undefined', () => {
  assert.equal(effectiveContextTokens({}), undefined);
});

// ---------------------------------------------------------------------------
// contextCompactBlock
// ---------------------------------------------------------------------------

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 's',
  name: 's',
  cwd: '/tmp',
  model: 'claude-opus-5',
  permissionMode: 'default',
  compressResponses: false,
  status: 'idle',
  createdAt: 0,
  claudeSessionId: 'cli-1',
  contextUsage: usage(100),
  ...over,
});

/** A workflow session sitting on step 0, in whatever step state the test needs. */
const parked = (over: Partial<WorkflowState> = {}): Partial<SessionMeta> => ({
  workflow: {
    workflowId: 'wf',
    stepIndex: 0,
    stepStatuses: ['waiting-approval'],
    started: true,
    ...over,
  },
});

test('compaction is allowed on a settled session with a reading', () => {
  assert.equal(contextCompactBlock(meta()), null);
  assert.equal(contextCompactBlock(meta({ status: 'done' })), null);
});

test('a parked workflow step does not block compaction', () => {
  // The hand-off reads the on-disk transcript, not the CLI's live context, and the
  // park is restored on settle — so a full context window is compactable right where
  // a long workflow session actually sits.
  assert.equal(contextCompactBlock(meta({ status: 'waiting-approval', ...parked() })), null);
  // Same for a step that failed: its banner survives the compaction.
  assert.equal(
    contextCompactBlock(
      meta({ status: 'error', errorMessage: 'boom', ...parked({ stepFailure: 'turn' }) }),
    ),
    null,
  );
});

test('every block code reports itself with a reason', () => {
  const cases: [Partial<SessionMeta>, string][] = [
    [{ status: 'running' }, 'turn-running'],
    [{ status: 'waiting-permission' }, 'turn-running'],
    [{ status: 'waiting-approval', ...parked({ advancing: true }) }, 'step-advancing'],
    [{ claudeSessionId: undefined }, 'no-session'],
    [{ contextUsage: undefined }, 'no-reading'],
    [{ contextCompact: { at: 200, trigger: 'manual', ok: false } }, 'unsupported'],
  ];
  for (const [over, code] of cases) {
    const block = contextCompactBlock(meta(over));
    assert.equal(block?.code, code);
    assert.ok(block && block.reason.length > 0, `${code} must carry a tooltip reason`);
  }
});

test('a busy session reports the transient reason, not unsupported', () => {
  const block = contextCompactBlock(
    meta({ status: 'running', contextCompact: { at: 1, trigger: 'manual', ok: false } }),
  );
  assert.equal(block?.code, 'turn-running');
});

test("the SDK's own failure text lands in the tooltip", () => {
  const block = contextCompactBlock(
    meta({ contextCompact: { at: 1, trigger: 'manual', ok: false, error: 'compaction is disabled' } }),
  );
  assert.equal(block?.code, 'unsupported');
  assert.match(block!.reason, /compaction is disabled/);
});

test('a boundary-less success does not read as a failure', () => {
  assert.equal(contextCompactBlock(meta({ contextCompact: { at: 200, trigger: 'manual', ok: true } })), null);
});

// ---------------------------------------------------------------------------
// The unsupported latch: only an explicit SDK verdict sets it, and it never
// outlives the CLI conversation that produced it.
// ---------------------------------------------------------------------------

/** A SessionManager over a throwaway store, with a worker that swallows pushes. */
function harness(over: Partial<SessionMeta> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-compact-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta(over)]));
  const store = createStore(root);
  const sessions = new SessionManager(store, new GuardAllowlist(store), () => {});
  sessions.attachWorker({
    push: () => {},
    close: () => {},
    interrupt: () => {},
  } as unknown as WorkerClient);
  return sessions;
}

/** Start a manual compaction, then feed the turn's messages back in. */
function compacting(over: Partial<SessionMeta> = {}) {
  const sessions = harness(over);
  assert.deepEqual(sessions.compactContext('s'), { ok: true });
  // Whatever it covers, the compaction itself runs as an ordinary live turn.
  assert.equal(sessions.get('s')!.status, 'running');
  return sessions;
}

const status = (over: Record<string, unknown>) => ({
  type: 'system' as const,
  subtype: 'status',
  ...over,
});

test('a silent turn is inconclusive: no record, button stays clickable', () => {
  const sessions = compacting();
  sessions.handleWorkerEvent('s', { type: 'result', subtype: 'success' });
  const after = sessions.get('s')!;
  assert.equal(after.contextCompact, undefined);
  assert.equal(contextCompactBlock(after), null);
});

test('an SDK compact_result:failed latches with its own error text', () => {
  const sessions = compacting();
  sessions.handleWorkerEvent('s', status({ compact_result: 'failed', compact_error: 'no can do' }));
  sessions.handleWorkerEvent('s', { type: 'result', subtype: 'success' });
  const after = sessions.get('s')!;
  assert.equal(after.contextCompact?.ok, false);
  assert.equal(after.contextCompact?.error, 'no can do');
  assert.equal(contextCompactBlock(after)?.code, 'unsupported');
});

test('an SDK compact_result:success with no boundary leaves the button enabled', () => {
  const sessions = compacting();
  sessions.handleWorkerEvent('s', status({ compact_result: 'success' }));
  sessions.handleWorkerEvent('s', { type: 'result', subtype: 'success' });
  const after = sessions.get('s')!;
  assert.equal(after.contextCompact?.ok, true);
  assert.equal(after.contextCompact?.postTokens, undefined);
  assert.equal(contextCompactBlock(after), null);
});

test('a fresh CLI conversation clears a latched verdict', () => {
  const sessions = compacting();
  sessions.handleWorkerEvent('s', status({ compact_result: 'failed', compact_error: 'no can do' }));
  sessions.resetClaudeSession('s');
  assert.equal(sessions.get('s')?.contextCompact, undefined);
});

// ---------------------------------------------------------------------------
// A compaction moves no step: whatever status its 'running' turn covered comes
// back when it settles, on every path that ends the turn.
// ---------------------------------------------------------------------------

test('a compaction over a parked step settles back to waiting-approval', () => {
  const sessions = compacting({ status: 'waiting-approval', ...parked() });
  sessions.handleWorkerEvent('s', status({ compact_result: 'success' }));
  sessions.handleWorkerEvent('s', { type: 'result', subtype: 'success' });
  const after = sessions.get('s')!;
  assert.equal(after.status, 'waiting-approval'); // not 'done'
  assert.equal(after.workflow?.stepStatuses[0], 'waiting-approval');
});

test("a compaction over a failed step keeps the step's banner", () => {
  const sessions = compacting({
    status: 'error',
    errorMessage: 'the turn failed',
    ...parked({ stepFailure: 'turn' }),
  });
  sessions.handleWorkerEvent('s', { type: 'result', subtype: 'success' });
  const after = sessions.get('s')!;
  assert.equal(after.status, 'error');
  assert.equal(after.errorMessage, 'the turn failed');
});

test('a compaction that itself fails does not become the session failure', () => {
  const sessions = compacting({ status: 'waiting-approval', ...parked() });
  sessions.handleWorkerEvent('s', { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'nope' });
  const after = sessions.get('s')!;
  assert.equal(after.status, 'waiting-approval');
  assert.equal(after.errorMessage, undefined);
});

test('stopping a compaction leaves the parked step parked', () => {
  const sessions = compacting({ status: 'waiting-approval', ...parked() });
  sessions.interrupt('s'); // no `result` will follow
  assert.equal(sessions.get('s')!.status, 'waiting-approval'); // not 'idle'
});

test('a query that dies mid-compaction leaves the parked step parked', () => {
  const sessions = compacting({ status: 'waiting-approval', ...parked() });
  sessions.handleWorkerEnded('s');
  assert.equal(sessions.get('s')!.status, 'waiting-approval');
});

test('a compaction on a plain session still settles to done', () => {
  const sessions = compacting();
  sessions.handleWorkerEvent('s', { type: 'result', subtype: 'success' });
  assert.equal(sessions.get('s')!.status, 'done');
});
