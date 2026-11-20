# Changelog

## Unreleased

- Package created (empty); exports `CORE_VERSION`.
- `EngineOptions`, `resolveRouteInputs`, `RouteRequestError` (strict mode, `VESSEL_INCOMPLETE`) and the `RouteInputs` echo (`RouteResult.inputs`).
- `RoutingRequest` gains `speedKnots` and `safetyMarginDraft`/`Beam`/`AirDraft`.
- `validateRouteRequest` and `RequestLimits`: the shared request validator.
