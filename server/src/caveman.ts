import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { store } from './store.ts';
import type { CavemanLevel } from '@claude-ui/shared';

const REPO_URL = 'https://github.com/JuliusBrussee/caveman.git';
const VENDOR_DIR = path.join(store.rootDir, 'plugins', 'caveman-repo');

let resolvedPluginPath: string | null | undefined;

/** Find the directory containing a Claude Code plugin manifest inside a checkout. */
function findPluginDir(root: string): string | null {
  const candidates = [root];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.git')) {
        candidates.push(path.join(root, entry.name));
        try {
          for (const sub of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
            if (sub.isDirectory()) candidates.push(path.join(root, entry.name, sub.name));
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    return null;
  }
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json')) ||
      fs.existsSync(path.join(dir, 'plugin.json'))
    ) {
      return dir;
    }
  }
  return null;
}

/**
 * Returns a local path to the caveman plugin, cloning it on first use.
 * Returns null when the plugin cannot be obtained (offline, git missing) —
 * callers then fall back to the embedded system-prompt instructions.
 */
export function getCavemanPluginPath(): string | null {
  if (resolvedPluginPath !== undefined) return resolvedPluginPath;
  try {
    if (!fs.existsSync(VENDOR_DIR)) {
      fs.mkdirSync(path.dirname(VENDOR_DIR), { recursive: true });
      execFileSync('git', ['clone', '--depth', '1', REPO_URL, VENDOR_DIR], {
        stdio: 'ignore',
        timeout: 30_000,
      });
    }
    resolvedPluginPath = findPluginDir(VENDOR_DIR);
  } catch (err) {
    console.warn('[caveman] vendoring failed, falling back to prompt injection:', err);
    resolvedPluginPath = null;
  }
  return resolvedPluginPath;
}

/** Fallback when the plugin can't be loaded: equivalent instructions appended to the system prompt. */
export function cavemanPromptFallback(level: CavemanLevel): string {
  const intensity =
    level === 'lite'
      ? 'Moderate compression: drop pleasantries and filler, keep full sentences where clarity needs them.'
      : level === 'ultra'
        ? 'Maximum brevity: telegraphic fragments only, every non-essential word dies.'
        : 'Aggressive compression: drop articles (a/an/the), filler words, pleasantries, hedging. Fragments OK.';
  return [
    'CAVEMAN MODE ACTIVE — respond terse like smart caveman. All technical substance stays; only fluff dies.',
    intensity,
    'Rules: short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact. Code, commits, and PR text are written normally.',
    'Pattern: [thing] [action] [reason]. [next step].',
    'Stay active every response; never drift back to verbose style.',
  ].join('\n');
}
