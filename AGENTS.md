# Project Conventions for AI Agents

## Architecture: Server-Side Routing, Frontend Is a Client

- **All routing logic lives in the SignalK server plugin** (`src/routing.ts`, `src/database.ts`, `src/db-worker.ts`). The A* search, graph loading, constraint evaluation, LOS smoothing, and violation reporting all run server-side.
- **The frontend** (`public/index.html`) is purely a **client** — it defines waypoints (start/dest/via), displays the calculated route on a map, and provides a graph editor. It contains zero routing logic. It must never implement its own pathfinding, graph traversal, or constraint evaluation.
- **The API** (`POST /signalk/v1/api/router/route`) is the single entry point for route calculation. It returns a `FeatureCollection` with per-segment features, each annotated with `minDepth`, `maxAirDraft`, `costFactor`, etc., plus violation warnings. This API is designed to be consumed by **any frontend** (the built-in one, third-party UIs, mobile apps, etc.) — it is not coupled to the Leaflet UI.
- **Route simplification and itineraries are backend concerns** (`src/itinerary.ts`, invoked from `RoutingEngine.finalizeRoute`). Every route result also carries `waypoints` (Douglas-Peucker-simplified navigable points, max deviation = `waypointTolerance` config, default 30 m) and `itinerary` (start/via/end + major turns with per-leg distance/minDepth/minWidth/maxAirDraft aggregates and crossings with `distanceFromStart` chainage; each point's `coordIndex` is its route vertex, feature k running from vertex k to k+1). The start and end entries also carry `name` + `nameSource` (`nameEndpoints` in `src/route-description.ts`): the nearest named POI within 250 m (`nearestPoiName`, a part reads as its whole), else the named water the route starts/ends in (within 500 m of the end); clients use it only when they have no name of their own for that end. Frontends must render these, never re-derive them from geometry (the webapp's client-side `extractMajorNodes` is legacy and should migrate to `itinerary`).
- **Route description** (`src/route-description.ts`, `src/route-metadata.ts`, `describeRoute` in `src/db-worker.ts`): after a route is found, the worker reads `edge_sequence_id`, water bodies, names and NAVLINE notices for the route's edges only; nothing goes into the in-memory graph and the `loadEdges` SELECT stays untouched. The result is `RouteResult.description` plus `ItineraryPoint.leg.waters` (UIs render, never recompute); every warning there, and every shallow/narrow `leg.warnings` entry (`legWarnings` in `src/itinerary.ts`, against the request's vessel dims), carries a server-decided `level` (`danger`/`caution`/`info`) that clients show as sent, and may carry `at` (`RouteLocation[]`: vertex range + chainage + bounds, a point when `coordIndex === toCoordIndex`) saying where it applies — clients link a warning to the map from `at` alone, never by its `type`, so a new warning type needs no client change; `lang` comes in on the route request. Tables are detected per file, not by `schema_version`; old files just have no description. Depth quality is compared by `rank` against the `'charted'` row (never by id), unknown enum ids read as `other`/`unknown`, and none of it is ever a routing cost. Colliding sequence/water-body ids between files switch that file's description off (`descriptionError` in `GET /databases`) but it still routes. Departure scans pass `describe: false`.
- **Graph editor endpoints** (`/signalk/v1/api/router/graph/nodes/*`, `/signalk/v1/api/router/graph/edges/*`) expose CRUD for the routing graph for debugging and manual corrections, but all actual routing decisions remain server-side.
- **Vessel dimensions** (draft, beam, airDraft) are fetched from the SignalK delta stream on the server and injected into the routing engine. The frontend may display them but does not enforce constraints.
- When modifying the frontend, ensure no routing logic leaks into it. The frontend should only: collect waypoint coordinates, POST them to the API, render the returned GeoJSON, and display warnings/metadata.
- **Browser floor**: the webapp runs on old chart plotters, so it targets `browserslist` in `package.json` (currently Chrome/WebView 66). `npm run lint` checks `public/app.js` against it, but that check has gaps — **ask before introducing anything that raises the minimum**.
- **Chart sources** (webapp, "chart sources" section in `public/index.html`): the Charts tab lets users pick map layers — built-in OSM/OpenSeaMap plus charts from the SK server's `resources/charts` API (fetched from the *server root*, not the plugin router mount). Raster `tilelayer` charts render via `L.tileLayer`; S-57 `pbf` charts via Leaflet.VectorGrid with a **simplified** S-52 day-palette style. That normalisation + styling is adapted from Freeboard-SK (Apache-2.0) — keep the attribution comments there and in README when touching it. Selection persists in `localStorage['routeiq-charts']`.

## Freeboard-SK Plotter Extension (plotterext/)
- The plugin is also a **plotter extension provider** (Plotter Extensions API v1, see the Freeboard-SK docs). `src/plotterext.ts` registers a read-only `plotterExtensions` resource manifest (toolbar button + `routeiq-panel` iframe panel) and mounts assets at `/plotterext/signalk-routeiq/`.
- The panel (`plotterext/panel.html` + `panel.js`) has **no map** — the host chartplotter renders everything. It reads the visible route via the host `routes` capability (`route.list`/`route.get`), POSTs first/middle/last points as start/via/end to `POST /router/route`, stages the result with `route.replace`, and persists via `route.save({dialog:true})`. Same rule as the webapp: zero routing logic client-side.
- Chart actions (`actions` capability: Set start / Add via / Set destination, Optimise route / Best departure time) and the panel's 📍 pick buttons (`map.pick`) only hand the panel coordinates or a route handle; a plan becomes a draft route via `route.create` once start and destination are known. Every capability newer than the original set goes in the manifest's `optional` list (an unknown id in `requires` makes the extension incompatible with that host), and the panel gates each use on `client.hasCapability()`.
- The `signalk-plotterext-bus` client library (npm dependency) is served from its `node_modules` dist at `/plotterext/signalk-routeiq/bus/`; the panel imports `./bus/extension.js`.
- Extension assets are deliberately **not** under `/plugins/*` (admin-gated) and the package must **not** rely on the `signalk-webapp` keyword for them.
- `averageSpeedKnots` and `defaultCoastDistance` are exposed to clients via `GET /router/config`; ETA in both UIs derives from the plugin-config average speed.

## Data Pipeline (moved out of this repo)
- The chart-ingestion/graph-generation pipeline (`enc_preprocessor.py`, `nautical_routing_pipeline.py`, `add_pois_to_db.py`, `deploy_to_data_repo.py`, `generate_coastline.py`) no longer lives here — it moved to its own repo, **signalk-router-pipeline** (local checkout: `/home/node/signalkdev/signalk-router-pipeline`). This repo (`routeiq`) now only contains the **runtime consumer** of the compiled `.sqlite` databases.
- For pipeline architecture, usage, and data sources, see that repo's `README.md`. For the database schema this runtime must read (including fields not yet consumed here, like `source_tier`/`navmesh_regions`), see `signalk-router-data`'s `specs/routing-database-format-specification.md`.
- Sections below (SQLite Schema, POI Model, Deterministic Node IDs, Config) describe what the current runtime (`src/database.ts`, `src/routing.ts`) actually reads today — check the format spec for anything newer the pipeline may start emitting.

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
- POI ids are opaque: the producer keeps them stable across builds and they are no longer recomputable from the position. Compare them only for equality; ids are comparable only between files of one producer.

## SQLite Schema
- **`metadata`** table: `country`, `name`, `description`, `last_update_date`, `tags` (JSON array), `bounding_box` (JSON), `boundary_geometry` (GeoJSON), `schema_version` (4 for the POI model), `format_generation` (0 for now), `contributor`, `url` — describes the data source. `country` is no longer UNIQUE (a country may have multiple region databases).
- **`edge_type_enum`** table: `(id, description)` — `0=coastal, 1=inland`.
- **`poi_type_enum`** table: `(id, description)` — `0=harbour, 1=lock, 2=bridge, 5=lock_chamber, 6=bridge_span` (the enum table may list more ids; routeiq handles only these five, see POI Model).
- **`nodes`** table: includes `region_id INTEGER REFERENCES metadata(id)` for per-region replacement. No `node_type` column — type is encoded in the node ID (see above).
- **`edges`**: uses `edge_type_id INTEGER` (FK to `edge_type_enum`) and `traffic_mode INTEGER` (`0=two-way, 1=one-way fwd, 2=one-way rev`). No `direction_penalty`, `edge_type` TEXT, `is_one_way`, or `traffic_dir` columns. No region-level column needed (edges follow their source node's region).
- **`pois`**: `(id, type_id, name, lat, lon, parent_id, properties JSON, info JSON, region_id)`. The same whole or part can be in several files with the same id and content; routeiq keeps one entry per id.
- **`edge_pois`**: `(source, target, poi_id)`, `source < target`: the parts (chambers, spans) an edge passes. Read for the edges of a found route, never at start-up.
- `edges.lock_id` and `properties.structure` no longer exist.

## POI Model (spec §1.1, §2.10, §2.14; routeiq reads nothing else)
- **No legacy path.** A file is refused at open (`formatRefusal` in `src/db-worker.ts`) when `metadata.format_generation` is not in the supported set `{0}` (missing column = 0), or when it predates the model: `schema_version` < 4, no `pois.parent_id` column, or no `edge_pois` table. The refusal is per file and never fatal for the others: `GET /databases` lists it with `state: "unsupported"` and a `formatError` message ("rebuild it with the factory"), like `descriptionError` for the description; it is skipped by every region-selection path. `loadDatabaseGraph` of such a file rejects with the message. There are no fallbacks: do not read display keys from `properties`, do not reintroduce `lock_id`.
- **Wholes and parts.** Types: `0` harbour, `1` lock (whole), `2` bridge (whole), `5` lock_chamber (part), `6` bridge_span (part). A part's `parent_id` is its whole (one level); a bridge_span can have a lock as parent (a span over a lock head). A route passes parts and is reported as passing the whole. A part whose parent is not loaded is treated as a whole of its own. Rows of any other `type_id` are dropped at load. Constants and the `KNOWN_POI_TYPES`/`POI_PART_TYPES`/`POI_WHOLE_TYPES` sets are in `src/database.ts`; `getPoiParent`/`getPoiChildren` give the parent and child maps.
- **`properties` (routing keys only)**: `subtype`, `closed_height`, `typical_wait_minutes`, `opening_hours`, `clearance_reference`, `underside_nap`, `mhw_nap`. `typical_wait_minutes` is on wholes; also on a chamber (overrides the lock's value, `0` is a real value) and on a span whose parent is a lock; a span under a bridge whole reads the whole's. Loaded for every POI at start-up; every `JSON.parse` of it goes through `parsePoiJson` (a bad row reads as `{}`).
- **`info` (display keys)**: `kind`, `height`, `height_unknown`, `height_source`, `chart_height`, `refs`, `sources`. Never loaded at start-up: the worker message `poiInfo {ids}` reads it on demand; `getPoisInBBox` (at most 500 results), `searchPois`, `getNearestPoi` and the crossings carry it as its own `info` field beside `properties`. Server and UI read heights and kinds from `info` only. A bridge span's structure kind (`bridge`, `cable` = overhead power line, `weir`, ...) is resolved by the server (`spanKind`: the span's own `info.kind`, else its bridge whole's) and sent as `kind` on map POIs and bridge crossings; `height_unknown` is resolved the same way (`spanHeightUnknown`) and sent as `heightUnknown` on both. Clients take an absent kind as a bridge and never walk to the whole themselves. A crossing group (one whole) can mix kinds, since a span's own kind wins: clients draw the bridge from its non-cable spans and add a pylon badge, never pick by the first entry.
- **Map and search.** The map (`GET /pois`) returns parts and harbours (with `displayName`: the whole's name for a chamber or a span of a bridge); search returns wholes and harbours. Neither shows a thing twice.
- **Crossings.** `detectRouteStructures(coordinates, segments)` expands the route's segments into graph edges (`expandSegmentEdges`, shared with the route description), makes one `routePois {pairs}` request (pairs normalised to (min, max); the union of `edge_pois` over every file that holds the pair, with a `known` flag; a file with no `edge_pois` row at all has linked nothing and has no say, so on its own the pair is unknown), and lists exactly the chambers and spans linked to the route's edges, grouped by `parent_id`. On an edge no file holds (connector, navmesh shortcut, overlay edit: `known` false) it falls back to geometry for that edge only (in an aggregated segment, the line between that edge's nodes; the known edges keep their links): parts within `FALLBACK_MAX_DIST` (50 m, point-to-segment distance to that line; was 150 m from a vertex, which listed bridges on neighbouring canals, #57). A crossing carries the whole's name, `structure` = the whole's id as a string, and `partId` = the chamber or span used (the one nearest the line). The wait is the part's own value where the spec lets it carry one, else the whole's. The result is not cached between routes: a departure scan asks once per evaluated route.
- **Lock spans.** The same request sets `segments[].lockIds` to the lock whole of each linked chamber, or of a linked span whose parent is a lock. `crossingWaitSchedule` turns those into lock spans.

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
2. `"signalK": { "pluginConstructor": "pluginConstructor", "name": "signalk-routeiq" }` — names the factory function.
3. `"type": "module"` + `"main": "dist/index.js"`.
4. Both **named** and **default** exports must point to `pluginConstructor` — SK's `importOrRequire()` returns `module.default` for ESM.

## Routing Data Repository (signalk-router-data)
- Separate GitHub repo: `https://github.com/marcelrv/signalk-router-data`
- Contains pre-compiled `.sqlite` routing graph files in `regions/{continent}/{country}/{region}.sqlite`
- `index.json` at root is the machine-readable catalog (auto-generated by `scripts/generate_index.py`)
- `coverage-map.png` shows all available regions (auto-generated by same script)
- GitHub Action in `.github/workflows/generate-index.yml` auto-regenerates both on push
- The plugin's frontend has a "Manage Routing Data" dialog that fetches the catalog and allows downloading/updating databases
- **Autoload/disabled switch**: an installed database is switched off by renaming it to `<name>.sqlite.disabled` (`POST /databases/enabled` with `{filename, enabled}`; `DISABLED_SUFFIX` and the `isDisabledFile`/`baseFilename` helpers live in `src/database.ts`). Both states are scanned and both appear in `coverageIndex` — keyed by the plain `.sqlite` name, so a toggle never changes a database's identity — but a `disabled` entry must be skipped by *every* region-selection path (`ensureRegionsLoaded`, `ensureRegionsForBbox`, `eagerLoadForPosition`, `eagerLoadIfSingle`, `loadDatabaseGraph`). `getLoadingStatus().available` counts only routable databases and reports `disabled` separately. A directory holding nothing but disabled files must still `init()` successfully with an empty graph: `GET /databases` answers 503 while `db` is null, so throwing there would leave the Data Manager unable to list — and therefore unable to re-enable — the switched-off files.
- Building or updating a database, adding POIs, or deploying to this repo is done from **signalk-router-pipeline** now, not from here — see that repo's `README.md`.

### Known issues
1. **`POST /router/push`** fails with *"PUT not supported for resources.routes.*"* — the SK server's delta PUT handler does not support writing to `resources.routes.*`. Use `putSelfPath(relPath, value, cb)` to attempt the write, but this currently returns 405.
2. **Vessel dimension subscriptions** must use `app.subscriptionmanager.subscribe(command, unsubscribeFns, errorCb, callback)` with `unsubscribeFns` as an array (not a function).
3. **`__dirname` is unavailable** in ES modules — use `new URL(import.meta.url).pathname` to derive paths at plugin-constructor scope.
