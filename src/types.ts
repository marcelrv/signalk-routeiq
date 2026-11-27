/**
 * Type definitions for the SignalK RouteIQ Nautical Route Planner Plugin
 */

import * as v8 from "node:v8";

/** Edge columns the graph editor can set, and therefore the ones a user-edits
 *  overlay row can claim in `edited_fields`. Everything else on such a row is
 *  a placeholder written for a value the edit never mentioned, which is why
 *  the distinction has to be recorded rather than inferred from the values.
 *
 *  Lives here because both sides of the worker boundary need the same list —
 *  db-worker.ts writes it when an edge is drawn, database.ts stamps the
 *  matching in-memory row — and this module imports nothing, so the worker
 *  can take it without dragging anything else across. */
export const OVERLAY_EDITABLE_COLUMNS = [
  "cost_factor",
  "distance",
  "max_air_draft",
  "min_depth",
  "min_width",
  "traffic_mode",
];

export type {
  VesselDimensions,
  LegMode,
  RoutingRequest,
  RouteInputs,
  EdgeAttributes,
  SearchNode,
  RouteCrossing,
  RouteWaypoint,
  ItineraryPoint,
  WarnLevel,
  RouteLocation,
  WarningBase,
  LegWarning,
  RouteDescriptionWarning,
  RouteDescriptionLeg,
  RouteWaterPart,
  RouteWarning,
  RouteResult,
  DepartureScanStep,
  PoiResult,
  BBox,
} from "routeiq-core";

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
  routingBBoxMargin: number; // degrees, default 1.0 (~111km) — internal search tuning, not in the settings schema
  routingBBoxMaxExtent: number; // degrees, default 10.0 — internal, not in the settings schema
  // How much longer a fully-compliant route may be before the search stops
  // preferring it over a shorter one that carries constraint violations. 0
  // disables the bound (the old behaviour: fewer violating meters always won,
  // which answered an 18km request with a 242km route). Violations on the kept
  // route are still reported as warnings.
  maxPenaltyDetourRatio: number;
  // How long the straight line joining a start/destination to the charted
  // graph may be before it is called a coverage gap rather than an ordinary
  // connection. That leg is never routed and never depth-checked, so a long
  // one means the vessel is being asked to cross water the data does not
  // describe — most often a hole between two regional databases, where the
  // route is projected onto a waterway on the *far* side of the gap and joined
  // with a straight line. Measured separation on the US East Coast builds:
  // healthy connectors 4-893 m, gaps 3,485-4,597 m, so the default sits in the
  // empty band between them and needs no tuning per deployment. Internal, like
  // routingBBoxMargin — deliberately not in the settings schema. 0 disables.
  coverageGapMeters: number; // meters, default 1500 — internal, not user-facing
  lineOfSightSearchRadius: number; // meters, default 0 (smoothing off) — internal
  averageSpeedKnots: number; // knots, default 5.0
  // Typical wait at an opening span or a lock, in minutes. Applied to the ETA
  // only — never to the routing cost — so it cannot change which way a route
  // goes, only how long it is expected to take. A fixed bridge is either
  // passable or it is not, so it carries no wait.
  lockWaitMinutes: number; // minutes, default 60
  bridgeWaitMinutes: number; // minutes, default 30 (opening spans only)
  waypointTolerance: number; // meters, max deviation when simplifying to waypoints (default 30) — internal
  catalogUrl: string; // URL to the routing-index.json catalog for downloadable databases
  considerTides: boolean; // default for the per-request "use tides" toggle
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
  // §4a trigger 1 (internal): when dynamicLoading is on, subscribe to navigation.position
  // and eager-load the region under the vessel at startup + on movement, so a
  // positioned vessel boots with its local region loaded instead of an empty
  // graph. Default on; opt out to keep loading purely route-triggered.
  eagerLoadAtPosition: boolean;
  // Internal. Proactive load band (nautical miles) around the vessel position — a region
  // within this distance of the vessel loads before it actually crosses in.
  // 0 = containment only (load only the region the vessel is inside).
  loadRadiusNm: number;
  // §4a M5 (internal): bounded working-set for dynamic loading. 0 = unlimited (keep
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
  // Sibling cap to maxLoadedRegions, weighted by size instead of count. A
  // region's memory footprint varies ~100x (a small Zeeland-scale file vs.
  // a 260k-edge US-coast state tile), so a handful of large regions can
  // still exceed a count-based cap. 0 = unlimited, same convention as
  // maxLoadedRegions.
  //
  // Enforced two ways: ensureRegionsForBbox (the *discretionary* transit/
  // widening load, not the mandatory waypoint-containment one) skips
  // loading a region that would push total loaded edges past this, and
  // enforceRegionCapPass evicts LRU regions past it once no route is in
  // flight — same two mechanisms maxLoadedRegions already uses, just also
  // triggered by size. Added 2026-08-19 after a route whose bounding-box
  // widening (111km -> 888km chasing a via-point constraint violation)
  // loaded three large US East Coast regions at once and crashed the
  // server with a V8 heap OOM; maxLoadedRegions=6 never triggered because
  // six *regions* of that size is still too much memory, and eviction
  // cannot run mid-request regardless (never evicts out from under an
  // in-progress search — see activeRouteCount).
  maxLoadedRegionEdges: number;
}

// Order-of-magnitude heuristic, not a measured constant: how many loaded
// graph edges (with their share of associated node/POI/navmesh overhead) a
// device can safely hold per MB of V8 heap ceiling, deliberately
// conservative. Calibrated against the 2026-08-19 incident: three real US
// East Coast regions (~600k+ combined edges, before counting whatever else
// was already resident) crashed a ~4.1 GB heap, so this is chosen to land
// well under that on a heap of the same size, not to maximize how much a
// single request can load.
const EDGES_PER_MB_OF_HEAP = 120;

/** Heap-size-aware default for maxLoadedRegionEdges, computed once from
 *  *this* process's actual V8 heap ceiling (v8.getHeapStatistics --
 *  respects --max-old-space-size if set, otherwise V8's own default,
 *  itself informed by host memory) rather than a fixed number, so a
 *  Raspberry Pi and a beefy server each get a cap sized to what they can
 *  actually hold without hand-tuning. A deployment that wants a different
 *  number can still set maxLoadedRegionEdges explicitly in plugin config. */
function defaultMaxLoadedRegionEdges(): number {
  const heapLimitMb = v8.getHeapStatistics().heap_size_limit / (1024 * 1024);
  return Math.floor(heapLimitMb * EDGES_PER_MB_OF_HEAP);
}

// Default plugin configuration
export const DEFAULT_CONFIG: PluginConfig = {
  routingDataDir: "",
  safetyMarginDraft: 0.3,
  safetyMarginAirDraft: 1.5,
  safetyMarginBeam: 2.0,
  routingBBoxMargin: 1.0,
  routingBBoxMaxExtent: 10.0,
  maxPenaltyDetourRatio: 3.0,
  coverageGapMeters: 1500,
  lineOfSightSearchRadius: 0,
  averageSpeedKnots: 5.0,
  lockWaitMinutes: 60,
  bridgeWaitMinutes: 30,
  waypointTolerance: 30,
  catalogUrl:
    "https://raw.githubusercontent.com/marcelrv/signalk-router-data/main/routing-index.json",
  considerTides: false,
  dynamicLoading: true,
  eagerLoadAtPosition: true,
  loadRadiusNm: 0,
  maxLoadedRegions: 6,
  maxLoadedRegionEdges: defaultMaxLoadedRegionEdges(),
};

/** Keys that are no longer user settings. start() deletes them from the saved
 *  plugin config before merging it with DEFAULT_CONFIG, so a value saved back
 *  when the field was on the settings page can never override the current
 *  default. The ones still in PluginConfig are internal tuning with a fixed
 *  default; the others are gone altogether. */
export const RETIRED_CONFIG_KEYS: readonly string[] = [
  // internal search tuning, off the settings page since 2026-07-18
  "routingBBoxMargin",
  "routingBBoxMaxExtent",
  // retired 2026-11-16: nothing read these
  "wrongWayPenalty",
  "lineOfSightSampleInterval",
  // retired 2026-11-16: a no-op on factory databases (no distance_to_land)
  "defaultCoastDistance",
  // retired 2026-11-16: the tide plugins are reached in-process or on this
  // server's own address (src/server-access.ts)
  "tidesApiBase",
  // retired 2026-11-16: only scaled the height-derived current estimate,
  // which is gone (currents come from current stations only)
  "maxTidalCurrentKnots",
  // internal tuning since 2026-11-16
  "lineOfSightSearchRadius",
  "waypointTolerance",
  "eagerLoadAtPosition",
  "loadRadiusNm",
  "maxLoadedRegions",
];
