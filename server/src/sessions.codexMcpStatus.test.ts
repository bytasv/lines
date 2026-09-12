import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCodexMcpStatuses } from './sessions.ts';

/**
 * Codex's MCP server statuses, as the status dot in Settings → Connections.
 *
 * The two enums line up but do not match, and every mismatch here is a wrong
 * colour on a row the user is trying to debug — so each one is pinned.
 */

const row = (over: Record<string, unknown> = {}) => ({
  name: 'figma',
  runtimeStatus: 'connected',
  toolsError: null,
  tools: {},
  ...over,
});

test('connected maps straight through', () => {
  assert.deepEqual(normalizeCodexMcpStatuses([row()]), [{ name: 'figma', status: 'connected' }]);
});

test("codex's two pre-connection states both read as pending", () => {
  // Lines has one "not yet" state; codex distinguishes never-started from
  // starting. Neither is an error and neither should show as one.
  for (const runtimeStatus of ['notStarted', 'starting']) {
    assert.equal(normalizeCodexMcpStatuses([row({ runtimeStatus })])[0]!.status, 'pending');
  }
});

test('a null runtimeStatus with a clean catalog is connected, not pending', () => {
  // Measured: a server that started fine and listed 13 tools still reports
  // runtimeStatus null whenever no thread is running — which is the normal case
  // when Settings asks. Reading that as "pending" left every working connection
  // spinning forever.
  const out = normalizeCodexMcpStatuses([
    row({ runtimeStatus: null, toolsError: null, tools: { a: {}, b: {} } }),
  ]);
  assert.equal(out[0]!.status, 'connected');
});

test('a null runtimeStatus with a tools error is still failed', () => {
  const out = normalizeCodexMcpStatuses([
    row({ runtimeStatus: null, toolsError: 'MCP startup failed' }),
  ]);
  assert.equal(out[0]!.status, 'failed');
});

test('authenticationRequired is the needs-auth case under another name', () => {
  assert.equal(
    normalizeCodexMcpStatuses([row({ runtimeStatus: 'authenticationRequired' })])[0]!.status,
    'needs-auth',
  );
});

test('cancelled reads as failed, having no Lines equivalent', () => {
  // Closest true thing: a server that is not going to answer.
  assert.equal(normalizeCodexMcpStatuses([row({ runtimeStatus: 'cancelled' })])[0]!.status, 'failed');
});

test('a connected server whose tools failed to load is reported as failed', () => {
  // From the user's side a connection offering no tools has not worked, whatever
  // the transport thinks — and toolsError is the sentence that explains it.
  const out = normalizeCodexMcpStatuses([
    row({ runtimeStatus: 'connected', toolsError: 'handshaking with MCP server failed' }),
  ]);
  assert.equal(out[0]!.status, 'failed');
  assert.equal(out[0]!.error, 'handshaking with MCP server failed');
});

test('tool names are lifted out of the keyed map codex reports them in', () => {
  const out = normalizeCodexMcpStatuses([row({ tools: { get_file: {}, list_files: {} } })]);
  assert.deepEqual(out[0]!.tools, ['get_file', 'list_files']);
});

test('a row with no name is dropped rather than rendered nameless', () => {
  assert.deepEqual(normalizeCodexMcpStatuses([row({ name: '' }), 'nonsense', null]), []);
});

test('a non-array answer is empty, not a throw', () => {
  // This value crosses the worker socket, so it is untrusted by construction.
  assert.deepEqual(normalizeCodexMcpStatuses(null), []);
  assert.deepEqual(normalizeCodexMcpStatuses({ data: [] }), []);
});
