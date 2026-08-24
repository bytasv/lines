/**
 * The guest half of the /client gate: may this browser reach a machine it does
 * not own?
 *
 * Its own module so the decision can be tested against every shape of answer
 * storage might give — including the ones that are not answers at all. The
 * socket layer only ever sees "a grant" or "null".
 *
 * Deliberately stricter than `verifyDevice`, which tolerates an unreachable
 * storage to protect an *already-established* device link. This is an initial
 * grant, so every non-answer denies: network error, timeout, non-200, malformed
 * body, a body that says allowed without saying by whom. A storage outage
 * blocking new guest connections is the correct trade.
 */
import type { AttestedGrant } from './protocol.ts';

export interface AuthorizeDeps {
  storageUrl: string;
  /** Presented as x-relay-secret. Without it there is no way to ask, so nothing is granted. */
  sharedSecret: string | undefined;
  timeoutMs?: number;
}

export async function authorizeClient(
  deps: AuthorizeDeps,
  deviceId: string,
  userId: string,
): Promise<AttestedGrant | null> {
  if (!deps.sharedSecret) return null;
  try {
    const res = await fetch(`${deps.storageUrl}/v1/devices/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-secret': deps.sharedSecret },
      body: JSON.stringify({ deviceId, userId }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      allowed?: boolean;
      ownerId?: string;
      scope?: AttestedGrant['scope'];
      caps?: Record<string, boolean>;
      sessionIds?: string[];
      profile?: AttestedGrant['profile'];
      viewer?: AttestedGrant['viewerProfile'];
    };
    // `allowed !== true` rather than falsy: a body that omits the field entirely
    // must deny, not inherit whatever JavaScript considers truthy.
    if (body?.allowed !== true || !body.ownerId || !body.scope) return null;
    // 'owner' never arrives here — the caller took the fast path for the machine's
    // own user — so an owner-shaped answer for someone else is a contradiction.
    if (body.scope !== 'machine' && body.scope !== 'session') return null;
    // A session grant with no sessions reaches nothing. Denied rather than handed
    // to the bridge as an empty allowlist to interpret.
    if (body.scope === 'session' && !body.sessionIds?.length) return null;
    return {
      hostUserId: body.ownerId,
      scope: body.scope,
      caps: body.caps,
      sessionIds: body.sessionIds,
      profile: body.profile ?? null,
      viewerProfile: body.viewer ?? null,
    };
  } catch (err) {
    console.warn('[relay] client authorization failed:', (err as Error).message);
    return null;
  }
}
