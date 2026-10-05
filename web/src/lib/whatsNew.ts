import { nextSeen, releasesSince, type Changelog, type ChangelogRelease } from '@lines/shared';

/**
 * Which "What's new" notes this browser has not seen yet.
 *
 * Two tracks, each with its own marker: the web bundle (`__LINES_VERSION__`)
 * and the desktop app (the bridge's `hello` version, which a packaged bridge
 * stamps from desktop/package.json). Either one moving past its marker shows
 * every release in between, so 0.1.0 to 0.5.0 lists all of them.
 *
 * A missing marker (a first visit, or the first deploy of this feature) is
 * written silently and shows nothing. Markers only ever move forward, through
 * `nextSeen`, so connecting to an older machine never moves one back.
 *
 * In localStorage, like UpdateBanner's dismissal: per browser, outliving a reload.
 */

const WEB_KEY = 'lines.seenWeb';
const DESKTOP_KEY = 'lines.seenDesktop';

/** `changelog.json` at the repo root, baked into the bundle by vite.config.ts. */
export const CHANGELOG: Changelog = __LINES_CHANGELOG__;

export interface WhatsNew {
  web: ChangelogRelease[];
  desktop: ChangelogRelease[];
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the notes show again next load, which is the lesser harm.
  }
}

/**
 * The markers as this page load found them, before anything here wrote them.
 * Settings marks the releases above these as new.
 */
export const previouslySeen: { web: string | null; desktop: string | null } = {
  web: read(WEB_KEY),
  desktop: read(DESKTOP_KEY),
};

/** The web part, decided once at module load against this bundle's own version. */
const webNews: ChangelogRelease[] =
  previouslySeen.web === null ? [] : releasesSince(CHANGELOG.web, previouslySeen.web, __LINES_VERSION__);
if (previouslySeen.web === null) write(WEB_KEY, __LINES_VERSION__);

/** The last desktop version judged, so a remount or a repeat `hello` is not judged twice. */
let judgedDesktop: string | null = null;
let decided = false;

function desktopNews(version: string): ChangelogRelease[] {
  judgedDesktop = version;
  const seen = read(DESKTOP_KEY);
  if (seen === null) {
    write(DESKTOP_KEY, version);
    return [];
  }
  return releasesSince(CHANGELOG.desktop, seen, version);
}

/**
 * What boot should show over the finished splash, or null for nothing. Answers
 * once per page load: a machine switch remounts the app and replays the splash,
 * and must not show the card again.
 *
 * `bridgeVersion` is null when boot gave up waiting for a `hello`; the desktop
 * part is then left for `desktopUpdateNews` once one arrives.
 */
export function pendingWhatsNew(bridgeVersion: string | null): WhatsNew | null {
  if (decided) return null;
  decided = true;
  const desktop = bridgeVersion ? desktopNews(bridgeVersion) : [];
  return webNews.length || desktop.length ? { web: webNews, desktop } : null;
}

/**
 * The desktop notes for a bridge version that arrived after boot: the desktop
 * app updated and relaunched its bridge, and the open tab reconnected without
 * a splash. Empty for a version already judged, including the one boot showed.
 */
export function desktopUpdateNews(bridgeVersion: string): ChangelogRelease[] {
  if (bridgeVersion === judgedDesktop) return [];
  return desktopNews(bridgeVersion);
}

/** The notes have been shown: move both markers up to what this bundle knows of. */
export function markSeen(bridgeVersion: string | null) {
  write(WEB_KEY, nextSeen(read(WEB_KEY), __LINES_VERSION__, CHANGELOG.web));
  if (bridgeVersion) write(DESKTOP_KEY, nextSeen(read(DESKTOP_KEY), bridgeVersion, CHANGELOG.desktop));
}
