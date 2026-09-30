import type { LineMatcher, SessionSearchHit, TranscriptEvent } from '@lines/shared';
import { clipAround } from '@lines/shared';
import { withoutCompactSpans } from './sessions.ts';

/**
 * Find-in-sessions: which transcript events of a session contain the query.
 *
 * Only what the transcript shows as conversation is searched — prompts, the
 * agent's text, the identifying fields of a tool call and its result. Thinking,
 * system/stream housekeeping and compaction spans are left out: the first is
 * hidden by default, the rest never render as text a person would look for.
 */

/** Tool-call inputs worth matching: what a card's header shows. */
const TOOL_INPUT_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'path', 'description'];
/** A tool result is often a whole file; past this it is noise, not conversation. */
const TOOL_RESULT_CHARS = 20_000;
const SNIPPET_CHARS = 160;

/** One searchable piece of text and the event it came from. */
export interface SearchableText {
  seq: number;
  text: string;
  /** Set for a tool call's input or result — see SessionSearchHit. */
  toolUseId?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: ContentBlock) => (b?.type === 'text' ? (b.text ?? '') : '')).join('');
  }
  return '';
}

/** The searchable text of a transcript, in event order. Pure, for tests. */
export function searchableTexts(events: TranscriptEvent[]): SearchableText[] {
  const out: SearchableText[] = [];
  // A provider switch's seed prompt is folded into the marker rather than shown
  // as a prompt, so it is not something the user typed and would search for.
  let skipSeed = false;
  for (const event of withoutCompactSpans(events)) {
    if (event.kind === 'provider-switch') {
      skipSeed = true;
      continue;
    }
    if (event.kind === 'user' || event.kind === 'interject') {
      const text = (event.data as { text?: string }).text ?? '';
      if (event.kind === 'user' && skipSeed) skipSeed = false;
      else if (text) out.push({ seq: event.seq, text });
      continue;
    }
    if (event.kind !== 'sdk') continue;
    const msg = event.data as { type?: string; message?: { content?: unknown } };
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    if (msg.type === 'assistant') {
      for (const block of content as ContentBlock[]) {
        if (block.type === 'text' && block.text) {
          out.push({ seq: event.seq, text: block.text });
        } else if (block.type === 'tool_use' && block.id) {
          const input = block.input ?? {};
          for (const field of TOOL_INPUT_FIELDS) {
            const value = input[field];
            if (typeof value === 'string' && value) {
              out.push({ seq: event.seq, text: value, toolUseId: block.id });
            }
          }
        }
      }
    } else if (msg.type === 'user') {
      for (const block of content as ContentBlock[]) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const text = resultText(block.content).slice(0, TOOL_RESULT_CHARS);
        if (text) out.push({ seq: event.seq, text, toolUseId: block.tool_use_id });
      }
    }
  }
  return out;
}

/**
 * Up to `limit` matching lines of one session's transcript, one snippet per
 * matching line. Null when nothing matched.
 */
export function searchSession(
  sessionId: string,
  events: TranscriptEvent[],
  match: LineMatcher,
  limit: number,
): SessionSearchHit | null {
  const matches: SessionSearchHit['matches'] = [];
  for (const piece of searchableTexts(events)) {
    for (const line of piece.text.split('\n')) {
      const ranges = match(line);
      if (!ranges.length) continue;
      const [start, end] = ranges[0];
      // Indentation is trimmed off the snippet, so the offsets shift with it.
      const lead = line.length - line.trimStart().length;
      const text = line.trim();
      const clip = clipAround(
        text,
        Math.max(0, start - lead),
        Math.min(text.length, end - lead),
        SNIPPET_CHARS,
      );
      matches.push({
        seq: piece.seq,
        ...clip,
        ...(piece.toolUseId ? { toolUseId: piece.toolUseId } : {}),
      });
      if (matches.length >= limit) return { sessionId, matches };
    }
  }
  return matches.length ? { sessionId, matches } : null;
}
