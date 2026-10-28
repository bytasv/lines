import changelog from '../../changelog.json';
import pkg from '../../web/package.json';

// web/vite.config.ts `define`s these two at build time; the islands are not
// built with that config, so they would be undeclared globals. Same values:
// the web package's version and the repo-root changelog.
const g = globalThis as { __LINES_VERSION__?: string; __LINES_CHANGELOG__?: unknown };
g.__LINES_VERSION__ ??= pkg.version;
g.__LINES_CHANGELOG__ ??= changelog;
