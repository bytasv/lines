import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TranscriptEvent } from '@lines/shared';
import { mergeTranscriptPage, transcriptHasMore } from '../../web/src/lib/transcriptPage.ts';

/**
 * The client's `transcript` merge, tested from the server's runner because that
 * is the only test runner this repo has.
 */
function ev(seq: number): TranscriptEvent {
  return { seq, ts: seq, kind: 'sdk', data: { seq } };
}

function range(from: number, to: number): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  for (let s = from; s <= to; s++) out.push(ev(s));
  return out;
}

function seqs(events: TranscriptEvent[]): number[] {
  return events.map((e) => e.seq);
}

describe('mergeTranscriptPage', () => {
  test('an older page prepends', () => {
    const merged = mergeTranscriptPage(range(10, 19), range(0, 9), { floor: 0, prevSeq: null });
    assert.deepEqual(seqs(merged), seqs(range(0, 19)));
  });

  test('an overlap with live events is de-duplicated', () => {
    // Live events 18..21 raced the tail page 10..19.
    const merged = mergeTranscriptPage(range(18, 21), range(10, 19), { floor: 0, prevSeq: 9 });
    assert.deepEqual(seqs(merged), seqs(range(10, 21)));
  });

  test('a tail page after a gap drops the disjoint cache', () => {
    // Cached 0..9, then a long disconnect: the tail page starts at 50 and the
    // last event it did not send (49) is newer than anything cached.
    const merged = mergeTranscriptPage(range(0, 9), range(50, 59), { floor: 0, prevSeq: 49 });
    assert.deepEqual(seqs(merged), seqs(range(50, 59)));
  });

  test('a tail page contiguous with the cache keeps it', () => {
    const merged = mergeTranscriptPage(range(0, 9), range(10, 19), { floor: 0, prevSeq: 9 });
    assert.deepEqual(seqs(merged), seqs(range(0, 19)));
  });

  test('a complete response merges exactly as before paging', () => {
    const cached = [ev(5), ev(30), ev(31)];
    const merged = mergeTranscriptPage(cached, range(0, 29), undefined);
    assert.deepEqual(seqs(merged), seqs(range(0, 31)));
    // The reply's copy wins over the cached one for a shared seq.
    const reply = { ...ev(5), data: 'fresh' };
    assert.equal(mergeTranscriptPage(cached, [reply], undefined)[0].data, 'fresh');
  });
});

describe('transcriptHasMore', () => {
  test('more only while the first cached seq is above a known floor', () => {
    assert.equal(transcriptHasMore(range(10, 19), 0), true);
    assert.equal(transcriptHasMore(range(0, 19), 0), false);
    assert.equal(transcriptHasMore(range(10, 19), undefined), false);
    assert.equal(transcriptHasMore([], 0), false);
    assert.equal(transcriptHasMore(undefined, 0), false);
  });
});
