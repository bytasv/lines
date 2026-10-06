/**
 * Guest grants this machine issued itself.
 *
 * A relay channel arrives carrying the relay's word about who is calling and
 * what they may do. For the owner that word was retired by the e2ee gate: an
 * owner channel must authenticate with a key this machine pinned. A guest had no
 * key to present, so their admission still rested on the relay's attestation —
 * and whoever controlled the relay could attest a machine-wide, full-access grant
 * for anyone, against any machine it brokered. Remote code execution everywhere.
 *
 * So the host's bridge mints the grant. The owner asks for one over their own
 * encrypted link while creating an invite; the bridge records it here and
 * answers with a random token, which reaches the invitee in the invite link's
 * *fragment* — never sent to any server — together with this machine's public
 * key. The invitee's browser holds its channel to that key, so the relay cannot
 * sit in the middle, and presents the token as its first sealed frame. Only then
 * is a guest admitted, and with at most what the record allows.
 *
 * What the relay still contributes is narrowing: its attestation reflects
 * storage (a revoked share drops the channel within a minute, a narrowed preset
 * narrows here too), and a guest's access is the intersection of the two. The
 * relay can take away; it can no longer give.
 *
 * Kept as a hash, so the file holds nothing anyone could present. 0600, beside
 * the e2ee keys. Injectable, like the signer store, so the policy can be driven
 * from a temp directory in tests rather than from `~/.lines-app`.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NO_SHARE_CAPS, parseShareCaps, type ShareCaps, type SocketAccess } from '@lines/shared';
import { APP_ROOT } from './workerProtocol.ts';

export const GUEST_GRANTS_FILE = path.join(APP_ROOT, 'guest-grants.json');

/**
 * How long an unredeemed grant stays redeemable — the invite's own lifetime
 * (storage expires invites after seven days). Once redeemed it lasts until it is
 * revoked, as the share it backs does.
 */
export const GRANT_CLAIM_TTL_MS = 7 * 24 * 60 * 60_000;

export interface GuestGrantRecord {
  id: string;
  /** sha256 of the token, base64url. The token itself is never stored. */
  tokenHash: string;
  /** Whose context the guest reaches — the host's own user id on this machine. */
  hostUserId: string;
  scope: 'machine' | 'session';
  /** Session grants only: the sessions it reaches. */
  sessionIds?: string[];
  /** The ceiling: what the owner granted when minting it, or last changed it to. */
  caps: ShareCaps;
  /**
   * The account that redeemed it, bound on first use. Null until then. A
   * forwarded link redeemed by a second account is refused, as the invite claim
   * in storage refuses it.
   */
  guestUserId: string | null;
  createdAt: number;
  /** Redeemable until then while unbound; ignored once bound. */
  claimBy: number;
}

export type GuestGrantFile = Record<string, GuestGrantRecord>;

export interface GuestGrantStore {
  load(): GuestGrantFile;
  save(grants: GuestGrantFile): void;
}

export const fileGrantStore: GuestGrantStore = {
  load: () => {
    try {
      const raw = JSON.parse(fs.readFileSync(GUEST_GRANTS_FILE, 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as GuestGrantFile) : {};
    } catch {
      return {};
    }
  },
  save: (grants) => {
    fs.mkdirSync(path.dirname(GUEST_GRANTS_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(GUEST_GRANTS_FILE, JSON.stringify(grants, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(GUEST_GRANTS_FILE, 0o600);
    } catch {
      // best-effort on platforms without POSIX perms
    }
  },
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');

/** Drop unredeemed grants whose link has expired; they can never be redeemed now. */
function live(grants: GuestGrantFile, now: number): GuestGrantFile {
  const out: GuestGrantFile = {};
  for (const [id, g] of Object.entries(grants)) {
    if (g.guestUserId === null && g.claimBy < now) continue;
    out[id] = g;
  }
  return out;
}

/**
 * Record a new grant and return its token — shown once, to the owner's browser,
 * which puts it in the invite link. 256 bits, so a token cannot be guessed, only
 * leaked with the link itself.
 */
export function mintGuestGrant(
  input: { hostUserId: string; scope: 'machine' | 'session'; sessionIds?: string[]; caps: ShareCaps },
  store: GuestGrantStore = fileGrantStore,
  now = Date.now(),
): { id: string; token: string } {
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const grants = live(store.load(), now);
  grants[id] = {
    id,
    tokenHash: hashToken(token),
    hostUserId: input.hostUserId,
    scope: input.scope,
    ...(input.scope === 'session' ? { sessionIds: [...(input.sessionIds ?? [])] } : {}),
    caps: parseShareCaps(input.caps),
    guestUserId: null,
    createdAt: now,
    claimBy: now + GRANT_CLAIM_TTL_MS,
  };
  store.save(grants);
  return { id, token };
}

/**
 * The grant a token redeems for this guest, or null. Binds an unredeemed grant
 * to the first account that presents it.
 *
 * `guestUserId` is the relay's word about who is calling, so binding to it adds
 * nothing against the relay — the token does that, and only the link holder has
 * it. What binding adds is that a forwarded link stops at the first account.
 */
export function redeemGuestGrant(
  token: string,
  guestUserId: string,
  store: GuestGrantStore = fileGrantStore,
  now = Date.now(),
): GuestGrantRecord | null {
  if (typeof token !== 'string' || !token || !guestUserId) return null;
  const hash = hashToken(token);
  const grants = live(store.load(), now);
  const grant = Object.values(grants).find((g) => g.tokenHash === hash);
  if (!grant) return null;
  if (grant.guestUserId === null) {
    grant.guestUserId = guestUserId;
    store.save(grants);
  } else if (grant.guestUserId !== guestUserId) {
    return null;
  }
  return grant;
}

/** Which of a host's grants a match names. `sessionId`: undefined = any scope, null = the machine grant. */
export interface GrantMatch {
  grantId?: string;
  guestUserId?: string;
  sessionId?: string | null;
}

function matches(g: GuestGrantRecord, hostUserId: string, m: GrantMatch): boolean {
  if (g.hostUserId !== hostUserId) return false;
  if (m.grantId !== undefined && g.id !== m.grantId) return false;
  if (m.guestUserId !== undefined && g.guestUserId !== m.guestUserId) return false;
  if (m.sessionId === null && g.scope !== 'machine') return false;
  if (typeof m.sessionId === 'string' && !(g.scope === 'session' && g.sessionIds?.includes(m.sessionId))) {
    return false;
  }
  // A match naming nothing would be every grant the host has — never what is meant.
  return m.grantId !== undefined || m.guestUserId !== undefined;
}

/**
 * Move the ceiling of a host's matching grants (a preset change). Returns the ids
 * that moved, so sockets admitted on them can be closed and come back under it.
 */
export function updateGuestGrants(
  hostUserId: string,
  match: GrantMatch,
  caps: ShareCaps,
  store: GuestGrantStore = fileGrantStore,
  now = Date.now(),
): string[] {
  const grants = live(store.load(), now);
  const moved: string[] = [];
  for (const g of Object.values(grants)) {
    if (!matches(g, hostUserId, match)) continue;
    g.caps = parseShareCaps(caps);
    moved.push(g.id);
  }
  if (moved.length) store.save(grants);
  return moved;
}

/** End a host's matching grants here. Returns what was removed, so live sockets can be closed. */
export function revokeGuestGrants(
  hostUserId: string,
  match: GrantMatch,
  store: GuestGrantStore = fileGrantStore,
  now = Date.now(),
): GuestGrantRecord[] {
  const grants = live(store.load(), now);
  const removed = Object.values(grants).filter((g) => matches(g, hostUserId, match));
  for (const g of removed) delete grants[g.id];
  if (removed.length) store.save(grants);
  return removed;
}

/**
 * How long a freshly minted grant is left alone by reconciliation: the owner's
 * browser mints it, then creates the invite in storage, and a pull landing in
 * between would otherwise find no trace of it and drop it.
 */
export const GRANT_RECONCILE_GRACE_MS = 10 * 60_000;

/**
 * Drop this host's grants that storage no longer lists, and return them.
 *
 * Storage keeps the id of every grant behind a live invite or share (never the
 * token), so a share revoked from a phone while this machine slept, or an invite
 * cancelled from another browser, reaches the grant here on the next pull rather
 * than never. Only ever removes: storage can take a grant away this way, and
 * cannot create or widen one. Grants younger than the grace period are kept.
 */
export function reconcileGuestGrants(
  hostUserId: string,
  liveGrantIds: ReadonlySet<string>,
  store: GuestGrantStore = fileGrantStore,
  now = Date.now(),
  graceMs = GRANT_RECONCILE_GRACE_MS,
): GuestGrantRecord[] {
  const grants = live(store.load(), now);
  const removed = Object.values(grants).filter(
    (g) => g.hostUserId === hostUserId && g.createdAt + graceMs <= now && !liveGrantIds.has(g.id),
  );
  for (const g of removed) delete grants[g.id];
  if (removed.length) store.save(grants);
  return removed;
}

/** The part of a grant that decides what it reaches. */
export type GrantReach = Pick<GuestGrantRecord, 'scope' | 'sessionIds' | 'caps'>;

/**
 * What several grants for one guest add up to — a host may share two sessions
 * with the same person, or a session and then the whole machine. The widest of
 * them: machine scope if any grant has it, otherwise every session any grant
 * names; a capability if any grant gives it. Approval-before-prompting is the
 * one restriction, so it holds only when every grant asks for it. Null for none.
 */
export function combineGrants(grants: GuestGrantRecord[]): GrantReach | null {
  if (!grants.length) return null;
  const caps = { ...NO_SHARE_CAPS };
  for (const key of Object.keys(NO_SHARE_CAPS) as (keyof ShareCaps)[]) {
    const each = grants.map((g) => parseShareCaps(g.caps)[key]);
    caps[key] = key === 'promptNeedsApproval' ? each.every(Boolean) : each.some(Boolean);
  }
  if (grants.some((g) => g.scope === 'machine')) return { scope: 'machine', caps };
  const sessionIds = [...new Set(grants.flatMap((g) => g.sessionIds ?? []))];
  return { scope: 'session', sessionIds, caps };
}

/**
 * What a guest admitted on `grant` may do, given what the relay attests today:
 * the intersection, or null when nothing is left.
 *
 * Every capability must be allowed by both. `promptNeedsApproval` is the one
 * restriction among them, so it holds when either side asks for it. Scope
 * narrows the same way: a session grant on either side means session scope,
 * over only the sessions both name.
 */
export function guestAccessFor(
  grant: GrantReach,
  attested: { scope: string; caps?: Record<string, boolean>; sessionIds?: string[] },
): Pick<SocketAccess, 'scope' | 'caps' | 'sessionIds'> | null {
  if (attested.scope !== 'machine' && attested.scope !== 'session') return null;
  const ceiling = parseShareCaps(grant.caps);
  const relayed = parseShareCaps(attested.caps);
  const caps = { ...NO_SHARE_CAPS };
  for (const key of Object.keys(NO_SHARE_CAPS) as (keyof ShareCaps)[]) {
    caps[key] = key === 'promptNeedsApproval' ? ceiling[key] || relayed[key] : ceiling[key] && relayed[key];
  }
  if (grant.scope === 'machine' && attested.scope === 'machine') return { scope: 'machine', caps };

  const mine = grant.scope === 'session' ? (grant.sessionIds ?? []) : null;
  const theirs = attested.scope === 'session' ? (attested.sessionIds ?? []) : null;
  const sessionIds = mine && theirs ? mine.filter((id) => theirs.includes(id)) : (mine ?? theirs ?? []);
  if (!sessionIds.length) return null;
  // A session share has no folder to create one in, whatever either side says.
  return { scope: 'session', caps: { ...caps, createSessions: false }, sessionIds };
}
