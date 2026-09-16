// SPDX-License-Identifier: AGPL-3.0-only
// Additional permission under GNU AGPL v3 section 7 — see LICENSE-EXCEPTION.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * This repository is public, so two things have to stay true commit after
 * commit: the licence is actually declared everywhere a scanner or a fork will
 * look for it, and nothing that was scrubbed before publication creeps back in.
 *
 * Neither survives on care alone — the same reasoning as
 * `storage/src/schema.credentials.test.ts`, which fails CI rather than trusting
 * that nobody adds a credential column. A regression here is permanent once it
 * is pushed: git history is public the instant the repository is.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');

const WORKSPACES = ['shared', 'server', 'web', 'relay', 'storage', 'desktop'] as const;

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as Record<string, unknown>;
}

function manifests(): { rel: string; pkg: Record<string, unknown> }[] {
  return ['package.json', ...WORKSPACES.map((w) => `${w}/package.json`)].map((rel) => ({
    rel,
    pkg: readJson(rel),
  }));
}

test('the root manifest still lists exactly the workspaces this test checks', () => {
  // Otherwise a seventh workspace could be added and silently skip every
  // assertion below.
  assert.deepEqual(readJson('package.json').workspaces, [...WORKSPACES]);
});

test('every manifest declares the AGPL and points at the repository', () => {
  for (const { rel, pkg } of manifests()) {
    assert.equal(
      pkg.license,
      'AGPL-3.0-only',
      `${rel} must declare "license": "AGPL-3.0-only" (the bare "AGPL-3.0" id is deprecated)`,
    );
    const repository = pkg.repository as { url?: string } | undefined;
    assert.ok(repository?.url, `${rel} must declare a repository url`);
  }
});

test('the licence files a recipient looks for are all present', () => {
  for (const name of [
    'LICENSE',
    'LICENSE-EXCEPTION',
    'NOTICE',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, name)), `${name} is missing from the repository root`);
  }
});

test('LICENSE is the AGPL, not the GPL', () => {
  // The two texts are near-identical apart from section 13, so a paste of the
  // wrong one is easy to miss by eye and changes what the licence actually
  // requires of a hosted deployment.
  const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(license, /Remote Network Interaction/, 'LICENSE lacks AGPL section 13');
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
});

test('the exception grants an additional permission under section 7', () => {
  const exception = fs.readFileSync(path.join(ROOT, 'LICENSE-EXCEPTION'), 'utf8');
  assert.match(exception, /section 7/);
  assert.match(exception, /Agent Provider Software/);
});

test('no workspace can be published to npm by accident', () => {
  // Nothing here is meant for the registry. `private` is the only thing that
  // stops a stray `npm publish`, and adding a licence field is not a reason to
  // drop it.
  for (const { rel, pkg } of manifests()) {
    assert.equal(pkg.private, true, `${rel} must keep "private": true`);
  }
});

/**
 * Strings that were removed before this repository went public and must not
 * return. Deliberately narrow — each one is a thing the pre-publication audit
 * decided did not belong in a public tree:
 *
 *   - a Linear ticket id, which is third-party data rather than anything
 *     about this product (the workspace name it belonged to is gone from
 *     the tracked tree and from every historic commit — not just this
 *     denylist, since a pattern for it would itself have to spell it out);
 *   - the literal forced-command `authorized_keys` line, which publishes the
 *     exact sshd restriction set guarding a live host;
 *   - the author's own GHCR namespace, which a self-hoster following
 *     `deploy/README.md` would otherwise pull images from.
 *
 * What is deliberately NOT here, because the audit decided each is legitimate:
 * `linesapp.cloud` (the shipping product's real runtime default — a desktop
 * build from genericized source would be a broken build, and the endpoints
 * resolve from any browser) and `bytasv/lines` (the repository's own public
 * URL, which the `repository` fields and the landing page both need).
 */
const DENIED: { pattern: RegExp; why: string }[] = [
  { pattern: /NUR-\d+/, why: 'a Linear ticket id from a former workspace' },
  { pattern: /command="\/root\//, why: 'a literal forced-command authorized_keys entry' },
  { pattern: /ghcr\.io\/bytasv/, why: "the author's own container registry namespace" },
];

/** Extensions whose contents are not text and would only produce false hits. */
const BINARY = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.svgz',
  '.pdf', '.zip', '.gz', '.tgz', '.dmg', '.woff', '.woff2', '.ttf', '.otf',
  '.mp4', '.mov', '.node', '.wasm',
]);

/**
 * This file quotes every denied string in `DENIED`, so it matches itself. Skip
 * it by path rather than obfuscating the patterns, which would make them
 * unreadable to the next person deciding whether a string belongs here.
 */
const SELF = path.relative(ROOT, import.meta.filename).split(path.sep).join('/');

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

test('the tracked tree holds no scrubbed string', () => {
  const files = trackedFiles();
  // Guard against `git ls-files` failing open and the test passing vacuously.
  assert.ok(files.length > 100, `expected the whole tree, got ${files.length} files`);

  const offenders: string[] = [];
  for (const rel of files) {
    if (rel === SELF) continue;
    if (BINARY.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue; // staged deletion, not yet committed
    const text = fs.readFileSync(abs, 'utf8');
    for (const { pattern, why } of DENIED) {
      const hit = pattern.exec(text);
      if (hit) offenders.push(`${rel}: ${hit[0]} (${why})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'string(s) scrubbed before this repository went public have come back:\n' +
      offenders.join('\n') +
      '\nIf one of these is genuinely fine to publish, change DENIED and say why.',
  );
});
