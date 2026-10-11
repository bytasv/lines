import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TranscriptEvent } from '@lines/shared';
import { watchSharedTranscripts } from './transcriptWatch.ts';

const line = (seq: number) => JSON.stringify({ seq, ts: 0, kind: 'user', data: { text: `m${seq}` } }) + '\n';

function shared() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-twatch-'));
  const real = path.join(base, 'prod');
  const link = path.join(base, 'dev');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'dir');
  return { real, link };
}

function collect(n: number, events: [string, TranscriptEvent][]): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const tick = () => {
      if (events.length >= n) return resolve();
      if (Date.now() > deadline) return reject(new Error(`saw ${events.length} of ${n} events`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const settle = () => new Promise((r) => setTimeout(r, 200));

test('a missing folder is not watched', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lines-twatch-')), 'absent');
  assert.equal(watchSharedTranscripts(dir, new Map(), () => {}), null);
});

test('streams lines another writer appends, skipping existing and own ones', async () => {
  const { real, link } = shared();
  fs.writeFileSync(path.join(real, 's1.jsonl'), line(0));
  const own = new Map<string, number>([['s1', 1]]);
  const seen: [string, TranscriptEvent][] = [];
  const watcher = watchSharedTranscripts(link, own, (id, ev) => seen.push([id, ev]));
  assert.ok(watcher);
  try {
    await settle(); // the FSEvents stream is not live the moment fs.watch returns
    fs.appendFileSync(path.join(real, 's1.jsonl'), line(1)); // this process's own, already broadcast
    fs.appendFileSync(path.join(real, 's1.jsonl'), line(2));
    fs.appendFileSync(path.join(real, 's2.jsonl'), line(0)); // a new session's file
    await collect(2, seen);
    assert.deepEqual(
      seen.map(([id, ev]) => `${id}:${ev.seq}`).sort(),
      ['s1:2', 's2:0'],
    );
  } finally {
    watcher.close();
  }
});

test('a partial trailing line waits for its newline', async () => {
  const { real, link } = shared();
  const file = path.join(real, 's1.jsonl');
  fs.writeFileSync(file, '');
  const seen: [string, TranscriptEvent][] = [];
  const watcher = watchSharedTranscripts(link, new Map(), (id, ev) => seen.push([id, ev]));
  assert.ok(watcher);
  try {
    await settle(); // the FSEvents stream is not live the moment fs.watch returns
    const full = line(0);
    fs.appendFileSync(file, full.slice(0, 10));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, 0);
    fs.appendFileSync(file, full.slice(10));
    await collect(1, seen);
    assert.equal(seen[0][1].seq, 0);
  } finally {
    watcher.close();
  }
});
