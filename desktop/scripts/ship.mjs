#!/usr/bin/env node
/**
 * The whole desktop release, in one command.
 *
 *   npm run ship -w desktop               # bump the version first, then this
 *   npm run ship -w desktop -- --dry-run  # build and sign, publish nothing
 *   npm run ship -w desktop -- --force    # re-publish a version on purpose
 *
 * The `--` is npm's argument separator: without it npm keeps the flag and this
 * script never sees it. A swallowed `--dry-run` would mean a real publish, so
 * an unrecognised argument is an error here rather than something ignored.
 *
 * This is also what the `release-desktop` workflow runs, deliberately — a local
 * release and a CI release that drift are two procedures to keep correct, and
 * the local one is what you reach for when CI is broken.
 *
 * It orchestrates the existing scripts rather than replacing them; `package` and
 * `release` stay usable on their own. What it adds is the part that is easy to
 * get wrong by hand: both build-time URLs are *derived* from
 * `R2_RELEASE_PUBLIC_BASE_URL` instead of exported from memory. A feed URL typed
 * wrong bakes a dead updater into the shipped app, and nothing notices until a
 * user's copy quietly stops finding releases.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(DESKTOP, '..');
const RELEASE_DIR = path.join(DESKTOP, 'release');
/** Must match `PREFIX` and `ALIAS` in `release.mjs` — that script writes the key this URL reads. */
const PREFIX = 'desktop';
const ALIAS = 'Lines-latest.dmg';

const flags = new Set(['--dry-run', '--force']);
const unknown = process.argv.slice(2).filter((arg) => !flags.has(arg));
if (unknown.length) {
  console.error(`Unrecognised argument: ${unknown.join(' ')}`);
  console.error('Usage: npm run ship -w desktop [-- --dry-run --force]');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

const { config } = require('dotenv');
config({ path: path.join(REPO, '.env') });

const publicBase = process.env.R2_RELEASE_PUBLIC_BASE_URL?.replace(/\/$/, '');
if (!publicBase) {
  console.error(
    'Missing R2_RELEASE_PUBLIC_BASE_URL — both the update feed and the download URL are derived from it.\n' +
      'Set it in the repo-root .env (local) or in the workflow environment (CI).',
  );
  process.exit(1);
}

/** `build.mjs` reads both of these into the shipped `config.json`. */
const env = {
  ...process.env,
  LINES_UPDATE_FEED_URL: `${publicBase}/${PREFIX}`,
  LINES_DOWNLOAD_URL: `${publicBase}/${PREFIX}/${ALIAS}`,
};

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  try {
    execFileSync(command, args, { cwd: REPO, stdio: 'inherit', ...options });
  } catch (error) {
    // The child already printed why; a Node stack trace on top only buries it.
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
}

if (force) {
  console.log('--force: skipping the already-published check.');
} else {
  run(process.execPath, [path.join(DESKTOP, 'scripts', 'check-unreleased.mjs')], { env });
}

/**
 * electron-builder output and nothing else. A DMG left from an earlier build
 * would otherwise be published as the download alias — `release.mjs` refuses
 * outright when it finds two, so clearing first is what keeps that from being a
 * failure you have to think about.
 */
fs.rmSync(RELEASE_DIR, { recursive: true, force: true });

run('npm', ['run', 'package', '-w', 'desktop'], { env });

if (dryRun) {
  console.log(`\n--dry-run: built and signed, nothing published.`);
  console.log(`Artifacts in ${path.relative(REPO, RELEASE_DIR)}/; check desktop/dist/config.json for:`);
  console.log(`  updateFeedUrl ${env.LINES_UPDATE_FEED_URL}`);
  console.log(`  downloadUrl   ${env.LINES_DOWNLOAD_URL}`);
  process.exit(0);
}

run('npm', ['run', 'release', '-w', 'desktop'], { env });
