import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { VOICE_AUDIO_MAX_BYTES } from '@lines/shared';
import type { WhisperStatus } from '@lines/shared';
import { cleanTranscript, createTranscriber, type ExecFileFn } from './transcribe.ts';

const READY: WhisperStatus = {
  state: 'ready',
  path: '/opt/homebrew/bin/whisper-cli',
  models: ['ggml-large-v3-turbo-q5_0.bin', 'ggml-base.en.bin'],
  modelPaths: {
    'ggml-large-v3-turbo-q5_0.bin': '/models/ggml-large-v3-turbo-q5_0.bin',
    'ggml-base.en.bin': '/models/ggml-base.en.bin',
  },
  minVersion: '1.7.4',
};

/** A minimal, valid-looking WAV: the RIFF/WAVE header plus a few samples. */
function wav(extra = 16): string {
  const bytes = Buffer.alloc(44 + extra);
  bytes.write('RIFF', 0, 'ascii');
  bytes.write('WAVE', 8, 'ascii');
  return bytes.toString('base64');
}

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lines-transcribe-test-'));
}

test('the transcript comes back trimmed, with whisper markers removed', async () => {
  const tmpDir = scratch();
  const calls: string[][] = [];
  const execFile: ExecFileFn = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: ' Hello there.\n [BLANK_AUDIO]\n General Kenobi.\n', stderr: '' };
  };
  const run = createTranscriber({ status: () => READY, execFile, tmpDir });
  assert.equal(await run(wav()), 'Hello there. General Kenobi.');
  assert.equal(calls[0][0], READY.path);
  // No language named: auto-detect, on the best multilingual model.
  assert.deepEqual(calls[0].slice(1, 3), ['-m', '/models/ggml-large-v3-turbo-q5_0.bin']);
  assert.deepEqual(calls[0].slice(-2), ['-l', 'auto']);
  assert.ok(calls[0].includes('-nt') && calls[0].includes('-np'));
  // The scratch file is gone after a success, too.
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('the language and translation reach whisper, and English picks the English model', async () => {
  const calls: string[][] = [];
  const execFile: ExecFileFn = async (_file, args) => {
    calls.push(args);
    return { stdout: 'ok', stderr: '' };
  };
  const run = createTranscriber({ status: () => READY, execFile, tmpDir: scratch() });
  await run(wav(), { language: 'lt', translate: true });
  assert.deepEqual(calls[0].slice(-3), ['-l', 'lt', '-tr']);
  await run(wav(), { language: 'en', translate: true });
  assert.equal(calls[1][1], '/models/ggml-base.en.bin');
  // An English-only model is never asked to translate.
  assert.deepEqual(calls[1].slice(-2), ['-l', 'en']);
});

test('a language code that is not one is refused before anything runs', async () => {
  const run = createTranscriber({ status: () => READY, execFile: async () => assert.fail('must not spawn'), tmpDir: scratch() });
  await assert.rejects(run(wav(), { language: '--model=/etc/passwd' }), /not a language/);
});

test('a named language with only an English model is refused with the fix', async () => {
  const run = createTranscriber({
    status: () => ({ ...READY, models: ['ggml-base.en.bin'], modelPaths: { 'ggml-base.en.bin': '/m/base.en' } }),
    execFile: async () => assert.fail('must not spawn'),
    tmpDir: scratch(),
  });
  await assert.rejects(run(wav(), { language: 'lt' }), /multilingual/);
});

test('an oversized recording is refused before whisper is spawned', async () => {
  let spawned = false;
  const run = createTranscriber({
    status: () => READY,
    execFile: async () => {
      spawned = true;
      return { stdout: '', stderr: '' };
    },
    tmpDir: scratch(),
  });
  await assert.rejects(run(wav(VOICE_AUDIO_MAX_BYTES)), /too long/);
  assert.equal(spawned, false);
});

test('bytes that are not a WAV are refused', async () => {
  const run = createTranscriber({ status: () => READY, execFile: async () => ({ stdout: '', stderr: '' }), tmpDir: scratch() });
  await assert.rejects(run(Buffer.from('definitely not audio, but long enough to pass the length check').toString('base64')), /not a WAV/);
});

test('a missing install is refused with the fix, not spawned', async () => {
  const run = createTranscriber({
    status: () => ({ state: 'missing-model', path: READY.path, minVersion: '1.7.4' }),
    execFile: async () => assert.fail('must not spawn'),
    tmpDir: scratch(),
  });
  await assert.rejects(run(wav()), /whisper model/);
});

test('a timeout is reported as one, and the temp file is still removed', async () => {
  const tmpDir = scratch();
  let seenTimeout = 0;
  const execFile: ExecFileFn = async (_file, args, options) => {
    seenTimeout = options.timeout;
    // The WAV was written where whisper was pointed.
    assert.ok(fs.existsSync(args[args.indexOf('-f') + 1]));
    throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
  };
  const run = createTranscriber({ status: () => READY, execFile, tmpDir, timeoutMs: 1234 });
  await assert.rejects(run(wav()), /timed out/);
  assert.equal(seenTimeout, 1234);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('a failure names whisper\'s last stderr line and cleans up', async () => {
  const tmpDir = scratch();
  const run = createTranscriber({
    status: () => READY,
    execFile: async () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'loading model\nerror: failed to read WAV file\n' });
    },
    tmpDir,
  });
  await assert.rejects(run(wav()), /Transcription failed: error: failed to read WAV file/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('transcriptions run one at a time, and a failure does not jam the queue', async () => {
  let running = 0;
  let peak = 0;
  let n = 0;
  const execFile: ExecFileFn = async () => {
    const mine = ++n;
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    if (mine === 1) throw new Error('boom');
    return { stdout: `clip ${mine}`, stderr: '' };
  };
  const run = createTranscriber({ status: () => READY, execFile, tmpDir: scratch() });
  const results = await Promise.allSettled([run(wav()), run(wav()), run(wav())]);
  assert.equal(peak, 1);
  assert.equal(results[0].status, 'rejected');
  assert.deepEqual(
    results.slice(1).map((r) => (r.status === 'fulfilled' ? r.value : null)),
    ['clip 2', 'clip 3'],
  );
});

test('past the queue cap a request is refused rather than queued', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const execFile: ExecFileFn = async () => {
    await gate;
    return { stdout: 'ok', stderr: '' };
  };
  const run = createTranscriber({ status: () => READY, execFile, tmpDir: scratch(), maxQueued: 1 });
  const first = run(wav());
  const second = run(wav());
  await assert.rejects(run(wav()), /busy/);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
});

test('cleanTranscript drops silence entirely', () => {
  assert.equal(cleanTranscript('\n [BLANK_AUDIO]\n'), '');
});
