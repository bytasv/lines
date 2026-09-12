import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  candidatePaths,
  claudeCliRefusalMessage,
  compareVersions,
  findClaudeCli,
  MIN_CLAUDE_VERSION,
  publicClaudeCliStatus,
  readVersion,
  resolveClaudeCliStatus,
  type DiscoveryDeps,
} from './claudeCli.ts';

const HOME = '/Users/tester';
/** Nothing on PATH unless a case says so, so the order assertions stay stable. */
const base: DiscoveryDeps = { env: {}, home: HOME, onPath: () => null };

test('the env override replaces every installed location', () => {
  // Exclusive, not merely first: a wrong pin must fail loudly rather than
  // quietly running some other binary.
  const paths = candidatePaths({ ...base, env: { LINES_CLAUDE_PATH: '/pinned/claude' } });
  assert.deepEqual(paths, ['/pinned/claude']);
  assert.deepEqual(
    resolveClaudeCliStatus({ ...base, env: { LINES_CLAUDE_PATH: '/pinned/claude' } }),
    { state: 'missing', minVersion: MIN_CLAUDE_VERSION },
  );
});

test('the native installer symlink is preferred over PATH and Homebrew', () => {
  const paths = candidatePaths({ ...base, onPath: () => '/some/shim/claude' });
  assert.deepEqual(paths.slice(0, 4), [
    path.join(HOME, '.local', 'bin', 'claude'),
    '/some/shim/claude',
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]);
});

test('discovery skips candidates that are not executable', () => {
  const found = findClaudeCli({
    ...base,
    isExecutable: (p) => p === '/usr/local/bin/claude',
    readVersion: () => '2.1.224',
  });
  assert.deepEqual(found, { path: '/usr/local/bin/claude', version: '2.1.224' });
});

test('no binary anywhere is "missing", never a throw', () => {
  const status = resolveClaudeCliStatus({ ...base, isExecutable: () => false });
  assert.deepEqual(status, { state: 'missing', minVersion: MIN_CLAUDE_VERSION });
  assert.match(claudeCliRefusalMessage(status)!, /install it from https:\/\/docs\.claude\.com/);
});

test('--version output is parsed down to x.y.z', () => {
  // A real executable, because readVersion's whole job is spawning one: the
  // shipped app's version gate is worthless if the exec half is only mocked.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-cli-'));
  const good = path.join(dir, 'claude');
  fs.writeFileSync(good, '#!/bin/sh\necho "2.1.224 (Claude Code)"\n', { mode: 0o755 });
  assert.equal(readVersion(good), '2.1.224');

  const silent = path.join(dir, 'silent');
  fs.writeFileSync(silent, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(readVersion(silent), null);

  const broken = path.join(dir, 'broken');
  fs.writeFileSync(broken, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  assert.equal(readVersion(broken), null, 'a non-zero exit must not throw');

  assert.equal(readVersion(path.join(dir, 'absent')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an executable probe accepts a real file and rejects a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-cli-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\necho "2.1.224 (Claude Code)"\n', { mode: 0o755 });
  const found = findClaudeCli({ env: { LINES_CLAUDE_PATH: bin }, home: dir, onPath: () => null });
  assert.deepEqual(found, { path: bin, version: '2.1.224' });
  // A directory on the candidate list must be skipped, not spawned.
  assert.equal(findClaudeCli({ env: { LINES_CLAUDE_PATH: dir }, home: '/nope', onPath: () => null }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compareVersions orders around the floor', () => {
  assert.ok(compareVersions('2.1.210', MIN_CLAUDE_VERSION) < 0);
  assert.equal(compareVersions(MIN_CLAUDE_VERSION, MIN_CLAUDE_VERSION), 0);
  assert.ok(compareVersions('2.1.224', MIN_CLAUDE_VERSION) > 0);
  // Not a string compare: 2.1.9 must not read as newer than 2.1.211.
  assert.ok(compareVersions('2.1.9', MIN_CLAUDE_VERSION) < 0);
  assert.ok(compareVersions('3.0.0', MIN_CLAUDE_VERSION) > 0);
});

test('a CLI below the floor is "outdated" and says how to fix it', () => {
  const status = resolveClaudeCliStatus({
    ...base,
    isExecutable: () => true,
    readVersion: () => '2.0.1',
  });
  assert.equal(status.state, 'outdated');
  assert.equal(status.version, '2.0.1');
  assert.match(claudeCliRefusalMessage(status)!, /claude update/);
});

test('an unparsable --version is trusted rather than refused', () => {
  // A wrapper script that prints nothing must not lock the user out.
  const status = resolveClaudeCliStatus({
    ...base,
    isExecutable: () => true,
    readVersion: () => null,
  });
  assert.equal(status.state, 'ok');
  assert.equal(status.version, undefined);
  assert.equal(claudeCliRefusalMessage(status), null);
});

test('this machine resolves a usable CLI', () => {
  // Not a mock: the shipped app depends on real discovery working here, and the
  // dev checkout has the SDK's own binary as a last resort. Skipped rather than
  // failed on a machine with neither, so CI without Claude Code stays green.
  const status = resolveClaudeCliStatus({ home: os.homedir() });
  if (status.state === 'missing') return;
  assert.equal(status.state, 'ok', `found ${status.path} at ${status.version}`);
  assert.ok(path.isAbsolute(status.path!));
});

test('the wire copy carries the version and never the binary path', () => {
  // `path` names the host's home directory and therefore their username, and
  // `hello` goes to anyone holding a socket. Field-by-field construction is what
  // keeps it off the wire, so this asserts the key is absent, not merely falsy.
  const status = resolveClaudeCliStatus({
    ...base,
    isExecutable: () => true,
    readVersion: () => '2.2.0',
  });
  assert.ok(status.path, 'the bridge-side status does keep the path');

  const wire = publicClaudeCliStatus(status);
  assert.deepEqual(Object.keys(wire).sort(), ['minVersion', 'state', 'version']);
  assert.equal('path' in wire, false);
  assert.deepEqual(wire, { state: 'ok', version: '2.2.0', minVersion: MIN_CLAUDE_VERSION });
});

test('the wire copy of a missing CLI omits the version rather than sending undefined', () => {
  const wire = publicClaudeCliStatus(resolveClaudeCliStatus({ ...base, isExecutable: () => false }));
  assert.deepEqual(wire, { state: 'missing', minVersion: MIN_CLAUDE_VERSION });
});
