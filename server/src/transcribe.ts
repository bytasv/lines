// SPDX-License-Identifier: AGPL-3.0-only
// Additional permission under GNU AGPL v3 section 7 — see LICENSE-EXCEPTION.

/**
 * Voice input: one dictated WAV in, its text out, through the local whisper.cpp
 * that `whisperCli.ts` found.
 *
 * The browser does the encoding (16 kHz mono WAV), so nothing here needs ffmpeg:
 * the bytes go to a scratch file, `whisper-cli` reads it, and the file is gone
 * again whatever happened. Transcriptions run one at a time — on a shared machine
 * the audio is a guest's but the CPU is the host's, and whisper will happily take
 * every core it is given.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isVoiceLanguage, VOICE_AUDIO_MAX_BYTES } from '@lines/shared';
import type { WhisperStatus } from '@lines/shared';
import { pickWhisperModel, whisperRefusalMessage, whisperStatus } from './whisperCli.ts';

/** Generous for the base model on a laptop; a VPS bridge is slower. */
export const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** Waiting behind the running one. More than this is refused rather than queued
 *  for minutes nobody will wait through. */
export const TRANSCRIBE_MAX_QUEUED = 4;

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface TranscribeDeps {
  status?: () => WhisperStatus;
  execFile?: ExecFileFn;
  /** Parent of the per-request scratch directory. */
  tmpDir?: string;
  timeoutMs?: number;
  maxQueued?: number;
}

const defaultExecFile: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { ...options, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });

/** A RIFF/WAVE header — cheap proof the bytes are what the recorder produces
 *  before they are handed to a native binary. */
function isWav(bytes: Buffer): boolean {
  return (
    bytes.length > 44 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WAVE'
  );
}

/**
 * `-nt` output is the text alone, one segment per line. Silence comes back as a
 * `[BLANK_AUDIO]` marker (and noise as `[Music]`-style tags), which is not
 * something anyone meant to type.
 */
export function cleanTranscript(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\[[A-Z_ ]+\]/g, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The last non-empty stderr line, which is where whisper-cli says what went wrong. */
function lastLine(text: unknown): string {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

export interface TranscribeOptions {
  /** `auto` or an ISO 639-1 code. Absent = `auto`. */
  language?: string;
  /** Translate the speech into English text. */
  translate?: boolean;
}

/**
 * The `whisper-cli` arguments after the model and the file. An English-only
 * model is always told `en` and never asked to translate: it can do neither
 * of the other things, and whisper would only warn and fall back anyway.
 */
export function languageArgs(multilingual: boolean, language: string, translate: boolean): string[] {
  if (!multilingual) return ['-l', 'en'];
  return ['-l', language, ...(translate ? ['-tr'] : [])];
}

export function createTranscriber(
  deps: TranscribeDeps = {},
): (audio: string, options?: TranscribeOptions) => Promise<string> {
  const status = deps.status ?? whisperStatus;
  const execFile = deps.execFile ?? defaultExecFile;
  const timeoutMs = deps.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
  const maxQueued = deps.maxQueued ?? TRANSCRIBE_MAX_QUEUED;
  let tail: Promise<unknown> = Promise.resolve();
  /** Accepted and not yet settled, the running one included. */
  let inFlight = 0;

  async function run(bytes: Buffer, language: string, translate: boolean): Promise<string> {
    const whisper = status();
    const refusal = whisperRefusalMessage(whisper);
    if (refusal || !whisper.path) throw new Error(refusal ?? 'Voice input is not available.');
    const model = pickWhisperModel(whisper.modelPaths ?? {}, language);
    if ('error' in model) throw new Error(model.error);
    const dir = await fs.mkdtemp(path.join(deps.tmpDir ?? os.tmpdir(), 'lines-voice-'));
    try {
      const wav = path.join(dir, 'audio.wav');
      await fs.writeFile(wav, bytes, { mode: 0o600 });
      try {
        const { stdout } = await execFile(
          whisper.path,
          ['-m', model.path, '-f', wav, '-nt', '-np', ...languageArgs(model.multilingual, language, translate)],
          { timeout: timeoutMs },
        );
        return cleanTranscript(stdout);
      } catch (err) {
        const e = err as { killed?: boolean; signal?: string | null; stderr?: unknown };
        if (e.killed || e.signal === 'SIGTERM') throw new Error('Transcription timed out.');
        const detail = lastLine(e.stderr);
        throw new Error(detail ? `Transcription failed: ${detail}` : 'Transcription failed.');
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  return async (audio: string, options: TranscribeOptions = {}) => {
    const language = options.language ?? 'auto';
    // Checked before it can become an argument to a native binary.
    if (!isVoiceLanguage(language)) throw new Error('That is not a language voice input knows.');
    // Checked on the encoded length first, so an oversized frame is refused
    // without decoding it.
    if (Math.floor((audio.length * 3) / 4) > VOICE_AUDIO_MAX_BYTES) {
      throw new Error('That recording is too long to transcribe.');
    }
    const bytes = Buffer.from(audio, 'base64');
    if (bytes.length > VOICE_AUDIO_MAX_BYTES) throw new Error('That recording is too long to transcribe.');
    if (!isWav(bytes)) throw new Error('That recording is not a WAV file.');
    if (inFlight > maxQueued) throw new Error('This machine is busy transcribing — try again in a moment.');
    inFlight++;
    const result = tail.then(() => run(bytes, language, options.translate === true));
    // The chain must survive a failed transcription, or one error would refuse
    // every later one.
    tail = result.catch(() => undefined);
    try {
      return await result;
    } finally {
      inFlight--;
    }
  };
}

/** The bridge's one transcriber: one queue per machine, shared by every user context. */
export const transcribe = createTranscriber();
