#!/usr/bin/env node
/**
 * Stamps the desktop notes committed since the last release with the version
 * they ship in.
 *
 *   npm run changelog:stamp -w desktop                 # stamp desktop/package.json's version
 *   node desktop/scripts/stamp-changelog.mjs --check   # exit 1 if anything is unstamped
 *
 * The commit step of the Lines dev workflow appends user-facing desktop changes
 * to `desktopPending` in the repo-root `changelog.json`: a desktop version exists
 * only once a release bumps it. ship.mjs stamps them when it commits a bump; a
 * CI release cannot commit, so its guard job runs `--check` and the stamp is
 * made and committed by hand before dispatching it.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
/** Relative so ship.mjs's commit stays path-scoped from the repo root. */
export const CHANGELOG = 'changelog.json';

/** Today as `YYYY-MM-DD`, in local time: the day the release was cut where it was cut. */
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The changelog with `desktopPending` moved into a new newest `desktop` release.
 * The same object back when nothing is pending. Throws for a version that
 * already has a release: stamping twice would split one release's notes.
 */
export function stampChangelog(changelog, version, date) {
  if (!changelog.desktopPending?.length) return changelog;
  if (changelog.desktop.some((release) => release.version === version)) {
    throw new Error(`${CHANGELOG} already has a desktop ${version} release; bump the version first.`);
  }
  return {
    ...changelog,
    desktop: [{ version, date, items: changelog.desktopPending }, ...changelog.desktop],
    desktopPending: [],
  };
}

/** Stamps the file in place. True when it wrote anything. */
export function stampFile(version, { repo = REPO, date = today() } = {}) {
  const file = path.join(repo, CHANGELOG);
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const after = stampChangelog(before, version, date);
  if (after === before) return false;
  fs.writeFileSync(file, `${JSON.stringify(after, null, 2)}\n`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  if (process.argv.includes('--check')) {
    const pending = JSON.parse(fs.readFileSync(path.join(REPO, CHANGELOG), 'utf8')).desktopPending ?? [];
    if (pending.length) {
      console.error(
        `${CHANGELOG} has ${pending.length} unstamped desktop note(s), and a CI release cannot commit the stamp.\n` +
          'Run `npm run changelog:stamp -w desktop`, commit, push, then dispatch the release again.',
      );
      process.exit(1);
    }
  } else {
    const version = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop', 'package.json'), 'utf8')).version;
    try {
      console.log(stampFile(version) ? `Stamped pending desktop notes as ${version}.` : 'No pending desktop notes.');
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }
}
