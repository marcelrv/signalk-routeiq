# Project Conventions for AI Agents

## Python (backend/)
- Always use `python3` (not `python`) when running scripts.
- Always use `pip3` (not `pip`) when installing packages.
- The backend has two scripts:
  - `enc_preprocessor.py` — accepts `--input` and `--output`
  - `nautical_routing_pipeline.py` — accepts `--input-dir`, `--output`, `--country`, `--name`, `--description`, `--tags`, `--contributor`, `--url`
- Dependencies in `requirements.txt`. Install via `pip3 install --user --break-system-packages -r backend/requirements.txt`
- No system `sudo` available in dev environment; use `--user` + `--break-system-packages` for pip installs.
- **Preprocessor runtime**: `enc_preprocessor.py` takes a long time (often 10-30+ minutes depending on input size). The process may appear to hang — this is normal. Do NOT kill it early and assume it failed. Always let it run to completion. If the agent's session times out, the preprocessor step must be re-run from scratch in the next session before proceeding with other steps (e.g., the pipeline). Verify the output file exists before continuing.

## Adaptive Quadtree Grid (coastal navmesh)
- `nautical_routing_pipeline.py` uses adaptive quadtree subdivision (replacing the old fixed 0.01° grid).
- Resolution: 0.005° (~500m) in open sea → 0.0002° (~20m) in narrow channels.
- Subdivision criteria: narrowness (distance to nearest land), presence of centerlines, land/water boundary.
- Nodes store `resolution` metadata in the SQLite DB; `node_type` is encoded in the node ID (see below).
- Edges store `edge_type` ('coastal' or 'inland').

## Bounding-Box A* Search (runtime)
- `routing.ts:astarSearch()` accepts an optional `bbox` parameter that prunes nodes outside the box.
- On failure, the margin doubles (`routingBBoxMargin` → `routingBBoxMaxExtent`).
- BBox expansion adds warnings to the route result.
- Via points each get their own per-segment bounding box.

## Deterministic Node IDs (coordinate hashing + type packing)
- Node IDs are globally unique integers derived from snapped (lat, lon) at 5 decimal places + node type.
- Formula: `lat_int = int((round(lat,5) + 90.0) * 100000)` (0..18M), `lon_int = int((round(lon,5) + 180.0) * 100000)` (0..36M), `type_int = 1 if 'inland' else 0`.
- `id = (type_int * 648_000_000_000_000) + (lat_int * 36_000_000) + lon_int`.
- Fits within `Number.MAX_SAFE_INTEGER` (53 bits). Allows merging multiple regional `.sqlite` files without ID collisions.
- On the TypeScript side, use `getNodeTypeInt(id)` (`Math.floor(id / 648000000000000)`) to extract the type (0=coastal, 1=inland) without loading a string column.
- No `node_type` column in SQLite — the ID encodes the type at all times.
- POI IDs use a deterministic MD5 hash of `"{poi_type}_{round(lat,5)}_{round(lon,5)}"` truncated to 13 hex chars.

## SQLite Schema
- **`metadata`** table: `country`, `name`, `description`, `last_update_date`, `tags` (JSON array), `bounding_box` (JSON), `boundary_geometry` (GeoJSON), `schema_version` (default 3), `contributor`, `url` — describes the data source. `country` is no longer UNIQUE (a country may have multiple region databases).
- **`edge_type_enum`** table: `(id, description)` — `0=coastal, 1=inland`.
- **`poi_type_enum`** table: `(id, description)` — `0=harbour, 1=lock, 2=bridge, 3=fairway, 4=waterway`.
- **`nodes`** table: includes `region_id INTEGER REFERENCES metadata(id)` for per-region replacement. No `node_type` column — type is encoded in the node ID (see above).
- **`edges`**: uses `edge_type_id INTEGER` (FK to `edge_type_enum`) and `traffic_mode INTEGER` (`0=two-way, 1=one-way fwd, 2=one-way rev`). No `direction_penalty`, `edge_type` TEXT, `is_one_way`, or `traffic_dir` columns. No region-level column needed (edges follow their source node's region).
- **`pois`**: uses `type_id INTEGER` (FK to `poi_type_enum`). `INSERT OR IGNORE` handles duplicate POI IDs from overlapping regions (uses deterministic hash based on type+coords, ignoring name variations).

## Config
- `routingDataDir` (was `routingDatabase`): path to a **directory** containing one or more `.sqlite` routing graph files.
- `routingBBoxMargin` (deg, default 0.1): initial bounding box margin
- `routingBBoxMaxExtent` (deg, default 10.0): max bbox before full-graph fallback
- `lineOfSightSampleInterval` (m, default 500): LOS sample spacing
- `lineOfSightSearchRadius` (m, default 800): LOS node search radius

## Node.js / TypeScript (root, src/)
- **No local node/npm** — use Docker for all Node.js commands:
  ```
  docker run --rm -v "$(pwd):/work" -w /work node:22 <command>
  ```
- **Always pass `-u "$(id -u):$(id -g)"`** so build output is owned by your user, not root.
- **Always set `-e HOME=/tmp`** so npm cache (`/.npm`) doesn't cause EACCES (root-owned in node:22 image).
- Package manager: `npm` (not yarn, pnpm) — runs via Docker.
- Build: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 npm run build`
- Dev: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 npm run dev`
- Lint: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 npm run lint`
- Format: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 npm run format`
- Tests: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 npm test`
  (for now: `node --test --test-force-exit dist-test/routing.test.js`)
- Multi-step (build + test): `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 sh -c "npm run build && npm test"`
- All source in `src/`, compiled to `dist/`.
- ES modules (`"type": "module"` in package.json).

## Signal K Server Plugin Deployment
- Container name: `signalk-server` (runs `signalk/signalk-server:latest`)
- The dev directory is **bind-mounted** at `/home/node/.signalk/autoroute-dev` via `docker-compose.yml`.
  This path is OUTSIDE `node_modules/` so npm doesn't treat the bind-mount as a managed package.
- npm manages a `file:` symlink via `.signalk/package.json`:
  ```
  "signalk-autoroute": "file:autoroute-dev"
  ```
  which creates `node_modules/signalk-autoroute → ../autoroute-dev`.
- npm preserves `file:` symlinks during its install-tree operations for other packages.
- Build output in `dist/` is instantly visible to the SK server via the symlink.
- Plugin config stored at: `/home/node/.signalk/plugin-config-data/signalk-autoroute.json`
- Server data dir: `/home/node/.signalk/` (bind-mounted).
- Signal K server restarts via `docker restart signalk-server`.

### Deployment workflow (after code changes)
One command: `bash deploy.sh`
  — builds via Docker, then restarts the SK container.

The container must be running first. If it isn't:
```bash
docker compose -f /home/node/signalkdev/autoroute/docker-compose.yml up -d
```

### First-time setup (fresh container)
After `docker compose up -d`, run `npm install` once to create the `file:` symlink:
```bash
docker exec signalk-server sh -c "cd /home/node/.signalk && npm install"
```
Then `bash deploy.sh` to build and start using the plugin.

### If the container ever needs to be recreated
```bash
docker compose -f /home/node/signalkdev/autoroute/docker-compose.yml up -d
```
Then follow the first-time setup above.

### Required `package.json` settings
1. `"keywords": ["signalk-node-server-plugin"]` — **essential** for SK server to discover the plugin via `modulesWithKeyword()`.
2. `"signalK": { "pluginConstructor": "pluginConstructor", "name": "signalk-autoroute" }` — names the factory function.
3. `"type": "module"` + `"main": "dist/index.js"`.
4. Both **named** and **default** exports must point to `pluginConstructor` — SK's `importOrRequire()` returns `module.default` for ESM.

## Routing Data Repository (signalk-router-data)
- Separate GitHub repo: `https://github.com/marcelrv/signalk-router-data`
- Contains pre-compiled `.sqlite` routing graph files in `regions/{continent}/{country}/{region}.sqlite`
- `index.json` at root is the machine-readable catalog (auto-generated by `scripts/generate_index.py`)
- `coverage-map.png` shows all available regions (auto-generated by same script)
- GitHub Action in `.github/workflows/generate-index.yml` auto-regenerates both on push
- The plugin's frontend has a "Manage Routing Data" dialog that fetches the catalog and allows downloading/updating databases
- Pipeline generates databases with `schema_version=2` which includes `boundary_geometry` and `bounding_box` in the metadata table (required for the coverage map)

### Database CLI example (with new args):
```bash
python3 nautical_routing_pipeline.py \
  --input-dir ./output_geojson \
  --output ./netherlands.sqlite \
  --country NL \
  --name "Netherlands" \
  --description "Dutch inland waterways and coastal waters" \
  --tags '["official","rws","enc","inland","coastal"]' \
  --contributor "marcelrv" \
  --url "https://example.com/source"
```

### Deploy script for the data repo
- `backend/deploy_to_data_repo.py` — gzips a `.sqlite` and places it in the `router-data/` folder structure, then regenerates `index.json`
- Usage:
  ```bash
  python3 backend/deploy_to_data_repo.py \
    --input ./netherlands.sqlite \
    --continent europe \
    --country nl \
    --region netherlands \
    --data-repo /home/node/signalkdev/router-data
  ```

### Known issues
1. **`POST /router/push`** fails with *"PUT not supported for resources.routes.*"* — the SK server's delta PUT handler does not support writing to `resources.routes.*`. Use `putSelfPath(relPath, value, cb)` to attempt the write, but this currently returns 405.
2. **Vessel dimension subscriptions** must use `app.subscriptionmanager.subscribe(command, unsubscribeFns, errorCb, callback)` with `unsubscribeFns` as an array (not a function).
3. **`__dirname` is unavailable** in ES modules — use `new URL(import.meta.url).pathname` to derive paths at plugin-constructor scope.
