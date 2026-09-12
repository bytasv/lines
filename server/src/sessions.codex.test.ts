import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CODEX_NOTIFICATION } from '@lines/shared';
import type { ServerMessage, SessionMeta } from '@lines/shared';
import type { AuthManager } from './auth.ts';
import { GuardAllowlist } from './autoGuard.ts';
import { McpConnections } from './mcpConnections.ts';
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
  /** Seed the user's MCP connection list, to assert what rides a codex push. */
  connections?: unknown[];
}

function harness(opts: HarnessOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-codex-store-'));
  fs.writeFileSync(
    path.join(root, 'sessions.json'),
    JSON.stringify([meta('s1', opts.model ?? 'gpt-5.6-terra')]),
  );
  if (opts.connections?.length) {
    fs.writeFileSync(path.join(root, 'mcp-connections.json'), JSON.stringify(opts.connections));
  }
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
    new McpConnections(store),
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
    // canInterject reads this rather than `status.connected`: a send made while
    // the socket is down would be replayed into a *fresh* turn.
    linkOpen: true,
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
  // Codex escalates rather than asking about everything, and in 'default' the
  // sandbox is read-only — so a write is what raises a card, and an observation
  // is not. Same set of things Claude prompts about.
  assert.equal(push.options.approvalPolicy, 'on-request');
  assert.equal(push.options.sandboxMode, 'read-only');
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

test('bypassPermissions reaches danger-full-access, now that Lines is the gate', async () => {
  // Safe only because every codex tool call is routed back through the bridge's
  // permission path: the sandbox is a second line, not the only one. While codex
  // answered its own approvals this mapping was deliberately withheld.
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness();
  h.sessions.setPermissionMode('s1', 'bypassPermissions');

  h.sessions.prompt('s1', 'go');
  await settle();

  assert.equal(h.pushes[0]!.options.sandboxMode, 'danger-full-access');
  // Bypass means the bridge's own handlers decide without codex asking first —
  // the always-ask tools still stop there.
  assert.equal(h.pushes[0]!.options.approvalPolicy, 'never');
});

test('every gated mode has codex escalate rather than ask about everything', async () => {
  // `untrusted` used to be set here on the theory that the auto-guard would
  // silently approve the safe calls. It cannot: `isSafeReadOnly` gates on
  // Read/Glob/Grep and every codex command arrives as `Bash`, so the result was a
  // permission card for every `cat`. What reaches the card now is what the
  // sandbox refuses.
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  for (const mode of ['default', 'auto', 'acceptEdits', 'plan'] as const) {
    const h = harness();
    h.sessions.setPermissionMode('s1', mode);
    h.sessions.prompt('s1', 'go');
    await settle();
    assert.equal(h.pushes[0]!.options.approvalPolicy, 'on-request', mode);
  }
});

test('only acceptEdits hands codex the workspace up front', async () => {
  // The sandbox is what makes an edit ask in 'default': codex has to escalate to
  // write, and that escalation is the permission card. Granting workspace-write
  // in 'default' would let it edit files without one.
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const sandboxFor = async (mode: 'default' | 'auto' | 'acceptEdits' | 'plan') => {
    const h = harness();
    h.sessions.setPermissionMode('s1', mode);
    h.sessions.prompt('s1', 'go');
    await settle();
    return h.pushes[0]!.options.sandboxMode;
  };
  assert.equal(await sandboxFor('default'), 'read-only');
  assert.equal(await sandboxFor('auto'), 'read-only');
  assert.equal(await sandboxFor('plan'), 'read-only');
  assert.equal(await sandboxFor('acceptEdits'), 'workspace-write');
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

test('an interjection steers the live turn instead of starting a new one', async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness();
  h.sessions.prompt('s1', 'count to twenty');
  await settle();

  // Queue a prompt, then Send now. `queryTokens` is the Claude token map and is
  // never filled for codex — canInterject has to let that pass, or Send now is
  // refused on every codex session.
  const meta = h.sessions.get('s1')!;
  meta.queued = [{ id: 'q1', text: 'stop counting', at: Date.now() } as never];
  const verdict = h.sessions.interjectQueued('s1', 'q1', { needsApproval: false });
  assert.equal(verdict.ok, true, `refused: ${verdict.ok === false ? verdict.reason : ''}`);
  await settle();

  assert.equal(h.pushes.length, 2);
  // The second push joins the running turn rather than opening one.
  assert.deepEqual(h.pushes[1]!.message, { text: 'stop counting', steer: true });
  assert.equal(h.pushes[1]!.engine, 'codex');
  // And the turn it joined is still the live one — an interjection settles nothing.
  assert.equal(h.sessions.get('s1')?.status, 'running');
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

test("the user's MCP connections ride a codex push, in codex's own shape", async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness({
    connections: [
      { id: 'c1', name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 's'], enabled: true },
    ],
  });

  h.sessions.prompt('s1', 'list the files');
  await settle();

  const push = h.pushes[0]!;
  const servers = push.options.mcpServers as Record<string, unknown>;
  // codex's `config.toml` shape, not the SDK's: no `type` discriminator.
  assert.deepEqual(servers.local, { command: 'npx', args: ['-y', 's'] });
});

test('a codex push with no connections still carries only the lines server', async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness();

  h.sessions.prompt('s1', 'list the files');
  await settle();

  const push = h.pushes[0]!;
  // Lines' own tools are always offered, so the table is never empty — but a user
  // with no connections must not pay for an env payload that has nothing in it.
  assert.deepEqual(Object.keys(push.options.mcpServers as object), ['lines']);
  assert.ok(!('mcpEnv' in push.options));
});

test("Lines' own tools are served to a codex session as a real stdio server", async () => {
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness();

  h.sessions.prompt('s1', 'list the files');
  await settle();

  const servers = h.pushes[0]!.options.mcpServers as Record<string, Record<string, unknown>>;
  // Codex spawns MCP servers as child processes, so the in-process server the
  // Claude SDK hosts has no equivalent — the tools arrive as a spawned proxy.
  assert.ok(servers.lines, 'the lines server is in the codex table');
  assert.equal(servers.lines.command, process.execPath);
});

test('a user connection cannot take over the lines namespace on a codex push', async () => {
  // The same invariant `mergeMcpServers` exists to hold on the Claude side: a
  // connection named `lines` would otherwise shadow every `mcp__lines__*` tool
  // with no error anywhere. Bridge validation refuses the name, but the merge
  // order is the backstop.
  process.env.LINES_CODEX_PATH = FAKE_CODEX;
  await refreshCodex();
  const h = harness({
    connections: [
      { id: 'c1', name: 'lines', transport: 'stdio', command: 'imposter', enabled: true },
    ],
  });

  h.sessions.prompt('s1', 'go');
  await settle();

  const servers = h.pushes[0]!.options.mcpServers as Record<string, Record<string, unknown>>;
  assert.notEqual(servers.lines.command, 'imposter');
  assert.equal(servers.lines.command, process.execPath);
});
