#!/usr/bin/env node
/**
 * The whole desktop release, in one command.
 *
 *   npm run ship -w desktop               # offers to bump the version if needed
 *   npm run ship -w desktop -- --dry-run  # build and sign, publish nothing
 *   npm run ship -w desktop -- --force    # re-publish a version on purpose
 *
 * `npm run release -w desktop` is an alias of `ship`: the command people reach
 * for first has to be the full release, bump offer included.
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
 * `upload` stay usable on their own. What it adds is the part that is easy to
 * get wrong by hand: both build-time URLs are *derived* from
 * `R2_RELEASE_PUBLIC_BASE_URL` instead of exported from memory. A feed URL typed
 * wrong bakes a dead updater into the shipped app, and nothing notices until a
 * user's copy quietly stops finding releases.
 *
 * It also runs the typecheck and the server and relay suites before building:
 * the bridge ships inside the app, and a release cut from a commit whose tests
 * fail puts that failure on every user's machine. There is no flag to skip them.
 * `LINES_SHIP_TESTED=1` is for the release workflow only, whose cheap guard job
 * has already run the same suites on the same commit.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(DESKTOP, '..');
const RELEASE_DIR = path.join(DESKTOP, 'release');
/** Relative so the commit below is path-scoped from the repo root. */
const MANIFEST = 'desktop/package.json';
/** Must match `PREFIX` and `ALIAS` in `release.mjs` — that script writes the key this URL reads. */
const PREFIX = 'desktop';
const ALIAS = 'Lines-latest.dmg';

const flags = new Set(['--dry-run', '--force']);
const unknown = process.argv.slice(2).filter((arg) => !flags.has(arg));
if (unknown.length) {
  console.error(`Unrecognised argument: ${unknown.join(' ')}`);
  console.error('Usage: npm run ship|release -w desktop [-- --dry-run --force]');
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

/**
 * Like `run`, but hands the status back instead of exiting on it, and captures
 * the child's stderr rather than inheriting it. Both matter only for the
 * already-published check: its failure message has to be held back until we
 * know whether a prompt is coming, or the user reads an error and *then* a
 * question about that error.
 */
function runStatus(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  try {
    execFileSync(command, args, { cwd: REPO, stdio: ['inherit', 'inherit', 'pipe'], ...options });
    return { status: 0, stderr: '' };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stderr: error.stderr?.toString() ?? '',
    };
  }
}

/**
 * Every release used to start the same way: hit the already-published check,
 * hand-edit one line of `desktop/package.json`, commit, re-run. So offer it.
 *
 * Only at a terminal, and never on a `--dry-run` — a dry run publishes nothing
 * and must leave the repo untouched. CI and any piped invocation fall through to
 * the original failure, unchanged.
 *
 * Returns the new version, having already written it; `build.mjs` and
 * electron-builder both re-read the file in a fresh process, so the write only
 * has to land before `npm run package`.
 */
async function promptForBump(message) {
  const text = fs.readFileSync(path.join(REPO, MANIFEST), 'utf8');
  const current = JSON.parse(text).version;
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!parts) {
    // A prerelease or anything else unusual: what "the next one" means is a
    // judgement call, so make it by hand.
    process.stderr.write(message);
    console.error(`\nCannot bump ${current} automatically — edit ${MANIFEST} yourself.`);
    process.exit(1);
  }
  const next = `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\n${current} is already published. Bump to ${next} and continue?\n` +
      'The bump is committed and pushed after the release succeeds. [Y/n] ',
  );
  rl.close();
  if (!/^(y(es)?)?$/i.test(answer.trim())) {
    // The original message and the original exit code: a scripted caller that
    // only checks for failure sees exactly what it saw before.
    process.stderr.write(message);
    process.exit(1);
  }

  // A targeted replace on the first `"version"` — line 3 of this file — keeps
  // the formatting that `JSON.parse` + `stringify` would quietly rewrite.
  // package-lock.json is deliberately left stale: every historical bump commit
  // did the same, and it resyncs on the next install.
  fs.writeFileSync(path.join(REPO, MANIFEST), text.replace(/"version": "[^"]+"/, `"version": "${next}"`));
  console.log(`Bumped ${MANIFEST} to ${next}.`);
  return next;
}

/** The version this run wrote, if it wrote one. Null on every other path. */
let bumped = null;

if (force) {
  console.log('--force: skipping the already-published check.');
} else {
  const check = runStatus(process.execPath, [path.join(DESKTOP, 'scripts', 'check-unreleased.mjs')], { env });
  if (check.status !== 0) {
    // 2 is specifically "already published" (see `check-unreleased.mjs`); any
    // other non-zero status is a check that could not run, which no bump fixes.
    const offerBump = check.status === 2 && !dryRun && process.stdin.isTTY && process.stdout.isTTY;
    if (!offerBump) {
      process.stderr.write(check.stderr);
      process.exit(check.status);
    }
    bumped = await promptForBump(check.stderr);
  }
}

/**
 * A build that fails after the bump leaves a version that is neither published
 * nor committed — and the next ship would see it differ from the published one,
 * pass the check silently, and publish a bump nobody recorded. Say so instead.
 */
if (bumped) {
  process.on('exit', (code) => {
    if (code !== 0) console.error(`\nleft ${MANIFEST} at ${bumped}, uncommitted.`);
  });
}

/**
 * electron-builder output and nothing else. A DMG left from an earlier build
 * would otherwise be published as the download alias — `release.mjs` refuses
 * outright when it finds two, so clearing first is what keeps that from being a
 * failure you have to think about.
 */
fs.rmSync(RELEASE_DIR, { recursive: true, force: true });

if (process.env.LINES_SHIP_TESTED === '1') {
  console.log('\nLINES_SHIP_TESTED=1: the guard job already ran typecheck and tests.');
} else {
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'test', '-w', 'server']);
  run('npm', ['run', 'test', '-w', 'relay']);
}

run('npm', ['run', 'package', '-w', 'desktop'], { env });

if (dryRun) {
  console.log(`\n--dry-run: built and signed, nothing published.`);
  console.log(`Artifacts in ${path.relative(REPO, RELEASE_DIR)}/; check desktop/dist/config.json for:`);
  console.log(`  updateFeedUrl ${env.LINES_UPDATE_FEED_URL}`);
  console.log(`  downloadUrl   ${env.LINES_DOWNLOAD_URL}`);
  process.exit(0);
}

run('npm', ['run', 'upload', '-w', 'desktop'], { env });

/**
 * Record the bump only now: a failed build must never leave a pushed bump for a
 * release that did not ship. Deliberately not via `run` — that exits on a
 * non-zero status, which would report an already-published release as a
 * failure. The release is done; the worst case here is a commit you push later.
 */
if (bumped) {
  const git = (args) => execFileSync('git', args, { cwd: REPO, stdio: 'inherit' });
  try {
    git(['commit', MANIFEST, '-m', `chore(desktop): bump version to ${bumped}`]);
  } catch {
    console.error(`\npublished ${bumped}; ${MANIFEST} is written but uncommitted — commit and push it.`);
    process.exit(0);
  }
  try {
    git(['push']);
  } catch {
    console.error(`\npublished ${bumped}; the bump commit is local — run \`git push\`.`);
    process.exit(0);
  }
}
