# Production deployment

## Purpose

Runs the server side of a hosted Lines install — the relay, the storage server,
the static web bundle, and the static marketing page — as containers behind an existing Traefik instance,
issuing its own TLS certificate per hostname. Deliberately excludes the bridge
and worker: the agent runs on each user's own machine (see
[hosted-machine-access](hosted-machine-access.md) and
[hosted-machine-access](hosted-machine-access.md)), so no agent turn ever executes on this
host, and the images ship without `server/`'s Claude Agent SDK dependency.

## Entry points

- `deploy/docker/compose.yml` — `docker compose --env-file lines.env up -d`
- `deploy/docker/Dockerfile` — `relay` / `storage` / `web` / `landing` build targets
- `deploy/README.md` — the runbook this doc summarizes, plus growth metrics, self-hosting, the
  optional Supabase-to-Postgres move and backups
- `.github/workflows/deploy.yml` — CI: on push to `main`, the three `test` legs
  (`typecheck`, `server`, `runtime`) and `check-migrations` run in parallel; once
  all pass, the two `build` legs (`services`, `web`) push images to GHCR in
  parallel, then `deploy` SSHes into the VPS. Skipped when every changed file matches `paths-ignore`
  (`desktop/package.json` only — the lone bump commit `ship.mjs` can push, see
  desktop-app's Releasing section); a push touching that file alongside
  anything else still runs normally.
- `deploy/scripts/deploy-lines.sh` — the VPS-side script the forced-command SSH
  key runs; pulls, migrates, and restarts the stack
- `deploy/scripts/check-migration-safety.sh` — the `check-migrations` job's gate

## Important files

- `deploy/docker/Dockerfile` — multi-stage build; a `manifests` stage feeds one
  `deps` layer shared by all the targets
- `deploy/docker/normalize-manifests.mjs` — run by the `manifests` stage; strips
  the manifests and lockfile to what `npm ci` installs, so `deps` stays cached
  across version bumps and script edits
- `deploy/docker/compose.yml` — service definitions and Traefik labels
- `deploy/docker/web-nginx.conf` — the static-file server for `web` and `landing`; Traefik
  cannot serve files, so each ships one
- `deploy/docker/env.example` — template for `lines.env`
- `.github/workflows/deploy.yml` — the auto-deploy pipeline
- `deploy/scripts/deploy-lines.sh` — kept byte-identical to the copy installed
  at `/root/deploy-lines.sh` on the VPS; the repo copy is the only record of it
- `deploy/scripts/check-migration-safety.sh` — refuses the push if a new
  migration file looks destructive

## Important symbols

None — this is infrastructure, not application code.

## Data flow

`docker compose build` produces four images from one `deps` layer (installed
with `--ignore-scripts`, scoped to the `shared`/`relay`/`storage`/`web`
workspaces via `npm ci --workspace`). `deps` copies its manifests and lockfile
from the `manifests` stage, which normalizes them first (see Architectural
rules). The `web` build stage bakes
`VITE_BRIDGE_WS_URL`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_STORAGE_URL`, and
`VITE_DESKTOP_DOWNLOAD_URL` into the bundle as build args — none of the four can
be changed by restarting the container, only by rebuilding it. The `landing` stage is a
separate, keyless build (`npm run build:landing -w web`) that bakes in only `VITE_APP_URL` (the
app host, where every call to action points) and `VITE_DESKTOP_DOWNLOAD_URL`; it fails the
image if `VITE_APP_URL` is empty or absent from the output. The `web` build fails
if the WS URL is not actually present in the output; the download URL gets the
same assertion but only when set, since an empty value is the legitimate state
before a desktop release exists (see [desktop-app](desktop-app.md)).

`VITE_DESKTOP_DOWNLOAD_URL` is set once, to the stable alias
(`${R2_RELEASE_PUBLIC_BASE_URL}/desktop/Lines-latest.dmg`), not per release — a desktop release
re-publishes that same key, so it never needs a matching web rebuild. Before the alias existed this
was a versioned filename hand-pasted after every release, forcing a `web` rebuild in lockstep with
`desktop-app`'s release step; that ordering no longer exists.

The same URL also reaches `web` and `landing` at runtime, as `DESKTOP_DOWNLOAD_URL` (compose passes
`${VITE_DESKTOP_DOWNLOAD_URL:-/}`). Both nginx servers answer `/download` with a 302 to it, and the
install card links there in production builds, so every download click is a line in the access
log. nginx's envsubst renders `${CSP_CONNECT_SRC}` and `${DESKTOP_DOWNLOAD_URL}` only (the filter
is the regex `^(CSP_CONNECT_SRC|DESKTOP_DOWNLOAD_URL)$`); every other `$` in the conf reaches nginx
intact.

At runtime, Traefik routes by `Host()`/`PathPrefix()` label rules on the
existing Docker socket provider: `web` takes **its own host** (`run.<domain>`, and `app.<domain>` while released desktop
builds still open it), `relay` takes `/agent` and `/client` on the apex (priority 100), `landing`
takes the rest of the apex (priority 1), `www` redirects to the apex, apex `/join/` links
redirect to `run.` (priority 50, for invites minted before the move), and
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
- Hosted Supabase (`DATABASE_URL`/`DIRECT_URL` in `lines.env`) — the production database. Any
  standalone Postgres works as well, including the optional bundled `postgres` service; see
  Deploy mechanics and `deploy/README.md`'s Self-hosting section
- A production Clerk instance (or the dev instance, for testing)

## Tests

`server/src/oss-safety.test.ts` — not a deployment test as such, but it reads
this feature's own files (`deploy/README.md`, `deploy/scripts/deploy-lines.sh`,
`deploy/docker/env.example`) as part of a repo-wide denylist that fails CI if a
string scrubbed before the repository went public (the author's Linear
workspace slug, the literal forced-command `authorized_keys` line, the
author's GHCR namespace) comes back.

Otherwise none as a test suite — the `.github/workflows/deploy.yml` pipeline
itself is the verification path: `test` is a matrix of three legs, each with its
own `npm ci` and none cancelling the others (`fail-fast: false`, so one run
reports every failure) — `typecheck` (all five workspaces, including `relay`),
`server` (`npm run test:unit -w server`), and `runtime` (`test:dev-runtime` for
`server`, then the `relay` and `storage` suites). `build` waits for every `test`
leg and `check-migrations`, and `deploy` waits for every `build` leg.
Manual verification is still `deploy/README.md`'s checklist (health endpoints,
CORS preflight, the `/v1/devices/verify` 404 at the edge, cert issuance for
the apex, `run.` and `www`, the `www` and `/join/` redirects, and — after a deploy — confirming the running images
are tagged with the pushed commit SHA).

## Business rules

### Origin separation

- The web bundle and the relay **must not share a hostname**. They were always separate
  containers; sharing an origin was purely a Traefik routing accident, and it meant that code
  execution inside the relay — the most exposed process here — could serve JavaScript to the page
  holding the end-to-end encryption keys and defeat all of it in one line. The bundle lives on
  `run.<domain>`; the apex keeps `/agent` and `/client` (priority 100).
- The apex serves **only** the `landing` build: a static page with no Clerk, no router, no store
  and no socket, whose actions are plain links to `<VITE_APP_URL>/sign-in`. It never serves the
  app bundle, so a relay compromise has nothing to steal there. Storage's `WEB_ORIGINS` does not
  list the apex, since the page never calls it.
- The app is served from two hosts only temporarily: released desktop builds hardcode
  `app.<domain>` and their navigation guard trusts only the app origin, so it cannot become a
  redirect until most installs have updated. Then `app.` becomes a 301 to `run.` and leaves
  `lines-web.rule` and `WEB_ORIGINS`. Whether an old window follows that redirect in-window (it
  fires `will-redirect`, not `will-navigate`) is unverified.
- Every origin has its own E2EE pins and key, so a browser re-enrols once on `run.`.
- This narrows the exposure from "any server-side compromise" to "host or reverse-proxy
  compromise". It is a reduction, not a solution: whoever controls Traefik or the host can still
  serve arbitrary JavaScript from the bundle's origin. See
  [end-to-end-encryption](end-to-end-encryption.md#residual-risks).
- Deploying the split needs two things in place **first**: an A record for `run.<domain>`, and
  that origin in the Clerk instance's allowed origins and redirect URLs. Without the DNS record
  the landing page's buttons point at a name that resolves nowhere; without Clerk, sign-in breaks
  at the cutover.

### Content security

- Monaco is bundled from `node_modules`, not loaded from `cdn.jsdelivr.net`. A CDN script in the
  page that holds the encryption keys is a second, independent supply chain into it — and it was
  the stated reason a CSP was impossible.
- The CSP ships **Report-Only** until it has been exercised against live Clerk and a real diff
  modal. Its `connect-src` is interpolated at image build time from `VITE_BRIDGE_WS_URL` and
  `VITE_STORAGE_URL` via nginx's envsubst; if either is empty, an *enforcing* policy would leave
  an app that loads and then cannot reach the relay — indistinguishable from a broken deploy.
  Drop the `-Report-Only` suffix once the console is clean.
- `script-src` needs `blob:`: Monaco's editor worker is instantiated from a blob URL by Vite's
  `?worker` import, and without it every editor silently fails to load. `style-src` allows
  `'unsafe-inline'` because Mantine sets inline styles throughout — style injection is not script
  execution.
- Neither origin serves an analytics script or a third-party embed. Growth numbers come from the
  nginx access log (`?ref=<channel>` tags on shared links, `/download` 302s) and read-only SQL —
  `deploy/README.md`, Growth metrics. A tracker would be third-party code beside the encryption
  keys, and would fail the CSP once it enforces.
- SRI is added to the emitted chunks by a post-build step, and its limit is worth stating: it
  protects the chunks `index.html` references, not `index.html` itself. Against an attacker who
  can rewrite the served HTML it buys nothing; its value is against a compromised asset host and
  against accidental drift.
- That limit has a concrete instance: Monaco's four editor surfaces (`MonacoPreviewModal`,
  `MonacoDiffModal`, `SessionDiffModal`, `FilesView`) are `React.lazy`-loaded rather than statically
  imported from the entry chunk, so their chunks are never named in `index.html` and carry no SRI
  hash at all — same-origin `script-src` is what still gates them. Deliberate: bundling Monaco into
  the entry chunk delayed first paint on every screen, including ones with no editor on them.

### Deploy mechanics

- The VPS checkout is a **deploy target, not a working copy**. It drifted onto an orphaned
  history once (a different root commit from `origin/main`), and every deploy then failed at
  `git merge --ff-only` with `refusing to merge unrelated histories` — for days, with the error
  pointing at git rather than at the cause. If it recurs, re-point it:
  `git fetch origin main && git checkout -B main origin/main`. `lines.env` is gitignored, so a
  reset cannot touch it; check `git status --porcelain` for tracked modifications first.
- `storage` never gets a published port or exposure beyond its one Traefik
  router; the browser reaches it directly (cross-origin) only for the device
  routes, everything else is called by the relay over the internal Docker
  network.
- Migrations (`docker compose run --rm migrate`) run before the first `up`
  against a new database — `prisma migrate deploy` uses `DIRECT_URL` (on
  Supabase the direct `:5432` string, not the pooled `:6543`), and starting
  `storage` first lets it connect successfully against an empty schema while
  looking healthy.
- The database stays Supabase in production. A standalone Postgres is a
  drop-in alternative: point both `DATABASE_URL` and `DIRECT_URL` at it, the
  same string, with no `pgbouncer` param. `compose.yml` carries one as an
  optional `postgres` service under the `db` profile (`COMPOSE_PROFILES=db` in
  `lines.env`, commented out in `env.example`). It publishes no port and sits
  only on `lines-db`, an `internal: true` network that `storage` and `migrate`
  join besides `lines`. Their `depends_on` on it is `required: false`, so a
  Supabase deployment starts with no `postgres` service at all.
  `POSTGRES_PASSWORD` is deliberately not `${…:?}`: compose interpolates every
  service, profiled or not, so a required variable there would break every
  deployment without the profile.
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
- The `deps` layer's inputs are normalized by `normalize-manifests.mjs`: every
  `version` becomes `0.0.0` (in the manifests, and in the lockfile's top level and
  its root and workspace entries, matched by exact key, never by prefix), and
  `scripts` and desktop's electron-builder `build` block are dropped. Without it,
  a desktop version bump or a scripts edit — nearly every manifest-touching
  commit — invalidated `deps`, reran `npm ci`, and made the registry and the VPS
  move a new ~230 MB layer for an unchanged dependency tree. It is safe because
  `npm ci` runs with `--ignore-scripts` and every internal `@lines/*` spec is
  `"*"`; the script exits 1 if one is not, or if `workspaces` is not a plain list
  of directories. Any stage that runs a workspace script or reads a workspace's
  `version` must `COPY` that workspace first, which restores its real manifest —
  `storage`, `web-build` and `landing-build` already do.
- The `build` job's `services` leg builds `relay` and `storage` together on
  purpose: both images contain the `deps` layer, and one buildx builder shares
  the blob. In separate jobs each would rerun `npm ci` on a `deps` miss and the
  VPS would pull and store two ~230 MB layers. `web` and `landing` share the
  other leg.
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
- The `VITE_*` build args (five, with `VITE_APP_URL`) exist in two places that must be kept in sync by
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
