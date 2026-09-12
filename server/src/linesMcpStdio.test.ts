import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { linesMcpServerConfig } from './linesMcpStdio.ts';

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
    args.some((a) => a.endsWith('linesMcpStdio.ts') || a.endsWith('linesMcpStdio.js')),
    'the server module is the script being run',
  );
  assert.ok(path.isAbsolute(args.find((a) => a.includes('linesMcpStdio'))!), 'absolute path');
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
