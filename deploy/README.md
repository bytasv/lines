# Deploying the server side of Lines

Lines splits across two machines:

| Runs where | Processes | Why |
|---|---|---|
| The user's own machine | bridge + worker (supervised by the desktop app) | The worker spawns Claude Code and needs the user's filesystem. It dials **out** to the relay, so the machine needs no inbound port and no NAT setup. |
| This server | relay + storage + the static web bundle | A dumb frame pipe, a Clerk-authed Postgres API, and a directory of files. No agent turn ever executes here. |

That split is the security story. The server holds no agent, no workspaces, and
no `~/.lines-app` — that directory is the source of truth and lives on the
user's machine, so **server backups are not the backup that matters**.

Everything here is containers behind the Traefik instance the host image
already ships at `${TRAEFIK_ROOT}`.

Two placeholders run through this document: `${TRAEFIK_ROOT}` is wherever the
host image put its Traefik stack, and `${DEPLOY_ROOT}` is wherever you check
this repo out on the VPS. Substitute your own paths, or `export DEPLOY_ROOT=...`
in the shell you run the commands from.

## Status: working end to end

A signed-in user reaches `<domain>`, downloads the macOS app, pairs it with
the code it shows, and runs turns on their own machine. The four client-side
blockers this section used to list — no device id on the socket, the wrong
`/client` path, no way to discover a device, no pairing flow — are all
implemented. `web/src/ws.ts` names the device, `web/src/lib/storage.ts` lists
them, storage is exposed through Traefik at `api.<domain>`, and
`desktop/src/main.ts` registers this machine and shows the pairing code.

The desktop build's signing and auto-update status is a packaging matter, not a
deployment one — see `docs/codebase/features/desktop-app.md`.

## Prerequisites

- A VPS with Docker and a stock Traefik stack in `${TRAEFIK_ROOT}`
  (`--providers.docker.exposedbydefault=false`, ACME via HTTP challenge,
  HTTP→HTTPS redirect — all default in that image).
- `A <domain> → <VPS IP>` resolving **before** the first `up`; Traefik issues
  the certificate on demand via the HTTP challenge.
- Ports 80 and 443 open, nothing else. The relay and storage never publish a
  port; Traefik reaches the relay on the internal network.
- Set `ACME_EMAIL` in `${TRAEFIK_ROOT}/.env` to a real address — a stock image
  usually defaults it to an unrouted address, so expiry warnings go nowhere.

## Deploy

```bash
git clone git@github.com:<org>/lines.git ~/app && cd ~/app/deploy/docker
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

## Auto-deploy

Every push to `main` that passes tests deploys automatically —
`.github/workflows/deploy.yml`:

1. **test** — `npm ci`, `npm run typecheck`, tests for `server`/`relay`/`storage`.
2. **check-migrations** — `deploy/scripts/check-migration-safety.sh` diffs
   `storage/prisma/migrations` against the previous commit and fails the run if
   a newly added migration contains `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, or
   `DELETE FROM`. `DROP INDEX`/`DROP CONSTRAINT` are fine — no data loss. A
   flagged migration needs a human to review and merge by hand; the pipeline
   will not auto-deploy it.
3. **build** — builds `relay`/`storage`/`web` from `deploy/docker/Dockerfile`
   and pushes each to `ghcr.io/<org>/lines-<service>` tagged `latest` and the
   commit SHA. The `web` build args come from the `VITE_*` GitHub secrets — keep
   those in sync with `lines.env` by hand if either changes.
4. **deploy** — SSHes into the VPS with a key scoped to that one purpose (see
   below) and runs the VPS-side copy of `deploy-lines.sh`: `git pull --ff-only`,
   `docker compose pull`, `run --rm migrate`, `up -d`, then prunes old images.

**The deploy key is forced-command, not a general login.** Its `authorized_keys`
entry on the VPS pins the key to a `command="…"` naming that one script, and
disables port, X11 and agent forwarding as well as pty allocation. Whatever
command the workflow requests, sshd runs the script instead — a leaked key can
only trigger that one script, not arbitrary root commands. The script reads the
GHCR login token off stdin (the workflow's own short-lived `GITHUB_TOKEN`, piped
in each run) rather than storing a long-lived registry credential on the box.

GitHub secrets involved: `DEPLOY_SSH_KEY` (the private half), `DEPLOY_HOST`,
`DEPLOY_USER`, and the four `VITE_*` build args. `lines.env` on the VPS carries
one addition, `REGISTRY=ghcr.io/<org>/`, which is what makes `compose.yml`
pull the CI-built images instead of building locally — unset it and `build`
still works exactly as before for a manual/local deploy.

Rotate the key by generating a new pair, updating the `authorized_keys` entry
and the `DEPLOY_SSH_KEY` secret together, then deleting the old public key
line.

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
- [ ] A browser socket to `/client` with no `?device=` is rejected with
      `1008 'device required'` — proof the relay is enforcing. The real client
      always names a device, so this is a curl-level check, not a symptom.

## Updating

Normally you don't — push to `main` and the [auto-deploy](#auto-deploy)
pipeline does this for you. Manual steps below are for a rollback, a schema
change flagged by the migration-safety check, or the pipeline itself being
down.

The checkout lives at `${DEPLOY_ROOT}` on the VPS (alongside `${TRAEFIK_ROOT}`).

```bash
cd "$DEPLOY_ROOT" && git pull --ff-only origin main && cd deploy/docker
docker compose --env-file lines.env build
docker compose --env-file lines.env run --rm migrate   # if storage/prisma changed
docker compose --env-file lines.env up -d
```

The server holds **no GitHub credential** — only an inbound `authorized_keys`. So
`git pull` there needs your own key forwarded for the one command:

```bash
ssh -A <host> "cd $DEPLOY_ROOT && git pull --ff-only"
```

Add a read-only deploy key if that ever needs to run unattended. Note `-A` lets
root on that box use your agent for the life of the connection.

A `VITE_*` change is baked at image build time, so it needs `build web` and not
just `up -d` — that includes `VITE_DESKTOP_DOWNLOAD_URL` after a desktop release.

Rollback is `git checkout <tag>` plus the same three commands, or re-tagging a
previously built image. Migrations do **not** roll back: `migrate deploy` is
forward-only and the schema is additive, so roll the code back and leave the
schema forward.

## Releasing the desktop app

Runs on a Mac, not the VPS — it needs Xcode's `codesign` and produces an arm64
bundle. Nothing in the deployment serves the DMG; it lives in a public R2 bucket.

```bash
# 1. build and sign, with the update feed baked in
LINES_UPDATE_FEED_URL="$R2_RELEASE_PUBLIC_BASE_URL/desktop" npm run package -w desktop
# 2. upload; prints the VITE_DESKTOP_DOWNLOAD_URL to paste into lines.env
npm run release -w desktop
# 3. on the VPS, after updating lines.env
docker compose --env-file lines.env build web && docker compose --env-file lines.env up -d web
```

Ordering is forced: step 2 prints a URL containing the artifact filename, and
step 3 bakes it into the bundle — so the release must exist before the web build.

Two buckets, deliberately: `R2_BUCKET` holds recipe images, `R2_RELEASE_BUCKET`
holds releases. Public-read is a bucket-level setting, so sharing one would make
every user-uploaded screenshot world-readable in order to publish an installer.
Both `R2_PUBLIC_BASE_URL` and `R2_RELEASE_PUBLIC_BASE_URL` must be the bucket's
public `r2.dev` (or custom) domain — never the S3 API endpoint, which only serves
signed requests. The API token needs access to both buckets.

**Bump the version rather than re-uploading one.** Artifacts are stored
`immutable` with a one-year max-age, so overwriting a filename can leave the edge
serving the old bytes.

**Clear `desktop/release/` first, or check the URL step 2 prints.** It reports the
first `.dmg` in that directory, so a previous version's artifact left behind wins
alphabetically and the printed `VITE_DESKTOP_DOWNLOAD_URL` names the *old* build —
which then ships as the download link. `latest-mac.yml` is unaffected;
electron-updater still sees the new version.

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
