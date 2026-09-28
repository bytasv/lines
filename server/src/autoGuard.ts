import path from 'node:path';
import os from 'node:os';
import {
  ALWAYS_ASK_TOOLS,
  diffAllowlists,
  normalizeAllowEntry,
  sameAllowEntry,
  type GuardAllowEntry,
  type GuardAllowlistBlob,
  type GuardAllowlistReview,
  type GuardEntryError,
} from '@lines/shared';
import type { GuardSyncState, Store } from './store.ts';

// Both moved to shared/ so the web client validates with the exact same rules;
// re-exported here because sessions.ts and the guard tests import them from this
// module, and a second definition is exactly the fork risk to avoid.
export { ALWAYS_ASK_TOOLS, type GuardAllowEntry };

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
  // Bash is deny-list only, so these auto-approve otherwise. `git worktree add`
  // and `list` are deliberately left alone: add is creative, and flagging it would
  // be inconsistent with `mkdir` outside the roots already being allowed. Lines'
  // own worktree actions go through worktreeCommands, not Bash, so these govern
  // only the agent running git itself.
  {
    pattern: /\bgit\s+worktree\s+(remove|prune)\b/,
    reason: 'Removing a git worktree (deletes its working files)',
  },
  { pattern: /\bgit\s+branch\s+(-d|--delete)\b/, reason: 'Deleting a branch' },
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

export type GuardAddResult = { ok: true } | { ok: false; reason: 'duplicate' | GuardEntryError };

/** Validate + dedupe an untrusted list (this disk, or a storage row) into canonical entries. */
function sanitizeEntries(raw: unknown): GuardAllowEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: GuardAllowEntry[] = [];
  for (const item of raw) {
    const norm = normalizeAllowEntry(item as { tool: string; prefix?: string });
    if ('error' in norm) continue;
    if (out.some((e) => sameAllowEntry(e, norm.entry))) continue;
    out.push(norm.entry);
  }
  return out;
}

/** Order-insensitive set equality — the only comparison divergence detection uses. */
function setEqual(a: GuardAllowEntry[], b: GuardAllowEntry[]): boolean {
  const { added, removed } = diffAllowlists(a, b);
  return added.length === 0 && removed.length === 0;
}

/**
 * Per-store allowlist of user-approved exceptions, persisted via the injected Store.
 *
 * Also owns the cross-machine review lifecycle: a remote list is *never* applied
 * silently. `reviewRemote` only stages a diff; entries change solely through
 * `add`, `remove`, and `acceptReview`.
 */
export class GuardAllowlist {
  private entries: GuardAllowEntry[];
  private syncState: GuardSyncState;

  /** Fired on every local list change — permission card, UI edit, or accepted review. */
  onChange?: (entries: GuardAllowEntry[]) => void;
  /** Fired when a remote divergence is staged, recomputed, or cleared. */
  onReview?: (review: GuardAllowlistReview | null) => void;

  constructor(private store: Store) {
    const raw = store.loadGuardAllowlist<unknown[]>([]);
    this.entries = sanitizeEntries(raw);
    // Load-time migration. The file was append-only and unvalidated before the
    // list became visible, so it can legitimately hold `{tool:'Bash',prefix:''}`,
    // ALWAYS_ASK entries the guard ignores, and whitespace near-duplicates.
    // Rewrite once, only when the sanitized form actually differs.
    if (JSON.stringify(raw) !== JSON.stringify(this.entries)) this.persistEntries();
    this.syncState = store.loadGuardSync();
    if (!this.syncState.updatedAt) {
      // No sync file yet (every install predating this feature). Stamp now, or the
      // storage row would be written with a 1970 timestamp and always lose its LWW.
      this.syncState = { ...this.syncState, updatedAt: Date.now() };
      this.persistSync();
    }
  }

  list(): GuardAllowEntry[] {
    return this.entries;
  }

  /** The synced form: entries plus the local-change timestamp that orders the storage row. */
  blob(): GuardAllowlistBlob {
    return { entries: this.entries, updatedAt: this.syncState.updatedAt };
  }

  get pendingReview(): boolean {
    return this.syncState.pending !== null;
  }

  /** Add an entry if absent. Normalizes internally, so every writer shares one gate. */
  add(entry: GuardAllowEntry): GuardAddResult {
    const norm = normalizeAllowEntry(entry);
    if ('error' in norm) return { ok: false, reason: norm.error };
    if (this.entries.some((e) => sameAllowEntry(e, norm.entry))) return { ok: false, reason: 'duplicate' };
    this.entries = [...this.entries, norm.entry];
    this.commit();
    return { ok: true };
  }

  /** Drop an entry; persists and returns true when one matched. */
  remove(entry: GuardAllowEntry): boolean {
    const next = this.entries.filter((e) => !sameAllowEntry(e, entry));
    if (next.length === this.entries.length) return false;
    this.entries = next;
    this.commit();
    return true;
  }

  /**
   * Compare a pulled remote list against the local one and stage a review when
   * they differ. Detection is a set difference, not last-write-wins: a fresh
   * machine has an empty list and a *newer* timestamp than a populated cloud, and
   * it must still ask rather than erase it.
   *
   * Never mutates `entries`, so it is safe to call inside the syncer's `applying`
   * window — `onChange`, and with it the push, is unreachable from here.
   */
  reviewRemote(remote: GuardAllowlistBlob | null): void {
    // An empty cloud is not a divergence; the caller's push bootstraps the row.
    if (!remote) {
      this.clearPending();
      return;
    }
    // Security boundary: a tampered row must not smuggle an odd-shaped or
    // ALWAYS_ASK entry as far as the UI, which is itself an attack surface.
    const entries = sanitizeEntries(remote.entries);
    if (setEqual(entries, this.entries)) {
      // Converged — also forget any rejection, so a later change prompts again.
      this.clearPending(true);
      return;
    }
    const rejected = this.syncState.rejected;
    if (rejected && setEqual(entries, rejected.entries)) {
      // "Keep mine" was already answered for exactly this remote content. Stay
      // quiet; the caller's push still retries overwriting the row.
      this.clearPending();
      return;
    }
    const pending = this.syncState.pending;
    this.syncState = {
      ...this.syncState,
      pending: {
        entries,
        remoteUpdatedAt: typeof remote.updatedAt === 'number' ? remote.updatedAt : 0,
        // Same remote content already pending: keep the original stamp, which is
        // the client's dedupe key for "don't re-open a modal I dismissed".
        detectedAt: pending && setEqual(pending.entries, entries) ? pending.detectedAt : Date.now(),
      },
      rejected: null, // remote moved on — an old answer no longer applies
    };
    this.persistSync();
    this.onReview?.(this.review());
  }

  /** The staged review with a freshly recomputed diff, so the UI never shows a stale one. */
  review(): GuardAllowlistReview | null {
    const pending = this.syncState.pending;
    if (!pending) return null;
    const { added, removed } = diffAllowlists(this.entries, pending.entries);
    return { entries: pending.entries, added, removed, detectedAt: pending.detectedAt };
  }

  /** Install the reviewed remote list — exactly what the user was shown, re-sanitized. */
  acceptReview(): boolean {
    const pending = this.syncState.pending;
    if (!pending) return false;
    // reviewRemote already sanitized what it staged, but the pending blob round-trips
    // through disk (loadGuardSync is unvalidated), so re-run the gate here: the
    // invariant "no ALWAYS_ASK / odd-shaped entry ever reaches list()" holds locally.
    this.entries = sanitizeEntries(pending.entries);
    this.syncState = { updatedAt: Date.now(), pending: null, rejected: null };
    this.persistEntries();
    this.persistSync();
    this.onChange?.(this.entries);
    this.onReview?.(null);
    return true;
  }

  /** Keep the local list and remember the answer, keyed on the remote *content*. */
  rejectReview(): boolean {
    const pending = this.syncState.pending;
    if (!pending) return false;
    const now = Date.now();
    // Entries are untouched, but updatedAt advances on purpose: "keep mine" only
    // converges the fleet if this list wins the row's LWW and gets pushed back over
    // the remote one. Keyed on content, so the same answer is never re-asked while
    // anything new still is.
    this.syncState = {
      updatedAt: now,
      pending: null,
      rejected: { entries: pending.entries, rejectedAt: now },
    };
    this.persistSync();
    this.onChange?.(this.entries); // idempotent client-side; also unblocks the push
    this.onReview?.(null); // closes the modal in this user's other tabs
    return true;
  }

  /** Persist a local change, notify, and re-evaluate any review against the new list. */
  private commit(): void {
    this.syncState = { ...this.syncState, updatedAt: Date.now() };
    this.persistEntries();
    const pending = this.syncState.pending;
    // A local edit can resolve the divergence outright, or merely change the diff
    // being asked about. Either way the UI only ever renders diff(local, remote).
    if (pending && setEqual(this.entries, pending.entries)) {
      this.syncState = { ...this.syncState, pending: null, rejected: null };
      this.persistSync();
      this.onChange?.(this.entries);
      this.onReview?.(null);
      return;
    }
    this.persistSync();
    this.onChange?.(this.entries);
    if (pending) this.onReview?.(this.review());
  }

  /** Drop a staged review (and optionally the remembered rejection); notifies only on change. */
  private clearPending(alsoRejected = false): void {
    const hadPending = this.syncState.pending !== null;
    const hadRejected = this.syncState.rejected !== null;
    if (!hadPending && !(alsoRejected && hadRejected)) return;
    this.syncState = {
      ...this.syncState,
      pending: null,
      rejected: alsoRejected ? null : this.syncState.rejected,
    };
    this.persistSync();
    if (hadPending) this.onReview?.(null);
  }

  // Persistence is best-effort: a throw here would take down the whole
  // buildUserContext, and the in-memory list still governs this run.
  private persistEntries(): void {
    try {
      this.store.saveGuardAllowlist(this.entries);
    } catch (err) {
      console.warn('[guard] could not persist allowlist:', err);
    }
  }

  private persistSync(): void {
    try {
      this.store.saveGuardSync(this.syncState);
    } catch (err) {
      console.warn('[guard] could not persist allowlist sync state:', err);
    }
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
const PLAN_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isInsideAny(dirs: string[], target: string): boolean {
  return dirs.some((dir) => isInside(dir, target));
}

/**
 * True when the target resolves inside a plan directory (~/.claude/plans or
 * `<root>/.claude/plans` for any of the session's roots). Anchored to real
 * directories rather than a substring match on the shared PLAN_DIR_MARKER, so
 * `.../plans/../../../.ssh/id_rsa` cannot pass.
 *
 * Exported because the `/file` HTTP route reuses it to let the plan review card
 * read a plan that lives outside every project root.
 */
export function isPlanPath(filePath: string, roots: string[]): boolean {
  const resolved = path.resolve(filePath);
  return (
    isInside(path.join(os.homedir(), '.claude', 'plans'), resolved) ||
    isInsideAny(roots.map((root) => path.join(root, '.claude', 'plans')), resolved)
  );
}

/**
 * The files that back the *running* worker process.
 *
 * Self-locating by default: the guard has no session or bridge identity, and the
 * only writes that kill this worker are writes to the files this bridge itself
 * runs from. `import.meta.dirname` is `server/src` under tsx watch, so a second
 * checkout of Lines is correctly unaffected — its paths don't match.
 *
 * A packaged build runs from a bundle instead, where that default matches
 * nothing and the rule silently no-ops. It fails safe (no spurious prompts) but
 * the protection is gone, so the desktop shell names the real files explicitly
 * in `LINES_WORKER_SOURCES` (delimited like a PATH). Read once at module load:
 * the set cannot change without a restart, which is when it is recomputed
 * anyway.
 */
const SELF_WORKER_SOURCES = new Set(
  (process.env.LINES_WORKER_SOURCES
    ? process.env.LINES_WORKER_SOURCES.split(path.delimiter).filter(Boolean)
    : ['worker.ts', 'workerProtocol.ts', 'workerMcp.ts'].map((f) => path.join(import.meta.dirname, f))
  ).map((file) => path.resolve(file)),
);

/**
 * True when the target is one of this bridge's own worker sources. Writing one
 * restarts the worker under tsx watch, which kills the very turn making the
 * edit — the incident this rule exists for.
 *
 * Exported so its test can assert directly, following `isPlanPath`.
 */
export function isSelfWorkerSource(filePath: string): boolean {
  return SELF_WORKER_SOURCES.has(path.resolve(filePath));
}

/**
 * @param roots Every directory this session may work in — its project's roots,
 *   primary first (see `rootsForCwd`, which never returns empty). An empty list
 *   escalates every file tool, which is the safe direction: the guard fails
 *   toward prompting the user.
 */
export function assessToolCall(
  toolName: string,
  input: Record<string, unknown>,
  roots: string[],
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

  // Deliberately above the allowlist short-circuit: a blanket `{ tool: 'Edit' }`
  // entry must not disarm the one write that kills the turn doing it. Writes
  // only — reading these files is harmless.
  if (PLAN_WRITE_TOOLS.has(toolName) && isSelfWorkerSource(String(input.file_path ?? input.notebook_path ?? ''))) {
    return {
      dangerous: true,
      reason: "Edits this bridge's worker source — the write restarts the worker and kills this turn",
    };
  }

  if (allowlist.some((e) => !e.prefix && e.tool === toolName)) return { dangerous: false };

  if (FILE_TOOLS.has(toolName)) {
    const filePath = String(input.file_path ?? input.notebook_path ?? '');
    if (filePath && !isInsideAny(roots, filePath)) {
      // Home-directory dotfiles and credentials are the riskiest targets.
      const home = os.homedir();
      const sensitive =
        isInside(path.join(home, '.ssh'), filePath) ||
        isInside(path.join(home, '.aws'), filePath) ||
        filePath.includes('.env');
      // Plan mode's deliverable lives outside cwd by design; reading or
      // authoring it shouldn't prompt.
      if (!sensitive && isPlanPath(filePath, roots)) return { dangerous: false };
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
  if (MCP_READ_TOOL_PATTERN.test(toolName)) return { dangerous: false };
  return { dangerous: true, reason: `Unrecognized tool "${toolName}" — review before running` };
}

/** Name fragments that mark an unknown (MCP) tool as a read in auto mode. */
const MCP_READ_TOOL_PATTERN = /read|list|get|search|view/i;

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
  roots: string[],
  allowlist: GuardAllowEntry[],
): boolean {
  if (ALWAYS_ASK_TOOLS.has(toolName) || !READ_ONLY_TOOLS.has(toolName)) return false;
  return !assessToolCall(toolName, input, roots, allowlist).dangerous;
}

/**
 * True when a call authors the plan file itself. Separate from isSafeReadOnly,
 * which gates on READ_ONLY_TOOLS and so can never cover a write: without this,
 * every incremental Write/Edit while drafting a plan raises a permission card.
 */
export function isSafePlanWrite(
  toolName: string,
  input: Record<string, unknown>,
  roots: string[],
): boolean {
  if (!PLAN_WRITE_TOOLS.has(toolName)) return false;
  const filePath = String(input.file_path ?? input.notebook_path ?? '');
  return Boolean(filePath) && isPlanPath(filePath, roots);
}

/**
 * Commands that only print what they read. Their arguments are still checked by
 * READ_ONLY_ARG_RULES where a flag turns them into a writer (`sort -o`).
 */
export const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'egrep', 'fgrep', 'sort', 'uniq', 'cut', 'tr', 'jq',
  'file', 'stat', 'du', 'df', 'which', 'whereis', 'type', 'basename', 'dirname', 'realpath', 'readlink',
  'tree', 'diff', 'cmp', 'comm', 'column', 'nl', 'less', 'more', 'date', 'whoami', 'hostname', 'uname',
  'env', 'lsof', 'ps',
  // Shell builtins with no side effect once redirects are ruled out.
  'cd', 'pwd', 'echo', 'printf', 'test', '[',
]);

/** Leading keywords of a compound command; what follows them is checked on its own. */
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'done', 'fi', 'if', 'elif']);

/**
 * Split a command into its simple commands, each as unquoted words, or null when
 * anything could run or write beyond those words: command/process substitution,
 * heredocs, background jobs, subshell parens, or an output redirect to anything
 * but /dev/null. Quote-aware, so `grep "a|b"` stays one command.
 */
function splitReadOnlyShell(command: string): string[][] | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  // Set after a redirect operator: the next word is its target, not an argument.
  let target: 'devnull' | 'file' | null = null;

  const endWord = (): boolean => {
    if (!inWord) return true;
    if (target === 'devnull' && word !== '/dev/null') return false;
    if (target) target = null;
    else words.push(word);
    word = '';
    inWord = false;
    return true;
  };
  const endSegment = (): boolean => {
    if (!endWord() || target) return false;
    if (words.length) segments.push(words);
    words = [];
    return true;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (c === '\\') {
      if (next === undefined) return null;
      if (next !== '\n') {
        word += next;
        inWord = true;
      }
      i++;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j];
        if (d === '`' || (d === '$' && command[j + 1] === '(')) return null;
        if (d === '\\' && j + 1 < command.length) {
          j++;
          word += command[j];
          continue;
        }
        word += d;
      }
      if (j >= command.length) return null;
      inWord = true;
      i = j;
      continue;
    }
    if (c === '`' || c === '(' || c === ')' || (c === '$' && next === '(')) return null;
    if (c === ' ' || c === '\t') {
      if (!endWord()) return null;
      continue;
    }
    if (c === '#' && !inWord) {
      const nl = command.indexOf('\n', i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    if (c === '\n' || c === ';') {
      if (!endSegment()) return null;
      continue;
    }
    if (c === '|') {
      if (next === '&') return null;
      if (!endSegment()) return null;
      if (next === '|') i++;
      continue;
    }
    if (c === '&') {
      if (next === '&') {
        if (!endSegment()) return null;
        i++;
        continue;
      }
      if (next === '>') {
        // &> / &>> — both streams, so only a sink is acceptable.
        if (!endWord() || target) return null;
        i += command[i + 2] === '>' ? 2 : 1;
        target = 'devnull';
        continue;
      }
      return null; // background job
    }
    if (c === '>' || c === '<') {
      // A bare fd number right before the operator (`2>`) belongs to it.
      if (inWord && /^\d+$/.test(word) && !target) {
        word = '';
        inWord = false;
      } else if (!endWord()) {
        return null;
      }
      if (target) return null;
      if (next === '(') return null; // process substitution
      if (next === '&') {
        // fd duplication (2>&1, <&0, >&-) writes nothing new.
        const dup = /^(\d+|-)/.exec(command.slice(i + 2));
        if (dup) {
          i += 1 + dup[0].length;
          continue;
        }
        if (c === '<') return null;
        i++;
        target = 'devnull'; // `>&file` redirects both streams to a file
        continue;
      }
      if (c === '<') {
        if (next === '<' || next === '>') return null; // heredoc / herestring / read-write open
        target = 'file';
        continue;
      }
      if (next === '>' || next === '|') i++;
      target = 'devnull';
      continue;
    }
    word += c;
    inWord = true;
  }
  if (!endSegment()) return null;
  return segments;
}

/** Positional (non-flag) arguments. */
function positionals(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('-'));
}

/** True when any short-flag cluster (`-uo`) contains one of `letters`, or a long flag starts with one of `longs`. */
function hasFlag(args: string[], letters: string, longs: string[] = []): boolean {
  return args.some(
    (a) =>
      (a.startsWith('--') && longs.some((l) => a === l || a.startsWith(l + '='))) ||
      (/^-[^-]/.test(a) && [...a.slice(1)].some((ch) => letters.includes(ch))),
  );
}

const GIT_READ_SUBCOMMANDS = new Set(['log', 'show', 'diff', 'status', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'describe']);

function gitReadOnly(args: string[]): boolean {
  let i = 0;
  // Global options: only ones that can't swap in a program or config.
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') i += 2;
    else if (args[i] === '--no-pager') i++;
    else return false;
  }
  const [sub, ...rest] = args.slice(i);
  if (!sub) return false;
  // Writes a file (--output) or launches a program (grep's -O pager, ext diff).
  if (rest.some((a) => a.startsWith('--output') || a.startsWith('-O') || a.startsWith('--open-files-in-pager') || a === '--ext-diff')) {
    return false;
  }
  if (GIT_READ_SUBCOMMANDS.has(sub)) return true;
  const listing = hasFlag(rest, 'l', ['--list']);
  switch (sub) {
    case 'branch':
      return (
        !hasFlag(rest, 'dDmMcCfu', ['--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description', '--track', '--no-track', '--create-reflog']) &&
        (listing || positionals(rest).length === 0)
      );
    case 'tag':
      return (
        !hasFlag(rest, 'asufdmFe', ['--delete', '--annotate', '--sign', '--local-user', '--force', '--message', '--file', '--edit', '--create-reflog', '--cleanup']) &&
        (listing || positionals(rest).length === 0)
      );
    case 'remote':
      return (
        rest.length === 0 ||
        (rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose')) ||
        (rest.length === 2 && rest[0] === 'get-url')
      );
    case 'config':
      return (
        rest.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a)) &&
        !rest.some((a) => ['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '--edit', '-e'].includes(a))
      );
    default:
      return false;
  }
}

/** Address (line, `$`, or /regex/) and range forms sed accepts before a command. */
const SED_ADDR = String.raw`(?:\d+|\$|/(?:\\.|[^/\\])*/I?)`;
/** One sed command that only prints: [addr[,addr]][!]p|l|=|q. `w`, `e`, `s///w` never match. */
const SED_PRINT_COMMAND = new RegExp(
  String.raw`^\s*(?:${SED_ADDR}(?:\s*,\s*(?:${SED_ADDR}|[+~]\d+))?)?\s*!?\s*(?:[pl=]|[qQ]\d*)\s*$`,
);

function sedReadOnly(args: string[]): boolean {
  let quiet = false;
  const scripts: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--quiet' || a === '--silent') quiet = true;
    else if (a === '-e' || a === '--expression') scripts.push(args[++i] ?? '');
    else if (a === '--regexp-extended') continue;
    else if (/^-[nEr]+$/.test(a)) quiet = quiet || a.includes('n');
    else if (a.startsWith('-')) return false; // -i, -f, --in-place, …
    else rest.push(a);
  }
  if (scripts.length === 0 && rest.length) scripts.push(rest[0]);
  return (
    quiet &&
    scripts.length > 0 &&
    scripts.every((s) => s.split(/[;\n]/).every((cmd) => !cmd.trim() || SED_PRINT_COMMAND.test(cmd)))
  );
}

function awkReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-v') {
      i++;
      continue;
    }
    if (a.startsWith('-F') || a === '--') continue;
    if (a.startsWith('-')) return false; // -f progfile, gawk -i/-l extension loading, …
    // Redirects, pipes, and command execution inside the program itself.
    if (/system\s*\(|getline|[>|@]/.test(a)) return false;
  }
  return true;
}

function tscReadOnly(args: string[]): boolean {
  return args.includes('--noEmit') && !args.some((a) => ['-b', '--build', '-w', '--watch', '--init'].includes(a));
}

/**
 * Argument checks for commands that are read-only only in some forms. A command
 * here needs no READ_ONLY_COMMANDS entry; one in both must pass this check too.
 */
const READ_ONLY_ARG_RULES: Record<string, (args: string[]) => boolean> = {
  git: gitReadOnly,
  find: (args) => !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fls|fprint\w*)$/.test(a)),
  sed: sedReadOnly,
  awk: awkReadOnly,
  tsc: tscReadOnly,
  npx: (args) => args[0] === 'tsc' && tscReadOnly(args.slice(1)),
  sort: (args) => !hasFlag(args, 'o', ['--output', '--compress-program']),
  tree: (args) => !hasFlag(args, 'oR'),
  diff: (args) => !hasFlag(args, '', ['--output']),
  uniq: (args) => positionals(args).length <= 1, // a second operand is the output file
  rg: (args) => !args.some((a) => a === '--pre' || a.startsWith('--pre=')),
  file: (args) => !hasFlag(args, 'C', ['--compile']),
  env: (args) => args.length === 0, // `env X=1 cmd` runs cmd
  hostname: (args) => positionals(args).length === 0,
  date: (args) => !hasFlag(args, 's', ['--set']) && positionals(args).every((a) => a.startsWith('+')),
};

function segmentReadOnly(words: string[]): boolean {
  let w = words;
  while (w.length && SHELL_KEYWORDS.has(w[0])) w = w.slice(1);
  if (w.length === 0) return true;
  if (w[0] === 'for') return w.length >= 3 && /^[A-Za-z_]\w*$/.test(w[1]) && w[2] === 'in';
  // Bare assignments only. Lowercase names keep them off exported variables
  // (PATH, GIT_PAGER, LESSOPEN) that would change what a later command runs.
  if (w.every((a) => /^[a-z_][a-z0-9_]*=/.test(a))) return true;
  const [cmd, ...args] = w;
  const rule = READ_ONLY_ARG_RULES[cmd];
  if (rule) return rule(args);
  return READ_ONLY_COMMANDS.has(cmd);
}

/** Credential locations a read-only command must still not touch without asking. */
const CREDENTIAL_PATH = /(?:^|[\s/'"=:])\.(?:ssh|aws|gnupg)\b|\.(?:netrc|npmrc|pypirc)\b/;

/**
 * True when a Bash command only reads. An allowlist, not a deny-list: anything
 * not recognised is false, so the call still prompts. Used in plan mode only.
 * BASH_RULES still apply on top, so their credential and destruction rules win
 * over any allowlisted command.
 */
export function isReadOnlyBash(command: string): boolean {
  if (!command.trim()) return false;
  if (CREDENTIAL_PATH.test(command) || BASH_RULES.some((rule) => rule.pattern.test(command))) return false;
  const segments = splitReadOnlyShell(command);
  return segments !== null && segments.length > 0 && segments.every(segmentReadOnly);
}

/**
 * Non-file tools that only observe or track the agent's own work. Subagent and
 * skill tool calls still go through the same permission gate on their own.
 */
const PLAN_MODE_READ_TOOLS = new Set([
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'ToolSearch',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
]);

/**
 * An MCP tool whose own name (after `mcp__<server>__`) starts with a read verb.
 * Anchored to the start, unlike MCP_READ_TOOL_PATTERN: `submit_diff_review`
 * contains "view" and is a write.
 */
const MCP_READ_VERB_FIRST = /^(?:[Rr]ead|[Ll]ist|[Gg]et|[Ss]earch|[Vv]iew)(?![a-z])/;

/**
 * True when a plan-mode call only observes, so research runs without a card.
 * Wider than isSafeReadOnly (read-only Bash, web reads, subagents, MCP reads);
 * edits, unrecognised shell, and the always-ask tools still prompt.
 */
export function isSafePlanModeRead(
  toolName: string,
  input: Record<string, unknown>,
  roots: string[],
  allowlist: GuardAllowEntry[],
): boolean {
  if (ALWAYS_ASK_TOOLS.has(toolName)) return false;
  if (isSafeReadOnly(toolName, input, roots, allowlist)) return true;
  if (toolName === 'Bash') return isReadOnlyBash(String(input.command ?? ''));
  if (PLAN_MODE_READ_TOOLS.has(toolName)) return true;
  if (!toolName.startsWith('mcp__')) return false;
  return MCP_READ_VERB_FIRST.test(toolName.split('__').slice(2).join('__'));
}
