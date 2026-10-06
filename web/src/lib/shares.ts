/**
 * Share grants and invites, over HTTP to the storage server.
 *
 * Like devices, and for the same reason: a grant is what decides whether a
 * socket may exist at all, so it cannot travel over one. Only reachable in a
 * hosted deployment — with no VITE_STORAGE_URL there are no machines to share.
 */
import type { SharePreset, ShareProfile } from '@lines/shared';
import { STORAGE_URL, storageCall } from './storage';

/** Sharing needs a storage server to hold the grants; a local install has none. */
export const SHARING_ENABLED = Boolean(STORAGE_URL);

export interface ShareGrant {
  kind: 'machine' | 'session';
  deviceId: string;
  sessionId?: string;
  /** The grantee. */
  userId: string;
  preset: SharePreset | null;
  createdAt: string;
  profile: ShareProfile | null;
}

export interface ShareInvite {
  code: string;
  deviceId: string;
  sessionId: string | null;
  inviteeEmail: string | null;
  preset: SharePreset | null;
  createdAt: string;
  expiresAt: string;
}

export interface ReceivedShare {
  kind: 'machine' | 'session';
  deviceId: string;
  sessionId?: string;
  ownerId: string;
  profile: ShareProfile | null;
}

export interface SharesResponse {
  granted: ShareGrant[];
  invites: ShareInvite[];
  received: ReceivedShare[];
}

export interface InvitePreview {
  code: string;
  scope: 'machine' | 'session';
  machineName: string | null;
  sessionName: string | null;
  owner: ShareProfile | null;
  preset: SharePreset | null;
  isOwn: boolean;
  expiresAt: string;
}

/** One invitation waiting for the signed-in user, found by their verified email. */
export interface PendingInvite {
  code: string;
  scope: 'machine' | 'session';
  machineName: string | null;
  owner: ShareProfile | null;
  preset: SharePreset | null;
  expiresAt: string;
}

/**
 * Invitations addressed to this user, so accepting one never depends on still
 * having the link. Link-only invites are deliberately absent — they are bearer
 * tokens addressed to nobody.
 */
export function pendingInvites(): Promise<{ invites: PendingInvite[] }> {
  return storageCall<{ invites: PendingInvite[] }>('/v1/shares/pending');
}

export function listShares(): Promise<SharesResponse> {
  return storageCall<SharesResponse>('/v1/shares');
}

/**
 * Mint an invite. `inviteeEmail` binds it to one address (claimable only by a
 * *verified* one on the claimer's account); omitted, anyone holding the link may
 * redeem it once.
 */
export function createInvite(body: {
  deviceId: string;
  sessionId?: string | null;
  inviteeEmail?: string | null;
  preset: SharePreset;
  /** The machine's grant id for this invite (never the token), so the machine can drop it once the share is gone. */
  grantId?: string;
}): Promise<{ code: string; expiresAt: string }> {
  return storageCall('/v1/shares/invite', { method: 'POST', body: JSON.stringify(body) });
}

export function invitePreview(code: string): Promise<InvitePreview> {
  return storageCall<InvitePreview>(`/v1/shares/invite/${encodeURIComponent(code)}`);
}

export function claimInvite(code: string): Promise<{
  ok: true;
  deviceId: string;
  sessionId: string | null;
  scope: 'machine' | 'session';
}> {
  return storageCall('/v1/shares/claim', { method: 'POST', body: JSON.stringify({ code }) });
}

/** Narrow or widen a live grant, so access can change without a re-invite. */
export function setGrantPreset(grant: ShareGrant, preset: SharePreset): Promise<{ ok: true }> {
  return storageCall(`/v1/shares/${grant.kind}/${encodeURIComponent(grant.deviceId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ preset, userId: grant.userId, sessionId: grant.sessionId }),
  });
}

export function revokeGrant(grant: ShareGrant): Promise<{ ok: true }> {
  const query = new URLSearchParams({ userId: grant.userId });
  if (grant.sessionId) query.set('sessionId', grant.sessionId);
  return storageCall(
    `/v1/shares/${grant.kind}/${encodeURIComponent(grant.deviceId)}?${query.toString()}`,
    { method: 'DELETE' },
  );
}

/**
 * Give up a machine somebody shared with you.
 *
 * The one revocation a grantee may make, and it reaches exactly their own grants
 * on that machine: every other route here is scoped by ownerId, because a
 * grantee can revoke nothing of anyone else's. The machine itself is untouched —
 * this drops access, not a computer — so the owner can share it again.
 */
export function leaveShare(deviceId: string): Promise<{ ok: true }> {
  return storageCall(`/v1/shares/self/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
}

export function revokeInvite(code: string): Promise<{ ok: true }> {
  return storageCall(`/v1/shares/invite/${encodeURIComponent(code)}`, { method: 'DELETE' });
}

/**
 * Somebody this account has shared with before. Kept server-side rather than
 * derived from the grant list: grants get revoked and invites expire, and that is
 * precisely when you still want the address offered back.
 */
export interface ShareContact {
  /** Lowercased, and the primary key of the row alongside the owner. */
  email: string;
  /** Only known once they have claimed something. */
  name: string | null;
  imageUrl: string | null;
  userId: string | null;
  lastUsedAt: string;
}

export function listContacts(): Promise<{ contacts: ShareContact[] }> {
  return storageCall<{ contacts: ShareContact[] }>('/v1/contacts');
}

/** A real delete — the list only exists to be offered back. */
export function forgetContact(email: string): Promise<{ ok: true }> {
  return storageCall(`/v1/contacts/${encodeURIComponent(email)}`, { method: 'DELETE' });
}

export function clearContacts(): Promise<{ ok: true; count: number }> {
  return storageCall('/v1/contacts', { method: 'DELETE' });
}

/** The link an invite code turns into. Same origin as the app, so it just works. */
export const joinUrl = (code: string): string => `${location.origin}/join/${code}`;

/**
 * The invite link with the machine's grant in its fragment — the token the
 * invitee presents to that machine, the machine key they hold the channel to,
 * and which machine that is. A fragment never reaches a server, so storage
 * (which holds the invite) and the relay (which carries the channel) never see
 * any of it.
 */
export const joinUrlWithGrant = (
  code: string,
  deviceId: string,
  grant: { token: string; bridgeKey: string },
): string =>
  `${joinUrl(code)}#${new URLSearchParams({ grant: grant.token, key: grant.bridgeKey, device: deviceId }).toString()}`;

/** invite code -> the machine grant minted for it, so cancelling the invite can end the grant too. */
const INVITE_GRANTS_KEY = 'lines.inviteGrants';

function readInviteGrants(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(INVITE_GRANTS_KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function rememberInviteGrant(code: string, grantId: string): void {
  localStorage.setItem(INVITE_GRANTS_KEY, JSON.stringify({ ...readInviteGrants(), [code]: grantId }));
}

/** The grant minted for an invite this browser created, forgotten as it is read. */
export function takeInviteGrant(code: string): string | null {
  const grants = readInviteGrants();
  const grantId = grants[code] ?? null;
  delete grants[code];
  localStorage.setItem(INVITE_GRANTS_KEY, JSON.stringify(grants));
  return grantId;
}

/** One line per preset, shown in the overlay. The warning is deliberately separate. */
export const PRESET_COPY: Record<SharePreset, { label: string; detail: string }> = {
  view: { label: 'View only', detail: 'Follow the transcript. Cannot send anything.' },
  prompt: {
    label: 'Can prompt',
    detail: 'Send prompts; you release each one and answer every permission request.',
  },
  collaborator: {
    label: 'Collaborator',
    detail: 'Prompt, stop/retry, approve permissions, change model, drive workflow steps.',
  },
  full: {
    label: 'Full access',
    detail: 'Everything a collaborator can, plus change permission mode, archive, complete and delete sessions.',
  },
};
