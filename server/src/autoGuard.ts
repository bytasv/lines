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
