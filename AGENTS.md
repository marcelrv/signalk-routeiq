# Project Conventions for AI Agents

## Architecture: Server-Side Routing, Frontend Is a Client

- **All routing logic lives in the SignalK server plugin** (`src/routing.ts`, `src/database.ts`, `src/db-worker.ts`). The A* search, graph loading, constraint evaluation, LOS smoothing, and violation reporting all run server-side.
- **The frontend** (`public/index.html`) is purely a **client** — it defines waypoints (start/dest/via), displays the calculated route on a map, and provides a graph editor. It contains zero routing logic. It must never implement its own pathfinding, graph traversal, or constraint evaluation.
- **The API** (`POST /signalk/v1/api/router/route`) is the single entry point for route calculation. It returns a `FeatureCollection` with per-segment features, each annotated with `minDepth`, `maxAirDraft`, `costFactor`, etc., plus violation warnings. This API is designed to be consumed by **any frontend** (the built-in one, third-party UIs, mobile apps, etc.) — it is not coupled to the Leaflet UI.
- **Route simplification and itineraries are backend concerns** (`src/itinerary.ts`, invoked from `RoutingEngine.finalizeRoute`). Every route result also carries `waypoints` (Douglas-Peucker-simplified navigable points, max deviation = `waypointTolerance` config, default 30 m) and `itinerary` (start/via/end + major turns with per-leg distance/minDepth/minWidth/maxAirDraft aggregates and crossings with `distanceFromStart` chainage). Frontends must render these, never re-derive them from geometry (the webapp's client-side `extractMajorNodes` is legacy and should migrate to `itinerary`).
- **Graph editor endpoints** (`/signalk/v1/api/router/graph/nodes/*`, `/signalk/v1/api/router/graph/edges/*`) expose CRUD for the routing graph for debugging and manual corrections, but all actual routing decisions remain server-side.
- **Vessel dimensions** (draft, beam, airDraft) are fetched from the SignalK delta stream on the server and injected into the routing engine. The frontend may display them but does not enforce constraints.
- When modifying the frontend, ensure no routing logic leaks into it. The frontend should only: collect waypoint coordinates, POST them to the API, render the returned GeoJSON, and display warnings/metadata.

## Freeboard-SK Plotter Extension (plotterext/)
- The plugin is also a **plotter extension provider** (Plotter Extensions API v1, see the Freeboard-SK docs). `src/plotterext.ts` registers a read-only `plotterExtensions` resource manifest (toolbar button + `autoroute-panel` iframe panel) and mounts assets at `/plotterext/signalk-autoroute/`.
- The panel (`plotterext/panel.html` + `panel.js`) has **no map** — the host chartplotter renders everything. It reads the visible route via the host `routes` capability (`route.list`/`route.get`), POSTs first/middle/last points as start/via/end to `POST /router/route`, stages the result with `route.replace`, and persists via `route.save({dialog:true})`. Same rule as the webapp: zero routing logic client-side.
- The `signalk-plotterext-bus` client library (npm dependency) is served from its `node_modules` dist at `/plotterext/signalk-autoroute/bus/`; the panel imports `./bus/extension.js`.
- Extension assets are deliberately **not** under `/plugins/*` (admin-gated) and the package must **not** rely on the `signalk-webapp` keyword for them.
- `averageSpeedKnots` and `defaultCoastDistance` are exposed to clients via `GET /router/config`; ETA in both UIs derives from the plugin-config average speed.

## Data Pipeline (moved out of this repo)
- The chart-ingestion/graph-generation pipeline (`enc_preprocessor.py`, `nautical_routing_pipeline.py`, `add_pois_to_db.py`, `deploy_to_data_repo.py`, `generate_coastline.py`) no longer lives here — it moved to its own repo, **signalk-router-pipeline** (local checkout: `/home/node/signalkdev/signalk-router-pipeline`). This repo (`autoroute`) now only contains the **runtime consumer** of the compiled `.sqlite` databases.
- For pipeline architecture, usage, and data sources, see that repo's `README.md`. For the database schema this runtime must read (including fields not yet consumed here, like `source_tier`/`navmesh_regions`), see `signalk-router-data`'s `specs/routing-database-format-specification.md`.
- Sections below (SQLite Schema, Deterministic Node IDs, Config) describe what the current runtime (`src/database.ts`, `src/routing.ts`) actually reads today — check the format spec for anything newer the pipeline may start emitting.

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
- Package manager: `npm` (not yarn, pnpm).
- Scripts: `build`, `dev`, `lint`, `format`, `test` — see `package.json`.
  (Tests for now: `node --test --test-force-exit dist-test/routing.test.js`)
- All source in `src/`, compiled to `dist/`.
- ES modules (`"type": "module"` in package.json).


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
- Building or updating a database, adding POIs, or deploying to this repo is done from **signalk-router-pipeline** now, not from here — see that repo's `README.md`.

### Known issues
1. **`POST /router/push`** fails with *"PUT not supported for resources.routes.*"* — the SK server's delta PUT handler does not support writing to `resources.routes.*`. Use `putSelfPath(relPath, value, cb)` to attempt the write, but this currently returns 405.
2. **Vessel dimension subscriptions** must use `app.subscriptionmanager.subscribe(command, unsubscribeFns, errorCb, callback)` with `unsubscribeFns` as an array (not a function).
3. **`__dirname` is unavailable** in ES modules — use `new URL(import.meta.url).pathname` to derive paths at plugin-constructor scope.
