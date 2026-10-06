import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Every table has Row Level Security on, with no policy and nothing forced.
 *
 * Supabase's Data API (PostgREST) can serve the `public` schema to its `anon` and
 * `authenticated` roles, and the anon key is public by design. Nothing in Lines
 * uses that API — every query is the storage server's, scoped by the verified
 * Clerk user id — so RLS with no policy shuts those roles out of every table
 * whether or not the project exposes `public`, while the storage server, as the
 * tables' owner, is unaffected. See the `row_level_security` migration.
 *
 * Reads files only, so it runs in CI with no database: a new table whose
 * migration forgets `ENABLE ROW LEVEL SECURITY` fails here rather than shipping a
 * table the anon key can read.
 */

const PRISMA_DIR = path.resolve(import.meta.dirname, '../prisma');
const SCHEMA = fs.readFileSync(path.join(PRISMA_DIR, 'schema.prisma'), 'utf8');
const MIGRATIONS_DIR = path.join(PRISMA_DIR, 'migrations');

/** Prisma's bookkeeping table: created by `migrate deploy`, not by a migration, and in `public` all the same. */
const PRISMA_MIGRATIONS = '_prisma_migrations';

/** Each model's table: its `@@map` name, else the model's own (Prisma's default). */
function schemaTables(): string[] {
  const out: string[] = [];
  let model: string | null = null;
  let table: string | null = null;
  for (const raw of SCHEMA.split('\n')) {
    const line = raw.trim();
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      model = open[1];
      table = null;
      continue;
    }
    if (!model) continue;
    const map = /^@@map\(\s*(?:name:\s*)?"(\w+)"/.exec(line);
    if (map) table = map[1];
    if (line.startsWith('}')) {
      out.push(table ?? model);
      model = null;
    }
  }
  return out;
}

/** Comments out, so prose that names a statement — that migration's header explains FORCE — never counts as one. */
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

/** Every migration's SQL, in the order `migrate deploy` applies them: folder names lead with a timestamp. */
function migrations(): { name: string; sql: string }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      sql: stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8')),
    }));
}

/** A table name as a migration writes it: quoted or not, optionally schema-qualified. */
const NAME = String.raw`(?:"?public"?\.)?"?(\w+)"?`;
const ALTER = String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${NAME}`;

type Kind = 'create' | 'drop' | 'rename' | 'enable' | 'disable';

/** The statements that decide whether a table exists and whether it has RLS. */
const STATEMENTS: { kind: Kind; re: RegExp }[] = [
  { kind: 'create', re: new RegExp(String.raw`CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`, 'gi') },
  { kind: 'drop', re: new RegExp(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${NAME}`, 'gi') },
  { kind: 'rename', re: new RegExp(String.raw`${ALTER}\s+RENAME\s+TO\s+"?(\w+)"?`, 'gi') },
  { kind: 'enable', re: new RegExp(String.raw`${ALTER}\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY`, 'gi') },
  { kind: 'disable', re: new RegExp(String.raw`${ALTER}\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY`, 'gi') },
];

/**
 * Every migration's table statements, replayed in order: the tables that exist at
 * the end, the ones with RLS on, and every RLS statement that names a table no
 * earlier statement created.
 */
function replay(): { live: Set<string>; rls: Set<string>; unknown: string[] } {
  const live = new Set<string>();
  const rls = new Set<string>();
  const unknown: string[] = [];
  for (const { name, sql } of migrations()) {
    const found = STATEMENTS.flatMap(({ kind, re }) =>
      [...sql.matchAll(re)].map((m) => ({ at: m.index ?? 0, kind, table: m[1], renamedTo: m[2] })),
    ).sort((a, b) => a.at - b.at);
    for (const { kind, table, renamedTo } of found) {
      if (kind === 'create') {
        live.add(table);
      } else if (kind === 'drop') {
        live.delete(table);
        rls.delete(table);
      } else if (kind === 'rename') {
        // RLS is a property of the table, so it follows the table to its new name.
        if (live.delete(table)) live.add(renamedTo);
        if (rls.delete(table)) rls.add(renamedTo);
      } else {
        if (table !== PRISMA_MIGRATIONS && !live.has(table)) unknown.push(`${name}: ${table}`);
        if (kind === 'enable') rls.add(table);
        else rls.delete(table);
      }
    }
  }
  return { live, rls, unknown };
}

test('the schema and the migrations parse into tables', () => {
  // Guard against a parser that silently matches nothing and passes vacuously.
  const tables = schemaTables();
  assert.ok(tables.length > 15, `expected many tables, found ${tables.length}`);
  assert.ok(tables.includes('step_versions'), 'expected @@map names, not model names');
  assert.ok(replay().live.has('sessions'), 'expected the migrations to create the sessions table');
});

test('every table has row level security enabled', () => {
  // The schema's tables, and also whatever a migration created without a model:
  // the anon key reaches a table whether or not Prisma knows about it.
  const { live, rls } = replay();
  const required = new Set([...schemaTables(), ...live, PRISMA_MIGRATIONS]);
  const missing = [...required].filter((table) => !rls.has(table)).sort();
  assert.deepEqual(
    missing,
    [],
    `table(s) without row level security: ${missing.join(', ')}. Add ` +
      '`ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;` to the migration that creates it — no policy, ' +
      'no FORCE. Without it, the Supabase anon key can read and write that table whenever the Data API ' +
      'exposes `public`.',
  );
});

test('every RLS statement names a table that exists by then', () => {
  // A misspelt or misordered name passes review and then fails `migrate deploy` in
  // production, which records the migration as failed and refuses every deploy
  // after it until someone resolves it by hand.
  const { unknown } = replay();
  assert.deepEqual(unknown, [], `RLS statement(s) naming a table no earlier migration creates: ${unknown.join(', ')}`);
});

test('no table forces row level security on its owner', () => {
  // The storage server connects as the tables' owner, which RLS skips unless the
  // table is FORCEd — and with no policies, a forced table denies it every row.
  const forced = migrations()
    .filter(({ sql }) => /(?<!NO\s+)FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql))
    .map(({ name }) => name);
  assert.deepEqual(forced, [], `FORCE ROW LEVEL SECURITY in ${forced.join(', ')} would lock the storage server out`);
});

test('no migration creates a policy', () => {
  // No policy is the design, not an omission: nothing but the storage server reads
  // these tables. A policy is the one statement that hands a table back to the Data
  // API's roles, so adding one has to be a decision made here, not a side effect.
  const withPolicy = migrations()
    .filter(({ sql }) => /CREATE\s+POLICY/i.test(sql))
    .map(({ name }) => name);
  assert.deepEqual(withPolicy, [], `CREATE POLICY in ${withPolicy.join(', ')}`);
});
