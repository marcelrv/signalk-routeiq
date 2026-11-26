# Changelog

Versions follow semver; see "Versioning" in the README for what counts as a
breaking change.

## Unreleased

### Fixed

- `pinned` policy: `loadGraph()` rejects when an enabled file is refused for its format or cannot load, instead of resolving with missing coverage. Disabled files stay excluded.
- `EngineClient`: options that cannot be sent to the worker (a function, say) fail the start with `INIT_FAILED` like any other startup failure; a `logger` in the engine or database options stays on the client side.
- Tide and current provider calls honour the request's abort signal and wall-time budget (`ABORTED` / `BUDGET_EXCEEDED`).
- Provider error text is logged at `debug` only; the `warn` line is generic.
- Read-only mode is checked on the opened read-only connection (a write in a rolled-back transaction) instead of in a temporary directory; `nodeSqliteSupportsReadOnly` is replaced by `probeReadOnlyConnection`.
- A `dbIndex` issued before `close()` or a re-initialisation is refused by the store (`Stale database handle`) and never selects another file.
- `RoutingEngine` validates its options at construction (`validateEngineOptions`; `bboxMarginDeg` above 0, `bboxMaxExtentDeg` not below it, other numbers finite and in range), and the bounding-box retry loops stop when the margin does not grow.

## 1.0.0 - 2026-11-26

First release as a standalone package: the routing engine of `signalk-routeiq`,
usable outside Signal K. Distributed as a tarball attached to the GitHub release
`core-v1.0.0`.

### Added

- Package entry point `routeiq-core` with the engine, the database, route description, itinerary, passage profile, GPX / Signal K route export, tides and `CORE_VERSION`. Only `node:*` modules are imported.
- `EngineOptions` and `resolveRouteInputs`: the engine keeps no vessel or user state; each request carries its draft, beam, air draft, speed, margins, waits and tide choice, and the options only supply defaults. `RoutingRequest` gains `speedKnots` and `safetyMarginDraft`/`Beam`/`AirDraft`.
- `RouteResult.inputs` (`RouteInputs`): the effective values a route was calculated with, the core version and `inputs.data`, a provenance hint (file name, `lastUpdateDate`, build id) per loaded routing file.
- Strict mode (`requireVesselInRequest`): a request without draft, beam, air draft and speed is refused with `RouteRequestError` (`VESSEL_INCOMPLETE`).
- `validateRouteRequest` and `RequestLimits`: the shared validator for untrusted request bodies (coordinate ranges, vias, speed, margins, waits, flags, language, straight-line length).
- `RouteFailure` (`failure.ts`) with `code`, `params`, optional `blocking` and a translated `message` free of file paths, SQL and internal ids: `NO_PATH`, `OUTSIDE_COVERAGE`, `NO_NODE_NEAR_POINT`, `BUDGET_EXCEEDED`, `ABORTED`, `VESSEL_INCOMPLETE`, `REGION_UNAVAILABLE`, `INVALID_REQUEST`. `RouteSearchError` and `RouteRequestError` are subclasses.
- Stable `code` and `params` on every warning, leg warning, route-description warning, crossing note (`noteCode`/`noteParams`), departure scan error and passage-profile warning (`codes.ts`).
- Message catalogue (`messages.ts`) in English and Dutch: `format`, `formatFailure`, `resolveMessageLanguage`; `EngineOptions.messageLanguage` and `RequestLimits.messageLanguage`.
- Request budget and abort (`request-control.ts`): `EngineOptions.budget` (`maxIterations`, `maxWallMs`) is spent over a whole request; `calculateRoute`, `streamDepartures` and `scanDepartures` take `{ budget, signal }`. `EngineOptions.maxSearchIterations` is the per-search cap.
- Injected `Logger` on the engine, the database and the store; silent by default, no coordinates above `debug`. The core never uses the console.
- `RoutingEngine.getCounters()`: routes, failures by code, budget hits, search iterations and time, regions loaded with an estimated size.
- Worker host (`worker-host.ts`) and `EngineClient`: the database and engine in a `worker_thread` behind a versioned protocol (`PROTOCOL_VERSION = 1`); jobs `route`, `departures`, `status`, `pois`, `search`, `nearestPoi`, `coverage`, `gpx`, `abort`, `shutdown`; one job at a time with a queue; abort by job id or signal; hard stop and restart of a hung worker (`WORKER_RESTARTED`), `WORKER_EXITED`, `ready`/`onReady`.
- Host `init.providers`: tide-height and current provider modules loaded inside the worker.
- Route result ids (`resultId`, a string carrying the worker's generation); GPX from the host only for a result it still holds (the last 32).
- `RoutingDatabaseOptions.readOnly` (the store checks at start that `node:sqlite` honours it), `policy`, an explicit file list, and `limits` (`PoiLimits`) for POI results, search results, the nearest-POI radius and search text length.
- Pack contents check and release workflow for the tarball.

### Changed

- GPX/XML output escapes every text and removes characters XML 1.0 forbids (`escapeXmlText`, `escapeXmlAttribute`).
- `RequestLimits.ignoredDimensionHint` (a callback) is replaced by `ignoredDimensionFallback: "default" | "configured"`, so the text comes from the catalogue.
- `RoutingEngine.calculateRoute` refuses a start, end or via that is not a latitude/longitude pair with `INVALID_REQUEST`.
- `streamDepartures` takes `RouteCallOptions` (was `{ aborted: boolean }`) and throws `ABORTED`/`BUDGET_EXCEEDED` out of the stream; a consumer that stops reading still ends the scan cleanly.
- `SqliteWorkerStore`: when its worker dies on its own, waiting calls are rejected and further calls are refused until `openAll` (or `close`).
- POI search and box limits are normalised to whole non-negative counts; search text has control characters removed.
