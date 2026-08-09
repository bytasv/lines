# syntax=docker/dockerfile:1
#
# Server-side Lines images: relay, storage, web. Build a target explicitly:
#   docker build -f deploy/docker/Dockerfile --target relay -t lines-relay .
# The build context is the REPO ROOT, not this directory (npm workspaces).
#
# The bridge and the worker are deliberately absent. They run on the user's own
# machine and dial out to the relay, so nothing here executes an agent turn.

# ---------- shared dependency layer ----------
FROM node:22-slim AS deps
WORKDIR /app

# Every workspace manifest must be present even though only some workspaces end
# up in the images: npm ci validates the lockfile against all of them.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY relay/package.json relay/
COPY storage/package.json storage/
COPY web/package.json web/
COPY desktop/package.json desktop/

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

# Written to a file rather than passed as bare environment variables: vite reads
# the repo-root .env (envDir: '..'), and a file makes the baked-in values
# explicit and greppable if a build ever produces a bundle without them.
RUN test -n "$VITE_BRIDGE_WS_URL" || { echo "FATAL: --build-arg VITE_BRIDGE_WS_URL is required"; exit 1; }
RUN printf 'VITE_BRIDGE_WS_URL=%s\nVITE_CLERK_PUBLISHABLE_KEY=%s\nVITE_STORAGE_URL=%s\n' \
      "$VITE_BRIDGE_WS_URL" "$VITE_CLERK_PUBLISHABLE_KEY" "$VITE_STORAGE_URL" > .env
RUN npm run build -w web
# Unset or mistyped, the build still succeeds and the app reconnects forever —
# so fail the image instead of shipping one that cannot reach the relay.
RUN grep -qF "$VITE_BRIDGE_WS_URL" web/dist/assets/*.js \
 || { echo "FATAL: VITE_BRIDGE_WS_URL is not in the built bundle"; exit 1; }

# ---------- web (runtime) ----------
# Traefik cannot serve files, so the bundle ships with its own nginx.
FROM nginx:alpine AS web
COPY deploy/docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/web/dist /usr/share/nginx/html
EXPOSE 80
