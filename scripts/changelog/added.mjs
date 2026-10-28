/**
 * The releases a deploy added to `changelog.json`: present at `to`, missing at `from`, by track and
 * version. An existing release edited between the two is not added again, so a typo fix never
 * re-announces. `desktopPending` is never announced: it has no version until a release stamps it.
 *
 *   import { addedReleases, readChangelogAt } from './added.mjs';
 */

import { execFileSync } from 'node:child_process';

/** Git's "no commit" SHA: `github.event.before` on a branch's first push. */
export const ZERO_SHA = /^0+$/;

/** The tracks whose releases are announced. */
export const TRACKS = ['web', 'desktop'];

/** `changelog.json` at `sha`, or `null` when it did not exist there. */
export function readChangelogAt(sha, cwd = process.cwd()) {
  try {
    const text = execFileSync('git', ['show', `${sha}:changelog.json`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The releases of `to` that `from` does not have, as `{ track, release }`, each track newest first
 * as `to` keeps it. A missing `from` (the file is new) means every release of `to` is added.
 */
export function addedReleases(from, to) {
  return TRACKS.flatMap((track) => {
    const known = new Set((from?.[track] ?? []).map((r) => r.version));
    return (to?.[track] ?? []).filter((r) => !known.has(r.version)).map((release) => ({ track, release }));
  });
}
