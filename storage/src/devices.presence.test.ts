import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { DEVICE_PRESENCE_TTL_MS, presenceOf } from './presence.ts';

/**
 * `POST /v1/devices/presence` and the freshness gate in front of `Device.online`.
 *
 * The relay is the only writer of that flag, so a relay crash between attach and
 * detach leaves every machine that was up reading online forever — a UI that
 * confidently points at dead machines. `lastSeenAt` freshness is the entire
 * mitigation, which is why it gets a test of its own.
 *
 * The route half is opt-in on a real Postgres, exactly as devices.unpair.test.ts:
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://… npm test -w storage
 */

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

const DB_URL = process.env.STORAGE_TEST_DATABASE_URL;
const skip = DB_URL
  ? false
  : 'set STORAGE_TEST_DATABASE_URL to a scratch Postgres to run the presence route tests';

const RELAY_SECRET = 'presence-test-relay-secret';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
let prisma: PrismaClient | null = null;
let base = '';
/** Every row this file creates, so a scratch database is left as it was found. */
const created: string[] = [];

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

/** A registered, claimed machine — what the relay would be reporting about. */
async function paired(id: string): Promise<void> {
  created.push(id);
  await fetch(`${base}/v1/devices/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      secretHash: sha256(randomBytes(32).toString('hex')),
      name: 'test-machine',
      platform: 'darwin',
    }),
  });
  await prisma!.device.update({
    where: { id },
    data: { userId: `test-user-${id}`, pairingCode: null, pairingExpiresAt: null },
  });
}

const presence = (body: unknown, secret: string | null) =>
  fetch(`${base}/v1/devices/presence`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-relay-secret': secret } : {}),
    },
    body: JSON.stringify(body),
  });

/**
 * The relay-crash case, and the reason `online` is never returned raw. No
 * database needed: this is the whole of the gate `GET /v1/devices` applies.
 */
describe('presenceOf', () => {
  test('a fresh online flag is believed', () => {
    assert.equal(presenceOf({ online: true, lastSeenAt: new Date(1_000_000) }, 1_000_000), true);
  });

  test('a stale online flag is not — the relay may have died holding it true', () => {
    const seen = new Date(1_000_000);
    const now = 1_000_000 + DEVICE_PRESENCE_TTL_MS + 1;
    assert.equal(presenceOf({ online: true, lastSeenAt: seen }, now), false);
  });

  test('offline stays offline however fresh', () => {
    assert.equal(presenceOf({ online: false, lastSeenAt: new Date(1_000_000) }, 1_000_000), false);
  });

  test('a machine that has never been seen makes no claim', () => {
    assert.equal(presenceOf({ online: true, lastSeenAt: null }), false);
  });
});

describe('POST /v1/devices/presence', { skip }, () => {
  before(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        DATABASE_URL: DB_URL,
        DIRECT_URL: DB_URL,
        PORT: String(port),
        WEB_ORIGINS: '',
        RELAY_SHARED_SECRET: RELAY_SECRET,
      },
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

  test('the relay secret is required', async () => {
    const id = randomUUID();
    await paired(id);

    assert.equal((await presence({ deviceId: id, online: true }, null)).status, 401);
    assert.equal((await presence({ deviceId: id, online: true }, 'wrong-secret')).status, 401);

    const row = await prisma!.device.findUnique({ where: { id } });
    assert.equal(row?.online, false, 'a refused report must not touch the row');
  });

  test('attach and detach flip the flag and stamp lastSeenAt', async () => {
    const id = randomUUID();
    await paired(id);

    assert.equal((await presence({ deviceId: id, online: true }, RELAY_SECRET)).status, 200);
    const up = await prisma!.device.findUnique({ where: { id } });
    assert.equal(up?.online, true);
    assert.ok(up?.lastSeenAt, 'an attach is contact — it must stamp lastSeenAt');

    assert.equal((await presence({ deviceId: id, online: false }, RELAY_SECRET)).status, 200);
    const down = await prisma!.device.findUnique({ where: { id } });
    assert.equal(down?.online, false);
    // Stamped on detach too, so "last seen 2h ago" is the truth once the flag
    // stops claiming anything.
    assert.ok(down!.lastSeenAt!.getTime() >= up!.lastSeenAt!.getTime());
  });

  test('a report about a revoked machine changes nothing', async () => {
    const id = randomUUID();
    await paired(id);
    await prisma!.device.update({ where: { id }, data: { revokedAt: new Date() } });

    assert.equal((await presence({ deviceId: id, online: true }, RELAY_SECRET)).status, 404);
    const row = await prisma!.device.findUnique({ where: { id } });
    assert.equal(row?.online, false, 'a tombstoned row must never be resurrected by a presence report');
  });

  test('a malformed report is refused', async () => {
    const id = randomUUID();
    await paired(id);
    assert.equal((await presence({ deviceId: id }, RELAY_SECRET)).status, 400);
    assert.equal((await presence({ online: true }, RELAY_SECRET)).status, 400);
  });

  test('a stale row reads offline however the flag was left', async () => {
    const id = randomUUID();
    await paired(id);
    await presence({ deviceId: id, online: true }, RELAY_SECRET);
    // The relay-crash shape: online true, and nothing has re-verified since.
    await prisma!.device.update({
      where: { id },
      data: { lastSeenAt: new Date(Date.now() - DEVICE_PRESENCE_TTL_MS - 60_000) },
    });

    // GET /v1/devices is Clerk-authenticated, so the gate itself is asserted
    // against the row the route would read — the same call it makes.
    const row = await prisma!.device.findUnique({
      where: { id },
      select: { online: true, lastSeenAt: true },
    });
    assert.equal(row!.online, true, 'the raw flag is still set — that is the trap');
    assert.equal(presenceOf(row!), false, 'and must never be reported as online');
  });
});
