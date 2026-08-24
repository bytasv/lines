import type { ShareCaps } from '@lines/shared';
import { useStore } from '../store';

/**
 * What this browser may do on the machine it is connected to.
 *
 * Reads the `access` block the bridge sent on `hello`, which is derived from the
 * same grant the bridge enforces — so the UI hides exactly what would be refused,
 * rather than a hand-maintained second opinion about it. On your own machine
 * `access` is null and everything is permitted.
 *
 * Hiding is never the security boundary: `MESSAGE_AUTHZ` on the bridge is. This
 * only keeps a guest from clicking things that would answer with an error.
 */
export function useCan(cap: keyof ShareCaps): boolean {
  return useStore((s) => !s.access || s.access.caps[cap]);
}

/** True when connected to somebody else's machine. */
export function useIsGuest(): boolean {
  return useStore((s) => s.access !== null);
}

/**
 * Whether this session is one the connection may act on at all. A machine-scope
 * guest sees every session; a session-scoped one sees exactly their list.
 */
export function useInScope(sessionId: string): boolean {
  return useStore(
    (s) => !s.access || s.access.scope === 'machine' || !!s.access.sessionIds?.includes(sessionId),
  );
}

/**
 * Whether *this* user has to connect a Claude account before turns can run.
 *
 * False on somebody else's machine, always. A guest's `hello` reports
 * `loggedIn: false` because the host's Claude account is deliberately withheld —
 * that is "not yours to see", not "you must sign in". Turns there run on the
 * host's token, so offering a guest a sign-in button asks them to fix something
 * they cannot see, do not own, and would not help by changing.
 */
export function useClaudeLoginNeeded(): boolean {
  return useStore((s) => s.auth?.loggedIn === false && s.access === null);
}
