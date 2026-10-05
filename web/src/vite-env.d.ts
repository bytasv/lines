/// <reference types="vite/client" />

/** Web bundle version, injected by vite.config.ts `define` — see WEB_VERSION there. */
declare const __LINES_VERSION__: string;

/** `changelog.json` at the repo root, injected by vite.config.ts `define` — see CHANGELOG there. */
declare const __LINES_CHANGELOG__: import('@lines/shared').Changelog;
