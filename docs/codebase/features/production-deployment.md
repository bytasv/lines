# Production deployment

## Purpose

Runs the server side of a hosted Lines install — the relay, the storage server,
and the static web bundle — as containers behind an existing Traefik instance,
issuing its own TLS certificate per hostname. Deliberately excludes the bridge
and worker: the agent runs on each user's own machine (see
[remote-relay-bridge](remote-relay-bridge.md) and
[device-pairing](device-pairing.md)), so no agent turn ever executes on this
host, and the images ship without `server/`'s Claude Agent SDK dependency.

## Entry points

- `deploy/docker/compose.yml` — `docker compose --env-file lines.env up -d`
- `deploy/docker/Dockerfile` — `relay` / `storage` / `web` build targets
- `deploy/README.md` — the runbook this doc summarizes

## Important files

- `deploy/docker/Dockerfile` — multi-stage build; one `deps` layer shared by
  all three targets
- `deploy/docker/compose.yml` — service definitions and Traefik labels
- `deploy/docker/web-nginx.conf` — the bundle's own static-file server; Traefik
  cannot serve files, so `web` ships one
- `deploy/docker/env.example` — template for `lines.env`

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
before a desktop release exists (see [desktop-packaging](desktop-packaging.md)).

At runtime, Traefik routes by `Host()`/`PathPrefix()` label rules on the
existing Docker socket provider: `web` takes the apex host, `relay` takes
`/agent` and `/client` on the same host (with a `www` redirect router), and
`storage` gets its own subdomain (`api.<domain>`) with `/v1/devices/verify`
excluded from that router — see Architectural rules. `storage` carries no
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

None — this is deploy configuration, verified manually per `deploy/README.md`'s
checklist (health endpoints, CORS preflight, the `/v1/devices/verify` 404 at the
edge, cert issuance for both the apex and `www`).

## Business rules

- `storage` never gets a published port or exposure beyond its one Traefik
  router; the browser reaches it directly (cross-origin) only for the device
  routes, everything else is called by the relay over the internal Docker
  network.
- Migrations (`docker compose run --rm migrate`) run before the first `up`
  against a new database — `prisma migrate deploy` uses the direct (`:5432`)
  connection string, and starting `storage` first lets it connect successfully
  against an empty schema while looking healthy.

## Architectural rules

- `npm ci` is scoped by `--workspace` rather than `--omit=optional`, because
  `--omit=optional` would also drop `@rollup/rollup-linux-x64-gnu` (an
  optional dependency of `rollup` on the same platform-binary mechanism used
  for the Claude SDK's native binary) and break `vite build`.
- The relay's router carries **no** `StripPrefix` middleware: `relay/src/index.ts`
  matches `url.pathname` exactly against `/agent`/`/client`, so rewriting the
  path closes the socket with `1008` — the container-routing equivalent of the
  classic nginx trailing-slash trap.
- `storage`'s public router excludes `/v1/devices/verify` by rule (Traefik v3
  `!Path(...)`), on top of that route's own shared-secret gate (see
  [device-pairing](device-pairing.md)) — defense in depth, not redundancy: one
  is a network-level exclusion, the other an application-level credential
  check, and either alone would leave the route reachable if the other broke.
- The image installs `openssl` explicitly in the `storage` stage: `node:22-slim`
  ships without libssl, and Prisma's query engine falls back to a guessed build
  and warns at every boot without it.

## Related decisions

- [remote-relay-bridge](remote-relay-bridge.md) — what `relay` in this compose
  file actually is
- [device-pairing](device-pairing.md) — the auth model `storage`'s device
  routes implement, including the CORS and shared-secret rules this deploy
  depends on
- [desktop-shell](desktop-shell.md) — the other half of the split; nothing in
  this doc runs an agent
- [desktop-packaging](desktop-packaging.md) — where `VITE_DESKTOP_DOWNLOAD_URL`
  comes from
