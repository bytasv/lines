import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  installedWhisperModels,
  MIN_WHISPER_VERSION,
  pickWhisperModel,
  publicWhisperStatus,
  resolveWhisperStatus,
  whisperCandidatePaths,
  whisperRefusalMessage,
  type WhisperDiscoveryDeps,
} from './whisperCli.ts';

const ROOT = '/Users/tester/.lines-app';
const MODEL = path.join(ROOT, 'models', 'ggml-base.en.bin');
/** Nothing on PATH unless a case says so, so the order assertions stay stable. */
const base: WhisperDiscoveryDeps = { env: {}, appRoot: ROOT, onPath: () => null, readVersion: () => null };

test('the env override replaces every installed location', () => {
  assert.deepEqual(whisperCandidatePaths({ ...base, env: { LINES_WHISPER_BIN: '/pinned/whisper-cli' } }), [
    '/pinned/whisper-cli',
  ]);
  // Exclusive: a wrong pin is "missing", not a quiet fall-through to Homebrew.
  assert.equal(
    resolveWhisperStatus({
      ...base,
      env: { LINES_WHISPER_BIN: '/pinned/whisper-cli' },
      isExecutable: (p) => p === '/opt/homebrew/bin/whisper-cli',
    }).state,
    'missing-binary',
  );
});

test('Homebrew is preferred over PATH', () => {
  assert.deepEqual(whisperCandidatePaths({ ...base, onPath: () => '/some/shim/whisper-cli' }), [
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
    '/some/shim/whisper-cli',
  ]);
});

test('the desktop app\'s bundled binary comes before Homebrew, and is not exclusive', () => {
  assert.deepEqual(whisperCandidatePaths({ ...base, env: { LINES_WHISPER_BUNDLED_BIN: '/App/Resources/whisper/whisper-cli' } }), [
    '/App/Resources/whisper/whisper-cli',
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
  ]);
});

test('discovery skips candidates that are not executable', () => {
  const status = resolveWhisperStatus({
    ...base,
    onPath: () => '/some/shim/whisper-cli',
    isExecutable: (p) => p === '/some/shim/whisper-cli',
    isFile: () => true,
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.path, '/some/shim/whisper-cli');
});

test('installed models are the known files present under the app root; the env pin is exclusive', () => {
  const turbo = path.join(ROOT, 'models', 'ggml-large-v3-turbo-q5_0.bin');
  assert.deepEqual(installedWhisperModels({ ...base, isFile: (p) => p === MODEL || p === turbo }), {
    'ggml-large-v3-turbo-q5_0.bin': turbo,
    'ggml-base.en.bin': MODEL,
  });
  // Unknown files in the folder are not picked up.
  assert.deepEqual(installedWhisperModels({ ...base, isFile: (p) => p.endsWith('/stray.bin') }), {});
  assert.deepEqual(
    installedWhisperModels({ ...base, env: { LINES_WHISPER_MODEL: '/pinned/ggml-medium.bin' }, isFile: () => true }),
    { 'ggml-medium.bin': '/pinned/ggml-medium.bin' },
  );
});

test('English prefers the English-only model; other languages the multilingual one', () => {
  const models = {
    'ggml-base.en.bin': '/m/base.en',
    'ggml-large-v3-turbo-q5_0.bin': '/m/turbo',
  };
  assert.deepEqual(pickWhisperModel(models, 'en'), { file: 'ggml-base.en.bin', path: '/m/base.en', multilingual: false });
  assert.deepEqual(pickWhisperModel(models, 'lt'), {
    file: 'ggml-large-v3-turbo-q5_0.bin',
    path: '/m/turbo',
    multilingual: true,
  });
  assert.equal((pickWhisperModel(models, 'auto') as { file: string }).file, 'ggml-large-v3-turbo-q5_0.bin');
  // English with only the multilingual model still works.
  const turboOnly = { 'ggml-large-v3-turbo-q5_0.bin': '/m/turbo' };
  assert.equal((pickWhisperModel(turboOnly, 'en') as { file: string }).file, 'ggml-large-v3-turbo-q5_0.bin');
});

test('any language but English, auto included, needs the multilingual model', () => {
  const englishOnly = { 'ggml-base.en.bin': '/m/base.en' };
  assert.match((pickWhisperModel(englishOnly, 'lt') as { error: string }).error, /multilingual model/);
  assert.match((pickWhisperModel(englishOnly, 'auto') as { error: string }).error, /multilingual model/);
  assert.match((pickWhisperModel({}, 'en') as { error: string }).error, /needs a whisper model/);
});

test('no binary is "missing-binary", and says how to install it', () => {
  const status = resolveWhisperStatus({ ...base, isExecutable: () => false, isFile: () => true });
  assert.deepEqual(status, { state: 'missing-binary', minVersion: MIN_WHISPER_VERSION });
  assert.match(whisperRefusalMessage(status)!, /brew install whisper-cpp/);
});

test('a binary without a model is "missing-model", distinct from a missing binary', () => {
  const status = resolveWhisperStatus({ ...base, isExecutable: () => true, isFile: () => false });
  assert.equal(status.state, 'missing-model');
  assert.equal(status.path, '/opt/homebrew/bin/whisper-cli');
  assert.deepEqual(status.models, []);
  assert.match(whisperRefusalMessage(status)!, /Settings → Voice input/);
});

test('a binary below the floor is "outdated"; an unreadable version still runs', () => {
  const deps = { ...base, isExecutable: () => true, isFile: () => true };
  assert.equal(resolveWhisperStatus({ ...deps, readVersion: () => '1.5.0' }).state, 'outdated');
  assert.equal(resolveWhisperStatus({ ...deps, readVersion: () => null }).state, 'ready');
});

test('ready carries both paths bridge-side, and the public copy strips them', () => {
  const status = resolveWhisperStatus({ ...base, isExecutable: () => true, isFile: () => true, readVersion: () => '1.8.0' });
  const all = Object.fromEntries(
    ['ggml-large-v3-turbo-q5_0.bin', 'ggml-base.en.bin'].map((f) => [
      f,
      path.join(ROOT, 'models', f),
    ]),
  );
  assert.deepEqual(status, {
    state: 'ready',
    path: '/opt/homebrew/bin/whisper-cli',
    models: Object.keys(all),
    modelPaths: all,
    version: '1.8.0',
    minVersion: MIN_WHISPER_VERSION,
  });
  assert.equal(whisperRefusalMessage(status), null);
  assert.deepEqual(publicWhisperStatus(status), {
    state: 'ready',
    version: '1.8.0',
    models: Object.keys(all),
    minVersion: MIN_WHISPER_VERSION,
  });
});
