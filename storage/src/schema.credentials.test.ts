import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

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
