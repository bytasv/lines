import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  PermissionRequestData,
  ServerMessage,
  SessionMeta,
  TranscriptEvent,
} from '@lines/shared';
import { formatPlanComments, KEEP_PLANNING_MESSAGE } from '@lines/shared';
import type { AuthManager, TokenRejection } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';

const meta = (id: string): SessionMeta =>
  ({
    id,
    name: id,
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    status: 'running',
    createdAt: 1,
  }) as SessionMeta;

/** What the fake worker was asked to send, message included: a transparent
 *  recovery re-pushes without writing anything to the transcript, so the pushed
 *  message is the only place its content can be asserted. */
interface Push {
  sessionId: string;
  message: Record<string, unknown>;
}

/**
 * A manager over a throwaway store, with token-rejection notifications counted.
 * `rejection` is what the fake AuthManager reports back; `withAuth: false` builds
 * the ambient-token manager, which has no login flow to offer.
 */
function harness(
  rejection: TokenRejection = { outcome: 'refreshed' },
  withAuth = true,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-ended-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta('s1')]));
  const store = createStore(root);
  let rejections = 0;
  let reports = rejection;
  const auth = {
    getAccessTokenSync: () => 'tok',
    ensureFreshToken: async () => 'tok',
    handleTokenRejected: async () => {
      rejections++;
      return reports;
    },
  } as unknown as AuthManager;
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(
    store,
    new GuardAllowlist(store),
    (msg) => broadcasts.push(msg),
    withAuth ? auth : undefined,
  );
  // index.ts wires a worker before any client can prompt; the model and permission
  // setters forward to it, so an unwired manager is not a state production has.
  const closes: string[] = [];
  const pushes: Push[] = [];
  sessions.attachWorker({
    setModel: () => {},
    close: (sessionId: string) => closes.push(sessionId),
    push: (sessionId: string, message: Record<string, unknown>) => pushes.push({ sessionId, message }),
    interrupt: () => {},
  } as never);
  const transcript = () => store.loadTranscript('s1');
  return {
    sessions,
    broadcasts,
    transcript,
    closes,
    pushes,
    rejections: () => rejections,
    /** Change what the next recovery refresh reports — e.g. a machine coming back online. */
    setRejection: (next: TokenRejection) => {
      reports = next;
    },
  };
}

/** The text blocks of a pushed message, joined: what the model was actually sent. */
const pushedText = (push: Push): string => {
  const content = (push.message.message as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
};

/** Let the recovery promise and its banner rewrite settle. */
async function drain() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** The trailing transcript event, which is what the web Retry button keys off. */
const lastResult = (events: TranscriptEvent[]) => {
  const last = events.at(-1);
  assert.equal(last?.kind, 'sdk');
  return last!.data as {
    type?: string;
    is_error?: boolean;
    subtype?: string;
    result?: string;
    stopped?: unknown;
    recovering?: unknown;
  };
};

test('a crashed query writes a failed result so the transcript can offer Retry', () => {
  const h = harness();
  h.sessions.handleWorkerEnded('s1', 'read ECONNRESET');
  h.sessions.flushPersist();

  const result = lastResult(h.transcript());
  assert.equal(result.type, 'result');
  assert.equal(result.is_error, true);
  assert.equal(result.subtype, 'error_during_execution');
  assert.equal(result.result, 'read ECONNRESET');
});

test('the failed result lands before the error status, so it is the trailing item', () => {
  const h = harness();
  h.sessions.handleWorkerEnded('s1', 'boom');

  const upserts = h.broadcasts.filter((m) => m.type === 'sessionUpsert');
  assert.equal(upserts.at(-1)?.type === 'sessionUpsert' && upserts.at(-1)?.session.status, 'error');
  // The transcript event is emitted first; the status upsert follows it.
  assert.equal(h.transcript().at(-1)?.kind, 'sdk');
});

test('an ordinary crash does not touch auth', () => {
  const h = harness();
  h.sessions.handleWorkerEnded('s1', 'Claude Code process exited with code 1');
  assert.equal(h.rejections(), 0);
});

/** The CLI's own wording for the case this recovery exists to make actionable. */
const CLI_401 = 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.';

test('a rejected-token crash notifies auth so the login modal can open', () => {
  const h = harness();
  h.sessions.handleWorkerEnded('s1', 'API Error: 401 Unauthorized');
  assert.equal(h.rejections(), 1);
});

/** A revoked token: the wording that fell through raw before, on the 403 the CLI
 *  raises it on as well as the reported 401. */
const CLI_REVOKED = 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.';

test('a revoked token is recognised as an auth failure, not left raw', async () => {
  const h = harness({ outcome: 'refreshed' });
  h.sessions.emitEvent('s1', 'user', { text: 'go on', source: 'user' });
  h.sessions.handleWorkerEvent('s1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: CLI_REVOKED,
  });
  await drain();

  // Recognised, refreshed and re-driven: the user is never asked to do anything.
  assert.equal(h.rejections(), 1);
  assert.equal(h.sessions.get('s1')!.errorMessage, undefined);
  assert.equal(h.pushes.length, 1);
});

test('an auth failure drops the query, so Retry cannot reuse the child that failed', async () => {
  const h = harness({ outcome: 'refreshed' });
  h.sessions.handleWorkerEnded('s1', CLI_REVOKED);
  await drain();

  assert.deepEqual(h.closes, ['s1']);
});

test('any failed turn drops its query, so one Retry is enough even unclassified', async () => {
  // The wording-independent half: a child the API has started rejecting is wedged
  // whether or not we recognise what it said, so no failure keeps its query.
  const h = harness();
  h.sessions.handleWorkerEvent('s1', failedResult('Claude Code process exited with code 1'));
  await drain();

  assert.deepEqual(h.closes, ['s1']);
  assert.equal(h.rejections(), 0); // still no token refresh — only auth acts
});

test('a recovered token on a crashed query rewrites the banner to say Retry will now work', async () => {
  // The crashed-query path still settles and still asks for a click: there is no
  // turn left in flight to re-drive (that is handleWorkerEvent's `result` branch,
  // covered by the transparent-recovery tests below).
  const h = harness({ outcome: 'refreshed' });
  h.sessions.handleWorkerEnded('s1', CLI_401);
  await drain();

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.status, 'error');
  assert.match(meta.errorMessage!, /Retry to continue/);
  assert.equal(meta.errorKind, undefined);
  // The transcript keeps the raw CLI text as the durable diagnostic record.
  assert.equal(lastResult(h.transcript()).result, CLI_401);
});

test('a dead refresh token asks for a sign-in and flags the session', async () => {
  const h = harness({ outcome: 'signed-out' });
  h.sessions.handleWorkerEnded('s1', CLI_401);
  await drain();

  const meta = h.sessions.get('s1')!;
  assert.match(meta.errorMessage!, /Sign in to Claude, then Retry/);
  assert.equal(meta.errorKind, 'auth');
});

test('a transient refresh failure explains itself without offering a sign-in', async () => {
  const h = harness({ outcome: 'refresh-failed', error: new Error('Token refresh failed (500)') });
  h.sessions.handleWorkerEnded('s1', CLI_401);
  await drain();

  const meta = h.sessions.get('s1')!;
  assert.match(meta.errorMessage!, /Could not refresh the Claude login/);
  assert.match(meta.errorMessage!, /500/);
  assert.equal(meta.errorKind, undefined);
});

test('a session that moved on keeps its new status instead of the revised banner', async () => {
  const h = harness({ outcome: 'signed-out' });
  h.sessions.handleWorkerEnded('s1', CLI_401);
  // A queued prompt flushed / the user hit Retry before the refresh resolved.
  h.sessions.setStatus('s1', 'running');
  await drain();

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.status, 'running');
  assert.equal(meta.errorMessage, undefined);
  assert.equal(meta.errorKind, undefined);
  // Recovery itself still ran — only the banner rewrite was dropped.
  assert.equal(h.rejections(), 1);
});

test('a failure result carrying only errors[] recovers its reason instead of degrading', async () => {
  const h = harness({ outcome: 'signed-out' });
  h.sessions.handleWorkerEvent('s1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [CLI_401],
  });
  await drain();

  assert.equal(h.rejections(), 1);
  const meta = h.sessions.get('s1')!;
  assert.match(meta.errorMessage!, /Sign in to Claude, then Retry/);
  assert.equal(meta.errorKind, 'auth');
});

test('failTurn is itself a classification point, so every caller is covered', async () => {
  const h = harness();
  h.sessions.failTurn('s1', `Failed to start the turn: ${CLI_401}`);
  await drain();
  assert.equal(h.rejections(), 1);
});

test('the recovery messages cannot re-classify themselves into a loop', async () => {
  const h = harness();
  h.sessions.failTurn('s1', 'Not signed in to Claude. Sign in, then Retry.');
  await drain();
  assert.equal(h.rejections(), 0);

  const h2 = harness();
  h2.sessions.failTurn('s1', 'The Claude login expired and could not be renewed. Sign in to Claude, then Retry.');
  await drain();
  assert.equal(h2.rejections(), 0);
});

test('ambient-token mode keeps the raw message and offers no sign-in', async () => {
  const h = harness({ outcome: 'signed-out' }, false);
  h.sessions.handleWorkerEnded('s1', CLI_401);
  await drain();

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.errorMessage, CLI_401);
  assert.equal(meta.errorKind, undefined);
  assert.equal(h.rejections(), 0);
});

/** The failure this second class of banner exists for: a content-filter block. */
const FILTERED =
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Output blocked by content filtering policy"}}';

/** A failed SDK result carrying `text` as its reason. */
const failedResult = (text: string) => ({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  result: text,
});

test('a blocked request is rewritten into the choices the user actually has', () => {
  const h = harness();
  h.sessions.handleWorkerEvent('s1', failedResult(FILTERED));

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.status, 'error');
  assert.equal(meta.errorKind, 'filtered');
  assert.match(meta.errorMessage!, /smaller pieces/);
  // No workflow, so nothing to skip — the banner must not offer it.
  assert.equal(meta.errorMessage!.includes('approve the step'), false);
  // The raw text stays in the transcript as the durable diagnostic record.
  assert.equal(lastResult(h.transcript()).result, FILTERED);
  // Classification is local: no token refresh was attempted.
  assert.equal(h.rejections(), 0);
});

test('the other named API failures each get their own banner', () => {
  // Deterministic failures only: an overload is re-driven transparently instead
  // (see the transparent-recovery section), so it has no banner until it gives up.
  const cases: [string, string, RegExp][] = [
    ['context', 'API Error: 400 prompt is too long: 214331 tokens > 200000 maximum', /context window/],
    ['invalid', 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}', /malformed/],
  ];
  for (const [kind, text, banner] of cases) {
    const h = harness();
    h.sessions.handleWorkerEvent('s1', failedResult(text));
    const meta = h.sessions.get('s1')!;
    assert.equal(meta.errorKind, kind, text);
    assert.match(meta.errorMessage!, banner);
  }
});

test('an unrecognised failure keeps its raw text and offers only Retry', () => {
  const h = harness();
  h.sessions.handleWorkerEvent('s1', failedResult('Claude Code process exited with code 1'));

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.errorMessage, 'Claude Code process exited with code 1');
  assert.equal(meta.errorKind, undefined);
});

test('an auth failure still wins over the other classifications', async () => {
  // Auth is the only kind that also acts (one refresh), so its async rewrite must
  // not be pre-empted — even though this text also carries a 400.
  const h = harness({ outcome: 'signed-out' });
  h.sessions.handleWorkerEvent('s1', failedResult(`API Error: 400 Bad Request — ${CLI_401}`));
  await drain();

  assert.equal(h.rejections(), 1);
  assert.equal(h.sessions.get('s1')!.errorKind, 'auth');
});

// ---------------------------------------------------------------------------
// Transparent turn recovery. A rejected token or a momentarily overloaded API
// says nothing about the work, so the turn is re-driven instead of settled: the
// session never leaves 'running', and the failed attempt stays in the transcript
// as a neutral `recovering` row. Only a credential the user has to fix surfaces.
// ---------------------------------------------------------------------------

/** A session one prompt into a turn — what every recovery is anchored to. */
function midTurn(rejection: TokenRejection = { outcome: 'refreshed' }) {
  const h = harness(rejection);
  h.sessions.get('s1')!.turnSource = 'user';
  h.sessions.emitEvent('s1', 'user', { text: 'go on', source: 'user' });
  return h;
}

/** The API's own wording for a transient overload. */
const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}';

test('a refreshed token re-sends the same turn instead of settling it', async () => {
  const h = midTurn();
  h.sessions.handleWorkerEvent('s1', failedResult(CLI_REVOKED));
  await drain();
  h.sessions.flushPersist();

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.status, 'running');
  assert.equal(meta.errorMessage, undefined);
  assert.equal(meta.errorKind, undefined);
  assert.equal(meta.turnSource, 'user', 'the turn was never settled');

  assert.equal(h.pushes.length, 1);
  assert.equal(pushedText(h.pushes[0]!), 'go on');
  // No second 'user' event: one turn with two attempts, so every turn-scoped scan
  // still slices from the same prompt.
  assert.equal(h.transcript().filter((e) => e.kind === 'user').length, 1);
  // The failed attempt is the durable diagnostic record, stamped to read neutrally.
  const result = lastResult(h.transcript());
  assert.equal(result.recovering, true);
  assert.equal(result.result, CLI_REVOKED);
  // Recovery closes the old query; token replacement may close it idempotently again.
  assert.ok(h.closes.length > 0);
  assert.ok(h.closes.every((id) => id === 's1'), 'only the rejected query is closed');
});

test('a second auth failure on the same turn settles for real', async () => {
  const h = midTurn();
  h.sessions.handleWorkerEvent('s1', failedResult(CLI_REVOKED));
  await drain();
  h.sessions.handleWorkerEvent('s1', failedResult(CLI_REVOKED));
  await drain();
  h.sessions.flushPersist();

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.status, 'error');
  assert.match(meta.errorMessage!, /Retry to continue/); // today's banner, unchanged
  assert.equal(h.pushes.length, 1, 'the budget is spent, so nothing is re-sent');
  assert.equal(lastResult(h.transcript()).recovering, undefined);
});

test('a dead stored credential is the one failure the user is asked to fix', async () => {
  const h = midTurn({ outcome: 'signed-out' });
  h.sessions.handleWorkerEvent('s1', failedResult(CLI_REVOKED));
  await drain();

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.status, 'error');
  assert.equal(meta.errorKind, 'auth');
  assert.match(meta.errorMessage!, /Sign in to Claude, then Retry/);
  assert.deepEqual(h.pushes, []);
});

test('giving up settles the turn so a workflow step can park on it', async () => {
  const h = midTurn({ outcome: 'signed-out' });
  const completions: [string, string, boolean, boolean][] = [];
  h.sessions.setTurnCompleteListener((id, source, interrupted, failed) =>
    completions.push([id, source, interrupted, failed]),
  );
  h.sessions.get('s1')!.turnSource = 'workflow';
  h.sessions.handleWorkerEvent('s1', failedResult(CLI_REVOKED));
  await drain();

  assert.deepEqual(completions, [['s1', 'workflow', false, true]]);
});

test('a turn being re-driven reports no completion, so no step parks mid-recovery', async () => {
  const h = midTurn();
  const completions: string[] = [];
  h.sessions.setTurnCompleteListener((id) => completions.push(id));
  h.sessions.handleWorkerEvent('s1', failedResult(CLI_REVOKED));
  await drain();

  assert.deepEqual(completions, []);
});

test('the failed attempt still bills what it burned', async () => {
  const h = midTurn();
  h.sessions.handleWorkerEvent('s1', {
    ...failedResult(CLI_REVOKED),
    total_cost_usd: 0.2,
    usage: { input_tokens: 900, output_tokens: 100 },
  });
  await drain();

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.totalCostUsd, 0.2);
  assert.equal(meta.totalTokens, 1_000);
});

test('an overloaded turn is re-sent after a backoff, not immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = midTurn();
  h.sessions.handleWorkerEvent('s1', failedResult(OVERLOADED));
  await drain();

  assert.deepEqual(h.pushes, [], 'nothing is re-sent before the backoff elapses');
  assert.equal(h.sessions.get('s1')!.status, 'running');
  assert.equal(h.rejections(), 0, 'an overload is not a token problem');

  t.mock.timers.tick(2_000);
  await drain();
  assert.equal(h.pushes.length, 1);
  assert.equal(pushedText(h.pushes[0]!), 'go on');
});

test('a third overload settles with the banner that names the wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = midTurn();
  for (const delay of [2_000, 8_000]) {
    h.sessions.handleWorkerEvent('s1', failedResult(OVERLOADED));
    await drain();
    t.mock.timers.tick(delay);
    await drain();
  }
  h.sessions.handleWorkerEvent('s1', failedResult(OVERLOADED));
  await drain();

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.status, 'error');
  assert.equal(meta.errorKind, 'overloaded');
  assert.match(meta.errorMessage!, /Wait a moment/);
  assert.equal(h.pushes.length, 2, 'two re-drives, then the real failure');
});

test('Stop during a recovery abandons it and leaves the session idle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = midTurn();
  h.sessions.handleWorkerEvent('s1', failedResult(OVERLOADED));
  await drain();
  h.sessions.interrupt('s1');

  t.mock.timers.tick(30_000);
  await drain();

  assert.equal(h.sessions.get('s1')!.status, 'idle');
  assert.deepEqual(h.pushes, []);
});

test('a new prompt supersedes the recovery of the turn before it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = midTurn();
  h.sessions.handleWorkerEvent('s1', failedResult(OVERLOADED));
  await drain();
  h.sessions.prompt('s1', 'do this instead');
  await drain();

  t.mock.timers.tick(30_000);
  await drain();

  assert.equal(h.pushes.length, 1, 'only the new prompt was sent');
  assert.equal(pushedText(h.pushes[0]!), 'do this instead');
});

test('an offline refresh holds the turn rather than spending its attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const offline = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const h = midTurn({ outcome: 'refresh-failed', error: offline });
  h.sessions.handleWorkerEvent('s1', failedResult(CLI_REVOKED));
  await drain();

  // Held, not failed: no banner, no button, nothing re-sent into a dead network.
  assert.equal(h.sessions.get('s1')!.status, 'running');
  assert.equal(h.sessions.get('s1')!.errorMessage, undefined);
  assert.deepEqual(h.pushes, []);

  // The probe that finally succeeds is the came-back-online signal.
  h.setRejection({ outcome: 'refreshed' });
  t.mock.timers.tick(5_000);
  await drain();

  assert.equal(h.pushes.length, 1);
  assert.equal(pushedText(h.pushes[0]!), 'go on');
});

test('a hold that never reconnects fails the turn with the refusal banner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const offline = Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } });
  const h = midTurn({ outcome: 'refresh-failed', error: offline });
  h.sessions.handleWorkerEvent('s1', failedResult(CLI_REVOKED));
  await drain();

  // Past the 5-minute hold budget, probing on a doubling backoff throughout.
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(60_000);
    await drain();
  }

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.status, 'error');
  assert.match(meta.errorMessage!, /Could not refresh the Claude login/);
  assert.equal(meta.errorKind, undefined, 'no sign-in button: the credential is fine');
  assert.deepEqual(h.pushes, []);
});

test('failTurn classifies the same way, so a refused push is covered too', () => {
  const h = harness();
  h.sessions.failTurn('s1', FILTERED);
  assert.equal(h.sessions.get('s1')!.errorKind, 'filtered');
});

test('a Retry after a blocked turn asks for the same result in a different shape', () => {
  const h = harness();
  h.sessions.emitEvent('s1', 'user', { text: 'Write out the whole licence', source: 'user' });
  h.sessions.handleWorkerEvent('s1', failedResult(FILTERED));

  const last = h.sessions.lastPromptForRetry('s1')!;
  assert.match(last.text, /^Write out the whole licence\n\n/);
  assert.match(last.text, /verbatim/);
  assert.equal(last.source, 'user');
  assert.deepEqual(last.attachments, []);
});

test('a Retry re-sends the prompt untouched where re-phrasing would not help', () => {
  for (const text of [
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    'Claude Code process exited with code 1',
  ]) {
    const h = harness();
    h.sessions.emitEvent('s1', 'user', { text: 'go on', source: 'user' });
    h.sessions.handleWorkerEvent('s1', failedResult(text));
    assert.equal(h.sessions.lastPromptForRetry('s1')!.text, 'go on', text);
  }
});

// ---------------------------------------------------------------------------
// Retry after a mid-turn gesture. Answering a card writes no 'user' event, so
// without the gesture scan a Retry re-sends the prompt that opened the turn —
// on a workflow plan step, the whole rendered step template.
// ---------------------------------------------------------------------------

/** The card as it is recorded when it is asked: the only place its tool name lives. */
const permissionRequest = (h: ReturnType<typeof harness>, requestId: string, toolName: string) =>
  h.sessions.emitEvent('s1', 'permission', { requestId, toolName, input: {} });

/** …and as it is recorded when it is answered (`toolName: ''`, by design). */
const permissionResolution = (
  h: ReturnType<typeof harness>,
  requestId: string,
  data: Partial<PermissionRequestData>,
) =>
  h.sessions.emitEvent('s1', 'permission', {
    requestId,
    toolName: '',
    input: {},
    resolution: 'allow',
    resolvedBy: 'user',
    ...data,
  } as PermissionRequestData);

/** A step prompt, a plan, then "Refine with comments" — the reported case. */
function refinedPlan(failure = 'boom') {
  const h = harness();
  h.sessions.emitEvent('s1', 'user', { text: 'do step 3', source: 'workflow' });
  permissionRequest(h, 'p1', 'ExitPlanMode');
  permissionResolution(h, 'p1', {
    resolution: 'deny',
    denyMessage: formatPlanComments([{ id: 'a', quote: 'step 3', note: 'add a rollback' }], 'refine'),
  });
  h.sessions.handleWorkerEvent('s1', failedResult(failure));
  return h;
}

test('a Retry after refining a plan re-sends the notes, not the prompt that opened the turn', () => {
  const last = refinedPlan().sessions.lastPromptForRetry('s1')!;

  assert.match(last.text, /^The previous turn failed before this reached you\./);
  assert.ok(last.text.includes(KEEP_PLANNING_MESSAGE));
  assert.match(last.text, /On "step 3": add a rollback/);
  assert.ok(!last.text.includes('do step 3'), 'the step template is not replayed');
  // A gesture has no attachments of its own; the opening prompt's are not its.
  assert.deepEqual(last.attachments, []);
  assert.equal(last.source, 'workflow', 'inherited from the turn that failed');
});

test('a retry hint still rides the gesture text', () => {
  const last = refinedPlan(FILTERED).sessions.lastPromptForRetry('s1')!;
  assert.match(last.text, /On "step 3": add a rollback/);
  assert.match(last.text, /verbatim/, 'the hint follows the gesture');
});

test('an auto-approved read is not the user speaking, so Retry re-sends the prompt', () => {
  const h = harness();
  h.sessions.emitEvent('s1', 'user', { text: 'do step 3', source: 'workflow' });
  permissionRequest(h, 'p1', 'Read');
  permissionResolution(h, 'p1', { resolvedBy: 'auto', auto: true });
  h.sessions.handleWorkerEvent('s1', failedResult('boom'));

  assert.equal(h.sessions.lastPromptForRetry('s1')!.text, 'do step 3');
});

test('a server-synthesized resolution never becomes retry text', () => {
  for (const resolvedBy of ['workflow-advance', 'recovery'] as const) {
    const h = harness();
    h.sessions.emitEvent('s1', 'user', { text: 'do step 3', source: 'workflow' });
    permissionRequest(h, 'p1', 'ExitPlanMode');
    permissionResolution(h, 'p1', { resolvedBy, denyMessage: 'synthesized' });
    h.sessions.handleWorkerEvent('s1', failedResult('boom'));

    assert.equal(h.sessions.lastPromptForRetry('s1')!.text, 'do step 3', resolvedBy);
  }
});

test('answered questions are replayed as answers, with an instruction not to re-ask', () => {
  const h = harness();
  h.sessions.emitEvent('s1', 'user', { text: 'do step 3', source: 'workflow' });
  permissionRequest(h, 'p1', 'AskUserQuestion');
  permissionResolution(h, 'p1', { answers: { 'Which store?': 'Postgres', 'Which auth?': 'Clerk' } });
  h.sessions.handleWorkerEvent('s1', failedResult('boom'));

  const last = h.sessions.lastPromptForRetry('s1')!;
  assert.match(last.text, /- Which store\?\n  Answer: Postgres/);
  assert.match(last.text, /- Which auth\?\n  Answer: Clerk/);
  assert.match(last.text, /Do not re-ask them/);
});

test('a plain allow is left to the CLI: it re-sends the prompt', () => {
  const h = harness();
  h.sessions.emitEvent('s1', 'user', { text: 'do step 3', source: 'workflow' });
  permissionRequest(h, 'p1', 'Bash');
  permissionResolution(h, 'p1', { updatedInput: { command: 'ls' } });
  h.sessions.handleWorkerEvent('s1', failedResult('boom'));

  assert.equal(h.sessions.lastPromptForRetry('s1')!.text, 'do step 3');
});

test('the newest gesture wins: an interjection outranks the resolution before it', () => {
  const h = harness();
  h.sessions.emitEvent('s1', 'user', { text: 'do step 3', source: 'workflow' });
  permissionRequest(h, 'p1', 'ExitPlanMode');
  permissionResolution(h, 'p1', { resolution: 'deny', denyMessage: 'earlier notes' });
  h.sessions.emitEvent('s1', 'interject', { text: 'also drop the index first' });
  h.sessions.handleWorkerEvent('s1', failedResult('boom'));

  const last = h.sessions.lastPromptForRetry('s1')!;
  assert.match(last.text, /also drop the index first/);
  assert.ok(!last.text.includes('earlier notes'));
});

test('a gesture still staged on the queue is held, not re-sent as a retry', () => {
  const h = harness();
  h.sessions.emitEvent('s1', 'user', { text: 'do step 3', source: 'workflow' });
  h.sessions.emitEvent('s1', 'interject', { text: 'also drop the index first' });
  h.sessions.handleWorkerEvent('s1', failedResult('boom'));
  const meta = h.sessions.get('s1')!;
  meta.queued = [{ id: 'q1', ts: 1, text: 'also drop the index first' }];

  assert.equal(h.sessions.lastPromptForRetry('s1')!.text, 'do step 3');
});

/** How the SDK reports a user interrupt: an error result with no `result` at all. */
const interruptResult = () => ({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  errors: ['Interrupted by user'],
});

test('a stopped turn is recorded as stopped, not failed', async () => {
  const h = harness();
  h.sessions.interrupt('s1');
  h.sessions.handleWorkerEvent('s1', interruptResult());
  await drain();
  h.sessions.flushPersist();

  // Annotated, never rewritten: the raw SDK verdict stays verbatim beside the stamp.
  const result = lastResult(h.transcript());
  assert.equal(result.stopped, true);
  assert.equal(result.is_error, true);
  assert.equal(result.subtype, 'error_during_execution');

  const meta = h.sessions.get('s1')!;
  assert.equal(meta.status, 'idle');
  assert.equal(meta.errorMessage, undefined);
  assert.equal(meta.errorKind, undefined);
});

test('a stopped turn keeps its query', async () => {
  // An interrupt leaves the CLI child healthy, so dropping it only buys the next
  // prompt a resume respawn.
  const h = harness();
  h.sessions.interrupt('s1');
  h.sessions.handleWorkerEvent('s1', interruptResult());
  await drain();

  assert.deepEqual(h.closes, []);
});

test('a genuine error result is still a failed turn', async () => {
  const h = harness();
  h.sessions.handleWorkerEvent('s1', interruptResult());
  await drain();
  h.sessions.flushPersist();

  assert.equal(lastResult(h.transcript()).stopped, undefined);
  const meta = h.sessions.get('s1')!;
  assert.equal(meta.status, 'error');
  assert.equal(meta.errorMessage, 'Interrupted by user');
  assert.deepEqual(h.closes, ['s1']);
});

test('the Stop flag is consumed exactly once', async () => {
  // A dangling flag would neutralise the next genuine failure.
  const h = harness();
  h.sessions.interrupt('s1');
  h.sessions.handleWorkerEvent('s1', interruptResult());
  await drain();
  h.sessions.handleWorkerEvent('s1', interruptResult());
  await drain();
  h.sessions.flushPersist();

  assert.equal(lastResult(h.transcript()).stopped, undefined);
});

test('a clean end writes no synthetic result', () => {
  const h = harness();
  h.sessions.handleWorkerEnded('s1');
  assert.deepEqual(h.transcript(), []);
});

test('an auth-failure result message notifies auth', () => {
  const h = harness();
  h.sessions.handleWorkerEvent('s1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'OAuth token has expired',
  });
  assert.equal(h.rejections(), 1);
});

test('a successful result message does not notify auth', () => {
  const h = harness();
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success', result: 'done' });
  assert.equal(h.rejections(), 0);
});

/** A settled turn's cost/usage payload, the shape the by-model split reads. */
const settled = (costUsd: number, inputTokens: number) => ({
  type: 'result',
  subtype: 'success',
  result: 'done',
  total_cost_usd: costUsd,
  usage: { input_tokens: inputTokens, output_tokens: 0 },
});

test('a settled turn splits its spend under the session model', () => {
  const h = harness();
  h.sessions.handleWorkerEvent('s1', settled(0.4, 1_000));
  h.sessions.handleWorkerEvent('s1', settled(0.6, 500));

  const meta = h.sessions.get('s1')!;
  assert.deepEqual(meta.costByModel, {
    'claude-opus-5': { costUsd: 1, tokens: 1_500, turns: 2 },
  });
  const summed = Object.values(meta.costByModel!).reduce((n, s) => n + s.costUsd, 0);
  assert.equal(summed, meta.totalCostUsd);
});

test('switching model mid-session opens a second row instead of moving the first', () => {
  const h = harness();
  h.sessions.handleWorkerEvent('s1', settled(0.4, 1_000));
  h.sessions.setModel('s1', 'claude-haiku-4-5');
  h.sessions.handleWorkerEvent('s1', settled(0.01, 200));

  const meta = h.sessions.get('s1')!;
  assert.deepEqual(meta.costByModel, {
    'claude-opus-5': { costUsd: 0.4, tokens: 1_000, turns: 1 },
    'claude-haiku-4-5': { costUsd: 0.01, tokens: 200, turns: 1 },
  });
});

test('a result carrying neither cost nor usage opens no row', () => {
  const h = harness();
  h.sessions.handleWorkerEvent('s1', { type: 'result', subtype: 'success', result: 'done' });
  assert.equal(h.sessions.get('s1')!.costByModel, undefined);
});
