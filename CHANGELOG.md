# Changelog

## Unreleased

- Fixed: saving the plugin configuration on a fresh install failed with a 404.
  The API handler was only created in `start()`, so on an install that was not
  yet enabled `registerWithRouter()` threw and Signal K never mounted the plugin
  router — taking its own `POST /plugins/signalk-routeiq/config` route with it.
- Fixed: the Freeboard-SK plotter extension assets (`plotterext/`) were missing
  from the published package, so the RouteIQ panel failed to load in Freeboard-SK
  on an npm install.
- Changed: routing databases now default to the plugin's own Signal K data
  directory (`<config>/plugin-config-data/signalk-routeiq/routing-data`) instead of
  `./data/` inside `node_modules`, where npm discarded them on every plugin
  update. Existing configurations keep the directory they have.
- Fixed: the App Store icon did not render. `public/icon.svg` declared only a
  `viewBox`, so it had no intrinsic size; it now sets `width`/`height` as well.
- Added: `signalk.recommends` lists `signalk-tidal-currents`, `signalk-tides`
  and `@signalk/freeboard-sk` so the App Store links the optional companions.
- Added: four App Store screenshots under `img/`, declared in
  `signalk.screenshots` and shipped via `files`. Regenerate them with
  `./scripts/screenshots.sh`.
- Docs: the tide settings and README no longer describe `signalk-tides` as
  required. Both tide sources are optional and independent — with neither
  installed, routes fall back to plain distance.

## 0.1.0-alpha.1 — 2026-07-25

First alpha release. Offline-first, vessel-aware nautical route planning
for a small set of test regions (parts of the Netherlands and the US East
Coast). Not yet suitable for real-world passage planning — see the README
for details and current coverage.
