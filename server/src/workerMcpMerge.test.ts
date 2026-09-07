import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeMcpServers } from './workerProtocol.ts';
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
