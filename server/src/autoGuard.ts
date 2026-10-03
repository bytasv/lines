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
      !e.scope && // a plan-mode read never widens the auto-mode guard
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
  'env', 'lsof', 'ps', 'seq', 'strings', 'od', 'paste', 'rev', 'tac', 'fold', 'id', 'sw_vers', 'arch',
  'nproc', 'shasum', 'sha256sum', 'md5sum', 'md5', 'pgrep', 'host', 'dig', 'nslookup', 'mdfind', 'mdls',
  'locale', 'getconf',
  // Shell builtins with no side effect once redirects are ruled out.
  'cd', 'pwd', 'echo', 'printf', 'test', '[', 'true', 'false', ':', 'read', 'sleep', 'continue', 'break',
  'return', 'exit', 'shift',
]);

/** Leading keywords of a compound command; what follows them is checked on its own. */
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'done', 'fi', 'if', 'elif', 'while', 'until', '{', '}', '!']);

/** Where a plan-mode command may send output: nothing that persists. */
const REDIRECT_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** Stands in for a checked substitution's output inside the word that held it. */
const SUBSTITUTION = '$(…)';

/** Why a command is not a plain read: a recognised write, or something the classifier can't place. */
type NotRead = { kind: 'write' | 'unknown'; reason: string; prefix?: string };

/** `note`: something short of a write (a scratch file under a temp dir) that still needs the user. */
type ShellSplit = { segments: string[][]; note?: NotRead } | NotRead;

/** Scratch locations: writing here changes nothing the plan is about, but it is still not a read. */
const TEMP_PATH = /^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\$TMPDIR\/|\$\{TMPDIR\}\/)/;

/** Index of the `)` closing the `(` just before `from`, skipping quotes and nesting; -1 if none. */
function closingParen(s: string, from: number): number {
  let depth = 1;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === "'") {
      j = s.indexOf("'", j + 1);
      if (j < 0) return -1;
    } else if (c === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === '\\') j++;
      if (j >= s.length) return -1;
    } else if (c === '`') {
      j = closingBacktick(s, j + 1);
      if (j < 0) return -1;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

/** Index of the next unescaped backtick at or after `from`; -1 if none. */
function closingBacktick(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '`') return j;
  }
  return -1;
}

/**
 * Split a command into its simple commands, each as unquoted words, or say why
 * it can't be. Command and process substitutions are split too, their commands
 * joining the list so each is checked like any other; `$((…))` arithmetic runs
 * nothing unless something is substituted inside it. Heredocs and background
 * jobs stay unrecognised, and an output redirect to anything but a sink is a
 * write. Quote-aware, so `grep "a|b"` stays one command.
 */
function splitShell(command: string, depth = 0): ShellSplit {
  if (depth > 8) return { kind: 'unknown', reason: 'its command substitutions nest too deeply to check' };
  const segments: string[][] = [];
  const nested: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  // Set after a redirect operator: the next word is its target, not an argument.
  let target: 'sink' | 'data' | null = null;
  let failure: NotRead | null = null;
  let note: NotRead | undefined;
  // Heredocs opened on the current line; their bodies start after its newline.
  const heredocs: { delim: string; quoted: boolean; strip: boolean }[] = [];

  const fail = (kind: NotRead['kind'], reason: string): false => {
    failure ??= { kind, reason };
    return false;
  };
  const unparsable = () => fail('unknown', "the command couldn't be parsed");
  const failed = (): NotRead => failure ?? { kind: 'unknown', reason: "the command couldn't be parsed" };

  const endWord = (): boolean => {
    if (!inWord) return true;
    if (target === 'sink' && !REDIRECT_SINKS.has(word)) {
      if (!TEMP_PATH.test(word) || word.split('/').includes('..')) return fail('write', `it redirects output into ${word}`);
      note ??= { kind: 'unknown', reason: `it writes the scratch file ${word}` };
    }
    if (target) target = null;
    else words.push(word);
    word = '';
    inWord = false;
    return true;
  };
  const endSegment = (): boolean => {
    if (!endWord()) return false;
    if (target) return unparsable();
    if (words.length) segments.push(words);
    words = [];
    return true;
  };
  const substitute = (inner: string): boolean => {
    const sub = splitShell(inner, depth + 1);
    if (!('segments' in sub)) return fail(sub.kind, sub.reason);
    nested.push(...sub.segments);
    note ??= sub.note;
    return true;
  };
  /** At a backtick or `$(`: check the substitution, returning the index of its last character, or -1. */
  const expansion = (i: number): number => {
    if (command[i] === '`') {
      const end = closingBacktick(command, i + 1);
      if (end < 0) return unparsable() || -1;
      return substitute(command.slice(i + 1, end).replace(/\\`/g, '`')) ? end : -1;
    }
    const end = closingParen(command, i + 2);
    if (end < 0) return unparsable() || -1;
    const inner = command.slice(i + 2, end);
    if (inner.startsWith('(')) {
      return /\$\(|`/.test(inner) ? fail('unknown', 'it substitutes a command inside arithmetic') || -1 : end;
    }
    return substitute(inner) ? end : -1;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (c === '\\') {
      if (next === undefined) return failed();
      if (next !== '\n') {
        word += next;
        inWord = true;
      }
      i++;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return failed();
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j];
        if (d === '`' || (d === '$' && command[j + 1] === '(')) {
          const end = expansion(j);
          if (end < 0) return failed();
          word += SUBSTITUTION;
          j = end;
          continue;
        }
        if (d === '\\' && j + 1 < command.length) {
          j++;
          word += command[j];
          continue;
        }
        word += d;
      }
      if (j >= command.length) return failed();
      inWord = true;
      i = j;
      continue;
    }
    if (c === '`' || (c === '$' && next === '(')) {
      const end = expansion(i);
      if (end < 0) return failed();
      word += SUBSTITUTION;
      inWord = true;
      i = end;
      continue;
    }
    // Subshells and groups: what is inside is checked as ordinary commands.
    if (c === '(' || c === ')') {
      if (!endSegment()) return failed();
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (!endWord()) return failed();
      continue;
    }
    if (c === '#' && !inWord) {
      const nl = command.indexOf('\n', i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    if (c === '\n' || c === ';') {
      if (!endSegment()) return failed();
      if (c === '\n' && heredocs.length) {
        // Skip each pending heredoc's body: it is input to its command, not a
        // command. An unquoted delimiter expands `$(…)` inside it, which runs.
        let pos = i + 1;
        for (const h of heredocs) {
          const start = pos;
          let end = command.length;
          for (;;) {
            const nl = command.indexOf('\n', pos);
            const line = command.slice(pos, nl < 0 ? command.length : nl);
            if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) {
              end = pos;
              pos = nl < 0 ? command.length : nl + 1;
              break;
            }
            if (nl < 0) {
              pos = command.length;
              break;
            }
            pos = nl + 1;
          }
          if (!h.quoted && /\$\(|`/.test(command.slice(start, end))) {
            fail('unknown', 'its heredoc expands a command');
            return failed();
          }
        }
        heredocs.length = 0;
        i = pos - 1;
      }
      continue;
    }
    if (c === '|') {
      if (!endSegment()) return failed();
      if (next === '|' || next === '&') i++;
      continue;
    }
    if (c === '&') {
      if (next === '&') {
        if (!endSegment()) return failed();
        i++;
        continue;
      }
      if (next === '>') {
        // &> / &>> — both streams, so only a sink is acceptable.
        if (!endWord() || target) return failed();
        i += command[i + 2] === '>' ? 2 : 1;
        target = 'sink';
        continue;
      }
      fail('unknown', 'it starts a background job');
      return failed();
    }
    if (c === '>' || c === '<') {
      if (next === '(' && !inWord && !target) {
        // Process substitution: its command is checked like any other.
        const end = closingParen(command, i + 2);
        if (end < 0 || !substitute(command.slice(i + 2, end))) return failed();
        word += SUBSTITUTION;
        inWord = true;
        i = end;
        continue;
      }
      // A bare fd number right before the operator (`2>`) belongs to it.
      if (inWord && /^\d+$/.test(word) && !target) {
        word = '';
        inWord = false;
      } else if (!endWord()) {
        return failed();
      }
      if (target) return failed();
      if (next === '&') {
        // fd duplication (2>&1, <&0, >&-) writes nothing new.
        const dup = /^(\d+|-)/.exec(command.slice(i + 2));
        if (dup) {
          i += 1 + dup[0].length;
          continue;
        }
        if (c === '<') return failed();
        i++;
        target = 'sink'; // `>&file` redirects both streams to a file
        continue;
      }
      if (c === '<') {
        if (next === '<' && command[i + 2] === '<') {
          i += 2; // herestring: the next word is input, nothing more
        } else if (next === '<') {
          // Heredoc: read its delimiter now; the body is skipped at the newline.
          let j = i + 2;
          const strip = command[j] === '-';
          if (strip) j++;
          while (command[j] === ' ' || command[j] === '\t') j++;
          const from = j;
          while (j < command.length && !/[\s;|&<>()]/.test(command[j])) {
            if (command[j] === "'" || command[j] === '"') {
              const close = command.indexOf(command[j], j + 1);
              if (close < 0) return failed();
              j = close;
            }
            j++;
          }
          const raw = command.slice(from, j);
          const delim = raw.replace(/['"\\]/g, '');
          if (!delim) return failed();
          heredocs.push({ delim, quoted: delim !== raw, strip });
          i = j - 1;
          continue;
        } else if (next === '>') {
          return failed(); // read-write open
        }
        target = 'data';
        continue;
      }
      if (next === '>' || next === '|') i++;
      target = 'sink';
      continue;
    }
    word += c;
    inWord = true;
  }
  if (!endSegment()) return failed();
  return { segments: [...segments, ...nested], ...(note ? { note } : {}) };
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

const GIT_READ_SUBCOMMANDS = new Set([
  'log', 'show', 'diff', 'status', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'describe',
  'check-ignore', 'check-attr', 'rev-list', 'cat-file', 'merge-base', 'for-each-ref', 'shortlog',
  'name-rev', 'ls-remote', 'show-ref', 'whatchanged', 'cherry', 'range-diff', 'count-objects', 'show-branch',
]);

/** The subcommand after git's global options (`git -C dir log` → log). */
function gitSubcommand(args: string[]): { sub?: string; rest: string[]; clean: boolean } {
  let i = 0;
  let clean = true;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') i += 2;
    else if (args[i] === '--no-pager') i++;
    else {
      // Anything else (`-c core.pager=…`) can swap in a program or config.
      clean = false;
      i += args[i] === '-c' ? 2 : 1;
    }
  }
  return { sub: args[i], rest: args.slice(i + 1), clean };
}

function gitReadOnly(args: string[]): boolean {
  const { sub, rest, clean } = gitSubcommand(args);
  if (!clean || !sub) return false;
  // Writes a file (--output) or launches a program (grep's -O pager, ext diff).
  if (rest.some((a) => a.startsWith('--output') || a.startsWith('-O') || a.startsWith('--open-files-in-pager') || a === '--ext-diff')) {
    return false;
  }
  if (GIT_READ_SUBCOMMANDS.has(sub)) return true;
  // A filter or sort flag makes branch/tag list, and its value is not a new name.
  const listing =
    hasFlag(rest, 'l', ['--list']) ||
    rest.some((a) => /^--(contains|no-contains|merged|no-merged|points-at|sort|format)\b/.test(a));
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
    case 'config': {
      const scopes = ['--global', '--local', '--system', '--show-origin', '--includes'];
      return (
        (rest.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a)) ||
          // `git config user.name` — one key and no value is a get.
          (positionals(rest).length === 1 && rest.every((a) => !a.startsWith('-') || scopes.includes(a)))) &&
        !rest.some((a) => ['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '--edit', '-e'].includes(a))
      );
    }
    case 'reflog':
      return rest[0] === undefined || rest[0] === 'show' || rest[0].startsWith('-');
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show';
    case 'worktree':
      return rest[0] === 'list';
    default:
      return false;
  }
}

/** Address (line, `first~step`, `$`, or /regex/) and range forms sed accepts before a command. */
const SED_ADDR = String.raw`(?:\d+~\d+|\d+|\$|/(?:\\.|[^/\\])*/I?)`;
const SED_ADDRESS_PREFIX = new RegExp(
  String.raw`^(?:${SED_ADDR}(?:\s*,\s*(?:${SED_ADDR}|[+~]\d+))?)?\s*!?\s*`,
);
/** sed commands that only shape what is printed. */
const SED_STREAM_COMMANDS = new Set([...'pPl=dDnNgGhHxzF{}']);

/**
 * True when a sed script only transforms the stream it prints: `p`, `d`,
 * `s///` and `y///` and the like. Anything that writes or runs (`w`, `e`,
 * `s///w`, `s///e`) or takes a free-text argument (`a`, `r`, labels) is refused.
 */
function sedScriptReadOnly(script: string): boolean {
  let i = 0;
  /** Skip one delimited part (pattern or replacement); false when unterminated. */
  const part = (delim: string): boolean => {
    for (; i < script.length; i++) {
      if (script[i] === '\\') i++;
      else if (script[i] === delim) {
        i++;
        return true;
      }
    }
    return false;
  };
  while (i < script.length) {
    while (i < script.length && /[\s;]/.test(script[i])) i++;
    if (i >= script.length) break;
    if (script[i] === '#') {
      const nl = script.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    i += SED_ADDRESS_PREFIX.exec(script.slice(i))![0].length;
    const cmd = script[i++];
    if (cmd === undefined) return false;
    if (cmd === 's' || cmd === 'y') {
      const delim = script[i++];
      if (!delim || delim === '\\' || delim === '\n' || !part(delim) || !part(delim)) return false;
      if (cmd === 's') i += /^[gpiImM\d]*/.exec(script.slice(i))![0].length;
    } else if (cmd === 'q' || cmd === 'Q') {
      i += /^\s*\d*/.exec(script.slice(i))![0].length;
    } else if (!SED_STREAM_COMMANDS.has(cmd)) {
      return false;
    }
    while (i < script.length && (script[i] === ' ' || script[i] === '\t')) i++;
    if (i < script.length && !/[;\n}#]/.test(script[i])) return false;
  }
  return true;
}

function sedReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '--expression') scripts.push(args[++i] ?? '');
    else if (a.startsWith('--expression=')) scripts.push(a.slice('--expression='.length));
    else if (/^-[nErsuz]+$/.test(a)) continue;
    else if (['--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data', '--posix', '--sandbox'].includes(a)) continue;
    else if (a.startsWith('-')) return false; // -i, -f, --in-place, …
    else rest.push(a);
  }
  if (scripts.length === 0 && rest.length) scripts.push(rest[0]);
  return scripts.length > 0 && scripts.every(sedScriptReadOnly);
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
    // Command execution and extension loading inside the program itself.
    if (/system\s*\(|getline|\|&|@(include|load)/.test(a)) return false;
    // Output redirection only exists on print: `print > "f"`, `printf … | "cmd"`. A
    // `>` anywhere else is a comparison (`NR>=10`).
    if (a.split(/[;{}\n]/).some((stmt) => /\bprintf?\b[\s\S]*[>|]/.test(stmt))) return false;
  }
  return true;
}

function tscReadOnly(args: string[]): boolean {
  return args.includes('--noEmit') && !args.some((a) => ['-b', '--build', '-w', '--watch', '--init'].includes(a));
}

/**
 * True for a find that only lists. `-exec`/`-execdir` pass when the command they
 * run is itself read-only (`-exec cat {} +`); `-delete` and the file-writing
 * actions never do.
 */
function findReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-(delete|ok|okdir|fls|fprint\w*)$/.test(a)) return false;
    if (a === '-exec' || a === '-execdir') {
      const end = args.findIndex((x, j) => j > i && (x === ';' || x === '+'));
      if (end < 0 || !commandReadOnly(args.slice(i + 1, end).filter((x) => x !== '{}'))) return false;
      i = end;
    }
  }
  return true;
}

/** The command xargs runs, after its own options; null for an option this doesn't know. */
function xargsCommand(args: string[]): string[] | null {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (/^-[0rtx]+$/.test(a) || ['--null', '--no-run-if-empty', '--verbose', '--exit'].includes(a)) i++;
    else if (/^-[nILPsdEa]$/.test(a)) i += 2;
    else if (/^-[nILPsdEa]./.test(a) || /^--(max-args|max-lines|max-procs|max-chars|delimiter|eof|arg-file|replace)=/.test(a)) i++;
    else return null;
  }
  const rest = args.slice(i);
  return rest.length ? rest : ['echo'];
}

/**
 * True for a curl that only fetches to stdout: no request body, no upload, no
 * method but GET/HEAD, nothing saved but to a sink, nothing read from a local
 * file into the request. Values are never consumed as flags are scanned, so a
 * value that looks like a flag can only make this refuse, never pass.
 */
function curlReadOnly(args: string[]): boolean {
  const sink = (v: string | undefined) => v !== undefined && (v === '-' || REDIRECT_SINKS.has(v));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // `@file` feeds a local file (or stdin) into a header or body; `%output{}` in -w writes a file.
    if (a.startsWith('@') || a.includes('%output{')) return false;
    if (!a.startsWith('-') || a === '-') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      const value = () => (eq < 0 ? args[++i] : a.slice(eq + 1));
      if (/^--(data|json|form|upload-file|remote-name|config|cookie-jar|trace|libcurl|output-dir|create-dirs|etag-save|hsts|alt-svc|stderr|unix-socket|abstract-unix-socket)/.test(name)) return false;
      if ((name === '--output' || name === '--dump-header') && !sink(value())) return false;
      if (name === '--request' && !/^(GET|HEAD)$/i.test(value() ?? '')) return false;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if ('TdFOKcJ'.includes(ch)) return false; // upload, data, form, remote-name, config, cookie-jar
      if (ch === 'o' || ch === 'D' || ch === 'X') {
        const v = a.slice(k + 1) || args[++i];
        if (ch === 'X' ? !/^(GET|HEAD)$/i.test(v ?? '') : !sink(v)) return false;
        break;
      }
    }
  }
  return true;
}

const GH_READ_GROUPS = new Set(['run', 'pr', 'issue', 'release', 'repo', 'workflow', 'label', 'cache', 'gist', 'ruleset', 'variable']);
const GH_READ_ACTIONS = new Set(['list', 'view', 'status', 'diff', 'checks']);

/** True for a gh call that only reports: `gh <group> list|view|…`, `gh search`, a GET `gh api`. */
function ghReadOnly(args: string[]): boolean {
  const [group, action] = args;
  if (group === 'search' || (group === 'auth' && action === 'status')) return true;
  if (group === 'api') {
    let get = false;
    let fields = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--input')) return false;
      if (/^(-f|-F|--field|--raw-field)/.test(a)) fields = true;
      if (a.startsWith('-X') || a.startsWith('--method')) {
        const method = a === '-X' || a === '--method' ? args[++i] : a.replace(/^-X|^--method=/, '');
        if (!/^GET$/i.test(method ?? '')) return false;
        get = true;
      }
    }
    // Fields turn a call into a POST unless the method is pinned to GET (then they are the query).
    return !fields || get;
  }
  return GH_READ_GROUPS.has(group) && GH_READ_ACTIONS.has(action);
}

/** Package-manager subcommands that only report. */
const PACKAGE_READ_SUBCOMMANDS = new Set(['ls', 'list', 'view', 'info', 'show', 'outdated', 'explain', 'why', 'root', 'bin', 'prefix', 'help', '-v', '--version']);

/**
 * Argument checks for commands that are read-only only in some forms. A command
 * here needs no READ_ONLY_COMMANDS entry; one in both must pass this check too.
 */
const READ_ONLY_ARG_RULES: Record<string, (args: string[]) => boolean> = {
  git: gitReadOnly,
  find: findReadOnly,
  sed: sedReadOnly,
  awk: awkReadOnly,
  tsc: tscReadOnly,
  npx: (args) => args[0] === 'tsc' && tscReadOnly(args.slice(1)),
  xargs: (args) => {
    const inner = xargsCommand(args);
    return inner !== null && commandReadOnly(inner);
  },
  curl: curlReadOnly,
  gh: ghReadOnly,
  dd: (args) => !args.some((a) => a.startsWith('of=')), // no of= writes to stdout
  base64: (args) => !hasFlag(args, 'o', ['--output']),
  fd: (args) => !hasFlag(args, 'xX', ['--exec', '--exec-batch']),
  ping: (args) => hasFlag(args, 'c'), // bounded
  defaults: (args) => ['read', 'read-type', 'domains', 'find'].includes(args[0]),
  npm: (args) => PACKAGE_READ_SUBCOMMANDS.has(args[0]),
  pnpm: (args) => PACKAGE_READ_SUBCOMMANDS.has(args[0]),
  yarn: (args) => PACKAGE_READ_SUBCOMMANDS.has(args[0]),
  node: (args) => args.length === 1 && (args[0] === '-v' || args[0] === '--version'),
  python3: (args) => args.length === 1 && (args[0] === '-V' || args[0] === '--version'),
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

/** True when one simple command (keywords and assignments already stripped) only reads. */
function commandReadOnly(words: string[]): boolean {
  const [path0, ...args] = words;
  if (path0 === undefined) return false;
  const cmd = commandName(path0);
  // `tool --help`, `tool sub --version`: a probe that prints and exits.
  if (
    args.length &&
    (args.at(-1) === '--help' || args.at(-1) === '--version') &&
    args.slice(0, -1).every((a) => /^[a-z][a-z0-9-]*$/.test(a))
  ) {
    return true;
  }
  const rule = READ_ONLY_ARG_RULES[cmd];
  if (rule) return rule(args);
  return READ_ONLY_COMMANDS.has(cmd);
}

/** A system binary by absolute path reads as its bare name: `/usr/bin/grep` is `grep`. */
function commandName(word: string): string {
  return /^\/(?:usr\/(?:local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/.test(word)
    ? word.slice(word.lastIndexOf('/') + 1)
    : word;
}

/** Commands that write only their operands, so a scratch-only call is not a project write. */
const TEMP_WRITERS = new Set(['mkdir', 'touch', 'rm', 'cp', 'mv', 'tee', 'ln']);

/** True when a TEMP_WRITERS call only ever writes under a temp dir (cp/ln: the destination). */
function writesOnlyTemp([cmd, ...args]: string[]): boolean {
  if (!TEMP_WRITERS.has(cmd)) return false;
  const paths = positionals(args);
  if (!paths.length) return false;
  const temp = (p: string) => TEMP_PATH.test(p) && !p.split('/').includes('..');
  return cmd === 'cp' || cmd === 'ln' ? temp(paths.at(-1)!) : paths.every(temp);
}

const WRITE_COMMANDS = new Set([
  'rm', 'rmdir', 'unlink', 'mv', 'cp', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp', 'truncate',
  'tee', 'install', 'patch', 'dd', 'shred', 'rsync', 'scp', 'kill', 'pkill', 'killall', 'mkfifo', 'mktemp',
]);
const GIT_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'switch', 'restore', 'reset', 'rebase', 'merge',
  'cherry-pick', 'revert', 'stash', 'rm', 'mv', 'apply', 'am', 'clean', 'init', 'clone', 'worktree',
  'submodule', 'gc', 'prune', 'notes', 'commit-tree', 'update-ref', 'update-index', 'symbolic-ref',
  'branch', 'tag', 'config', 'remote',
]);
const PACKAGE_WRITE_SUBCOMMANDS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'ci', 'publish',
  'version', 'init', 'link', 'unlink', 'prune', 'dedupe', 'create',
]);

/**
 * Why a simple command that isn't read-only is a recognised write, or null when
 * it is merely unrecognised. Only consulted after commandReadOnly said no, so
 * `git branch` (a listing) never reaches the `branch` entry here.
 */
function commandWrites(words: string[]): string | null {
  const [path0, ...args] = words;
  const cmd = commandName(path0);
  if (WRITE_COMMANDS.has(cmd)) return `\`${cmd}\` changes files or processes`;
  if (cmd === 'git') {
    const { sub } = gitSubcommand(args);
    return sub && GIT_WRITE_SUBCOMMANDS.has(sub) ? `\`git ${sub}\` changes the repository` : null;
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && PACKAGE_WRITE_SUBCOMMANDS.has(args[0])) {
    return `\`${cmd} ${args[0]}\` changes installed packages`;
  }
  if ((cmd === 'pip' || cmd === 'pip3') && (args[0] === 'install' || args[0] === 'uninstall')) {
    return `\`${cmd} ${args[0]}\` changes installed packages`;
  }
  if (cmd === 'brew' && ['install', 'uninstall', 'upgrade', 'update', 'tap', 'untap', 'link', 'unlink'].includes(args[0])) {
    return `\`brew ${args[0]}\` changes installed packages`;
  }
  if ((cmd === 'sed' || cmd === 'perl') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
    return `\`${cmd} -i\` edits files in place`;
  }
  if (cmd === 'find' && args.includes('-delete')) return '`find -delete` deletes files';
  if (cmd === 'xargs') {
    const inner = xargsCommand(args);
    return inner && commandWrites(inner);
  }
  return null;
}

/** Bare or leading assignments to these change what a later command runs or loads. */
const UNSAFE_ASSIGNMENT =
  /^(?:PATH|IFS|ENV|BASH_ENV|CDPATH|TMPDIR|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|GLOBIGNORE|HOME|ZDOTDIR|PAGER|MANPAGER|EDITOR|VISUAL|NODE_OPTIONS|NODE_PATH|GIT_\w*|LESS\w*|XDG_\w*|PYTHON\w*|PERL\w*|RUBY\w*|LD_\w*|DYLD_\w*)=/;

/** The prefix "Allow as read" records for a command: its first two words, quoted content and all. */
function planReadPrefix(words: string[]): string | undefined {
  const lead: string[] = [];
  for (const w of [commandName(words[0]), ...words.slice(1, 2)]) {
    if (w.includes(SUBSTITUTION)) break;
    lead.push(w);
  }
  const prefix = lead.join(' ').trim();
  // The shapes normalizeAllowEntry would refuse.
  return prefix && prefix.length <= 200 && !/[|;&\n\r]/.test(prefix) ? prefix : undefined;
}

function planReadAllowed(words: string[], allowlist: GuardAllowEntry[]): boolean {
  const joined = [commandName(words[0]), ...words.slice(1)].join(' ');
  return allowlist.some(
    (e) =>
      e.scope === 'plan-read' &&
      e.tool === 'Bash' &&
      !!e.prefix &&
      (joined === e.prefix || joined.startsWith(e.prefix + ' ')),
  );
}

/** Leading words that run the rest of the line as the command: `time`, `timeout 30`, `env X=1`, `command`. */
function unwrap(w: string[]): string[] {
  if (w[0] === 'time') return w.slice(w[1] === '-p' ? 2 : 1);
  if (w[0] === 'command' && w[1] !== '-v' && w[1] !== '-V') return w.slice(w[1] === '-p' ? 2 : 1);
  if (w[0] === 'env' && w.length > 1 && !w[1].startsWith('-')) return w.slice(1);
  if (w[0] === 'timeout') {
    let i = 1;
    while (i < w.length && w[i].startsWith('-')) i += w[i] === '-s' || w[i] === '-k' ? 2 : 1;
    return w.slice(i + 1); // past the duration
  }
  return w;
}

function classifySegment(words: string[], allowlist: GuardAllowEntry[]): NotRead | null {
  let w = words;
  while (w.length && SHELL_KEYWORDS.has(w[0])) w = w.slice(1);
  for (let prev: string[] | null = null; prev !== w; ) {
    prev = w;
    w = unwrap(w);
    // Assignments, bare or leading (`LC_ALL=C grep`), and their declaration
    // builtins: only the names that steer later commands are refused.
    if (['export', 'local', 'declare', 'readonly'].includes(w[0])) w = w.slice(1);
    while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) {
      if (UNSAFE_ASSIGNMENT.test(w[0])) {
        return { kind: 'unknown', reason: `it sets ${w[0].split('=')[0]}, which changes what later commands run` };
      }
      w = w.slice(1);
    }
  }
  if (w.length === 0) return null;
  if (w[0] === 'command') return null; // `command -v x` only resolves a name
  if (w[0] === 'for') {
    return w.length >= 3 && /^[A-Za-z_]\w*$/.test(w[1]) && w[2] === 'in'
      ? null
      : { kind: 'unknown', reason: "its for loop couldn't be parsed" };
  }
  if (planReadAllowed(w, allowlist) || commandReadOnly(w)) return null;
  if (writesOnlyTemp(w)) return { kind: 'unknown', reason: `\`${w[0]}\` writes under a temp directory` };
  // BASH_RULES per command, and only for one that isn't a read: run over the
  // whole line they matched pattern text (`grep -E "deploy|launchctl"`).
  const rule = BASH_RULES.find((r) => r.pattern.test(w.join(' ')));
  if (rule) return { kind: 'write', reason: rule.reason };
  const write = commandWrites(w);
  if (write) return { kind: 'write', reason: write };
  const prefix = planReadPrefix(w);
  return {
    kind: 'unknown',
    reason: `\`${prefix ?? w[0]}\` isn't on the plan-mode read-only list`,
    ...(prefix ? { prefix } : {}),
  };
}

/** Credential locations a read-only command must still not touch without asking. */
const CREDENTIAL_PATH = /(?:^|[\s/'"=:])\.(?:ssh|aws|gnupg)\b|\.(?:netrc|npmrc|pypirc)\b/;

export type PlanModeVerdict = { kind: 'read' } | NotRead;

/**
 * Plan mode's three-way reading of a Bash command: a read, a recognised write
 * (a BASH_RULES match on a command that isn't a read, a write command, an
 * output redirect into the project — the only kind plan mode may reject on its
 * own), or unknown (`node -e`, a scratch file under /tmp), which goes to the
 * user. An allowlist, not a deny-list, on the read side: nothing unrecognised
 * is ever a read. `plan-read` allowlist entries extend it; they never outrank
 * the credential check or a write elsewhere on the line.
 */
export function classifyPlanBash(command: string, allowlist: GuardAllowEntry[] = []): PlanModeVerdict {
  if (!command.trim()) return { kind: 'unknown', reason: 'the command is empty' };
  if (CREDENTIAL_PATH.test(command)) return { kind: 'write', reason: 'it touches credential files' };
  const split = splitShell(command);
  if (!('segments' in split)) return split;
  if (split.segments.length === 0) return { kind: 'unknown', reason: "the command couldn't be parsed" };
  let unknown: NotRead | null = split.note ?? null;
  for (const words of split.segments) {
    const verdict = classifySegment(words, allowlist);
    if (verdict?.kind === 'write') return verdict;
    unknown ??= verdict;
  }
  return unknown ?? { kind: 'read' };
}

/**
 * True when a Bash command only reads. Used in plan mode only. BASH_RULES still
 * apply on top, so their credential and destruction rules win over any
 * allowlisted command.
 */
export function isReadOnlyBash(command: string, allowlist: GuardAllowEntry[] = []): boolean {
  return classifyPlanBash(command, allowlist).kind === 'read';
}

/**
 * Non-file tools that only observe or track the agent's own work. Subagent and
 * skill tool calls still go through the same permission gate on their own.
 * SendMessage only talks to the session's own agents.
 */
const PLAN_MODE_READ_TOOLS = new Set([
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'ToolSearch', 'SendMessage', 'ListAgents',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
]);

/**
 * An MCP tool whose own name (after `mcp__<server>__`) starts with a read verb.
 * Anchored to the start, unlike MCP_READ_TOOL_PATTERN: `submit_diff_review`
 * contains "view" and is a write.
 */
const MCP_READ_VERB_FIRST = /^(?:[Rr]ead|[Ll]ist|[Gg]et|[Ss]earch|[Vv]iew)(?![a-z])/;

/** An MCP tool whose own name starts with a verb that changes something. */
const MCP_WRITE_VERB_FIRST =
  /^(?:create|update|delete|remove|add|set|save|send|post|put|patch|write|upload|insert|edit|modify|move|rename|run|execute|exec|deploy|publish|push|merge|submit|approve|reject|archive|import|apply|authorize|use|generate|replace|cancel|start|stop)(?![a-z])/i;

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
  // Monitor runs a shell command too (usually a wait loop for a background agent).
  if (toolName === 'Bash' || toolName === 'Monitor') return isReadOnlyBash(String(input.command ?? ''), allowlist);
  if (PLAN_MODE_READ_TOOLS.has(toolName)) return true;
  if (!toolName.startsWith('mcp__')) return false;
  return MCP_READ_VERB_FIRST.test(toolName.split('__').slice(2).join('__'));
}

/**
 * Plan mode's verdict on any call isSafePlanModeRead didn't pass: a recognised
 * write, which `planModeRejectWrites` rejects without asking, or unknown, which
 * always reaches the user. Rejecting only what is recognised is the point — a
 * call the classifier merely can't place is usually research.
 */
export function planModeVerdict(
  toolName: string,
  input: Record<string, unknown>,
  allowlist: GuardAllowEntry[],
): PlanModeVerdict {
  if (toolName === 'Bash' || toolName === 'Monitor') return classifyPlanBash(String(input.command ?? ''), allowlist);
  if (PLAN_WRITE_TOOLS.has(toolName)) return { kind: 'write', reason: `\`${toolName}\` edits a file outside the plan` };
  if (toolName.startsWith('mcp__')) {
    const name = toolName.split('__').slice(2).join('__');
    return MCP_WRITE_VERB_FIRST.test(name)
      ? { kind: 'write', reason: `\`${name}\` changes state through an MCP server` }
      : { kind: 'unknown', reason: `\`${name}\` isn't recognised as a read` };
  }
  return { kind: 'unknown', reason: `\`${toolName}\` isn't recognised as a read` };
}
