# Project Conventions for AI Agents

## Python (backend/)
- Always use `python3` (not `python`) when running scripts.
- Always use `pip3` (not `pip`) when installing packages.
- The backend has two scripts:
  - `enc_preprocessor.py` — accepts `--input` and `--output`
  - `nautical_routing_pipeline.py` — accepts `--input-dir`, `--output`, `--country`, `--name`, `--description`
- Dependencies in `requirements.txt`. Install via `pip3 install --user --break-system-packages -r backend/requirements.txt`
- No system `sudo` available in dev environment; use `--user` + `--break-system-packages` for pip installs.

## Adaptive Quadtree Grid (coastal navmesh)
- `nautical_routing_pipeline.py` uses adaptive quadtree subdivision (replacing the old fixed 0.01° grid).
- Resolution: 0.005° (~500m) in open sea → 0.0002° (~20m) in narrow channels.
- Subdivision criteria: narrowness (distance to nearest land), presence of centerlines, land/water boundary.
- Nodes store `resolution` and `node_type` metadata in the SQLite DB.
- Edges store `edge_type` ('coastal' or 'inland').

## Bounding-Box A* Search (runtime)
- `routing.ts:astarSearch()` accepts an optional `bbox` parameter that prunes nodes outside the box.
- On failure, the margin doubles (`routingBBoxMargin` → `routingBBoxMaxExtent`).
- BBox expansion adds warnings to the route result.
- Via points each get their own per-segment bounding box.

## Deterministic Node IDs (coordinate hashing)
- Node IDs are globally unique integers derived from snapped (lat, lon) at 5 decimal places.
- Formula: `lat_int = int((round(lat,5) + 90.0) * 100000)`, `lon_int = int((round(lon,5) + 180.0) * 100000)`, `id = lat_int * 100000000 + lon_int`.
- Fits within `Number.MAX_SAFE_INTEGER` (53 bits). Allows merging multiple regional `.sqlite` files without ID collisions.
- POI IDs use a deterministic MD5 hash of `"{poi_type}_{round(lat,5)}_{round(lon,5)}"` truncated to 13 hex chars.

## SQLite Schema
- **`metadata`** table: `country` (UNIQUE), `name`, `description`, `last_update_date` — describes the data source.
- **`nodes`** table: includes `region_id INTEGER REFERENCES metadata(id)` for per-region replacement.
- **`edges`**: same as before, no region-level column needed (edges follow their source node's region).
- **`pois`**: `INSERT OR IGNORE` handles duplicate POI IDs from overlapping regions (uses deterministic hash based on type+coords, ignoring name variations).

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

### Known issues
1. **`POST /router/push`** fails with *"PUT not supported for resources.routes.*"* — the SK server's delta PUT handler does not support writing to `resources.routes.*`. Use `putSelfPath(relPath, value, cb)` to attempt the write, but this currently returns 405.
2. **Vessel dimension subscriptions** must use `app.subscriptionmanager.subscribe(command, unsubscribeFns, errorCb, callback)` with `unsubscribeFns` as an array (not a function).
3. **`__dirname` is unavailable** in ES modules — use `new URL(import.meta.url).pathname` to derive paths at plugin-constructor scope.
