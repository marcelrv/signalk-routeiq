# Feature: Tide-aware routing

Make the route calculation consider tidal currents when the user desires so:
tide-dependent speed/cost per edge, per-leg current display, departure time
selection, and a departure planner that scans 24 h for the best start time.

## Status (2026-07-16)

Phases 1-3 (backend core, webapp UI, plotter panel) are shipped and match
this spec. Since the original write-up, a companion plugin
(`signalk-tidal-currents`) was built and now supplies real harmonic current
stations — see "signalk-tidal-currents plugin" below, which supersedes the
"Recommendation: separate plugin" section as the as-built description.
Phasing item 4 (ENC/RWS providers, wind, tide-aware depth constraints,
`environment.current` calibration) and item 5 (stations baked into the
routing DB) remain open — no code for either exists yet.

## Data source investigation (2026-07-02)

- **[signalk-tides](https://github.com/bkeepers/signalk-tides)** (installed):
  offline harmonic **tide-height** predictions via Neaps/TICON-4.
  - `GET /signalk/v2/api/tides/stations?latitude=&longitude=` — 10 nearest
    stations with `distance` (km), harmonic metadata.
  - `GET /signalk/v2/api/tides/stations/{id}/timeline?start=&end=` (ISO,
    URL-encoded) — height series at a fixed 10-minute interval.
  - `GET .../extremes` — HW/LW list.
  - **It provides heights only — no tidal currents (set/drift).**
- **ENC map data**: S-57 defines tidal-stream objects (`TS_FEB` flood/ebb
  vectors, `TS_PAD` 13-hour panel data keyed to a reference-station HW).
  The ENC cells available to the pipeline do not contain these layers, so
  this is a *future* provider, not v1.
- **Other SK plugins**: none found that predict currents. `environment.current`
  is measured (live) set/drift only — usable for calibration later, not
  for prediction along a route.

**Decision:** v1 derives an *estimated* tidal current from the height
stations, behind a pluggable provider interface so better sources (ENC
TS_PAD, RWS stroomatlas, GRIB/CMEMS currents, NOAA currents) and **wind**
can be added without touching the routing engine again.

## v1 current model (height-derived, clearly labeled "estimated")

For a sample point (lat, lon, t):

1. **Phase / magnitude** — at the nearest station compute `dh/dt` from the
   prefetched timeline and normalize by that station's max `|dh/dt|` over the
   window → phase factor in [-1, 1]. Current speed = `maxTidalCurrentKnots ×
   phase` (config, default 2.0 kn ≈ typical Dutch delta springs).
2. **Direction** — water flows down the surface gradient: fit a plane through
   the heights of the nearby stations (≤ 6 within 60 km, least squares);
   flow direction = −∇h. With < 3 usable stations the direction is
   indeterminate → current treated as **zero** (conservative fallback).
3. The resulting (u, v) vector is projected on each edge's bearing during the
   search — only the along-track component changes speed (no leeway model).

Known limitation: this is a first-order estimate (standing-wave phase lag,
local channel effects and eddies are not modeled). The UI labels all values
"estimated tidal current". The provider interface is the upgrade path.

## Architecture

### `src/tides.ts`
- `TidesClient` — talks to the signalk-tides REST API (base URL from config,
  default same server). Caches station lists and timelines (TTL) so a 24 h
  departure scan reuses one set of fetches.
- `FlowField` interface — **the wind-ready abstraction**, as shipped:
  ```ts
  interface FlowField {
    sample(lat, lon, timeMs): { u, v }        // m/s east/north, synchronous & cheap
    readonly maxSpeedMs: number               // bound for A* admissibility
    readonly stations: TideStationInfo[]      // for the tide{stations} result field
    readonly estimated: boolean               // model estimate vs. real station data
    readonly source: 'stations' | 'height-estimate'
  }
  ```
  `stations`/`estimated`/`source` were added beyond the original sketch so
  `finalizeRoute` can report provenance without a second lookup. A future
  wind provider implements the same shape; the speed model composes (v1:
  SOG = STW + along-track water flow; later: + wind polar).
- `prepareTidalFlowField(points, startMs, endMs, maxCurrentKnots)` — fetch
  height stations + timelines for the request's anchor points up front;
  `sample()` then runs in-memory (called in the A* inner loop). Returns a
  `HeightGradientFlowField` (the height-derived model below).
- `CurrentsClient` + `prepareStationFlowField(...)` — **shipped, not in the
  original sketch.** Talks to the sibling `signalk-tidal-currents` plugin's
  `/signalk/v2/api/currents` API for real harmonic current stations (see
  "signalk-tidal-currents plugin" below) and builds a `StationFlowField`:
  nearest vector-capable station within 20 km, linear time interpolation,
  falling back to the height-gradient field (`HeightGradientFlowField`)
  outside that range or when no stations cover the route. `prepareEnv` in
  `routing.ts` prefers the station-backed field over the height estimate
  whenever one is available for the request.

### Routing engine (`src/routing.ts`)
- `RoutingRequest` gains `departureTime?` (ISO, default now) and `useTides?`
  (default = config `considerTides`).
- A `RouteEnv { flow, departureMs, offsetSec, speedMs }` is threaded through
  `astarSearch` / via / fallback paths (no shared engine state → concurrent
  requests stay safe). `offsetSec` (not in the original sketch) carries the
  elapsed time of prior legs into each via-point sub-search, so a multi-leg
  route samples the flow field at each leg's actual passage time rather than
  resetting the clock to departure at every via point.
- **Cost stays distance-scaled** for compatibility: each edge uses
  `effectiveDistance = distance × STW / SOG` where
  `SOG = clamp(STW + alongTrackCurrent, 0.2×STW, ∞)`; existing cost factors
  and penalties apply unchanged. With tides off, SOG = STW and results are
  bit-identical to today.
- Arrival **time is tracked per node** (`t = Σ distance/SOG`) and used to
  sample the flow field — the route is time-dependent, so it can genuinely
  pick a different channel when the tide favors it.
- Heuristic stays admissible: `h = remainingDist × minMultiplier ×
  STW / (STW + flow.maxSpeedMs)`.
- Result additions: per-segment `seconds`, `currentKn` (signed, + = fair),
  `sogKn`; route-level `departureTime`, `arrivalTime`, `totalSeconds`,
  `totalSecondsNoTide`, `tide { enabled, estimated, source, stations }` (the
  `source` field — `'stations' | 'height-estimate'` — was added beyond the
  original sketch, see `FlowField` above). Itinerary legs aggregate `seconds`
  and distance-weighted `currentKn`.
- `scanDepartures(request, hours, stepMinutes)` — full re-route per step
  (routes may differ per tide), cheap because station/timeline fetches are
  cached across steps.

### API (`src/api.ts`)
- `POST /route` — accepts `departureTime`, `useTides`.
- `GET /tides/status` — availability probe (plugin reachable + stations near
  the loaded region); UIs show tide controls only when available.
- `POST /route/departures` — `{ ...routeRequest, scanHours=24, stepMinutes=60 }`
  → `{ departures: [{ departureTime, totalSeconds, totalSecondsNoTide, error? }] }`.
  As-built, each entry omits `arrivalTime`/`totalDistance` (originally
  sketched above) — the planner UI only needs the two second counts to build
  the ramp and doesn't currently ask for the rest. Add them if a consumer
  needs them; cheap since `calculateRoute` already computes both internally.

### Config (`src/index.ts` schema)
- `considerTides` (bool, default false) — default for the per-request toggle.
- `maxTidalCurrentKnots` (number, default 2.0) — spring-current calibration.
- `tidesApiBase` (string, default `http://localhost:3000`) — base URL for
  signalk-tides. As-built, this same value also doubles as the base URL for
  the `signalk-tidal-currents` plugin's `CurrentsClient` (no separate
  `currentsApiBase` key) — fine as long as both plugins run on the same
  Signal K server, which is the only deployment in practice.

### UIs (webapp `public/index.html` + plotter `plotterext/panel.js`)
Kept visually consistent between both:
- "Consider tide" toggle + departure time picker (`datetime-local`, default
  now) — only rendered when `/tides/status` reports available.
- Summary line: total time **with** tide + delta vs. no-tide
  (e.g. `6:40 (+0:25 tide)`), arrival clock time.
- Expanded leg details: estimated current (`+0.8 kn` fair / `−1.2 kn` foul)
  and tide-corrected leg time.
- **Departure planner**: button opens a 24 h view; each slot shows departure
  time + total duration, colored on a shared green→red HSL ramp normalized
  between the fastest and slowest slot; clicking a slot sets the departure
  time and recalculates. Webapp = modal with horizontal bar strip; panel =
  compact vertical list with the same color coding.
- **Webapp-only, not in the original sketch**: live current/tide station
  markers with tooltips, a GRIB current-grid map overlay
  (`/signalk/v2/api/currents/grid` on the sibling plugin), and a time
  scrubber for stepping the overlay through the tide cycle
  (`public/index.html`, station/grid layer code). Built to visualize
  `signalk-tidal-currents`' station and GRIB data directly on the chart; the
  plotter panel stays compact and doesn't carry this.

## Phasing

1. **Backend core** — tides client, flow field, time-dependent A*, API,
   config. **Shipped.**
2. **Webapp UI** — toggle, departure time, totals/legs, planner modal.
   **Shipped**, plus the station-marker/GRIB-grid/scrubber overlay described
   above (not originally planned for this phase).
3. **Plotter panel** — same features, compact layout. **Shipped.**
4. **Later — still open**, except GRIB currents (see note): ENC `TS_PAD`/RWS
   current providers; wind provider (same `FlowField` interface) with
   polar-based STW; tide-height-aware depth constraints (open shallow edges
   near HW — heights are exact, unlike currents); calibration against
   measured `environment.current`. None of these have code in `src/` — only
   an aspirational comment in `tides.ts` naming them as future `FlowField`
   implementers. GRIB currents are the exception: they arrived, but as GRIB2
   support *inside* `signalk-tidal-currents` (served over the same
   `/currents` REST API `StationFlowField` already consumes) rather than as
   a new `FlowField` class in routeiq — no engine change was needed.

### OpenCPN tide-file investigation (2026-07-02)

OpenCPN reads two formats (reference impl: `gui/src/tcds_ascii_harmonic.cpp`
and `tcds_binary_harmonic.cpp` in the OpenCPN repo, GPLv2 — reimplement,
don't copy):

- **Legacy ASCII `HARMONIC` + `HARMONIC.IDX`** — IDX lines typed
  `T/t/C/c` (tide/current, reference/subordinate). Current references carry
  harmonic constituents **in knots** (signed speed along the channel axis) in
  the self-contained HARMONIC file (constituent speeds + yearly node
  factors/equilibrium args included); subordinate `^` lines carry flood/ebb
  time offsets, multipliers and **flood/ebb directions** — everything a
  set/drift vector needs. Straightforward to parse.
- **XTide `.tcd`** (libtcd) — bit-packed binary; public-domain format with a
  spec, but **no maintained JS or pure-Python decoder exists** (the PyPI
  `libtcd` is a ctypes wrapper; decoding was only possible after compiling
  the C library). Supporting it means porting libtcd's unpacking (~days).

**Coverage measured (decoded the actual files):**
- OpenCPN-shipped `harmonics-dwf-*-free.tcd`: 4 593 current stations — all
  Americas/NOAA, **zero in Europe**.
- OpenCPN-shipped `ticon-europe-global.tcd`: heights only (same TICON data
  signalk-tides uses), zero currents.
- OpenCPN-shipped `HARMONICS_NO_US(.IDX)`: no current stations at all.
- **User-supplied `data/HARMONICS_V10` bundle (French community data, "non
  issues du SHOM")**: 726 height + **149 current stations in W-Europe, 48 in
  the NL box** — dense Waddenzee coverage (Borndiep, Vliestroom, Doove Balg,
  …), Dutch subordinates referencing e.g. "Harlingen, Courants"
  (M2 0.83 kn) with per-station flood/ebb directions. **Genuinely usable to
  replace the height-gradient estimate in our waters.**

**Recommendation (2026-07-02): separate plugin** (`signalk-tidal-currents`),
mirroring signalk-tides: config points at a tcdata dir; parses ASCII
HARMONIC/IDX first (covers NL via the V10 bundle), TCD later (US data);
publishes `environment.current` predictions plus a REST API (station search
by position, set/drift timeline). RouteIQ then adds a thin `StationFlowField`
provider that prefers real current stations within range and falls back to
the height-gradient estimate elsewhere — the `FlowField` interface needs no
change. Label data provenance in the UI (community data, not official).

### `signalk-tidal-currents` plugin — as-built (2026-07-16)

The plugin shipped and substantially exceeds the recommendation above:

- **ASCII HARMONIC/IDX parsing** — shipped as planned (`src/harmonics.ts`),
  covers NL via the V10 bundle.
- **UTCEF format** — a modern JSON/GeoJSON harmonic-current format, not in
  the original plan at all (`src/utcef.ts`). Used to carry **2,544 US
  current stations converted from NOAA CO-OPS's official harmonic
  constituents**, validated against NOAA's own published predictions —
  Americas/NOAA coverage the ASCII-format-only plan didn't reach.
- **GRIB2 current grids** — also not in the original plan (`src/grib2.ts`,
  `src/gribcurrents.ts`); source priority resolves `grib2 → utcef →
  harmonic`.
- **Tidal Currents Manager** — a companion catalog/auto-download webapp
  (`catalog.ts`, `manifest.ts`, `autoUpdate.ts`, `downloads.ts`) for
  fetching and managing the above data files. A whole feature area not
  anticipated here.
- **REST API** (`/signalk/v2/api/currents`) — station search, timeline, plus
  `/vector` and `/grid` (GRIB) endpoints beyond the planned
  station-search-and-timeline pair. `environment.current` deltas are
  published as planned.
- **Still open, as this plan anticipated**: XTide `.tcd`/libtcd binary
  decoding (no maintained JS/pure-Python decoder exists; needs a port of
  libtcd's unpacking). M1/OO1 harmonic constituents are also deliberately
  still excluded (the NOS standard set's remaining pair).
- **Not done anywhere**: culling against FES or dropping RTOFS as a data
  source were not found described in this plugin's current docs/changelog —
  if those decisions were made, they predate what's captured here.

## Optional accuracy upgrade — stations baked into the routing DB (open)

v1 assigns stations at runtime by straight-line proximity, which can pick a
station across a peninsula whose tide differs completely. The pipeline
can precompute the correct station per graph region (Voronoi by *water*
distance over the graph) into a `tide_stations` table
(`station_id, name, lat, lon, area_geojson` + optional `nodes.tide_station`
column). The `FlowField` provider then prefers the DB mapping and falls
back to runtime proximity for databases without it. **Not implemented** —
no `tide_stations`/`area_geojson`/`nodes.tide_station` references exist in
either `signalk-routeiq/src/database.ts` or the `signalk-tidal-currents`
plugin.
