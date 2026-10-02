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

**`storage`** — Clerk-authed Express + Prisma against hosted Supabase. Any
standalone Postgres works too, including the optional bundled `postgres`
service (see [Self-hosting](#self-hosting)). Public at `api.<domain>`, minus
the relay-only device routes; the relay reaches it at `http://storage:8790` on
the compose network.

**`web`** — `nginx:alpine` with the built bundle. Traefik cannot serve files, so
the bundle brings its own server. TLS and redirects stay in Traefik; this nginx
only does SPA fallback, cache headers, and the `/download` redirect.

**`landing`** — the same nginx config with the keyless marketing build, on the
apex. It also answers `/download`.

**`postgres`** — optional, only under the `db` profile. No published port; it
sits on the internal `lines-db` network that only `storage` and `migrate` join.

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
  uses `DIRECT_URL` (on Supabase, `:5432` rather than the pooled `:6543`). Started against an empty
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

Triaging "stuck connecting to my machine": the relay and storage write no timestamps of their own,
so always pass `-t`. Run these from `deploy/docker`:

```bash
docker compose --env-file lines.env logs -t --since 12h relay | grep <deviceId>
docker compose --env-file lines.env logs -t --since 12h storage | grep '\[diag\]'
docker compose --env-file lines.env exec relay node -e "fetch('http://127.0.0.1:8791/',{headers:{'x-relay-secret':process.env.RELAY_SHARED_SECRET}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j.events,null,1)))"
```

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

## Growth metrics

Neither the app nor the marketing page loads an analytics script, on purpose:
the app's origin holds the end-to-end encryption keys, and a tracker there would
be third-party code next to them. Every number comes from server logs and
read-only SQL instead. Treat them as directional — bots, link previews and
prefetch inflate them, and log rotation drops history — so snapshot weekly and
compare channels week against week.

**Channel attribution.** Every shared link carries `?ref=<channel>` (`linkedin`,
`hn`, `reddit-claudeai`, `ph`, `yt`, …). The first visit is a full page load, so
nginx logs it with its query string and `Referer`. Run these from
`deploy/docker`:

```bash
# Visits per ref tag, marketing page and app combined
docker compose --env-file lines.env logs --no-log-prefix landing web 2>&1 \
  | grep -oE '[?&]ref=[A-Za-z0-9_-]+' | sort | uniq -c | sort -rn

# Download clicks: every button goes through /download, a logged 302
docker compose --env-file lines.env logs --no-log-prefix landing web 2>&1 \
  | grep -c '"GET /download'

# Full report (needs goaccess on the VPS); open report.html locally
docker compose --env-file lines.env logs --no-log-prefix landing 2>&1 \
  | goaccess - --log-format=COMBINED -o report.html
```

nginx sits behind Traefik, so the client address it logs is Traefik's. Unique
visitor counts in GoAccess are therefore meaningless; use requests and ref tags.

**Funnel.** Signups are on the Clerk dashboard. The rest is in Postgres, in a
read-only transaction:

```sql
BEGIN READ ONLY;
-- Users with at least one paired, unrevoked machine
SELECT count(DISTINCT user_id) FROM devices
 WHERE user_id IS NOT NULL AND revoked_at IS NULL;
-- Machines registered per week
SELECT date_trunc('week', created_at) AS week, count(*) FROM devices
 WHERE user_id IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 12;
-- Weekly active machines
SELECT count(*) FROM devices
 WHERE revoked_at IS NULL AND last_seen_at > now() - interval '7 days';
-- Synced sessions per user
SELECT user_id, count(*) FROM sessions
 WHERE deleted_at IS NULL GROUP BY user_id ORDER BY 2 DESC;
ROLLBACK;
```

Against the bundled database:
`docker compose --env-file lines.env exec -T postgres psql -U lines -d lines < metrics.sql`.
Against a managed one, `psql "<DIRECT_URL>" -f metrics.sql`, pasting the URL
rather than sourcing `lines.env` (its unquoted `&` would background the shell).

## Self-hosting

A self-hosted deployment runs the relay, storage and both web servers on your
own server, so none of it touches linesapp.cloud. The database is wherever
`DATABASE_URL` points: a Supabase project of your own, as `env.example`
assumes, or a standalone Postgres. [PRIVACY.md](../PRIVACY.md) lists what each
piece holds.

**Requirements:**

- Docker and a Traefik stack (see [Prerequisites](#prerequisites)), with DNS for
  `<domain>`, `run.<domain>` and `api.<domain>`. `app.<domain>` is only a
  transitional alias for older linesapp.cloud desktop builds and can be left out
  of a fresh deployment's DNS.
- **Postgres.** Supabase, as in production, or any standalone Postgres you run
  or rent — including the bundled `postgres` service: uncomment
  `COMPOSE_PROFILES=db`, `POSTGRES_PASSWORD` and its two URLs in `lines.env`.
  With no pooler in front, `DATABASE_URL` and `DIRECT_URL` are the same string.
- **Clerk — required, and an accepted external dependency.** Sign-in, the
  relay's browser tokens and storage's auth all verify Clerk sessions, and
  there is no other identity provider. The free tier is enough. Create a Clerk
  application, allow `https://run.<domain>` (and `https://app.<domain>` while
  that alias exists) as origins and redirect URLs, and put its keys in
  `VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. **Clerk holds every
  user's identity (user id, email, profile) even when everything else is
  self-hosted** — say so to your users, as PRIVACY.md does.
- **Cloudflare R2 — optional.** `R2_*` enables recipe screenshot uploads (a
  public-read bucket); unset, recipes still work and the upload route answers
  503. The release bucket is needed only if you publish your own desktop builds.
- **A desktop build pointed at your domains.** Released DMGs talk to
  linesapp.cloud. Build your own with `desktop/config.json` (or the
  `LINES_RELAY_URL`, `LINES_STORAGE_URL` and `LINES_WEB_URL` variables) naming
  your hosts — see `docs/codebase/features/desktop-app.md` — or run the bridge
  from source on each machine.

Then follow [Deploy](#deploy). With the bundled database, start it first:
`docker compose --env-file lines.env up -d postgres`, then `run --rm migrate`.

### Moving from Supabase to the bundled Postgres

Optional, and not the default: production runs on Supabase, and a managed
Postgres keeps working exactly as before. Rehearse the
whole sequence on a scratch VPS or a throwaway compose project first, from a
real dump, before doing it for real.

The commands run from `deploy/docker`. `SUPABASE_DIRECT_URL` is your current
`DIRECT_URL`: the `:5432` connection, never the `:6543` transaction pooler,
which `pg_dump` cannot use. Paste it in, quoted:

```bash
SUPABASE_DIRECT_URL='postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:5432/postgres'
```

1. **Take a maintenance window and stop storage.** Bridges keep running turns
   and show the storage banner; nothing new is written.
   ```bash
   docker compose --env-file lines.env stop storage
   ```
2. **Dump from Supabase**, the `public` schema only (Prisma's tables and
   `_prisma_migrations` live there; Supabase's own `auth`/`storage` schemas are
   not ours). Use a `pg_dump` at least as new as the server.
   ```bash
   docker run --rm --network host postgres:17 \
     pg_dump "$SUPABASE_DIRECT_URL" --schema=public --no-owner --no-privileges -Fc > lines.dump
   ```
3. **Start the bundled Postgres.** In `lines.env`, uncomment `COMPOSE_PROFILES=db`
   and set `POSTGRES_PASSWORD` (`openssl rand -hex 32`), then:
   ```bash
   docker compose --env-file lines.env up -d postgres
   ```
4. **Restore into it.**
   ```bash
   docker compose --env-file lines.env exec -T postgres \
     pg_restore -U lines -d lines --no-owner --no-privileges < lines.dump
   ```
   One `schema "public" already exists` error is expected and harmless: the new
   database already has it. Any other error means stop, drop the volume
   (`docker compose --env-file lines.env down postgres && docker volume rm lines-postgres`)
   and fix it before going further.
5. **Point storage at it.** In `lines.env`, set both URLs to the new instance
   (and delete the Supabase ones):
   ```
   DATABASE_URL=postgresql://lines:<password>@postgres:5432/lines
   DIRECT_URL=postgresql://lines:<password>@postgres:5432/lines
   ```
6. **Migrate and check for drift.** `migrate` should report no pending
   migrations, and the diff should exit 0:
   ```bash
   docker compose --env-file lines.env run --rm migrate
   docker compose --env-file lines.env run --rm migrate \
     ../node_modules/.bin/prisma migrate diff --from-url "postgresql://lines:<password>@postgres:5432/lines" \
     --to-schema-datamodel prisma/schema.prisma --exit-code
   ```
   Compare row counts on both sides for `sessions`, `devices`, `workflows` and
   `agent_memory_files` too.
7. **Start storage and smoke-test**: sign in, see the session list, open a
   session on a paired machine, and pair a new device.
   ```bash
   docker compose --env-file lines.env up -d
   ```
8. **Keep the Supabase project untouched** for a rollback window (a couple of
   weeks), then pause or delete it. Rolling back is restoring the old two URLs
   in `lines.env` and `up -d storage`; anything written after the cutover stays
   behind in the new database.

### Backups

Supabase keeps its own backups, on terms that depend on the plan — check its
retention, and keep an off-platform dump too if it is short. The same
`pg_dump` works against `DIRECT_URL`.

The bundled database has no backups at all until you add them, and it is then
the only copy of synced metadata. A nightly dump with two weeks of history,
from root's crontab:

```cron
15 3 * * * cd /path/to/lines/deploy/docker && docker compose --env-file lines.env exec -T postgres pg_dump -U lines -Fc lines > /var/backups/lines/lines-$(date +\%F).dump && find /var/backups/lines -name 'lines-*.dump' -mtime +14 -delete
```

Copy the dumps off the box too. Test a restore at least once, into a throwaway
container rather than the live one:

```bash
docker run -d --name lines-restore-test -e POSTGRES_PASSWORD=test postgres:17
docker exec -i lines-restore-test sh -c 'until pg_isready -U postgres; do sleep 1; done; createdb -U postgres lines'
docker exec -i lines-restore-test pg_restore -U postgres -d lines --no-owner < /var/backups/lines/lines-<date>.dump
docker exec lines-restore-test psql -U postgres -d lines -c 'SELECT count(*) FROM sessions'
docker rm -f lines-restore-test
```

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
