# Changelog

## 0.1.0-alpha.3 — 2026-07-27

- Fixed: a first-time install could never reach the Data Manager, so there was
  no way to download the first routing database. With none installed the app sat
  on "Loading Routing Data — Waiting for server..." indefinitely: it waited for
  an endpoint that only answers once a routing graph is loaded, which cannot
  happen before the first download. It now recognises the empty install and opens
  the Data Manager on the Available tab, one click from the first download.
- Fixed: vessel dimensions stayed blank after that first download until the page
  was reloaded, because they had been requested once at startup while the
  routing engine was still unavailable.
- Changed: releasing now points npm's `latest` tag at the published pre-release
  for as long as no stable version exists, so `npm install signalk-routeiq` and
  the App Store resolve to the current build instead of whichever one happened to
  be tagged first. Once a stable version ships, pre-releases stop touching
  `latest`. A manual `workflow_dispatch` can also repoint a tag after the fact.
- Fixed: `./scripts/screenshots.sh` could produce a passing screenshot of a
  failed route — the waits for the route summary and the departure scan swallowed
  their own timeouts. They now fail the shot, which captures a `*.FAILED` image
  for diagnosis instead of publishing a misleading one.

## 0.1.0-alpha.2 — 2026-07-26

- Fixed: saving the plugin configuration on a fresh install failed with a 404.
  The API handler was only created in `start()`, so on an install that was not
  yet enabled `registerWithRouter()` threw and Signal K never mounted the plugin
  router — taking its own `POST /plugins/signalk-routeiq/config` route with it.
- Fixed: saving the plugin configuration could leave routing unavailable until
  the Signal K server was restarted, with every route request answering
  "Routing engine not ready, still initializing". Signal K stops and restarts the
  plugin on each save, and the two halves could overlap — the shutdown
  discarding the routing database the restart had just finished loading.
- Fixed: downloading or deleting a routing database while the plugin was still
  starting up, or while another download was completing, could leave routing
  unavailable the same way, and left the abandoned database's worker thread
  running — one per occurrence — for as long as the server stayed up.
- Fixed: route requests arriving while a routing database was being swapped in
  (after a download or delete) could reach that database as it was closing,
  instead of getting a plain "not ready" answer for the moment the swap takes.
- Fixed: on Windows, re-downloading a routing database after a failed startup
  reported an internal error instead of retrying the file replacement. The retry
  path assumed a database was already open, which is exactly what is not true
  when the download is meant to repair a broken one.
- Changed: stopping or disabling the plugin now finishes closing its routing
  database before Signal K moves on, so a stop immediately followed by a start
  can no longer trip over itself, and a database left over from an earlier start
  is always closed rather than abandoned.
- Changed: routes to a destination that sits away from the routing network skip
  a redundant nearest-waterway search, and opening a user-edits overlay now
  prepares its queries once instead of once per edge. Both are faster, with
  identical results.
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
- Added: `repository`, `bugs`, `homepage` and `author` to `package.json`. The
  App Store derives its GitHub and Issues links from these, and the registry
  clones the repository to run the test suite — without them a plugin scores
  zero for tests however many it actually has.
- Changed: CI now calls the shared `SignalK/signalk-server` plugin-CI reusable
  workflow (with a separate lint job), which is what the App Store registry
  credits. armv7 is disabled there: it runs Node 20, which has no `node:sqlite`
  and rejects `--experimental-sqlite` outright.
- Changed: `--experimental-sqlite` moved from CI's `NODE_OPTIONS` into the
  `test` script, so tests run identically on Windows and macOS runners.
- Fixed: `signalK.url` pointed at the wrong GitHub owner.
- Removed: the plugin router no longer serves the web UI under
  `/plugins/signalk-routeiq/`. The server gates all of `/plugins` behind admin
  auth, so that copy was invisible to read-only users — and broken for admins
  too, because the page derives its API base from its own URL and so requested
  `/plugins/signalk-routeiq/signalk/v1/api/router/...`, which is not where the
  API is mounted (404). The webapp is unaffected: it is published at
  `/signalk-routeiq/` by the `signalk-webapp` keyword and calls the public
  `/signalk/v1/api/router/...` endpoints. The admin-only API under
  `/plugins/signalk-routeiq/router/` is unchanged.
- Docs: the tide settings and README no longer describe `signalk-tides` as
  required. Both tide sources are optional and independent — with neither
  installed, routes fall back to plain distance.

## 0.1.0-alpha.1 — 2026-07-25

First alpha release. Offline-first, vessel-aware nautical route planning
for a small set of test regions (parts of the Netherlands and the US East
Coast). Not yet suitable for real-world passage planning — see the README
for details and current coverage.
