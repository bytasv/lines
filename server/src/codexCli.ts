// SPDX-License-Identifier: AGPL-3.0-only
// Additional permission under GNU AGPL v3 section 7 — see LICENSE-EXCEPTION.

/**
 * The Codex CLI this machine has installed.
 *
 * The mirror of `claudeCli.ts`, for the same reason and with the same shape: the
 * packaged app ships no `codex` binary either, so a missing or too-old one has to
 * become a sentence a non-developer can act on rather than a crash inside
 * `@openai/codex-sdk` (which reports a failed spawn as
 * `Codex Exec exited with code 1: <stderr>`).
 *
 * Kept as its own module rather than parameterizing `claudeCli.ts`: the two share
 * their *structure*, not their candidates, their version floor or their copy, and
 * the shared half is four lines of `x.y.z` comparison.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions } from './claudeCli.ts';

/**
 * The oldest `codex` we are willing to drive: the version the pinned
 * `@openai/codex-sdk` ships alongside — the two are published from one repo on
 * one version line, so the SDK's version *is* the CLI it was written against.
 *
 * Like `MIN_CLAUDE_VERSION`, this gate is ours or nobody's: the SDK performs no
 * version handshake, and an unknown flag (`--experimental-json`, `exec resume`,
 * `--add-dir`) surfaces only as a non-zero exit with CLI text on stderr.
 *
 * It is also the floor for the models in `DEFAULT_MODELS`: `gpt-6-astra` and the
 * GPT-5.6 family only exist on 0.153.4 and up, so an older CLI would fail every
 * turn with a model-not-found error instead of this sentence.
 *
 * Bump this with the SDK dependency, not independently.
 */
export const MIN_CODEX_VERSION = '0.154.0';

/** Where to send someone who has no CLI at all. */
export const CODEX_INSTALL_URL = 'https://developers.openai.com/codex/cli';

export type CodexCliState = 'ok' | 'missing' | 'outdated';

export interface CodexCliStatus {
  state: CodexCliState;
  /** Absolute path to the binary; absent only when `state === 'missing'`. */
  path?: string;
  /** Parsed `x.y.z`; absent when the binary exists but would not report one. */
  version?: string;
  /** Echoed so callers can word their own message without importing the constant. */
  minVersion: string;
}

/** Injection seams, so discovery order is testable without a real filesystem.
 *  Same shape as `claudeCli.ts`'s `DiscoveryDeps`, deliberately. */
export interface CodexDiscoveryDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** True when the path is an existing, executable file. */
  isExecutable?: (candidate: string) => boolean;
  /** `command -v codex` against the inherited PATH; null when not found. */
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

/** `codex` on PATH, through `sh -c` for the same reason the Claude probe is. */
function codexOnPath(): string | null {
  try {
    const out = execFileSync('/bin/sh', ['-c', 'command -v codex'], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * The CLI the SDK would have resolved itself, from its optional platform package.
 * Last, never first — and in this repo the global `~/.npmrc` sets
 * `ignore-scripts=true`, so it may simply not be there after an `npm i`.
 */
function sdkBundledCli(): string | null {
  const target =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'darwin-arm64'
        : 'darwin-x64'
      : process.platform === 'linux'
        ? process.arch === 'arm64'
          ? 'linux-arm64'
          : 'linux-x64'
        : process.arch === 'arm64'
          ? 'win32-arm64'
          : 'win32-x64';
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  try {
    return createRequire(import.meta.url).resolve(`@openai/codex-${target}/bin/${binary}`);
  } catch {
    return null;
  }
}

/**
 * Every place a `codex` may live, in the order we prefer it.
 *
 * `LINES_CODEX_PATH` is exclusive, not merely first — same rule as
 * `LINES_CLAUDE_PATH`: someone who pinned a binary must not silently get a
 * different one when the pin is wrong, and it makes "no CLI at all" reachable in
 * a test on a machine that has one.
 */
export function codexCandidatePaths(deps: CodexDiscoveryDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const onPath = deps.onPath ?? codexOnPath;
  if (env.LINES_CODEX_PATH) return [env.LINES_CODEX_PATH];
  return [
    path.join(home, '.local', 'bin', 'codex'),
    onPath(),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    sdkBundledCli(),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

/**
 * `x.y.z` out of `--version` output like `codex-cli 0.52.0`. Null when the binary
 * refuses to run or prints something unrecognisable — "cannot vouch for it"
 * rather than a failure, see `resolveCodexCliStatus`.
 */
export function readCodexVersion(binary: string): string | null {
  try {
    const out = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
  } catch {
    return null;
  }
}

/** First candidate that both exists and answers `--version`; a version-less
 *  binary is still returned, exactly as `findClaudeCli` does. */
export function findCodexCli(
  deps: CodexDiscoveryDeps = {},
): { path: string; version: string | null } | null {
  const isExecutable = deps.isExecutable ?? isExecutableFile;
  const version = deps.readVersion ?? readCodexVersion;
  for (const candidate of codexCandidatePaths(deps)) {
    if (!isExecutable(candidate)) continue;
    return { path: candidate, version: version(candidate) };
  }
  return null;
}

/** Discovery result with the floor check applied. Never throws. */
export function resolveCodexCliStatus(deps: CodexDiscoveryDeps = {}): CodexCliStatus {
  const found = findCodexCli(deps);
  if (!found) return { state: 'missing', minVersion: MIN_CODEX_VERSION };
  // No parsable version → let it run, rather than refuse a working install over a
  // formatting change in `--version`.
  if (found.version && compareVersions(found.version, MIN_CODEX_VERSION) < 0) {
    return { state: 'outdated', path: found.path, version: found.version, minVersion: MIN_CODEX_VERSION };
  }
  return {
    state: 'ok',
    path: found.path,
    ...(found.version ? { version: found.version } : {}),
    minVersion: MIN_CODEX_VERSION,
  };
}

let cached: CodexCliStatus | null = null;

/** Cached per process: discovery spawns `--version` and a login shell, and the
 *  answer is asked for on every codex turn push. */
export function codexCliStatus(): CodexCliStatus {
  cached ??= resolveCodexCliStatus();
  return cached;
}

export function refreshCodexCli(): CodexCliStatus {
  cached = resolveCodexCliStatus();
  return cached;
}

/**
 * Why a codex turn cannot run, for a user who has never heard of a PATH. Null
 * when the CLI is fine. Names the fix, not the fault.
 */
export function codexCliRefusalMessage(status: CodexCliStatus = codexCliStatus()): string | null {
  if (status.state === 'ok') return null;
  if (status.state === 'missing') {
    return (
      'The Codex CLI is not installed on this machine — install it with ' +
      `\`npm i -g @openai/codex\` (see ${CODEX_INSTALL_URL}), then Retry.`
    );
  }
  return (
    `Codex ${status.version} on this machine is older than the ${status.minVersion} Lines ` +
    'needs — run `npm i -g @openai/codex`, then Retry.'
  );
}
