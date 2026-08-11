# TODO — Feature Planning (routeiq plugin)

Last reviewed 2026-07-13. This file used to mix plugin-side ideas with
routing-database/pipeline design and had drifted far out of date — several
items below had already shipped. It's been pruned to what's actually still
open for **this repo** (the Signal K plugin + webapp). Cross-repo pipeline
work now lives in `signalk-router-pipeline/NEXT_PHASES.md`,
`PHASE_3_DESIGN.md`, `PHASE_4_DESIGN.md`, and the old routing-DB brainstorm
ideas that used to be at the bottom of this file have moved to
[`signalk-router-pipeline/LEGACY_IDEAS.md`](../signalk-router-pipeline/LEGACY_IDEAS.md)
for evaluation (still worth doing vs. superseded by what shipped since).

## Shipped since this file was last accurate

Kept as one-line pointers only — see git history / source for detail:

- **Tidal current in routing cost + departure time selection** — `src/tides.ts`
  (`FlowField`/`TidesClient`/`CurrentsClient`), time-dependent `astarSearch` in
  `src/routing.ts`, `POST /route/departures` departure-scan endpoint, webapp +
  plotter-panel departure planner UI. Design doc: `feature-tidal-routing.md`.
  Real current stations now come from the sibling `signalk-tidal-currents`
  plugin; height-gradient estimate remains the fallback.
- **Manual routing (mixed auto/manual segments)** — `LegMode`
  (`'auto' | 'manual'`) in `src/types.ts`, `buildManualLeg` in `src/routing.ts`,
  per-via `mode` toggle in the webapp toolbar.
- **Left-click-to-route / right-click-context-menu swap** — `map.on('click', …)`
  places start/dest/via in `public/index.html`; `contextmenu` opens the marker
  menu.
- **Undo/redo stack** for waypoint edits — toolbar buttons + Ctrl+Z/Ctrl+Y in
  `public/index.html`.
- **GRIB current overlay** on the map (gridded field, distinct from harmonic
  station markers) — `public/index.html`.
- **"Manage Routing Data" download UI** for `.sqlite` database files —
  `GET/POST /databases*` endpoints + modal in `public/index.html`.
- **Segments vs. itinerary confusion** — resolved by the `src/itinerary.ts`
  redesign: server computes both a simplified `waypoints` polyline and a
  human-readable `itinerary` (chainage/course/aggregates per leg) as the single
  source of truth, so frontends stay dumb. See the module doc-comment there.

---

## Open — Routing features

### 1. ~~Tide-Informed Depth Calculation in Routing~~ — DONE 2026-08-11
Shipped on branch `feat/tide-aware-depth`. Design and decisions:
`feature-tidal-routing.md`, "Tide-aware depth". The original note follows.

The one thing that changed from the plan below: the rise is measured from the
fetched window's own low water, not from LAT, because nothing here can verify
what datum signalk-tides' `level` uses and assuming would overstate the water
by half the tidal range in the direction that runs a boat aground. Also note
the framing in the last sentence is half wrong — a charted depth is *already*
the low-water case, so there is no "vice versa" to catch: this can only ever
open water up, which is why every safeguard points the same way.

Chart depths are referenced to LAT; actual depth = charted depth + tide
height above LAT at the time the vessel is there. Currently only *speed*
(tidal current) is tide-aware — *depth* constraints still use the static
charted `min_depth` only, so a route that's genuinely safe at high tide may
be rejected, and vice versa isn't caught either.

- Reuse the existing `FlowField`/tide-height infrastructure in `src/tides.ts`
  (station timelines are already fetched) rather than building a second data
  path.
- Only needs a tide-height *lookup*, not the current/direction math — simpler
  than the current feature was.
- Per edge: `effective_depth = charted_min_depth + tideHeightAt(midpoint, estimatedArrivalTime)`;
  discard if `effective_depth < vessel.draft + safety_margin`.
- Skip the lookup entirely when `charted_min_depth` already clears
  `draft + margin + max_local_tidal_range` — most edges, most of the time.
- Noted as a "Later" phase in `feature-tidal-routing.md` — this supersedes
  that phasing note; do the design there before starting.

### 2. Weather Routing & Sailing Polar Diagrams
Sailing boats' speed depends on true wind speed/angle (polar table), not a
constant `nominal_speed`. Not started — `grep -ri polar src/` turns up
nothing yet.

- `FlowField` in `src/tides.ts` was explicitly designed as "wind-ready" — a
  wind provider would implement the same `sample(lat, lon, t) → {u, v}`
  shape; the speed model composes (STW from polar lookup, then + current →
  SOG), matching the phasing note already in `feature-tidal-routing.md`.
- Needs: wind data source (forecast GRIB via `resources/weather/*` or
  similar), a polar table format + UI editor, TWA/TWS lookup per edge,
  reefing/ghosting-speed edge cases for out-of-range wind, non-sailing
  vessel fallback (ignore polar, keep tidal current).
- Do this after item 1, since both hang off the same time-dependent A*
  machinery and it's worth designing them together rather than threading
  the arrival-time/lookup plumbing twice.

### 3. Bridge & Lock Waiting Times
Every opening bridge/lock crossing is currently assumed instant. Not just
an ETA nicety — every downstream tidal current/depth sample after an
unmodeled delay is computed at the wrong clock time, so this quietly
degrades items 1 and the existing tide-aware routing the more bridges/
locks a route crosses. Full design: `feature-bridge-lock-waits.md`.

- ~~**Tier 1**~~ — **done.** `lockWaitMinutes`/`bridgeWaitMinutes` (60/30) are
  counted per crossing into the ETA only, never into the routing cost, and a
  per-POI `typical_wait_minutes` overrides them when a database supplies one.
  Originally described as: a flat config-constant
  wait added to `edgeSeconds`/ETA propagation only — reuses the
  `tSec`/`env` time-tracking `feature-tidal-routing.md` already added to
  `astarSearch`, provably doesn't change route choice.
- **Tier 2**: schedule-aware minimum wait, once real opening-hours data
  exists (pipeline/schema side — `signalk-router-pipeline/PHASE_4_DESIGN.md`
  §4c; this is a natural first real use case for the community override
  workflow in that repo's §3c).
- **Tier 3**: fold wait cost into `effDistance` so a long-expected wait can
  lose to a longer route around it, car-navigator-traffic-jam style. Has a
  real correctness precondition (the wait function must be FIFO) that
  needs checking against real schedule data before enabling — see the
  design doc.

---

## Open — Webapp UX

None of these are started (`makeSimpleInstructions` in `public/index.html`
is still a two-line stub — "Start"/"Destination" only, no bearing-based
turn text).

- **Elevation/Depth route profile graph** — chart `min_depth`/`max_air_draft`
  over cumulative distance below the map, with the vessel's draft/air-draft
  as threshold lines, so shallow spots and low bridges are visible at a
  glance.
- **Dynamic isochrones (reachability polygons)** — Dijkstra from the vessel's
  position out to a time budget, returned as a GeoJSON polygon boundary.
- **Custom avoidance / no-go zones** — user-drawn polygons passed to
  `/route`, applied as a heavy penalty or hard exclusion on intersecting
  edges.
- **Turn-by-turn marine instructions** — replace the `makeSimpleInstructions`
  stub with real bearing-delta turn text ("Turn Starboard heading 145°") and
  fairway-entry callouts.
- **Energy/fuel consumption estimate** — capacity + consumption-rate vessel
  settings, warn in `route-warnings` if a route exceeds range.
- **Marine night mode** — dark/red-tinted theme + basemap for night-vision
  preservation.
- **Wind overlay** — the GRIB *current* overlay already ships; a wind
  particle/vector overlay (e.g. Leaflet-Velocity) alongside it does not.
- ~~Left-click vs. right-click placement~~ — **resolved, not a bug: confirmed
  intentional, no code change.** Re-checked `public/index.html`: the
  coexistence is deliberate design, not leftover legacy code. The commit
  that added the right-click menu (`8663300`, "UI overhaul with hybrid
  auto/manual routing…") documents it explicitly in its own message —
  "Standard map conventions: left-drag pans, left-click places waypoints
  …, right-click opens a context menu" — and the code has matching
  in-place documentation: the comment at `map.on('contextmenu', ...)`
  (~line 2044, "Standard map conventions: left-drag pans … left-click
  places waypoints … right-click opens the context menu") and the
  user-facing hint text (~line 1316/2166, "Tap map: 1st=Start, 2nd=Dest,
  3rd+=Via · right-click for menu"). Left-click is the fast/default path,
  right-click is the precise/power-user path (also reachable on markers
  themselves for remove/toggle-mode/clear). Nothing to change here.
- **Real bug found while investigating the above, fixed**: in edit mode,
  selecting a node/edge that the drawn route visually overlapped was
  impossible — `renderCustomRoute()` (`public/index.html`) always calls
  `state.routeLayers.bringToFront()`, and the route line's own click
  handler unconditionally calls `stopPropagation()`, so the click never
  reached the edge/node underneath (regardless of via-insertion logic).
  Verified with a live DOM-stack inspection before/after. Fix: after
  `bringToFront()`, if `state.editMode`, bring `edgesLayer`/`graphLayer`
  back above the route so they stay clickable and visible while editing.
  Left-click-to-place and click-on-route-to-add-via are unaffected.
- ~~Edge debug overlay colors by `edge_type_id` only (coastal vs.
  inland), not `edge_kind_id`~~ — **done, and later simplified to one
  control.** First pass added a separate "Color edges by kind" toggle;
  per follow-up feedback, folded into the single existing "Graph edges"
  toggle instead — three independent visual channels are now always on
  whenever edges are shown, no mode switch to remember:
  - **color** = `edge_kind_id`: green=centerline, amber=navmesh_boundary,
    violet=lane, pink=macro.
  - **dash** = `edge_type_id`: coastal long-dot-long (`16,6,4,6`), inland
    solid. (First pass used `10,3,2,3` at the original 0.35 opacity —
    verified via pixel-level checks against a live render that this was
    genuinely invisible, not just subtle: short dash segments blur out
    completely at low alpha/weight 3. Bumped both the dash unit sizes and
    opacity until confirmed visible at actual render settings, not just
    checking the DOM attribute was present.)
  - **opacity** = `traffic_mode`: one-way edges bolder (0.85) than
    two-way (0.6) — also raised from the first pass (0.65/0.35) since the
    baseline needed to be visible enough for the dash to read at all.
  Required exposing `edge_kind_id` through
  `RoutingDatabase.getEdgesInBBox()` (`src/database.ts`), which the
  `/graph/edges` API didn't return before. Verified live: navmesh
  boundary rings now render clearly distinct (amber) from skeleton
  centerlines (green), instead of two near-identical greens, with the
  coastal/inland and one-way distinctions still visible via dash/opacity.

## Open — smaller/unscoped notes

These were one-line ideas without a design behind them; worth a proper look
before adding to the lists above, or dropping if no longer relevant:

- POI search: better result ranking/selection, more compact result list.
- Plugin config: candidate for simplification — re-review which settings in
  the table in `README.md` actually need to be user-facing vs. could be
  fixed/auto-detected.
- ~~**Position/route-aware dynamic database loading**~~ — **shipped.**
  `RoutingDatabase.init()` peeks rather than opening every `.sqlite`, with
  route- and position-triggered loads and an LRU cap. One piece of §4a is
  still open: a route that triggers a load still blocks for the length of it
  (the client now says which region, and waits rather than failing, but the
  request stays open). Scoped and deliberately deferred — see "Non-blocking
  `202` for route requests that trigger a load" in `ROUTEIQ_NEXT_PHASES.md`,
  which places it behind item 1 above.
