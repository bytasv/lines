import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { assessToolCall, isSelfWorkerSource } from './autoGuard.ts';

// This test file sits beside autoGuard.ts, so its own dirname is the directory
// the rule anchors to — no need to reach into module internals for the paths.
const selfDir = import.meta.dirname;
const workerSource = path.join(selfDir, 'worker.ts');
const protocolSource = path.join(selfDir, 'workerProtocol.ts');
const mcpSource = path.join(selfDir, 'workerMcp.ts');

/** Roots wide enough that nothing here escalates for being outside the project. */
const roots = [path.resolve(selfDir, '..', '..'), '/tmp'];

test('writing this bridge\'s own worker sources is dangerous', () => {
  for (const file of [workerSource, protocolSource, mcpSource]) {
    assert.equal(assessToolCall('Edit', { file_path: file }, roots, []).dangerous, true, file);
    assert.equal(assessToolCall('Write', { file_path: file }, roots, []).dangerous, true, file);
  }
});

test('isSelfWorkerSource resolves before matching', () => {
  assert.equal(isSelfWorkerSource(path.join(selfDir, 'sessions', '..', 'worker.ts')), true);
  assert.equal(isSelfWorkerSource(path.join(selfDir, 'sessions.ts')), false);
});

test('a same-named worker.ts elsewhere is untouched', () => {
  // A second checkout of Lines, or any unrelated project: those files don't
  // back the running worker, so editing them can't kill the turn.
  const other = '/tmp/other-checkout/server/src/worker.ts';
  assert.equal(isSelfWorkerSource(other), false);
  assert.equal(assessToolCall('Edit', { file_path: other }, roots, []).dangerous, false);
});

test('reading a worker source is not dangerous', () => {
  assert.equal(assessToolCall('Read', { file_path: protocolSource }, roots, []).dangerous, false);
});

test('a blanket allowlist entry cannot disarm the rule', () => {
  const allowlist = [{ tool: 'Edit' }, { tool: 'Write' }];
  assert.equal(assessToolCall('Edit', { file_path: protocolSource }, roots, allowlist).dangerous, true);
  assert.equal(assessToolCall('Write', { file_path: workerSource }, roots, allowlist).dangerous, true);
  // The same entry still works for any other file, so the rule is narrow.
  assert.equal(
    assessToolCall('Edit', { file_path: path.join(selfDir, 'sessions.ts') }, roots, allowlist).dangerous,
    false,
  );
});
