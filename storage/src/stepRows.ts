/**
 * Cross-user step-version reads, split out from the routes so the visibility rule
 * is reachable from a test: `/steps/resolve` is Clerk-authenticated, and minting a
 * real token in a test is not possible.
 *
 * The rule is the one GET /steps/:ownerId/:id/versions already applies: every
 * version of your own steps, and only the published versions of anyone else's.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

/** Ceiling on one /steps/resolve batch, so a malformed client can't ask for everything. */
export const RESOLVE_MAX_REFS = 500;

/** One pinned version, as the bridge asks for it: a `StepRef` with `stepId` sent as `id`. */
export type StepVersionKey = { ownerId: string; id: string; version: number };

/**
 * Types are checked, not just truthiness: these values go straight into a Prisma
 * `where`, which reads an object in place of a string as a filter — `{ "not": "" }`
 * would match every owner — rather than refusing it.
 */
function isKey(ref: unknown): ref is StepVersionKey {
  const r = ref as Partial<Record<keyof StepVersionKey, unknown>> | null;
  return (
    typeof r?.ownerId === 'string' &&
    r.ownerId !== '' &&
    typeof r.id === 'string' &&
    r.id !== '' &&
    Number.isInteger(r.version)
  );
}

/**
 * The `where` for one resolve batch, or null when no ref is well-formed. A foreign
 * ref matches a published row only.
 *
 * A pin is not a grant: the caller writes their own workflows, so a ref names
 * whatever they choose. Owner and step ids ride on every shared row and on every
 * published workflow that pins one, and a version is a small integer to count up.
 */
export function resolveWhere(requester: string, refs: unknown[]): Prisma.StepVersionWhereInput | null {
  const keys = refs.filter(isKey).slice(0, RESOLVE_MAX_REFS);
  if (keys.length === 0) return null;
  return {
    OR: keys.map((k) => ({
      userId: k.ownerId,
      id: k.id,
      version: k.version,
      ...(k.ownerId === requester ? {} : { published: true }),
    })),
  };
}

/**
 * Resolve the exact versions a set of refs pins, as far as `requester` may see them.
 *
 * A ref they may not see is simply absent from the answer, exactly like one that
 * does not exist, so the response never confirms that a private version is there.
 * The bridge already treats an absent ref as unresolved.
 *
 * `ownerId` comes from the row's `user_id`, as on /steps/shared: the blob is not
 * trusted to say who owns it. The bridge files each answer under the owner it
 * names, so a blob claiming the caller would join the caller's own step history
 * there — and be pushed back to storage as theirs.
 */
export async function resolveStepVersions(
  prisma: PrismaClient,
  requester: string,
  refs: unknown[],
): Promise<object[]> {
  const where = resolveWhere(requester, refs);
  if (!where) return [];
  const rows = await prisma.stepVersion.findMany({ where, select: { data: true, userId: true } });
  return rows.map((r) => ({ ...(r.data as object), ownerId: r.userId }));
}
