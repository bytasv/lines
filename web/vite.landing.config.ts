import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { subresourceIntegrity } from './vite.config';

/**
 * The static marketing build of LandingPage, served on the apex.
 *
 * A separate build rather than a route of the app's, because the apex is the
 * relay's host: it must never serve the bundle that holds the end-to-end
 * encryption keys (see deploy/docker/compose.yml). This one is keyless and
 * Clerk-free — web/src/landing.tsx mounts nothing but the page.
 *
 * Paths are anchored to this directory, not to `root`, which Vite would
 * otherwise resolve them against.
 */
const here = import.meta.dirname;

export default defineConfig({
  root: path.resolve(here, 'landing'),
  plugins: [react(), subresourceIntegrity()],
  // VITE_* vars load from the repo-root .env, as in vite.config.ts.
  envDir: path.resolve(here, '..'),
  // The app's icons; the page links favicon.png and apple-touch-icon.png.
  publicDir: path.resolve(here, 'public'),
  build: {
    outDir: path.resolve(here, 'dist-landing'),
    emptyOutDir: true,
  },
  server: { fs: { allow: [path.resolve(here, '..')] } },
});
