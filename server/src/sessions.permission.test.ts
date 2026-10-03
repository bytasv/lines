import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  Actor,
  PermissionMode,
  PermissionRequestData,
  QueuedPrompt,
  SessionMeta,
  SessionStatus,
  TranscriptEvent,
  UserUiSettings,
  WorkflowState,
} from '@lines/shared';
import {
  KEEP_PLANNING_MESSAGE,
  PLAN_REPLY_MARKER,
  planModeRejectMessage,
  formatPlanComments,
  keepPlanningReason,
  normalizePlanComments,
  type PlanComment,
} from '@lines/shared';
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
// Plan comments — the validation gate and the single-sourced wording
// ---------------------------------------------------------------------------

test('a comment with no note is dropped, not rejected', () => {
  const got = normalizePlanComments([
    { id: 'a', quote: 'q', note: '  ' },
    { id: 'b', quote: 'q2', note: ' keep me ' },
    { id: 'c', quote: 'q3' },
  ]);
  assert.deepEqual(got, [{ id: 'b', quote: 'q2', note: 'keep me' }]);
});

test('a non-array payload normalizes to nothing', () => {
  assert.deepEqual(normalizePlanComments(undefined), []);
  assert.deepEqual(normalizePlanComments('nope'), []);
  assert.deepEqual(normalizePlanComments([null, 3, 'x']), []);
});

test('an oversized quote and note are truncated', () => {
  const [got] = normalizePlanComments([
    { id: 'a', quote: 'q'.repeat(500), note: 'n'.repeat(5000) },
  ]);
  assert.equal(got.quote.length, 280);
  assert.equal(got.note.length, 2000);
});

test('the list is capped', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, quote: 'q', note: 'n' }));
  assert.equal(normalizePlanComments(many).length, 20);
});

test('refine wording keeps the prefix and marker planReplyText parses', () => {
  const comments: PlanComment[] = [{ id: 'a', quote: 'step 3', note: 'add a rollback' }];
  const text = formatPlanComments(comments, 'refine');
  assert.ok(text.startsWith(KEEP_PLANNING_MESSAGE));
  assert.ok(text.includes("The user's message:\n"));
  assert.ok(text.includes('On "step 3": add a rollback'));
});

test('approve wording names the count and carries the same body', () => {
  const text = formatPlanComments(
    [
      { id: 'a', quote: 'step 3', note: 'add a rollback' },
      { id: 'b', quote: 'step 4', note: 'skip it' },
    ],
    'approve',
  );
  assert.ok(text.includes('2 comments'));
  assert.ok(!text.startsWith(KEEP_PLANNING_MESSAGE), 'an approval is not a keep-planning');
  assert.ok(text.includes('On "step 3": add a rollback'));
  assert.ok(text.includes('On "step 4": skip it'));
});

test('an empty list formats to nothing at all', () => {
  assert.equal(formatPlanComments([], 'approve'), '');
  assert.equal(formatPlanComments([], 'refine'), '');
});

// ---------------------------------------------------------------------------
// Resolution provenance and idempotency (the whole point: only a human answer
// may move an always-ask request, and the transcript must record which did)
// ---------------------------------------------------------------------------

const cwd = '/tmp';

/** A manager over a throwaway store with one session and a seeded transcript. */
function harness(
  opts: {
    mode?: PermissionMode;
    events?: TranscriptEvent[];
    workflow?: WorkflowState;
    settings?: UserUiSettings;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-provenance-'));
  fs.writeFileSync(
    path.join(root, 'sessions.json'),
    JSON.stringify([
      {
        id: 's1',
        name: 's1',
        cwd,
        model: 'claude-opus-5-5',
        permissionMode: opts.mode ?? 'default',
        status: 'running',
        createdAt: 1,
        ...(opts.workflow ? { workflow: opts.workflow } : {}),
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
  if (opts.settings) fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(opts.settings));
  const store = createStore(root);
  const sessions = new SessionManager(store, new GuardAllowlist(store), () => {});
  const answered: unknown[] = [];
  const pushes: string[] = [];
  const pushed: Record<string, unknown>[] = [];
  const modePushes: string[] = [];
  sessions.attachWorker({
    push: (id: string, message: Record<string, unknown>) => {
      pushes.push(id);
      pushed.push(message);
    },
    setPermissionMode: (_id: string, mode: string) => modePushes.push(mode),
    close: () => {},
    interrupt: () => {},
    rpcResult: (_id: string, result: unknown) => answered.push(result),
    // canInterject refuses a closed link outright, so an interjection test needs
    // this open. Everything else ignores it.
    linkOpen: true,
  } as unknown as WorkerClient);
  return {
    sessions,
    answered,
    pushes,
    pushed,
    modePushes,
    s1: () => sessions.get('s1')!,
    /**
     * Pretend this bridge spawned the running query. `canInterject` only steers a
     * query whose token it remembers, and nothing in this harness ever pushes a
     * turn, so the map it consults stays empty otherwise.
     */
    goLive: () =>
      (sessions as unknown as { queryTokens: Map<string, string | null> }).queryTokens.set(
        's1',
        null,
      ),
    cards: () =>
      store
        .loadTranscript('s1')
        .filter((e) => e.kind === 'permission')
        .map((e) => e.data as PermissionRequestData),
    interjections: () =>
      store
        .loadTranscript('s1')
        .filter((e) => e.kind === 'interject')
        .map((e) => e.data as { text: string }),
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

/** A canUseTool rpc with an explicit input, for calls other than a bare `ls`. */
const canUseToolWith = (requestId: string, toolName: string, input: Record<string, unknown>): WorkerRpc => ({
  id: requestId,
  sessionId: 's1',
  kind: 'canUseTool',
  resend: false,
  payload: { toolName, input },
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

// ---------------------------------------------------------------------------
// Plan comments, end to end through resolvePermission
// ---------------------------------------------------------------------------

const NOTES: PlanComment[] = [{ id: 'a', quote: 'step 3', note: 'add a rollback' }];

const ALICE: Actor = { userId: 'u-alice', name: 'Alice', imageUrl: null };

/** resolvePermission's trailing params are positional; this names the two that matter. */
const answerPlan = (
  h: ReturnType<typeof harness>,
  allow: boolean,
  comments: PlanComment[],
  denyMessage?: string,
) =>
  h.sessions.resolvePermission(
    's1',
    'p1',
    allow,
    undefined,
    undefined,
    denyMessage,
    undefined,
    'user',
    undefined,
    comments,
  );

test('approving a plan with comments allows it and steers the turn it started', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  h.goLive();
  answerPlan(h, true, NOTES);
  await settle();

  const last = h.cards().at(-1)!;
  assert.equal(last.resolution, 'allow', 'an approval stays a real allow');
  assert.equal(last.resolvedBy, 'user');
  const text = h.interjections().at(-1)?.text ?? '';
  assert.match(text, /step 3/);
  assert.match(text, /add a rollback/);
  assert.deepEqual(h.s1().queued ?? [], [], 'delivered into the turn, not left for the next one');
});

test('comments on an approval reach the queue when the turn cannot be steered', async () => {
  // No goLive(): this bridge does not know the query, which is one of the
  // conditions canInterject refuses on.
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  answerPlan(h, true, NOTES);
  await settle();

  assert.deepEqual(h.interjections(), [], 'nothing was pushed into the turn');
  assert.match(h.s1().queued?.[0]?.text ?? '', /add a rollback/, 'staged, never dropped');
});

test('refining with comments builds the deny reason from them, not from the client', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  h.goLive();
  answerPlan(h, false, NOTES, 'whatever the client sent');
  await settle();

  const last = h.cards().at(-1)!;
  assert.equal(last.resolution, 'deny');
  assert.ok(last.denyMessage?.startsWith(KEEP_PLANNING_MESSAGE));
  assert.match(last.denyMessage!, /On "step 3": add a rollback/);
  assert.ok(!last.denyMessage!.includes('whatever the client sent'));
  assert.deepEqual(h.interjections(), [], 'a refusal never interjects');
});

test('a Retry after refining re-sends the notes, off the real emit path', async () => {
  // The reported bug: the notes never become a 'user' event, so a Retry used to
  // re-send whatever opened the turn (a workflow step's rendered template).
  const h = harness({ mode: 'plan', events: [ev('user', { text: 'do step 3', source: 'workflow' })] });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  h.goLive();
  answerPlan(h, false, NOTES);

  const last = h.sessions.lastPromptForRetry('s1')!;
  assert.ok(last.text.includes(KEEP_PLANNING_MESSAGE));
  assert.match(last.text, /On "step 3": add a rollback/);
  assert.ok(!last.text.includes('do step 3'));
});

test('a workflow plan-step gate folds comments into its message and never interjects', async () => {
  const h = harness({
    mode: 'plan',
    workflow: {
      workflowId: 'wf1',
      started: true,
      stepIndex: 0,
      stepStatuses: ['running'],
    },
  });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  h.goLive();
  answerPlan(h, true, NOTES);
  await settle();

  assert.equal(h.cards().at(-1)?.resolvedBy, 'workflow-advance');
  assert.deepEqual(h.interjections(), [], 'the step is ending — there is no turn to steer');
  const gate = JSON.stringify(h.answered.at(-1));
  assert.match(gate, /The user approved this plan/);
  assert.match(gate, /add a rollback/);
});

test('an empty comment list resolves exactly as it did before the feature', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  h.goLive();
  answerPlan(h, true, []);
  await settle();

  assert.equal(h.cards().at(-1)?.resolution, 'allow');
  assert.deepEqual(h.interjections(), []);
  assert.deepEqual(h.s1().queued ?? [], []);
  assert.equal(h.s1().permissionMode, 'auto', 'approval leaves plan mode and lands in Assist');
});

test('leaving plan mode on approval is pushed to the worker, not only written to meta', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  h.goLive();
  answerPlan(h, true, []);
  await settle();

  // 'auto' is not an SDK mode — the worker has to be told, or the CLI keeps
  // enforcing plan mode while the pill says otherwise.
  assert.deepEqual(h.modePushes, ['acceptEdits']);
});

// ---------------------------------------------------------------------------
// Queued messages folded into a "Keep planning" deny
// ---------------------------------------------------------------------------

/** Stage items straight on the queue — get() hands back the live meta object. */
const seedQueue = (h: ReturnType<typeof harness>, items: Partial<QueuedPrompt>[]) => {
  h.s1().queued = items.map((over, i) => ({
    id: `q${i}`,
    ts: 1000 + i,
    text: '',
    ...over,
  })) as QueuedPrompt[];
};

/** The button: a bare keep-planning deny, no comments. */
const keepPlanning = (h: ReturnType<typeof harness>, actor?: Actor) =>
  h.sessions.resolvePermission(
    's1',
    'p1',
    false,
    undefined,
    undefined,
    KEEP_PLANNING_MESSAGE,
    undefined,
    'user',
    actor,
  );

test('Keep planning folds a queued message in, exactly as typing it at the card would', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  seedQueue(h, [{ text: 'add a rollback step' }]);
  keepPlanning(h);
  await settle();

  const last = h.cards().at(-1)!;
  assert.equal(last.resolution, 'deny');
  // Byte-identical to the typed-reply path: the same words must read the same way.
  assert.equal(last.denyMessage, decide({ text: 'add a rollback step' })!.denyMessage);
  assert.deepEqual(h.s1().queued, [], 'the row is gone, not left to strand');
});

test('several queued messages fold in order, into one reason', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  seedQueue(h, [{ text: 'first' }, { text: 'second' }]);
  keepPlanning(h);
  await settle();

  assert.equal(h.cards().at(-1)?.denyMessage, keepPlanningReason('first\n\nsecond'));
  assert.deepEqual(h.s1().queued, []);
});

test('comments and a queued message compose into one marker', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  seedQueue(h, [{ text: 'and rename the flag' }]);
  answerPlan(h, false, NOTES, 'whatever the client sent');
  await settle();

  const msg = h.cards().at(-1)!.denyMessage!;
  assert.equal(msg, keepPlanningReason('1. On "step 3": add a rollback\n\nand rename the flag'));
  assert.equal(msg.split(PLAN_REPLY_MARKER).length, 2, 'one marker, not one per body');
});

test('an empty queue leaves the deny reason exactly as the client sent it', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  keepPlanning(h);
  await settle();

  assert.equal(h.cards().at(-1)?.denyMessage, KEEP_PLANNING_MESSAGE);
  assert.deepEqual(h.answered.at(-1), {
    behavior: 'deny',
    message: KEEP_PLANNING_MESSAGE,
  });
});

test('a typed reply does not also eat the queue', async () => {
  // 'plan-reply' already carries the user's words; folding there would jump the
  // queue ahead of the row that was waiting first.
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  seedQueue(h, [{ text: 'queued earlier' }]);
  h.sessions.userPrompt('s1', 'typed now');
  await settle();

  const last = h.cards().at(-1)!;
  assert.equal(last.resolvedBy, 'plan-reply');
  assert.ok(!last.denyMessage!.includes('queued earlier'));
  assert.equal(h.s1().queued?.length, 1, 'still queued, untouched');
});

test('a paused queue is never released by a Keep planning click', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  seedQueue(h, [{ text: 'held for the owner', actor: ALICE }]);
  h.s1().queuePaused = true;
  keepPlanning(h);
  await settle();

  assert.equal(h.cards().at(-1)?.denyMessage, KEEP_PLANNING_MESSAGE);
  assert.equal(h.s1().queued?.length, 1);
  assert.equal(h.s1().queuePaused, true);
});

test('the folded text is persisted on the resolution, so Retry can re-send it', async () => {
  const h = harness({
    mode: 'plan',
    events: [ev('user', { text: 'do step 3', source: 'workflow' })],
  });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();
  seedQueue(h, [{ text: 'add a rollback step' }]);
  keepPlanning(h);
  await settle();

  const last = h.sessions.lastPromptForRetry('s1')!;
  assert.match(last.text, /add a rollback step/);
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

// ---------------------------------------------------------------------------
// Plan mode: read-only auto-approve and the reject-writes setting
// ---------------------------------------------------------------------------

const readOnlyBash = { command: 'cd /tmp && ls | grep -i lines' };
const projectEdit = { file_path: path.join(cwd, 'a.ts'), old_string: 'a', new_string: 'b' };
const rejectWrites: UserUiSettings = { planModeRejectWrites: true };

test('plan mode auto-approves read-only Bash without a card', async () => {
  const h = harness({ mode: 'plan' });
  await h.sessions.handleWorkerRpc(canUseToolWith('r1', 'Bash', readOnlyBash));

  assert.deepEqual(h.answered, [{ behavior: 'allow', updatedInput: readOnlyBash }]);
  assert.deepEqual(
    h.cards().map((c) => [c.resolution, c.resolvedBy]),
    [['allow', 'auto']],
  );
  assert.notEqual(h.s1().status, 'waiting-permission');
});

test('plan mode still parks a writing Bash command', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseToolWith('r1', 'Bash', { command: 'npm install x' }));
  await settle();

  assert.deepEqual(h.answered, []);
  assert.equal(h.s1().status, 'waiting-permission');
});

test('plan mode still parks an edit of a project file', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseToolWith('r1', 'Edit', projectEdit));
  await settle();

  assert.deepEqual(h.answered, []);
  assert.equal(h.s1().status, 'waiting-permission');
});

test('plan mode still parks ExitPlanMode', async () => {
  const h = harness({ mode: 'plan' });
  void h.sessions.handleWorkerRpc(canUseTool('p1', 'ExitPlanMode'));
  await settle();

  assert.deepEqual(h.answered, []);
  assert.equal(h.s1().status, 'waiting-permission');
});

test('read-only Bash outside plan mode still parks', async () => {
  const h = harness({ mode: 'default' });
  void h.sessions.handleWorkerRpc(canUseToolWith('r1', 'Bash', readOnlyBash));
  await settle();

  assert.deepEqual(h.answered, []);
  assert.equal(h.s1().status, 'waiting-permission');
});

test('reject-writes denies a plan-mode edit without a card', async () => {
  const h = harness({ mode: 'plan', settings: rejectWrites });
  await h.sessions.handleWorkerRpc(canUseToolWith('r1', 'Edit', projectEdit));

  const message = planModeRejectMessage('`Edit` edits a file outside the plan');
  assert.deepEqual(h.answered, [{ behavior: 'deny', message }]);
  const cards = h.cards();
  assert.deepEqual(
    cards.map((c) => [c.resolution, c.resolvedBy, c.auto]),
    [['deny', 'plan-readonly', true]],
  );
  assert.equal(cards[0].denyMessage, message);
  assert.equal(cards[0].guardReason, '`Edit` edits a file outside the plan');
  assert.notEqual(h.s1().status, 'waiting-permission');
});

test('reject-writes denies a writing Bash command but still allows a read', async () => {
  const h = harness({ mode: 'plan', settings: rejectWrites });
  await h.sessions.handleWorkerRpc(canUseToolWith('r1', 'Bash', { command: 'npm install x' }));
  await h.sessions.handleWorkerRpc(canUseToolWith('r2', 'Bash', readOnlyBash));

  assert.deepEqual(h.answered, [
    { behavior: 'deny', message: planModeRejectMessage('Installing new packages') },
    { behavior: 'allow', updatedInput: readOnlyBash },
  ]);
});

test('reject-writes parks a command it cannot check, naming the prefix', async () => {
  const h = harness({ mode: 'plan', settings: rejectWrites });
  void h.sessions.handleWorkerRpc(canUseToolWith('r1', 'Bash', { command: "node -e 'console.log(1)'" }));
  await settle();

  assert.deepEqual(h.answered, []);
  assert.equal(h.s1().status, 'waiting-permission');
  assert.deepEqual(h.cards()[0].planRead, {
    reason: "`node -e` isn't on the plan-mode read-only list",
    prefix: 'node -e',
  });
});

test('Allow as read records a plan-read entry, so the same command stops asking', async () => {
  const h = harness({ mode: 'plan', settings: rejectWrites });
  const nodeE = { command: "node -e 'console.log(1)'" };
  void h.sessions.handleWorkerRpc(canUseToolWith('r1', 'Bash', nodeE));
  await settle();
  h.sessions.resolvePermission('s1', 'r1', true, undefined, undefined, undefined, false, 'user', undefined, [], true);
  await h.sessions.handleWorkerRpc(canUseToolWith('r2', 'Bash', { command: "node -e 'console.log(2)'" }));

  await settle();

  // r2 is answered without a card of its own.
  assert.deepEqual(
    h.cards().filter((c) => c.requestId !== 'r1').map((c) => [c.resolution, c.resolvedBy]),
    [['allow', 'auto']],
  );
  assert.ok(
    h.answered.some(
      (a) => JSON.stringify(a) === JSON.stringify({ behavior: 'allow', updatedInput: { command: "node -e 'console.log(2)'" } }),
    ),
  );
});

test('reject-writes still parks the always-ask tools', async () => {
  for (const tool of ['ExitPlanMode', 'AskUserQuestion']) {
    const h = harness({ mode: 'plan', settings: rejectWrites });
    void h.sessions.handleWorkerRpc(canUseTool('p1', tool));
    await settle();

    assert.deepEqual(h.answered, [], tool);
    assert.equal(h.s1().status, 'waiting-permission', tool);
  }
});

test('reject-writes denies a Lines workflow write', async () => {
  const h = harness({ mode: 'plan', settings: rejectWrites });
  await h.sessions.handleWorkerRpc(canUseToolWith('r1', 'mcp__lines__save_step', {}));

  assert.deepEqual(h.answered, [
    { behavior: 'deny', message: planModeRejectMessage('`save_step` changes state through an MCP server') },
  ]);
});

test('reject-writes does nothing outside plan mode', async () => {
  const h = harness({ mode: 'default', settings: rejectWrites });
  void h.sessions.handleWorkerRpc(canUseToolWith('r1', 'Edit', projectEdit));
  await settle();

  assert.deepEqual(h.answered, []);
  assert.equal(h.s1().status, 'waiting-permission');
});

test('with reject-writes off a plan-mode edit still parks', async () => {
  const h = harness({ mode: 'plan', settings: { planModeRejectWrites: false } });
  void h.sessions.handleWorkerRpc(canUseToolWith('r1', 'Edit', projectEdit));
  await settle();

  assert.deepEqual(h.answered, []);
  assert.equal(h.s1().status, 'waiting-permission');
});

test('the PreToolUse hook denies a plan-mode edit when reject-writes is on', async () => {
  const h = harness({ mode: 'plan', settings: rejectWrites });
  await h.sessions.handleWorkerRpc({
    id: 'h1',
    sessionId: 's1',
    kind: 'preToolUse',
    resend: false,
    payload: { tool_name: 'Edit', tool_input: projectEdit },
  });

  const out = h.answered[0] as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(
    h.cards().map((c) => [c.resolution, c.resolvedBy]),
    [['deny', 'plan-readonly']],
  );
});
