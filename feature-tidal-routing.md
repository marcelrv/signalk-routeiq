# Feature: Tide-aware routing

Make the route calculation consider tidal currents when the user desires so:
tide-dependent speed/cost per edge, per-leg current display, departure time
selection, and a departure planner that scans 24 h for the best start time.

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

### `src/tides.ts` (new)
- `TidesClient` — talks to the signalk-tides REST API (base URL from config,
  default same server). Caches station lists and timelines (TTL) so a 24 h
  departure scan reuses one set of fetches.
- `FlowField` interface — **the wind-ready abstraction**:
  ```ts
  interface FlowField {
    sample(lat, lon, timeMs): { u, v }   // m/s east/north, synchronous & cheap
    maxSpeedMs: number                    // bound for A* admissibility
  }
  ```
  A future wind provider implements the same shape; the speed model
  composes (v1: SOG = STW + along-track water flow; later: + wind polar).
- `prepareTidalFlowField(bbox, timeWindow)` — fetch stations + timelines up
  front; `sample()` then runs in-memory (called in the A* inner loop).

### Routing engine (`src/routing.ts`)
- `RoutingRequest` gains `departureTime?` (ISO, default now) and `useTides?`
  (default = config `considerTides`).
- A `RouteEnv { flow, departureMs, speedMs }` is threaded through
  `astarSearch` / via / fallback paths (no shared engine state → concurrent
  requests stay safe).
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
  `totalSecondsNoTide`, `tide { enabled, estimated, stations }`. Itinerary
  legs aggregate `seconds` and distance-weighted `currentKn`.
- `scanDepartures(request, hours, stepMinutes)` — full re-route per step
  (routes may differ per tide), cheap because station/timeline fetches are
  cached across steps.

### API (`src/api.ts`)
- `POST /route` — accepts `departureTime`, `useTides`.
- `GET /tides/status` — availability probe (plugin reachable + stations near
  the loaded region); UIs show tide controls only when available.
- `POST /route/departures` — `{ ...routeRequest, scanHours=24, stepMinutes=60 }`
  → `{ departures: [{ departureTime, totalSeconds, arrivalTime, totalDistance }] }`.

### Config (`src/index.ts` schema)
- `considerTides` (bool, default false) — default for the per-request toggle.
- `maxTidalCurrentKnots` (number, default 2.0) — spring-current calibration.
- `tidesApiBase` (string, default `http://localhost:3000`) — where
  signalk-tides lives.

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

## Phasing

1. **Backend core** — tides client, flow field, time-dependent A*, API,
   config (this change).
2. **Webapp UI** — toggle, departure time, totals/legs, planner modal.
3. **Plotter panel** — same features, compact layout.
4. **Later** — ENC `TS_PAD`/RWS/NOAA/GRIB current providers; wind provider
   (same `FlowField` interface) with polar-based STW; tide-height-aware
   depth constraints (open shallow edges near HW — heights are exact, unlike
   currents); calibration against measured `environment.current`.

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

**Recommendation: separate plugin** (`signalk-tidal-currents`), mirroring
signalk-tides: config points at a tcdata dir; parses ASCII HARMONIC/IDX
first (covers NL via the V10 bundle), TCD later (US data); publishes
`environment.current` predictions plus a REST API (station search by
position, set/drift timeline). RouteIQ then adds a thin `StationFlowField`
provider that prefers real current stations within range and falls back to
the height-gradient estimate elsewhere — the `FlowField` interface needs no
change. Label data provenance in the UI (community data, not official).
5. **Optional accuracy upgrade — stations baked into the routing DB**: v1
   assigns stations at runtime by straight-line proximity, which can pick a
   station across a peninsula whose tide differs completely. The pipeline
   can precompute the correct station per graph region (Voronoi by *water*
   distance over the graph) into a `tide_stations` table
   (`station_id, name, lat, lon, area_geojson` + optional `nodes.tide_station`
   column). The `FlowField` provider then prefers the DB mapping and falls
   back to runtime proximity for databases without it.
