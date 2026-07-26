#!/usr/bin/env bash
set -euo pipefail

# Run scripts/screenshots.mjs inside the Playwright image.
#
# The image ships the browsers (/ms-playwright) but not the npm package, so we
# install a matching playwright into scripts/.pw-cache once and reuse it.
# --network host is what lets the container reach the Signal K server on
# localhost:3000; point SK_URL elsewhere if your server is remote.
#
#   ./scripts/screenshots.sh                 # all shots
#   ./scripts/screenshots.sh webapp-route    # a subset
#   ./scripts/screenshots.sh --list
#
# Credentials come from the environment:
#   SK_USERNAME=admin SK_PASSWORD=secret ./scripts/screenshots.sh

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PW_VERSION="${PW_VERSION:-1.59.1}"
PW_IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"

docker run --rm \
  --network host \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  -e SK_URL="${SK_URL:-http://localhost:3000}" \
  -e SK_USERNAME="${SK_USERNAME:-}" \
  -e SK_PASSWORD="${SK_PASSWORD:-}" \
  -e OUT_DIR="${OUT_DIR:-img}" \
  -e VIEWPORT="${VIEWPORT:-1600x1000}" \
  -v "$REPO_DIR:/work" \
  -w /work \
  "$PW_IMAGE" \
  sh -c "
    set -e
    # ESM ignores NODE_PATH and resolves bare specifiers by walking up from the
    # importing file, so playwright has to land in scripts/node_modules for
    # scripts/screenshots.mjs to find it. Gitignored; installed once.
    if [ ! -d scripts/node_modules/playwright ] || [ ! -d scripts/node_modules/sharp ]; then
      echo '[shots] installing playwright@${PW_VERSION} + sharp (one-off)…'
      npm install --silent --no-save --prefix scripts playwright@${PW_VERSION} sharp
    fi
    node scripts/screenshots.mjs $*
  "
