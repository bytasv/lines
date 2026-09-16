#!/usr/bin/env node
/**
 * Refuse to publish a version that is already on the edge.
 *
 * Published artifacts are immutable with a one-year max-age (`release.mjs`), so
 * re-uploading a version does not replace it for anyone who already has it
 * cached — the download link and the update feed can disagree for a year. The
 * fix is always to bump `desktop/package.json`, so this turns that rule into an
 * exit code rather than a line in the runbook.
 *
 * Standalone and hand-runnable, like `deploy/scripts/check-migration-safety.sh`:
 * the workflow calls it on the cheap ubuntu job so a stale version costs one
 * quota minute instead of a full macOS build.
 *
 *   node desktop/scripts/check-unreleased.mjs
 *   node desktop/scripts/check-unreleased.mjs --force   # skip the check on purpose
 *
 * Exit codes are deliberately the inverse of the grep/diff convention, because
 * `ship.mjs` dispatches on them and the two outcomes are not interchangeable:
 *
 *   0  this version is publishable (or the check was skipped)
 *   2  this version is already published — the bump is the fix
 *   1  the check could not run (no R2_RELEASE_PUBLIC_BASE_URL)
 *
 * Do not "tidy" the 2 back to 1: `ship.mjs` reads it to decide whether it can
 * offer the bump, and the workflow only cares that either is non-zero.
 *
 * Needs only `R2_RELEASE_PUBLIC_BASE_URL` — it reads the public feed, so no
 * credentials are involved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(DESKTOP, '..');

const { config } = require('dotenv');
config({ path: path.join(REPO, '.env') });

// The workflow skips this step entirely when its `force` input is set, but the
// failure message points at `--force`, so honour it here too rather than
// advertising a flag only one of the two callers understands.
if (process.argv.includes('--force')) {
  console.log('--force: skipping the already-published check.');
  process.exit(0);
}

const publicBase = process.env.R2_RELEASE_PUBLIC_BASE_URL;
if (!publicBase) {
  console.error('Missing R2_RELEASE_PUBLIC_BASE_URL — cannot tell what is already published.');
  process.exit(1);
}

const { version } = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const feedUrl = `${publicBase.replace(/\/$/, '')}/desktop/latest-mac.yml`;

/**
 * A missing feed means nothing has shipped yet, which is a valid state to
 * release from. It is also what a wrong base URL looks like — the S3-endpoint
 * assertion in `release.mjs` is what catches that shape of mistake — so say
 * which one this was rather than passing silently.
 */
let body;
try {
  const response = await fetch(feedUrl);
  if (response.status === 404) {
    console.log(`No ${feedUrl} yet — treating ${version} as the first release.`);
    process.exit(0);
  }
  if (!response.ok) {
    console.warn(`Could not read ${feedUrl} (HTTP ${response.status}) — skipping the version check.`);
    process.exit(0);
  }
  body = await response.text();
} catch (error) {
  console.warn(`Could not reach ${feedUrl} (${error.message}) — skipping the version check.`);
  process.exit(0);
}

// electron-builder writes a flat three-key file; a YAML parser would be a
// dependency for one line.
const published = body.match(/^version:\s*(\S+)/m)?.[1];
if (!published) {
  console.warn(`No version line in ${feedUrl} — skipping the version check.`);
  process.exit(0);
}

if (published === version) {
  console.error(
    `${version} is already published; bump desktop/package.json.\n` +
      'Artifacts are immutable at the edge, so re-uploading one does not replace it. ' +
      'Pass --force (or the workflow `force` input) if you mean to republish anyway.',
  );
  process.exit(2);
}

console.log(`Publishing ${version} (currently published: ${published}).`);
