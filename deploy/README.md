# Deploying the server side of Lines

Lines splits across two machines:

| Runs where | Processes | Why |
|---|---|---|
| The user's own machine | bridge + worker (supervised by the desktop app) | The worker spawns Claude Code and needs the user's filesystem. It dials **out** to the relay, so the machine needs no inbound port and no NAT setup. |
| This server | relay + storage + the static web bundle | A dumb frame pipe, a Clerk-authed Postgres API, and a directory of files. No agent turn ever executes here. |

That split is the security story. The server holds no agent, no workspaces, and
no `~/.lines-app` — that directory is the source of truth and lives on the
user's machine, so **server backups are not the backup that matters**.

Everything here is containers behind the Traefik instance that Hostinger's
image already ships at `/docker/traefik`.

## Status: not yet usable end to end

The server side deploys and is verifiable today. The client side is not
finished, and no amount of deployment fixes it:

1. **`web/src/ws.ts:163` sends no device id.** It builds `` `${WS_URL}/?token=…` ``,
   and the relay closes `1008 'device required'` when `?device=` is absent
   (`relay/src/index.ts:112-116`).
2. **The same line produces the wrong path.** `wss://host/client` becomes
   `/client/?token=…`, and the relay compares `url.pathname === '/client'`
   exactly (`:118`), so it answers `1008 'unknown endpoint'`.
3. **Nothing in `web/src` can discover a device.** The only `fetch()` in the
   whole client is the dev-only `/__bridge` probe. A device picker needs
   `GET /v1/devices` from the browser, which also means exposing storage
   through Traefik — it is deliberately unexposed today.
4. **There is no pairing flow.** `desktop/src/main.ts` never mentions devices.
   Storage has `/v1/devices/register`, `/claim`, `/verify`, and the bridge reads
   `LINES_DEVICE_ID` / `LINES_DEVICE_SECRET` from its environment — so pairing
   is currently a manual API call plus two environment variables.

So: deploy the server, confirm it is healthy, then treat the client work as the
next task.

## Prerequisites

- A VPS with Docker and the stock Traefik stack in `/docker/traefik`
  (`--providers.docker.exposedbydefault=false`, ACME via HTTP challenge,
  HTTP→HTTPS redirect — all default in that image).
- `A <domain> → <VPS IP>` resolving **before** the first `up`; Traefik issues
  the certificate on demand via the HTTP challenge.
- Ports 80 and 443 open, nothing else. The relay and storage never publish a
  port; Traefik reaches the relay on the internal network.
- Set `ACME_EMAIL` in `/docker/traefik/.env` to a real address — the stock value
  is `admin@<hostname>.hstgr.cloud`, so expiry warnings go nowhere.

## Deploy

```bash
git clone git@github.com:bytasv/lines.git ~/app && cd ~/app/deploy/docker
cp env.example lines.env && chmod 600 lines.env
$EDITOR lines.env                       # every field is annotated

docker compose --env-file lines.env build
docker compose --env-file lines.env run --rm migrate    # BEFORE first up
docker compose --env-file lines.env up -d
docker compose --env-file lines.env ps
```

`lines.env` is used twice — as compose's `--env-file` (so `${LINES_DOMAIN}` and
the `VITE_*` build args interpolate) and as `env_file:` for the two services. It
is gitignored by exact path; the repo's `.env.*` rule does not match this name.

Build on your laptop or in CI if the box is small: the web build peaks around
1.5 GB and will compete with anything else running.

## What each piece does

**`relay`** — pipes frames between a browser on `/client` and the user's bridge
on `/agent`. Deliberately dumb: never parses, persists or logs an app payload.
Holds no database credentials, because it is the most exposed process here — it
asks storage to verify a device secret and gets back only the owning user id.

**`storage`** — Clerk-authed Express + Prisma against hosted Supabase. **No
Traefik labels at all**, so it is unroutable from the internet; the relay
reaches it at `http://storage:8790` on the compose network. This is a stronger
boundary than the firewall rule it replaces.

**`web`** — `nginx:alpine` with the built bundle. Traefik cannot serve files, so
the bundle brings its own server. TLS and redirects stay in Traefik; this nginx
only does SPA fallback and cache headers.

## Traps this configuration exists to avoid

- **Never add a `StripPrefix` middleware to the relay router.** The relay
  matches `url.pathname === '/client'` exactly, so a rewritten path closes the
  socket with `1008`. This is the Traefik-shaped version of the classic nginx
  `proxy_pass`-with-trailing-slash bug.
- **`VITE_*` are baked at image build time**, not read at runtime. Changing the
  Clerk key or the socket URL means `docker compose build web && up -d web`. The
  Dockerfile greps the built bundle for `VITE_BRIDGE_WS_URL` and fails the build
  if it is missing, because otherwise the app builds fine and reconnects
  forever.
- **`npm ci --ignore-scripts` skips `prisma generate`**, so the storage stage
  runs it explicitly. Without it the server dies at `$connect()`.
- **`--omit=optional` is safe here and only here**: it drops the 262 MB Linux
  `claude` binary. Nothing on this server spawns an agent query. Do not copy
  that flag to a machine that runs the worker.
- **Migrate before the first `up`.** `prisma migrate deploy` is forward-only and
  uses `DIRECT_URL` (`:5432`), not the pooled `:6543`. Started against an empty
  schema, storage looks healthy while every query fails P2021 — and sync treats
  storage errors as best-effort, so the only symptom is an amber banner in the
  UI.
- **`RELAY_AUTH_DISABLED` must never be set.** It accepts any device secret and
  binds every client to one user.

## Verification

```bash
docker compose --env-file lines.env ps          # storage + relay healthy, web up
docker compose --env-file lines.env exec relay \
  node -e "fetch('http://127.0.0.1:8791/').then(r=>r.json()).then(console.log)"
#   -> { ok: true, version: <n>, devices: 0 }
docker compose --env-file lines.env exec relay \
  node -e "fetch('http://storage:8790/health').then(r=>r.json()).then(console.log)"
#   -> { ok: true }
curl -sI https://<domain>/ | head -3            # 200, valid cert
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/some/deep/route   # 200, SPA fallback
```

- [ ] `https://<domain>/` loads and Clerk sign-in completes.
- [ ] `http://` redirects to `https://` (Traefik does this globally).
- [ ] Storage is **not** reachable from outside: it has no published port and no
      Traefik labels.
- [ ] `docker compose logs relay` shows no `[relay] device verification failed`.
- [ ] A browser socket to `/client` is rejected with `1008 'device required'` —
      expected until the client work below lands, and proof the relay is
      enforcing.

## Updating

```bash
cd ~/app && git pull --ff-only origin main && cd deploy/docker
docker compose --env-file lines.env build
docker compose --env-file lines.env run --rm migrate   # if storage/prisma changed
docker compose --env-file lines.env up -d
```

Rollback is `git checkout <tag>` plus the same three commands, or re-tagging a
previously built image. Migrations do **not** roll back: `migrate deploy` is
forward-only and the schema is additive, so roll the code back and leave the
schema forward.

## Adding another app to this box

Give it a compose file, put it on its own network, and label it for Traefik:

```yaml
labels:
  traefik.enable: "true"
  traefik.http.routers.myapp.rule: "Host(`myapp.example.com`)"
  traefik.http.routers.myapp.entrypoints: websecure
  traefik.http.routers.myapp.tls.certresolver: letsencrypt
  traefik.http.services.myapp.loadbalancer.server.port: "3000"
```

DNS, then `up -d`. No config file to edit, no certificate command to run.

Keep each app's secrets in its own `chmod 600` env file, and do not put secrets
in compose `environment:` blocks that end up in `docker inspect` output for
anyone in the `docker` group. Membership of that group is root-equivalent —
grant it to nobody you would not give root.
