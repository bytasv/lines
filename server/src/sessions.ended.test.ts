import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta, TranscriptEvent } from '@lines/shared';
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
    caveman: { enabled: false, level: 'full' },
    status: 'running',
    createdAt: 1,
  }) as SessionMeta;

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
  const auth = {
    getAccessTokenSync: () => 'tok',
    ensureFreshToken: async () => 'tok',
    handleTokenRejected: async () => {
      rejections++;
      return rejection;
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
  sessions.attachWorker({
    setModel: () => {},
    close: (sessionId: string) => closes.push(sessionId),
    push: () => {},
    interrupt: () => {},
  } as never);
  const transcript = () => store.loadTranscript('s1');
  return { sessions, broadcasts, transcript, closes, rejections: () => rejections };
}

/** Let the recovery promise and its banner rewrite settle. */
async function drain() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** The trailing transcript event, which is what the web Retry button keys off. */
const lastResult = (events: TranscriptEvent[]) => {
  const last = events.at(-1);
  assert.equal(last?.kind, 'sdk');
  return last!.data as { type?: string; is_error?: boolean; subtype?: string; result?: string };
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
  h.sessions.handleWorkerEvent('s1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: CLI_REVOKED,
  });
  await drain();

  assert.equal(h.rejections(), 1);
  assert.match(h.sessions.get('s1')!.errorMessage!, /Retry to continue/);
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

test('a recovered token rewrites the banner to say Retry will now work', async () => {
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
  const cases: [string, string, RegExp][] = [
    ['context', 'API Error: 400 prompt is too long: 214331 tokens > 200000 maximum', /context window/],
    ['overloaded', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', /Wait a moment/],
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
