import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downloadWhisperModel } from './whisperModel.ts';

/** ggml's magic as whisper.cpp reads it (little-endian), then some weights. */
function modelBytes(size = 64): Uint8Array {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(0x67676d6c, 0);
  return bytes;
}

/** A fetch that answers with `body`, announcing `length` (default: the true one). */
function fakeFetch(body: Uint8Array, init: { status?: number; length?: number | null } = {}): typeof fetch {
  return (async () => {
    const headers = new Headers();
    const length = init.length === undefined ? body.length : init.length;
    if (length !== null) headers.set('content-length', String(length));
    return new Response(body, { status: init.status ?? 200, headers });
  }) as typeof fetch;
}

const MODEL = 'ggml-base.en.bin';

function target(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-model-test-'));
  return { dir, file: path.join(dir, 'models', MODEL) };
}

test('a complete ggml file lands at the target, via a .part that is gone afterwards', async () => {
  const { dir, file } = target();
  const progress: number[] = [];
  await downloadWhisperModel(MODEL, (received) => progress.push(received), {
    fetch: fakeFetch(modelBytes()),
    dir: path.dirname(file),
    now: (() => {
      let t = 0;
      return () => (t += 1000);
    })(),
  });
  assert.equal(fs.statSync(file).size, 64);
  assert.equal(fs.existsSync(`${file}.part`), false);
  assert.ok(progress.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an HTTP error writes nothing', async () => {
  const { dir, file } = target();
  await assert.rejects(
    downloadWhisperModel(MODEL, () => {}, { fetch: fakeFetch(new Uint8Array(), { status: 404 }), dir: path.dirname(file) }),
    /HTTP 404/,
  );
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a truncated download is refused and its .part removed', async () => {
  const { dir, file } = target();
  // The announced total disagrees with what arrived — the same check a dropped
  // connection trips.
  await assert.rejects(
    downloadWhisperModel(MODEL, () => {}, { fetch: fakeFetch(modelBytes(), { length: 9999 }), dir: path.dirname(file) }),
    /cut short/,
  );
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.part`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file without the ggml magic (an HTML error page, say) is refused', async () => {
  const { dir, file } = target();
  const html = new TextEncoder().encode('<!doctype html><title>Rate limited</title>');
  await assert.rejects(downloadWhisperModel(MODEL, () => {}, { fetch: fakeFetch(html), dir: path.dirname(file) }), /not a whisper model/);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
