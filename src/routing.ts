/**
 * A* Pathfinding Engine for Nautical Routing
 * Implements vessel-aware directed A* with multi-layered cost function
 */

import { EdgeRow, RoutingDatabase, getNodeTypeInt, NODE_TYPE_INLAND, EDGE_TYPE_COASTAL, POI_TYPE_BRIDGE, POI_TYPE_LOCK, TRAFFIC_TWO_WAY, TRAFFIC_ONE_WAY_REV } from './database.js';
import { bearingDeg, buildItinerary } from './itinerary.js';
import { CurrentsClient, FlowField, KNOTS_TO_MS, TidesClient, prepareStationFlowField, prepareTidalFlowField } from './tides.js';
import {
    BBox,
    LegMode,
    PluginConfig,
    RouteCrossing,
    RouteResult,
    RouteWarning,
    RoutingRequest,
    VesselDimensions,
} from './types.js';

function isInsideBBox(lat: number, lon: number, bbox: BBox): boolean {
  return lat >= bbox.minLat && lat <= bbox.maxLat &&
         lon >= bbox.minLon && lon <= bbox.maxLon;
}

/**
 * Per-request environmental context for time-dependent routing.
 * Built once in calculateRoute and threaded through the search paths —
 * never stored on the engine, so concurrent requests stay isolated.
 */
interface RouteEnv {
  flow: FlowField;
  departureMs: number; // departure time of the overall route
  offsetSec: number;   // elapsed seconds before this sub-search (via legs)
  speedMs: number;     // vessel speed through water
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
  private tides: TidesClient | null = null;
  private currents: CurrentsClient | null = null;

  constructor(db: RoutingDatabase, config: PluginConfig, vesselDimensions?: VesselDimensions) {
    this.db = db;
    this.config = config;
    this.vesselDimensions = vesselDimensions || {
      draft: 0,   // unknown until SignalK provides it
      beam: 4,    // reaseonable default until SignalK provides it
      airDraft: 0,
    };
  }

  /**
   * Update vessel dimensions
   */
  setVesselDimensions(dimensions: VesselDimensions): void {
    this.vesselDimensions = { ...this.vesselDimensions, ...dimensions };
  }

  get vesselDims(): VesselDimensions {
    return { ...this.vesselDimensions };
  }

  setTidesClient(client: TidesClient | null): void {
    this.tides = client;
  }

  get tidesClient(): TidesClient | null {
    return this.tides;
  }

  setCurrentsClient(client: CurrentsClient | null): void {
    this.currents = client;
  }

  get currentsClient(): CurrentsClient | null {
    return this.currents;
  }

  /**
   * Build the per-request environmental context: resolve departure time and
   * prepare the tidal flow field over the request area and travel window.
   * Returns undefined when tides are off or unavailable (route falls back to
   * plain distance-based behavior, bit-identical to before this feature).
   */
  private async prepareEnv(
    request: RoutingRequest,
    anchors: Array<{ latitude: number; longitude: number }>,
  ): Promise<RouteEnv | undefined> {
    const wantTides = request.useTides ?? this.config.considerTides;
    if (!wantTides || (!this.tides && !this.currents)) return undefined;

    const parsed = request.departureTime ? Date.parse(request.departureTime) : NaN;
    const departureMs = Number.isFinite(parsed) ? parsed : Date.now();
    const speedMs = Math.max(0.5, this.config.averageSpeedKnots) * KNOTS_TO_MS;

    // Travel window estimate: 3× the direct distance at STW covers detours,
    // clamped to sane bounds so timeline fetches stay small.
    let directM = 0;
    for (let i = 1; i < anchors.length; i++) {
      directM += this.haversineDistance(
        anchors[i - 1].latitude, anchors[i - 1].longitude,
        anchors[i].latitude, anchors[i].longitude,
      );
    }
    const windowSec = Math.min(72 * 3600, Math.max(6 * 3600, (3 * directM) / speedMs));

    const endMs = departureMs + windowSec * 1000;

    // Height-derived estimate (signalk-tides) — used directly when no
    // current stations cover the route, else as the out-of-range fallback.
    const gradient = this.tides
      ? await prepareTidalFlowField(
          this.tides, anchors, departureMs, endMs, this.config.maxTidalCurrentKnots,
        )
      : null;

    // Real harmonic current stations (signalk-tidal-currents) — preferred.
    const stationField = this.currents
      ? await prepareStationFlowField(this.currents, anchors, departureMs, endMs, gradient)
      : null;

    const flow = stationField ?? gradient;
    if (!flow) return undefined;
    return { flow, departureMs, offsetSec: 0, speedMs };
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

    // Build per-request effective dimensions without mutating shared engine state.
    // Concurrent requests each get their own local copy, avoiding race conditions.
    const effectiveDims: VesselDimensions = {
      draft:    draft    !== undefined ? draft    : this.vesselDimensions.draft,
      beam:     beam     !== undefined ? beam     : this.vesselDimensions.beam,
      airDraft: airDraft !== undefined ? airDraft : this.vesselDimensions.airDraft,
    };

    const coastDistanceMeters = effectiveCoastDistance * 1852;

      // Find nearest graph nodes to start/end. A missing node is only fatal
      // when the adjacent leg is auto-routed — manual legs are straight lines
      // and work in areas with no graph coverage at all.
      const startNode = await this.db.findNearestNode(start.latitude, start.longitude);
      const endNode = await this.db.findNearestNode(end.latitude, end.longitude);
      const firstLegMode = via.length > 0 ? via[0].mode : request.endMode;
      const lastLegMode = request.endMode;

      if (!startNode && firstLegMode !== 'manual') throw new Error(`No routing nodes found near start point`);
      if (!endNode && lastLegMode !== 'manual') throw new Error(`No routing nodes found near end point`);

      // Tidal flow field for time-dependent costs (undefined = tides off/unavailable)
      const env = await this.prepareEnv(request, [start, ...via, end]);

      // Build bounding box with initial margin, try A* with expansion on failure
      const bboxWarnings: RouteWarning[] = [];

      if (via.length > 0 || request.endMode === 'manual') {
        return await this.routeViaPoints(start, end, via, coastDistanceMeters, effectiveDims, bboxWarnings, env, request.endMode);
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
            effectiveDims,
            bbox,
            env,
          );

          // Connect user's start/end to the route coordinates
          await this.connectUserPoint(start, result, 'start');
          await this.connectUserPoint(end, result, 'end');

          // Check for constraint violations (draft, beam, air draft) on the found path
          const violationWarnings: RouteWarning[] = [];
          this.addViolationWarnings(result, violationWarnings, 'destination', start, end, effectiveDims);

          // Attach any warning types
          result.warnings = [
            ...(result.warnings || []),
            ...bboxWarnings,
            ...violationWarnings,
          ];
          if (result.warnings.length === 0) delete result.warnings;
          await this.finalizeRoute(result, [], env);
          return result;
        } catch {
          // Expand bounding box and retry
          if (currentMargin < maxMargin) {
            const newMargin = Math.min(currentMargin * 2, maxMargin);
            if (newMargin > currentMargin) {
              console.log(`Route search expanded from ${(currentMargin * 111).toFixed(0)}km to ${(newMargin * 111).toFixed(0)}km bounding box`);
            }
            currentMargin = newMargin;
          } else {
            break;
          }
        }
      }

      // All bbox attempts failed — try fallback routing (unconstrained graph).
      // (Only reachable on the all-auto path, where both nodes were verified.)
      return await this.fallbackRoute(
        startNode!, endNode!, start, end, coastDistanceMeters, via, effectiveDims, env,
      );
  }

  /**
   * Scan a range of departure times and return the total travel time for
   * each, so the user can pick the most favorable tide. Each step is a full
   * route calculation (the optimal route may differ per tide); repeated tide
   * API fetches are absorbed by the TidesClient cache.
   */
  async scanDepartures(
    request: RoutingRequest,
    scanHours: number = 24,
    stepMinutes: number = 60,
  ): Promise<Array<{
    departureTime: string;
    totalSeconds?: number;
    totalSecondsNoTide?: number;
    arrivalTime?: string;
    totalDistance?: number;
    error?: string;
  }>> {
    const parsed = request.departureTime ? Date.parse(request.departureTime) : NaN;
    const t0 = Number.isFinite(parsed) ? parsed : Date.now();
    const steps = Math.min(97, Math.floor((scanHours * 60) / stepMinutes) + 1);

    const out = [];
    for (let i = 0; i < steps; i++) {
      const departureTime = new Date(t0 + i * stepMinutes * 60_000).toISOString();
      try {
        const r = await this.calculateRoute({ ...request, departureTime, useTides: true });
        out.push({
          departureTime,
          totalSeconds: r.totalSeconds,
          totalSecondsNoTide: r.totalSecondsNoTide,
          arrivalTime: r.arrivalTime,
          totalDistance: r.totalDistance,
        });
      } catch (e) {
        out.push({ departureTime, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
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
    _via: Array<{ latitude: number; longitude: number }>,
    dims: VesselDimensions,
    env?: RouteEnv,
  ): Promise<RouteResult> {
    const warnings: RouteWarning[] = [];
    const reachableFromStart = this.db.getReachableNodes(startNode);
    const endReachable = reachableFromStart.has(endNode);

    if (!endReachable) {
      // Disconnected components — pick the larger component as the primary routing network
      const reachableFromEnd = this.db.getReachableNodes(endNode);
      const useEndAsPrimary = reachableFromEnd.size >= reachableFromStart.size;
      const primaryComponent = useEndAsPrimary ? reachableFromEnd : reachableFromStart;

      // Find connection points in the primary component nearest to each user point
      const entry = await this.db.findNearestNodeInSet(
        start.latitude, start.longitude, primaryComponent, 50000
      );
      const exit = await this.db.findNearestNodeInSet(
        end.latitude, end.longitude, primaryComponent, 50000
      );

      if (!entry || !exit) {
        throw new Error(
          'No route found — the start and end are in disconnected parts of the waterway ' +
          'network (e.g. separated by a lock or unconnected water body) and no bridging ' +
          'point could be found at either end.'
        );
      }

      // Route through the primary component from entry to exit
      let route: RouteResult;
      if (entry.id === exit.id) {
        route = await this.buildEmptyRoute(entry.id);
      } else {
        try {
          route = await this.astarSearch(
            entry.lat, entry.lon,
            exit.lat, exit.lon,
            coastDistanceMeters,
            dims,
            undefined,
            env,
          );
        } catch {
          throw new Error(
            'No route found through the primary waterway network between the connection points.'
          );
        }
      }

      // Connect user points to the primary network entry/exit
      await this.connectUserPoint(start, route, 'start');
      await this.connectUserPoint(end, route, 'end');

      await this.finalizeRoute(route, [], env);
      return route;
    }

    throw new Error(
      `No route found — graph is connected but A* could not find a path. ` +
      `This should not happen with soft constraints enabled.`
    );
  }

  /**
   * Route through a list of via points sequentially.
   * Handles individual segment failures by trying relaxed constraints
   * (zero draft, beam, airDraft, coast distance) instead of failing entirely.
   */
  private async routeViaPoints(
    start: { latitude: number; longitude: number },
    end: { latitude: number; longitude: number },
    via: Array<{ latitude: number; longitude: number; mode?: LegMode }>,
    coastDistanceMeters: number,
    dims: VesselDimensions,
    globalWarnings?: RouteWarning[],
    env?: RouteEnv,
    endMode?: LegMode,
  ): Promise<RouteResult> {
    let currentStart = start;
    let elapsedSec = 0; // time offset of the current leg's departure
    const allSegments: RouteResult['features'][0]['properties']['segments'] = [];
    const allCoordinates: [number, number][] = [];
    const warnings: RouteWarning[] = [];
    let totalDistanceMeters = 0;
    let totalCostAccum = 0;

    // Compute an adaptive margin from the overall span of all waypoints.
    // Water routes can make large lat/lon excursions (e.g. Lisbon→Italy via
    // Gibraltar is ~3° south of both endpoints), so the per-segment bbox must
    // be generous enough to contain the full water path, not just the chord.
    const allPts = [start, ...via, end];
    const minPtLat = Math.min(...allPts.map(p => p.latitude));
    const maxPtLat = Math.max(...allPts.map(p => p.latitude));
    const minPtLon = Math.min(...allPts.map(p => p.longitude));
    const maxPtLon = Math.max(...allPts.map(p => p.longitude));
    const spanLat = maxPtLat - minPtLat;
    const spanLon = maxPtLon - minPtLon;
    const adaptiveMargin = Math.min(
      this.config.routingBBoxMaxExtent,
      Math.max(
        this.config.routingBBoxMargin,
        spanLat * 0.3,
        spanLon * 0.2,
      ),
    );

    for (let i = 0; i < via.length; i++) {
      let nextPoint: { latitude: number; longitude: number; mode?: LegMode } = via[i];
      const legEnv = env ? { ...env, offsetSec: elapsedSec } : undefined;
      let segmentResult: RouteResult | null;
      if (nextPoint.mode === 'manual') {
        // User-drawn straight line, bypassing the graph. The endpoint snaps to
        // a nearby graph node (when one exists) so a following auto leg picks
        // up exactly where the manual line ends.
        const manual = await this.buildManualLeg(currentStart, nextPoint, `Via point ${i + 1}`, warnings);
        segmentResult = manual.route;
        nextPoint = { ...nextPoint, ...manual.snappedEnd };
      } else {
        const segmentBbox = bboxFromPoints(
          currentStart, nextPoint,
          adaptiveMargin,
        );
        segmentResult = await this.tryRouteSegment(
          currentStart.latitude, currentStart.longitude,
          nextPoint.latitude, nextPoint.longitude,
          coastDistanceMeters,
          i, warnings, dims,
          segmentBbox,
          legEnv,
        );
      }
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

      allSegments.push(...segmentResult.features[0].properties.segments!);
      totalDistanceMeters += segmentResult.features[0].properties.totalDistance ?? 0;
      totalCostAccum += segmentResult.features[0].properties.totalCost ?? 0;
      elapsedSec = this.annotateSegmentTimes(
        segmentResult.features[0].geometry.coordinates,
        segmentResult.features[0].properties.segments!,
        env, elapsedSec,
      );
      currentStart = nextPoint;
    }

    let finalResult: RouteResult | null;
    if (endMode === 'manual') {
      // Final leg drawn by hand — end exactly at the user's destination
      // (no node snapping; there is no following leg to pick up from it).
      finalResult = (await this.buildManualLeg(currentStart, end, 'Destination', warnings, false)).route;
    } else {
      const finalBbox = bboxFromPoints(
        currentStart, end,
        adaptiveMargin,
      );
      finalResult = await this.tryRouteSegment(
        currentStart.latitude, currentStart.longitude,
        end.latitude, end.longitude,
        coastDistanceMeters,
        -1, warnings, dims,
        finalBbox,
        env ? { ...env, offsetSec: elapsedSec } : undefined,
      );
    }

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
    allSegments.push(...finalResult.features[0].properties.segments!);
    totalDistanceMeters += finalResult.features[0].properties.totalDistance ?? 0;
    totalCostAccum += finalResult.features[0].properties.totalCost ?? 0;

    const allWarnings = [...warnings, ...(globalWarnings || [])];

    const result: RouteResult = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: allCoordinates },
        properties: {
          totalDistance: totalDistanceMeters,
          totalCost: totalCostAccum,
          segments: allSegments,
        },
      }],
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    };

    // Connect only the overall end coordinate (start is handled per-segment above)
    await this.connectUserPoint(end, result, 'end');

    await this.finalizeRoute(result, via, env);
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
    dims: VesselDimensions,
    bbox?: BBox,
    env?: RouteEnv,
  ): Promise<RouteResult | null> {
    const label = viaIndex >= 0 ? `Via point ${viaIndex + 1}` : 'Destination';
    const startPt = { latitude: startLat, longitude: startLon };
    const endPt = { latitude: endLat, longitude: endLon };

    let currentMargin = this.config.routingBBoxMargin;
    const segmentMaxMargin = this.config.routingBBoxMaxExtent;

    while (currentMargin <= segmentMaxMargin) {
      const segmentBbox = bbox ?? bboxFromPoints(startPt, endPt, currentMargin);
      try {
        const result = await this.astarSearch(startLat, startLon, endLat, endLon, coastDistanceMeters, dims, segmentBbox, env);
        this.addViolationWarnings(result, warnings, label, startPt, endPt, dims);
        return result;
      } catch {
        bbox = undefined;
        if (currentMargin >= segmentMaxMargin) break;
        const newMargin = Math.min(currentMargin * 2, segmentMaxMargin);
        if (newMargin > currentMargin) {
          console.log(`Route search for ${label} expanded from ${(currentMargin * 111).toFixed(0)}km to ${(newMargin * 111).toFixed(0)}km bounding box`);
        }
        currentMargin = newMargin;
      }
    }

    // A* failed entirely — graph is physically disconnected. Bridge the gap.
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
        const fallback = await this.fallbackRoute(startNode, endNode, startPt, endPt, coastDistanceMeters, [], dims);
        if (fallback.warnings) {
          warnings.push(...fallback.warnings);
          fallback.warnings = undefined;
        }
        return fallback;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Build a manual (user-drawn) leg: a straight rhumb line from `from` to
   * `to`, bypassing the A* graph entirely. When `snapEnd` is true (default)
   * the endpoint is snapped to the nearest graph node within
   * MANUAL_SNAP_RADIUS_M so a following auto leg picks up seamlessly — the
   * caller must continue from the returned `snappedEnd`.
   *
   * The segment carries no depth/air-draft data (mode:'manual', minDepth -1)
   * — the user takes responsibility for its navigability. A line-of-sight
   * sample against the graph flags likely land crossings as a warning.
   */
  private async buildManualLeg(
    from: { latitude: number; longitude: number },
    to: { latitude: number; longitude: number },
    label: string,
    warnings: RouteWarning[],
    snapEnd: boolean = true,
  ): Promise<{ route: RouteResult; snappedEnd: { latitude: number; longitude: number } }> {
    const MANUAL_SNAP_RADIUS_M = 150;
    let endLat = to.latitude;
    let endLon = to.longitude;
    let endNodeId = -1;

    if (snapEnd) {
      const nearId = await this.db.findNearestNode(to.latitude, to.longitude, MANUAL_SNAP_RADIUS_M);
      if (nearId != null) {
        const node = await this.db.getNodeById(nearId);
        if (node) {
          endLat = node.lat;
          endLon = node.lon;
          endNodeId = nearId;
        }
      }
    }

    const distance = Math.round(
      this.haversineDistance(from.latitude, from.longitude, endLat, endLon),
    );

    // Best-effort land check: sample the straight line against the graph.
    // Manual mode exists precisely for areas with poor graph coverage, so
    // this can only ever be a warning, never a rejection.
    const samples = Math.max(5, Math.min(40, Math.round(distance / 200)));
    if (distance > 20 && this.db.isLineCrossingLand(from.latitude, from.longitude, endLat, endLon, samples)) {
      warnings.push({
        type: 'manual_segment',
        message: `Manual leg to ${label.toLowerCase()} may cross land or uncharted water — verify against the chart.`,
        from: { latitude: from.latitude, longitude: from.longitude },
        to: { latitude: endLat, longitude: endLon },
        distanceMeters: distance,
      });
    }

    const route: RouteResult = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [from.longitude, from.latitude],
            [endLon, endLat],
          ],
        },
        properties: {
          totalDistance: distance,
          totalCost: distance,
          segments: [{
            from: -1,
            to: endNodeId,
            distance,
            minDepth: -1,
            maxAirDraft: -1,
            costFactor: 1.0,
            trafficMode: TRAFFIC_TWO_WAY,
            mode: 'manual',
          }],
        },
      }],
    };

    return { route, snappedEnd: { latitude: endLat, longitude: endLon } };
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
    const segments = route.features[0].properties.segments!;

    const markOverland = (segIdx: number, fromLon: number, fromLat: number, toLon: number, toLat: number) => {
      if (!this.config.lineOfSightSearchRadius) return;
      const seg = segments[segIdx];
      if (!seg) return;
      const overland = (this.db as any).isLineCrossingLand &&
        (this.db as any).isLineCrossingLand(fromLat, fromLon, toLat, toLon, 5);
      if (overland) {
        seg.minDepth = 0;
      }
    };
    if (coords.length === 0) return;

    if (position === 'start') {
      const firstCoord = coords[0];
      const directDist = this.haversineDistance(userPoint.latitude, userPoint.longitude, firstCoord[1], firstCoord[0]);
      if (directDist <= 1) return;

      // Project user onto the first route edge (coords[0] → coords[1])
      // and split the edge at that point so the connection doesn't backtrack.
      let didSplit = false;
      if (coords.length >= 2) {
        const secondCoord = coords[1];
        const proj = this.db.projectOnEdge(
          firstCoord[0], firstCoord[1],
          secondCoord[0], secondCoord[1],
          userPoint.longitude, userPoint.latitude,
        );

        if (proj.distance < directDist && proj.fraction > 0.01 && proj.fraction < 0.99) {
          const firstSeg = segments[0];
          const portionDist = firstSeg ? Math.round(firstSeg.distance * (1 - proj.fraction)) : 0;

          // Replace the first route coordinate with the projection point P
          coords[0] = [proj.point.lon, proj.point.lat];
          // Prepend user position
          coords.unshift([userPoint.longitude, userPoint.latitude]);

          // Replace first segment with the edge portion P → secondCoord
          segments[0] = {
            from: -1, to: firstSeg?.to ?? -1,
            distance: portionDist,
            minDepth: firstSeg?.minDepth ?? -1,
            maxAirDraft: firstSeg?.maxAirDraft ?? -1,
            costFactor: firstSeg?.costFactor ?? 1.2,
            trafficMode: firstSeg?.trafficMode ?? TRAFFIC_TWO_WAY,
            edgeTypeId: firstSeg?.edgeTypeId,
          };
          // Prepend over-land segment user → P
          segments.unshift({
            from: -1, to: -1,
            distance: Math.round(proj.distance),
            minDepth: -1, maxAirDraft: -1,
            costFactor: 1.2,
            trafficMode: TRAFFIC_TWO_WAY,
          });

          markOverland(0, userPoint.longitude, userPoint.latitude, proj.point.lon, proj.point.lat);
          route.features[0].properties.totalDistance! += Math.round(proj.distance);

          if (!route.warnings) route.warnings = [];
          route.warnings.push({
            type: 'start_connecting',
            message: `${Math.round(proj.distance)}m from start to the nearest waterway edge.`,
            from: { latitude: userPoint.latitude, longitude: userPoint.longitude },
            to: { latitude: secondCoord[1], longitude: secondCoord[0] },
            distanceMeters: Math.round(proj.distance),
          });

          didSplit = true;
        }
      }

      if (!didSplit) {
        // Fall back to straight line
        coords.unshift([userPoint.longitude, userPoint.latitude]);
        segments.unshift({
          from: -1, to: -1,
          distance: Math.round(directDist),
          minDepth: -1, maxAirDraft: -1,
          costFactor: 1.2,
          trafficMode: TRAFFIC_TWO_WAY,
        });
        markOverland(0, userPoint.longitude, userPoint.latitude, firstCoord[0], firstCoord[1]);
        route.features[0].properties.totalDistance! += Math.round(directDist);
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

      // ── Try truncation: project end point onto the last graph edge ─────
      // If the last route segment's edge passes close to the end point, we
      // can truncate that edge at the projection and avoid overshooting.
      const lastSegIdx = segments.length - 1;
      let didTruncate = false;

      if (lastSegIdx >= 0) {
        const lastSeg = segments[lastSegIdx];
        if (lastSeg.from >= 0 && lastSeg.to >= 0) {
          const segFrom = this.db.getNodeSync(lastSeg.from);
          const segTo = this.db.getNodeSync(lastSeg.to);
          if (segFrom && segTo) {
            const proj = this.db.projectOnEdge(
              segFrom.lon, segFrom.lat, segTo.lon, segTo.lat,
              userPoint.longitude, userPoint.latitude,
            );
            if (proj.fraction > 0.02 && proj.fraction < 0.98 && proj.distance < directDist * 0.7) {
              const truncatedDist = Math.round(lastSeg.distance * proj.fraction);

              // Replace last coord with the projection, then add the real end
              coords[coords.length - 1] = [proj.point.lon, proj.point.lat];
              coords.push([userPoint.longitude, userPoint.latitude]);

              segments[lastSegIdx] = {
                from: lastSeg.from,
                to: -1,
                distance: truncatedDist,
                minDepth: lastSeg.minDepth,
                maxAirDraft: lastSeg.maxAirDraft,
                costFactor: lastSeg.costFactor,
                trafficMode: lastSeg.trafficMode,
                edgeTypeId: lastSeg.edgeTypeId,
              };

              segments.push({
                from: -1, to: -1,
                distance: Math.round(proj.distance),
                minDepth: -1, maxAirDraft: -1,
                costFactor: 1.2,
                trafficMode: TRAFFIC_TWO_WAY,
              });
              markOverland(segments.length - 1, proj.point.lon, proj.point.lat, userPoint.longitude, userPoint.latitude);

              route.features[0].properties.totalDistance! += Math.round(truncatedDist + proj.distance - lastSeg.distance);

              if (!route.warnings) route.warnings = [];
              route.warnings.push({
                type: 'end_connecting',
                message: `${Math.round(proj.distance)}m from nearest waterway edge to destination.`,
                from: { latitude: proj.point.lat, longitude: proj.point.lon },
                to: { latitude: userPoint.latitude, longitude: userPoint.longitude },
                distanceMeters: Math.round(proj.distance),
              });
              didTruncate = true;
            }
          }
        }
      }

      const edgeSnap = await this.db.findNearestEdge(userPoint.latitude, userPoint.longitude);
      if (!didTruncate && edgeSnap && edgeSnap.distance < directDist && edgeSnap.fraction > 0.01 && edgeSnap.fraction < 0.99) {
        // ── Append path (existing fallback) ──────────────────────────────
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
            costFactor: edgeSnap.edge.cost_factor,
            trafficMode: edgeSnap.edge.traffic_mode,
            edgeTypeId: edgeSnap.edge.edge_type_id,
          },
          {
            from: -1, to: -1,
            distance: Math.round(edgeSnap.distance),
            minDepth: -1, maxAirDraft: -1,
            costFactor: 1.2,
            trafficMode: TRAFFIC_TWO_WAY,
          },
        );
        markOverland(segments.length - 1, edgeSnap.point.lon, edgeSnap.point.lat, userPoint.longitude, userPoint.latitude);
        // Delta = travel from last route node to snap point + snap point to user.
        // edgePortion (fraction of the last edge) is already counted in the route cost; don't add it again.
        route.features[0].properties.totalDistance! += Math.round(edgeSnap.distance + nodeToSnap);
        if (!route.warnings) route.warnings = [];
        route.warnings.push({
          type: 'end_connecting',
          message: `${Math.round(edgeSnap.distance)}m from nearest waterway edge to destination (via edge projection).`,
          from: { latitude: lastCoord[1], longitude: lastCoord[0] },
          to: { latitude: userPoint.latitude, longitude: userPoint.longitude },
          distanceMeters: Math.round(nodeToSnap),
        });
      } else if (!didTruncate) {
        // Fall back to straight line
        coords.push([userPoint.longitude, userPoint.latitude]);
        segments.push({
          from: -1, to: -1,
          distance: Math.round(directDist),
          minDepth: -1, maxAirDraft: -1,
          costFactor: 1.2,
          trafficMode: TRAFFIC_TWO_WAY,
        });
        markOverland(segments.length - 1, lastCoord[0], lastCoord[1], userPoint.longitude, userPoint.latitude);
        route.features[0].properties.totalDistance! += Math.round(directDist);
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
    dims: VesselDimensions,
    bbox?: BBox,
    env?: RouteEnv,
  ): Promise<RouteResult> {
    let startNode = await this.db.findNearestNode(startLat, startLon);
    let endNode = await this.db.findNearestNode(endLat, endLon);

    if (!startNode || !endNode) {
      throw new Error('Could not find routing nodes near start or end point');
    }

    const minDepth = (dims.draft || 2.0) + this.config.safetyMarginDraft;

    const bearingDeg = (fromLat: number, fromLon: number, toLat: number, toLon: number): number => {
      const dLon = (toLon - fromLon) * Math.PI / 180;
      const lat1 = fromLat * Math.PI / 180;
      const lat2 = toLat * Math.PI / 180;
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    };

    const improveNode = async (node: number, nodeLat: number, nodeLon: number, label: string): Promise<number> => {
      const nodePos = this.db.getNodeSync(node);
      if (!nodePos) return node;
      const edges = await this.db.getOutgoingEdges(node);
      // For end nodes with no outgoing edges, the node is still valid as a destination.
      // For start nodes with no outgoing edges, we must find an alternative.
      if (edges.length === 0 && label !== 'Start') return node;

      if (label === 'Start') {
        // For start nodes: check if all edges leading toward the destination are shallow.
        // Compute bearing from start point to destination; then for each edge to its target,
        // if the edge direction is within 90° of the destination bearing and is deep, keep the node.
        const destBearing = bearingDeg(nodePos.lat, nodePos.lon, endLat, endLon);
        let anyTowardDeep = false;
        for (const e of edges) {
          const edgeBearing = bearingDeg(nodePos.lat, nodePos.lon, e.lat, e.lon);
          const bearingDiff = Math.abs(edgeBearing - destBearing);
          const towardDest = Math.min(bearingDiff, 360 - bearingDiff) < 90;
          const isDeep = e.min_depth < 0 || e.min_depth >= minDepth;
          if (towardDest && isDeep) {
            anyTowardDeep = true;
            break;
          }
        }
        if (anyTowardDeep) return node;
      } else {
        // For end nodes: keep the original logic — if all outgoing edges are shallow, improve.
        const allShallow = edges.every(e => typeof e.min_depth === 'number' && e.min_depth >= 0 && e.min_depth < minDepth);
        if (!allShallow) return node;
      }

      // Search radius: 2000m for start (need to find a fundamentally better entry), 1000m for end
      const radius = label === 'Start' ? 2000 : 1000;
      const candidates = await this.db.getNodesInRadius(nodeLat, nodeLon, radius);
      let best = node;
      let bestDist = Infinity;
      for (const c of candidates) {
        if (c.id === node) continue;
        const cEdges = await this.db.getOutgoingEdges(c.id);
        if (cEdges.length === 0) continue; // skip dead-end candidates for start node
        const hasDeep = cEdges.some(e => e.min_depth < 0 || e.min_depth >= minDepth);
        if (hasDeep && c.distance < bestDist) {
          bestDist = c.distance;
          best = c.id;
        }
      }
      if (best !== node) {
        console.log(`[autoroute] ${label} node ${node} → ${best} (better depth, ${Math.round(bestDist)}m away)`);
      }
      return best;
    };

    const improvedEnd = await improveNode(endNode, endLat, endLon, 'End');
    if (improvedEnd !== endNode) {
      endNode = improvedEnd;
    }
    const improvedStart = await improveNode(startNode, startLat, startLon, 'Start');
    if (improvedStart !== startNode) {
      startNode = improvedStart;
    }

    // Expand bbox to include the actual snapped node coordinates so the
    // strict isInsideBBox check below never rejects a valid start/end node.
    if (bbox) {
      const snapStart = await this.db.getNodeById(startNode);
      const snapEnd = await this.db.getNodeById(endNode);
      if (snapStart) {
        bbox.minLat = Math.min(bbox.minLat, snapStart.lat);
        bbox.maxLat = Math.max(bbox.maxLat, snapStart.lat);
        bbox.minLon = Math.min(bbox.minLon, snapStart.lon);
        bbox.maxLon = Math.max(bbox.maxLon, snapStart.lon);
      }
      if (snapEnd) {
        bbox.minLat = Math.min(bbox.minLat, snapEnd.lat);
        bbox.maxLat = Math.max(bbox.maxLat, snapEnd.lat);
        bbox.minLon = Math.min(bbox.minLon, snapEnd.lon);
        bbox.maxLon = Math.max(bbox.maxLon, snapEnd.lon);
      }
    }

    // A* data structures
    const openSet = new MinHeap<SearchState>((state) => state.f);
    const closedSet = new Set<number>();
    const gScore = new Map<number, number>();
    const parent = new Map<number, number | null>();
    // Elapsed sailing seconds from the (sub-)route departure per settled node —
    // used to sample the tidal flow field at the right moment.
    const tSec = new Map<number, number>();

    // Minimum possible cost multiplier — ensures A* heuristic never overestimates.
    // 0.8 is the fairway cost_factor floor; if custom edges go lower, update this.
    // With tides, an edge's effective distance can shrink to STW/(STW+maxCurrent)
    // of its length on a fully fair current — fold that into the heuristic bound.
    const minMultiplier = 0.8 * (env
      ? env.speedMs / (env.speedMs + env.flow.maxSpeedMs)
      : 1);

    // Initialize
    gScore.set(startNode, 0);
    tSec.set(startNode, 0);
    openSet.push({
      nodeId: startNode,
      g: 0,
      f: this.haversineDistance(startLat, startLon, endLat, endLon) * minMultiplier,
      parent: null,
    });

    let goalReached = false;
    let iterations = 0;
    const maxIterations = 5000000; // Safety limit (5000K suffices for trans-continental routes like NL→Italy ~2000nm)

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

        // Apply soft safety constraints
        const penalty = this.getEdgePenalty(edge, minCoastDistanceMeters, dims);
        if (penalty === -1) {
          continue;
        }

        // Tidal current: scale the edge to an "effective distance" so all
        // existing cost factors and penalties keep their meaning. A fair
        // current shortens the edge, a foul one lengthens it; with tides off
        // (env undefined) this is a no-op and results match the old engine.
        let effDistance = edge.distance;
        let edgeSeconds = 0;
        if (env) {
          const fromNode = this.db.getNodeSync(current.nodeId);
          const elapsed = tSec.get(current.nodeId) ?? 0;
          let sog = env.speedMs;
          if (fromNode) {
            const flow = env.flow.sample(
              (fromNode.lat + edge.lat) / 2,
              (fromNode.lon + edge.lon) / 2,
              env.departureMs + (env.offsetSec + elapsed) * 1000,
            );
            if (flow.u !== 0 || flow.v !== 0) {
              const brg = this.toRadians(bearingDeg(fromNode.lat, fromNode.lon, edge.lat, edge.lon));
              const along = flow.u * Math.sin(brg) + flow.v * Math.cos(brg);
              // Never let a foul current make an edge impossible — floor SOG
              // at 20% of STW (matches the annotation in finalizeRoute).
              sog = Math.max(0.2 * env.speedMs, env.speedMs + along);
            }
          }
          effDistance = edge.distance * env.speedMs / sog;
          edgeSeconds = edge.distance / sog;
        }

        const baseCost = this.calculateEdgeCost(edge, effDistance);
        const edgeCost = baseCost + (penalty * Math.max(1, edge.distance));

        const tentativeG = gScore.get(current.nodeId)! + edgeCost;

        if (!gScore.has(edge.target) || tentativeG < gScore.get(edge.target)!) {
          gScore.set(edge.target, tentativeG);
          parent.set(edge.target, current.nodeId);
          if (env) tSec.set(edge.target, (tSec.get(current.nodeId) ?? 0) + edgeSeconds);

          const h = this.haversineDistance(
            edge.lat,
            edge.lon,
            endLat,
            endLon
          ) * minMultiplier;

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
        `Try reducing minCoastDistance or checking vessel dimensions (draft=${dims.draft}m, beam=${dims.beam}m, airDraft=${dims.airDraft}m).`
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

  private getEdgePenalty(edge: EdgeRow & { lat: number; lon: number }, minCoastDistanceMeters: number, dims: VesselDimensions): number {
    if (edge.crosses_land === 1) return -1;
    if (edge.crosses_obstacle === 1) return -1;

    let penalty = 0;

    if (typeof edge.max_air_draft === 'number' && edge.max_air_draft >= 0 && edge.max_air_draft < (dims.airDraft || 0) + this.config.safetyMarginAirDraft) {
      penalty += 1000000;
    }

    const minDepth = (dims.draft || 2.0) + this.config.safetyMarginDraft;
    if (typeof edge.min_depth === 'number' && edge.min_depth >= 0 && edge.min_depth < minDepth) penalty += 1000000;
    if (typeof edge.min_width === 'number' && edge.min_width >= 0 && edge.min_width < (dims.beam || 4.0) + this.config.safetyMarginBeam) penalty += 1000000;
    if (edge.edge_type_id === EDGE_TYPE_COASTAL && edge.distance_to_land < minCoastDistanceMeters) penalty += 50000;

    return penalty;
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
    if (!this.config.lineOfSightSearchRadius) {
      return true;
    }
    const dist = this.haversineDistance(lat1, lon1, lat2, lon2);

    // Cap samples so very long LOS candidates don't stall the smoother.
    // 50m spacing gives fine resolution; 60 samples caps at ~3 km per check.
    const numSamples = Math.min(60, Math.max(3, Math.ceil(dist / 50)));

    if ((this.db as any).isLineCrossingLand && (this.db as any).isLineCrossingLand(lat1, lon1, lat2, lon2, numSamples)) {
        return false;
    }

    const searchRadius = this.config.lineOfSightSearchRadius;
    for (let i = 1; i < numSamples; i++) {
      const t = i / numSamples;
      // Pure linear interpolation in degree-space: this correctly places points
      // along the straight segment between the two graph nodes. Cosine correction
      // belongs only in distance measurement (haversineDistance), not here —
      // applying it to lon would displace samples off the actual path.
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
   * Cost = Distance × CostFactor × OneWayPenalty
   *
   * `effectiveDistance` defaults to the edge length; tide-aware search passes
   * the current-adjusted equivalent (distance × STW / SOG) instead.
   */
  private calculateEdgeCost(edge: EdgeRow & { lat: number; lon: number }, effectiveDistance?: number): number {
    let cost = (effectiveDistance ?? edge.distance) * edge.cost_factor;

    // One-way penalty: traffic_mode=2 means only reverse direction (target→source)
    // is allowed, so traversing source→target is wrong-way.
    if (edge.traffic_mode === TRAFFIC_ONE_WAY_REV) {
      cost *= 1e6; // virtually impassable wrong-way
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
   * Finalize a computed single-feature route for delivery: detect crossings
   * (when a merge dropped them), derive the simplified navigable waypoints and
   * the annotated itinerary, then split into per-segment features.
   * Must be called exactly once, as the last step of every successful route.
   */
  private async finalizeRoute(
    route: RouteResult,
    via: Array<{ latitude: number; longitude: number }> = [],
    env?: RouteEnv,
  ): Promise<void> {
    const feature = route.features[0];
    if (!feature || feature.geometry.coordinates.length < 2) return;
    const coords = feature.geometry.coordinates;
    const segments = feature.properties.segments || [];

    // Sailing time & estimated current per segment (covers segments added by
    // connectUserPoint too — this runs after all geometry mutations).
    const totalSec = this.annotateSegmentTimes(coords, segments, env, 0);
    route.totalSeconds = Math.round(totalSec);
    if (env) {
      const totalDistance = feature.properties.totalDistance
        ?? segments.reduce((s, seg) => s + (seg.distance || 0), 0);
      route.totalSecondsNoTide = Math.round(totalDistance / env.speedMs);
      route.departureTime = new Date(env.departureMs).toISOString();
      route.arrivalTime = new Date(env.departureMs + totalSec * 1000).toISOString();
      route.tide = {
        enabled: true,
        estimated: env.flow.estimated,
        source: env.flow.source,
        stations: env.flow.stations.map((s) => s.name),
      };
    }

    // Via-point routes are merged from sub-results and lose the per-segment
    // crossings detected in buildRouteResult — recover them here.
    if (!route.crossings) {
      const crossings = await this.detectCrossings(coords);
      if (crossings.length > 0) route.crossings = crossings;
    }

    const { waypoints, itinerary } = buildItinerary(
      coords,
      segments,
      route.crossings || [],
      via,
      this.config.waypointTolerance ?? 30,
    );
    route.waypoints = waypoints;
    route.itinerary = itinerary;

    this.splitToSegmentFeatures(route);
  }

  /**
   * Annotate each path segment with sailing seconds and (when a flow field is
   * active) the estimated along-track current and SOG, sampling the field at
   * the vessel's actual passage time. Returns the cumulative seconds at the
   * end of the path (startOffsetSec + sailing time).
   */
  private annotateSegmentTimes(
    coords: Array<[number, number]>,
    segments: NonNullable<RouteResult['features'][0]['properties']['segments']>,
    env: RouteEnv | undefined,
    startOffsetSec: number,
  ): number {
    const speedMs = env?.speedMs ?? Math.max(0.5, this.config.averageSpeedKnots) * KNOTS_TO_MS;
    let cum = startOffsetSec;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const from = coords[i];
      const to = coords[i + 1];
      let sog = speedMs;
      if (env && from && to) {
        const flow = env.flow.sample(
          (from[1] + to[1]) / 2,
          (from[0] + to[0]) / 2,
          env.departureMs + cum * 1000,
        );
        if (flow.u !== 0 || flow.v !== 0) {
          const brg = this.toRadians(bearingDeg(from[1], from[0], to[1], to[0]));
          const along = flow.u * Math.sin(brg) + flow.v * Math.cos(brg);
          sog = Math.max(0.2 * speedMs, speedMs + along);
          seg.currentKn = Math.round((along / KNOTS_TO_MS) * 100) / 100;
          seg.sogKn = Math.round((sog / KNOTS_TO_MS) * 100) / 100;
        }
      }
      const sec = (seg.distance || 0) / sog;
      seg.seconds = Math.round(sec * 10) / 10;
      cum += sec;
    }
    return cum;
  }

  /**
   * Split a single-feature route (LineString + segments array) into individual
   * per-segment features so the frontend can color each segment independently
   * based on its minDepth / maxAirDraft properties.
   */
  private splitToSegmentFeatures(route: RouteResult): void {
    const feature = route.features[0];
    const segments = feature.properties.segments;
    if (!feature || !segments || segments.length === 0) return;

    const coords = feature.geometry.coordinates;
    const totalDistance = feature.properties.totalDistance!;
    const totalCost = feature.properties.totalCost!;
    const crossings = route.crossings;

    const segmentFeatures: RouteResult['features'] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const fromCoord = coords[i];
      const toCoord = coords[i + 1];
      if (!fromCoord || !toCoord) continue;

      const segmentProps: Record<string, any> = {
        minDepth: seg.minDepth,
        maxAirDraft: seg.maxAirDraft,
        costFactor: seg.costFactor,
        trafficMode: seg.trafficMode,
        edgeTypeId: seg.edgeTypeId,
        distance: seg.distance,
        ...(seg.mode !== undefined ? { mode: seg.mode } : {}),
        ...(seg.seconds !== undefined ? { seconds: seg.seconds } : {}),
        ...(seg.currentKn !== undefined ? { currentKn: seg.currentKn, sogKn: seg.sogKn } : {}),
      };

      segmentFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [fromCoord, toCoord],
        },
        properties: segmentProps as any,
      });
    }

    route.features = segmentFeatures;
    route.totalDistance = totalDistance;
    route.totalCost = totalCost;
    if (crossings) route.crossings = crossings;
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
            minWidth: edge.min_width,
            costFactor: edge.cost_factor,
            trafficMode: edge.traffic_mode,
            edgeTypeId: edge.edge_type_id,
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
              costFactor: 1.2,
              trafficMode: TRAFFIC_TWO_WAY,
            });
          }
        }
      }
    }

    const crossings = await this.detectCrossings(coordinates);

    return {
      type: 'FeatureCollection',
      crossings: crossings.length > 0 ? crossings : undefined,
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

  private async detectCrossings(coordinates: [number, number][]): Promise<RouteCrossing[]> {
    if (coordinates.length === 0) return [];

    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [lon, lat] of coordinates) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    const MARGIN = 0.002;
    const pois = await this.db.getPoisInBBox(
      minLat - MARGIN, minLon - MARGIN,
      maxLat + MARGIN, maxLon + MARGIN,
    );

    const bridgePois = pois.filter(p => p.typeId === POI_TYPE_BRIDGE);
    const lockPois = pois.filter(p => p.typeId === POI_TYPE_LOCK);
    const crossings: RouteCrossing[] = [];
    const seenIds = new Set<number>();
    const seenCrossingKeys = new Set<string>();
    const MAX_DIST = 150;
    const crossingKey = (poi: typeof bridgePois[0]): string => {
      const subtype = (poi.properties as Record<string, unknown>)?.subtype as string | undefined;
      return `${poi.name}|${poi.typeId}|${subtype || ''}`;
    };

    for (const [lon, lat] of coordinates) {
      for (const poi of bridgePois) {
        if (seenIds.has(poi.id)) continue;
        if (this.haversineDistance(lat, lon, poi.lat, poi.lon) <= MAX_DIST) {
          seenIds.add(poi.id);
          const key = crossingKey(poi);
          if (seenCrossingKeys.has(key)) continue;
          seenCrossingKeys.add(key);
          crossings.push({
            type: 'bridge',
            name: poi.name,
            subtype: (poi.properties as Record<string, unknown>)?.subtype as string | undefined,
            height: (poi.properties as Record<string, unknown>)?.height as number | undefined,
            position: { latitude: poi.lat, longitude: poi.lon },
          });
        }
      }
      for (const poi of lockPois) {
        if (seenIds.has(poi.id)) continue;
        if (this.haversineDistance(lat, lon, poi.lat, poi.lon) <= MAX_DIST) {
          seenIds.add(poi.id);
          const key = crossingKey(poi);
          if (seenCrossingKeys.has(key)) continue;
          seenCrossingKeys.add(key);
          crossings.push({
            type: 'lock',
            name: poi.name,
            position: { latitude: poi.lat, longitude: poi.lon },
          });
        }
      }
    }

    return crossings;
  }

  private addViolationWarnings(
    result: RouteResult,
    warnings: RouteWarning[],
    label: string,
    startPt: { latitude: number; longitude: number },
    endPt: { latitude: number; longitude: number },
    dims: VesselDimensions,
  ) {
    if (!result.features[0] || !result.features[0].properties.segments) return;
    const coords = result.features[0].geometry.coordinates;
    const segments = result.features[0].properties.segments!;
    const minDepth = (dims.draft || 2.0) + this.config.safetyMarginDraft;
    const airDraft = (dims.airDraft || 0) + this.config.safetyMarginAirDraft;

    let totalViolationSegments = 0;
    let totalViolationDist = 0;
    let worstDepth = Infinity;
    let worstAirDraft = Infinity;
    let firstFromCoord: number[] | null = null;
    let lastToCoord: number[] | null = null;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const depthViolation = seg.minDepth >= 0 && seg.minDepth < minDepth;
      const airDraftViolation = seg.maxAirDraft >= 0 && seg.maxAirDraft < airDraft;

      if (depthViolation || airDraftViolation) {
        const fromCoord = coords[i];
        const toCoord = coords[i + 1];
        if (!fromCoord || !toCoord) continue;

        totalViolationSegments++;
        totalViolationDist += seg.distance || 0;
        if (depthViolation && seg.minDepth < worstDepth) worstDepth = seg.minDepth;
        if (airDraftViolation && seg.maxAirDraft < worstAirDraft) worstAirDraft = seg.maxAirDraft;
        if (!firstFromCoord) firstFromCoord = fromCoord;
        lastToCoord = toCoord;
      }
    }

    if (totalViolationSegments > 0 && firstFromCoord && lastToCoord) {
      const reasons: string[] = [];
      if (worstDepth < Infinity) reasons.push(`depth ${worstDepth.toFixed(1)}m < required ${minDepth}m`);
      if (worstAirDraft < Infinity) reasons.push(`air draft ${worstAirDraft.toFixed(1)}m < required ${airDraft}m`);
      const distNm = totalViolationDist / 1852;
      warnings.push({
        type: 'via_constrained',
        message: `Route to ${label}: constrained for ${totalViolationSegments} leg(s) ${distNm.toFixed(1)}Nm — ${reasons.join('; ')}`,
        from: { latitude: firstFromCoord[1], longitude: firstFromCoord[0] },
        to: { latitude: lastToCoord[1], longitude: lastToCoord[0] },
        distanceMeters: totalViolationDist,
      });
    }
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
    if (path.length <= 2 || !this.config.lineOfSightSearchRadius) return path;

    const smoothed: number[] = [path[0]];
    let i = 0;

    const nodeMap = new Map<number, any>();
    for (const id of path) {
      const n = await this.db.getNodeById(id);
      nodeMap.set(id, n);
    }

    // Lookahead cap: any LOS shortcut spanning > 300 graph nodes covers hundreds
    // of km and is very unlikely to be valid. Capping avoids O(N²) worst case.
    const MAX_LOOKAHEAD = 300;

    while (i < path.length - 1) {
      const maxJ = Math.min(path.length - 1, i + MAX_LOOKAHEAD);
      let j = maxJ;
      while (j > i + 1) {
        let skippingInland = false;
        for (let k = i + 1; k < j; k++) {
          if (getNodeTypeInt(path[k]) === NODE_TYPE_INLAND) {
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