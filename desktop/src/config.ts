/**
 * Where the installed app points.
 *
 * A packaged build has no `.env` and no repo to read one from, so its URLs ship
 * as a generated `Resources/config.json`. A file rather than esbuild `--define`
 * on purpose: a release artifact should be inspectable, and re-pointable at a
 * staging relay without a rebuild.
 *
 * Environment variables still win, which is what keeps `npm run dev -w desktop`
 * and Tilt working against a local stack.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface DesktopConfig {
  /**
   * Relay origin, with NO path: `RelayClient` appends `/agent` itself, and the
   * relay matches its endpoint path exactly. The browser's own `/client` URL is
   * baked into the web bundle, not here.
   */
  relayUrl: string;
  storageUrl: string;
  /** The hosted app, for "Open Lines" and the pairing window's link. */
  webUrl: string;
  /**
   * Directory holding `latest-mac.yml` for electron-updater's `generic`
   * provider. Empty disables update checks entirely — which is the state of any
   * build made before the release bucket is configured.
   */
  updateFeedUrl: string;
  /** Where a user goes to download an update by hand; see `canSelfInstall`. */
  downloadUrl: string;
}

/** Production, i.e. what a DMG built with no extra configuration points at. */
export const DEFAULT_CONFIG: DesktopConfig = {
  relayUrl: 'wss://linesapp.cloud',
  storageUrl: 'https://api.linesapp.cloud',
  webUrl: 'https://linesapp.cloud',
  updateFeedUrl: '',
  downloadUrl: 'https://linesapp.cloud',
};

/** File name inside the bundle's Resources (and beside the repo's desktop/ in dev). */
export const CONFIG_FILE = 'config.json';

/**
 * Defaults, then `config.json`, then the environment — last writer wins, so a
 * developer's `LINES_RELAY_URL` overrides a shipped file without editing it.
 *
 * Never throws: a corrupt config.json falls back to the defaults rather than
 * leaving the user with an app that will not launch and no way to fix it.
 */
export function loadConfig(resourcesDir: string, env: NodeJS.ProcessEnv = process.env): DesktopConfig {
  let fromFile: Partial<DesktopConfig> = {};
  const file = path.join(resourcesDir, CONFIG_FILE);
  try {
    if (fs.existsSync(file)) fromFile = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DesktopConfig>;
  } catch (err) {
    console.warn(`[config] ignoring ${file}: ${(err as Error).message}`);
  }
  const fromEnv: Partial<DesktopConfig> = {
    ...(env.LINES_RELAY_URL ? { relayUrl: env.LINES_RELAY_URL } : {}),
    ...(env.LINES_STORAGE_URL ? { storageUrl: env.LINES_STORAGE_URL } : {}),
    ...(env.LINES_WEB_URL ? { webUrl: env.LINES_WEB_URL } : {}),
    ...(env.LINES_UPDATE_FEED_URL ? { updateFeedUrl: env.LINES_UPDATE_FEED_URL } : {}),
    ...(env.LINES_DOWNLOAD_URL ? { downloadUrl: env.LINES_DOWNLOAD_URL } : {}),
  };
  return { ...DEFAULT_CONFIG, ...fromFile, ...fromEnv };
}

/**
 * Local mode: serve the web bundle ourselves and open a window, the way the app
 * behaved before a relay existed. Explicitly opt-in now — a downloaded DMG must
 * come up hosted, and `web/dist` is not even in it — and the `dev` script is
 * what sets this so a repo checkout keeps its old behaviour.
 */
export function isLocalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LINES_LOCAL_MODE === '1';
}
