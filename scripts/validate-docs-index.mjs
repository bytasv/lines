#!/usr/bin/env node
// Validates docs/codebase/index.json against docs/codebase/index.schema.json,
// then runs the cross-checks a schema can't express (unique ids, doc files exist).
//
// Zero-dependency on purpose: it implements only the JSON Schema keywords the
// index schema uses (type, const, required, properties, additionalProperties,
// items, minLength, pattern, $ref to #/$defs). An unknown keyword fails loudly
// rather than being silently ignored.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(root, 'docs/codebase');
const schema = JSON.parse(readFileSync(join(docsDir, 'index.schema.json'), 'utf8'));
const index = JSON.parse(readFileSync(join(docsDir, 'index.json'), 'utf8'));

const KNOWN = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description',
  'type', 'const', 'required', 'properties', 'additionalProperties', 'items', 'minLength', 'pattern',
]);
const errors = [];

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function check(node, value, path) {
  if (node.$ref) {
    const name = node.$ref.replace(/^#\/\$defs\//, '');
    const target = schema.$defs?.[name];
    if (!target) throw new Error(`unresolvable $ref ${node.$ref}`);
    return check(target, value, path);
  }
  for (const key of Object.keys(node)) {
    if (!KNOWN.has(key)) throw new Error(`schema keyword "${key}" is not supported by this validator`);
  }
  if (node.type) {
    const actual = typeOf(value);
    const ok = node.type === actual || (node.type === 'number' && actual === 'integer');
    if (!ok) return void errors.push(`${path}: expected ${node.type}, got ${actual}`);
  }
  if ('const' in node && value !== node.const) {
    errors.push(`${path}: expected ${JSON.stringify(node.const)}`);
  }
  if (typeof value === 'string') {
    if (node.minLength != null && value.length < node.minLength) errors.push(`${path}: empty string`);
    if (node.pattern && !new RegExp(node.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${node.pattern}`);
    }
  }
  if (Array.isArray(value) && node.items) {
    value.forEach((item, i) => check(node.items, item, `${path}[${i}]`));
  }
  if (typeOf(value) === 'object') {
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      const sub = node.properties?.[key];
      if (sub) check(sub, child, `${path}.${key}`);
      else if (node.additionalProperties === false) errors.push(`${path}: unknown property "${key}"`);
    }
  }
}

check(schema, index, '$');

const seen = new Set();
for (const [i, feature] of (index.features ?? []).entries()) {
  const where = `$.features[${i}]`;
  if (seen.has(feature.id)) errors.push(`${where}.id: duplicate id "${feature.id}"`);
  seen.add(feature.id);
  if (typeof feature.doc === 'string' && !existsSync(join(docsDir, feature.doc))) {
    errors.push(`${where}.doc: ${feature.doc} does not exist`);
  }
}

if (errors.length) {
  console.error(`docs/codebase/index.json: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`docs/codebase/index.json: valid (${index.features.length} features)`);
