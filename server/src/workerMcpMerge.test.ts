import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeMcpServers, staleDynamicServers } from './workerProtocol.ts';
import { LINES_MCP_SERVER } from './mcpWorkflowTools.ts';

/**
 * `ensureSession` used to *overwrite* `options.mcpServers` with the Lines
 * server, so a user connection could never reach a session at all. These pin
 * both halves of the fix: the neighbours survive, and Lines still wins.
 *
 * The merge itself lives in workerProtocol.ts precisely so it can be asserted
 * without starting a worker process.
 */

const LINES = { instance: 'lines-server' };

test('user connections survive the Lines server being spliced in', () => {
  const merged = mergeMcpServers(
    { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
    LINES_MCP_SERVER,
    LINES,
  );
  assert.deepEqual(Object.keys(merged).sort(), ['figma', LINES_MCP_SERVER].sort());
  assert.deepEqual(merged.figma, { type: 'http', url: 'https://mcp.figma.com/mcp' });
  assert.equal(merged[LINES_MCP_SERVER], LINES);
});

test('the Lines server wins a name collision', () => {
  // The failure this ordering exists to prevent: a connection named `lines`
  // silently replacing the workflow tools, with no error anywhere.
  const merged = mergeMcpServers(
    { [LINES_MCP_SERVER]: { type: 'http', url: 'https://evil.example/mcp' } },
    LINES_MCP_SERVER,
    LINES,
  );
  assert.equal(merged[LINES_MCP_SERVER], LINES);
  assert.equal(Object.keys(merged).length, 1);
});

test('absent or malformed options still yield just the Lines server', () => {
  for (const input of [undefined, null, [], 'nonsense', 42]) {
    assert.deepEqual(
      mergeMcpServers(input, LINES_MCP_SERVER, LINES),
      { [LINES_MCP_SERVER]: LINES },
      JSON.stringify(input ?? null),
    );
  }
});

/**
 * `setMcpServers` is a replace, but only for the servers it can replace. Measured
 * against the installed SDK: omitting the in-process Lines server returned
 * `removed: ['lines']` and destroyed it, while omitting a process-based http
 * server left it running on its old config. So a live query needs both halves —
 * the merge above to keep Lines alive, and this sweep to actually turn off a
 * connection the user disabled or deleted.
 */

const dynamic = (name: string, status = 'connected') => ({ name, status, scope: 'dynamic' });

test('a dynamic server missing from the payload is named for switching off', () => {
  const stale = staleDynamicServers([dynamic('figma'), dynamic('linear')], {
    figma: { type: 'http', url: 'https://mcp.figma.com/mcp' },
  });
  assert.deepEqual(stale, ['linear']);
});

test('servers Lines did not add are never touched, whatever their scope says', () => {
  // A settings-file server and a claude.ai proxy entry are the user's own. Lines
  // disabling one would silently remove a tool surface it never provided.
  const stale = staleDynamicServers(
    [
      { name: 'from-settings', status: 'connected', scope: 'user' },
      { name: 'claude.ai Figma', status: 'connected', scope: 'claudeai' },
      { name: 'from-project', status: 'connected', scope: 'project' },
    ],
    {},
  );
  assert.deepEqual(stale, []);
});

test('the Lines server is never swept, because the merge always re-includes it', () => {
  const payload = mergeMcpServers({}, LINES_MCP_SERVER, LINES);
  const stale = staleDynamicServers([dynamic(LINES_MCP_SERVER), dynamic('figma')], payload);
  assert.deepEqual(stale, ['figma']);
});

test('an already-disabled server is not toggled again, so a repeat call is a no-op', () => {
  assert.deepEqual(staleDynamicServers([dynamic('figma', 'disabled')], {}), []);
});

test('a needs-auth server still counts as live and gets switched off', () => {
  // The status a just-removed Figma connection is most likely sitting in.
  assert.deepEqual(staleDynamicServers([dynamic('figma', 'needs-auth')], {}), ['figma']);
});

test('a malformed status read yields no toggles rather than throwing', () => {
  for (const bad of [null, undefined, {}, 'nope', [null], [{}], [{ scope: 'dynamic' }]]) {
    assert.deepEqual(staleDynamicServers(bad, {}), [], JSON.stringify(bad ?? null));
  }
});
