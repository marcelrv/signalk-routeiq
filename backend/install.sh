#!/usr/bin/env bash
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Install system-level GDAL dependency (needed by geopandas/fiona for S-57 support)
if command -v apt-get &>/dev/null; then
    echo "Installing system GDAL library..."
    sudo apt-get update -qq && sudo apt-get install -y -qq libgdal-dev gdal-bin
elif command -v brew &>/dev/null; then
    echo "Installing GDAL via Homebrew..."
    brew install gdal
else
    echo "WARNING: Could not install GDAL automatically. Install libgdal-dev for your OS."
fi

# 2. Create a virtual environment (isolated from system/user packages)
VENV_DIR="$BACKEND_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
    echo "Created virtual environment at $VENV_DIR"
fi

# 3. Activate and install Python dependencies
source "$VENV_DIR/bin/activate"
pip install --upgrade pip
pip install -r "$BACKEND_DIR/requirements.txt"

echo ""
echo "=== Backend environment ready ==="
echo "Activate it with:  source $VENV_DIR/bin/activate"
echo "Run pipeline:      python backend/nautical_routing_pipeline.py"
