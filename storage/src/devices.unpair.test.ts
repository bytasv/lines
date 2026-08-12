import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

/**
 * `POST /v1/devices/unpair` — the machine's own way out, and the one route that
 * lets a device secret change account state, so its failure modes are the point.
 *
 * Opt-in: this is the only test in the repo that needs a real Postgres, and it
 * writes device rows. It runs against `STORAGE_TEST_DATABASE_URL` and nothing
 * else — deliberately NOT `DATABASE_URL`, which in a checkout points at the
 * deployment's database.
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://… npm test -w storage
 */

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

const DB_URL = process.env.STORAGE_TEST_DATABASE_URL;
const skip = DB_URL
  ? false
  : 'set STORAGE_TEST_DATABASE_URL to a scratch Postgres to run the unpair route tests';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
let prisma: PrismaClient | null = null;
let base = '';
/** Every row this file creates, so a scratch database is left as it was found. */
const created: string[] = [];

/** A port nothing else holds: the storage server logs but does not publish one. */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function until<T>(fn: () => Promise<T | null | undefined>, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

/** A registered, unclaimed machine, as `registerDevice` would leave it. */
async function register(id: string, secret: string): Promise<Response> {
  created.push(id);
  return fetch(`${base}/v1/devices/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, secretHash: sha256(secret), name: 'test-machine', platform: 'darwin' }),
  });
}

/** Claim it, without a Clerk token: `POST /claim` is authenticated, this is setup. */
async function claim(id: string, userId: string): Promise<void> {
  await prisma!.device.update({
    where: { id },
    data: { userId, pairingCode: null, pairingExpiresAt: null },
  });
}

const unpair = (id: string, secret: string) =>
  fetch(`${base}/v1/devices/unpair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, secret }),
  });

describe('POST /v1/devices/unpair', { skip }, () => {
  before(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, DATABASE_URL: DB_URL, DIRECT_URL: DB_URL, PORT: String(port), WEB_ORIGINS: '' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await until(async () => (await fetch(`${base}/health`)).ok || null, 'storage to answer /health');
  });

  after(async () => {
    server?.kill('SIGTERM');
    if (prisma) {
      await prisma.device.deleteMany({ where: { id: { in: created } } });
      await prisma.$disconnect();
    }
    await sleep(200);
  });

  test('the right secret releases the machine', async () => {
    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    await register(id, secret);
    await claim(id, `test-user-${id}`);

    const res = await unpair(id, secret);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    // A tombstone, not a delete: the row survives as an audit trail, and drops out
    // of GET /v1/devices, which filters revokedAt: null.
    const row = await prisma!.device.findUnique({ where: { id } });
    assert.ok(row?.revokedAt, 'revokedAt must be stamped');
    const listed = await prisma!.device.findMany({ where: { userId: row!.userId, revokedAt: null } });
    assert.equal(listed.length, 0, 'the machine must no longer be listed for its owner');
  });

  test('a wrong secret is refused and changes nothing', async () => {
    const id = randomUUID();
    await register(id, 'aa'.repeat(32));
    await claim(id, `test-user-${id}`);

    const res = await unpair(id, 'bb'.repeat(32));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
    const row = await prisma!.device.findUnique({ where: { id } });
    assert.equal(row?.revokedAt, null, 'a failed proof must not touch the row');
    assert.ok(row?.userId, 'nor drop the owner');
  });

  test('an unknown id answers exactly as a wrong secret does', async () => {
    // Identical replies on purpose: a distinct "no such device" would confirm a
    // guessed id had once been real.
    const res = await unpair(randomUUID(), 'cc'.repeat(32));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  });

  test('a never-claimed device is refused too', async () => {
    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    await register(id, secret);

    // Nothing to release, and answering 200 would make this an oracle for which
    // registered ids exist.
    const res = await unpair(id, secret);
    assert.equal(res.status, 403);
    const row = await prisma!.device.findUnique({ where: { id } });
    assert.equal(row?.revokedAt, null);
  });

  test('after unpairing, register issues a fresh code', async () => {
    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    await register(id, secret);
    await claim(id, `test-user-${id}`);

    // While claimed, registration refuses — which is what makes unpair the only
    // way back for a machine whose owner cannot reach the web app.
    assert.equal((await register(id, secret)).status, 409);

    assert.equal((await unpair(id, secret)).status, 200);
    const res = await register(id, secret);
    assert.equal(res.status, 200);
    const { pairingCode } = (await res.json()) as { pairingCode: string };
    assert.match(pairingCode, /^[A-Z2-9]{8}$/);
    // Registration clears both, or the row would go straight back to the account
    // that revoked it — or stay refused by the relay despite having a valid code.
    const row = await prisma!.device.findUnique({ where: { id } });
    assert.equal(row?.userId, null);
    assert.equal(row?.revokedAt, null);
  });
});
