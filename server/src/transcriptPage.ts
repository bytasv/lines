/**
 * Paging over a transcript's raw JSONL lines, for `loadTranscript` with `page`.
 * Pure on purpose: `index.ts` listens on import, so anything worth a unit test
 * has to live outside it.
 *
 * A page is byte-bounded (raw line text, so it costs nothing to measure) and then
 * stretched back to the `user` event that opens its turn, so the client never
 * builds a turn from its middle. One enormous turn (a long workflow step) would
 * defeat paging if that stretch were unbounded, so it stops at `4 × PAGE_BYTES`
 * and cuts mid-turn there; `buildTranscript` already tolerates the orphans.
 */

/** Byte budget of one page, in raw line text. */
export const PAGE_BYTES = 256 * 1024;

/** How far turn alignment may stretch a page before it cuts mid-turn. */
const ALIGN_LIMIT = 4 * PAGE_BYTES;

export interface PageOptions {
  /** Only events with `seq < before`. Absent = the tail of the file. */
  before?: number;
  /** Everything older than `before` in one page, ignoring the budget. */
  all?: boolean;
}

export interface TranscriptPage {
  lines: string[];
  /** The file's first seq (0 for an empty file). */
  floor: number;
  /** Seq of the last event not sent, or null when the page reaches the start. */
  prevSeq: number | null;
}

// `emitEvent` builds events as `{ seq, ts, kind, data }`, and JSON.stringify
// keeps that key order, so both reads come straight off the line prefix.
const SEQ_PREFIX = /^\{"seq":(\d+)/;
const USER_PREFIX = /^\{"seq":\d+,"ts":\d+,"kind":"user"/;

/** Seq of one line, off its prefix; a full parse only when the prefix misses. */
export function lineSeq(line: string): number {
  const m = SEQ_PREFIX.exec(line);
  if (m) return Number(m[1]);
  return (JSON.parse(line) as { seq: number }).seq;
}

function isUserLine(line: string): boolean {
  if (USER_PREFIX.test(line)) return true;
  if (SEQ_PREFIX.test(line)) return false; // ours, in the usual order: not a user event
  try {
    return (JSON.parse(line) as { kind?: string }).kind === 'user';
  } catch {
    return false;
  }
}

/** Index of the first line whose seq is `>= seq` (lines are in seq order). */
function lowerBound(lines: string[], seq: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lineSeq(lines[mid]) < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function pageTranscript(lines: string[], opts: PageOptions): TranscriptPage {
  if (lines.length === 0) return { lines: [], floor: 0, prevSeq: null };
  const floor = lineSeq(lines[0]);
  const end = opts.before === undefined ? lines.length : lowerBound(lines, opts.before);
  let start = end;
  if (opts.all && opts.before !== undefined) {
    start = 0;
  } else if (end > 0) {
    let bytes = 0;
    // Fill the budget; always at least one line, so the client's loop advances
    // even past a single line bigger than the whole budget.
    while (start > 0 && (start === end || bytes < PAGE_BYTES)) {
      start--;
      bytes += lines[start].length;
    }
    // Stretch back to the turn's opening `user` event, within the cap.
    while (start > 0 && !isUserLine(lines[start]) && bytes < ALIGN_LIMIT) {
      start--;
      bytes += lines[start].length;
    }
  }
  return {
    lines: lines.slice(start, end),
    floor,
    prevSeq: start > 0 ? lineSeq(lines[start - 1]) : null,
  };
}
