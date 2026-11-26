# Changelog

## Unreleased

- Injected `Logger` (`logger.ts`): `EngineOptions.logger`, `RoutingDatabaseOptions.logger`, `SqliteWorkerStoreOptions.logger`; silent by default. The core never uses the console (lint rule and a test on the compiled output). The db worker thread forwards its log calls as `{ type: "log" }` messages that `SqliteWorkerStore` hands to the logger.
- Stable `code` and `params` on every warning, leg warning, route-description warning, crossing note (`noteCode`/`noteParams`), departure scan error and passage-profile warning (`codes.ts`: the code lists).
- Message catalogue (`messages.ts`): every user-facing text keyed by code, in English and Dutch; `format(key, params, lang)`, `formatFailure`, `resolveMessageLanguage` (unknown language reads as English, `nl-BE` as `nl`, Dutch uses a decimal comma). The texts of warnings, itinerary legs, failures, request-validation errors and the GPX/Signal K route descriptions moved there; the English wording is unchanged.
- `EngineOptions.messageLanguage` (`"request"` follows the request `lang`, any other value fixes the language); `RequestLimits.messageLanguage` for the validator.
- `RouteFailure` (`failure.ts`): `code` (`NO_PATH`, `OUTSIDE_COVERAGE`, `NO_NODE_NEAR_POINT`, `BUDGET_EXCEEDED`, `ABORTED`, `VESSEL_INCOMPLETE`, `REGION_UNAVAILABLE`, `INVALID_REQUEST`), `params`, optional `blocking`, a translated `message` without file paths, SQL or internal ids. `RouteSearchError` and `RouteRequestError` are subclasses. `BUDGET_EXCEEDED` and `ABORTED` are reserved: nothing throws them yet.
- `RoutingEngine.getCounters()` (`counters.ts`): routes calculated and failed, failures by code, budget hits, search iterations and time (sum + count), regions loaded with an estimated size each.
- `RequestLimits.ignoredDimensionHint` (a callback) is replaced by `ignoredDimensionFallback: "default" | "configured"`, because the text must come from the catalogue to be translated.
- `RoutingEngine.calculateRoute` refuses a request whose start, end or via is not a latitude/longitude pair with `INVALID_REQUEST`.

- Package created (empty); exports `CORE_VERSION`.
- `EngineOptions`, `resolveRouteInputs`, `RouteRequestError` (strict mode, `VESSEL_INCOMPLETE`) and the `RouteInputs` echo (`RouteResult.inputs`).
- `RoutingRequest` gains `speedKnots` and `safetyMarginDraft`/`Beam`/`AirDraft`.
- `validateRouteRequest` and `RequestLimits`: the shared request validator.
