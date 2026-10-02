#!/usr/bin/env bash
set -euo pipefail
read -r GHCR_TOKEN
read -r GHCR_ACTOR
read -r IMAGE_TAG || true
export TAG="${IMAGE_TAG:-latest}"
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_ACTOR" --password-stdin
cd "${LINES_DEPLOY_ROOT:-/docker/lines}"
git fetch origin main
git merge --ff-only origin/main
cd deploy/docker
docker compose --env-file lines.env pull relay storage web landing
docker compose --env-file lines.env run --rm migrate
docker compose --env-file lines.env up -d
docker compose --env-file lines.env ps
docker image prune -f
