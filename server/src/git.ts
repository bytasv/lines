import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const MAX_BUFFER = 12 * 1024 * 1024;
const MAX_UNTRACKED = 50;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec('git', args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    // `git diff --no-index` exits non-zero when files differ but still prints the
    // diff on stdout — recover it. Everything else (not a repo, git missing) → ''.
    const stdout = (err as { stdout?: unknown })?.stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

/** A non-destructive snapshot of the working tree at workflow start, so step
 *  diffs show only what the workflow changed — not pre-existing dirty state. */
export interface DiffBaseline {
  /** Commit-ish to diff tracked changes against (a `git stash create` SHA, or 'HEAD'). */
  ref: string;
  /** Untracked files that already existed at start — excluded from step diffs. */
  untracked: string[];
}

async function listUntracked(cwd: string): Promise<string[]> {
  return (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Snapshot the current working tree without touching it. `git stash create`
 * records tracked modifications as a dangling commit (empty output when clean);
 * we fall back to HEAD. Untracked files are recorded so newly-created ones can be
 * told apart later. Safe on a non-repo (returns { ref: 'HEAD', untracked: [] }).
 */
export async function captureBaseline(cwd: string): Promise<DiffBaseline> {
  const created = (await git(cwd, ['stash', 'create'])).trim();
  return { ref: created || 'HEAD', untracked: await listUntracked(cwd) };
}

/**
 * Working-tree diff used to seed a fresh workflow step: tracked changes since
 * `baseline` (or HEAD) plus files created since it. Returns '' when nothing
 * changed, `cwd` is not a git repo, or git is unavailable.
 */
export async function workingTreeDiff(cwd: string, baseline?: DiffBaseline): Promise<string> {
  const parts: string[] = [];

  const tracked = (await git(cwd, ['diff', baseline?.ref ?? 'HEAD'])).trim();
  if (tracked) parts.push(tracked);

  const preexisting = new Set(baseline?.untracked ?? []);
  const untracked = (await listUntracked(cwd)).filter((f) => !preexisting.has(f));

  for (const file of untracked.slice(0, MAX_UNTRACKED)) {
    const d = (await git(cwd, ['diff', '--no-index', '--', '/dev/null', file])).trim();
    if (d) parts.push(d);
  }
  if (untracked.length > MAX_UNTRACKED) {
    parts.push(`# … ${untracked.length - MAX_UNTRACKED} more untracked files omitted from the diff`);
  }

  return parts.join('\n');
}
