/**
 * A* Pathfinding Engine for Nautical Routing
 * Implements vessel-aware directed A* with multi-layered cost function
 */

import { EdgeRow, RoutingDatabase } from './database.js';
import {
    BBox,
    PluginConfig,
    RouteResult,
    RouteWarning,
    RoutingRequest,
    VesselDimensions,
} from './types.js';

function isInsideBBox(lat: number, lon: number, bbox: BBox): boolean {
  return lat >= bbox.minLat && lat <= bbox.maxLat &&
         lon >= bbox.minLon && lon <= bbox.maxLon;
}

function bboxFromPoints(
  start: { latitude: number; longitude: number },
  end: { latitude: number; longitude: number },
  marginDeg: number,
): BBox {
  return {
    minLat: Math.min(start.latitude, end.latitude) - marginDeg,
    maxLat: Math.max(start.latitude, end.latitude) + marginDeg,
    minLon: Math.min(start.longitude, end.longitude) - marginDeg,
    maxLon: Math.max(start.longitude, end.longitude) + marginDeg,
  };
}

// A* search state
interface SearchState {
  nodeId: number;
  g: number; // actual cost from start
  f: number; // estimated total cost (g + h)
  parent: number | null;
}

// Priority queue for A* (min-heap)
class MinHeap<T> {
  private data: T[] = [];
  private score: (item: T) => number;

  constructor(score: (item: T) => number) {
    this.score = score;
  }

  push(item: T): void {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const bottom = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = bottom;
      this.sinkDown(0);
    }
    return top;
  }

  get size(): number {
    return this.data.length;
  }

  isEmpty(): boolean {
    return this.data.length === 0;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.score(this.data[index]) >= this.score(this.data[parentIndex])) break;
      [this.data[index], this.data[parentIndex]] = [this.data[parentIndex], this.data[index]];
      index = parentIndex;
    }
  }

  private sinkDown(index: number): void {
    const length = this.data.length;
    for (;;) {
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      let smallest = index;

      if (left < length && this.score(this.data[left]) < this.score(this.data[smallest])) {
        smallest = left;
      }
      if (right < length && this.score(this.data[right]) < this.score(this.data[smallest])) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.data[index], this.data[smallest]] = [this.data[smallest], this.data[index]];
      index = smallest;
    }
  }
}

export class RoutingEngine {
  private db: RoutingDatabase;
  private config: PluginConfig;
  private vesselDimensions: VesselDimensions;

  constructor(db: RoutingDatabase, config: PluginConfig, vesselDimensions?: VesselDimensions) {
    this.db = db;
    this.config = config;
    this.vesselDimensions = vesselDimensions || {
      draft: config.defaultDraft,
      beam: config.defaultBeam,
      airDraft: config.defaultAirDraft,
    };
  }

  /**
   * Update vessel dimensions
   */
  setVesselDimensions(dimensions: VesselDimensions): void {
    this.vesselDimensions = { ...this.vesselDimensions, ...dimensions };
  }

  /**
   * Calculate a route using directed A* algorithm with bounding-box pruning.
   * Falls back to partial routing when the route cannot be completed
   * (disconnected components or unreachable due to constraints),
   * returning warnings for teleported segments.
   *
   * The bounding box starts tight around start+end (plus margin) and expands
   * on failure, so short routes are very fast.
   */
  async calculateRoute(request: RoutingRequest): Promise<RouteResult> {
    const { start, end, via = [], minCoastDistance, draft, beam, airDraft } = request;
    const effectiveCoastDistance = minCoastDistance ?? this.config.defaultCoastDistance;

    // Apply per-request vessel dimension overrides (do not mutate engine state)
    const savedDims = { ...this.vesselDimensions };
    if (draft !== undefined || beam !== undefined || airDraft !== undefined) {
      this.vesselDimensions = {
        ...this.vesselDimensions,
        ...(draft !== undefined && { draft }),
        ...(beam !== undefined && { beam }),
        ...(airDraft !== undefined && { airDraft }),
      };
    }

    try {
      const coastDistanceMeters = effectiveCoastDistance * 1852;

      // Find nearest graph nodes to start/end
      const startNode = await this.db.findNearestNode(start.latitude, start.longitude);
      const endNode = await this.db.findNearestNode(end.latitude, end.longitude);

      if (!startNode) throw new Error(`No routing nodes found near start point`);
      if (!endNode) throw new Error(`No routing nodes found near end point`);

      // Build bounding box with initial margin, try A* with expansion on failure
      const bboxWarnings: RouteWarning[] = [];

      if (via.length > 0) {
        return await this.routeViaPoints(start, end, via, coastDistanceMeters, bboxWarnings);
      }
      // Fall through for non-via routes (bbox search below)

      // Try A* with expanding bounding box
      let currentMargin = this.config.routingBBoxMargin;
      const maxMargin = this.config.routingBBoxMaxExtent;

      while (currentMargin <= maxMargin) {
        const bbox = bboxFromPoints(start, end, currentMargin);

        try {
          const result = await this.astarSearch(
            start.latitude, start.longitude,
            end.latitude, end.longitude,
            coastDistanceMeters,
            bbox,
          );

          // Connect user's start/end to the route coordinates
          await this.connectUserPoint(start, result, 'start');
          await this.connectUserPoint(end, result, 'end');

          // Attach any expansion warnings
          if (bboxWarnings.length > 0) {
            result.warnings = [...(result.warnings || []), ...bboxWarnings];
          }
          return result;
        } catch {
          // Expand bounding box and retry
          if (currentMargin < maxMargin) {
            const newMargin = Math.min(currentMargin * 2, maxMargin);
            if (newMargin > currentMargin) {
              bboxWarnings.push({
                type: 'via_constrained',
                message: `Route search expanded from ${(currentMargin * 111).toFixed(0)}km to ${(newMargin * 111).toFixed(0)}km bounding box to find a path.`,
                from: { latitude: start.latitude, longitude: start.longitude },
                to: { latitude: end.latitude, longitude: end.longitude },
              });
            }
            currentMargin = newMargin;
          } else {
            break;
          }
        }
      }

      // All bbox attempts failed — try fallback routing (unconstrained graph)
      return await this.fallbackRoute(
        startNode, endNode, start, end, coastDistanceMeters, via,
      );
    } finally {
      this.vesselDimensions = savedDims;
    }
  }

  /**
   * Fallback routing when A* fails (disconnected components or constraints).
   * Routes as far as possible and returns warnings for the unreachable section.
   */
  private async fallbackRoute(
    startNode: number,
    endNode: number,
    start: { latitude: number; longitude: number },
    end: { latitude: number; longitude: number },
    coastDistanceMeters: number,
    _via: Array<{ latitude: number; longitude: number }>
  ): Promise<RouteResult> {
    const warnings: RouteWarning[] = [];
    const reachableFromStart = this.db.getReachableNodes(startNode);
    const endReachable = reachableFromStart.has(endNode);

    if (!endReachable) {
      // Disconnected components — find bridge node in start's component nearest to end
      const bridge = await this.db.findNearestNodeInSet(
        end.latitude, end.longitude, reachableFromStart
      );

      if (!bridge) {
        throw new Error(
          `No route found — neither the start nor the end point can be connected ` +
          `to the navigable waterway network within range.`
        );
      }

      warnings.push({
        type: 'end_unreachable',
        message: `End destination is in a disconnected part of the waterway network. ` +
          `Route ends ${bridge.distance.toFixed(0)}m from the requested destination, ` +
          `at the nearest reachable point.`,
        from: { latitude: bridge.lat, longitude: bridge.lon },
        to: { latitude: end.latitude, longitude: end.longitude },
        distanceMeters: Math.round(bridge.distance),
      });

      // Check if start node itself is in a tiny component
      const startReachable = this.db.getReachableNodes(startNode);
      if (startReachable.size < 10) {
        const nearestMain = await this.db.findNearestNodeInSet(
          start.latitude, start.longitude, reachableFromStart
        );
        if (nearestMain && nearestMain.id !== startNode) {
          warnings.unshift({
            type: 'start_unreachable',
            message: `Start location is outside the main navigable waterway network. ` +
              `Navigating ${nearestMain.distance.toFixed(0)}m to the nearest channel.`,
            from: { latitude: start.latitude, longitude: start.longitude },
            to: { latitude: nearestMain.lat, longitude: nearestMain.lon },
            distanceMeters: Math.round(nearestMain.distance),
          });
        }
      }

      // Route from start node to bridge node
      const mainRoute = await this.astarSearch(
        start.latitude, start.longitude,
        bridge.lat, bridge.lon,
        coastDistanceMeters
      );

      // Connect start user coordinate to the route
      await this.connectUserPoint(start, mainRoute, 'start');

      // Append the remaining leg as a straight-line segment with warning
      mainRoute.features[0].geometry.coordinates.push([end.longitude, end.latitude]);
      mainRoute.features[0].properties.totalDistance += bridge.distance;
      mainRoute.features[0].properties.segments.push({
        from: bridge.id,
        to: endNode,
        distance: Math.round(bridge.distance),
        minDepth: 0,
        maxAirDraft: 0,
        isFairway: false,
        directionPenalty: 1,
      });
      mainRoute.warnings = warnings;
      return mainRoute;
    }

    // Nodes are in the same component but constraints block all paths
    // — try routing without constraint filtering (raw graph)
    // by temporarily setting vessel dimensions to 0
    const savedFallbackDims = { ...this.vesselDimensions };
    this.vesselDimensions = { draft: 0, beam: 0, airDraft: 0 };
    try {
      const relaxedResult = await this.astarSearch(
        start.latitude, start.longitude,
        end.latitude, end.longitude,
        0  // also zero out coast distance
      );

      // Connect user start/end coordinates to the route
      await this.connectUserPoint(start, relaxedResult, 'start');
      await this.connectUserPoint(end, relaxedResult, 'end');

      warnings.push({
        type: 'end_unreachable',
        message: `Route constrained by vessel dimensions (draft=${savedFallbackDims.draft}m, ` +
          `beam=${savedFallbackDims.beam}m) or coast distance. The route shown ignores some ` +
          `constraints — verify each segment is safe for your vessel.`,
        from: { latitude: start.latitude, longitude: start.longitude },
        to: { latitude: end.latitude, longitude: end.longitude },
        distanceMeters: Math.round(relaxedResult.features[0].properties.totalDistance),
      });

      relaxedResult.warnings = warnings;
      return relaxedResult;
    } finally {
      this.vesselDimensions = savedFallbackDims;
    }
  }

  /**
   * Route through a list of via points sequentially.
   * Handles individual segment failures by trying relaxed constraints
   * (zero draft, beam, airDraft, coast distance) instead of failing entirely.
   */
  private async routeViaPoints(
    start: { latitude: number; longitude: number },
    end: { latitude: number; longitude: number },
    via: Array<{ latitude: number; longitude: number }>,
    coastDistanceMeters: number,
    globalWarnings?: RouteWarning[],
  ): Promise<RouteResult> {
    let currentStart = start;
    const allSegments: RouteResult['features'][0]['properties']['segments'] = [];
    const allCoordinates: [number, number][] = [];
    const warnings: RouteWarning[] = [];

    for (let i = 0; i < via.length; i++) {
      const nextPoint = via[i];
      const segmentBbox = bboxFromPoints(
        currentStart, nextPoint,
        this.config.routingBBoxMargin,
      );
      const segmentResult = await this.tryRouteSegment(
        currentStart.latitude, currentStart.longitude,
        nextPoint.latitude, nextPoint.longitude,
        coastDistanceMeters,
        i, warnings,
        segmentBbox,
      );
      if (!segmentResult) {
        // via point completely unreachable — skip it
        warnings.push({
          type: 'via_skipped',
          message: `Via point ${i + 1} is unreachable via any route — skipped.`,
          from: { latitude: currentStart.latitude, longitude: currentStart.longitude },
          to: { latitude: nextPoint.latitude, longitude: nextPoint.longitude },
        });
        continue;
      }

      // Snap the start of this segment to the user's currentStart coordinate
      // (important for the first segment and for each via point)
      await this.connectUserPoint(currentStart, segmentResult, 'start');

      if (allCoordinates.length === 0) {
        allCoordinates.push(...segmentResult.features[0].geometry.coordinates);
      } else {
        allCoordinates.push(...segmentResult.features[0].geometry.coordinates.slice(1));
      }

      allSegments.push(...segmentResult.features[0].properties.segments);
      currentStart = nextPoint;
    }

    const finalBbox = bboxFromPoints(
      currentStart, end,
      this.config.routingBBoxMargin,
    );
    const finalResult = await this.tryRouteSegment(
      currentStart.latitude, currentStart.longitude,
      end.latitude, end.longitude,
      coastDistanceMeters,
      -1, warnings,
      finalBbox,
    );

    if (!finalResult) {
      throw new Error('No route found to destination');
    }

    // Snap the final segment's start to currentStart (last via point or start if no vias)
    await this.connectUserPoint(currentStart, finalResult, 'start');

    if (allCoordinates.length === 0) {
      allCoordinates.push(...finalResult.features[0].geometry.coordinates);
    } else {
      allCoordinates.push(...finalResult.features[0].geometry.coordinates.slice(1));
    }
    allSegments.push(...finalResult.features[0].properties.segments);

    const allWarnings = [...warnings, ...(globalWarnings || [])];

    const result: RouteResult = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: allCoordinates },
        properties: {
          totalDistance: finalResult.features[0].properties.totalDistance,
          totalCost: finalResult.features[0].properties.totalCost,
          segments: allSegments,
        },
      }],
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };

    // Connect only the overall end coordinate (start is handled per-segment above)
    await this.connectUserPoint(end, result, 'end');

    return result;
  }

  /**
   * Try routing a segment with full constraints and optional bounding box;
   * on failure fall back to relaxed constraints (zero vessel dimensions, 
   * zero coast distance). Returns null if both attempts fail.
   */
  private async tryRouteSegment(
    startLat: number, startLon: number,
    endLat: number, endLon: number,
    coastDistanceMeters: number,
    viaIndex: number,
    warnings: RouteWarning[],
    bbox?: BBox,
  ): Promise<RouteResult | null> {
    const label = viaIndex >= 0 ? `Via point ${viaIndex + 1}` : 'Destination';
    const startPt = { latitude: startLat, longitude: startLon };
    const endPt = { latitude: endLat, longitude: endLon };

    // Try full-constraint A* with expanding bounding box.
    // Cap at 4 doublings (≤ ~180 km) to avoid exploring the whole graph for
    // a short via-segment. The main start→end route uses routingBBoxMaxExtent.
    let currentMargin = this.config.routingBBoxMargin;
    const segmentMaxMargin = Math.min(this.config.routingBBoxMaxExtent, this.config.routingBBoxMargin * 16);

    while (currentMargin <= segmentMaxMargin) {
      const segmentBbox = bbox ?? bboxFromPoints(startPt, endPt, currentMargin);
      try {
        return await this.astarSearch(startLat, startLon, endLat, endLon, coastDistanceMeters, segmentBbox);
      } catch {
        bbox = undefined; // force recompute next iteration
        if (currentMargin >= segmentMaxMargin) break;
        const newMargin = Math.min(currentMargin * 2, segmentMaxMargin);
        if (newMargin > currentMargin) {
          warnings.push({
            type: 'via_constrained',
            message: `Route search for ${label} expanded from ${(currentMargin * 111).toFixed(0)}km to ${(newMargin * 111).toFixed(0)}km bounding box.`,
            from: startPt,
            to: endPt,
          });
        }
        currentMargin = newMargin;
      }
    }

    // All full-constraint attempts failed — try relaxed (zero vessel, zero coast)
    const savedDims = { ...this.vesselDimensions };
    this.vesselDimensions = { draft: 0, beam: 0, airDraft: 0 };
    try {
      const relaxedBbox = bboxFromPoints(startPt, endPt, currentMargin);
      const relaxed = await this.astarSearch(startLat, startLon, endLat, endLon, 0, relaxedBbox);
      warnings.push({
        type: 'via_constrained',
        message: `${label} unreachable under vessel constraints — routed with relaxed constraints.`,
        from: startPt,
        to: endPt,
      });
      return relaxed;
    } catch {
      // Both full-constraint and relaxed A* failed — graph is likely
      // disconnected. Bridge the gap via fallbackRoute (straight line to
      // nearest reachable node) so the via point is preserved.
      const startNode = await this.db.findNearestNode(startLat, startLon);
      const endNode = await this.db.findNearestNode(endLat, endLon);
      if (startNode && endNode) {
        warnings.push({
          type: 'via_constrained',
          message: `${label} is disconnected in the waterway network — bridged via nearest reachable node.`,
          from: startPt,
          to: endPt,
        });
        try {
          const fallback = await this.fallbackRoute(startNode, endNode, startPt, endPt, 0, []);
          if (fallback.warnings) {
            warnings.push(...fallback.warnings);
            // Remove from result so routeViaPoints doesn't double-append
            fallback.warnings = undefined;
          }
          return fallback;
        } catch {
          return null;
        }
      }
      return null;
    } finally {
      this.vesselDimensions = savedDims;
    }
  }

  /**
   * Connect a user-requested point to the nearest route coordinate.
   * Prepends/appends the user point and adds a connecting segment + warning.
   */
  private async connectUserPoint(
    userPoint: { latitude: number; longitude: number },
    route: RouteResult,
    position: 'start' | 'end',
  ): Promise<void> {
    const coords = route.features[0].geometry.coordinates;
    const segments = route.features[0].properties.segments;
    if (coords.length === 0) return;

    // Try edge-snapped projection for smoother entry/exit
    const edgeSnap = await this.db.findNearestEdge(userPoint.latitude, userPoint.longitude);

    if (position === 'start') {
      const firstCoord = coords[0];
      const directDist = this.haversineDistance(userPoint.latitude, userPoint.longitude, firstCoord[1], firstCoord[0]);
      if (directDist <= 1) return;

      if (edgeSnap && edgeSnap.distance < directDist && edgeSnap.fraction > 0.01 && edgeSnap.fraction < 0.99) {
        // Use edge projection: user → projected → graph_node
        const snapToNode = this.haversineDistance(
          edgeSnap.point.lat, edgeSnap.point.lon,
          firstCoord[1], firstCoord[0],
        );
        const edgePortion = edgeSnap.fraction <= 0.5
          ? edgeSnap.edge.distance * edgeSnap.fraction
          : edgeSnap.edge.distance * (1 - edgeSnap.fraction);

        coords.unshift(
          [edgeSnap.point.lon, edgeSnap.point.lat],
          [userPoint.longitude, userPoint.latitude],
        );
        segments.unshift(
          {
            from: -1, to: -1,
            distance: Math.round(edgePortion + snapToNode),
            minDepth: edgeSnap.edge.min_depth,
            maxAirDraft: edgeSnap.edge.max_air_draft,
            isFairway: edgeSnap.edge.is_fairway === 1,
            directionPenalty: edgeSnap.edge.direction_penalty,
            isOneWay: edgeSnap.edge.is_one_way === 1,
            trafficDir: edgeSnap.edge.traffic_dir,
          },
          {
            from: -1, to: -1,
            distance: Math.round(edgeSnap.distance),
            minDepth: -1, maxAirDraft: -1,
            isFairway: false,
            directionPenalty: 1,
          },
        );
        route.features[0].properties.totalDistance += Math.round(edgeSnap.distance + edgePortion + snapToNode);
        if (!route.warnings) route.warnings = [];
        route.warnings.push({
          type: 'start_connecting',
          message: `${Math.round(edgeSnap.distance)}m from start position to the nearest waterway edge, then ${Math.round(edgePortion + snapToNode)}m along the waterway.`,
          from: { latitude: userPoint.latitude, longitude: userPoint.longitude },
          to: { latitude: firstCoord[1], longitude: firstCoord[0] },
          distanceMeters: Math.round(edgeSnap.distance),
        });
      } else {
        // Fall back to straight line
        coords.unshift([userPoint.longitude, userPoint.latitude]);
        segments.unshift({
          from: -1, to: -1,
          distance: Math.round(directDist),
          minDepth: -1, maxAirDraft: -1,
          isFairway: false,
          directionPenalty: 1,
        });
        route.features[0].properties.totalDistance += Math.round(directDist);
        if (!route.warnings) route.warnings = [];
        route.warnings.push({
          type: 'start_connecting',
          message: `${Math.round(directDist)}m from start position to the nearest charted waterway.`,
          from: { latitude: userPoint.latitude, longitude: userPoint.longitude },
          to: { latitude: firstCoord[1], longitude: firstCoord[0] },
          distanceMeters: Math.round(directDist),
        });
      }
    } else {
      const lastCoord = coords[coords.length - 1];
      const directDist = this.haversineDistance(userPoint.latitude, userPoint.longitude, lastCoord[1], lastCoord[0]);
      if (directDist <= 1) return;

      if (edgeSnap && edgeSnap.distance < directDist && edgeSnap.fraction > 0.01 && edgeSnap.fraction < 0.99) {
        // Use edge projection: graph_node → projected → user
        const nodeToSnap = this.haversineDistance(
          lastCoord[1], lastCoord[0],
          edgeSnap.point.lat, edgeSnap.point.lon,
        );
        const edgePortion = edgeSnap.fraction <= 0.5
          ? edgeSnap.edge.distance * edgeSnap.fraction
          : edgeSnap.edge.distance * (1 - edgeSnap.fraction);

        coords.push(
          [edgeSnap.point.lon, edgeSnap.point.lat],
          [userPoint.longitude, userPoint.latitude],
        );
        segments.push(
          {
            from: -1, to: -1,
            distance: Math.round(nodeToSnap + edgePortion),
            minDepth: edgeSnap.edge.min_depth,
            maxAirDraft: edgeSnap.edge.max_air_draft,
            isFairway: edgeSnap.edge.is_fairway === 1,
            directionPenalty: edgeSnap.edge.direction_penalty,
            isOneWay: edgeSnap.edge.is_one_way === 1,
            trafficDir: edgeSnap.edge.traffic_dir,
          },
          {
            from: -1, to: -1,
            distance: Math.round(edgeSnap.distance),
            minDepth: -1, maxAirDraft: -1,
            isFairway: false,
            directionPenalty: 1,
          },
        );
        route.features[0].properties.totalDistance += Math.round(edgeSnap.distance + edgePortion + nodeToSnap);
        if (!route.warnings) route.warnings = [];
        route.warnings.push({
          type: 'end_connecting',
          message: `${Math.round(edgeSnap.distance)}m from nearest waterway edge to destination (via edge projection).`,
          from: { latitude: lastCoord[1], longitude: lastCoord[0] },
          to: { latitude: userPoint.latitude, longitude: userPoint.longitude },
          distanceMeters: Math.round(nodeToSnap + edgePortion),
        });
      } else {
        // Fall back to straight line
        coords.push([userPoint.longitude, userPoint.latitude]);
        segments.push({
          from: -1, to: -1,
          distance: Math.round(directDist),
          minDepth: -1, maxAirDraft: -1,
          isFairway: false,
          directionPenalty: 1,
        });
        route.features[0].properties.totalDistance += Math.round(directDist);
        if (!route.warnings) route.warnings = [];
        route.warnings.push({
          type: 'end_connecting',
          message: `${Math.round(directDist)}m from nearest charted waterway to the destination.`,
          from: { latitude: lastCoord[1], longitude: lastCoord[0] },
          to: { latitude: userPoint.latitude, longitude: userPoint.longitude },
          distanceMeters: Math.round(directDist),
        });
      }
    }
  }

  /**
   * Build a minimal route result containing just a single node
   */
  private async buildEmptyRoute(nodeId: number): Promise<RouteResult> {
    const node = await this.db.getNodeById(nodeId);
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: node ? [[node.lon, node.lat]] : [],
        },
        properties: { totalDistance: 0, totalCost: 0, segments: [] },
      }],
    };
  }

  /**
   * Core A* search algorithm with nautical cost function.
   * Optionally constrains search to a bounding box for performance.
   */
  private async astarSearch(
    startLat: number,
    startLon: number,
    endLat: number,
    endLon: number,
    minCoastDistanceMeters: number,
    bbox?: BBox,
  ): Promise<RouteResult> {
    const startNode = await this.db.findNearestNode(startLat, startLon);
    const endNode = await this.db.findNearestNode(endLat, endLon);

    if (!startNode || !endNode) {
      throw new Error('Could not find routing nodes near start or end point');
    }

    // A* data structures
    const openSet = new MinHeap<SearchState>((state) => state.f);
    const closedSet = new Set<number>();
    const gScore = new Map<number, number>();
    const parent = new Map<number, number | null>();

    // Initialize
    gScore.set(startNode, 0);
    openSet.push({
      nodeId: startNode,
      g: 0,
      f: this.haversineDistance(startLat, startLon, endLat, endLon),
      parent: null,
    });

    let goalReached = false;
    let iterations = 0;
    const maxIterations = 100000; // Safety limit

    // Pre-fetch start node coords for boundary checks
    const startCoords = await this.db.getNodeById(startNode);

    // Ensure start is inside the bounding box
    if (bbox && startCoords) {
      if (!isInsideBBox(startCoords.lat, startCoords.lon, bbox)) {
        throw new Error('Start node is outside the routing bounding box');
      }
    }

    while (!openSet.isEmpty() && iterations < maxIterations) {
      iterations++;
      const current = openSet.pop()!;

      if (current.nodeId === endNode) {
        goalReached = true;
        break;
      }

      if (closedSet.has(current.nodeId)) {
        continue;
      }

      closedSet.add(current.nodeId);

      // Get outgoing edges from current node
      const edges = await this.db.getOutgoingEdges(current.nodeId);

      for (const edge of edges) {
        if (closedSet.has(edge.target)) {
          continue;
        }

        // Bounding box check — skip nodes outside the box
        if (bbox && !isInsideBBox(edge.lat, edge.lon, bbox)) {
          continue;
        }

        // Apply hard safety constraints
        if (!this.isEdgeSafe(edge)) {
          continue;
        }
        // CRITICAL FIX: Only apply coastline distance constraints to open sea/coastal grids.
        // Inland waterways and locks are inherently safe from a coastline perspective.
        if (edge.edge_type === 'coastal' && edge.distance_to_land < minCoastDistanceMeters) {
          continue;
        }

        // Check coast distance constraint for coastal routing
        if (edge.distance_to_land < minCoastDistanceMeters) {
          continue;
        }

        // Calculate edge cost using multi-layered cost function
        const edgeCost = this.calculateEdgeCost(edge);

        const tentativeG = gScore.get(current.nodeId)! + edgeCost;

        if (!gScore.has(edge.target) || tentativeG < gScore.get(edge.target)!) {
          gScore.set(edge.target, tentativeG);
          parent.set(edge.target, current.nodeId);

          const h = this.haversineDistance(
            edge.lat,
            edge.lon,
            endLat,
            endLon
          );

          openSet.push({
            nodeId: edge.target,
            g: tentativeG,
            f: tentativeG + h,
            parent: current.nodeId,
          });
        }
      }
    }

    if (!goalReached) {
      throw new Error(
        `No route found between the given points with current constraints. ` +
        `Try reducing minCoastDistance or checking vessel dimensions (draft=${this.vesselDimensions.draft}m, beam=${this.vesselDimensions.beam}m, airDraft=${this.vesselDimensions.airDraft}m).`
      );
    }

    // Reconstruct path
    const path: number[] = [];
    let current: number | null = endNode;
    while (current !== null) {
      path.unshift(current);
      current = parent.get(current) ?? null;
    }

    // Compress collinear waypoints (cheap pre-pass before LOS smoothing)
    const compressedPath = this.compressCollinear(path);

    // Apply string-pulling to remove unnecessary grid staircasing
    const smoothedPath = await this.smoothPath(compressedPath);

    // Build GeoJSON response
    return await this.buildRouteResult(smoothedPath, path, gScore.get(endNode) || 0);
  }

  /**
   * Apply hard safety constraints to an edge
   */
  private isEdgeSafe(edge: EdgeRow & { lat: number; lon: number }): boolean {
    // Reject edges flagged as crossing land (post-pipeline validation)
    if (edge.crosses_land === 1) {
      return false;
    }

    // Air draft applies to ALL edges (bridges are hard physical stops)
    if (edge.max_air_draft >= 0 && edge.max_air_draft < (this.vesselDimensions.airDraft || 0)) {
      return false;
    }

    // Coastal edges: Enforce strict depth and width checks
    if (edge.edge_type === 'coastal') {
      if (edge.min_depth >= 0 && edge.min_depth < (this.vesselDimensions.draft || 0)) return false;
      if (edge.min_width >= 0 && edge.min_width < (this.vesselDimensions.beam || 0)) return false;
    }
    
    // Inland edges (official fairways/centerlines) bypass depth/width checks 
    // because the Python spatial join often grazes shallow riverbanks.
    return true;
  }


  /**
   * Check if a straight line between two coordinates stays within navigable water.
   *
   * Primary check: sample points along the line and verify each lies inside a
   * water polygon (coastal_water_polygons.geojson).  This correctly rejects
   * shortcuts that cross land without depending on node density, which was the
   * root cause of staircase routes on the open Markermeer where the coarse
   * 0.005° grid leaves gaps larger than the node-proximity search radius.
   *
   * If the water polygon data is unavailable the check falls back to the
   * original node-proximity heuristic so the smoother still works on graphs
   * built without coastal water polygons.
   */
  private hasLineOfSight(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
  ): boolean {
    const dist = this.haversineDistance(lat1, lon1, lat2, lon2);

    // CRITICAL: Force a dense 50m sampling interval so it cannot jump over land
    const numSamples = Math.max(3, Math.ceil(dist / 50));

    // Primary check: Does the line intersect Land polygons?
    // If it crosses land, it's NOT a clear line of sight.
    if ((this.db as any).isLineCrossingLand && (this.db as any).isLineCrossingLand(lat1, lon1, lat2, lon2, numSamples)) {
        return false; 
    }

    // Secondary fallback: Make sure the path stays near navigable graph nodes
    const searchRadius = this.config.lineOfSightSearchRadius; // config default is 50m
    for (let i = 1; i < numSamples; i++) {
      const t = i / numSamples;
      const lat = lat1 + (lat2 - lat1) * t;
      const lon = lon1 + (lon2 - lon1) * t;
      if (!this.db.hasNodeWithinRadius(lat, lon, searchRadius)) {
        return false;
      }
    }
    return true;
  }
  
  /**
   * Calculate the cost for an edge using the multi-layered cost function
   * Cost = Distance × FairwayMultiplier × DirectionalPenalty × OneWayPenalty
   */
  private calculateEdgeCost(edge: EdgeRow & { lat: number; lon: number }): number {
    let cost = edge.distance; // Base cost is distance in meters

    // Fairway multiplier: prefer official buoyed waterways
    const fairwayMultiplier = edge.is_fairway
      ? this.config.fairwayMultiplier
      : this.config.openWaterMultiplier;
    cost *= fairwayMultiplier;

    // Directional penalty: penalize traveling against traffic flow
    cost *= edge.direction_penalty;

    // One-way penalty: edges are stored source→target.
    // If edge is one-way (traffic_dir=1, meaning source→target is allowed,
    // or traffic_dir=-1, meaning target→source is allowed), traversing the
    // wrong direction incurs a severe cost penalty (~1000× base).
    // The direction_penalty in the DB already reflects asymmetric traffic
    // modeling; is_one_way enforces strict regulatory one-way lanes.
    if (edge.is_one_way === 1 && edge.traffic_dir !== undefined) {
      // Edges are always traversed source→target via getOutgoingEdges().
      // If the allowed direction is target→source (traffic_dir=-1),
      // this traversal is against the one-way restriction.
      if (edge.traffic_dir === -1) {
        cost *= 1e6; // virtually impassable wrong-way
      }
    }

    return cost;
  }

  /**
   * Haversine distance between two coordinates (returns meters)
   */
  private haversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 6371000; // Earth radius in meters
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRadians(degrees: number): number {
    return (degrees * Math.PI) / 180;
  }

  /**
   * Build GeoJSON RouteResult from path node IDs
   */
  private async buildRouteResult(
    smoothedPath: number[],
    originalPath: number[],
    totalCost: number
  ): Promise<RouteResult> {
    const coordinates: [number, number][] = [];
    const segments: RouteResult['features'][0]['properties']['segments'] = [];
    let totalDistance = 0;

    for (let i = 0; i < smoothedPath.length; i++) {
      const node = await this.db.getNodeById(smoothedPath[i]);
      if (node) {
        coordinates.push([node.lon, node.lat]);
      }

      if (i > 0) {
        const prevNode = smoothedPath[i - 1];
        const currNode = smoothedPath[i];
        let edge = await this.db.getEdge(prevNode, currNode);

        if (!edge && originalPath !== smoothedPath) {
          edge = this.db.aggregateSegmentEdges(prevNode, currNode, originalPath);
        }

        if (edge) {
          totalDistance += edge.distance;
          segments.push({
            from: prevNode,
            to: currNode,
            distance: edge.distance,
            minDepth: edge.min_depth,
            maxAirDraft: edge.max_air_draft,
            isFairway: edge.is_fairway === 1,
            directionPenalty: edge.direction_penalty,
            isOneWay: edge.is_one_way === 1,
            trafficDir: edge.traffic_dir,
          });
        } else {
          const fromNode = await this.db.getNodeById(prevNode);
          const toNode = await this.db.getNodeById(currNode);
          if (fromNode && toNode) {
            const dist = Math.round(this.haversineDistance(
              fromNode.lat, fromNode.lon,
              toNode.lat, toNode.lon
            ));
            totalDistance += dist;
            segments.push({
              from: prevNode,
              to: currNode,
              distance: dist,
              minDepth: -1,
              maxAirDraft: -1,
              isFairway: false,
              directionPenalty: 1,
            });
          }
        }
      }
    }

    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates,
          },
          properties: {
            totalDistance,
            totalCost,
            segments,
          },
        },
      ],
    };
  }

  /**
   * Compress collinear waypoints: remove intermediate nodes that are nearly
   * collinear with their neighbors (cross-track distance < 2m).
   * This is a lightweight pre-pass before the more expensive LOS smoothing.
   */
  private compressCollinear(path: number[]): number[] {
    if (path.length <= 2) return path;

    const coordsCache = new Map<number, { lat: number; lon: number }>();

    const getCoord = (id: number): { lat: number; lon: number } | null => {
      let c = coordsCache.get(id);
      if (!c) {
        const node = this.db.getNodeSync(id);
        if (!node) return null;
        c = { lat: node.lat, lon: node.lon };
        coordsCache.set(id, c);
      }
      return c;
    };

    // Convert signed area calculation to equirectangular meters
    const isCollinear = (n1: number, n2: number, n3: number, thresholdMeters = 2): boolean => {
      const p1 = getCoord(n1);
      const p2 = getCoord(n2);
      const p3 = getCoord(n3);
      if (!p1 || !p2 || !p3) return false;

      // Equirectangular approximation: project to meters around mid-latitude
      const midLat = ((p1.lat + p3.lat) / 2) * Math.PI / 180;
      const cosMid = Math.cos(midLat);
      const R = 6371000;
      const toRad = (d: number) => d * Math.PI / 180;

      const x1 = toRad(p1.lon) * cosMid * R;
      const y1 = toRad(p1.lat) * R;
      const x2 = toRad(p2.lon) * cosMid * R;
      const y2 = toRad(p2.lat) * R;
      const x3 = toRad(p3.lon) * cosMid * R;
      const y3 = toRad(p3.lat) * R;

      // Cross-track distance = area of parallelogram / base length
      const cross = Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
      const base = Math.sqrt((x3 - x1) ** 2 + (y3 - y1) ** 2);
      if (base < 1) return true; // p1 and p3 are the same point

      return cross / base < thresholdMeters;
    };

    const compressed: number[] = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const prev = compressed[compressed.length - 1];
      const next = path[i + 1];

      if (!isCollinear(prev, path[i], next)) {
        compressed.push(path[i]);
      }
    }
    compressed.push(path[path.length - 1]);

    return compressed;
  }

  /**
   * Apply string-pulling (line-of-sight smoothing) to a grid-based A* path.
   * Greedy lookahead: for each anchor node, find the furthest node ahead
   * that has a clear line-of-sight (no land or constraint gaps), and skip
   * the intermediate grid nodes.
   */
private async smoothPath(path: number[]): Promise<number[]> {
    if (path.length <= 2) return path;

    const smoothed: number[] = [path[0]];
    let i = 0;

    // Pre-fetch all nodes to check their type
    const nodeMap = new Map<number, any>();
    for (const id of path) {
      const n = await this.db.getNodeById(id);
      nodeMap.set(id, n);
    }

    while (i < path.length - 1) {
      let j = path.length - 1;
      while (j > i + 1) {
        // CRITICAL FIX: Do not shortcut if any intermediate node is an official inland centerline.
        // This forces the route to perfectly track river curves and fairways.
        let skippingInland = false;
        for (let k = i + 1; k < j; k++) {
          const n = nodeMap.get(path[k]);
          if (n && n.node_type === 'inland') {
            skippingInland = true;
            break;
          }
        }

        if (!skippingInland) {
          const coordsI = nodeMap.get(path[i]);
          const coordsJ = nodeMap.get(path[j]);
          if (coordsI && coordsJ && this.hasLineOfSight(coordsI.lat, coordsI.lon, coordsJ.lat, coordsJ.lon)) {
            break;
          }
        }
        j--;
      }

      smoothed.push(path[j]);
      i = j;
    }

    return smoothed;
  }


}