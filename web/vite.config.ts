import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-only bridge discovery.
 *
 * The bridge binds an ephemeral port and publishes it to
 * `~/.lines-app/run/<instance>/bridge.json`. The browser can't read that file,
 * so the dev server hands out the port at `/__bridge`.
 *
 * The path convention is duplicated from server/src/workerProtocol.ts rather
 * than imported: this is a Node-side dev config in a workspace that has no
 * dependency on the server package, and the file format is a stable two-field
 * contract. Only `port` is exposed — never the token.
 */
function bridgeDiscovery(): Plugin {
  const instance = process.env.LINES_INSTANCE ?? 'default';
  const file = path.join(os.homedir(), '.lines-app', 'run', instance, 'bridge.json');
  return {
    name: 'lines-bridge-discovery',
    configureServer(server) {
      server.middlewares.use('/__bridge', (_req, res) => {
        // Read per request: the bridge republishes on every restart, and a dev
        // server outlives many of those.
        let port: number | null = null;
        try {
          port = (JSON.parse(fs.readFileSync(file, 'utf8')) as { port: number }).port ?? null;
        } catch {
          port = null; // bridge down or still booting
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ port }));
      });
    },
  };
}

/**
 * Version of this bundle, read at config time.
 *
 * Mirrors the bridge's `__LINES_VERSION__` (server/src/index.ts) rather than
 * introducing a `VITE_` var: this is the app's own identity, not deployment
 * configuration, and a browser has no package.json to read it from at runtime.
 */
const WEB_VERSION: string = (() => {
  try {
    const pkg = fs.readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8');
    return (JSON.parse(pkg) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export default defineConfig({
  plugins: [react(), bridgeDiscovery()],
  define: { __LINES_VERSION__: JSON.stringify(WEB_VERSION) },
  // VITE_* vars load from the repo-root .env (shared with the bridge).
  envDir: '..',
  server: {
    port: 5173,
    fs: { allow: ['..'] },
  },
});
