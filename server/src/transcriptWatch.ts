import fs from 'node:fs';
import type { TranscriptEvent } from '@lines/shared';

const TRANSCRIPT_NAME = /^([A-Za-z0-9_-]+)\.jsonl$/;

/**
 * Streams lines another process appends to a shared transcripts folder (a dev
 * root symlinked to the prod root's). `lastSeq` is this process's own high-water
 * mark per session, so lines it wrote itself are never echoed back.
 */
export function watchSharedTranscripts(
  dir: string,
  lastSeq: Map<string, number>,
  onEvent: (sessionId: string, event: TranscriptEvent) => void,
): fs.FSWatcher | null {
  let real: string;
  try {
    if (!fs.lstatSync(dir).isSymbolicLink()) return null;
    real = fs.realpathSync(dir);
  } catch {
    return null;
  }

  const offsets = new Map<string, number>();
  for (const name of fs.readdirSync(real)) {
    if (!TRANSCRIPT_NAME.test(name)) continue;
    try {
      offsets.set(name, fs.statSync(`${real}/${name}`).size);
    } catch {
      // vanished between readdir and stat
    }
  }

  const drain = (name: string) => {
    const id = TRANSCRIPT_NAME.exec(name)?.[1];
    if (!id) return;
    const file = `${real}/${name}`;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      offsets.delete(name);
      return;
    }
    const from = offsets.get(name) ?? 0;
    if (size <= from) {
      offsets.set(name, size); // truncated by a rewind, or nothing new
      return;
    }
    const buf = Buffer.alloc(size - from);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, from);
    } finally {
      fs.closeSync(fd);
    }
    // Only whole lines: the writer may be mid-append.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return;
    offsets.set(name, from + end + 1);
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      let event: TranscriptEvent;
      try {
        event = JSON.parse(line) as TranscriptEvent;
      } catch {
        continue;
      }
      if (typeof event.seq !== 'number' || event.seq <= (lastSeq.get(id) ?? -1)) continue;
      lastSeq.set(id, event.seq);
      onEvent(id, event);
    }
  };

  const watcher = fs.watch(real, (_type, name) => {
    if (name) drain(name.toString());
  });
  watcher.unref();
  return watcher;
}
