#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — Build the plugin and restart the Signal K server.
#
# The dev directory is bind-mounted at /home/node/.signalk/routeiq-dev by the
# server's compose file (/home/node/.signalk/docker-compose.yml, host infra —
# deliberately not in this repo). npm manages a file: symlink:
#   node_modules/signalk-routeiq → ../routeiq-dev
# so build output in dist/ is instantly visible to the container.
# No copy step needed.

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SK_CONTAINER="signalk-server"

echo "==> Building plugin..."
# HOME=/tmp avoids EACCES on /.npm (root-owned in node:22 image)
#docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$REPO_DIR:/work" -w /work node:22 sh -c "npm install && npm run build && npm pack"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$REPO_DIR:/work" -w /work node:22 sh -c "npm install && npm run build"


echo "==> Restarting Signal K server..."
docker restart "$SK_CONTAINER"

echo "==> Done."
