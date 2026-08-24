import { useEffect, useRef } from 'react';
import { send } from '../ws';
import { useStore } from '../store';
import { getOwnerId } from './clerk';

/**
 * Tell the host which session this tab is looking at, and whether its composer
 * has focus.
 *
 * Debounced hard, and deliberately not per keystroke: `writeDraft` already fires
 * on every character, and presence must not become one frame per character on top
 * of it. Focus is a boolean that changes on click, not on typing, so a short
 * settle is enough to coalesce a click-through.
 *
 * A heartbeat keeps the entry warm without any user action, so a viewer who is
 * simply reading does not decay out of the list.
 */
const SETTLE_MS = 250;
const HEARTBEAT_MS = 25_000;

export function usePresence(sessionId: string | null, focused: boolean): void {
  // Latest intent, read by both the settle timer and the heartbeat, so the two
  // can never disagree about what is being reported.
  const latest = useRef({ sessionId, focused });
  latest.current = { sessionId, focused };
  const sent = useRef<string>('');

  useEffect(() => {
    const signal = (force: boolean) => {
      const { sessionId: id, focused: hasFocus } = latest.current;
      if (!id) return;
      const key = `${id}:${hasFocus}`;
      // The heartbeat re-sends the same state on purpose; an edge-triggered
      // change sends only when something actually differs.
      if (!force && key === sent.current) return;
      sent.current = key;
      send({ type: 'presence', sessionId: id, viewing: true, focused: hasFocus });
    };

    const settle = setTimeout(() => signal(false), SETTLE_MS);
    const beat = setInterval(() => signal(true), HEARTBEAT_MS);
    return () => {
      clearTimeout(settle);
      clearInterval(beat);
    };
  }, [sessionId, focused]);

  // Leaving the session is an explicit departure rather than something the host
  // has to time out: a stale avatar is worse than none.
  useEffect(() => {
    if (!sessionId) return;
    return () => {
      sent.current = '';
      send({ type: 'presence', sessionId, viewing: false, focused: false });
    };
  }, [sessionId]);
}

/**
 * Everyone watching this session except this tab's own user — the header shows
 * "who else is here", and your own avatar is noise.
 */
export function usePeers(sessionId: string) {
  const viewers = useStore((s) => s.presence[sessionId]);
  if (!viewers) return [];
  // Module-level rather than store state: it comes from Clerk at sign-in and
  // never changes for the life of the tab.
  const me = getOwnerId();
  return viewers.filter((v) => v.userId !== me);
}
