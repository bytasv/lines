import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage, SessionMeta, SessionStatus } from '@lines/shared';
import { GuardAllowlist } from './autoGuard.ts';
import { McpConnections } from './mcpConnections.ts';
import { SessionManager } from './sessions.ts';
import { createStore } from './store.ts';

/**
 * The two halves of "a connection the user just added can actually be used".
 *
 * `ensureSession` freezes `mcpServers` into a query when it is created, so
 * without `applyMcpServers` a new connection exists for no running session —
 * reports no status, and can never be authorized. And without `warmQuery` a
 * session that has never run a turn has no query to authorize *through*, which
 * left the Authorize button reachable only by accident.
 */

const meta = (id: string, status: SessionStatus = 'done'): SessionMeta =>
  ({
    id,
    name: id,
    cwd: '/tmp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    status,
    createdAt: 1,
  }) as SessionMeta;

/** Whatever the stubbed worker should do for one ask, keyed by method. */
type Answers = {
  mcpSetServers?: (sessionId: string, servers: Record<string, unknown>) => unknown;
  mcpWarm?: (sessionId: string) => unknown;
  mcpStatus?: (sessionId: string) => unknown;
  mcpAuthStart?: (sessionId: string) => unknown;
};

function harness(metas: SessionMeta[], answers: Answers = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-mcplive-'));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(metas));
  const store = createStore(root);
  const broadcasts: ServerMessage[] = [];
  const mcp = new McpConnections(store);
  const sessions = new SessionManager(
    store,
    new GuardAllowlist(store),
    (msg) => broadcasts.push(msg),
    undefined,
    mcp,
  );
  // Every call the stub saw, so a test can assert on what was *not* called too.
  const calls: string[] = [];
  const answer = <K extends keyof Answers>(method: K, fallback: unknown) =>
    (async (sessionId: string, ...rest: unknown[]) => {
      calls.push(`${method}:${sessionId}`);
      const fn = answers[method] as ((...a: unknown[]) => unknown) | undefined;
      if (!fn) return fallback;
      const out = fn(sessionId, ...(rest as [never]));
      if (out instanceof Error) throw out;
      return out;
    });
  sessions.attachWorker({
    push: () => {},
    close: () => {},
    mcpSetServers: answer('mcpSetServers', { result: { errors: {} }, servers: [] }),
    mcpWarm: answer('mcpWarm', []),
    mcpStatus: answer('mcpStatus', []),
    mcpAuthStart: answer('mcpAuthStart', {}),
  } as never);
  return { sessions, mcp, broadcasts, calls };
}

const statuses = (...names: string[]) => names.map((name) => ({ name, status: 'needs-auth' }));

test('applyMcpServers pushes the connection list at every session and broadcasts status', async () => {
  const h = harness([meta('s1'), meta('s2')], {
    mcpSetServers: (sessionId) => ({
      result: { added: ['figma'], removed: [], errors: {} },
      servers: statuses('figma', sessionId),
    }),
  });
  const added = h.mcp.add({ name: 'figma', transport: 'http', url: 'https://mcp.figma.com/mcp', enabled: true });
  assert.ok(!('error' in added));

  await h.sessions.applyMcpServers();

  assert.deepEqual(h.calls.sort(), ['mcpSetServers:s1', 'mcpSetServers:s2']);
  // One account-wide message keyed by session, not two session-scoped ones: see
  // the `mcpStatuses` comment in shared/types.ts for why the shape matters.
  const status = h.broadcasts.filter((m) => m.type === 'mcpStatuses');
  assert.equal(status.length, 1);
  assert.deepEqual(
    Object.keys((status[0] as { statuses: Record<string, unknown> }).statuses).sort(),
    ['s1', 's2'],
  );
});

test('applyMcpServers sends the config with its header values, not the synced form', async () => {
  let sent: Record<string, unknown> | undefined;
  const h = harness([meta('s1')], {
    mcpSetServers: (_id, servers) => {
      sent = servers;
      return { result: { errors: {} }, servers: [] };
    },
  });
  const added = h.mcp.add(
    { name: 'figma', transport: 'http', url: 'https://mcp.figma.com/mcp', headerKeys: ['Authorization'], enabled: true },
    { Authorization: 'Bearer secret' },
  );
  assert.ok(!('error' in added));

  await h.sessions.applyMcpServers();

  // serverConfigs() is the one shape carrying credential values — the whole
  // point of pushing this rather than the blob the browser sees.
  assert.deepEqual(sent?.figma, {
    type: 'http',
    url: 'https://mcp.figma.com/mcp',
    headers: { Authorization: 'Bearer secret' },
  });
});

test('a session with no live query is a no-op, and does not stop the others', async () => {
  const h = harness([meta('s1'), meta('s2')], {
    mcpSetServers: (sessionId) =>
      sessionId === 's1'
        ? new Error('no-live-session')
        : { result: { errors: {} }, servers: statuses('figma') },
  });
  await h.sessions.applyMcpServers();
  const status = h.broadcasts.filter((m) => m.type === 'mcpStatuses');
  assert.equal(status.length, 1);
  assert.deepEqual(Object.keys((status[0] as { statuses: Record<string, unknown> }).statuses), ['s2']);
});

test('applyMcpServers never warms — a Settings edit must not spawn a CLI child', async () => {
  const h = harness([meta('s1')], { mcpSetServers: () => new Error('no-live-session') });
  await h.sessions.applyMcpServers();
  assert.deepEqual(h.calls, ['mcpSetServers:s1']);
});

test('a status read only warms when asked to', async () => {
  const h = harness([meta('s1')], { mcpStatus: () => statuses('figma') });
  await h.sessions.mcpServerStatus('s1');
  assert.deepEqual(h.calls, ['mcpStatus:s1']);

  const warmed = harness([meta('s1')], { mcpWarm: () => statuses('figma') });
  assert.deepEqual(await warmed.sessions.mcpServerStatus('s1', { warm: true }), statuses('figma'));
  assert.deepEqual(warmed.calls, ['mcpWarm:s1']);
});

test('startMcpAuth warms a session with no query, then completes on the retry', async () => {
  // The case the feature exists for: the user added a connection and has not run
  // a turn, so leg 1 has no query to run against until one is brought up.
  let attempts = 0;
  const h = harness([meta('s1')], {
    mcpWarm: () => statuses('figma'),
    mcpAuthStart: () =>
      ++attempts === 1
        ? new Error('no-live-session')
        : { authUrl: 'https://www.figma.com/oauth/mcp?state=abc', state: 'abc', callbackExpected: true },
  });

  const started = await h.sessions.startMcpAuth('s1', 'figma', 'http://127.0.0.1:8787/mcp-oauth/callback');

  assert.deepEqual(started, { authUrl: 'https://www.figma.com/oauth/mcp?state=abc', state: 'abc' });
  assert.deepEqual(h.calls, ['mcpAuthStart:s1', 'mcpWarm:s1', 'mcpAuthStart:s1']);
});

test('a worker too old to warm falls back to the pre-warm copy, not a broken-feature error', async () => {
  // An older worker has no `mcpWarm` case, so it answers for a session it holds
  // no query for — which is exactly the situation the old copy described.
  const h = harness([meta('s1')], {
    mcpWarm: () => new Error('no-live-session'),
    mcpAuthStart: () => new Error('no-live-session'),
  });
  assert.deepEqual(await h.sessions.startMcpAuth('s1', 'figma', 'http://127.0.0.1:8787/mcp-oauth/callback'), {
    error: 'Start a turn in this session first — authorizing needs a running query.',
  });
});

test('an already-authorized server is a success, not a missing-URL failure', async () => {
  const h = harness([meta('s1')], { mcpAuthStart: () => ({ callbackExpected: false }) });
  assert.deepEqual(await h.sessions.startMcpAuth('s1', 'figma', 'http://127.0.0.1:8787/mcp-oauth/callback'), {
    alreadyAuthorized: true,
  });
});

test('a dead worker is reported as such rather than retried through a warm', async () => {
  const h = harness([meta('s1')], { mcpAuthStart: () => new Error('worker-unavailable') });
  assert.deepEqual(await h.sessions.startMcpAuth('s1', 'figma', 'http://127.0.0.1:8787/mcp-oauth/callback'), {
    error: 'The Lines worker is not reachable right now.',
  });
  assert.deepEqual(h.calls, ['mcpAuthStart:s1']);
});

test('nothing is broadcast when no session had a live query to update', async () => {
  const h = harness([meta('s1')], { mcpSetServers: () => new Error('no-live-session') });
  await h.sessions.applyMcpServers();
  assert.deepEqual(h.broadcasts.filter((m) => m.type === 'mcpStatuses'), []);
});
