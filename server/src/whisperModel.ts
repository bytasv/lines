// SPDX-License-Identifier: AGPL-3.0-only
// Additional permission under GNU AGPL v3 section 7 — see LICENSE-EXCEPTION.

/**
 * Fetching a whisper model for the user, so voice input needs no terminal on a
 * machine that already has the binary (which the desktop app ships).
 *
 * Only the files in `WHISPER_MODELS`, from their one known URL, so this is a
 * plain download, not something to hand an agent. It streams into `<model>.part` and only renames once the byte
 * count matches what the server announced and the file opens with ggml's magic —
 * so a half-written or HTML-error-page "model" never reaches the path
 * `whisperCli.ts` treats as ready.
 */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isWhisperModelFile, whisperModelUrl } from '@lines/shared';
import type { WhisperModelDownload, WhisperModelFile } from '@lines/shared';
import { whisperModelsDir } from './whisperCli.ts';

/** `GGML_FILE_MAGIC`, as whisper.cpp reads it: a little-endian uint32 up front. */
const GGML_MAGIC = 0x67676d6c;
/** How often progress is published. The pane needs a bar, not every chunk. */
const PROGRESS_EVERY_MS = 500;

export interface ModelDownloadDeps {
  fetch?: typeof fetch;
  /** Directory the model lands in; defaults to `<app root>/models`. */
  dir?: string;
  now?: () => number;
}

/**
 * Download to `target`, reporting `received`/`total` as it goes. Resolves once
 * the file is in place; rejects (with the `.part` removed) otherwise.
 */
export async function downloadWhisperModel(
  file: WhisperModelFile,
  onProgress: (received: number, total: number | null) => void,
  deps: ModelDownloadDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetch ?? fetch;
  const url = whisperModelUrl(file);
  const target = path.join(deps.dir ?? whisperModelsDir(), file);
  const now = deps.now ?? Date.now;
  const part = `${target}.part`;

  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`The model download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || null;

  await fs.mkdir(path.dirname(target), { recursive: true });
  let received = 0;
  let lastReport = 0;
  let head = Buffer.alloc(0);
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length;
      if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4 - head.length)]);
      if (now() - lastReport >= PROGRESS_EVERY_MS) {
        lastReport = now();
        onProgress(received, total);
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(part, { mode: 0o644 }),
    );
    if (total !== null && received !== total) {
      throw new Error('The model download was cut short — try again.');
    }
    if (head.length < 4 || head.readUInt32LE(0) !== GGML_MAGIC) {
      throw new Error('The downloaded file is not a whisper model.');
    }
    await fs.rename(part, target);
  } catch (err) {
    await fs.rm(part, { force: true });
    throw err;
  }
}

let state: WhisperModelDownload = { state: 'idle' };
const listeners = new Set<(status: WhisperModelDownload, finished: boolean) => void>();

export function whisperModelDownloadState(): WhisperModelDownload {
  return state;
}

/** `finished` is true exactly once per successful download, so the caller can
 *  re-probe and republish `cliStatus`. */
export function onWhisperModelDownload(
  listener: (status: WhisperModelDownload, finished: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: WhisperModelDownload, finished = false) {
  state = next;
  for (const listener of listeners) listener(next, finished);
}

/**
 * Start the one download this bridge runs at a time. A second request while one
 * is in flight is a no-op rather than a second half-gigabyte stream.
 *
 * Refused under `LINES_WHISPER_MODEL`: that pin makes discovery look at one file
 * only, so a download into the models folder would change nothing.
 */
export function startWhisperModelDownload(
  file: string,
  deps: ModelDownloadDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  // The file name becomes a path and a URL; only the known list gets that far.
  if (!isWhisperModelFile(file)) return;
  if (state.state === 'downloading') return;
  if (env.LINES_WHISPER_MODEL && !deps.dir) {
    publish({ state: 'error', file, message: 'LINES_WHISPER_MODEL is set — models are not downloaded while it is.' });
    return;
  }
  publish({ state: 'downloading', file, received: 0, total: null });
  downloadWhisperModel(file, (received, total) => publish({ state: 'downloading', file, received, total }), deps).then(
    () => publish({ state: 'idle' }, true),
    (err: unknown) =>
      publish({ state: 'error', file, message: err instanceof Error ? err.message : 'The model download failed.' }),
  );
}
