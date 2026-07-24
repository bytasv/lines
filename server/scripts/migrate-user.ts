/**
 * Merge a legacy flat lines store into a user's namespaced store.
 *
 *   npm run migrate -w server -- <clerk-user-id> [--from <dir>]
 *
 * <dir> defaults to ~/.lines-app (this machine's flat store). Point --from
 * at another environment's copied store to migrate a second install —
 * every run APPENDS into ~/.lines-app/users/<id>:
 *   - sessions/workflows: union by id (existing target entries win)
 *   - recent-dirs/projects/guard-allowlist: set union
 *   - transcripts/attachments: copied unless already present
 *   - auth.json: copied only if the target has no login (tokens can't merge)
 * The source is read-only — nothing is deleted or moved.
 *
 * Run with the bridge STOPPED (it holds sessions in memory and whole-file
 * persists, which would clobber entries appended underneath it).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const userId = args[0];
const fromIdx = args.indexOf('--from');
const sourceRoot = path.resolve(
  fromIdx >= 0 && args[fromIdx + 1] ? args[fromIdx + 1] : path.join(os.homedir(), '.lines-app'),
);

if (!userId || userId.startsWith('--')) {
  console.error('usage: migrate-user.ts <clerk-user-id> [--from <legacy store dir>]');
  process.exit(1);
}

const targetRoot = path.join(os.homedir(), '.lines-app', 'users', userId);
if (path.resolve(targetRoot) === sourceRoot) {
  console.error('source and target are the same directory');
  process.exit(1);
}
if (!fs.existsSync(sourceRoot)) {
  console.error(`source not found: ${sourceRoot}`);
  process.exit(1);
}

async function bridgeRunning(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:8787/', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Union of two arrays of {id} objects; target entries win on collision. */
function mergeById<T extends { id: string }>(target: T[], source: T[]): { merged: T[]; added: number } {
  const seen = new Set(target.map((t) => t.id));
  const fresh = source.filter((s) => s.id && !seen.has(s.id));
  return { merged: [...target, ...fresh], added: fresh.length };
}

function mergeJsonById(name: string): void {
  const src = readJson<{ id: string }[]>(path.join(sourceRoot, name), []);
  if (src.length === 0) return void console.log(`  ${name}: source empty, skipped`);
  const dstFile = path.join(targetRoot, name);
  const { merged, added } = mergeById(readJson<{ id: string }[]>(dstFile, []), src);
  writeJson(dstFile, merged);
  console.log(`  ${name}: +${added} (now ${merged.length})`);
}

function mergeStringSet(name: string, cap?: number): void {
  const src = readJson<string[]>(path.join(sourceRoot, name), []);
  if (src.length === 0) return;
  const dstFile = path.join(targetRoot, name);
  const dst = readJson<string[]>(dstFile, []);
  let merged = [...dst, ...src.filter((s) => !dst.includes(s))];
  if (cap != null) merged = merged.slice(0, cap);
  writeJson(dstFile, merged);
  console.log(`  ${name}: now ${merged.length}`);
}

function mergeGuardAllowlist(): void {
  const name = 'guard-allowlist.json';
  interface Entry {
    tool: string;
    prefix?: string;
  }
  const src = readJson<Entry[]>(path.join(sourceRoot, name), []);
  if (src.length === 0) return;
  const dstFile = path.join(targetRoot, name);
  const dst = readJson<Entry[]>(dstFile, []);
  const has = (e: Entry) => dst.some((d) => d.tool === e.tool && d.prefix === e.prefix);
  const fresh = src.filter((e) => !has(e));
  writeJson(dstFile, [...dst, ...fresh]);
  console.log(`  ${name}: +${fresh.length} (now ${dst.length + fresh.length})`);
}

function copyAuthIfAbsent(): void {
  const src = path.join(sourceRoot, 'auth.json');
  const dst = path.join(targetRoot, 'auth.json');
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dst)) return void console.log('  auth.json: target already logged in, kept');
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o600);
  console.log('  auth.json: copied');
}

/** Copy dir entries (files or per-session dirs) that the target doesn't have yet. */
function copyDirAppend(name: string): void {
  const srcDir = path.join(sourceRoot, name);
  if (!fs.existsSync(srcDir)) return;
  const dstDir = path.join(targetRoot, name);
  fs.mkdirSync(dstDir, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(srcDir)) {
    const from = path.join(srcDir, entry);
    const to = path.join(dstDir, entry);
    if (fs.existsSync(to)) {
      skipped++;
      continue;
    }
    fs.cpSync(from, to, { recursive: true });
    copied++;
  }
  console.log(`  ${name}/: +${copied}${skipped ? ` (${skipped} already present, skipped)` : ''}`);
}

if (!args.includes('--force') && (await bridgeRunning())) {
  console.error(
    'The bridge is running on :8787 — stop it first (it whole-file persists from memory and would clobber appended entries).',
  );
  process.exit(1);
}

console.log(`Migrating ${sourceRoot} → ${targetRoot} (append)`);
fs.mkdirSync(targetRoot, { recursive: true });
mergeJsonById('sessions.json');
mergeJsonById('workflows.json');
mergeStringSet('recent-dirs.json', 10);
mergeStringSet('projects.json');
mergeGuardAllowlist();
copyAuthIfAbsent();
copyDirAppend('transcripts');
copyDirAppend('attachments');
console.log('Done. Source left untouched. Start the bridge and sign in to see the merged state.');
