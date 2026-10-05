# syntax=docker/dockerfile:1
#
# Server-side Lines images: relay, storage, web, landing. Build a target explicitly:
#   docker build -f deploy/docker/Dockerfile --target relay -t lines-relay .
# The build context is the REPO ROOT, not this directory (npm workspaces).
#
# The bridge and the worker are deliberately absent. They run on the user's own
# machine and dial out to the relay, so nothing here executes an agent turn.

# ---------- normalized manifests ----------
FROM node:22-slim AS manifests
WORKDIR /app
# Outside /app, so the script itself is not part of what `deps` copies.
COPY deploy/docker/normalize-manifests.mjs /normalize-manifests.mjs

# Every workspace manifest must be present even though only some workspaces end
# up in the images: npm ci validates the lockfile against all of them.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY relay/package.json relay/
COPY storage/package.json storage/
COPY web/package.json web/
COPY desktop/package.json desktop/
RUN node /normalize-manifests.mjs /app

# ---------- shared dependency layer ----------
FROM node:22-slim AS deps
WORKDIR /app

# The manifests arrive normalized: versions pinned to 0.0.0, `scripts` and
# desktop's electron-builder `build` block removed. BuildKit keys COPY --from on
# file content, not on how the source stage got there, so a desktop version
# bump or a scripts edit reruns `manifests` (about a second) and leaves this
# COPY and npm ci CACHED. The ~230 MB layer keeps its digest, and neither the
# registry nor the VPS has to move it again.
# Each later stage gets a workspace's real manifest back by copying that
# workspace, so a stage that runs a workspace script or reads a workspace's
# version must COPY the workspace first.
COPY --from=manifests /app/ ./

# --ignore-scripts: desktop's electron postinstall downloads ~100 MB we never
#   use. It also skips storage's `prisma generate`, which the storage target
#   therefore runs explicitly — the same trap as on a bare VM.
# --workspace: limits the tree to what this server actually runs. It excludes
#   `server`, and with it the 262 MB linux `claude` binary — the agent runs on
#   the user's machine, and nothing in these images spawns a query.
# Dev dependencies are kept on purpose: tsx runs both services and vite builds
# the bundle.
#
# NOT --omit=optional. That would also drop @rollup/rollup-linux-x64-gnu, which
# is an optionalDependency of rollup by the same platform-binary mechanism, and
# vite build then dies with "Cannot find module @rollup/rollup-linux-x64-gnu".
# Excluding the server workspace is what keeps the claude binary out.
RUN npm ci --ignore-scripts --include-workspace-root \
      --workspace shared --workspace relay --workspace storage --workspace web

# ---------- relay ----------
# Pipes frames between a browser (/client) and the user's bridge (/agent).
# Holds no database credentials by design: it is the most exposed process here,
# so device verification is delegated to storage over the internal network.
FROM deps AS relay
WORKDIR /app
COPY relay relay
ENV NODE_ENV=production
ENV RELAY_PORT=8791
EXPOSE 8791
USER node
CMD ["node_modules/.bin/tsx", "relay/src/index.ts"]

# ---------- storage ----------
FROM deps AS storage
WORKDIR /app
# node:22-slim ships no libssl, and Prisma's query engine needs it: without this
# the client warns "Please manually install OpenSSL" at boot and falls back to a
# guessed engine build.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
COPY shared shared
COPY storage storage
# Explicit because --ignore-scripts skipped the postinstall hook above. Without
# it the server dies at $connect() with "@prisma/client did not initialize yet".
RUN npm run generate -w storage
ENV NODE_ENV=production
ENV PORT=8790
EXPOSE 8790
USER node
CMD ["node_modules/.bin/tsx", "storage/src/index.ts"]

# ---------- web (build stage) ----------
FROM deps AS web-build
WORKDIR /app
COPY shared shared
COPY web web
# The "What's new" notes, which vite.config.ts bakes into the bundle.
COPY changelog.json changelog.json

# Baked into the bundle at build time, so changing either one needs a rebuilt
# image rather than a restart.
#   VITE_BRIDGE_WS_URL — where the browser opens its socket. Points at the
#     relay's /client endpoint in this topology, NOT at a bridge.
#   VITE_CLERK_PUBLISHABLE_KEY — pk_live for a production Clerk instance.
ARG VITE_BRIDGE_WS_URL
ARG VITE_CLERK_PUBLISHABLE_KEY
#   VITE_STORAGE_URL — public storage origin. Its presence is what enables the
#     device-pairing gate in the web app.
ARG VITE_STORAGE_URL
#   VITE_DESKTOP_DOWNLOAD_URL — direct link to the published macOS DMG. Its
#     presence is what enables the download surface on the pairing screens.
ARG VITE_DESKTOP_DOWNLOAD_URL

# Written to a file rather than passed as bare environment variables: vite reads
# the repo-root .env (envDir: '..'), and a file makes the baked-in values
# explicit and greppable if a build ever produces a bundle without them.
RUN test -n "$VITE_BRIDGE_WS_URL" || { echo "FATAL: --build-arg VITE_BRIDGE_WS_URL is required"; exit 1; }
RUN printf 'VITE_BRIDGE_WS_URL=%s\nVITE_CLERK_PUBLISHABLE_KEY=%s\nVITE_STORAGE_URL=%s\nVITE_DESKTOP_DOWNLOAD_URL=%s\n' \
      "$VITE_BRIDGE_WS_URL" "$VITE_CLERK_PUBLISHABLE_KEY" "$VITE_STORAGE_URL" \
      "$VITE_DESKTOP_DOWNLOAD_URL" > .env
RUN npm run build -w web
# Unset or mistyped, the build still succeeds and the app reconnects forever —
# so fail the image instead of shipping one that cannot reach the relay.
RUN grep -qF "$VITE_BRIDGE_WS_URL" web/dist/assets/*.js \
 || { echo "FATAL: VITE_BRIDGE_WS_URL is not in the built bundle"; exit 1; }
# Optional, so only asserted when asked for: a typo here silently ships an image
# whose pairing screens tell the user to install an app they cannot download.
RUN test -z "$VITE_DESKTOP_DOWNLOAD_URL" \
 || grep -qF "$VITE_DESKTOP_DOWNLOAD_URL" web/dist/assets/*.js \
 || { echo "FATAL: VITE_DESKTOP_DOWNLOAD_URL is not in the built bundle"; exit 1; }

# ---------- web (runtime) ----------
# Traefik cannot serve files, so the bundle ships with its own nginx.
FROM nginx:alpine AS web
# Origins the page is allowed to *talk to*, substituted into the CSP below. They
# are deployment facts (the relay's WebSocket host, the storage API), so they
# cannot be hardcoded in the conf — and a policy naming the wrong ones fails in a
# way that looks like an app bug rather than like a policy.
ARG VITE_BRIDGE_WS_URL
ARG VITE_STORAGE_URL
COPY deploy/docker/web-nginx.conf /etc/nginx/templates/default.conf.template
# nginx's own envsubst entrypoint renders /etc/nginx/templates/*.template into
# /etc/nginx/conf.d at container start. Restricted to these two variables
# (the filter is a regex), because the conf is full of `$uri` and `$host` that
# nginx must receive intact.
ENV NGINX_ENVSUBST_FILTER=^(CSP_CONNECT_SRC|DESKTOP_DOWNLOAD_URL)\$
# Where /download redirects. A runtime value, set by compose to the same DMG
# alias as VITE_DESKTOP_DOWNLOAD_URL. The default keeps the template valid: an
# unsubstituted ${DESKTOP_DOWNLOAD_URL} is an unknown nginx variable, which
# fails the config at start.
ENV DESKTOP_DOWNLOAD_URL=/
ENV CSP_CONNECT_SRC="${VITE_BRIDGE_WS_URL} ${VITE_STORAGE_URL} https://*.clerk.accounts.dev https://*.clerk.com"
COPY --from=web-build /app/web/dist /usr/share/nginx/html
EXPOSE 80

# ---------- landing (build stage) ----------
# The static marketing page for the apex. Deliberately NOT the web bundle: the
# apex is the relay's host, and the relay must never be able to serve JavaScript
# to the page holding the end-to-end encryption keys. This build has no Clerk
# key, no relay URL and no storage URL — it links to the app host and nothing
# else.
FROM deps AS landing-build
WORKDIR /app
COPY shared shared
COPY web web
#   VITE_APP_URL — origin of the app host (https://run.<domain>), where every
#     call to action on the page points.
ARG VITE_APP_URL
#   VITE_DESKTOP_DOWNLOAD_URL — the same DMG link as the web build.
ARG VITE_DESKTOP_DOWNLOAD_URL
RUN test -n "$VITE_APP_URL" || { echo "FATAL: --build-arg VITE_APP_URL is required"; exit 1; }
RUN printf 'VITE_APP_URL=%s\nVITE_DESKTOP_DOWNLOAD_URL=%s\n' \
      "$VITE_APP_URL" "$VITE_DESKTOP_DOWNLOAD_URL" > .env
RUN npm run build:landing -w web
# Unset or mistyped, every button on the page goes nowhere — fail the image.
RUN grep -qF "$VITE_APP_URL" web/dist-landing/assets/*.js \
 || { echo "FATAL: VITE_APP_URL is not in the built landing bundle"; exit 1; }

# ---------- landing (runtime) ----------
FROM nginx:alpine AS landing
COPY deploy/docker/web-nginx.conf /etc/nginx/templates/default.conf.template
ENV NGINX_ENVSUBST_FILTER=^(CSP_CONNECT_SRC|DESKTOP_DOWNLOAD_URL)\$
ENV DESKTOP_DOWNLOAD_URL=/
# Empty: the page talks to nothing but its own origin.
ENV CSP_CONNECT_SRC=""
COPY --from=landing-build /app/web/dist-landing /usr/share/nginx/html
EXPOSE 80
