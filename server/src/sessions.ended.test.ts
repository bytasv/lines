import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta, TranscriptEvent } from '@lines/shared';
import type { AuthManager } from './auth.ts';
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

/** A manager over a throwaway store, with token-rejection notifications counted. */
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-ended-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify([meta('s1')]));
  const store = createStore(root);
  let rejections = 0;
  const auth = {
    getAccessTokenSync: () => 'tok',
    ensureFreshToken: async () => 'tok',
    handleTokenRejected: async () => {
      rejections++;
    },
  } as unknown as AuthManager;
  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(
    store,
    new GuardAllowlist(store),
    (msg) => broadcasts.push(msg),
    auth,
  );
  const transcript = () => store.loadTranscript('s1');
  return { sessions, broadcasts, transcript, rejections: () => rejections };
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

test('a rejected-token crash notifies auth so the login modal can open', () => {
  const h = harness();
  h.sessions.handleWorkerEnded('s1', 'API Error: 401 Unauthorized');
  assert.equal(h.rejections(), 1);
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
