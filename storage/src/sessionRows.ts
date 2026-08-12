/**
 * Session row persistence, split out from the routes so the soft-delete rules are
 * reachable from a test: `/sessions` is Clerk-authenticated, and minting a real
 * token in a test is not possible — but these are the rules that actually matter.
 *
 * Deletes are soft, and that is load-bearing rather than tidy. A hard delete
 * leaves peers nothing to adopt: the machine that still holds the row pushes it
 * back on its next sync and the session reappears.
 */
import type { PrismaClient } from '@prisma/client';

/** `sessions.id` is a uuid column, so a malformed id would reject a whole batch. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ceiling on one /sessions pull. Sessions are never removed from storage by age,
 * so without this the newest install re-downloads years of metadata. The bridge
 * keeps its own full copy on disk; this only bounds what a *sync* moves.
 */
export const SESSIONS_PAGE_MAX = 500;

/** Client-stamped LWW timestamp from a synced payload, falling back to now. */
function stampOf(data: unknown): Date {
  const ms = (data as { updatedAt?: number } | null)?.updatedAt;
  return typeof ms === 'number' ? new Date(ms) : new Date();
}

/** One row as it goes on the wire: the stored meta, plus `deletedAt` on a tombstone. */
export type SessionRow = { data: unknown; deletedAt: Date | null; updatedAt: Date };

/**
 * A page of this user's sessions, tombstones included.
 *
 * Direction matters with `take`. A full pull wants the newest page (`desc`), and
 * the cursor it hands back is the newest row — everything older is deliberately
 * left behind. A delta pull walks *forward* (`asc`), so when more than a page has
 * changed the cursor lands on the oldest unsent row and the next pull resumes
 * there; newest-first would strand the remainder.
 */
export function listSessions(
  prisma: PrismaClient,
  userId: string,
  since?: Date,
): Promise<SessionRow[]> {
  return prisma.session.findMany({
    where: { userId, ...(since ? { updatedAt: { gte: since } } : {}) },
    select: { data: true, deletedAt: true, updatedAt: true },
    orderBy: { updatedAt: since ? 'asc' : 'desc' },
    take: SESSIONS_PAGE_MAX,
  });
}

/**
 * Soft-deleted rows are served too, carrying `deletedAt` in ms. That is how a peer
 * learns about a delete at all — filtering them out here is exactly what let the
 * machine that still held the row push it straight back.
 */
export function toWire(rows: SessionRow[]): unknown[] {
  return rows.map((r) => (r.deletedAt ? { ...(r.data as object), deletedAt: r.deletedAt.getTime() } : r.data));
}

/**
 * Batched LWW upsert. Returns how many rows were accepted for writing (invalid ids
 * are dropped rather than failing the whole push).
 */
export async function putSessions(
  prisma: PrismaClient,
  userId: string,
  list: { id?: string }[],
): Promise<number> {
  const valid = list.filter((m) => m?.id && UUID_RE.test(m.id));
  if (valid.length === 0) return 0;
  await prisma.$executeRaw`
    INSERT INTO sessions (user_id, id, data, updated_at)
    SELECT ${userId}, u.id::uuid, u.data::jsonb, u.updated_at
    FROM UNNEST(
      ${valid.map((m) => m.id!)}::text[],
      ${valid.map((m) => JSON.stringify(m))}::text[],
      ${valid.map((m) => stampOf(m).toISOString())}::timestamptz[]
    ) AS u(id, data, updated_at)
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, deleted_at = NULL
      -- Resurrect-proof: a peer that has not heard about the delete pushes the row
      -- it still holds, and its stamp predates the tombstone. Only a write that is
      -- genuinely newer than the delete brings the session back (and clears it).
      WHERE sessions.deleted_at IS NULL OR sessions.deleted_at < EXCLUDED.updated_at`;
  return valid.length;
}

/** Single-row upsert, with the same resurrect guard expressed as a read. */
export async function putSession(
  prisma: PrismaClient,
  userId: string,
  meta: { id: string },
): Promise<{ deleted: boolean }> {
  const stamp = stampOf(meta);
  const existing = await prisma.session.findUnique({
    where: { userId_id: { userId, id: meta.id } },
    select: { deletedAt: true },
  });
  if (existing?.deletedAt && existing.deletedAt >= stamp) return { deleted: true };
  await prisma.session.upsert({
    where: { userId_id: { userId, id: meta.id } },
    create: { userId, id: meta.id, data: meta as object, updatedAt: stamp },
    update: { data: meta as object, updatedAt: stamp, deletedAt: null },
    select: { userId: true }, // never return the blob we just sent
  });
  return { deleted: false };
}

/** Stamp the tombstone. A malformed (non-uuid) id is not worth a 500. */
export async function softDeleteSession(
  prisma: PrismaClient,
  userId: string,
  id: string,
): Promise<void> {
  const now = new Date();
  await prisma.session
    .updateMany({
      // `deletedAt: null` makes this idempotent: the bridge retries a delete until
      // storage confirms it, and moving the tombstone forward on every retry would
      // re-notify every peer each time.
      where: { userId, id, deletedAt: null },
      // `updatedAt` moves too, so the tombstone falls inside every peer's next delta
      // window — otherwise nobody would ever pull it.
      data: { deletedAt: now, updatedAt: now },
    })
    .catch(() => undefined);
}
