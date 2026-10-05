#!/usr/bin/env node
/**
 * Builds the `whisper-cli` the desktop app ships, so voice input needs no
 * Homebrew on a user's Mac.
 *
 * From a pinned whisper.cpp source release, with everything the binary needs
 * linked in: static ggml/whisper libraries (no dylibs to carry beside it) and
 * the Metal shaders embedded (no `.metallib` to locate at runtime). The only
 * dependencies left are system frameworks.
 *
 * Output: `dist/whisper/whisper-cli`, picked up by electron-builder's
 * `extraResources` and handed to the bridge as `LINES_WHISPER_BUNDLED_BIN`.
 * Cached by version, so repeated packaging does not recompile it.
 *
 * Needs `cmake` (present on the GitHub macOS runner; `brew install cmake`
 * locally). Without it a local build skips the binary with a warning — the app
 * then falls back to Homebrew's — but CI fails, so a release never ships
 * without it by accident.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Bump deliberately, and check the flags `server/src/transcribe.ts` passes. */
const WHISPER_CPP_VERSION = '1.7.6';

const DESKTOP = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(DESKTOP, 'dist', 'whisper');
const OUT = path.join(OUT_DIR, 'whisper-cli');
const STAMP = path.join(OUT_DIR, 'VERSION');

function have(command) {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function buildWhisper() {
  // Always present, even empty: `extraResources` names this directory.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (process.platform !== 'darwin') {
    console.warn('[whisper] not macOS — skipping the bundled whisper-cli');
    return;
  }
  if (fs.existsSync(OUT) && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === WHISPER_CPP_VERSION) {
    console.log(`[whisper] whisper-cli ${WHISPER_CPP_VERSION} already built`);
    return;
  }
  if (!have('cmake')) {
    const message = '[whisper] cmake not found — the app will ship without whisper-cli';
    if (process.env.CI) throw new Error(`${message} (refusing in CI)`);
    console.warn(`${message}. brew install cmake to bundle it.`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-whisper-build-'));
  try {
    const tarball = path.join(work, 'src.tar.gz');
    const url = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.tar.gz`;
    console.log(`[whisper] fetching ${url}`);
    execFileSync('curl', ['-fsSL', '-o', tarball, url], { stdio: 'inherit' });
    execFileSync('tar', ['-xzf', tarball, '-C', work], { stdio: 'inherit' });
    const src = path.join(work, `whisper.cpp-${WHISPER_CPP_VERSION}`);
    const build = path.join(src, 'build');
    execFileSync(
      'cmake',
      [
        '-S', src,
        '-B', build,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_OSX_ARCHITECTURES=arm64',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DGGML_METAL=ON',
        '-DGGML_METAL_EMBED_LIBRARY=ON',
        '-DWHISPER_BUILD_TESTS=OFF',
        '-DWHISPER_BUILD_SERVER=OFF',
        '-DWHISPER_SDL2=OFF',
      ],
      { stdio: 'inherit' },
    );
    execFileSync('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '-j'], {
      stdio: 'inherit',
    });
    fs.copyFileSync(path.join(build, 'bin', 'whisper-cli'), OUT);
    fs.chmodSync(OUT, 0o755);
    // Ad-hoc so it runs unpackaged: arm64 refuses to run an unsigned binary, and
    // a copied linker signature is not worth trusting. electron-builder re-signs
    // it with the Developer ID when the app is packaged.
    execFileSync('codesign', ['--force', '--sign', '-', OUT], { stdio: 'inherit' });
    fs.writeFileSync(STAMP, `${WHISPER_CPP_VERSION}\n`);
    console.log(`[whisper] built ${path.relative(DESKTOP, OUT)} (${WHISPER_CPP_VERSION})`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) buildWhisper();
