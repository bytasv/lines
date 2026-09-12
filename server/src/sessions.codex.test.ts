import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CODEX_NOTIFICATION } from '@lines/shared';
import type { ServerMessage, SessionMeta } from '@lines/shared';
import type { AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import type { OpenaiAuthManager } from './openaiAuth.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';
import type { WorkerClient } from './workerClient.ts';

/**
 * Routing and gates for a session on an OpenAI model. The properties under test
 * are all about what a codex turn must NOT touch: the Claude token, the Claude
 * CLI check, and the `authStatus` broadcast that force-opens the Claude login
 * modal — an OpenAI-only user hits every one of them on their first turn.
 *
 * `LINES_CODEX_PATH` is exclusive (see codexCli.ts), which is what lets this file
 * force "no codex" or "a codex" regardless of the machine. node:test gives each
 * file its own process, so the env and the module-level cache stay local to it.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-codex-session-'));
const FAKE_CODEX = path.join(TMP, 'codex');
fs.writeFileSync(FAKE_CODEX, '#!/bin/sh\necho "codex-cli 99.0.0"\n', { mode: 0o755 });

const meta = (id: string, model: string): SessionMeta =>
  ({
    id,
    name: id,
    cwd: '/tmp',
    model,
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
  }) as SessionMeta;

interface HarnessOptions {
  model?: string;
  openaiConnected?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-codex-store-'));
  fs.writeFileSync(
    path.join(root, 'sessions.json'),
    JSON.stringify([meta('s1', opts.model ?? 'gpt-5.6-terra')]),
  );
  const store = createStore(root);

  // Every call here is a failure: a codex push must never reach the Claude token.
  let claudeTokenReads = 0;
  const auth = {
    getAccessTokenSync: () => {
      claudeTokenReads++;
      return 'tok';
    },
    ensureFreshToken: async () => {
      claudeTokenReads++;
      return 'tok';
    },
    handleTokenRejected: async () => ({ outcome: 'refreshed' }),
  } as unknown as AuthManager;

  const openaiAuth = {
    isLoggedIn: () => opts.openaiConnected !== false,
    getStatus: () => ({ loggedIn: opts.openaiConnected !== false }),
  } as unknown as OpenaiAuthManager;

  const broadcasts: ServerMessage[] = [];
  const sessions = new SessionManager(
    store,
    new GuardAllowlist(store),
    (msg) => broadcasts.push(msg),
    auth,
    undefined,
    openaiAuth,
  );
  const pushes: {
    options: Record<string, unknown>;
    message: unknown;
    engine?: string;
  }[] = [];
  sessions.attachWorker({
    push: (
      _sessionId: string,
      message: unknown,
      options: Record<string, unknown>,
      _tools: unknown,
      engine?: string,
    ) => pushes.push({ options, message, engine }),
    close: () => {},
    interrupt: () => {},
    setModel: () => {},
    setPermissionMode: () => {},
    contextUsage: () => Promise.reject(new Error('no-live-session')),
  } as unknown as WorkerClient);

  return { sessions, store, pushes, broadcasts, claudeTokenReads: () => claudeTokenReads };
}

/** One app-server notification, in the envelope the worker forwards. */
const notify = (method: string, params: Record<string, unknown> = {}) => ({
  type: CODEX_NOTIFICATION,
  method,
  params,
});

/** Let the fire-and-forget pushTurn chain settle (no timers involved). */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function refreshCodex() {
  const { refreshCodexCli } = await import('./codexCli.ts');
  return refreshCodexCli();
}

test('an OpenAI model pushes with engine codex and never reads the Claude token', async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness();

  h.sessions.prompt('s1', 'list the files');
  await settle();

  assert.equal(h.pushes.length, 1);
  const push = h.pushes[0]!;
  assert.equal(push.engine, 'codex');
  // Thread options, not SDK query options.
  assert.equal(push.options.model, 'gpt-5.6-terra');
  assert.equal(push.options.approvalPolicy, 'never');
  assert.equal(push.options.sandboxMode, 'workspace-write');
  assert.equal(push.options.codexPath, FAKE_CODEX);
  assert.match(String(push.options.codexHome), /codex$/);
  // The prompt is flattened: `codex exec` takes text, not content blocks.
  assert.deepEqual(push.message, { text: 'list the files' });
  assert.equal(h.claudeTokenReads(), 0);
});

test('plan mode maps to a read-only sandbox', async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness();
  h.sessions.setPermissionMode('s1', 'plan');

  h.sessions.prompt('s1', 'have a look');
  await settle();

  assert.equal(h.pushes[0]!.options.sandboxMode, 'read-only');
});

test('bypassPermissions does not reach danger-full-access', async () => {
  // Codex has no gate of its own in this cut, so full access would be genuinely
  // unrestricted — which is not what the user picked.
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness();
  h.sessions.setPermissionMode('s1', 'bypassPermissions');

  h.sessions.prompt('s1', 'go');
  await settle();

  assert.equal(h.pushes[0]!.options.sandboxMode, 'workspace-write');
});

test('no OpenAI account is refused with the Connect message, and no Claude authStatus', async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness({ openaiConnected: false });

  h.sessions.prompt('s1', 'hello');
  await settle();

  assert.deepEqual(h.pushes, []);
  assert.match(String(h.sessions.get('s1')?.errorMessage), /Connect one in Settings/);
  assert.equal(h.sessions.get('s1')?.status, 'error');
  // The one that would force-open the Claude login modal at a user who never
  // asked for a Claude account.
  assert.equal(
    h.broadcasts.some((m) => m.type === 'authStatus'),
    false,
  );
  assert.equal(h.claudeTokenReads(), 0);
});

test('a missing codex binary is refused with install instructions', async () => {
  process.env.LINES_CODEX_PATH = path.join(TMP, 'not-installed');
  const status = await refreshCodex();
  assert.equal(status.state, 'missing');
  const h = harness();

  h.sessions.prompt('s1', 'hello');
  await settle();

  assert.deepEqual(h.pushes, [], 'the SDK must not be asked to find a binary itself');
  assert.match(String(h.sessions.get('s1')?.errorMessage), /npm i -g @openai\/codex/);
});

test('a codex turn settles to done with its tokens accumulated', async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness();
  h.sessions.prompt('s1', 'hello');
  await settle();

  h.sessions.handleWorkerEvent('s1', notify('thread/started', { thread: { id: 'th_1' } }));
  h.sessions.handleWorkerEvent(
    's1',
    notify('item/completed', { item: { type: 'agentMessage', id: 'i1', text: 'done' } }),
  );
  // Usage arrives on its own notification, ahead of the turn settling.
  h.sessions.handleWorkerEvent(
    's1',
    notify('thread/tokenUsage/updated', {
      tokenUsage: {
        last: {
          totalTokens: 137,
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 30,
          reasoningOutputTokens: 7,
        },
      },
    }),
  );
  h.sessions.handleWorkerEvent(
    's1',
    notify('turn/completed', { turn: { id: 't1', status: 'completed' } }),
  );
  await settle();

  const settled = h.sessions.get('s1')!;
  assert.equal(settled.status, 'done');
  // The resume pointer, persisted the way claudeSessionId is.
  assert.equal(settled.codexThreadId, 'th_1');
  assert.equal(settled.lastTokens, 137);
  // Codex reports no USD cost; the row exists on tokens alone.
  assert.equal(settled.totalCostUsd, undefined);
});

test('a stopped codex turn settles as stopped, not as a failure', async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness();
  h.sessions.prompt('s1', 'hello');
  await settle();

  h.sessions.interrupt('s1');
  // An aborted `codex exec` produces no result of its own — the child just dies.
  h.sessions.handleWorkerEnded('s1');
  await settle();

  const settled = h.sessions.get('s1')!;
  assert.notEqual(settled.status, 'error');
  assert.equal(settled.errorMessage, undefined);
  // The synthetic result still reaches the transcript, stamped as stopped — so
  // the turn ends on a row that reads as "you stopped this", not as a failure
  // with a Retry button, and not on nothing at all.
  const events = h.store.loadTranscript('s1');
  const last = events.at(-1);
  assert.equal(last?.kind, 'sdk');
  assert.equal((last?.data as { type?: string }).type, 'result');
  assert.equal((last?.data as { stopped?: boolean }).stopped, true);
});

test('a failed turn carries its message into a failed turn', async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness();
  h.sessions.prompt('s1', 'hello');
  await settle();

  // Failure is a status on turn/completed, not a notification of its own.
  h.sessions.handleWorkerEvent(
    's1',
    notify('turn/completed', {
      turn: {
        id: 't1',
        status: 'failed',
        error: { message: 'insufficient_quota: you exceeded your current quota' },
      },
    }),
  );
  await settle();

  const settled = h.sessions.get('s1')!;
  assert.equal(settled.status, 'error');
  // Classified, so the banner names an action instead of echoing the API.
  assert.equal(settled.errorKind, 'quota');
});

test('a cross-provider setModel is refused once the session has run', async () => {
  const h = harness();
  // A switch before the first turn is free — that is what makes the picker useful.
  assert.deepEqual(h.sessions.setModel('s1', 'claude-opus-5'), { ok: true });

  const back = h.sessions.setModel('s1', 'gpt-5.6-terra');
  assert.deepEqual(back, { ok: true });
  h.sessions.get('s1')!.codexThreadId = 'th_1';

  const verdict = h.sessions.setModel('s1', 'claude-opus-5');
  assert.equal(verdict.ok, false);
  assert.match(
    verdict.ok === false ? verdict.reason : '',
    /cannot move between providers/,
  );
  // Refused means unchanged, not partially applied.
  assert.equal(h.sessions.get('s1')?.model, 'gpt-5.6-terra');
});
