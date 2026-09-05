import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  PermissionMode,
  PermissionRequestData,
  SessionMeta,
  SessionStatus,
  TranscriptEvent,
} from '@lines/shared';
import { KEEP_PLANNING_MESSAGE } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { planReplyDecision, SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient, WorkerRpc } from './workerClient.ts';

let seq = 0;
const ev = (kind: TranscriptEvent['kind'], data: unknown): TranscriptEvent =>
  ({ seq: ++seq, ts: 0, kind, data }) as TranscriptEvent;

const request = (requestId: string, toolName = 'ExitPlanMode') =>
  ev('permission', { requestId, toolName, input: {} });
const resolution = (requestId: string, res = 'deny') =>
  ev('permission', { requestId, toolName: '', input: {}, resolution: res });

const decide = (over: Partial<Parameters<typeof planReplyDecision>[0]> = {}) =>
  planReplyDecision({
    status: 'waiting-permission' as SessionStatus,
    pendingPermissionTool: 'ExitPlanMode',
    text: 'add a rollback step',
    hasAttachments: false,
    livePendingIds: ['r1'],
    events: [request('r1')],
    ...over,
  });

test('falls through when the session is not waiting on a permission', () => {
  assert.equal(decide({ status: 'idle' as SessionStatus }), null);
});

test('falls through when the pending card is some other tool', () => {
  assert.equal(decide({ pendingPermissionTool: 'Bash' }), null);
});

test('falls through on whitespace-only text', () => {
  assert.equal(decide({ text: '   \n ' }), null);
});

test('falls through when no ExitPlanMode request can be found', () => {
  assert.equal(decide({ livePendingIds: [], events: [] }), null);
});

test('picks the live pending ExitPlanMode request over a stale transcript one', () => {
  const got = decide({
    livePendingIds: ['live'],
    events: [request('stale'), request('live'), request('other', 'Bash')],
  });
  assert.equal(got?.requestId, 'live');
});

test('ignores a live pending id belonging to another tool', () => {
  const got = decide({
    livePendingIds: ['bash1'],
    events: [request('plan1'), request('bash1', 'Bash')],
  });
  assert.equal(got?.requestId, 'plan1');
});

test('falls back to the newest unresolved ExitPlanMode when the live map is empty', () => {
  const got = decide({
    livePendingIds: [],
    events: [request('old'), request('newer'), request('answered'), resolution('answered')],
  });
  assert.equal(got?.requestId, 'newer');
});

test('no attachments: the reason wraps the keep-planning prefix around the typed text', () => {
  const got = decide({ text: '  add a rollback step  ' });
  assert.equal(
    got?.denyMessage,
    `${KEEP_PLANNING_MESSAGE}\n\nThe user's message:\nadd a rollback step`,
  );
  assert.equal(got?.alsoQueue, false);
});

test('attachments: the reason never repeats the text the queued turn will carry', () => {
  const got = decide({ text: 'look at this', hasAttachments: true });
  assert.ok(got?.denyMessage.startsWith(KEEP_PLANNING_MESSAGE));
  assert.ok(!got!.denyMessage.includes('look at this'));
  assert.equal(got?.alsoQueue, true);
});

// ---------------------------------------------------------------------------
// Resolution provenance and idempotency (the whole point: only a human answer
// may move an always-ask request, and the transcript must record which did)
// ---------------------------------------------------------------------------

const cwd = '/tmp';

/** A manager over a throwaway store with one session and a seeded transcript. */
function harness(opts: { mode?: PermissionMode; events?: TranscriptEvent[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-provenance-'));
  fs.writeFileSync(
    path.join(root, 'sessions.json'),
    JSON.stringify([
      {
        id: 's1',
        name: 's1',
        cwd,
        model: 'claude-opus-5',
        permissionMode: opts.mode ?? 'default',
        status: 'running',
        createdAt: 1,
      } as SessionMeta,
    ]),
  );
  if (opts.events?.length) {
    fs.mkdirSync(path.join(root, 'transcripts'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'transcripts', 's1.jsonl'),
      opts.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }
  const store = createStore(root);
  const sessions = new SessionManager(store, new GuardAllowlist(store), () => {});
  const answered: unknown[] = [];
  const pushes: string[] = [];
  sessions.attachWorker({
    push: (id: string) => pushes.push(id),
    close: () => {},
    interrupt: () => {},
    rpcResult: (_id: string, result: unknown) => answered.push(result),
  } as unknown as WorkerClient);
  return {
    sessions,
    answered,
    pushes,
    s1: () => sessions.get('s1')!,
    cards: () =>
      store
        .loadTranscript('s1')
        .filter((e) => e.kind === 'permission')
        .map((e) => e.data as PermissionRequestData),
  };
}

let s = 0;
const requestEvent = (requestId: string, toolName: string): TranscriptEvent =>
  ({ seq: s++, ts: 0, kind: 'permission', data: { requestId, toolName, input: {} } }) as TranscriptEvent;
const resolutionEvent = (
  requestId: string,
  data: Partial<PermissionRequestData>,
): TranscriptEvent =>
  ({
    seq: s++,
    ts: 0,
    kind: 'permission',
    data: { requestId, toolName: '', input: {}, ...data },
  }) as TranscriptEvent;

const canUseTool = (requestId: string, toolName: string, resend = false): WorkerRpc => ({
  id: requestId,
  sessionId: 's1',
  kind: 'canUseTool',
  resend,
  payload: { toolName, input: { command: 'ls' } },
});

/** Let the fire-and-forget rpc chain settle (no timers involved). */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("a click on a live card is recorded as the user's", async () => {
  const h = harness();
  void h.sessions.handleWorkerRpc(canUseTool('r1', 'Bash'));
  await settle();
  h.sessions.resolvePermission('s1', 'r1', true);

  assert.equal(h.cards().at(-1)?.resolvedBy, 'user');
});

test('a typed composer reply to a plan is recorded as plan-reply', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('r1', 'ExitPlanMode'));
  await settle();
  h.sessions.userPrompt('s1', 'add a rollback step');

  const last = h.cards().at(-1)!;
  assert.equal(last.resolution, 'deny');
  assert.equal(last.resolvedBy, 'plan-reply');
});

test('a guard auto-approval is recorded as auto', async () => {
  const h = harness();
  await h.sessions.handleWorkerRpc({
    id: 'r1',
    sessionId: 's1',
    kind: 'preToolUse',
    resend: false,
    payload: { tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'a.ts') } },
  });

  assert.deepEqual(
    h.cards().map((c) => [c.resolution, c.resolvedBy]),
    [['allow', 'auto']],
  );
});

test('bypass mode resolves a tool call without a card', async () => {
  const h = harness({ mode: 'bypassPermissions' });
  await h.sessions.handleWorkerRpc(canUseTool('r1', 'Bash'));

  assert.deepEqual(h.answered, [{ behavior: 'allow', updatedInput: { command: 'ls' } }]);
  assert.deepEqual(
    h.cards().map((c) => [c.resolution, c.resolvedBy]),
    [['allow', 'auto']],
    'recorded as an auto-allow, never as a pending request',
  );
  assert.notEqual(h.s1().status, 'waiting-permission');
});

test('bypass mode still parks an always-ask tool on a card', async () => {
  const h = harness({ mode: 'bypassPermissions' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();

  assert.deepEqual(h.answered, []);
  assert.equal(h.s1().status, 'waiting-permission');
});

test('a second answer for an already-resolved request changes nothing', () => {
  const h = harness({
    mode: 'plan',
    events: [
      requestEvent('p1', 'ExitPlanMode'),
      resolutionEvent('p1', { resolution: 'allow', resolvedBy: 'user' }),
    ],
  });
  h.sessions.resolvePermission('s1', 'p1', true);

  assert.equal(h.cards().length, 2, 'no second resolution event');
  assert.deepEqual(h.pushes, [], 'no recovery prompt injected');
  assert.equal(h.s1().permissionMode, 'plan', 'plan mode not flipped off a stale answer');
});

test('a resend replays the newest recorded resolution', async () => {
  const h = harness({
    events: [
      requestEvent('r1', 'Bash'),
      resolutionEvent('r1', { resolution: 'deny', denyMessage: 'no' }),
      resolutionEvent('r1', { resolution: 'allow', resolvedBy: 'user', updatedInput: { command: 'ls -l' } }),
    ],
  });
  await h.sessions.handleWorkerRpc(canUseTool('r1', 'Bash', true));

  assert.deepEqual(h.answered, [{ behavior: 'allow', updatedInput: { command: 'ls -l' } }]);
});

test('a resend re-asks an always-ask card whose allow was synthesized', async () => {
  const h = harness({
    mode: 'plan',
    events: [
      requestEvent('p1', 'ExitPlanMode'),
      resolutionEvent('p1', { resolution: 'allow', resolvedBy: 'recovery' }),
    ],
  });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode', true));
  await settle();

  assert.deepEqual(h.answered, [], 'a synthesized allow is not a real approval');
  assert.equal(h.s1().status, 'waiting-permission');
});

test('a resend replays an always-ask card the user really answered', async () => {
  const h = harness({
    mode: 'plan',
    events: [
      requestEvent('p1', 'ExitPlanMode'),
      resolutionEvent('p1', { resolution: 'allow', resolvedBy: 'user' }),
    ],
  });
  await h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode', true));

  assert.deepEqual(h.answered, [{ behavior: 'allow', updatedInput: { command: 'ls' } }]);
});

test('a legacy resolution with no resolvedBy still counts as the user', async () => {
  const h = harness({
    mode: 'plan',
    events: [requestEvent('p1', 'ExitPlanMode'), resolutionEvent('p1', { resolution: 'allow' })],
  });
  await h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode', true));

  assert.deepEqual(h.answered, [{ behavior: 'allow', updatedInput: { command: 'ls' } }]);
});

test('a model-initiated EnterPlanMode is mirrored into the session mode', async () => {
  const h = harness();
  await h.sessions.handleWorkerRpc({
    id: 'r1',
    sessionId: 's1',
    kind: 'preToolUse',
    resend: false,
    payload: { tool_name: 'EnterPlanMode', tool_input: {} },
  });

  assert.equal(h.s1().permissionMode, 'plan', 'so a query restart keeps edits gated');
});
