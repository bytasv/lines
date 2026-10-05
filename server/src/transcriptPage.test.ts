import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PAGE_BYTES, lineSeq, pageTranscript } from './transcriptPage.ts';

/** One JSONL line in the key order `emitEvent` writes, padded to ~`bytes`. */
function line(seq: number, kind: string, bytes = 100): string {
  return JSON.stringify({ seq, ts: 1_700_000_000_000 + seq, kind, data: { pad: 'x'.repeat(bytes) } });
}

function seqs(lines: string[]): number[] {
  return lines.map(lineSeq);
}

/** `turns` turns of one user event followed by `perTurn - 1` sdk events. */
function session(turns: number, perTurn: number, bytes = 100, first = 0): string[] {
  const out: string[] = [];
  let seq = first;
  for (let t = 0; t < turns; t++) {
    for (let i = 0; i < perTurn; i++) out.push(line(seq++, i === 0 ? 'user' : 'sdk', bytes));
  }
  return out;
}

describe('pageTranscript', () => {
  test('an empty file is one empty, complete page', () => {
    assert.deepEqual(pageTranscript([], {}), { lines: [], floor: 0, prevSeq: null });
    assert.deepEqual(pageTranscript([], { before: 10 }), { lines: [], floor: 0, prevSeq: null });
  });

  test('a file under the budget comes back whole as the tail page', () => {
    const lines = session(3, 4, 100, 5);
    const page = pageTranscript(lines, {});
    assert.deepEqual(page.lines, lines);
    assert.equal(page.floor, 5);
    assert.equal(page.prevSeq, null);
  });

  test('the tail page stops near the budget and reports the last event not sent', () => {
    // 10 turns of 10 events of ~10 KB: ~1 MB, so the tail is a few turns.
    const lines = session(10, 10, 10_000);
    const page = pageTranscript(lines, {});
    assert.ok(page.lines.length < lines.length);
    assert.equal(page.lines.at(-1), lines.at(-1));
    const first = lineSeq(page.lines[0]);
    assert.equal(page.prevSeq, first - 1);
    assert.equal(page.floor, 0);
    const bytes = page.lines.reduce((n, l) => n + l.length, 0);
    assert.ok(bytes >= PAGE_BYTES);
  });

  test('a page starts on the user event that opens its turn', () => {
    const lines = session(10, 10, 10_000);
    const page = pageTranscript(lines, {});
    assert.match(page.lines[0], /"kind":"user"/);
    // Turns are 10 events long and start at multiples of 10.
    assert.equal(lineSeq(page.lines[0]) % 10, 0);
  });

  test('turn alignment stops at 4 × the budget inside one huge turn', () => {
    // One user event, then ~2 MB of sdk events: alignment can't reach the user
    // event within the cap, so the page cuts mid-turn.
    const lines = session(1, 200, 10_000);
    const page = pageTranscript(lines, {});
    assert.ok(page.lines.length < lines.length);
    assert.doesNotMatch(page.lines[0], /"kind":"user"/);
    const bytes = page.lines.reduce((n, l) => n + l.length, 0);
    assert.ok(bytes >= 4 * PAGE_BYTES);
    assert.ok(bytes < 4 * PAGE_BYTES + 20_000);
  });

  test('`before` binary-searches to the events strictly older than it', () => {
    const lines = session(5, 4, 100, 100);
    const page = pageTranscript(lines, { before: 110 });
    assert.deepEqual(seqs(page.lines), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    assert.equal(page.prevSeq, null);
    assert.equal(page.floor, 100);
  });

  test('`before` below the floor is an empty, complete page', () => {
    const lines = session(2, 2, 100, 50);
    assert.deepEqual(pageTranscript(lines, { before: 50 }), { lines: [], floor: 50, prevSeq: null });
  });

  test('`before` pages walk back to the start without gaps or overlap', () => {
    const lines = session(20, 10, 10_000);
    const got: number[] = [];
    let page = pageTranscript(lines, {});
    got.unshift(...seqs(page.lines));
    for (let guard = 0; page.prevSeq !== null && guard < 100; guard++) {
      page = pageTranscript(lines, { before: lineSeq(page.lines[0]) });
      assert.equal(lineSeq(page.lines.at(-1)!), got[0] - 1);
      got.unshift(...seqs(page.lines));
    }
    assert.deepEqual(got, seqs(lines));
  });

  test('`all` returns everything older than `before` in one page', () => {
    const lines = session(20, 10, 10_000);
    const page = pageTranscript(lines, { before: 150, all: true });
    assert.deepEqual(seqs(page.lines), seqs(lines).slice(0, 150));
    assert.equal(page.prevSeq, null);
  });

  test('a single line over the budget still makes progress', () => {
    const lines = [line(0, 'user'), line(1, 'sdk', PAGE_BYTES * 5), line(2, 'sdk', PAGE_BYTES * 5)];
    const tail = pageTranscript(lines, {});
    assert.deepEqual(seqs(tail.lines), [2]);
    assert.equal(tail.prevSeq, 1);
    const next = pageTranscript(lines, { before: 2 });
    assert.deepEqual(seqs(next.lines), [1]);
    assert.equal(next.prevSeq, 0);
  });

  test('a line whose keys are out of order falls back to a parse', () => {
    const odd = (seq: number, kind: string) => JSON.stringify({ kind, ts: seq, seq, data: {} });
    const lines = [odd(3, 'user'), odd(4, 'sdk'), odd(5, 'user'), odd(6, 'sdk')];
    assert.equal(lineSeq(lines[2]), 5);
    const page = pageTranscript(lines, { before: 6 });
    assert.deepEqual(seqs(page.lines), [3, 4, 5]);
    assert.equal(page.floor, 3);
  });
});
