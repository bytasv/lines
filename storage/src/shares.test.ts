import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { capsForPreset, parseShareCaps, presetOfCaps, type ShareCaps } from '@lines/shared';
import {
  authorizeDevice,
  capsJson,
  forgetShareContact,
  normalizeEmail,
  recordShareContact,
  revokeGrantsForDevice,
  revokeGrantsForGrantee,
} from './shares.ts';

/**
 * The grant model, and `authorizeDevice` in particular — the answer the relay
 * acts on when it decides whether a browser may be wired to a machine it does
 * not own. A regression here is one signed-in user reaching another's computer,
 * so the negative cases carry the weight: revoked, drifted, unknown, unclaimed.
 *
 * The cap tests need nothing and always run. The grant tests are opt-in on a
 * scratch Postgres, as devices.unpair.test.ts:
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://… npm test -w storage
 */

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

const DB_URL = process.env.STORAGE_TEST_DATABASE_URL;
const skip = DB_URL
  ? false
  : 'set STORAGE_TEST_DATABASE_URL to a scratch Postgres to run the grant tests';

const RELAY_SECRET = 'shares-test-relay-secret';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Capabilities — pure, and the fail-closed property is the point
// ---------------------------------------------------------------------------

describe('share capabilities', () => {
  test('an unreadable caps blob grants nothing', () => {
    for (const blob of [null, undefined, {}, 'collaborator', 42, [], { prompt: 'yes' }]) {
      const caps = parseShareCaps(blob);
      assert.equal(
        Object.values(caps).some(Boolean),
        false,
        `${JSON.stringify(blob)} must parse to no capabilities at all`,
      );
    }
  });

  test('only an explicit boolean true grants a capability', () => {
    // The load-bearing case: a truthy-but-not-true value (a string, a 1) must not
    // widen a grant, because caps arrive as untyped JSON from the database.
    const caps = parseShareCaps({ prompt: true, approvePermissions: 'true', interrupt: 1 });
    assert.equal(caps.prompt, true);
    assert.equal(caps.approvePermissions, false);
    assert.equal(caps.interrupt, false);
  });

  test('a capability added later defaults to denied on an old grant', () => {
    // Simulates a row written before `manageWorkflow` existed: the key is simply
    // absent, and must not be inherited from a permissive default.
    const stored = { prompt: true, readFiles: true };
    assert.equal(parseShareCaps(stored).manageWorkflow, false);
  });

  test('view only can read and nothing else', () => {
    const caps = capsForPreset('view', 'session');
    assert.equal(caps.readFiles, true);
    assert.equal(caps.prompt, false);
    assert.equal(caps.approvePermissions, false);
  });

  test('can prompt queues for the owner rather than running straight through', () => {
    const caps = capsForPreset('prompt', 'session');
    assert.equal(caps.prompt, true);
    assert.equal(caps.promptNeedsApproval, true);
    assert.equal(caps.approvePermissions, false, 'the owner still answers every permission');
    assert.equal(caps.interrupt, false);
  });

  test('no preset ever grants setPermissionMode', () => {
    // Permission mode is the guard around everything else — a guest raising it
    // would widen every other capability they hold.
    for (const preset of ['view', 'prompt', 'collaborator'] as const) {
      for (const scope of ['machine', 'session'] as const) {
        assert.equal(
          capsForPreset(preset, scope).setPermissionMode,
          false,
          `${preset}/${scope} must not grant setPermissionMode`,
        );
      }
    }
  });

  test('createSessions is machine-scope collaborator only', () => {
    assert.equal(capsForPreset('collaborator', 'machine').createSessions, true);
    assert.equal(capsForPreset('collaborator', 'session').createSessions, false);
    assert.equal(capsForPreset('prompt', 'machine').createSessions, false);
  });

  test('a stored cap set reads back as the preset it was minted from', () => {
    for (const preset of ['view', 'prompt', 'collaborator'] as const) {
      for (const scope of ['machine', 'session'] as const) {
        const caps = parseShareCaps(capsForPreset(preset, scope) as unknown);
        assert.equal(presetOfCaps(caps, scope), preset);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Address normalization — one function, because two would drift
// ---------------------------------------------------------------------------

describe('normalizeEmail', () => {
  test('trims and lowercases, so case can never split one person into two', () => {
    assert.equal(normalizeEmail('  Vy@Example.COM '), 'vy@example.com');
    assert.equal(normalizeEmail('vy@example.com'), 'vy@example.com');
  });

  test('nothing at all is null, never an empty string', () => {
    // A `''` contact row would be a permanent empty suggestion, and a `''`
    // inviteeEmail would be an invite bound to an address nobody can hold.
    for (const blank of ['', '   ', null, undefined]) {
      assert.equal(normalizeEmail(blank), null);
    }
  });
});

// ---------------------------------------------------------------------------
// Grants — the relay's oracle, against a real database
// ---------------------------------------------------------------------------

let prisma: PrismaClient | null = null;
let server: ChildProcess | null = null;
let base = '';
const devices: string[] = [];
const users: string[] = [];

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

/** A machine owned by `ownerId`, as pairing would leave it. */
async function machine(ownerId: string, secret = randomBytes(32).toString('hex')): Promise<string> {
  const id = randomUUID();
  devices.push(id);
  await prisma!.device.create({
    data: { id, userId: ownerId, name: 'test-machine', secretHash: sha256(secret) },
  });
  return id;
}

const user = () => {
  const id = `test-user-${randomUUID()}`;
  users.push(id);
  return id;
};

describe('grants', { skip }, () => {
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
      await prisma.deviceMember.deleteMany({ where: { deviceId: { in: devices } } });
      await prisma.sessionShare.deleteMany({ where: { deviceId: { in: devices } } });
      await prisma.shareInvite.deleteMany({ where: { deviceId: { in: devices } } });
      await prisma.userProfile.deleteMany({ where: { userId: { in: users } } });
      await prisma.shareContact.deleteMany({ where: { ownerId: { in: users } } });
      await prisma.device.deleteMany({ where: { id: { in: devices } } });
      await prisma.$disconnect();
    }
    await sleep(200);
  });

  test('the owner is allowed, with everything', async () => {
    const owner = user();
    const id = await machine(owner);
    const auth = await authorizeDevice(prisma!, id, owner);
    assert.equal(auth.allowed, true);
    assert.equal(auth.allowed && auth.scope, 'owner');
    assert.equal(auth.allowed && auth.ownerId, owner);
  });

  test('a stranger is denied, and told nothing', async () => {
    const id = await machine(user());
    const auth = await authorizeDevice(prisma!, id, user());
    // The whole payload, asserted: a denial must not leak the owner or the scope.
    assert.deepEqual(auth, { allowed: false });
  });

  test('an unknown device id is denied', async () => {
    assert.deepEqual(await authorizeDevice(prisma!, randomUUID(), user()), { allowed: false });
  });

  test('a revoked machine is denied even to its owner', async () => {
    const owner = user();
    const id = await machine(owner);
    await prisma!.device.update({ where: { id }, data: { revokedAt: new Date() } });
    assert.deepEqual(await authorizeDevice(prisma!, id, owner), { allowed: false });
  });

  test('an unclaimed machine is denied', async () => {
    const id = randomUUID();
    devices.push(id);
    await prisma!.device.create({
      data: { id, name: 'unclaimed', secretHash: sha256('x'), userId: null },
    });
    assert.deepEqual(await authorizeDevice(prisma!, id, user()), { allowed: false });
  });

  test('a machine member gets machine scope and their stored caps', async () => {
    const owner = user();
    const guest = user();
    const id = await machine(owner);
    await prisma!.deviceMember.create({
      data: { deviceId: id, userId: guest, ownerId: owner, caps: capsJson(capsForPreset('prompt', 'machine')) },
    });
    const auth = await authorizeDevice(prisma!, id, guest);
    assert.equal(auth.allowed, true);
    assert.equal(auth.allowed && auth.scope, 'machine');
    // The host's context, not the guest's — this is what the bridge resolves to.
    assert.equal(auth.allowed && auth.ownerId, owner);
    assert.equal(auth.allowed && auth.caps.prompt, true);
    assert.equal(auth.allowed && auth.caps.approvePermissions, false);
  });

  test('a revoked member is denied', async () => {
    const owner = user();
    const guest = user();
    const id = await machine(owner);
    await prisma!.deviceMember.create({
      data: {
        deviceId: id,
        userId: guest,
        ownerId: owner,
        caps: capsJson(capsForPreset('collaborator', 'machine')),
        revokedAt: new Date(),
      },
    });
    assert.deepEqual(await authorizeDevice(prisma!, id, guest), { allowed: false });
  });

  test('a grant left over from a previous owner is refused', async () => {
    // The machine was unpaired and claimed by someone else. The device row is the
    // authority on ownership, so the stale grant must not point at the new owner.
    const previousOwner = user();
    const newOwner = user();
    const guest = user();
    const id = await machine(newOwner);
    await prisma!.deviceMember.create({
      data: {
        deviceId: id,
        userId: guest,
        ownerId: previousOwner,
        caps: capsJson(capsForPreset('collaborator', 'machine')),
      },
    });
    assert.deepEqual(await authorizeDevice(prisma!, id, guest), { allowed: false });
  });

  test('a session share carries exactly its sessions', async () => {
    const owner = user();
    const guest = user();
    const id = await machine(owner);
    const mine = randomUUID();
    const notMine = randomUUID();
    await prisma!.sessionShare.create({
      data: {
        deviceId: id,
        userId: guest,
        sessionId: mine,
        ownerId: owner,
        caps: capsJson(capsForPreset('view', 'session')),
      },
    });
    const auth = await authorizeDevice(prisma!, id, guest);
    assert.equal(auth.allowed && auth.scope, 'session');
    assert.deepEqual(auth.allowed && auth.sessionIds, [mine]);
    assert.equal(
      auth.allowed && auth.sessionIds?.includes(notMine),
      false,
      'a sibling session on the same machine must not come along',
    );
  });

  test('two session shares of different presets intersect to the narrower', async () => {
    // Widening to the union would hand a view-only session the capabilities of a
    // collaborator one on the same machine.
    const owner = user();
    const guest = user();
    const id = await machine(owner);
    for (const [sessionId, preset] of [
      [randomUUID(), 'collaborator'],
      [randomUUID(), 'view'],
    ] as const) {
      await prisma!.sessionShare.create({
        data: { deviceId: id, userId: guest, sessionId, ownerId: owner, caps: capsJson(capsForPreset(preset, 'session')) },
      });
    }
    const auth = await authorizeDevice(prisma!, id, guest);
    assert.equal(auth.allowed, true);
    const caps = (auth.allowed && auth.caps) as ShareCaps;
    assert.equal(caps.approvePermissions, false, 'the narrower grant wins');
    assert.equal(caps.prompt, false);
    assert.equal(caps.readFiles, true, 'what both grants agree on survives');
  });

  test('a machine grant outranks a session share on the same machine', async () => {
    const owner = user();
    const guest = user();
    const id = await machine(owner);
    await prisma!.sessionShare.create({
      data: {
        deviceId: id,
        userId: guest,
        sessionId: randomUUID(),
        ownerId: owner,
        caps: capsJson(capsForPreset('view', 'session')),
      },
    });
    await prisma!.deviceMember.create({
      data: { deviceId: id, userId: guest, ownerId: owner, caps: capsJson(capsForPreset('collaborator', 'machine')) },
    });
    const auth = await authorizeDevice(prisma!, id, guest);
    assert.equal(auth.allowed && auth.scope, 'machine');
    assert.equal(auth.allowed && auth.sessionIds, undefined, 'machine scope is not session-limited');
  });

  test('unpairing a machine takes every grant on it with it', async () => {
    // Device ids are re-registerable, so a grant that outlived its device would
    // attach to whoever claims that id next.
    const owner = user();
    const guest = user();
    const secret = randomBytes(32).toString('hex');
    const id = await machine(owner, secret);
    await prisma!.deviceMember.create({
      data: { deviceId: id, userId: guest, ownerId: owner, caps: capsJson(capsForPreset('collaborator', 'machine')) },
    });
    await prisma!.sessionShare.create({
      data: {
        deviceId: id,
        userId: guest,
        sessionId: randomUUID(),
        ownerId: owner,
        caps: capsJson(capsForPreset('view', 'session')),
      },
    });

    const res = await fetch(`${base}/v1/devices/unpair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, secret }),
    });
    assert.equal(res.status, 200);

    assert.deepEqual(await authorizeDevice(prisma!, id, guest), { allowed: false });
    const member = await prisma!.deviceMember.findUnique({
      where: { deviceId_userId: { deviceId: id, userId: guest } },
    });
    assert.ok(member?.revokedAt, 'the grant must be tombstoned, not left live');
  });

  /**
   * A guest walking away from a machine shared with them — the one revocation a
   * grantee may make. Driven through `revokeGrantsForGrantee` rather than the
   * route, like the unpair case above, because DELETE /v1/shares/self/:id is
   * behind Clerk auth this suite holds no token for; the route does nothing but
   * run this in a transaction and count the rows it touched.
   */
  test('leaving a shared machine ends that guest’s access and nobody else’s', async () => {
    const owner = user();
    const leaver = user();
    const stays = user();
    const id = await machine(owner);
    for (const guest of [leaver, stays]) {
      await prisma!.deviceMember.create({
        data: {
          deviceId: id,
          userId: guest,
          ownerId: owner,
          caps: capsJson(capsForPreset('collaborator', 'machine')),
        },
      });
      await prisma!.sessionShare.create({
        data: {
          deviceId: id,
          userId: guest,
          sessionId: randomUUID(),
          ownerId: owner,
          caps: capsJson(capsForPreset('view', 'session')),
        },
      });
    }

    const counts = await prisma!.$transaction(revokeGrantsForGrantee(prisma!, id, leaver));
    assert.ok(
      counts.reduce((n, { count }) => n + count, 0) > 0,
      'a live grant must be found, or the route would answer 404',
    );

    assert.deepEqual(await authorizeDevice(prisma!, id, leaver), { allowed: false });
    // The blast radius is the whole point: device-scoped revocation here would
    // have taken every other guest with it.
    assert.equal((await authorizeDevice(prisma!, id, stays)).allowed, true);
    // A grant went away, not a machine — the owner can share it again.
    const device = await prisma!.device.findUnique({ where: { id } });
    assert.ok(device && !device.revokedAt, 'the device row must survive a guest leaving');
    assert.equal((await authorizeDevice(prisma!, id, owner)).allowed, true);
    const member = await prisma!.deviceMember.findUnique({
      where: { deviceId_userId: { deviceId: id, userId: leaver } },
    });
    assert.ok(member?.revokedAt, 'tombstoned, never deleted, like every revocation here');
  });

  test('leaving a machine you hold no grant on matches nothing', async () => {
    // Nothing to revoke is what the route turns into a 404 — a stranger learns
    // nothing about whether the machine exists.
    const id = await machine(user());
    const counts = await prisma!.$transaction(revokeGrantsForGrantee(prisma!, id, user()));
    assert.equal(counts.reduce((n, { count }) => n + count, 0), 0);
  });

  test('/v1/devices/authorize is refused without the relay secret', async () => {
    const owner = user();
    const id = await machine(owner);
    const call = (secret: string | null) =>
      fetch(`${base}/v1/devices/authorize`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-relay-secret': secret } : {}),
        },
        body: JSON.stringify({ deviceId: id, userId: owner }),
      });

    assert.equal((await call(null)).status, 401);
    assert.equal((await call('wrong')).status, 401);
    const ok = await call(RELAY_SECRET);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { allowed: boolean }).allowed, true);
  });

  // -------------------------------------------------------------------------
  // The address book. Driven through the same functions the routes call, since
  // /v1/contacts and /v1/shares/invite are behind Clerk auth this suite has no
  // token for.
  // -------------------------------------------------------------------------

  const contactOf = (ownerId: string, email: string) =>
    prisma!.shareContact.findUnique({ where: { ownerId_email: { ownerId, email } } });

  test('inviting an address remembers it, normalized', async () => {
    const owner = user();
    await recordShareContact(prisma!, owner, '  Colleague@Example.COM ');
    const row = await contactOf(owner, 'colleague@example.com');
    assert.ok(row, 'the invitee must be remembered under the lowercased address');
    assert.equal(row.userId, null, 'nobody has claimed anything yet');
  });

  test('a second invite to the same address touches one row rather than adding another', async () => {
    const owner = user();
    await recordShareContact(prisma!, owner, 'again@example.com');
    const first = await contactOf(owner, 'again@example.com');
    await sleep(5);
    await recordShareContact(prisma!, owner, 'AGAIN@example.com');
    const rows = await prisma!.shareContact.findMany({ where: { ownerId: owner } });
    assert.equal(rows.length, 1, 'the composite key is owner + address');
    assert.ok(
      rows[0].lastUsedAt > first!.lastUsedAt,
      'the second invite must move the address back to the top of the list',
    );
    assert.deepEqual(rows[0].createdAt, first!.createdAt, 'and must not restamp when it was learned');
  });

  test('revoking every grant on a machine leaves the address behind', async () => {
    // The whole reason this table exists rather than a list derived from grants:
    // the address of somebody you just revoked is the one you most want offered.
    const owner = user();
    const guest = user();
    const id = await machine(owner);
    await prisma!.deviceMember.create({
      data: { deviceId: id, userId: guest, ownerId: owner, caps: capsJson(capsForPreset('view', 'machine')) },
    });
    await recordShareContact(prisma!, owner, 'revoked@example.com', guest);

    await prisma!.$transaction(revokeGrantsForDevice(prisma!, id));

    assert.deepEqual(await authorizeDevice(prisma!, id, guest), { allowed: false });
    const row = await contactOf(owner, 'revoked@example.com');
    assert.ok(row, 'the grant is gone; the address must not be');
    assert.equal(row.userId, guest, 'and it still knows who to name');
  });

  test('claiming a link-only invite records the claimer on the owner', async () => {
    // A link invite carries no address, so the claim is the only moment the owner
    // learns one — and it arrives with a user id, which an email invite does not.
    const owner = user();
    const claimer = user();
    await recordShareContact(prisma!, owner, 'Claimer@Example.com', claimer);
    const row = await contactOf(owner, 'claimer@example.com');
    assert.ok(row);
    assert.equal(row.userId, claimer);
    assert.equal(
      await contactOf(claimer, 'claimer@example.com'),
      null,
      'the book belongs to the owner who shared, not to the person who claimed',
    );
  });

  test('a later email invite keeps the name a claim earned', async () => {
    const owner = user();
    const claimer = user();
    await recordShareContact(prisma!, owner, 'both@example.com', claimer);
    await recordShareContact(prisma!, owner, 'both@example.com');
    assert.equal((await contactOf(owner, 'both@example.com'))?.userId, claimer);
  });

  test('forgetting an address is scoped to one owner', async () => {
    const mine = user();
    const theirs = user();
    const shared = 'shared@example.com';
    await recordShareContact(prisma!, mine, shared);
    await recordShareContact(prisma!, theirs, shared);

    assert.equal(await forgetShareContact(prisma!, mine, shared), 1);
    assert.equal(await contactOf(mine, shared), null);
    assert.ok(await contactOf(theirs, shared), "another account's identical address must survive");
    // Idempotent rather than throwing: the caller answers 404 off the count.
    assert.equal(await forgetShareContact(prisma!, mine, shared), 0);
  });
});
