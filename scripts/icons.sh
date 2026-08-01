#!/usr/bin/env bash
set -euo pipefail

# icons.sh — Regenerate the raster favicons from public/icon.svg.
#
# The SVG is the only source; the PNGs exist because not every browser accepts
# an SVG favicon (Safari falls back to the server's own icon if that is all it
# is offered) and iOS ignores an SVG apple-touch-icon outright. Run this after
# editing icon.svg, or the two drift apart silently — nothing checks them.
#
# Uses the same Playwright image as screenshots.sh, which already carries sharp
# in scripts/node_modules; no host toolchain required.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PW_VERSION="${PW_VERSION:-1.59.1}"
PW_IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"

docker run --rm \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$REPO_DIR:/work" \
  -w /work/scripts \
  "$PW_IMAGE" \
  sh -c "
    set -e
    if [ ! -d node_modules/sharp ]; then
      echo '[icons] installing sharp (one-off)…'
      npm install --silent --no-save sharp
    fi
    node -e \"
      const sharp = require('sharp');
      const fs = require('fs');
      const svg = fs.readFileSync('/work/public/icon.svg');
      // Rasterise at high density so the 512-unit artwork is supersampled down
      // rather than upscaled, which keeps the 32px tile legible.
      const out = [['/work/public/icon-32.png', 32], ['/work/public/apple-touch-icon.png', 180]];
      (async () => {
        for (const [file, size] of out) {
          await sharp(svg, { density: 512 }).resize(size, size).png({ compressionLevel: 9 }).toFile(file);
          console.log('[icons] wrote', file.replace('/work/', ''), size + 'x' + size,
                      fs.statSync(file).size + ' bytes');
        }
      })();
    \"
  "
