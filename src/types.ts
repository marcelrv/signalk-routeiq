/**
 * Type definitions for the SignalK Autoroute Plugin
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
  isFairway: boolean;
  directionPenalty: number;
  distanceToLand: number; // meters
  isOneWay?: boolean;
  trafficDir?: number; // 1 = with edge direction (source→target), -1 = against
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
      isFairway?: boolean;
      directionPenalty?: number;
      isOneWay?: boolean;
      trafficDir?: number;
      edgeType?: string;
      segments?: Array<{
        from: number; // node id
        to: number; // node id
        distance: number; // meters
        minDepth: number; // meters
        maxAirDraft: number; // meters
        isFairway: boolean;
        directionPenalty: number;
        isOneWay?: boolean;
        trafficDir?: number;
        edgeType?: string;
      }>;
      crossings?: RouteCrossing[];
    };
  }>;
}

// POI search result
export interface PoiResult {
  id: number;
  name: string;
  type: string;
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
  fairwayMultiplier: number;
  openWaterMultiplier: number;
  wrongWayPenalty: number;
  routingBBoxMargin: number;        // degrees, default 0.1 (~11km)
  routingBBoxMaxExtent: number;     // degrees, default 10.0
  lineOfSightSampleInterval: number; // meters, default 500
  lineOfSightSearchRadius: number;   // meters, default 800
  averageSpeedKnots: number;        // knots, default 6.0
}

// Default plugin configuration
export const DEFAULT_CONFIG: PluginConfig = {
  routingDataDir: './data/',
  safetyMarginDraft: 0.3,
  safetyMarginAirDraft: 1.5,
  safetyMarginBeam: 2.0,
  defaultCoastDistance: 0.5,
  fairwayMultiplier: 0.8,
  openWaterMultiplier: 1.2,
  wrongWayPenalty: 5.0,
  routingBBoxMargin: 0.1,
  routingBBoxMaxExtent: 10.0,
  lineOfSightSampleInterval: 500,
  lineOfSightSearchRadius: 800,
  averageSpeedKnots: 6.0,
};
