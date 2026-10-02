/**
 * Strip the package manifests and the lockfile down to what `npm ci` installs,
 * so the image's `deps` layer changes only when the dependency tree does.
 *
 * Runs in the Dockerfile's `manifests` stage, over copies of the root manifest,
 * every workspace manifest and the lockfile. Without it, a desktop version bump
 * or a `scripts` edit invalidates `deps`: npm ci reruns, and the registry and
 * the VPS each move a fresh ~230 MB layer for an unchanged dependency tree.
 *
 * - `version` becomes "0.0.0" in every manifest, and in the lockfile's top level
 *   and its root and workspace entries. That is only safe while every internal
 *   (`@lines/*`) dependency spec is "*", which is checked below: a pinned spec
 *   that 0.0.0 no longer satisfies sends npm to the registry for the package.
 * - `scripts` and `build` (desktop's electron-builder config) are dropped. npm
 *   ci runs with --ignore-scripts, so neither one affects the install.
 *
 * A stage that runs a workspace script or reads a workspace's version must COPY
 * that workspace first, which puts its real manifest back.
 *
 * Rewrites the files in place: point it at a throwaway copy, never a checkout.
 */
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`normalize-manifests: ${message}`);
  process.exit(1);
}

const root = process.argv[2];
if (!root) fail('usage: normalize-manifests.mjs <root dir>');

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const writeJson = (file, value) =>
  fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + '\n');

/** Relative, no globs, no `.` or `..` segments: each entry is also its lockfile key. */
const PLAIN_DIR = /^[\w-]+(?:[./][\w-]+)*$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const { workspaces } = readJson('package.json');
if (!Array.isArray(workspaces) || !workspaces.every((dir) => typeof dir === 'string' && PLAIN_DIR.test(dir))) {
  fail('root package.json "workspaces" must be a plain list of directories');
}
const dirs = ['', ...workspaces];

for (const dir of dirs) {
  const file = path.join(dir, 'package.json');
  const manifest = readJson(file);
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith('@lines/') && spec !== '*') {
        fail(`${file}: ${field} pins ${name}@${spec}, but internal specs must be "*" to accept version 0.0.0`);
      }
    }
  }
  manifest.version = '0.0.0';
  delete manifest.scripts;
  delete manifest.build;
  writeJson(file, manifest);
}

// npm ci reads workspace versions from the manifests on disk, so the install
// does not need these. They are pinned because a commit that only syncs them
// would otherwise still change the layer's input.
const lock = readJson('package-lock.json');
lock.version = '0.0.0';
// Exact keys, never a prefix match: nested installs such as
// `desktop/node_modules/esbuild` share a workspace's prefix.
for (const dir of dirs) {
  const entry = lock.packages?.[dir];
  if (!entry) fail(`package-lock.json has no packages["${dir}"] entry`);
  entry.version = '0.0.0';
}
writeJson('package-lock.json', lock);
