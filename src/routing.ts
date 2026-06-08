/**
 * A* Pathfinding Engine for Nautical Routing
 * Implements vessel-aware directed A* with multi-layered cost function
 */

import { EdgeRow, RoutingDatabase } from './database.js';
import {
    PluginConfig,
    RouteResult,
    RouteWarning,
    RoutingRequest,
    VesselDimensions,
} from './types.js';

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
   * Calculate a route using directed A* algorithm
   * Falls back to partial routing when the route cannot be completed
   * (disconnected components or unreachable due to constraints),
   * returning warnings for teleported segments.
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

      // Try normal A* routing first
      try {
        if (via.length > 0) {
          return await this.routeViaPoints(start, end, via, coastDistanceMeters);
        }
        return await this.astarSearch(
          start.latitude, start.longitude,
          end.latitude, end.longitude,
          coastDistanceMeters
        );
      } catch (_aStarErr) {
        // A* failed — attempt fallback routing
        return await this.fallbackRoute(
          startNode, endNode, start, end, coastDistanceMeters, via
        );
      }
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
    via: Array<{ latitude: number; longitude: number }>
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
   * Route through a list of via points sequentially
   */
  private async routeViaPoints(
    start: { latitude: number; longitude: number },
    end: { latitude: number; longitude: number },
    via: Array<{ latitude: number; longitude: number }>,
    coastDistanceMeters: number
  ): Promise<RouteResult> {
    let currentStart = start;
    const allSegments: RouteResult['features'][0]['properties']['segments'] = [];
    const allCoordinates: [number, number][] = [];

    for (let i = 0; i < via.length; i++) {
      const nextPoint = via[i];
      const segmentResult = await this.astarSearch(
        currentStart.latitude, currentStart.longitude,
        nextPoint.latitude, nextPoint.longitude,
        coastDistanceMeters
      );

      if (i === 0) {
        allCoordinates.push(...segmentResult.features[0].geometry.coordinates);
      } else {
        allCoordinates.push(...segmentResult.features[0].geometry.coordinates.slice(1));
      }

      allSegments.push(...segmentResult.features[0].properties.segments);
      currentStart = nextPoint;
    }

    const finalResult = await this.astarSearch(
      currentStart.latitude, currentStart.longitude,
      end.latitude, end.longitude,
      coastDistanceMeters
    );

    allCoordinates.push(...finalResult.features[0].geometry.coordinates.slice(1));
    allSegments.push(...finalResult.features[0].properties.segments);

    return {
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
    };
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
   * Core A* search algorithm with nautical cost function
   */
  private async astarSearch(
    startLat: number,
    startLon: number,
    endLat: number,
    endLon: number,
    minCoastDistanceMeters: number
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

        // Apply hard safety constraints
        if (!this.isEdgeSafe(edge)) {
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

          const edgeCoords = await this.db.getNodeById(edge.target);
          const h = this.haversineDistance(
            edgeCoords?.lat || 0,
            edgeCoords?.lon || 0,
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

    // Apply string-pulling to remove unnecessary grid staircasing
    const smoothedPath = await this.smoothPath(path);

    // Build GeoJSON response
    return await this.buildRouteResult(smoothedPath, path, gScore.get(endNode) || 0);
  }

  /**
   * Apply hard safety constraints to an edge
   */
  private isEdgeSafe(edge: EdgeRow & { lat: number; lon: number }): boolean {
    // Negative constraint values = unknown data gap; treat as passable
    if (edge.min_depth >= 0 && edge.min_depth < (this.vesselDimensions.draft || 0)) {
      return false;
    }

    if (edge.min_width >= 0 && edge.min_width < (this.vesselDimensions.beam || 0)) {
      return false;
    }

    if (edge.max_air_draft >= 0 && edge.max_air_draft < (this.vesselDimensions.airDraft || 0)) {
      return false;
    }

    return true;
  }

  /**
   * Calculate the cost for an edge using the multi-layered cost function
   * Cost = Distance × FairwayMultiplier × DirectionalPenalty
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
   * Apply string-pulling (line-of-sight smoothing) to a grid-based A* path.
   * Greedy lookahead: for each anchor node, find the furthest node ahead
   * that has a clear line-of-sight (no land or constraint gaps), and skip
   * the intermediate grid nodes.
   */
  private async smoothPath(path: number[]): Promise<number[]> {
    if (path.length <= 2) return path;

    const smoothed: number[] = [path[0]];
    let i = 0;

    while (i < path.length - 1) {
      let j = path.length - 1;
      while (j > i + 1) {
        const coordsI = await this.db.getNodeById(path[i]);
        const coordsJ = await this.db.getNodeById(path[j]);
        if (!coordsI || !coordsJ) { j--; continue; }

        if (this.hasLineOfSight(coordsI.lat, coordsI.lon, coordsJ.lat, coordsJ.lon)) {
          break;
        }
        j--;
      }

      smoothed.push(path[j]);
      i = j;
    }

    return smoothed;
  }

  /**
   * Check if a straight line between two coordinates stays within navigable water.
   * Samples points along the great-circle line and verifies each has a graph node
   * within the search radius. If any sample point has no nearby node, the line
   * likely crosses land or an unmapped area — reject the shortcut.
   */
  private hasLineOfSight(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
    sampleIntervalMeters: number = 500
  ): boolean {
    const dist = this.haversineDistance(lat1, lon1, lat2, lon2);
    const numSamples = Math.max(3, Math.ceil(dist / sampleIntervalMeters));

    for (let i = 1; i < numSamples; i++) {
      const t = i / numSamples;
      const lat = lat1 + (lat2 - lat1) * t;
      const lon = lon1 + (lon2 - lon1) * t;
      if (!this.db.hasNodeWithinRadius(lat, lon, sampleIntervalMeters)) {
        return false;
      }
    }
    return true;
  }
}
