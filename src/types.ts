/**
 * Type definitions for the SignalK RouteIQ Nautical Route Planner Plugin
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
  useTides?: boolean; // Override config.considerTides for this request
  // Override the configured waits for this request. Local knowledge beats a
  // default: a lock that always has a chamber ready is not an hour.
  lockWaitMinutes?: number;
  bridgeWaitMinutes?: number;
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
  // The wait actually charged here, in seconds — set on the crossing that owns
  // an obstacle group, and left off the ones it absorbs, so the numbers add up
  // exactly once. Distinct from waitMinutes below, which is an input.
  waitSeconds?: number;
  // Per-POI wait, overriding the config default. Populated by detectCrossings
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
}

// A point of the simplified, navigable route geometry (Douglas-Peucker with
// bounded deviation from the computed path) — suitable as route waypoints in
// a chartplotter / autopilot.
export interface RouteWaypoint {
  latitude: number;
  longitude: number;
}

// An entry of the human-readable route itinerary: start/end, via points and
// major course changes, with aggregates for the leg to the next entry.
export interface ItineraryPoint {
  kind: "start" | "turn" | "via" | "end";
  latitude: number;
  longitude: number;
  distanceFromStart: number; // meters along the route
  courseToNext?: number; // degrees true, chord course to the next itinerary point
  turn?: number; // signed course change at this point (deg, + = starboard)
  viaIndex?: number; // 0-based index of the matching request via point
  leg?: {
    distance: number; // meters, sum of graph edges to the next itinerary point
    minDepth?: number; // m, only when known (>= 0 in the graph)
    minWidth?: number; // m
    maxAirDraft?: number; // m
    seconds?: number; // tide-corrected sailing time for this leg, waits included
    waitSeconds?: number; // of `seconds`, time held at locks / opening spans
    currentKn?: number; // distance-weighted mean along-track current (+ = fair)
    crossings?: RouteCrossing[]; // bridges/locks on this leg, in route order
  };
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
    | "manual_segment"
    // A supplied draft/beam/airDraft was unusable and was dropped; the route
    // was planned against the server's configured dimensions instead.
    | "vessel_dimension_ignored";
  message: string;
  from?: { latitude: number; longitude: number };
  to?: { latitude: number; longitude: number };
  distanceMeters?: number;
}

export interface RouteResult {
  type: "FeatureCollection";
  warnings?: RouteWarning[];
  totalDistance?: number;
  totalCost?: number;
  totalSeconds?: number; // sailing time at averageSpeedKnots, tide-corrected when tide info present
  totalWaitSeconds?: number; // of totalSeconds, the part spent waiting at locks and opening spans
  totalSecondsNoTide?: number; // same route without current — UIs show the delta
  departureTime?: string; // ISO, echoed/defaulted from the request when tides active
  arrivalTime?: string; // ISO, departure + totalSeconds
  tide?: {
    enabled: boolean;
    estimated: boolean; // true = model/community-data predictions, not measurements
    source?: "stations" | "height-estimate"; // real current stations vs height-derived estimate
    stations: string[]; // station names used for the flow field
  };
  crossings?: RouteCrossing[];
  waypoints?: RouteWaypoint[];
  itinerary?: ItineraryPoint[];
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
      maxAirDraft?: number; // meters (only per-segment features)
      costFactor?: number;
      trafficMode?: number;
      edgeTypeId?: number;
      mode?: "manual"; // present on user-drawn straight-line segments
      segments?: Array<{
        from: number; // node id
        to: number; // node id
        distance: number; // meters
        minDepth: number; // meters
        maxAirDraft: number; // meters
        minWidth?: number; // meters
        costFactor: number;
        trafficMode: number;
        edgeTypeId?: number;
        // Locks this segment passes through, on databases that record it per
        // edge. Empty or absent means the database does not say, not that there
        // is no lock.
        lockIds?: number[];
        mode?: "manual"; // user-drawn straight-line segment (bypasses the graph)
        seconds?: number; // traversal time, tide-corrected when tides active
        currentKn?: number; // estimated along-track current, + = fair (with tide)
        sogKn?: number; // speed over ground used for this segment
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
  properties: Record<string, unknown>;
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

// Plugin configuration
export interface PluginConfig {
  // Empty means "not configured": index.ts then falls back to the plugin's own
  // Signal K data directory (<config>/plugin-config-data/signalk-routeiq/routing-data).
  // A relative path is resolved against the plugin install directory, which is
  // what the pre-2026-07-25 './data/' default did — that put downloaded
  // routing databases under node_modules/signalk-routeiq, where npm discards
  // them on the next plugin update.
  routingDataDir: string;
  safetyMarginDraft: number; // meters, added to design draft
  safetyMarginAirDraft: number; // meters, added to design air draft
  safetyMarginBeam: number; // meters, added to design beam
  defaultCoastDistance: number;
  wrongWayPenalty: number;
  routingBBoxMargin: number; // degrees, default 1.0 (~111km) — internal search tuning, not in the settings schema
  routingBBoxMaxExtent: number; // degrees, default 10.0 — internal, not in the settings schema
  lineOfSightSampleInterval: number; // meters, default 500
  lineOfSightSearchRadius: number; // meters, default 800
  averageSpeedKnots: number; // knots, default 6.0
  // Typical wait at an opening span or a lock, in minutes. Applied to the ETA
  // only — never to the routing cost — so it cannot change which way a route
  // goes, only how long it is expected to take. A fixed bridge is either
  // passable or it is not, so it carries no wait.
  lockWaitMinutes: number; // minutes, default 60
  bridgeWaitMinutes: number; // minutes, default 30 (opening spans only)
  waypointTolerance: number; // meters, max deviation when simplifying to waypoints (default 30)
  catalogUrl: string; // URL to the routing-index.json catalog for downloadable databases
  considerTides: boolean; // default for the per-request "use tides" toggle
  maxTidalCurrentKnots: number; // spring-current calibration for the estimated flow model
  tidesApiBase: string; // base URL of the server hosting signalk-tides
  // §4a: when true (default since 2026-07-20), startup only peeks each
  // file's metadata/coverage (cheap), and individual databases load into
  // memory on demand — the first time a route request needs them, or via
  // the /databases/load|unload control endpoints. When false,
  // routingDataDir's .sqlite files are all opened and loaded up front at
  // startup. Default flipped from false to true after loading multiple
  // real US East Coast region files (~527MB combined) unconditionally
  // crashed the dev SignalK server with a V8 heap OOM — the original
  // false default assumed every deployment had exactly one region file,
  // which stopped being true once per-region publishing started. See
  // PHASE_4_DESIGN.md §4a and NEXT_PHASES.md's 2026-07-20 entry.
  dynamicLoading: boolean;
  // §4a trigger 1: when dynamicLoading is on, subscribe to navigation.position
  // and eager-load the region under the vessel at startup + on movement, so a
  // positioned vessel boots with its local region loaded instead of an empty
  // graph. Default on; opt out to keep loading purely route-triggered.
  eagerLoadAtPosition: boolean;
  // Proactive load band (nautical miles) around the vessel position — a region
  // within this distance of the vessel loads before it actually crosses in.
  // 0 = containment only (load only the region the vessel is inside).
  loadRadiusNm: number;
  // §4a M5: bounded working-set for dynamic loading. 0 = unlimited (keep
  // every region a route/position has loaded). >0 = keep at most N regions
  // loaded, evicting the least-recently-used region(s) beyond that once no
  // route is in flight. Only takes effect with dynamicLoading on.
  //
  // Defaults to a finite cap because the graph lives in the main thread's V8
  // heap (RoutingDatabase.edgesBySource, one object per directed edge): a
  // regional file runs 60k–270k edges, so an unbounded working set grows into
  // the hundreds of MB on a long passage and GC-thrashes a Pi. Six regions is
  // a wide corridor — eviction only happens between routes, and an evicted
  // region reloads on demand.
  maxLoadedRegions: number;
}

// Default plugin configuration
export const DEFAULT_CONFIG: PluginConfig = {
  routingDataDir: "",
  safetyMarginDraft: 0.3,
  safetyMarginAirDraft: 1.5,
  safetyMarginBeam: 2.0,
  defaultCoastDistance: 0.5,
  wrongWayPenalty: 5.0,
  routingBBoxMargin: 1.0,
  routingBBoxMaxExtent: 10.0,
  lineOfSightSampleInterval: 500,
  lineOfSightSearchRadius: 0,
  averageSpeedKnots: 6.0,
  lockWaitMinutes: 60,
  bridgeWaitMinutes: 30,
  waypointTolerance: 30,
  catalogUrl:
    "https://raw.githubusercontent.com/marcelrv/signalk-router-data/main/routing-index.json",
  considerTides: false,
  maxTidalCurrentKnots: 2.0,
  tidesApiBase: "http://localhost:3000",
  dynamicLoading: true,
  eagerLoadAtPosition: true,
  loadRadiusNm: 0,
  maxLoadedRegions: 6,
};
