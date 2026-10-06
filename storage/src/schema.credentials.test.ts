import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import dotenv from 'dotenv';
import type { PrismaClient } from '@prisma/client';

/**
 * The product promise is that a database compromise cannot leak an agent
 * credential: the Claude OAuth token lives only in an `auth.json` under
 * `~/.lines-app`
 * on the user's own machine and is handed to the CLI as an env var.
 *
 * Today that holds because no model has anywhere to put one. This test is what
 * keeps it true — adding a credential-shaped column now fails CI instead of
 * quietly becoming the thing we said could never happen.
 */

const SCHEMA = fs.readFileSync(
  path.resolve(import.meta.dirname, '../prisma/schema.prisma'),
  'utf8',
);

/**
 * Names that suggest a secret. Deliberately broad: a false positive costs one
 * line in the allowlist below and a moment's thought about whether the field
 * really belongs in Postgres.
 */
const SUSPICIOUS = /token|secret|credential|password|apikey|api_key|refresh|access_key|private_key/i;

/**
 * Fields that look secret-ish and are allowed, each with the reason.
 *
 * `Device.secretHash` holds a sha256 of the pairing secret. The plaintext is
 * generated on the paired machine and never leaves it, so this column cannot be
 * replayed to impersonate a device — the same argument that lets a password hash
 * live in a database. Nothing joins this list without an equivalent one.
 */
const ALLOWED: ReadonlySet<string> = new Set(['Device.secretHash']);

interface Field {
  model: string;
  name: string;
}

/** Field lines inside `model X { ... }`, ignoring attributes and block markers. */
function fields(): Field[] {
  const out: Field[] = [];
  let model: string | null = null;
  for (const raw of SCHEMA.split('\n')) {
    const line = raw.trim();
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      model = open[1];
      continue;
    }
    if (line === '}') {
      model = null;
      continue;
    }
    if (!model || !line || line.startsWith('//') || line.startsWith('@@')) continue;
    const name = /^(\w+)\s+\S/.exec(line);
    if (name) out.push({ model, name: name[1] });
  }
  return out;
}

test('the schema parses into models and fields', () => {
  const all = fields();
  // Guard against the parser silently matching nothing and passing vacuously.
  assert.ok(all.length > 20, `expected many fields, found ${all.length}`);
  assert.ok(all.some((f) => f.model === 'Session'), 'expected a Session model');
});

test('no model has a credential-shaped field', () => {
  const offenders = fields()
    .filter((f) => SUSPICIOUS.test(f.name))
    .map((f) => `${f.model}.${f.name}`)
    .filter((id) => !ALLOWED.has(id));

  assert.deepEqual(
    offenders,
    [],
    `credential-shaped column(s) in the storage schema: ${offenders.join(', ')}. ` +
      'Agent credentials must never reach Postgres. If this is genuinely not a ' +
      'secret, add it to ALLOWED with a reason.',
  );
});

test('the allowlist has no stale entries', () => {
  // A stale allowlist quietly re-permits a name once the field is renamed away.
  const present = new Set(fields().map((f) => `${f.model}.${f.name}`));
  for (const id of ALLOWED) {
    if (!present.has(id)) {
      assert.fail(`ALLOWED lists ${id}, which no longer exists — drop it`);
    }
  }
});

/**
 * Columns are not the only place a credential can sit: most tables keep their
 * payload in a jsonb `data` blob, which the field check above cannot see into.
 * `mcp_connections` did hold one there — each stdio connection's `env`, values
 * and all — until bridges started syncing names only and
 * `20261006010000_mcp_env_names_only` scrubbed the rows already written. This
 * runs that migration's own SQL, read from the file rather than copied, so what
 * is tested is what shipped.
 *
 * Opt-in on a scratch Postgres with the migrations applied, as `shares.test.ts`:
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://… npm test -w storage
 *
 * The statement is the migration verbatim, so it runs over every
 * `mcp_connections` row in that database, not only the ones written here — one
 * more reason it must never point at `DATABASE_URL`.
 */

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });

const DB_URL = process.env.STORAGE_TEST_DATABASE_URL;
const skip = DB_URL
  ? false
  : 'set STORAGE_TEST_DATABASE_URL to a scratch Postgres to run the MCP env scrub test';

const ENV_SCRUB_SQL = path.resolve(
  import.meta.dirname,
  '../prisma/migrations/20261006010000_mcp_env_names_only/migration.sql',
);

describe('the MCP env scrub migration', { skip }, () => {
  let prisma: PrismaClient | null = null;
  /** Every user this block writes under, so a scratch database is left as found. */
  const users: string[] = [];
  const newUser = () => {
    const id = `test-mcp-env-${randomUUID()}`;
    users.push(id);
    return id;
  };
  const scrub = () => prisma!.$executeRawUnsafe(fs.readFileSync(ENV_SCRUB_SQL, 'utf8'));
  const dataOf = async (userId: string) =>
    (await prisma!.mcpConnections.findUnique({ where: { userId } }))?.data;

  before(async () => {
    // Imported here rather than at the top: the schema checks above need no
    // client, and must keep running where none has been generated.
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  });

  after(async () => {
    if (!prisma) return;
    await prisma.mcpConnections.deleteMany({ where: { userId: { in: users } } });
    await prisma.$disconnect();
  });

  test('env values become names, and nothing else in the row changes', async () => {
    const user = newUser();
    const http = {
      id: 'h',
      name: 'figma',
      transport: 'http',
      url: 'https://mcp.figma.com/mcp',
      headerKeys: ['Authorization'],
      enabled: true,
    };
    const signature = { alg: 'ecdsa-p256-sha256', key: 'k', counter: 3, sig: 's' };
    await prisma!.mcpConnections.create({
      data: {
        userId: user,
        data: {
          connections: [
            {
              id: 's',
              name: 'local',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', 'srv'],
              env: { REGION: 'eu', API_KEY: 'sk-CANARY' },
              enabled: true,
            },
            { id: 'e', name: 'bare', transport: 'stdio', command: 'uvx', env: {}, enabled: true },
            http,
          ],
          updatedAt: 1,
          _linesSig: signature,
        },
      },
    });

    await scrub();
    const scrubbed = await dataOf(user);
    // Idempotent: a second run (a replayed migration, a shadow database) finds
    // nothing left to do.
    await scrub();

    assert.deepEqual(await dataOf(user), scrubbed);
    assert.equal(JSON.stringify(scrubbed).includes('sk-CANARY'), false);
    assert.deepEqual(scrubbed, {
      connections: [
        {
          id: 's',
          name: 'local',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'srv'],
          envKeys: ['API_KEY', 'REGION'],
          enabled: true,
        },
        { id: 'e', name: 'bare', transport: 'stdio', command: 'uvx', enabled: true },
        http,
      ],
      updatedAt: 1,
      // Kept, and no longer verifying: the bridge refuses the row and pushes its
      // own signed copy over it (see sync.credentials.test.ts).
      _linesSig: signature,
    });
  });

  test('a row with no env in it is not touched', async () => {
    const user = newUser();
    const data = {
      connections: [{ id: 'h', name: 'figma', transport: 'http', url: 'https://x.example/mcp', enabled: true }],
      updatedAt: 2,
      _linesSig: { alg: 'ecdsa-p256-sha256', key: 'k', counter: 1, sig: 's' },
    };
    await prisma!.mcpConnections.create({ data: { userId: user, data } });
    const stamp = (await prisma!.mcpConnections.findUnique({ where: { userId: user } }))!.updatedAt;

    await scrub();

    const row = await prisma!.mcpConnections.findUnique({ where: { userId: user } });
    assert.deepEqual(row!.data, data);
    assert.equal(row!.updatedAt.getTime(), stamp.getTime());
  });
});
