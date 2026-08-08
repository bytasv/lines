#!/usr/bin/env bash
#
# Lines deploy — run as the `lines` user on the VPS:
#   /home/lines/app/deploy/deploy.sh
#
# Pulls main, reinstalls if the lockfile moved, regenerates the Prisma client,
# applies migrations, rebuilds the web bundle and restarts the units.
#
# Needs a narrow NOPASSWD sudo rule (/etc/sudoers.d/lines-deploy) for
# `systemctl start|stop|restart lines-*` and `systemctl reload nginx` — nothing
# broader. See deploy/README.md.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/lines/app}"
cd "$APP_DIR"

# Single source of truth for the domain: the URL that gets baked into the bundle.
BRIDGE_WS_URL="$(sed -n 's/^VITE_BRIDGE_WS_URL=//p' .env | tail -n1)"
if [ -z "$BRIDGE_WS_URL" ]; then
  echo "FATAL: VITE_BRIDGE_WS_URL is not set in $APP_DIR/.env — the built bundle" >&2
  echo "       would fall back to the vite-dev-only /__bridge probe and never connect." >&2
  exit 1
fi

PREV="$(git rev-parse HEAD)"
echo "rollback point: $PREV"

git fetch --prune origin
git pull --ff-only origin main
HEAD_SHA="$(git rev-parse HEAD)"

if [ "$PREV" = "$HEAD_SHA" ]; then
  echo "already at $HEAD_SHA — redeploying anyway"
fi

# Web-only changes need no restart, so no in-flight turn dies.
CHANGED="$(git diff --name-only "$PREV" "$HEAD_SHA")"
WEB_ONLY=no
if [ -n "$CHANGED" ] && ! printf '%s\n' "$CHANGED" | grep -qv '^web/'; then
  WEB_ONLY=yes
fi

build_web() {
  # vite peaks around 1.5 GB; run this when no turns are active, or build
  # elsewhere and rsync web/dist.
  npm run build -w web
  # The single most common silent failure: the bundle builds fine with the URL
  # missing and the UI then reconnects forever.
  if ! grep -rqF "$BRIDGE_WS_URL" web/dist/assets; then
    echo "FATAL: '$BRIDGE_WS_URL' is not present in web/dist/assets — not restarting." >&2
    exit 1
  fi
}

if [ "$WEB_ONLY" = yes ]; then
  echo "web-only change — rebuilding bundle, no service restart"
  build_web
  sudo systemctl reload nginx
  exit 0
fi

# npm ci with the full dependency tree, always:
#   --omit=dev  would drop tsx and vite, which run the services and the build
#   --omit=optional would drop @anthropic-ai/claude-agent-sdk-linux-x64 (~262 MB)
# ~/.npmrc sets ignore-scripts=true, so `prisma generate` never runs on install.
if ! git diff --quiet "$PREV" "$HEAD_SHA" -- package-lock.json; then
  npm ci
fi
npm run generate -w storage   # unconditional: postinstall is skipped by design

# Before any restart. `migrate deploy` is forward-only and uses DIRECT_URL.
npm run migrate -w storage

build_web

sudo systemctl restart lines-storage
sudo systemctl restart lines-worker   # kills every in-flight turn, by design
sudo systemctl restart lines-bridge   # reconnects to the worker within ~1s
sudo systemctl reload nginx

sleep 3
systemctl is-active lines-worker lines-bridge lines-storage
curl -fsS http://127.0.0.1:8790/health
echo
echo "deployed $HEAD_SHA (rollback: $PREV)"
echo "tag it:  git tag deploy-\$(date +%Y-%m-%d-%H%M) && git push origin --tags"
