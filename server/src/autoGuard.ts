import path from 'node:path';
import os from 'node:os';
import type { Store } from './store.ts';

/**
 * Local replica of Claude Code CLI's auto-mode boundaries, without the
 * classifier model: pattern rules over tool inputs. Safe calls auto-approve;
 * anything matching a rule below is escalated to the user with the reason.
 *
 * Mirrors the CLI's documented soft-block list: force push, curl|bash,
 * destructive filesystem/git operations, production deploys, publishing,
 * secrets access, and writes escaping the working directory.
 */

export interface GuardVerdict {
  dangerous: boolean;
  reason?: string;
}

interface BashRule {
  pattern: RegExp;
  reason: string;
}

const BASH_RULES: BashRule[] = [
  // Filesystem destruction
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, reason: 'Recursive/forced file deletion (rm -rf)' },
  { pattern: /\brm\s+.*\*/, reason: 'File deletion with glob pattern' },
  { pattern: /\b(rmdir|shred|srm)\b/, reason: 'Directory/file destruction' },
  { pattern: /\bfind\b.*-delete\b/, reason: 'Bulk deletion via find -delete' },
  { pattern: /\b(mkfs|diskutil\s+erase|fdisk|dd\s+.*of=)/i, reason: 'Disk-level operation' },
  { pattern: />\s*\/dev\/(sd|disk|null\b.*<)/, reason: 'Raw device write' },

  // Privilege / system state
  { pattern: /\bsudo\b/, reason: 'Privilege escalation (sudo)' },
  { pattern: /\bchmod\s+(-[a-z]+\s+)*[0-7]*777\b/, reason: 'World-writable permissions' },
  { pattern: /\b(chown|chmod)\s+-[a-z]*r/i, reason: 'Recursive ownership/permission change' },
  { pattern: /\b(shutdown|reboot|halt|launchctl|systemctl)\b/, reason: 'System service / power control' },
  { pattern: /\bkill(all)?\s+(-9\s+)?[0-9a-z]/i, reason: 'Killing processes' },
  { pattern: /\bcrontab\b/, reason: 'Scheduling persistent jobs' },

  // Git dangers
  { pattern: /\bgit\s+push\b.*(--force|-f\b|--delete)/, reason: 'Force/delete git push' },
  { pattern: /\bgit\s+push\b.*\b(prod|production|release|gh-pages)\b/, reason: 'Push to deploy branch' },
  { pattern: /\bgit\s+reset\s+--hard/, reason: 'Hard git reset (discards work)' },
  { pattern: /\bgit\s+clean\b.*-[a-z]*f/, reason: 'git clean -f (deletes untracked files)' },
  { pattern: /\bgit\s+branch\s+-D\b/, reason: 'Force-deleting a branch' },
  { pattern: /\bgit\s+(rebase|filter-branch|reflog\s+expire)\b/, reason: 'History rewrite' },

  // Remote code execution
  { pattern: /\b(curl|wget)\b[^|;&]*\|\s*(ba|z|fi|da)?sh\b/, reason: 'Piping a download into a shell (curl | bash)' },
  // Plain `npx <bin>` runs project-local binaries and is routine; only
  // auto-installing remote packages is flagged.
  { pattern: /\b(npx|uvx|bunx)\s+(-y\b|--yes\b|[a-z0-9@-]*(github:|https?:))/i, reason: 'Auto-installing and executing a remote package' },

  // Publishing / deploys
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/, reason: 'Publishing a package' },
  { pattern: /\b(twine\s+upload|gem\s+push|cargo\s+publish|goreleaser)\b/, reason: 'Publishing a package' },
  { pattern: /\b(terraform|tofu|pulumi)\s+(apply|destroy)\b/, reason: 'Infrastructure change' },
  { pattern: /\bkubectl\s+(delete|apply|drain|scale)\b/, reason: 'Kubernetes state change' },
  { pattern: /\baws\s+s3\s+(rm|rb|sync|cp)\b/, reason: 'Cloud bucket write/delete' },
  { pattern: /\b(gcloud|az)\b.*\b(delete|deploy|create)\b/, reason: 'Cloud resource change' },
  { pattern: /\b(vercel|netlify|fly|heroku|railway)\b.*\b(deploy|--prod)/i, reason: 'Production deploy' },

  // Secrets / exfiltration
  { pattern: /~\/\.(ssh|aws|gnupg|netrc|npmrc|pypirc)\b/, reason: 'Access to credential files' },
  { pattern: /\b(security\s+find-generic-password|keychain)\b/i, reason: 'Keychain access' },
  { pattern: /\b(printenv|env)\b.*\|\s*(curl|nc|wget)/, reason: 'Environment exfiltration' },
  { pattern: /\bcurl\b.*(-T|--upload-file|-d\s*@|--data-binary\s*@)/, reason: 'Uploading local files to a remote host' },
  { pattern: /\b(scp|rsync)\b.*@/, reason: 'Copying files to a remote host' },
  { pattern: /\b(nc|ncat|netcat)\b/, reason: 'Raw network socket' },
  { pattern: /\bgh\s+(secret|repo\s+delete|release\s+create)\b/, reason: 'GitHub account state change' },

  // Package installs (supply chain)
  { pattern: /\b(npm|pnpm|yarn)\s+(i|install|add)\b\s+(?!(-D\s+)?$)/, reason: 'Installing new packages' },
  { pattern: /\bpip3?\s+install\b/, reason: 'Installing new packages' },
  { pattern: /\bbrew\s+(install|uninstall)\b/, reason: 'System package change' },
];

/** Tools that must always reach the user regardless of guard verdicts. */
export const ALWAYS_ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** User-built exceptions, persisted by the caller. */
export interface GuardAllowEntry {
  tool: string;
  /** For Bash: command prefix (first two tokens), e.g. "npx tsc". */
  prefix?: string;
}

/** Per-store allowlist of user-approved exceptions, persisted via the injected Store. */
export class GuardAllowlist {
  private entries: GuardAllowEntry[];

  constructor(private store: Store) {
    this.entries = store.loadGuardAllowlist<GuardAllowEntry[]>([]);
  }

  list(): GuardAllowEntry[] {
    return this.entries;
  }

  /** Add an entry if absent; persists and returns true when it was new. */
  add(entry: GuardAllowEntry): boolean {
    if (this.entries.some((e) => e.tool === entry.tool && e.prefix === entry.prefix)) return false;
    this.entries = [...this.entries, entry];
    this.store.saveGuardAllowlist(this.entries);
    return true;
  }
}

/** Derive the allowlist entry an approved request should create. */
export function allowEntryFor(toolName: string, input: Record<string, unknown>): GuardAllowEntry {
  if (toolName === 'Bash') {
    const command = String(input.command ?? '').trim();
    const prefix = command.split(/&&|\|\||;/)[0].trim().split(/\s+/).slice(0, 2).join(' ');
    return { tool: 'Bash', prefix };
  }
  return { tool: toolName };
}

function segmentAllowed(segment: string, allowlist: GuardAllowEntry[]): boolean {
  return allowlist.some(
    (e) =>
      e.tool === 'Bash' &&
      e.prefix &&
      (segment === e.prefix || segment.startsWith(e.prefix + ' ')),
  );
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);

function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assessToolCall(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  allowlist: GuardAllowEntry[],
): GuardVerdict {
  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    // Evaluate each chained command separately (&&, ||, ;) so an allowlisted
    // prefix can't smuggle a dangerous follow-up past the rules. Pipes stay
    // inside their segment so pipe-based rules (curl | bash) still match.
    const segments = command.split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean);
    for (const segment of segments) {
      if (segmentAllowed(segment, allowlist)) continue;
      for (const rule of BASH_RULES) {
        if (rule.pattern.test(segment)) return { dangerous: true, reason: rule.reason };
      }
    }
    return { dangerous: false };
  }

  if (allowlist.some((e) => !e.prefix && e.tool === toolName)) return { dangerous: false };

  if (FILE_TOOLS.has(toolName)) {
    const filePath = String(input.file_path ?? input.notebook_path ?? '');
    if (filePath && !isInside(cwd, filePath)) {
      // Home-directory dotfiles and credentials are the riskiest targets.
      const home = os.homedir();
      const sensitive =
        isInside(path.join(home, '.ssh'), filePath) ||
        isInside(path.join(home, '.aws'), filePath) ||
        filePath.includes('.env');
      return {
        dangerous: true,
        reason: sensitive
          ? 'Touches credential/secret files outside the project'
          : 'File access outside the working directory',
      };
    }
    return { dangerous: false };
  }

  // Read-only / harness tools: allow.
  if (['Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'KillShell', 'TaskOutput'].includes(toolName)) {
    return { dangerous: false };
  }

  // Unknown tools (MCP etc.): allow reads, flag the rest conservatively.
  if (/read|list|get|search|view/i.test(toolName)) return { dangerous: false };
  return { dangerous: true, reason: `Unrecognized tool "${toolName}" — review before running` };
}

/**
 * Tools that only observe state (or track the agent's own todo list). Nothing
 * here mutates the repo, the network, or the machine.
 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'TaskOutput']);

/**
 * True when a call is a plain observation of project state. Used outside auto
 * mode, where the CLI otherwise prompts for every single call: after a plan is
 * approved the session drops to 'default' and each Read/Grep would ask again.
 *
 * Reuses assessToolCall, so reads escaping the working directory or touching
 * credential files still escalate, and allowlist entries are still honoured.
 */
export function isSafeReadOnly(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  allowlist: GuardAllowEntry[],
): boolean {
  if (ALWAYS_ASK_TOOLS.has(toolName) || !READ_ONLY_TOOLS.has(toolName)) return false;
  return !assessToolCall(toolName, input, cwd, allowlist).dangerous;
}
