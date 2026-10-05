import { send } from '../ws';
import { useStore } from '../store';
import { transcriptHasMore } from './transcriptPage';

/**
 * The one older-history request in flight per session, keyed by its `before`.
 * A reply prepends events, which moves the first seq, so the next request has a
 * different key and passes; a repeat of the same `before` (an effect re-running
 * before its reply landed) is held back. Cleared on disconnect, since a reply on
 * a dead link never comes.
 *
 * Module state rather than a ref so the background driver (SessionView) and the
 * jump/reveal fetches (Transcript) share it and never race each other.
 */
const inFlight = new Map<string, number>();

/** Asks for the events before `before` — one budgeted page, or all of them. */
export function requestTranscriptPage(sessionId: string, before: number, all = false): void {
  if (inFlight.get(sessionId) === before) return;
  const page = all ? { before, all: true } : { before };
  if (send({ type: 'loadTranscript', sessionId, page })) inFlight.set(sessionId, before);
}

/** Everything older than what is cached, in one frame — for a jump or reveal
 *  target in history the background backfill has not reached yet. A no-op once
 *  the history is complete. */
export function requestRest(sessionId: string): void {
  const state = useStore.getState();
  const events = state.transcripts[sessionId];
  if (!events || !transcriptHasMore(events, state.transcriptFloor[sessionId])) return;
  requestTranscriptPage(sessionId, events[0].seq, true);
}

export function clearTranscriptPageInFlight(sessionId: string): void {
  inFlight.delete(sessionId);
}
