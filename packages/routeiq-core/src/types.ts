/**
 * Engine, request and result types shared by the routing engine and its clients.
 */

// Vessel dimensions from SignalK delta tree
export interface VesselDimensions {
  draft?: number;
  beam?: number;
  airDraft?: number;
}

// How a leg (the segment ARRIVING at a waypoint) is routed:
// 'auto'   — A* graph search (default)
// 'manual' — straight rhumb line drawn by the user, bypassing the graph
export type LegMode = "auto" | "manual";

// Routing parameters from user request
export interface RoutingRequest {
  start: {
    latitude: number;
    longitude: number;
  };
  end: {
    latitude: number;
    longitude: number;
  };
  via?: Array<{
    latitude: number;
    longitude: number;
    mode?: LegMode; // mode of the leg from the previous point to this one
  }>;
  endMode?: LegMode; // mode of the final leg (last via, or start) → end
  minCoastDistance?: number; // NM from shore
  draft?: number; // Override vessel draft
  beam?: number; // Override vessel beam
  airDraft?: number; // Override vessel air draft
  departureTime?: string; // ISO 8601; default now. Only meaningful with tides.
  useTides?: boolean; // Override the engine's default (EngineOptions.defaultUseTides)
  // Average speed through the water, knots. Default EngineOptions.defaultSpeedKnots.
  speedKnots?: number;
  // Safety margins added to the vessel dimensions, metres. Default
  // EngineOptions.defaultSafetyMargin*M.
  safetyMarginDraft?: number;
  safetyMarginBeam?: number;
  safetyMarginAirDraft?: number;
  // Override the configured waits for this request. Local knowledge beats a
  // default: a lock that always has a chamber ready is not an hour.
  lockWaitMinutes?: number;
  bridgeWaitMinutes?: number;
  // BCP-47 language for water names in the route description ("de-CH" falls
  // back to "de", then to the database's default name).
  lang?: string;
  // Set false to skip the route description. The departure scan does, because
  // it only needs the times and nobody reads a description for each step.
  describe?: boolean;
}

/**
 * The inputs a route was actually calculated with: the request's values where
 * it gave them, the engine's defaults for the rest. Echoed on every successful
 * result (`RouteResult.inputs`) so a client can see what the numbers rest on
 * without knowing the engine's configuration. Distances in metres, speed in
 * knots, waits in minutes.
 */
export interface RouteInputs {
  draft: number;
  beam: number;
  airDraft: number;
  /** Speed through the water, knots (never below 0.5). */
  speedKnots: number;
  safetyMarginDraft: number;
  safetyMarginBeam: number;
  safetyMarginAirDraft: number;
  /** ISO 8601 instant the request asked for; null when it gave none (the
   *  tide calculations then start at the time of the request, which the
   *  result's own `departureTime` reports). */
  departureTime: string | null;
  useTides: boolean;
  lockWaitMinutes: number;
  bridgeWaitMinutes: number;
  /** Nautical miles of coast clearance asked for; 0 = none. */
  minCoastDistance: number;
  /** Language the route description was requested in; null when none. */
  lang: string | null;
  describe: boolean;
  /** Version of the routing core that produced the result. */
  coreVersion: string;
  /** Provenance hints for the routing data in memory when the route was
   *  calculated: one entry per loaded region file, sorted by filename. Set on
   *  a calculated route only (a request validator has no data to report).
   *  Hints, not proof: equal entries do not guarantee identical content. */
  data?: DataVersionEntry[];
}

/** A provenance hint for one routing data file: its name and the date its
 *  metadata carries, plus a build id only when the data carries one. It says
 *  where a result's data came from, not that two files with the same entry
 *  hold the same content. */
export interface DataVersionEntry {
  /** Plain `<name>.sqlite` identity of the file. */
  filename: string;
  /** `metadata.last_update_date`; null when the file has none. */
  lastUpdateDate: string | null;
  /** A build id, only when the file's metadata carries one. */
  buildId?: string;
}

// Edge attributes from routing database
export interface EdgeAttributes {
  distance: number; // meters
  minDepth: number; // meters
  maxAirDraft: number; // meters
  minWidth: number; // meters
  costFactor: number; // routing cost multiplier: 0.8=fairway (preferred), 1.2=open water, higher=penalized
  distanceToLand: number; // meters
  trafficMode: number; // 0=two-way, 1=one-way fwd, 2=one-way rev
  edgeTypeId: number; // 0=coastal, 1=inland
}

// A* search node
export interface SearchNode {
  id: number;
  g: number; // cost from start
  h: number; // heuristic cost to end
  f: number; // total cost
  parent: SearchNode | null;
}

// Crossing annotation (bridge or lock encountered on the route)
export interface RouteCrossing {
  type: "bridge" | "lock";
  name: string;
  subtype?: string; // 'opening' or 'fixed' for bridges
  height?: number; // vertical clearance (m) for fixed bridges
  // Bridge crossings: the structure kind (`info.kind` of the span, else of its
  // bridge whole): "bridge", "cable" (overhead power line), "weir", ... Absent
  // when the database does not say; clients take absent as a bridge.
  kind?: string;
  // The source has no usable height: `height`, if set, is an estimate.
  heightUnknown?: boolean;
  // Closed vertical clearance of an opening span, m; wait decision only. Not
  // an air-draft limit: an opening span still opens for a taller vessel.
  closedHeight?: number;
  // Set when this opening span is low enough to pass without it opening, so
  // it charges no wait; `note` says why, so the skipped wait stays visible.
  passesClosed?: boolean;
  note?: string;
  // The wait actually charged here, in seconds — set on the crossing that owns
  // an obstacle group, and left off the ones it absorbs, so the numbers add up
  // exactly once. Distinct from waitMinutes below, which is an input.
  waitSeconds?: number;
  // Per-POI wait, overriding the config default. Populated by detectRouteStructures
  // from the POI's `typical_wait_minutes` property, for both bridges and locks,
  // on databases that carry one.
  waitMinutes?: number;
  position: { latitude: number; longitude: number };
  distanceFromStart?: number; // meters along the route (chainage)
  /**
   * For a lock the route's own edges place it inside: the chainage range it
   * spends there, start to end. A lock is a stretch of waterway, not a point,
   * and the spans carried over its heads sit at the far end of that stretch —
   * so this is what says a bridge belongs to the lock. Only pipeline-built
   * databases mark the edges this can be derived from.
   */
  lockSpan?: [number, number];
  /**
   * The id of the whole (lock or bridge) the crossing belongs to, as a string:
   * entries with the same value are one physical structure. An opaque string,
   * compared only for equality. A part with no loaded whole is its own
   * structure and carries its own id.
   */
  structure?: string;
  /**
   * Which pass through the structure this is: 0, 1, ... in route order, per
   * type and `structure`. One pass is one run of consecutive route edges
   * linked to the structure (nearby runs merge); a pass after the route turned
   * back, or beyond the merge distance, is the next index. Clients key a row
   * on type + structure + passage; absent (older server) reads as one pass.
   */
  passage?: number;
  /** The chamber or span the route uses (a part of the structure). */
  partId?: number;
}

// A point of the simplified, navigable route geometry (Douglas-Peucker with
// bounded deviation from the computed path) — suitable as route waypoints in
// a chartplotter / autopilot.
export interface RouteWaypoint {
  latitude: number;
  longitude: number;
  // Which request point this waypoint is: the start, the end, or a via
  // (`viaIndex` into the request's `via`). Absent on the waypoints in between.
  // A via is always kept as a waypoint by the simplification.
  kind?: "start" | "via" | "end";
  viaIndex?: number;
}

// An entry of the human-readable route itinerary: start/end, via points and
// major course changes, with aggregates for the leg to the next entry.
export interface ItineraryPoint {
  kind: "start" | "turn" | "via" | "end";
  latitude: number;
  longitude: number;
  distanceFromStart: number; // meters along the route
  // Index of this point among the route's vertices. Feature k of the result
  // runs from vertex k to vertex k+1, so this point starts feature
  // `coordIndex` (the end point: features.length), and a leg covers features
  // coordIndex .. next.coordIndex - 1. Lets a client tie the itinerary to the
  // geometry without matching positions itself.
  coordIndex: number;
  courseToNext?: number; // degrees true, chord course to the next itinerary point
  turn?: number; // signed course change at this point (deg, + = starboard)
  viaIndex?: number; // 0-based index of the matching request via point
  // Start and end only: what to call this end when the client has no name of
  // its own for it. The nearest named harbour, lock or bridge within
  // ENDPOINT_POI_RADIUS_M ("poi"), else the named water the route starts or
  // ends in ("water"). Absent when neither is known.
  name?: string;
  nameSource?: "poi" | "water";
  leg?: {
    distance: number; // meters, sum of graph edges to the next itinerary point
    minDepth?: number; // m, only when known (>= 0 in the graph)
    minDepthAtPassage?: number; // m, charted + tide, when a tide source covered it
    minWidth?: number; // m
    maxAirDraft?: number; // m
    seconds?: number; // tide-corrected sailing time for this leg, waits included
    waitSeconds?: number; // of `seconds`, time held at locks / opening spans
    currentKn?: number; // distance-weighted mean along-track current (+ = fair)
    crossings?: RouteCrossing[]; // bridges/locks on this leg, in route order
    // The named waters this leg runs through, in route order, with the part of
    // the leg that lies in each. Only waters that have a name or a warning.
    waters?: RouteWaterPart[];
    // Where the leg is tight for this vessel, worst first. Absent when none.
    warnings?: LegWarning[];
  };
}

// How much a warning matters, decided here so every client shows the same:
// danger = do not go unless you know better, caution = check before you go,
// info = worth knowing. Clients render it as sent and never re-derive it.
export type WarnLevel = "danger" | "caution" | "info";

// Where on the route a warning applies, so a client can show it on the map
// without working anything out from the geometry. Route vertices
// coordIndex..toCoordIndex, numbered like ItineraryPoint.coordIndex (feature k
// runs from vertex k to k+1). A point (a bridge, lock or other POI) has
// coordIndex === toCoordIndex and a position.
export interface RouteLocation {
  coordIndex: number;
  toCoordIndex: number;
  distanceFromStart: number; // meters along the route
  distance: number; // meters, 0 for a point
  bounds: [number, number, number, number]; // [west, south, east, north]
  position?: { latitude: number; longitude: number }; // points only
}

// What every leg warning has, whatever its type. A client can show any
// warning, and link it to the map through `at`, without knowing the type.
export interface WarningBase {
  level: WarnLevel;
  message: string; // English
  at?: RouteLocation[]; // in route order; absent when the server cannot tell
}

// A leg too tight for the vessel the route was planned for. The numbers
// (meters) let a client word it itself.
export type LegWarning =
  | (WarningBase & {
      type: "shallow";
      minDepth: number; // charted
      minDepthAtPassage?: number; // charted + tide, when the tide added some
      requiredDepth: number; // draft + safetyMarginDraft
    })
  | (WarningBase & {
      type: "narrow";
      minWidth: number;
      beam: number;
      requiredWidth: number; // beam + safetyMarginBeam
    })
  | (WarningBase & {
      type: "low_clearance";
      maxAirDraft: number; // lowest charted clearance on the leg
      requiredAirDraft: number; // airDraft + safetyMarginAirDraft
    });

// A warning on a stretch of the route, from the routing database's metadata.
// The structured fields let a client word it itself.
export type RouteDescriptionWarning =
  | (WarningBase & { type: "depth_quality"; quality: string })
  | (WarningBase & { type: "origin"; origin: string })
  | (WarningBase & {
      type: "notice";
      severity: number; // 0 info, 1 caution, 2 depth, 3 prohibited
      text: string;
      name?: string;
    });

// One stretch of the route inside one water (consecutive stretches of the same
// water are merged). Display only: never a routing cost.
export interface RouteDescriptionLeg {
  distanceFromStart: number; // meters along the route
  distance: number; // meters
  waterBodyId?: number;
  name?: string; // in the requested language, else the database's default name
  kind?: string; // canal, river, lake, channel, sea_area, harbour, estuary, other
  warnings: RouteDescriptionWarning[];
}

export interface RouteWaterPart {
  name?: string;
  kind?: string;
  distance: number; // meters of the itinerary leg that lie in this water
  warnings: RouteDescriptionWarning[];
}

// Route result
export interface RouteWarning {
  type:
    | "start_unreachable"
    | "end_unreachable"
    | "both_unreachable"
    | "via_constrained"
    | "via_skipped"
    | "bbox_expanded"
    | "start_connecting"
    | "end_connecting"
    // A start_connecting/end_connecting leg long enough to be a hole in the
    // routing data rather than the last few metres to the quay. The leg is a
    // straight line carrying minDepth -1, so it is excluded from every
    // constraint check — reported separately because clients (this repo's own
    // webapp included) hide the ordinary connecting warnings as noise, which
    // is right for 45 m and badly wrong for 4 km. See coverageGapMeters.
    | "coverage_gap"
    | "manual_segment"
    // A supplied draft/beam/airDraft was unusable and was dropped; the route
    // was planned against the server's configured dimensions instead.
    | "vessel_dimension_ignored"
    // The route was found but the water names and warnings could not be read.
    | "description_unavailable";
  message: string;
  from?: { latitude: number; longitude: number };
  to?: { latitude: number; longitude: number };
  distanceMeters?: number;
}

export interface RouteResult {
  type: "FeatureCollection";
  /** The effective inputs this route was calculated with (see RouteInputs). */
  inputs?: RouteInputs;
  warnings?: RouteWarning[];
  totalDistance?: number;
  totalCost?: number;
  totalSeconds?: number; // sailing time at averageSpeedKnots, tide-corrected when tide info present
  totalWaitSeconds?: number; // of totalSeconds, the part spent waiting at locks and opening spans
  totalSecondsNoTide?: number; // same route without current — UIs show the delta
  departureTime?: string; // ISO, echoed/defaulted from the request when tides active
  arrivalTime?: string; // ISO, departure + totalSeconds
  // When the times above were worked out, and from what. The route goes back
  // to the server on Save to Signal K long after the request is gone, so the
  // saved passage profile (passage-profile.ts) reads its assumptions here.
  calculatedAt?: string; // ISO
  timingAssumptions?: {
    averageSpeedKnots: number; // speed through the water used for every leg
    lockWaitMinutes: number; // default wait per lock (a POI may carry its own)
    bridgeWaitMinutes: number; // default wait per opening span (likewise)
  };
  tide?: {
    enabled: boolean;
    estimated: boolean; // true = model/community-data predictions, not measurements
    source?: "stations" | "heights"; // current stations, or tide heights only (depth, no current)
    stations: string[]; // station names used for the flow field
    // True when the tide was counted towards depth somewhere on this route —
    // see the segment-level minDepthAtPassage.
    depthAware?: boolean;
  };
  crossings?: RouteCrossing[];
  waypoints?: RouteWaypoint[];
  itinerary?: ItineraryPoint[];
  // Where the route runs, by water: absent when no loaded database carries the
  // water-body tables (older databases) or no edge of the route is in one.
  description?: RouteDescriptionLeg[];
  features: Array<{
    type: "Feature";
    geometry: {
      type: "LineString";
      coordinates: Array<[number, number]>; // [lon, lat]
    };
    properties: {
      totalDistance?: number; // meters (only on first feature in single-feature mode)
      totalCost?: number;
      distance?: number; // segment distance (only per-segment features)
      minDepth?: number; // meters (only per-segment features)
      // Whether minDepth is a real reading rather than "no data" -- see
      // segments[].minDepthKnown below. splitToSegmentFeatures copies it up
      // onto each finalized per-feature properties object (only per-segment
      // features, same as minDepth itself).
      minDepthKnown?: boolean;
      minDepthAtPassage?: number; // meters, charted + tide risen by then
      tideRiseM?: number; // meters of tide included in minDepthAtPassage
      maxAirDraft?: number; // meters (only per-segment features)
      costFactor?: number;
      trafficMode?: number;
      edgeTypeId?: number;
      mode?: "manual"; // present on user-drawn straight-line segments
      segments?: Array<{
        from: number; // node id
        to: number; // node id
        distance: number; // meters
        // Graph nodes from..to inclusive when this segment aggregates several
        // edges (collinear compression, line-of-sight). Internal: read by the
        // route description, never sent to clients.
        nodes?: number[];
        minDepth: number; // meters
        // Whether minDepth is a real reading (possibly negative -- a charted
        // drying height, on schema_version >= 2) rather than "no data" (manual/
        // connector legs, or an edge whose source file predates the depth
        // sentinel fix). Every depth constraint check must gate on this
        // instead of `minDepth < 0` / `>= 0` (ROUTEIQ_NEXT_PHASES.md,
        // "Negative charted depths are read as unknown"). Required, not
        // optional, so every segment-construction site has to set it.
        minDepthKnown: boolean;
        maxAirDraft: number; // meters
        minWidth?: number; // meters
        costFactor: number;
        trafficMode: number;
        edgeTypeId?: number;
        // Locks this segment passes through, from the `edge_pois` rows of the
        // edges it covers (the lock whole of each chamber, or of a span carried
        // over a lock head). Empty or absent means none is known, not that
        // there is no lock.
        lockIds?: number[];
        mode?: "manual"; // user-drawn straight-line segment (bypasses the graph)
        seconds?: number; // traversal time, tide-corrected when tides active
        currentKn?: number; // estimated along-track current, + = fair (with tide)
        sogKn?: number; // speed over ground used for this segment
        // Depth at the time this segment is actually crossed: `minDepth` (which
        // stays the charted, LAT-referenced figure) plus the tide risen by
        // then. Present only where a tide source covered the segment and the
        // rise was worth something, so its absence means "charted only", never
        // "no tide". `tideRiseM` is the difference, broken out so a UI can say
        // where the extra water came from.
        minDepthAtPassage?: number; // meters
        tideRiseM?: number; // meters
        // Set where the router had to draw this leg across dry land, which is
        // also why minDepth reads 0 there. Distinguishes that from a charted
        // drying height of 0, which the two would otherwise look identical as.
        crossesLand?: boolean;
      }>;
    };
  }>;
}

// One departure of a departure scan. `index` is the step's position in the
// scan window, counted from the requested departure time — a streamed scan
// arrives coarse-to-fine rather than chronologically, so the index is what
// places a result in the window.
export interface DepartureScanStep {
  index: number;
  departureTime: string;
  totalSeconds?: number;
  totalSecondsNoTide?: number;
  arrivalTime?: string;
  totalDistance?: number;
  error?: string;
}

// POI search result
export interface PoiResult {
  id: number;
  name: string;
  typeId: number;
  /** Routing facts only (spec §2.10.1). */
  properties: Record<string, unknown>;
  /** Display facts (spec §2.10.2): height, kind, refs, sources, ... */
  info: Record<string, unknown>;
  /** The whole a part belongs to; absent on wholes and harbours. */
  parentId?: number | null;
  latitude: number;
  longitude: number;
  distance?: number; // meters from search point
}

// Bounding box for spatial filtering
export interface BBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** Who produced a passage profile or GPX file; supplied by the caller so the
 *  engine never reads a package.json. */
export interface ProviderInfo {
  name: string;
  version: string;
  /** Human-readable product name for descriptions; `name` when absent. */
  displayName?: string;
}
