# Changelog

## Unreleased

- Added: when a route has to wait for a region's routing data to be read in
  first, the planner now says which region it is waiting on instead of looking
  frozen. With dynamic loading, the first route into an area loads that area's
  data before it can answer, which takes seconds to the best part of a minute
  on a large region — until now with nothing on screen to say why.
- Fixed: such a route could also be given up on as failed while the server was
  still working. The planner waited 30 seconds regardless; a full-country
  region can take longer than that to load. It now allows a request that is
  demonstrably waiting on routing data considerably longer, and if it does
  time out, says so in those terms rather than as a routing failure.

- Added: a route whose start or destination sits far from any charted waterway
  now says so. The planner joins such a point to the nearest waterway with a
  straight line, which is fine for the last few meters to a quay but is not a
  navigable answer over kilometers — and that leg is not depth-checked, because
  there is no charted water under it to check. Beyond 1.5 km it is reported as
  a coverage gap, usually meaning the routing data does not cover that stretch.
  Shorter connections are unchanged and stay out of the way. Previously both
  were reported the same way and the web app hid them entirely, so a route
  could quietly cross four kilometers of water nobody had charted.

- Fixed: where two neighboring routing databases overlap, every waterway they
  both describe was held twice in memory — 24,506 duplicated connections on the
  Connecticut/Rhode Island pair alone, concentrated on exactly the crossings a
  route between the two regions has to use. They are now merged into one, and
  where the two disagree about depth, headroom or width, the more cautious
  figure is kept. Nothing about which route you get changes; the planner just
  stops doing the same work twice at every regional boundary, and loading a
  second overlapping region is slightly faster than before.

- Added: an autoload/disabled switch for each installed routing database, in
  Manage Routing Data. Disabling keeps the file on the device but stops the
  plugin loading it, so you can swap which regions are in play without
  deleting and re-downloading hundreds of megabytes. Switching takes effect
  immediately — no server restart — and a disabled region is dropped from the
  routing graph straight away rather than lingering until the next reboot.
  Databases you had already disabled by hand, by renaming them to
  `<name>.sqlite.disabled`, now show up in the list with a Disabled badge
  instead of vanishing from it.

## 0.1.0-alpha.6 — 2026-08-07

- Fixed: a lock could appear twice in the itinerary — once under its own name
  with no waiting time against it, and once as a nameless "Lock" carrying the
  hour. The name and the wait now sit on the same entry. The route's estimated
  duration was always right; it was the list that did not add up on screen.
- Fixed: the planner could hang on "Loading Routing Data" forever on older
  tablets and chart plotters, without ever showing a connection retry. It now
  connects and retries normally on those devices too.
- Fixed: the planner needed internet just to start, because the map library it
  draws on was loaded from the web. It's now bundled with the plugin, so the
  app starts offline. Base map tiles still need a network; for offline charts,
  use a Signal K chart provider.
- Added: if something goes wrong during startup — an incompatible browser, a
  missing file — the loading screen now says what happened, with a button to
  dismiss it and carry on, instead of sitting on a spinner with no explanation.
- Changed: a route result's `totalSeconds` now includes time spent waiting at
  locks and opening bridges, not just time spent moving — so a client reading
  it as pure travel time will be off by roughly an hour for each lock or bridge
  crossed. `totalSecondsNoTide` includes the same waits, deliberately, so
  comparing the two isn't skewed into looking like a tide saving. The waiting
  time is also broken out on its own, per leg as `leg.waitSeconds` and for the
  whole route as `totalWaitSeconds`.

## 0.1.0-alpha.5 — 2026-08-03

- Added: routes now allow time for locks and opening bridges. A route through
  the Zeeland delta crosses four locks and eight opening spans, and was reported
  as if every one of them were standing open. Defaults of 60 and 30 minutes,
  set under Plugin Config and adjustable per route under ☰ → Routing, are
  counted once per crossing towards the estimated duration and arrival time.
  Fixed spans cost nothing: you either fit under one or the route should not be
  crossing it. The wait is deliberately kept out of the routing cost, so it
  changes what a route is expected to take but never which way it goes. A
  routing database that carries a figure for a specific lock or bridge overrides
  both, though nothing emits that yet.
  A wait is spent where it happens, not added to the end: an hour in a lock puts
  every later leg an hour further into the tide, and sampling the flow field
  without that was the wrong-clock-time problem these waits exist to remove.
  Crossings close together along the route count as one obstacle, because the
  list is built from nearby points of interest and cannot tell which of several
  parallel structures a vessel actually uses: two lock chambers side by side are
  one locking, and a footbridge beside its road bridge is one opening. A lock
  absorbs the spans over its own heads — they open with it. Where the routing
  data records which lock a route went through, the lock's whole extent is used
  rather than a radius around its entry: the bridge over the Krammersluizen's
  far head is 316 m from the entry going north and 113 m going south, so a fixed
  radius charged an extra half hour in one direction only. Two locks never merge
  into one, however tightly they abut.
- Added: the waiting time is shown where the travel time is. It appears in the
  route summary, on each leg that has one, and against the lock or bridge that
  causes it. The summary, the turn list and the expanded leg detail now all take
  their times from the same source, so they agree with each other and with the
  total — previously the collapsed turn list was distance over average speed, so
  expanding a turn showed a different figure from the one above it.
- Fixed: a routing-data directory holding databases built by different pipeline
  versions could fail to load. Column availability was merged across every
  loaded database and then applied to all of them, so a query naming a column
  that only some of them have failed for the rest. Each database is now read
  with its own columns.
- Changed: the settings panel's tab body scrolls on every screen size, and its
  close button no longer scrolls out of reach on narrow ones. Which tab
  scrolled previously depended on how tall its content happened to be.
- Changed: "Backend URL" moves out of the Routing settings into its own
  "Advanced" section — it decides which server answers, not what is asked of it.
- Added: the departure planner shows the distance of each departure. A
  tide-aware scan can pick a different route at different times, so a row that
  is slower because its route is several miles longer used to look identical to
  one that is slower because the tide is against it.
- Added: the travel-time column switches to arrival time, from the control above
  it. Arrivals that land on a later day are marked (`06:41+1`) rather than
  showing a bare clock time that reads as arriving before departure. The choice
  is remembered.

## 0.1.0-alpha.4 — 2026-08-01

- Fixed: the settings panel could run off the bottom of the window with no way
  to scroll it. The Charts tab is as long as the server has charts — with 18 of
  them the panel ended 126 px below the viewport, and everything past that was
  unreachable. It is now bounded to the window and the tab body scrolls, with
  the header and its close button staying put. Narrow and short screens already
  turned the panel into a scrolling side sheet; this is the same idea for a
  desktop window.
- Fixed: the App Store listing showed the raw `<img src="public/icon.svg" …>`
  tag as text instead of the icon. Its README renderer does not allow inline
  HTML; the icon is now a Markdown image, with an absolute raw URL so it also
  resolves on npmjs.com where a relative path does not.
- Fixed: the web app showed Signal K's own favicon in the browser tab, because
  it declared none of its own and the browser fell back to the server root. It
  now uses the RouteIQ icon. The title leads with the name too — a tab truncated
  "SignalK RouteIQ Nautical Route Planner" down to "SignalK RouteIQ Nau…", so
  the app looked like the server it runs on.
- Fixed: the departure time used for tide-aware routing was the moment the page
  was opened, not the current time. The field was filled in once, when the tide
  panel first appeared, and then only ever refilled if it was empty — so ticking
  "Consider tide" an hour later, planning a route, or scanning for the best
  departure all worked from an hour in the past, silently. It now tracks the
  clock until a departure is actually chosen, either by editing the field or by
  picking a row in the departure planner. Affected the webapp and the
  Freeboard-SK plotter panel alike.
- Changed: the departure planner now fills in as it scans instead of showing a
  spinner until every departure has been calculated. A scan is one full route
  calculation per hour of the window and can run for minutes on a long passage;
  `POST /route/departures` now streams each result as newline-delimited JSON to
  a client that asks for it (`Accept: application/x-ndjson`), and answers with
  the same single JSON document as before to one that does not.
- Changed: the scan works coarse to fine — both ends of the window first, then
  the midpoint of each interval, and so on — rather than hour by hour from the
  start. The shape of the day is legible after a handful of results, which is
  usually enough to see where the good departures are long before the scan ends.
  The colour ramp and the ★ re-scale as results land.
- Added: a fifth App Store screenshot, `img/webapp-departures.jpg` — the
  departure planner mid-scan. Regenerate it with
  `./scripts/screenshots.sh webapp-departures`.
- Fixed: the departure planner mixed clock formats in one dialog — its rows are
  24 h, but the window it covers was rendered in whatever the locale preferred,
  so an en-US browser put "08:50 PM" directly above a column reading "20:50".
  The window heading and the row tooltips are now 24 h too, in the webapp and in
  the plotter panel.
- Fixed: saving a reshaped route from the Freeboard-SK plotter panel failed with
  "Operation could not be completed" and a wall of schema errors. Signal K's
  route schema requires every `coordinatesMeta` entry to carry a name or an
  href, and the host builds one entry per waypoint from that waypoint's name —
  so the unnamed points RouteIQ generated between start and destination became
  empty objects the server rejected. Reshaping a route into dozens of graph
  nodes made this certain rather than occasional. Generated waypoints are now
  numbered `WP1` upwards, except that the start and destination keep whatever
  the route already called them if they were named at all.
- Changed: a route saved from the webapp now carries the same numbered waypoints
  as one saved from the plotter panel. The two save by different routes — the
  webapp posts to the plugin, which writes the resource itself, while the panel
  hands its points to Freeboard-SK, which writes its own — and the webapp's
  omitted waypoint names altogether. The same route saved from the two windows
  produced two different waypoint lists.
- Changed: the Freeboard-SK plotter panel's departure list streams too, laying
  the whole window out at once and filling it in coarse to fine as results
  arrive, instead of showing "Scanning departures…" until the last one lands.
  Hiding the list drops the request, which stops the server calculating the rest.
- Changed: paging the departure window by 12 hours no longer recalculates the
  half it already has. A 24 h window moved half its own width overlaps itself by
  13 of its 25 steps — same route, same constraints, the same departure times to
  the millisecond — so only the 12 that are genuinely new are requested, and
  paging back to a window already seen calculates nothing at all. Kept results
  are discarded as soon as anything that would change a travel time changes.
- Added: the departure planner can be cancelled while it is still scanning,
  keeping the departures found so far, and can page the window backwards and
  forwards 12 hours at a time. Cancelling, paging, or closing the planner drops
  the request, which is what stops the server calculating a window nobody is
  looking at any more.
- Fixed: routing failed outright with "Invalid draft — expected a number in
  meters" on a server whose vessel draft was set. Signal K's `design.draft` is
  not a plain number — its value is an object (`{maximum, minimum, current}`) —
  and the webapp forwarded it verbatim as a routing override whenever the plugin
  had no draft of its own. A dimension is now read from that shape (and from a
  draft stored as text, `"2"`), both in the plugin and in the webapp.
- Changed: a draft, beam or air draft that still cannot be read no longer fails
  the request. It is dropped and the route is planned against the dimensions
  configured on the server, with a `vessel_dimension_ignored` warning in the
  route result — shown in the planner's warnings and as a toast, and logged.
  Dropping rather than zeroing is deliberate: the engine's fallbacks (2.0 m
  draft, 4.0 m beam) keep the depth and air-draft constraints doing their job.
  `PUT /vessel`, where an admin writes the server-wide defaults by hand, still
  answers 400 — as does an unusable `minCoastDistance`.
- Fixed: the "Consider tide" panel — including the "Best…" departure-planner
  button — could be missing from the webapp entirely, while working fine in the
  Freeboard-SK plotter extension for the same boat. The webapp checked tide
  availability against the map's hardcoded placeholder center (`[45.5, -1.0]`)
  at connect time, racing the vessel's actual position, which only arrives once
  `fetchBoatData()`'s request resolves and re-centers the map moments later. If
  the placeholder location happened to have no tide coverage, the whole panel
  stayed hidden and was never re-checked. It now re-checks against the vessel's
  real position as soon as that arrives. The plotter extension was unaffected —
  it awaits the real position before its first check.
- Fixed: a route being planned somewhere the boat isn't (a different cruising
  ground entirely) kept the tide panel keyed to the vessel's position even
  after routing elsewhere, so a route with tide coverage along it could still
  show the panel hidden. Every (re)route now also re-checks tide availability
  against the route's own midpoint, throttled to at most once per 5 nm of
  movement so dragging a waypoint doesn't spam the check.
- Changed: a release now chooses its npm dist-tag based on what is already
  published. While no stable version exists, a pre-release publishes as `latest`,
  so `npm install signalk-routeiq` and the Signal K App Store resolve to the
  current build rather than to whichever version happened to be tagged first.
  Once a stable version ships, pre-releases publish under their own channel
  (`alpha`) and leave `latest` on the stable build. The `alpha` tag stops
  advancing while `latest` is carrying pre-releases, because a publish can set
  only one tag and npm's trusted publishing cannot authenticate a tag change
  afterwards. For the same reason, a release whose registry check cannot be
  answered — an outage, a 5xx, a response that isn't a package document — now
  fails without publishing instead of guessing a tag it would be unable to move.
  Applies from the next release; `latest` for 0.1.0-alpha.3 was set by hand.

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
