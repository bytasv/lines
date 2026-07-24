import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ProjectKeyMap } from '@lines/shared';
import type { Store } from './store.ts';

/**
 * Normalize a git remote URL to a host/path identity, so the same repo reached
 * over SSH and HTTPS resolves to one key.
 *
 *   git@github.com:bytasv/lines.git     -> github.com/bytasv/lines
 *   https://github.com/bytasv/lines.git -> github.com/bytasv/lines
 *   ssh://git@github.com/bytasv/lines   -> github.com/bytasv/lines
 */
export function normalizeRemote(url: string): string | null {
  let rest = url.trim();
  if (!rest) return null;
  // scp-style (host:path) has no scheme; everything else does.
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(rest);
  if (scp) rest = `${scp[1]}/${scp[2]}`;
  else {
    rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
    if (!rest.includes('/')) return null;
  }
  rest = rest.replace(/\.git$/i, '').replace(/\/+$/, '');
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  // Host is case-insensitive; the path after it is not (GitHub preserves case).
  return rest.slice(0, slash).toLowerCase() + rest.slice(slash);
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Stable identity for a working directory, or null when there's nothing to key
 * off (not a repo, or no remote). The in-repo prefix is part of the key so that
 * sibling packages in one monorepo stay distinct projects.
 */
export function resolveProjectKey(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const remote = git(dir, ['remote', 'get-url', 'origin']);
  if (!remote) return null;
  const key = normalizeRemote(remote);
  if (!key) return null;
  const prefix = (git(dir, ['rev-parse', '--show-prefix']) ?? '').replace(/\/+$/, '');
  return prefix ? `${key}#${prefix}` : key;
}

/**
 * The user's cwd -> project-key map: learned from checkouts this machine can
 * see, unioned with what other machines have learned, and persisted so a path
 * that later disappears keeps its identity.
 */
export class ProjectKeyRegistry {
  private keys: ProjectKeyMap;

  constructor(
    private store: Store,
    private onChange: (keys: ProjectKeyMap) => void,
  ) {
    this.keys = store.loadProjectKeys();
  }

  all(): ProjectKeyMap {
    return { ...this.keys };
  }

  keyFor(cwd: string): string | null {
    return this.keys[cwd] ?? null;
  }

  /** Resolve `cwd` if we haven't already; returns the key (existing or fresh). */
  learn(cwd: string): string | null {
    const known = this.keys[cwd];
    if (known) return known;
    const key = resolveProjectKey(cwd);
    if (key) this.set(cwd, key);
    return key;
  }

  set(cwd: string, key: string): void {
    if (this.keys[cwd] === key) return;
    this.keys[cwd] = key;
    this.persist();
  }

  /**
   * Resolve every cwd we've never seen before. Paths that don't exist on this
   * machine simply stay unresolved until the machine that owns them syncs.
   */
  learnAll(cwds: Iterable<string>): void {
    let changed = false;
    for (const cwd of cwds) {
      if (!cwd || this.keys[cwd]) continue;
      const key = resolveProjectKey(cwd);
      if (key) {
        this.keys[cwd] = key;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Union in a pulled map. Local entries win — they were resolved from a real checkout. */
  merge(remote: ProjectKeyMap | null | undefined): void {
    if (!remote) return;
    let changed = false;
    for (const [cwd, key] of Object.entries(remote)) {
      if (typeof key !== 'string' || !key || this.keys[cwd]) continue;
      this.keys[cwd] = key;
      changed = true;
    }
    if (changed) this.persist();
  }

  private persist(): void {
    this.store.saveProjectKeys(this.keys);
    this.onChange(this.all());
  }
}
