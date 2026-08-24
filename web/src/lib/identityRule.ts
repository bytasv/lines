import type { Actor, ShareProfile } from '@lines/shared';

/**
 * Attribution, as a pure rule.
 *
 * Deliberately free of React, the store and anything JSX-shaped: mis-attributing
 * a prompt is a confident lie about who ran a command on somebody's machine, so
 * this has to be unit-testable from a plain node test. The hook that feeds it
 * lives in ./identity.
 */

export interface Identity extends PersonMeta {
  userId: string;
  /** Always something renderable — never blank, never "Someone". */
  name: string;
  imageUrl: string | null;
  /** This is the person looking at the screen. */
  self: boolean;
}

/**
 * Colours reserved for *people*, deliberately disjoint from the agent palette
 * above (blue for the main agent, violet for a subagent).
 *
 * A human must never be mistakable for an agent at a glance — that is the whole
 * point of colouring authorship — so no entry here may collide with one there.
 */
const PERSON_COLORS = ['teal', 'grape', 'orange', 'lime', 'pink', 'cyan', 'yellow'] as const;

export interface PersonMeta {
  color: string;
  /** Initial(s) for an avatar with no image. Never empty. */
  initials: string;
}

/**
 * How one person is coloured and initialled, mirroring {@link agentMeta}.
 *
 * Deterministic from the userId so the same person is the same colour in every
 * session, on every reload, without any shared state to keep in step. An unknown
 * or empty id still returns something renderable — as `agentMeta` does for an
 * unmapped subagent type — because a blank avatar reads as a bug.
 */
export function personMeta(userId: string | null | undefined, name?: string | null): PersonMeta {
  const id = (userId ?? '').trim();
  // Sum of char codes: stable, order-independent of nothing, and good enough to
  // spread a handful of collaborators across seven colours.
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) % 9973;
  const label = (name ?? '').trim();
  const initials = label
    ? label
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('') || label[0]!.toUpperCase()
    : id
      ? id.replace(/^user_/, '')[0]!.toUpperCase()
      : '?';
  return { color: PERSON_COLORS[hash % PERSON_COLORS.length], initials };
}

/** The inputs the resolver needs, so the rule itself is pure and testable. */
export interface IdentityContext {
  /** This browser's own Clerk id, or null in no-auth mode. */
  me: string | null;
  myName: string | null;
  /**
   * Your own Clerk avatar. The bridge records an actor for the owner but cannot
   * fill in its name or picture — it has no Clerk lookup for itself — so this is
   * the only source for your own image.
   */
  myImageUrl?: string | null;
  /** The host's profile — present only when we are a guest on their machine. */
  host: ShareProfile | null;
  isGuestView: boolean;
  /**
   * Names learned from presence, by user id. Consulted when the record's own
   * actor carries no name — which is the normal case for anything written before
   * that person's profile was cached, and for the host's own prompts (the bridge
   * has no Clerk lookup for itself).
   */
  profiles?: Record<string, ShareProfile>;
}

/**
 * The rule, extracted from the hook so it can be tested without React or a store.
 *
 * Order matters and is the whole of the logic:
 *   1. resolve what "no actor" means (the session's host — them, or you)
 *   2. an attested profile on the record wins
 *   3. otherwise the host's profile, if this is the host
 *   4. otherwise your own name, if this is you
 *   5. otherwise a shortened user id — never a blank, never "Someone"
 */
export function resolveIdentity(
  ctx: IdentityContext,
  userId: string | null | undefined,
  profile?: ShareProfile | Actor | null,
): Identity {
  const hostId = ctx.isGuestView ? (ctx.host?.userId ?? null) : ctx.me;
  const id = (userId ?? '').trim() || hostId || '';
  const self = !!id && id === ctx.me;

  // Only when it actually carries a label — a row with every field null is no
  // better than having none.
  const attested =
    profile && ('name' in profile || 'email' in profile)
      ? {
          name: profile.name ?? ('email' in profile ? profile.email : null) ?? null,
          imageUrl: profile.imageUrl ?? null,
        }
      : null;
  const asHost = !attested?.name && ctx.host && id === ctx.host.userId ? ctx.host : null;
  // Learned elsewhere in this session — the third source, and what makes a
  // historical prompt resolve once its author shows up in presence.
  const known = !attested?.name && !asHost && id ? ctx.profiles?.[id] : undefined;

  const name =
    attested?.name ??
    asHost?.name ??
    asHost?.email ??
    known?.name ??
    known?.email ??
    (self ? ctx.myName : null) ??
    // Clerk ids are `user_<random>`; the suffix is ugly but honest, and stable, so
    // two mentions of the same person match.
    (id ? `${id.replace(/^user_/, '').slice(0, 8)}…` : 'Unknown');

  const resolvedId = id || 'unknown';
  return {
    userId: resolvedId,
    name,
    imageUrl:
      attested?.imageUrl ??
      asHost?.imageUrl ??
      known?.imageUrl ??
      (self ? (ctx.myImageUrl ?? null) : null),
    self,
    ...personMeta(resolvedId, name),
  };
}

