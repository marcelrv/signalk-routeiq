/**
 * Type definitions for the SignalK Autoroute Nautical Route Planner Plugin
 */

// Vessel dimensions from SignalK delta tree
export interface VesselDimensions {
  draft?: number;
  beam?: number;
  airDraft?: number;
}

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
  }>;
  minCoastDistance?: number; // NM from shore
  draft?: number; // Override vessel draft
  beam?: number; // Override vessel beam
  airDraft?: number; // Override vessel air draft
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
  type: 'bridge' | 'lock';
  name: string;
  subtype?: string; // 'opening' or 'fixed' for bridges
  height?: number;  // vertical clearance (m) for fixed bridges
  position: { latitude: number; longitude: number };
  distanceFromStart?: number; // meters along the route (chainage)
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
  kind: 'start' | 'turn' | 'via' | 'end';
  latitude: number;
  longitude: number;
  distanceFromStart: number; // meters along the route
  courseToNext?: number;     // degrees true, chord course to the next itinerary point
  turn?: number;             // signed course change at this point (deg, + = starboard)
  viaIndex?: number;         // 0-based index of the matching request via point
  leg?: {
    distance: number;        // meters, sum of graph edges to the next itinerary point
    minDepth?: number;       // m, only when known (>= 0 in the graph)
    minWidth?: number;       // m
    maxAirDraft?: number;    // m
    crossings?: RouteCrossing[]; // bridges/locks on this leg, in route order
  };
}

// Route result
export interface RouteWarning {
  type: 'start_unreachable' | 'end_unreachable' | 'both_unreachable' | 'via_constrained' | 'via_skipped' | 'bbox_expanded' | 'start_connecting' | 'end_connecting';
  message: string;
  from?: { latitude: number; longitude: number };
  to?: { latitude: number; longitude: number };
  distanceMeters?: number;
}

export interface RouteResult {
  type: 'FeatureCollection';
  warnings?: RouteWarning[];
  totalDistance?: number;
  totalCost?: number;
  crossings?: RouteCrossing[];
  waypoints?: RouteWaypoint[];
  itinerary?: ItineraryPoint[];
  features: Array<{
    type: 'Feature';
    geometry: {
      type: 'LineString';
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
      }>;
    };
  }>;
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
  routingDataDir: string;
  safetyMarginDraft: number;     // meters, added to design draft
  safetyMarginAirDraft: number;  // meters, added to design air draft
  safetyMarginBeam: number;      // meters, added to design beam
  defaultCoastDistance: number;
  wrongWayPenalty: number;
  routingBBoxMargin: number;        // degrees, default 1.0 (~111km)
  routingBBoxMaxExtent: number;     // degrees, default 10.0
  lineOfSightSampleInterval: number; // meters, default 500
  lineOfSightSearchRadius: number; // meters, default 800
  averageSpeedKnots: number;        // knots, default 6.0
  waypointTolerance: number;        // meters, max deviation when simplifying to waypoints (default 30)
  catalogUrl: string;               // URL to the index.json catalog for downloadable databases
}

// Default plugin configuration
export const DEFAULT_CONFIG: PluginConfig = {
  routingDataDir: './data/',
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
  waypointTolerance: 30,
  catalogUrl: 'https://raw.githubusercontent.com/marcelrv/signalk-router-data/main/index.json',
};
