// SPDX-License-Identifier: AGPL-3.0-only
// Additional permission under GNU AGPL v3 section 7 — see LICENSE-EXCEPTION.

/**
 * The whisper.cpp install this machine transcribes voice input with.
 *
 * Same shape as `codexCli.ts`. Two things must be present, not one: the binary
 * and a model file, reported apart because the fix for each differs. The desktop
 * app ships the binary; the model (148 MB) is fetched on request by
 * `whisperModel.ts`. A dev checkout or a VPS bridge still needs Homebrew.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMultilingualWhisperModel, WHISPER_INSTALL_COMMAND, WHISPER_MODELS } from '@lines/shared';
import type { WhisperStatus } from '@lines/shared';
import { compareVersions } from './claudeCli.ts';
import { APP_ROOT } from './workerProtocol.ts';

export type { WhisperStatus };

/**
 * The oldest whisper.cpp we drive. 1.7.4 is where the example binary was renamed
 * `main` -> `whisper-cli`, and the flags `transcribe.ts` passes (`-m -f -nt -np`)
 * have held since. Older `whisper-cli` builds do not exist, so this mostly guards
 * against a future rename of those flags — bump it when they move.
 */
export const MIN_WHISPER_VERSION = '1.7.4';

/** Injection seams, the same shape as `CodexDiscoveryDeps`. */
export interface WhisperDiscoveryDeps {
  env?: NodeJS.ProcessEnv;
  /** `~/.lines-app`, where the default model lives under `models/`. */
  appRoot?: string;
  /** True when the path is an existing, executable file. */
  isExecutable?: (candidate: string) => boolean;
  /** True when the path is an existing, readable file. */
  isFile?: (candidate: string) => boolean;
  /** `command -v whisper-cli` against the inherited PATH; null when not found. */
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

function isReadableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function whisperOnPath(): string | null {
  try {
    const out = execFileSync('/bin/sh', ['-c', 'command -v whisper-cli'], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Every place a `whisper-cli` may live, in the order we prefer it.
 *
 * `LINES_WHISPER_BIN` is exclusive, like `LINES_CODEX_PATH`: a wrong pin must fail
 * loudly rather than quietly run some other binary.
 *
 * `LINES_WHISPER_BUNDLED_BIN` is the copy the desktop app ships in its resources
 * (see desktop/scripts/build-whisper.mjs) and comes first: it is the version the
 * flags in `transcribe.ts` were checked against, and it is the reason a desktop
 * user never needs Homebrew. Homebrew before PATH because the packaged app
 * inherits a GUI PATH that usually has neither.
 */
export function whisperCandidatePaths(deps: WhisperDiscoveryDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const onPath = deps.onPath ?? whisperOnPath;
  if (env.LINES_WHISPER_BIN) return [env.LINES_WHISPER_BIN];
  return [
    env.LINES_WHISPER_BUNDLED_BIN,
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
    onPath(),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

/** Where downloaded models live: `<app root>/models`. */
export function whisperModelsDir(deps: WhisperDiscoveryDeps = {}): string {
  return path.join(deps.appRoot ?? APP_ROOT, 'models');
}

/**
 * Installed models, file name -> path. `LINES_WHISPER_MODEL` is exclusive, like
 * `LINES_WHISPER_BIN`: whoever pinned a model gets exactly that one. Otherwise
 * only the known {@link WHISPER_MODELS} are looked for — a stray `.bin` in the
 * folder is not something to hand a native binary unasked.
 */
export function installedWhisperModels(deps: WhisperDiscoveryDeps = {}): Record<string, string> {
  const env = deps.env ?? process.env;
  const isFile = deps.isFile ?? isReadableFile;
  if (env.LINES_WHISPER_MODEL) {
    return isFile(env.LINES_WHISPER_MODEL) ? { [path.basename(env.LINES_WHISPER_MODEL)]: env.LINES_WHISPER_MODEL } : {};
  }
  const dir = whisperModelsDir(deps);
  const found: Record<string, string> = {};
  for (const { file } of WHISPER_MODELS) {
    const candidate = path.join(dir, file);
    if (isFile(candidate)) found[file] = candidate;
  }
  return found;
}

/** Preference rank: position in WHISPER_MODELS (best first); a pinned unknown
 *  file ranks ahead, being the only one there is. */
function rank(file: string): number {
  return WHISPER_MODELS.findIndex((m) => m.file === file);
}

/**
 * Which installed model a recording in `language` should use — the same rule as
 * the shared `whisperModelFor`, plus a fallback that costs nothing:
 *
 * - English: the English-only model, else a multilingual one (which also
 *   handles English, just slower).
 * - Anything else, `auto` included: a multilingual model, or a refusal — an
 *   English-only model would return confident English nonsense.
 */
export function pickWhisperModel(
  models: Record<string, string>,
  language: string,
): { file: string; path: string; multilingual: boolean } | { error: string } {
  const files = Object.keys(models).sort((a, b) => rank(a) - rank(b));
  const multilingual = files.filter(isMultilingualWhisperModel);
  const englishOnly = files.filter((f) => !isMultilingualWhisperModel(f));
  const chosen =
    language === 'en'
      ? (englishOnly[0] ?? multilingual[0])
      : multilingual[0];
  if (!chosen) {
    return files.length
      ? { error: 'Dictating in that language needs the multilingual model — download it in Settings → Voice input.' }
      : { error: 'Voice input needs a whisper model — download one in Settings → Voice input.' };
  }
  return { file: chosen, path: models[chosen], multilingual: isMultilingualWhisperModel(chosen) };
}

/**
 * `x.y.z` out of `whisper-cli --version`. Null when the build has no such flag
 * (older ones print usage and exit non-zero) — "cannot vouch for it", which
 * `resolveWhisperStatus` lets run.
 */
export function readWhisperVersion(binary: string): string | null {
  try {
    const out = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
  } catch {
    return null;
  }
}

/** Discovery with the model and floor checks applied. Never throws. */
export function resolveWhisperStatus(deps: WhisperDiscoveryDeps = {}): WhisperStatus {
  const isExecutable = deps.isExecutable ?? isExecutableFile;
  const isFile = deps.isFile ?? isReadableFile;
  const readVersion = deps.readVersion ?? readWhisperVersion;
  const binary = whisperCandidatePaths(deps).find((candidate) => isExecutable(candidate));
  if (!binary) return { state: 'missing-binary', minVersion: MIN_WHISPER_VERSION };
  const version = readVersion(binary);
  const found = { path: binary, ...(version ? { version } : {}), minVersion: MIN_WHISPER_VERSION };
  if (version && compareVersions(version, MIN_WHISPER_VERSION) < 0) {
    return { state: 'outdated', ...found };
  }
  const modelPaths = installedWhisperModels({ ...deps, isFile });
  const models = Object.keys(modelPaths);
  if (!models.length) return { state: 'missing-model', ...found, models };
  return { state: 'ready', ...found, models, modelPaths };
}

let cached: WhisperStatus | null = null;
let probedAt = 0;

/** Same retry window as the CLI probes: installing whisper or dropping the model
 *  in place should light the mic button up without a bridge restart. */
const RETRY_FAILED_AFTER_MS = 10_000;

/** Cached like `codexCliStatus`: a ready answer for the life of the bridge, a
 *  failed one for {@link RETRY_FAILED_AFTER_MS}. */
export function whisperStatus(): WhisperStatus {
  if (cached && (cached.state === 'ready' || Date.now() - probedAt < RETRY_FAILED_AFTER_MS)) {
    return cached;
  }
  return refreshWhisperStatus();
}

/** Probe again now — after the bridge has put the model in place itself, the
 *  retry window would only delay the mic lighting up. */
export function refreshWhisperStatus(): WhisperStatus {
  cached = resolveWhisperStatus();
  probedAt = Date.now();
  return cached;
}

/** The copy a client may see — field by field, so neither absolute path (which
 *  names the host's home directory) can leak. */
export function publicWhisperStatus(status: WhisperStatus = whisperStatus()): WhisperStatus {
  return {
    state: status.state,
    ...(status.version ? { version: status.version } : {}),
    ...(status.models ? { models: status.models } : {}),
    minVersion: status.minVersion,
  };
}

/** Why voice input cannot run, naming the fix. Null when it can. */
export function whisperRefusalMessage(status: WhisperStatus = whisperStatus()): string | null {
  switch (status.state) {
    case 'ready':
      return null;
    case 'missing-binary':
      return `Voice input needs whisper.cpp on this machine — install it with \`${WHISPER_INSTALL_COMMAND}\`.`;
    case 'outdated':
      return (
        `whisper.cpp ${status.version} on this machine is older than the ${status.minVersion} Lines ` +
        `needs — run \`brew upgrade whisper-cpp\`.`
      );
    case 'missing-model':
      return 'Voice input needs a whisper model — download one in Settings → Voice input.';
  }
}
