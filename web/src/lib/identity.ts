import type { Actor, ShareProfile } from '@lines/shared';
import { useStore } from '../store';
import { getOwnerId, getOwnerImageUrl, getOwnerName } from './clerk';
import { resolveIdentity, type Identity, type IdentityContext } from './identityRule';

export type { Identity } from './identityRule';

/**
 * Resolve one user id to something displayable, from the three sources a client
 * actually has: the attested profile on the record, `hello.access.ownerProfile`
 * for the host, and Clerk for yourself.
 *
 * One resolver for every surface — the avatar stack, the prompt bubbles, the
 * sidebar's turn actor and the resolved permission badge — so they can never
 * disagree about who somebody is. The rule itself is in ./identityRule, tested
 * directly; this only supplies it with context.
 */
export function useIdentityResolver(): (
  userId: string | null | undefined,
  profile?: ShareProfile | Actor | null,
) => Identity {
  const host = useStore((s) => s.access?.ownerProfile ?? null);
  const isGuestView = useStore((s) => s.access !== null);
  const profiles = useStore((s) => s.profiles);
  const ctx: IdentityContext = {
    me: getOwnerId(),
    myName: getOwnerName(),
    myImageUrl: getOwnerImageUrl(),
    host,
    isGuestView,
    profiles,
  };
  return (userId, profile) => resolveIdentity(ctx, userId, profile);
}
