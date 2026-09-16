import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  codexCandidatePaths,
  codexCliRefusalMessage,
  codexCliStatus,
  findCodexCli,
  MIN_CODEX_VERSION,
  readCodexVersion,
  refreshCodexCli,
  resolveCodexCliStatus,
  type CodexDiscoveryDeps,
} from './codexCli.ts';

const HOME = '/Users/tester';
/** Nothing on PATH unless a case says so, so the order assertions stay stable. */
const base: CodexDiscoveryDeps = { env: {}, home: HOME, onPath: () => null };

test('the env override replaces every installed location', () => {
  // Exclusive, not merely first — the same rule LINES_CLAUDE_PATH follows: a
  // wrong pin must fail loudly rather than quietly running some other binary.
  assert.deepEqual(codexCandidatePaths({ ...base, env: { LINES_CODEX_PATH: '/pinned/codex' } }), [
    '/pinned/codex',
  ]);
  assert.deepEqual(
    resolveCodexCliStatus({ ...base, env: { LINES_CODEX_PATH: '/pinned/codex' } }),
    { state: 'missing', minVersion: MIN_CODEX_VERSION },
  );
});

test('the local-bin install is preferred over PATH and Homebrew', () => {
  const paths = codexCandidatePaths({ ...base, onPath: () => '/some/shim/codex' });
  assert.deepEqual(paths.slice(0, 4), [
    path.join(HOME, '.local', 'bin', 'codex'),
    '/some/shim/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]);
});

test('discovery skips candidates that are not executable', () => {
  const found = findCodexCli({
    ...base,
    isExecutable: (p) => p === '/usr/local/bin/codex',
    readVersion: () => '9.9.9',
  });
  assert.deepEqual(found, { path: '/usr/local/bin/codex', version: '9.9.9' });
});

test('no binary anywhere is "missing", never a throw', () => {
  const status = resolveCodexCliStatus({ ...base, isExecutable: () => false });
  assert.deepEqual(status, { state: 'missing', minVersion: MIN_CODEX_VERSION });
  // The refusal names the fix, not the fault — it is shown to someone who has
  // never heard of a PATH.
  assert.match(codexCliRefusalMessage(status)!, /npm i -g @openai\/codex/);
});

test('a binary below the floor is "outdated", and says how to fix it', () => {
  const status = resolveCodexCliStatus({
    ...base,
    isExecutable: () => true,
    readVersion: () => '0.1.0',
  });
  assert.equal(status.state, 'outdated');
  assert.equal(status.version, '0.1.0');
  assert.match(codexCliRefusalMessage(status)!, /older than the .* Lines/);
});

test('a binary that reports no parsable version is allowed to run', () => {
  // Refusing it would break anyone whose wrapper script prints nothing, and the
  // version is only ever used for the floor check.
  const status = resolveCodexCliStatus({
    ...base,
    isExecutable: () => true,
    readVersion: () => null,
  });
  assert.equal(status.state, 'ok');
  assert.equal(status.version, undefined);
  assert.equal(codexCliRefusalMessage(status), null);
});

test('--version output is parsed down to x.y.z', () => {
  // A real executable, because readCodexVersion's whole job is spawning one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-codex-cli-'));
  const binary = path.join(dir, 'codex');
  fs.writeFileSync(binary, '#!/bin/sh\necho "codex-cli 0.62.1"\n', { mode: 0o755 });
  try {
    assert.equal(readCodexVersion(binary), '0.62.1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing CLI is re-probed, so installing one lands without a restart', (t) => {
  // The bug this closes: the verdict was cached for the life of the bridge, so
  // the obvious response to "not installed" — installing it — changed nothing.
  // Every turn kept refusing and the UI kept saying it was missing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-codex-cache-'));
  const binary = path.join(dir, 'codex');
  const previous = process.env.LINES_CODEX_PATH;
  process.env.LINES_CODEX_PATH = binary;
  // Date only: a fake setTimeout would hang the probe's own execFileSync timeout.
  t.mock.timers.enable({ apis: ['Date'] });
  try {
    assert.equal(refreshCodexCli().state, 'missing');

    fs.writeFileSync(binary, '#!/bin/sh\necho "codex-cli 99.0.0"\n', { mode: 0o755 });
    assert.equal(codexCliStatus().state, 'missing', 'inside the window, no probe per call');

    t.mock.timers.tick(10_001);
    assert.equal(codexCliStatus().state, 'ok', 'past the window, the machine is asked again');

    // And a working answer stays cached — that is the path every turn push is on.
    fs.rmSync(binary);
    t.mock.timers.tick(60_000);
    assert.equal(codexCliStatus().state, 'ok');
  } finally {
    t.mock.timers.reset();
    if (previous === undefined) delete process.env.LINES_CODEX_PATH;
    else process.env.LINES_CODEX_PATH = previous;
    refreshCodexCli();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
