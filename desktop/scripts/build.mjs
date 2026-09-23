#!/usr/bin/env node
/**
 * Builds everything that goes inside the app bundle.
 *
 * Four artifacts (plus the bundled whisper-cli, see build-whisper.mjs), because the shipped app is three processes plus one thing a
 * process spawns:
 *   dist/main.cjs              — the Electron shell (CJS; Electron's main process)
 *   dist/server/bridge.mjs      — the bridge, as a single ESM file
 *   dist/server/worker.mjs      — the worker, ditto
 *   dist/server/linesMcpStdio.mjs — codex's Lines MCP server, spawned BY the
 *     bridge (not the shell) as its own process; see linesMcpServerConfig in
 *     server/src/linesMcpStdio.ts for why this can't just be a codepath inside
 *     bridge.mjs.
 *
 * ESM for the two server bundles is not a preference: `server` and `shared` are
 * both `"type": "module"` and use `import.meta.dirname`, which is `undefined` in
 * CJS and throws at import time.
 *
 * The Claude Agent SDK stays external. `sdk.mjs` resolves things through
 * `createRequire(import.meta.url)`, so bundling it moves that anchor into our
 * output and breaks it — the real package is copied next to the bundles instead.
 * Its 231 MB `-darwin-arm64` platform sibling is deliberately NOT copied: every
 * query passes `pathToClaudeCodeExecutable` (see server/src/claudeCli.ts), so the
 * SDK's own binary resolver never runs, and that omission is what keeps the DMG
 * a sane size.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { buildWhisper } from './build-whisper.mjs';

const DESKTOP = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(DESKTOP, '..');
const DIST = path.join(DESKTOP, 'dist');
const SERVER_OUT = path.join(DIST, 'server');

const VERSION = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).version;

/**
 * Bundled CJS dependencies (ws, @clerk/backend, dotenv) can call `require` at
 * runtime; an ESM output has none. This is the standard shim, and `require` is a
 * free name because esbuild calls its own helper `__require`.
 */
const ESM_REQUIRE_SHIM =
  "import{createRequire as __linesCreateRequire}from'node:module';" +
  'const require=__linesCreateRequire(import.meta.url);';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  logLevel: 'info',
  // Kept readable on purpose: a release artifact someone has to debug from a
  // user's machine is worth more than the few hundred kB minifying would save.
  minify: false,
  sourcemap: false,
};

/** The Electron shell. Electron and the updater are provided by the runtime. */
async function buildShell() {
  await build({
    ...common,
    entryPoints: [path.join(DESKTOP, 'src', 'main.ts')],
    outfile: path.join(DIST, 'main.cjs'),
    format: 'cjs',
    external: ['electron', 'electron-updater'],
    // `dev` runs `electron dist/main.cjs` — a *file* argument, so Electron never
    // reads desktop/package.json and `app.getVersion()` answers with Electron's
    // own version. This is the only way the tray can state the real one.
    define: { __LINES_VERSION__: JSON.stringify(VERSION) },
  });
}

/** The bridge and the worker, each one file. */
async function buildServer(name, entry) {
  await build({
    ...common,
    entryPoints: [path.join(REPO, 'server', 'src', entry)],
    outfile: path.join(SERVER_OUT, `${name}.mjs`),
    format: 'esm',
    external: ['@anthropic-ai/claude-agent-sdk'],
    banner: { js: ESM_REQUIRE_SHIM },
    // The bundle has no package.json beside it to read a version from.
    define: { __LINES_VERSION__: JSON.stringify(VERSION) },
  });
}

/**
 * Locate an installed package on disk, walking the node_modules chain the way
 * node would. Deliberately not `require.resolve`: the SDK's `exports` map has no
 * `./package.json` entry, so resolving through it throws.
 */
function findPackageDir(name) {
  let dir = DESKTOP;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Copy a package and everything it declares as a runtime dependency into the
 * shipped tree. Walked rather than hand-listed so a new transitive dep does not
 * become a runtime `ERR_MODULE_NOT_FOUND` on a user's machine; optional deps are
 * skipped, which is what excludes the platform binaries.
 */
function copyPackages(names, dest, seen = new Set()) {
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const from = findPackageDir(name);
    if (!from) {
      // Not installed: either an optional peer the SDK never reaches, or a dep
      // only used on another platform. Loud, because the alternative is a
      // packaged app that fails at first turn.
      console.warn(`[package] ${name} not resolvable — skipped`);
      continue;
    }
    const manifest = path.join(from, 'package.json');
    const to = path.join(dest, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, dereference: true });
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    copyPackages(Object.keys(pkg.dependencies ?? {}), dest, seen);
  }
}

function writeRuntimeModules() {
  const modules = path.join(SERVER_OUT, 'node_modules');
  fs.rmSync(modules, { recursive: true, force: true });
  fs.mkdirSync(modules, { recursive: true });
  copyPackages(['@anthropic-ai/claude-agent-sdk'], modules);
  // `sdk.mjs` emits ajv-based validators for tool schemas; ajv is not one of its
  // declared dependencies, so the walk above never reaches it.
  copyPackages(['ajv', 'ajv-formats'], modules);
  // A package.json marks the directory ESM, so `bridge.mjs`/`worker.mjs` and the
  // SDK's own `.mjs` resolve as modules rather than by extension guesswork.
  fs.writeFileSync(
    path.join(SERVER_OUT, 'package.json'),
    `${JSON.stringify({ name: 'lines-server-runtime', private: true, version: VERSION, type: 'module' }, null, 2)}\n`,
  );
}

/**
 * The shipped `config.json`. Defaults live in `src/config.ts`; this only writes
 * the keys the release build was told to override, so an unset environment
 * produces a file that says "production" without repeating the URLs.
 */
function writeConfig() {
  const overrides = {};
  for (const [key, env] of [
    ['relayUrl', 'LINES_RELAY_URL'],
    ['storageUrl', 'LINES_STORAGE_URL'],
    ['webUrl', 'LINES_WEB_URL'],
    ['updateFeedUrl', 'LINES_UPDATE_FEED_URL'],
    ['downloadUrl', 'LINES_DOWNLOAD_URL'],
  ]) {
    if (process.env[env]) overrides[key] = process.env[env];
  }
  fs.writeFileSync(path.join(DIST, 'config.json'), `${JSON.stringify(overrides, null, 2)}\n`);
}

const shellOnly = process.argv.includes('--shell-only');

fs.mkdirSync(SERVER_OUT, { recursive: true });
await buildShell();
if (!shellOnly) {
  await buildServer('bridge', 'index.ts');
  await buildServer('worker', 'worker.ts');
  await buildServer('linesMcpStdio', 'linesMcpStdio.ts');
  writeRuntimeModules();
  writeConfig();
  // Voice input's transcriber, so a user never needs Homebrew for it.
  buildWhisper();
}
