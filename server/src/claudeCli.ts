/**
 * The Claude Code CLI this machine has installed.
 *
 * The packaged app does not ship a `claude` binary — the platform package alone
 * is 231 MB — so every turn runs the CLI the user already installed. That makes
 * discovery a product concern: a missing or too-old binary has to become a
 * sentence a non-developer can act on, in the tray and in the browser, rather
 * than a crash inside the SDK.
 *
 * Lives in the server workspace next to `device.ts` for the same reason: the
 * bridge, the worker and the desktop shell all need one answer about which
 * binary runs, and a second copy would drift.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeCliState, ClaudeCliStatus } from '@lines/shared';

// The shapes live in shared/types.ts because the browser renders them in
// Settings -> Updates and must not import server code. Re-exported here so every
// existing importer keeps reading them off the module that produces them.
export type { ClaudeCliState, ClaudeCliStatus };

/**
 * The CLI version the pinned SDK wrapper ships with
 * (`@anthropic-ai/claude-agent-sdk` → `claudeCodeVersion`), i.e. the oldest CLI
 * we know speaks the flag set and the stdin `initialize` payload the wrapper
 * sends.
 *
 * This gate is ours or nobody's: **the SDK performs no version handshake at
 * all.** It never runs `--version`, never reads `claude_code_version` or
 * `capabilities` off the init message, and an unknown flag surfaces only as
 * `Claude Code process exited with code 1`. Without this constant a user on a
 * year-old CLI gets that string and no way to guess what it means.
 */
export const MIN_CLAUDE_VERSION = '2.1.211';

/** Where to send someone who has no CLI at all. */
export const CLAUDE_INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup';

/** Injection seams, so discovery order is testable without a real filesystem. */
export interface DiscoveryDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** True when the path is an existing, executable file. */
  isExecutable?: (candidate: string) => boolean;
  /** `command -v claude` against the inherited PATH; null when not found. */
  onPath?: () => string | null;
  readVersion?: (binary: string) => string | null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `claude` on PATH. Runs through `sh -c` rather than `which` because a GUI-
 * launched app's PATH is already the login shell's (see the desktop shell's
 * `loginShellPath`), and `command -v` is the portable spelling.
 */
function claudeOnPath(): string | null {
  try {
    const out = execFileSync('/bin/sh', ['-c', 'command -v claude'], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * The CLI the SDK would have used itself, from its optional platform package.
 * Present in a dev checkout, deliberately deleted from the shipped app tree —
 * so this is the last candidate, never the first.
 */
function sdkBundledCli(): string | null {
  try {
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    return createRequire(import.meta.url).resolve(`${pkg}/claude`);
  } catch {
    return null;
  }
}

/**
 * Every place a CLI may live, in the order we prefer it.
 *
 * `LINES_CLAUDE_PATH` is not merely first, it is exclusive: someone who pinned a
 * binary must not silently get a different one when the pin is wrong. That also
 * makes "no CLI at all" reachable in a test on a machine that has one.
 */
export function candidatePaths(deps: DiscoveryDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const onPath = deps.onPath ?? claudeOnPath;
  if (env.LINES_CLAUDE_PATH) return [env.LINES_CLAUDE_PATH];
  return [
    // The native installer's symlink into ~/.local/share/claude/versions/*.
    path.join(home, '.local', 'bin', 'claude'),
    onPath(),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    sdkBundledCli(),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

/**
 * `x.y.z` out of `--version` output like `2.1.224 (Claude Code)`. Null when the
 * binary refuses to run or prints something unrecognisable — treated as "cannot
 * vouch for it" rather than as a failure, see `claudeCliStatus`.
 */
export function readVersion(binary: string): string | null {
  try {
    const out = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
  } catch {
    return null;
  }
}

/** Numeric `x.y.z` compare: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * First candidate that both exists and answers `--version`. A path that exists
 * but cannot report a version is still returned (with no version): refusing it
 * would break anyone whose wrapper script prints nothing, and the version is
 * only used for the floor check.
 */
export function findClaudeCli(deps: DiscoveryDeps = {}): { path: string; version: string | null } | null {
  const isExecutable = deps.isExecutable ?? isExecutableFile;
  const version = deps.readVersion ?? readVersion;
  for (const candidate of candidatePaths(deps)) {
    if (!isExecutable(candidate)) continue;
    return { path: candidate, version: version(candidate) };
  }
  return null;
}

/**
 * Discovery result, with the floor check applied. Never throws: a boot-time
 * probe that can take the bridge down would be worse than a wrong answer.
 */
export function resolveClaudeCliStatus(deps: DiscoveryDeps = {}): ClaudeCliStatus {
  const found = findClaudeCli(deps);
  if (!found) return { state: 'missing', minVersion: MIN_CLAUDE_VERSION };
  // No parsable version → let it run. The alternative is refusing a working
  // install over a formatting change in `--version` output.
  if (found.version && compareVersions(found.version, MIN_CLAUDE_VERSION) < 0) {
    return { state: 'outdated', path: found.path, version: found.version, minVersion: MIN_CLAUDE_VERSION };
  }
  return {
    state: 'ok',
    path: found.path,
    ...(found.version ? { version: found.version } : {}),
    minVersion: MIN_CLAUDE_VERSION,
  };
}

let cached: ClaudeCliStatus | null = null;

/**
 * Cached per process: discovery spawns `--version` and a login shell, and the
 * answer is asked for on every turn push and every tray render. The tray's
 * "Check again" calls {@link refreshClaudeCli} after the user installs one.
 */
export function claudeCliStatus(): ClaudeCliStatus {
  cached ??= resolveClaudeCliStatus();
  return cached;
}

export function refreshClaudeCli(): ClaudeCliStatus {
  cached = resolveClaudeCliStatus();
  return cached;
}

/**
 * The copy a client may see, for `hello`.
 *
 * Built field by field rather than by spreading, because `path` is an absolute
 * path to the binary: it names the host's home directory and therefore their
 * username, to anyone holding a socket. A spread with a `delete` would put that
 * one line's correctness between every future field and the wire; this cannot
 * leak a field nobody listed.
 */
export function publicClaudeCliStatus(status: ClaudeCliStatus = claudeCliStatus()): ClaudeCliStatus {
  return {
    state: status.state,
    ...(status.version ? { version: status.version } : {}),
    minVersion: status.minVersion,
  };
}

/**
 * Why a turn cannot run, for a user who has never heard of a PATH. Null when
 * the CLI is fine. This is what the browser shows, so it names the fix rather
 * than the fault.
 */
export function claudeCliRefusalMessage(status: ClaudeCliStatus = claudeCliStatus()): string | null {
  if (status.state === 'ok') return null;
  if (status.state === 'missing') {
    return `Claude Code not found on this machine — install it from ${CLAUDE_INSTALL_URL}`;
  }
  return (
    `Claude Code ${status.version} on this machine is older than the ${status.minVersion} Lines ` +
    'needs — run `claude update`, then Retry.'
  );
}
