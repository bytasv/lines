/**
 * Grant resolution: who may reach whose machine, and with which capabilities.
 *
 * Kept out of index.ts because one function here — `authorizeDevice` — is the
 * answer the relay acts on when it decides whether a browser may be wired to a
 * machine it does not own. That decision lives in one place on purpose.
 *
 * Everything here fails closed: an absent row, a revoked one, an unclaimed
 * device, or a cap the stored blob does not explicitly set is a denial.
 */
import type { PrismaClient } from '@prisma/client';
import { parseShareCaps, type ShareCaps, type ShareProfile, type ShareScope } from '@lines/shared';

/** What the relay gets back. `allowed: false` carries nothing else, deliberately. */
export type Authorization =
  | { allowed: false }
  | {
      allowed: true;
      /** Whose UserContext the bridge must resolve this connection to. */
      ownerId: string;
      scope: ShareScope;
      caps: ShareCaps;
      /** Session scope only: exactly the sessions this grant covers. */
      sessionIds?: string[];
      /** Display identity of the host, for the guest's UI. */
      profile: ShareProfile | null;
      /**
       * The caller's own identity, for presence and prompt attribution on the
       * host's machine. Resolved here rather than trusted from the client.
       */
      viewer: ShareProfile | null;
    };

/** Every capability, for the owner of the machine. Not a stored row. */
const OWNER_CAPS: ShareCaps = {
  prompt: true,
  promptNeedsApproval: false,
  readFiles: true,
  interrupt: true,
  approvePermissions: true,
  manageWorkflow: true,
  setModel: true,
  setPermissionMode: true,
  createSessions: true,
};

/**
 * ShareCaps as a Prisma JSON input. The interface has no index signature, which
 * Prisma's InputJsonObject requires — spreading is cheaper than casting away the
 * type at every call site.
 */
export const capsJson = (caps: ShareCaps): Record<string, boolean> => ({ ...caps });

export async function profileOf(
  prisma: PrismaClient,
  userId: string,
): Promise<ShareProfile | null> {
  const row = await prisma.userProfile.findUnique({ where: { userId } });
  return row
    ? { userId: row.userId, email: row.email, name: row.name, imageUrl: row.imageUrl }
    : null;
}

/**
 * May `userId` reach `deviceId`, and as what?
 *
 * Order matters: ownership first (it is the common case and the cheapest), then
 * a machine-scope grant, then session-scope. A user holding both a machine grant
 * and session shares gets the machine grant — it is strictly wider.
 */
export async function authorizeDevice(
  prisma: PrismaClient,
  deviceId: string,
  userId: string,
): Promise<Authorization> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { userId: true, revokedAt: true },
  });
  // Unknown, revoked, or never claimed: nobody reaches it, owner included.
  if (!device || device.revokedAt || !device.userId) return { allowed: false };

  if (device.userId === userId) {
    return {
      allowed: true,
      ownerId: userId,
      scope: 'owner',
      caps: OWNER_CAPS,
      profile: await profileOf(prisma, userId),
      viewer: await profileOf(prisma, userId),
    };
  }

  const member = await prisma.deviceMember.findUnique({
    where: { deviceId_userId: { deviceId, userId } },
  });
  if (member && !member.revokedAt) {
    // The grant's own ownerId is denormalized and could in principle drift from
    // Device.userId (a machine re-paired to another account). The device row is
    // the authority on who owns it, so a stale grant is refused rather than
    // pointed at the wrong host.
    if (member.ownerId !== device.userId) return { allowed: false };
    return {
      allowed: true,
      ownerId: device.userId,
      scope: 'machine',
      caps: parseShareCaps(member.caps),
      profile: await profileOf(prisma, device.userId),
      viewer: await profileOf(prisma, userId),
    };
  }

  const shares = await prisma.sessionShare.findMany({
    where: { deviceId, userId, revokedAt: null, ownerId: device.userId },
  });
  if (shares.length === 0) return { allowed: false };

  // Several session shares can carry different presets. The connection gets the
  // intersection — the narrowest of them — and per-session enforcement stays on
  // the bridge, which knows which session a message is for. Widening to the union
  // would hand a view-only session the caps of a collaborator one.
  const caps = shares
    .map((s) => parseShareCaps(s.caps))
    .reduce((a, b) => {
      const out = { ...a };
      for (const key of Object.keys(out) as (keyof ShareCaps)[]) out[key] = a[key] && b[key];
      return out;
    });
  return {
    allowed: true,
    ownerId: device.userId,
    scope: 'session',
    caps,
    sessionIds: shares.map((s) => s.sessionId),
    profile: await profileOf(prisma, device.userId),
    viewer: await profileOf(prisma, userId),
  };
}

/**
 * Tombstone every grant that points at a device, in one transaction with
 * whatever revoked it.
 *
 * A machine leaving an account must not leave live guest grants behind: the
 * device id is re-registerable, so a grant that outlived its device would attach
 * to whoever claims that id next.
 */
export function revokeGrantsForDevice(
  prisma: PrismaClient,
  deviceId: string,
  at: Date = new Date(),
) {
  return [
    prisma.deviceMember.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: at },
    }),
    prisma.sessionShare.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: at },
    }),
    prisma.shareInvite.updateMany({
      where: { deviceId, revokedAt: null, claimedBy: null },
      data: { revokedAt: at },
    }),
  ];
}
