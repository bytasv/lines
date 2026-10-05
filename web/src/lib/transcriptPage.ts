import type { TranscriptEvent } from '@lines/shared';

/** Paging metadata of a `transcript` frame; absent = the frame is the whole file. */
export interface TranscriptPageInfo {
  floor: number;
  prevSeq: number | null;
}

/**
 * Folds one `transcript` frame into the cached events. Pure, so it is tested
 * from the server's runner.
 *
 * By default this is the merge `case 'transcript'` always did: dedupe by seq,
 * then sort, so live events that raced the reply survive it.
 *
 * The one exception is a hole. A page whose `prevSeq` (the newest event it did
 * *not* carry) is newer than everything cached sits after a gap — the tail page
 * after a long disconnect — and keeping the cache would leave the events in
 * between missing for good, since backfill only ever walks back from the first
 * seq. So the cache is dropped and backfill re-fetches it. An older page can't
 * trip this: its `prevSeq` is below the first cached seq by construction.
 */
export function mergeTranscriptPage(
  cached: TranscriptEvent[],
  events: TranscriptEvent[],
  page: TranscriptPageInfo | undefined,
): TranscriptEvent[] {
  const last = cached.length > 0 ? cached[cached.length - 1].seq : -1;
  const keep = page && page.prevSeq !== null && page.prevSeq > last ? [] : cached;
  const merged = [...events];
  const seen = new Set(merged.map((e) => e.seq));
  for (const e of keep) if (!seen.has(e.seq)) merged.push(e);
  merged.sort((a, b) => a.seq - b.seq);
  return merged;
}

/** Older history is still unfetched. A missing floor means the cache is complete. */
export function transcriptHasMore(events: TranscriptEvent[] | undefined, floor: number | undefined): boolean {
  return floor !== undefined && events !== undefined && events.length > 0 && events[0].seq > floor;
}
