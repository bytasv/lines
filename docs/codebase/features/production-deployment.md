# Production deployment

## Purpose

Runs the server side of a hosted Lines install — the relay, the storage server,
and the static web bundle — as containers behind an existing Traefik instance,
issuing its own TLS certificate per hostname. Deliberately excludes the bridge
and worker: the agent runs on each user's own machine (see
[hosted-machine-access](hosted-machine-access.md) and
[hosted-machine-access](hosted-machine-access.md)), so no agent turn ever executes on this
host, and the images ship without `server/`'s Claude Agent SDK dependency.

## Entry points

- `deploy/docker/compose.yml` — `docker compose --env-file lines.env up -d`
- `deploy/docker/Dockerfile` — `relay` / `storage` / `web` build targets
- `deploy/README.md` — the runbook this doc summarizes
- `.github/workflows/deploy.yml` — CI: on push to `main`, runs `test` →
  `check-migrations` → `build` (push images to GHCR) → `deploy` (SSH into the
  VPS)
- `deploy/scripts/deploy-lines.sh` — the VPS-side script the forced-command SSH
  key runs; pulls, migrates, and restarts the stack
- `deploy/scripts/check-migration-safety.sh` — the `check-migrations` job's gate

## Important files

- `deploy/docker/Dockerfile` — multi-stage build; one `deps` layer shared by
  all three targets
- `deploy/docker/compose.yml` — service definitions and Traefik labels
- `deploy/docker/web-nginx.conf` — the bundle's own static-file server; Traefik
  cannot serve files, so `web` ships one
- `deploy/docker/env.example` — template for `lines.env`
- `.github/workflows/deploy.yml` — the auto-deploy pipeline
- `deploy/scripts/deploy-lines.sh` — kept byte-identical to the copy installed
  at `/root/deploy-lines.sh` on the VPS; the repo copy is the only record of it
- `deploy/scripts/check-migration-safety.sh` — refuses the push if a new
  migration file looks destructive

## Important symbols

None — this is infrastructure, not application code.

## Data flow

`docker compose build` produces three images from one `deps` layer (installed
with `--ignore-scripts`, scoped to the `shared`/`relay`/`storage`/`web`
workspaces via `npm ci --workspace`). The `web` build stage bakes
`VITE_BRIDGE_WS_URL`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_STORAGE_URL`, and
`VITE_DESKTOP_DOWNLOAD_URL` into the bundle as build args — none of the four can
be changed by restarting the container, only by rebuilding it. The build fails
if the WS URL is not actually present in the output; the download URL gets the
same assertion but only when set, since an empty value is the legitimate state
before a desktop release exists (see [desktop-app](desktop-app.md)).

`VITE_DESKTOP_DOWNLOAD_URL` is set once, to the stable alias
(`${R2_RELEASE_PUBLIC_BASE_URL}/desktop/Lines-latest.dmg`), not per release — a desktop release
re-publishes that same key, so it never needs a matching web rebuild. Before the alias existed this
was a versioned filename hand-pasted after every release, forcing a `web` rebuild in lockstep with
`desktop-app`'s release step; that ordering no longer exists.

At runtime, Traefik routes by `Host()`/`PathPrefix()` label rules on the
existing Docker socket provider: `web` takes the apex host, `relay` takes
`/agent` and `/client` on the same host (with a `www` redirect router), and
`storage` gets its own subdomain (`api.<domain>`) with `/v1/devices/verify`,
`/v1/devices/presence`, and `/v1/devices/authorize` excluded from that router —
see Architectural rules. `storage` carries no
Traefik labels for any other exclusion; it is reachable at all only because
`relay` and the browser need it, and its full route surface is otherwise
intentionally public (Clerk-authenticated) on that one subdomain.

## Dependencies

- Traefik (external to this repo — the deploy assumes a running instance with
  `--providers.docker.exposedbydefault=false` and an ACME resolver named
  `letsencrypt`)
- Hosted Supabase (`DATABASE_URL`/`DIRECT_URL` in `lines.env`)
- A production Clerk instance (or the dev instance, for testing)

## Tests

`server/src/oss-safety.test.ts` — not a deployment test as such, but it reads
this feature's own files (`deploy/README.md`, `deploy/scripts/deploy-lines.sh`,
`deploy/docker/env.example`) as part of a repo-wide denylist that fails CI if a
string scrubbed before the repository went public (the author's Linear
workspace slug, the literal forced-command `authorized_keys` line, the
author's GHCR namespace) comes back.

Otherwise none as a test suite — the `.github/workflows/deploy.yml` pipeline
itself is the verification path: `test` runs the `server`/`relay`/`storage`
unit suites and `npm run typecheck` (all five workspaces, including `relay`),
then `check-migrations`, `build`, and `deploy` gate on each other in sequence.
Manual verification is still `deploy/README.md`'s checklist (health endpoints,
CORS preflight, the `/v1/devices/verify` 404 at the edge, cert issuance for
both the apex and `www`, and — after a deploy — confirming the running images
are tagged with the pushed commit SHA).

## Business rules

- `storage` never gets a published port or exposure beyond its one Traefik
  router; the browser reaches it directly (cross-origin) only for the device
  routes, everything else is called by the relay over the internal Docker
  network.
- Migrations (`docker compose run --rm migrate`) run before the first `up`
  against a new database — `prisma migrate deploy` uses the direct (`:5432`)
  connection string, and starting `storage` first lets it connect successfully
  against an empty schema while looking healthy.
- The same ordering applies to every later schema change, not just first
  bring-up: `migrate deploy` must run against the live database before a new
  `storage` image serves traffic, or the new code 500s with a Prisma
  unknown-column/table error (`P2021`) against the old schema. `~/.npmrc`'s
  `ignore-scripts=true` (common on an ops machine) also means `prisma generate`
  needs an explicit run — it doesn't fire on `npm i` there.
- The relay's health endpoint (`GET /` on the relay's own host) accepts an
  optional `x-relay-secret` header; a request presenting the correct
  `RELAY_SHARED_SECRET` gets a `hubs` array (per-device attach counts and
  timestamps) alongside the ordinary health body — the triage call for a
  duplicate-bridge or flapping-relay-link report, with no Postgres access
  needed. See [hosted-machine-access](hosted-machine-access.md).
- The deploy SSH key's VPS-side `authorized_keys` entry forces
  `/root/deploy-lines.sh` regardless of what command the CI job sends — that
  key can run nothing else on the box. The script itself takes three lines on
  stdin (GHCR token, GHCR actor, image tag) and is the only privileged
  operation a leaked key grants.
- `check-migration-safety.sh` gates on added migration files
  (`--diff-filter=A`) between the push's before/after SHAs; editing an
  already-applied migration to add something destructive bypasses it — accepted
  because Prisma migrations are append-only by convention.
- Images are pinned to the pushing commit's SHA: `build` pushes both `:latest`
  and `:<sha>`, and `deploy-lines.sh` exports `TAG=<sha>` (from the third stdin
  line) before `docker compose pull`/`up -d`, which read `${TAG:-latest}` in
  `compose.yml`. Rollback is `TAG=<old-sha> docker compose --env-file lines.env
  up -d` — no rebuild needed. An old workflow or a manual `ssh` run with only
  two stdin lines still works and falls back to `latest`.

## Architectural rules

- `npm ci` is scoped by `--workspace` rather than `--omit=optional`, because
  `--omit=optional` would also drop `@rollup/rollup-linux-x64-gnu` (an
  optional dependency of `rollup` on the same platform-binary mechanism used
  for the Claude SDK's native binary) and break `vite build`.
- The relay's router carries **no** `StripPrefix` middleware: `relay/src/index.ts`
  matches `url.pathname` exactly against `/agent`/`/client`, so rewriting the
  path closes the socket with `1008` — the container-routing equivalent of the
  classic nginx trailing-slash trap.
- `storage`'s public router excludes `/v1/devices/verify`, `/presence`, and `/authorize` by rule
  (Traefik v3 chained `!Path(...)`), on top of each route's own shared-secret gate (see
  [hosted-machine-access](hosted-machine-access.md) and
  [session-collaboration](session-collaboration.md)) — defense in depth, not redundancy: one
  is a network-level exclusion, the other an application-level credential
  check, and either alone would leave the route reachable if the other broke.
- The image installs `openssl` explicitly in the `storage` stage: `node:22-slim`
  ships without libssl, and Prisma's query engine falls back to a guessed build
  and warns at every boot without it.
- The four `VITE_*` build args exist in two places that must be kept in sync by
  hand: GitHub Actions secrets (used by `.github/workflows/deploy.yml`'s image
  build) and `lines.env` on the VPS (used only for a manual `docker compose
  build`). Nothing checks the two agree; the Dockerfile only asserts
  `VITE_BRIDGE_WS_URL` is present, not that it matches the other source.

## Related decisions

- [hosted-machine-access](hosted-machine-access.md) — what `relay` in this compose
  file actually is, and the auth model `storage`'s device routes implement,
  including the CORS and shared-secret rules this deploy depends on
- [desktop-app](desktop-app.md) — the other half of the split (nothing in this doc
  runs an agent), and where `VITE_DESKTOP_DOWNLOAD_URL` comes from
- [session-collaboration](session-collaboration.md) — `RELAY_SHARED_SECRET` now also gates
  `/v1/devices/presence`/`authorize`; `SHARE_INVITE_TTL_MIN` and `DEVICE_PRESENCE_TTL_MS` are new
  optional env vars, both defaulted. A packaged desktop bridge older than the feature's minimum
  app protocol is refused as a guest by the relay, independent of this deploy.
