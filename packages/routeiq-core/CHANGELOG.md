# Changelog

## Unreleased

- Injected `Logger` (`logger.ts`): `EngineOptions.logger`, `RoutingDatabaseOptions.logger`, `SqliteWorkerStoreOptions.logger`; silent by default. The core never uses the console (lint rule and a test on the compiled output). The db worker thread forwards its log calls as `{ type: "log" }` messages that `SqliteWorkerStore` hands to the logger.
- Stable `code` and `params` on every warning, leg warning, route-description warning, crossing note (`noteCode`/`noteParams`), departure scan error and passage-profile warning (`codes.ts`: the code lists).
- Message catalogue (`messages.ts`): every user-facing text keyed by code, in English and Dutch; `format(key, params, lang)`, `formatFailure`, `resolveMessageLanguage` (unknown language reads as English, `nl-BE` as `nl`, Dutch uses a decimal comma). The texts of warnings, itinerary legs, failures, request-validation errors and the GPX/Signal K route descriptions moved there; the English wording is unchanged.
- `EngineOptions.messageLanguage` (`"request"` follows the request `lang`, any other value fixes the language); `RequestLimits.messageLanguage` for the validator.
- `RouteFailure` (`failure.ts`): `code` (`NO_PATH`, `OUTSIDE_COVERAGE`, `NO_NODE_NEAR_POINT`, `BUDGET_EXCEEDED`, `ABORTED`, `VESSEL_INCOMPLETE`, `REGION_UNAVAILABLE`, `INVALID_REQUEST`), `params`, optional `blocking`, a translated `message` without file paths, SQL or internal ids. `RouteSearchError` and `RouteRequestError` are subclasses. `BUDGET_EXCEEDED` and `ABORTED` are thrown by the request budget and abort (below).
- `RoutingEngine.getCounters()` (`counters.ts`): routes calculated and failed, failures by code, budget hits, search iterations and time (sum + count), regions loaded with an estimated size each.
- `RequestLimits.ignoredDimensionHint` (a callback) is replaced by `ignoredDimensionFallback: "default" | "configured"`, because the text must come from the catalogue to be translated.
- `RoutingEngine.calculateRoute` refuses a request whose start, end or via is not a latitude/longitude pair with `INVALID_REQUEST`.
- Request budget (`request-control.ts`): `EngineOptions.budget = { maxIterations, maxWallMs }` (default unlimited) is spent over the whole request: every bounding-box retry, via leg, departure-scan step and smoothing pass. `calculateRoute`, `streamDepartures` and `scanDepartures` take `{ budget, signal }` as call options; a call's budget can only lower the engine's. Checked in the A* loop (iterations every expansion; wall time and abort every 1024 expansions and after each yield) and between retries, legs and steps. An overrun throws `RouteFailure` `BUDGET_EXCEEDED` (params `limit`, `used`, `max`) and counts in `budgetHits`.
- `EngineOptions.maxSearchIterations` (default 5_000_000): the per-search cap, unchanged in behaviour (a search that reaches it still ends as "no path" with `iterationLimit: true`).
- Abort: the call options take an `AbortSignal`; an aborted request throws `ABORTED`. `streamDepartures` takes `RouteCallOptions` (was `{ aborted: boolean }`) and now throws `ABORTED`/`BUDGET_EXCEEDED` out of the stream instead of returning quietly; a consumer that stops reading still ends the scan cleanly.
- Worker host (`worker-host.ts`, entry file) and `EngineClient` (`engine-client.ts`): the store, database and engine in a `worker_thread` behind a versioned protocol (`protocol.ts`, `PROTOCOL_VERSION = 1`, requests `init`, `status`, `route`, `pois`, `search`, `nearestPoi`, `coverage`, `gpx`, `abort`, `shutdown`). One job at a time, queued by the client; `abort(jobId)` or a signal; hard stop (`hardStopGraceMs`) and restart of a hung worker (`WORKER_RESTARTED`), unexpected exits (`WORKER_EXITED`), `ready`/`onReady`. Queued jobs survive a restart. Failures cross as `{ code, params, message, blocking? }` and are thrown again as `RouteFailure`.
- GPX from the host is built only from a route result it still holds (the last 32, by result id); `GpxExporter.toGpx` is unchanged for in-process use.
- GPX/XML: every text is escaped and characters XML 1.0 forbids are removed (`escapeXmlText`, `escapeXmlAttribute`); attribute values keep tab/LF/CR as character references.
- `RoutingDatabaseOptions.limits` (`PoiLimits`): caps for POI box results (500), search results, nearest-POI radius (both unlimited) and search text length (256). Search text has control characters removed.
- `SqliteWorkerStore`: when its worker dies on its own, waiting calls are rejected and further calls are refused until `openAll` (or `close`); it no longer keeps posting to a terminated worker.

- Package created (empty); exports `CORE_VERSION`.
- `EngineOptions`, `resolveRouteInputs`, `RouteRequestError` (strict mode, `VESSEL_INCOMPLETE`) and the `RouteInputs` echo (`RouteResult.inputs`).
- `RoutingRequest` gains `speedKnots` and `safetyMarginDraft`/`Beam`/`AirDraft`.
- `validateRouteRequest` and `RequestLimits`: the shared request validator.
