import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { listSessions, putSession, putSessions, softDeleteSession, toWire } from './sessionRows.ts';

/**
 * Session deletes are soft, and that is load-bearing rather than tidy.
 *
 * A hard delete leaves peers nothing to adopt: the machine that still holds the row
 * pushes it back on its next sync and the session reappears — the undeletable
 * session. So the tombstone has to survive, has to ride the delta window, and has
 * to refuse a stale push.
 *
 * Opt-in, as devices.unpair.test.ts: this needs a real Postgres and writes rows. It
 * runs against `STORAGE_TEST_DATABASE_URL` and nothing else — deliberately NOT
 * `DATABASE_URL`, which in a checkout points at the deployment's database.
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://… npm test -w storage
 *
 * Driven through sessionRows.ts rather than over HTTP: `/sessions` is
 * Clerk-authenticated and a test cannot mint a session token, so the routes are
 * thin wrappers over exactly these calls.
 */

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

const DB_URL = process.env.STORAGE_TEST_DATABASE_URL;
const skip = DB_URL
  ? false
  : 'set STORAGE_TEST_DATABASE_URL to a scratch Postgres to run the session soft-delete tests';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let prisma: PrismaClient | null = null;
/** Every user this file writes under, so a scratch database is left as it was found. */
const users: string[] = [];

function newUser(): string {
  const id = `test-user-${randomUUID()}`;
  users.push(id);
  return id;
}

/** A minimal SessionMeta — only `id` and `updatedAt` matter to these calls. */
const meta = (id: string, updatedAt: number) => ({
  id,
  name: id,
  cwd: '/tmp',
  model: 'claude-opus-5',
  status: 'idle',
  createdAt: updatedAt,
  updatedAt,
});

const rowOf = (userId: string, id: string) =>
  prisma!.session.findUnique({ where: { userId_id: { userId, id } } });

describe('session soft delete', { skip }, () => {
  before(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  });

  after(async () => {
    if (prisma) {
      await prisma.session.deleteMany({ where: { userId: { in: users } } });
      await prisma.$disconnect();
    }
  });

  test('a delete stamps deletedAt instead of removing the row', async () => {
    const userId = newUser();
    const id = randomUUID();
    await putSessions(prisma!, userId, [meta(id, 1_000)]);

    await softDeleteSession(prisma!, userId, id);
    const row = await rowOf(userId, id);
    assert.ok(row, 'the row survives — a hard delete is what peers cannot learn from');
    assert.ok(row!.deletedAt, 'deletedAt must be stamped');
  });

  test('the tombstone rides the delta window', async () => {
    const userId = newUser();
    const id = randomUUID();
    await putSessions(prisma!, userId, [meta(id, 1_000)]);
    const before = new Date(Date.now() - 1_000);
    await softDeleteSession(prisma!, userId, id);

    // How a peer learns about the delete at all: the row is still served, carrying
    // its tombstone, and `updatedAt` moved so it falls inside the window.
    const wire = toWire(await listSessions(prisma!, userId, before)) as { id: string; deletedAt?: number }[];
    const tombstone = wire.find((r) => r.id === id);
    assert.ok(tombstone, 'a delta pull must see the delete');
    assert.equal(typeof tombstone!.deletedAt, 'number');
  });

  test('a stale push does not resurrect a deleted session', async () => {
    const userId = newUser();
    const id = randomUUID();
    await putSessions(prisma!, userId, [meta(id, 1_000)]);
    await softDeleteSession(prisma!, userId, id);

    // Exactly what a machine that has not pulled the tombstone yet sends.
    await putSessions(prisma!, userId, [meta(id, 1_000)]);
    assert.ok((await rowOf(userId, id))!.deletedAt, 'the row stays deleted');

    // And through the single-row route, which guards by reading rather than in SQL.
    assert.deepEqual(await putSession(prisma!, userId, meta(id, 1_000)), { deleted: true });
    assert.ok((await rowOf(userId, id))!.deletedAt);
  });

  test('a write newer than the delete brings the session back', async () => {
    const userId = newUser();
    const id = randomUUID();
    await putSessions(prisma!, userId, [meta(id, 1_000)]);
    await softDeleteSession(prisma!, userId, id);

    // The tombstone is a floor, not a permanent ban on the id.
    await putSessions(prisma!, userId, [meta(id, Date.now() + 60_000)]);
    assert.equal((await rowOf(userId, id))!.deletedAt, null);
  });

  test('a repeated delete keeps the original stamp', async () => {
    const userId = newUser();
    const id = randomUUID();
    await putSessions(prisma!, userId, [meta(id, 1_000)]);
    await softDeleteSession(prisma!, userId, id);
    const first = (await rowOf(userId, id))!.deletedAt;

    await sleep(20);
    await softDeleteSession(prisma!, userId, id);
    // The bridge retries a delete until storage confirms it; moving the tombstone
    // forward each time would re-notify every peer on every retry.
    assert.deepEqual((await rowOf(userId, id))!.deletedAt, first);
  });

  test('a live session is unaffected by another one being deleted', async () => {
    const userId = newUser();
    const [gone, kept] = [randomUUID(), randomUUID()];
    await putSessions(prisma!, userId, [meta(gone, 1_000), meta(kept, 1_000)]);
    await softDeleteSession(prisma!, userId, gone);

    const wire = toWire(await listSessions(prisma!, userId)) as { id: string; deletedAt?: number }[];
    assert.equal(wire.find((r) => r.id === kept)?.deletedAt, undefined);
    assert.equal(typeof wire.find((r) => r.id === gone)?.deletedAt, 'number');
  });
});
