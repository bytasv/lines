import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { linesMcpServerConfig } from './linesMcpStdio.ts';

const THIS_FILE = fileURLToPath(new URL('./linesMcpStdio.ts', import.meta.url));

/**
 * The spawn recipe codex is given for Lines' own tools.
 *
 * Asserted here rather than left to the live probe because a wrong entry fails
 * the way a missing feature does — codex reports a server that would not start,
 * and the session simply has no `mcp__lines__*` tools, with nothing saying why.
 */

test('the config runs this module through the node that is running the bridge', () => {
  const config = linesMcpServerConfig('u1');
  // Not the string "node": the desktop build's node is the Electron binary, and a
  // bare `node` may not be on the PATH codex inherits at all.
  assert.equal(config.command, process.execPath);
  const args = config.args as string[];
  assert.ok(
    args.some((a) => a.endsWith('linesMcpStdio.ts') || a.endsWith('linesMcpStdio.mjs')),
    'the server module is the script being run',
  );
  assert.ok(path.isAbsolute(args.find((a) => a.includes('linesMcpStdio'))!), 'absolute path');
});

test('the config never points at the bridge or worker bundle', () => {
  // The bundler folds this file into bridge.mjs as a dependency; if the spawn
  // recipe ever again derived its script from import.meta.url unconditionally,
  // codex would be told to spawn the bridge's own entrypoint a second time.
  const config = linesMcpServerConfig('u1');
  const args = config.args as string[];
  const script = args.find((a) => a.includes('linesMcpStdio'))!;
  assert.ok(!script.endsWith('bridge.mjs') && !script.endsWith('worker.mjs'));
});

test('the config always carries the sentinel that gates self-run', () => {
  // Path identity (argv[1] === this file) used to be the guard, and broke the
  // moment a bundler folded this file into bridge.mjs — import.meta.url then
  // equalled the bridge's own argv[1]. The sentinel is what the guard reads now.
  const config = linesMcpServerConfig('u1');
  assert.ok((config.args as string[]).includes('--lines-mcp-stdio'));
});

test('the config names the user and the run file, rather than letting the child guess', () => {
  const config = linesMcpServerConfig('u1');
  const args = config.args as string[];
  assert.equal(args[args.indexOf('--user') + 1], 'u1');
  const runFile = args[args.indexOf('--run-file') + 1];
  assert.ok(path.isAbsolute(runFile), 'run file is absolute');
  assert.ok(runFile.endsWith('bridge.json'), 'points at the bridge run file');
});

test('under tsx the script is loaded through it, since node cannot run a .ts file alone', () => {
  const config = linesMcpServerConfig('u1');
  const args = config.args as string[];
  const script = args.find((a) => a.includes('linesMcpStdio'))!;
  if (script.endsWith('.ts')) {
    assert.deepEqual(args.slice(0, 2), ['--import', 'tsx']);
  } else {
    assert.equal(args[0], script, 'a built .js file is run directly');
  }
});

test('the child is told to run Electron as plain node', () => {
  // Harmless under tsx and Tilt; load-bearing in the packaged app, where
  // process.execPath is Electron and would otherwise boot a browser window.
  const config = linesMcpServerConfig('u1');
  assert.deepEqual(config.env, { ELECTRON_RUN_AS_NODE: '1' });
});

/**
 * The actual crash loop: this file executed directly (argv[1] === its own
 * path, the exact condition a bundler recreates by folding it into bridge.mjs)
 * must not, by itself, start an MCP server on stdio. Only the sentinel flag may.
 */
test('running this file directly, without the sentinel, does not self-run', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', THIS_FILE], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.doesNotMatch(result.stderr, /\[lines-mcp\]/);
});

test('running this file directly, with the sentinel, does self-run', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      THIS_FILE,
      '--lines-mcp-stdio',
      '--run-file',
      '/nonexistent/lines-mcp-stdio-test/bridge.json',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  // Fails fast on the missing run file rather than hanging on a network call —
  // proof it reached main(), not proof of a healthy server.
  assert.match(result.stderr, /\[lines-mcp\] failed to start/);
});
