/**
 * Post-process `codex app-server generate-ts` output so it compiles here.
 *
 * ts-rs emits extensionless relative imports (`from "./ThreadId"`), which
 * `moduleResolution: nodenext` rejects outright. This repo's own convention is an
 * explicit `.ts` (see `allowImportingTsExtensions` in the tsconfigs), so the fix
 * is mechanical and belongs in the generate step rather than in 711 hand edits.
 *
 * Idempotent: a path that already carries an extension is left alone, so running
 * it twice over the same tree is a no-op.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: normalize-codex-protocol.mjs <dir>');
  process.exit(1);
}

/** `from "./X"` / `from "../y/X"` -> the same with `.ts`. */
const IMPORT_RE = /(from\s+")(\.\.?\/[^"]+)(")/g;

/**
 * The specifier to write for one relative import. A directory (`./v2`, the
 * namespace re-export at the root) resolves to its `index.ts`; everything else
 * takes a plain `.ts`.
 */
function resolveSpecifier(fromFile, spec) {
  if (path.extname(spec)) return spec;
  const target = path.resolve(path.dirname(fromFile), spec);
  const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
  return isDir ? `${spec}/index.ts` : `${spec}.ts`;
}

let touched = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const before = fs.readFileSync(full, 'utf8');
    const after = before.replace(IMPORT_RE, (whole, pre, spec, post) => {
      const resolved = resolveSpecifier(full, spec);
      return resolved === spec ? whole : `${pre}${resolved}${post}`;
    });
    if (after !== before) {
      fs.writeFileSync(full, after);
      touched++;
    }
  }
}

walk(root);
console.log(`normalized ${touched} generated file(s) under ${root}`);
