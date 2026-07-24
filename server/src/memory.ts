import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MemoryFileMap } from '@lines/shared';
import type { MemoryManifest, Store } from './store.ts';
import type { ProjectKeyRegistry } from './projectKeys.ts';

const ENTRY_MAX_BYTES = 256 * 1024;
const TOTAL_MAX_BYTES = 1.5 * 1024 * 1024;

/**
 * The slug the Claude CLI derives from an absolute path for its
 * `~/.claude/projects/<slug>/` dirs: every non-alphanumeric char becomes `-`
 * (e.g. `/Users/x/y` -> `-Users-x-y`). CLI-internal — re-verify on SDK upgrades.
 */
export function slugForPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function statSafe(abs: string): fs.Stats | null {
  try {
    return fs.statSync(abs);
  } catch {
    return null;
  }
}

function readSafe(abs: string): string | null {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Recursively collect regular-file absolute paths under `dir`. */
function walkFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

/**
 * Syncs the allowlisted agent-memory locations under `~/.claude` to/from the
 * cross-machine map. The SDK reads memory only off disk, so disk stays the
 * SDK-facing cache; this class collects local changes to push and applies remote
 * changes back, per-file last-write-wins by file mtime. `claudeDir` is injectable
 * so a scratch dir can stand in for `~/.claude` in tests.
 */
export class MemorySyncer {
  private userMemory: string;
  private projectsDir: string;
  private warned = false;

  constructor(
    private store: Store,
    private projectKeys: ProjectKeyRegistry,
    claudeDir = path.join(os.homedir(), '.claude'),
  ) {
    this.userMemory = path.join(claudeDir, 'CLAUDE.md');
    this.projectsDir = path.join(claudeDir, 'projects');
  }

  /** slug (as the CLI writes it) -> machine-independent project key. */
  private slugToKey(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [cwd, key] of Object.entries(this.projectKeys.all())) map[slugForPath(cwd)] = key;
    return map;
  }

  /** Every synced memory file present on disk right now, with its sync key. */
  private listFiles(): { abs: string; key: string }[] {
    const out: { abs: string; key: string }[] = [];
    if (fs.existsSync(this.userMemory)) out.push({ abs: this.userMemory, key: 'user/CLAUDE.md' });

    const slugKey = this.slugToKey();
    let slugs: fs.Dirent[];
    try {
      slugs = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const d of slugs) {
      if (!d.isDirectory()) continue;
      const memDir = path.join(this.projectsDir, d.name, 'memory');
      const projectKey = slugKey[d.name];
      for (const abs of walkFiles(memDir)) {
        const rel = path.relative(memDir, abs).split(path.sep).join('/');
        const key = projectKey ? `project/${projectKey}/memory/${rel}` : `slug/${d.name}/memory/${rel}`;
        out.push({ abs, key });
      }
    }
    return out;
  }

  /** Local abs path(s) a synced key maps to on this machine (project keys can hit several checkouts). */
  private targetsForKey(key: string): string[] {
    if (key === 'user/CLAUDE.md') return [this.userMemory];
    const proj = /^project\/(.+?)\/memory\/(.+)$/.exec(key);
    if (proj) {
      const [, projectKey, rel] = proj;
      return Object.entries(this.projectKeys.all())
        .filter(([, k]) => k === projectKey)
        .map(([cwd]) => path.join(this.projectsDir, slugForPath(cwd), 'memory', rel));
    }
    const slug = /^slug\/(.+?)\/memory\/(.+)$/.exec(key);
    if (slug) return [path.join(this.projectsDir, slug[1], 'memory', slug[2])];
    return [];
  }

  /** Full snapshot for a fresh push (syncNow). Applies per-file and total-size caps. */
  collectAll(): MemoryFileMap {
    const map: MemoryFileMap = {};
    const sizes: { key: string; size: number }[] = [];
    let total = 0;
    for (const { abs, key } of this.listFiles()) {
      const stat = statSafe(abs);
      if (!stat) continue;
      if (stat.size > ENTRY_MAX_BYTES) continue;
      const content = readSafe(abs);
      if (content == null) continue;
      map[key] = { content, updatedAt: Math.round(stat.mtimeMs) };
      sizes.push({ key, size: stat.size });
      total += stat.size;
    }
    // Total-size guard: drop largest until under the cap (never ship > express limit).
    if (total > TOTAL_MAX_BYTES) {
      sizes.sort((a, b) => b.size - a.size);
      for (const { key, size } of sizes) {
        if (total <= TOTAL_MAX_BYTES) break;
        delete map[key];
        total -= size;
        this.warnOnce(`memory too large — skipping ${key}`);
      }
    }
    return map;
  }

  /**
   * Files changed since the last sync (mtime/size diff vs the manifest), plus
   * tombstones for files that vanished. Rewrites the manifest to the current disk
   * state so unchanged files don't re-push. Returns null when nothing changed.
   */
  collectChanged(): MemoryFileMap | null {
    const manifest = this.store.loadMemoryManifest();
    const next: MemoryManifest = {};
    const changed: MemoryFileMap = {};
    const seen = new Set<string>();

    for (const { abs, key } of this.listFiles()) {
      const stat = statSafe(abs);
      if (!stat || stat.size > ENTRY_MAX_BYTES) continue;
      seen.add(abs);
      const mtimeMs = Math.round(stat.mtimeMs);
      next[abs] = { key, mtimeMs, size: stat.size };
      const prev = manifest[abs];
      if (prev && prev.mtimeMs === mtimeMs && prev.size === stat.size) continue;
      const content = readSafe(abs);
      if (content == null) continue;
      changed[key] = { content, updatedAt: mtimeMs };
    }

    // Files the manifest knew but that are gone now -> tombstones.
    for (const [abs, entry] of Object.entries(manifest)) {
      if (seen.has(abs) || fs.existsSync(abs)) continue;
      changed[entry.key] = { content: '', updatedAt: Date.now(), deleted: true };
    }

    this.store.saveMemoryManifest(next);
    return Object.keys(changed).length ? changed : null;
  }

  /**
   * Write remote entries that are newer than the local copy (create dirs as
   * needed); delete on a tombstone newer than the local file. Local-newer files
   * are left for the next push. The written file's mtime is stamped to the
   * remote updatedAt so the manifest stays consistent and the write can't bounce
   * back up as a fresh change.
   */
  applyRemote(remote: MemoryFileMap): void {
    if (!remote) return;
    const manifest = this.store.loadMemoryManifest();
    let dirty = false;

    for (const [key, entry] of Object.entries(remote)) {
      if (!entry || typeof entry.updatedAt !== 'number') continue;
      for (const abs of this.targetsForKey(key)) {
        const stat = statSafe(abs);
        const localMtime = stat ? Math.round(stat.mtimeMs) : 0;

        if (entry.deleted) {
          if (stat && localMtime < entry.updatedAt) {
            try {
              fs.rmSync(abs, { force: true });
              delete manifest[abs];
              dirty = true;
            } catch (err) {
              this.warnOnce(`memory delete failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          continue;
        }

        if (Buffer.byteLength(entry.content, 'utf8') > ENTRY_MAX_BYTES) continue;
        if (stat && localMtime >= entry.updatedAt) continue; // local same or newer — keep it
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, entry.content);
          const t = entry.updatedAt / 1000;
          fs.utimesSync(abs, t, t);
          const ns = statSafe(abs);
          manifest[abs] = {
            key,
            mtimeMs: ns ? Math.round(ns.mtimeMs) : entry.updatedAt,
            size: ns?.size ?? Buffer.byteLength(entry.content, 'utf8'),
          };
          dirty = true;
        } catch (err) {
          this.warnOnce(`memory write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (dirty) this.store.saveMemoryManifest(manifest);
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[memory] ${msg}`);
  }
}
