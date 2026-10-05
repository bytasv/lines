/**
 * The in-app "What's new" notes: their shape, and the rules for which of them a
 * browser has not seen yet. Read by the web app (from `changelog.json` at the
 * repo root, baked in by web/vite.config.ts) and by the tests that keep that
 * file well-formed.
 *
 * Imports nothing, so it is safe to re-export from types.ts above its
 * cycle-sensitive block.
 */

/** Numeric `x.y.z` compare: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** One shipped version of one track, and the user-facing changes it brought. */
export interface ChangelogRelease {
  version: string;
  /** `YYYY-MM-DD`. */
  date: string;
  items: string[];
}

/**
 * `changelog.json`. Both tracks are newest first. `desktopPending` holds desktop
 * items committed since the last release: a desktop version exists only once
 * desktop/scripts/ship.mjs bumps it, which is when they are stamped into a
 * release.
 */
export interface Changelog {
  web: ChangelogRelease[];
  desktop: ChangelogRelease[];
  desktopPending: string[];
}

/** The releases above `lastSeen`, up to and including `current`. */
export function releasesSince(
  releases: ChangelogRelease[],
  lastSeen: string,
  current: string,
): ChangelogRelease[] {
  return releases.filter(
    (r) => compareVersions(r.version, lastSeen) > 0 && compareVersions(r.version, current) <= 0,
  );
}

/**
 * What to remember as seen after showing the notes for `current`.
 *
 * Capped at the newest release this bundle knows of: a desktop app released
 * before the web app redeploys with its stamped notes runs a version this
 * changelog has no entry for yet, and remembering that version would skip those
 * notes for good. Never lower than `lastSeen`, so an older machine never moves
 * the marker back.
 */
export function nextSeen(lastSeen: string | null, current: string, releases: ChangelogRelease[]): string {
  const newest = releases.reduce<string | null>(
    (max, r) => (max === null || compareVersions(r.version, max) > 0 ? r.version : max),
    null,
  );
  const capped = newest !== null && compareVersions(current, newest) > 0 ? newest : current;
  if (lastSeen !== null && compareVersions(lastSeen, capped) > 0) return lastSeen;
  return capped;
}
