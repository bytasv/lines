/**
 * The guest half of the /client gate — may this browser reach a machine it does
 * not own? — and the sweep that keeps asking for as long as it is connected.
 *
 * Its own module so both can be tested against every shape of answer storage
 * might give — including the ones that are not answers at all.
 *
 * Which is why there are three outcomes, not two: a grant; `null`, storage
 * saying no (or saying something that grants nothing); and 'unreachable',
 * storage not answering. The gate refuses on both of the last two, and is
 * deliberately stricter than `verifyDevice` in that: an initial grant has no
 * link to protect, so a storage outage blocking new guest connections is the
 * correct trade. The sweep must tell them apart — a guest already connected is
 * closed on a real no, never because storage blinked.
 */
import type { HubRegistry } from './mux.ts';
import type { AttestedGrant } from './protocol.ts';

export interface AuthorizeDeps {
  storageUrl: string;
  /** Presented as x-relay-secret. Without it there is no way to ask, so nothing is granted. */
  sharedSecret: string | undefined;
  timeoutMs?: number;
}

/** A grant, storage's no (`null`), or no answer at all. Never conflate the last two. */
export type ClientAuthorization = AttestedGrant | null | 'unreachable';

export async function authorizeClient(
  deps: AuthorizeDeps,
  deviceId: string,
  userId: string,
): Promise<ClientAuthorization> {
  // Nothing to ask with, so nothing to grant. A no rather than 'unreachable':
  // the secret is fixed for the life of the process, so there is no admitted
  // guest for the sweep to be protecting.
  if (!deps.sharedSecret) return null;
  let res: Response;
  try {
    res = await fetch(`${deps.storageUrl}/v1/devices/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-secret': deps.sharedSecret },
      body: JSON.stringify({ deviceId, userId }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch (err) {
    console.warn('[relay] client authorization failed:', (err as Error).message);
    return 'unreachable';
  }
  // Storage's no is a 200 saying `allowed: false`. Every other status is about the
  // call, not the user — a 5xx or a proxy's 502 is an outage, a 401 or 503 is the
  // relay and storage disagreeing about the shared secret — so none of them is a
  // revoke. The same reading `verifyDevice` gives /verify's statuses.
  if (!res.ok) {
    console.warn(`[relay] client authorization: storage answered ${res.status}`);
    return 'unreachable';
  }
  let body: {
    allowed?: boolean;
    ownerId?: string;
    scope?: AttestedGrant['scope'];
    caps?: Record<string, boolean>;
    sessionIds?: string[];
    profile?: AttestedGrant['profile'];
    viewer?: AttestedGrant['viewerProfile'];
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Not JSON, or cut off mid-read: whatever answered was not storage's API — a
    // proxy's error page served as a 200 — so this is no answer either. The
    // parser's message is left out of the log, since it quotes the body.
    console.warn('[relay] client authorization: storage sent an unreadable answer');
    return 'unreachable';
  }
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
}

/**
 * Re-authorize every live guest channel, and close the ones whose grant is gone
 * or has narrowed.
 *
 * Without this, revoking a share only takes effect at the guest's next reconnect
 * — which for an open tab is never. Owner channels are deliberately not swept:
 * they are covered by the device re-verify, which is the check that a *machine*
 * still belongs to an account.
 *
 * Only an answer closes a channel. 'unreachable' leaves it exactly as it is:
 * treating an outage as a revoke kicks every guest off during a blip — the same
 * asymmetry the device re-verify applies, for the same reason. A revoke landing
 * late is recoverable; a mass disconnect is not.
 */
export async function reauthorizeGuests(
  hubs: Pick<HubRegistry, 'withGuests'>,
  authorize: (deviceId: string, userId: string) => Promise<ClientAuthorization>,
): Promise<void> {
  for (const { deviceId, hub } of hubs.withGuests()) {
    for (const ch of hub.guestChannels()) {
      const fresh = await authorize(deviceId, ch.userId).catch(() => 'unreachable' as const);
      if (fresh === 'unreachable') continue; // could not ask — leave the channel alone
      const narrowed =
        !fresh ||
        fresh.scope !== ch.grant.scope ||
        fresh.hostUserId !== ch.grant.hostUserId ||
        !sameCaps(fresh.caps, ch.grant.caps) ||
        !coversSameSessions(fresh.sessionIds, ch.grant.sessionIds);
      if (!narrowed) continue;
      console.log(`[relay] grant for ${ch.userId} on ${deviceId} changed — closing channel ${ch.id}`);
      // Closed rather than mutated in place: the bridge derived its whole view of
      // this connection from the grant on the `open` frame, so a changed grant has
      // to arrive as a new channel. The browser reconnects and gets the new one.
      hub.dropChannel(ch.id, 'grant changed');
    }
  }
}

const sameCaps = (a?: Record<string, boolean>, b?: Record<string, boolean>): boolean => {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) if ((a?.[key] === true) !== (b?.[key] === true)) return false;
  return true;
};

const coversSameSessions = (a?: string[], b?: string[]): boolean => {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  return left.size === right.size && [...left].every((id) => right.has(id));
};
