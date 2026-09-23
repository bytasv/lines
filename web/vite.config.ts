import { createHash } from 'node:crypto';
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
  const lockFile = path.join(os.homedir(), '.lines-app', 'bridge.lock');
  return {
    name: 'lines-bridge-discovery',
    configureServer(server) {
      /**
       * Which machine this page sits at, when it sits at this one.
       *
       * With a relay in the loop the bridge sees every browser as remote, so the
       * host's own tab loses "Browse…" like a phone does. The dev server can
       * tell them apart: a request whose source address is one of this
       * machine's own came from a browser on it. Answers the running bridge's
       * device id then (from its lock file), `null` otherwise — the same
       * `lines.hostDeviceId` the desktop shell hands its window. A proxied
       * request (a tunnel arrives from loopback) never counts.
       */
      server.middlewares.use('/__host', (req, res) => {
        const bare = (a?: string) => (a ?? '').replace(/^::ffff:/, '');
        const remote = bare(req.socket.remoteAddress);
        const proxied = !!(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']);
        const sameMachine = !proxied && remote !== '' && remote === bare(req.socket.localAddress);
        let deviceId: string | null = null;
        if (sameMachine) {
          try {
            deviceId = (JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { deviceId?: string }).deviceId ?? null;
          } catch {
            deviceId = null; // no bridge holds the machine right now
          }
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ deviceId }));
      });
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
 * Subresource integrity for the scripts and stylesheets `index.html` references.
 *
 * Be precise about what this buys, because it is easy to overstate: it protects
 * the *chunks*, not the HTML that names them. Against an attacker who can
 * rewrite the served `index.html` it buys nothing — they simply write new hashes.
 * Its value is against a compromised asset host and against accidental drift
 * between a cached chunk and the HTML that expects it.
 *
 * The real mitigation for a compromised web origin is not being able to serve
 * JavaScript from it at all, which is why the relay now lives on a different
 * hostname (see deploy/docker/compose.yml).
 */
function subresourceIntegrity(): Plugin {
  return {
    name: 'lines-sri',
    enforce: 'post',
    writeBundle(options, bundle) {
      const outDir = options.dir ?? 'dist';
      const indexPath = path.join(outDir, 'index.html');
      let html: string;
      try {
        html = fs.readFileSync(indexPath, 'utf8');
      } catch {
        return; // no HTML entry (library build): nothing to pin
      }
      const digests = new Map<string, string>();
      for (const [fileName, chunk] of Object.entries(bundle)) {
        // Hashed from what was written, not from what was read back: an asset
        // copied from `public/` is not in the bundle at all, so it simply has no
        // digest here and is left unpinned rather than pinned wrongly.
        const source = chunk.type === 'chunk' ? chunk.code : chunk.source;
        digests.set(`/${fileName}`, `sha384-${createHash('sha384').update(source).digest('base64')}`);
      }
      const withIntegrity = html.replace(
        /<(script|link)\b([^>]*?)(src|href)="([^"]+)"([^>]*)>/g,
        (tag, name: string, before: string, attr: string, url: string, after: string) => {
          const digest = digests.get(url);
          // Only same-origin emitted assets: an external URL has no hash here,
          // and adding a wrong one would block the resource outright.
          if (!digest || tag.includes('integrity=')) return tag;
          // Vite already emits `crossorigin` on these tags; a second copy is
          // invalid markup even though browsers tolerate it.
          const cors = tag.includes('crossorigin') ? '' : ' crossorigin="anonymous"';
          return `<${name}${before}${attr}="${url}"${after} integrity="${digest}"${cors}>`;
        },
      );
      fs.writeFileSync(indexPath, withIntegrity);
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

/**
 * Optional TLS + a same-origin proxy for the dev server.
 *
 * Why it exists: WebCrypto only runs in a secure context. `localhost` counts,
 * but `http://192.168.x.x` does not — so a second laptop or a phone on the LAN
 * cannot hold an encryption key, and enrollment is impossible there. Serving
 * dev over https fixes that for every device at once.
 *
 * The proxy is the other half, and it is not optional once TLS is on: an https
 * page may not open a `ws://` socket or fetch `http://` (mixed content), so the
 * relay and the storage server have to arrive through this same origin. `/client`
 * is the relay's WebSocket endpoint and `/v1` is storage's whole API, neither of
 * which collides with an app route.
 *
 * Opt-in via `LINES_DEV_TLS=1`, because the plain-http path is what Tilt and
 * every existing checkout use, and a dev server that suddenly needs a
 * certificate is a worse default than one that cannot enrol a phone.
 */
function devTls(): { https?: { cert: Buffer; key: Buffer }; proxy?: Record<string, unknown> } {
  if (process.env.LINES_DEV_TLS !== '1') return {};
  const certDir = process.env.LINES_DEV_CERT_DIR ?? path.resolve(import.meta.dirname, 'certs');
  const cert = path.join(certDir, 'dev-cert.pem');
  const key = path.join(certDir, 'dev-key.pem');
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    // Loud, not silent: falling back to http here would leave the user staring
    // at the same "not a secure origin" banner with no idea why.
    throw new Error(
      `LINES_DEV_TLS=1 but no certificate at ${certDir}. Generate one with:\n` +
        `  mkcert -cert-file ${cert} -key-file ${key} localhost 127.0.0.1 ::1 <your-lan-ip>`,
    );
  }
  const relayPort = process.env.LINES_DEV_RELAY_PORT ?? '8791';
  const storagePort = process.env.LINES_DEV_STORAGE_PORT ?? '8790';
  return {
    https: { cert: fs.readFileSync(cert), key: fs.readFileSync(key) },
    proxy: {
      // `ws: true` matters — without it the upgrade request is proxied as a
      // plain GET and the socket closes immediately.
      '/client': { target: `ws://127.0.0.1:${relayPort}`, ws: true, changeOrigin: true },
      '/v1': { target: `http://127.0.0.1:${storagePort}`, changeOrigin: true },
    },
  };
}

export default defineConfig({
  plugins: [react(), bridgeDiscovery(), subresourceIntegrity()],
  define: { __LINES_VERSION__: JSON.stringify(WEB_VERSION) },
  // VITE_* vars load from the repo-root .env (shared with the bridge).
  envDir: '..',
  server: {
    port: 5173,
    ...devTls(),
    // Every interface, not just loopback: the point of the dev server now is to
    // be opened from a phone on the same Wi-Fi. The bridge already binds this
    // way, and `/__bridge` hands the browser its port, so a phone reaches both
    // halves with no further configuration.
    //
    // Worth knowing what that exposes: anyone on the same network can open this
    // dev server, and the bridge behind it runs agent turns. A LAN socket is not
    // loopback, so `hello.local` is false there and the host-side folder picker
    // is hidden — but everything else a session can do is reachable. Fine on a
    // home or phone-hotspot network; not something to leave running on a café's.
    host: true,
    // Vite refuses a request whose Host header is a name it does not know, which
    // is what a tunnel (cloudflared, ngrok) sends. IPs are always allowed, so
    // this is only needed for the https-tunnel path — and it is opt-in rather
    // than a blanket `true`, since that would accept DNS-rebinding hosts too.
    ...(process.env.LINES_DEV_HOSTS
      ? { allowedHosts: process.env.LINES_DEV_HOSTS.split(',').map((h) => h.trim()) }
      : {}),
    fs: { allow: ['..'] },
  },
});
