import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

/**
 * `created_at` on `workflows` and `step_versions`, which is the durability half
 * of the feature: the merge has to be earliest-wins (so a peer or an older
 * bridge cannot move a birthday forward or erase it), and a step *lineage's*
 * creation is `min(created_at)` over its version rows rather than any one row's.
 *
 * Opt-in on a scratch Postgres, as `shares.test.ts` and `devices.unpair.test.ts`:
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://… npm test -w storage
 *
 * The scratch database must have the migrations applied
 * (`DATABASE_URL=… DIRECT_URL=… npm run migrate -w storage`) — without
 * `20260908000000_workflow_created_at` every statement here fails on a missing
 * column.
 *
 * The routes themselves are Clerk-authenticated, so they cannot be called from a
 * test process. The statements below are copies of the ones in `src/index.ts`
 * (`PUT /workflows`, `GET /workflows`, `PUT /steps`, `GET /steps`) and exist to
 * pin the *Postgres* semantics: the positional `UNNEST` column order, the `LEAST`
 * merge, the read-time column injection, and the lineage subquery under
 * `?since=`. Change a statement there, change it here.
 */

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

const DB_URL = process.env.STORAGE_TEST_DATABASE_URL;
const skip = DB_URL
  ? false
  : 'set STORAGE_TEST_DATABASE_URL to a scratch Postgres to run the created_at tests';

let prisma: PrismaClient | null = null;
/** Every user id this file writes under, so a scratch database is left as found. */
const users: string[] = [];

const userId = () => {
  const id = `test-created-at-${randomUUID()}`;
  users.push(id);
  return id;
};

type WorkflowBlob = { id: string; published?: boolean; updatedAt?: number; createdAt?: number };
type StepBlob = WorkflowBlob & { version: number };

const updatedAtOf = (data: { updatedAt?: number }): Date =>
  typeof data.updatedAt === 'number' ? new Date(data.updatedAt) : new Date();
const createdAtOf = (data: { createdAt?: number; updatedAt?: number }): Date =>
  typeof data.createdAt === 'number' ? new Date(data.createdAt) : updatedAtOf(data);

async function putWorkflows(user: string, valid: WorkflowBlob[]): Promise<void> {
  await prisma!.$executeRaw`
    INSERT INTO workflows (user_id, id, data, published, updated_at, created_at)
    SELECT ${user}, u.id, u.data::jsonb, u.published, u.updated_at, u.created_at
    FROM UNNEST(
      ${valid.map((wf) => wf.id)}::text[],
      ${valid.map((wf) => JSON.stringify(wf))}::text[],
      ${valid.map((wf) => wf.published === true)}::bool[],
      ${valid.map((wf) => updatedAtOf(wf).toISOString())}::timestamptz[],
      ${valid.map((wf) => createdAtOf(wf).toISOString())}::timestamptz[]
    ) AS u(id, data, published, updated_at, created_at)
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, published = EXCLUDED.published, updated_at = EXCLUDED.updated_at,
          created_at = LEAST(workflows.created_at, EXCLUDED.created_at)`;
}

async function getWorkflows(user: string): Promise<Record<string, unknown>[]> {
  const rows = await prisma!.workflow.findMany({
    where: { userId: user },
    select: { data: true, updatedAt: true, createdAt: true },
  });
  return rows.map((r) => ({ ...(r.data as object), createdAt: r.createdAt.getTime() }));
}

async function putSteps(user: string, valid: StepBlob[]): Promise<void> {
  await prisma!.$executeRaw`
    INSERT INTO step_versions (user_id, id, version, data, published, updated_at, created_at)
    SELECT ${user}, u.id, u.version, u.data::jsonb, u.published, u.updated_at, u.created_at
    FROM UNNEST(
      ${valid.map((s) => s.id)}::text[],
      ${valid.map((s) => s.version)}::int[],
      ${valid.map((s) => JSON.stringify(s))}::text[],
      ${valid.map((s) => s.published !== false)}::bool[],
      ${valid.map((s) => updatedAtOf(s).toISOString())}::timestamptz[],
      ${valid.map((s) => updatedAtOf(s).toISOString())}::timestamptz[]
    ) AS u(id, version, data, published, updated_at, created_at)
    ON CONFLICT (user_id, id, version) DO UPDATE
      SET data = EXCLUDED.data, published = EXCLUDED.published, updated_at = EXCLUDED.updated_at,
          created_at = LEAST(step_versions.created_at, EXCLUDED.created_at)`;
}

async function getSteps(user: string, since?: Date): Promise<Record<string, unknown>[]> {
  const rows = since
    ? await prisma!.$queryRaw<{ data: unknown; updatedAt: Date; createdAt: Date }[]>`
        SELECT DISTINCT ON (sv.user_id, sv.id) sv.data, sv.updated_at AS "updatedAt",
               m.created_at AS "createdAt"
        FROM step_versions sv
        JOIN (
          SELECT user_id, id, min(created_at) AS created_at FROM step_versions
          WHERE user_id = ${user} GROUP BY user_id, id
        ) m ON m.user_id = sv.user_id AND m.id = sv.id
        WHERE sv.user_id = ${user} AND sv.updated_at >= ${since}
        ORDER BY sv.user_id, sv.id, sv.version DESC`
    : await prisma!.$queryRaw<{ data: unknown; updatedAt: Date; createdAt: Date }[]>`
        SELECT DISTINCT ON (sv.user_id, sv.id) sv.data, sv.updated_at AS "updatedAt",
               m.created_at AS "createdAt"
        FROM step_versions sv
        JOIN (
          SELECT user_id, id, min(created_at) AS created_at FROM step_versions
          WHERE user_id = ${user} GROUP BY user_id, id
        ) m ON m.user_id = sv.user_id AND m.id = sv.id
        WHERE sv.user_id = ${user}
        ORDER BY sv.user_id, sv.id, sv.version DESC`;
  return rows.map((r) => ({ ...(r.data as object), createdAt: r.createdAt.getTime() }));
}

/** The stored column, which is the authority the reads derive from. */
async function columns(user: string, id: string) {
  return prisma!.$queryRaw<{ version: number; created_at: Date; updated_at: Date }[]>`
    SELECT version, created_at, updated_at FROM step_versions
    WHERE user_id = ${user} AND id = ${id} ORDER BY version`;
}

const T0 = new Date('2026-01-05T03:07:00.000Z').getTime();
const T1 = T0 + 60_000;
const T2 = T0 + 120_000;

describe('created_at on workflows and step_versions', { skip }, () => {
  before(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  });

  after(async () => {
    if (!prisma) return;
    await prisma.workflow.deleteMany({ where: { userId: { in: users } } });
    await prisma.stepVersion.deleteMany({ where: { userId: { in: users } } });
    await prisma.$disconnect();
  });

  test('a re-push that dropped createdAt leaves the stored value alone', async () => {
    const user = userId();
    await putWorkflows(user, [{ id: 'w1', updatedAt: T0, createdAt: T0 }]);
    // Exactly what an old bridge's bulk re-push looks like: no createdAt at all.
    await putWorkflows(user, [{ id: 'w1', updatedAt: T2 }]);

    const [row] = await prisma!.workflow.findMany({ where: { userId: user, id: 'w1' } });
    assert.equal(row!.createdAt.getTime(), T0);
    assert.equal(row!.updatedAt.getTime(), T2, 'updatedAt is still last-write-wins');
  });

  test('a later createdAt is ignored; an earlier one moves it back', async () => {
    const user = userId();
    await putWorkflows(user, [{ id: 'w1', updatedAt: T1, createdAt: T1 }]);

    await putWorkflows(user, [{ id: 'w1', updatedAt: T2, createdAt: T2 }]);
    let [row] = await prisma!.workflow.findMany({ where: { userId: user, id: 'w1' } });
    assert.equal(row!.createdAt.getTime(), T1, 'creation time never moves forward');

    await putWorkflows(user, [{ id: 'w1', updatedAt: T2, createdAt: T0 }]);
    [row] = await prisma!.workflow.findMany({ where: { userId: user, id: 'w1' } });
    assert.equal(row!.createdAt.getTime(), T0, 'an earlier peer value wins');
  });

  test('the read injects the column into a blob that has no createdAt key', async () => {
    const user = userId();
    await putWorkflows(user, [{ id: 'w1', updatedAt: T0 }]);

    const [read] = await getWorkflows(user);
    assert.equal(read!.createdAt, T0, 'derived from updatedAt, as the migration backfill does');
  });

  test('each version row keeps its own created_at while the read returns the lineage minimum', async () => {
    const user = userId();
    const v1: StepBlob = { id: 's1', version: 1, updatedAt: T0, createdAt: T0 };
    const v2: StepBlob = { id: 's1', version: 2, updatedAt: T2, createdAt: T0 };
    await putSteps(user, [v1]);
    await putSteps(user, [v2]);
    // The bridge re-pushes the whole history on every step change; the blob's
    // createdAt is the lineage's, so it must not collapse the per-row columns.
    await putSteps(user, [v1, v2]);

    assert.deepEqual(
      (await columns(user, 's1')).map((r) => [r.version, r.created_at.getTime()]),
      [
        [1, T0],
        [2, T2],
      ],
    );

    const [head] = await getSteps(user);
    assert.equal(head!.version, 2, 'DISTINCT ON still picks the head');
    assert.equal(head!.createdAt, T0, 'the lineage minimum, not the head row');

    // A delta window that contains only v2 must still report the lineage's birth —
    // a window function partitioned over the filtered rows would answer T2.
    const [delta] = await getSteps(user, new Date(T1));
    assert.equal(delta!.version, 2);
    assert.equal(delta!.createdAt, T0);
  });
});
