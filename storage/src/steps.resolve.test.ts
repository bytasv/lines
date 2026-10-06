import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { RESOLVE_MAX_REFS, resolveStepVersions, resolveWhere } from './stepRows.ts';

/**
 * `POST /steps/resolve` — how a bridge recovers the exact step versions its
 * workflows pin, other users' steps included. It used to answer any
 * `{ ownerId, id, version }` to any signed-in user, so a private version was one
 * counted-up version number away from anyone who had seen its step's id. The
 * negative cases carry the weight: another user's private version must come back
 * exactly as a missing one does.
 *
 * Unpublishing is a revocation, so a pin to a version that has since gone
 * private stops resolving for everyone but its owner. The bridge treats that as
 * any other unresolved pin.
 *
 * The query-shape tests need nothing and always run. The rest are opt-in on a
 * scratch Postgres, as sessions.softDelete.test.ts:
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://… npm test -w storage
 *
 * Driven through stepRows.ts rather than over HTTP: the route is
 * Clerk-authenticated and a test cannot mint a session token, so it is a thin
 * wrapper over exactly this call.
 */

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

const DB_URL = process.env.STORAGE_TEST_DATABASE_URL;
const skip = DB_URL
  ? false
  : 'set STORAGE_TEST_DATABASE_URL to a scratch Postgres to run the step resolve tests';

// ---------------------------------------------------------------------------
// Query shape — pure, and the only half that runs in CI
// ---------------------------------------------------------------------------

describe('resolveWhere', () => {
  test("another user's ref matches a published row only", () => {
    assert.deepEqual(resolveWhere('me', [{ ownerId: 'them', id: 's1', version: 2 }]), {
      OR: [{ userId: 'them', id: 's1', version: 2, published: true }],
    });
  });

  test("the caller's own ref matches the row whatever its flag", () => {
    assert.deepEqual(resolveWhere('me', [{ ownerId: 'me', id: 's1', version: 2 }]), {
      OR: [{ userId: 'me', id: 's1', version: 2 }],
    });
  });

  test('a malformed ref never reaches the query', () => {
    // The objects are the load-bearing cases: Prisma reads `{ not: '' }` as a
    // filter, so letting one through would match every owner (or every id) at once.
    const malformed = [
      null,
      'junk',
      { ownerId: { not: '' }, id: 's1', version: 1 },
      { ownerId: 'them', id: { not: '' }, version: 1 },
      { ownerId: 'them', id: 's1', version: { gte: 0 } },
      { ownerId: 'them', id: 's1', version: '1' },
      { ownerId: 'them', id: 's1', version: 1.5 },
      { ownerId: '', id: 's1', version: 1 },
      { id: 's1', version: 1 },
    ];
    assert.equal(resolveWhere('me', malformed), null);
    assert.deepEqual(resolveWhere('me', [...malformed, { ownerId: 'me', id: 's1', version: 1 }]), {
      OR: [{ userId: 'me', id: 's1', version: 1 }],
    });
  });

  test('a batch is capped', () => {
    const refs = Array.from({ length: RESOLVE_MAX_REFS + 10 }, (_, i) => ({ ownerId: 'them', id: `s${i}`, version: 1 }));
    assert.equal(resolveWhere('me', refs)?.OR?.length, RESOLVE_MAX_REFS);
  });
});

// ---------------------------------------------------------------------------
// Resolution — against a real database
// ---------------------------------------------------------------------------

type StepBlob = { id: string; version: number; ownerId: string };

let prisma: PrismaClient | null = null;
/** Every user this file writes under, so a scratch database is left as it was found. */
const users: string[] = [];

function newUser(): string {
  const id = `test-user-${randomUUID()}`;
  users.push(id);
  return id;
}

/** One version row as PUT /steps leaves it. `claimedOwner` is what the blob says. */
async function putVersion(userId: string, id: string, version: number, published: boolean, claimedOwner = userId) {
  await prisma!.stepVersion.create({
    data: { userId, id, version, published, data: { id, version, published, ownerId: claimedOwner, name: id } },
  });
}

/** Resolved keys, sorted, so a batch compares regardless of row order. */
async function resolved(requester: string, refs: unknown[]): Promise<string[]> {
  const rows = (await resolveStepVersions(prisma!, requester, refs)) as StepBlob[];
  return rows.map((r) => `${r.ownerId}/${r.id}/${r.version}`).sort();
}

describe('step version resolve', { skip }, () => {
  before(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  });

  after(async () => {
    if (prisma) {
      await prisma.stepVersion.deleteMany({ where: { userId: { in: users } } });
      await prisma.$disconnect();
    }
  });

  test("another user's private version comes back exactly as a missing one does", async () => {
    const [owner, stranger] = [newUser(), newUser()];
    const id = randomUUID();
    await putVersion(owner, id, 1, false);

    assert.deepEqual(await resolved(stranger, [{ ownerId: owner, id, version: 1 }]), []);
    // A version that was never written: the same empty answer, so the response
    // cannot confirm that the private one exists.
    assert.deepEqual(await resolved(stranger, [{ ownerId: owner, id, version: 2 }]), []);
  });

  test("another user's published version resolves", async () => {
    const [owner, stranger] = [newUser(), newUser()];
    const id = randomUUID();
    await putVersion(owner, id, 1, true);

    assert.deepEqual(await resolved(stranger, [{ ownerId: owner, id, version: 1 }]), [`${owner}/${id}/1`]);
  });

  test('the owner resolves their own private version', async () => {
    const owner = newUser();
    const id = randomUUID();
    await putVersion(owner, id, 1, false);

    assert.deepEqual(await resolved(owner, [{ ownerId: owner, id, version: 1 }]), [`${owner}/${id}/1`]);
  });

  test('a mixed batch answers only what the caller may see', async () => {
    const [owner, caller] = [newUser(), newUser()];
    const [shared, own] = [randomUUID(), randomUUID()];
    // A private draft saved after a publish: the step's id is already public from
    // the library, which is what made its other versions guessable.
    await putVersion(owner, shared, 1, true);
    await putVersion(owner, shared, 2, false);
    await putVersion(caller, own, 1, false);

    const answer = await resolved(caller, [
      { ownerId: owner, id: shared, version: 1 },
      { ownerId: owner, id: shared, version: 2 },
      { ownerId: caller, id: own, version: 1 },
    ]);
    assert.deepEqual(answer, [`${caller}/${own}/1`, `${owner}/${shared}/1`].sort());
  });

  test('unpublishing hides a version from everyone but its owner', async () => {
    const [owner, stranger] = [newUser(), newUser()];
    const id = randomUUID();
    await putVersion(owner, id, 1, true);
    const ref = { ownerId: owner, id, version: 1 };
    assert.equal((await resolved(stranger, [ref])).length, 1);

    // What DELETE /steps/:id does: every version's flag off, the rows kept.
    await prisma!.stepVersion.updateMany({ where: { userId: owner, id }, data: { published: false } });
    assert.deepEqual(await resolved(stranger, [ref]), []);
    assert.deepEqual(await resolved(owner, [ref]), [`${owner}/${id}/1`], 'the owner still resolves it');
  });

  test("ownerId is the row's, whatever the blob claims", async () => {
    const [owner, victim] = [newUser(), newUser()];
    const id = randomUUID();
    // A published blob claiming to be the victim's: answered as-is, the victim's
    // bridge would file it under their own id and push it back as theirs.
    await putVersion(owner, id, 1, true, victim);

    assert.deepEqual(await resolved(victim, [{ ownerId: owner, id, version: 1 }]), [`${owner}/${id}/1`]);
  });
});
