/**
 * A* Pathfinding Engine for Nautical Routing
 * Implements vessel-aware directed A* with multi-layered cost function
 */

import { EdgeRow, RoutingDatabase, getNodeTypeInt, NODE_TYPE_INLAND, EDGE_TYPE_COASTAL, POI_TYPE_BRIDGE, POI_TYPE_LOCK, TRAFFIC_TWO_WAY, TRAFFIC_ONE_WAY_REV } from './database.js';
import type { FunnelResult, NavmeshRegion } from './navmesh.js';
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

// A "successful" A* search can still be a bad route: getEdgePenalty adds a
// per-meter violation surcharge for soft constraints (air draft, depth,
// width — see VIOLATION_RATE_CONSTRAINT/VIOLATION_RATE_COAST below) so a
// route through a forbidden edge is technically findable but expensive
// rather than rejected outright. A tight bounding box can hide the real,
// unconstrained route while still leaving a penalized one reachable inside
// the box, which used to return silently wrong routes: the bbox-expansion
// retry below only ever triggered on "no route found", never on "found a
// terrible one".
//
// Round 13-18 detected this ("materially penalized") by comparing cost to
// distance × a flat factor. That broke once penalties became rate-based
// (Round 19): the flat +1,000,000-per-violation constant used to dwarf any
// plausible unpenalized cost on its own, so a cost/distance ratio was a
// reliable tripwire; a bounded per-meter rate does not blow past any fixed
// ratio the same way, and coast-distance violations (a soft comfort
// preference, not a hard constraint) legitimately fire on many otherwise
// fine routes and would make a ratio-based check trigger the retry almost
// unconditionally near any coastline.
//
// So detection is now explicit rather than magnitude-based: see
// pathViolationMeters, which walks the winning path's segments and sums the
// length of any depth/air-draft/beam violation (coast-distance excluded on
// purpose — see its doc comment). The retry triggers whenever that sum is
// nonzero, i.e. the route touches even one hard-constraint-violating edge.

// A* search state
interface SearchState {
  nodeId: number;
  g: number; // actual cost from start
  f: number; // estimated total cost (g + h)
  parent: number | null;
}

// Tally of why edges were skipped/penalized during a search, so a failed
// route can report its actual cause instead of a generic constraint guess.
interface SearchSkipReasons {
  land: number;
  obstacle: number;
  airDraft: number;
  draft: number;
  beam: number;
  coastDistance: number;
  bbox: number;
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

  peek(): T | undefined {
    return this.data[0];
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
  private _config: PluginConfig;
  private vesselDimensions: VesselDimensions;
  private tides: TidesClient | null = null;
  private currents: CurrentsClient | null = null;

  constructor(db: RoutingDatabase, config: PluginConfig, vesselDimensions?: VesselDimensions) {
    this.db = db;
    this._config = config;
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

  get config(): PluginConfig {
    return this._config;
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
   *
   * Thin wrapper around calculateRouteImpl: counts this request as "in
   * flight" for the whole calculation (§4a — RoutingDatabase.unloadDatabaseGraph
   * refuses to evict a database while any route is executing) without
   * touching the body of the actual search logic.
   */
  async calculateRoute(request: RoutingRequest): Promise<RouteResult> {
    this.db.beginRoute();
    try {
      return await this.calculateRouteImpl(request);
    } finally {
      this.db.endRoute();
    }
  }

  private async calculateRouteImpl(request: RoutingRequest): Promise<RouteResult> {
    const { start, end, via = [], minCoastDistance, draft, beam, airDraft } = request;
    const effectiveCoastDistance = minCoastDistance ?? this.config.defaultCoastDistance;

    // §4a dynamic loading: no-op in non-dynamic mode. In dynamic mode, load
    // (inline, before the search runs) any not-yet-loaded database whose
    // coverage bbox contains start/end/any via point — waypoint containment
    // only for this phase, not the full transit-bbox a route might also
    // pass through (PHASE_4_DESIGN.md §4a.1 task 4 is that follow-up).
    await this.db.ensureRegionsLoaded([start, end, ...via]);

    // Build per-request effective dimensions without mutating shared engine state.
    // Concurrent requests each get their own local copy, avoiding race conditions.
    const effectiveDims: VesselDimensions = {
      draft:    draft    !== undefined ? draft    : this.vesselDimensions.draft,
      beam:     beam     !== undefined ? beam     : this.vesselDimensions.beam,
      airDraft: airDraft !== undefined ? airDraft : this.vesselDimensions.airDraft,
    };

    const coastDistanceMeters = effectiveCoastDistance * 1852;

      // Same-region navmesh fast path: when both endpoints land inside the
      // same navmesh_regions polygon, the whole route is a single funnel
      // path with no point-graph traversal needed at all — astarSearch's
      // multi-candidate boundary-node seeding (below) can't produce this on
      // its own, since it always seeds/goal-tests against boundary nodes.
      if (via.length === 0 && request.endMode !== 'manual') {
        const navmeshRoute = await this.trySameRegionNavmeshRoute(start, end, effectiveDims);
        if (navmeshRoute) {
          const violationWarnings: RouteWarning[] = [];
          this.addViolationWarnings(navmeshRoute, violationWarnings, 'destination', start, end, effectiveDims);
          if (violationWarnings.length) navmeshRoute.warnings = violationWarnings;
          const sameRegionEnv = await this.prepareEnv(request, [start, end]);
          await this.finalizeRoute(navmeshRoute, [], sameRegionEnv);
          return navmeshRoute;
        }
      }

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

      // Try A* with expanding bounding box. A search that "succeeds" but
      // only got there by crossing a depth/air-draft/beam-violating edge
      // (see pathViolationMeters) gets the same expansion treatment as an
      // outright failure, since the real route may just be sitting outside
      // the current box. The best result seen across attempts is kept —
      // see isBetterCandidate for the fewer-violating-meters-first ordering.
      let currentMargin = this.config.routingBBoxMargin;
      const maxMargin = this.config.routingBBoxMaxExtent;

      // §4a.1 task 4: preload transit regions — databases the search bbox
      // passes through but that have no start/end waypoint inside them
      // (ensureRegionsLoaded above only covers waypoint containment). Use
      // the maximal bbox this expansion loop could ever reach (margin
      // capped at routingBBoxMaxExtent) so a mid-route region is already in
      // memory before the first search attempt, without loading beyond
      // what the search could actually examine.
      await this.db.ensureRegionsForBbox(bboxFromPoints(start, end, maxMargin));

      let bestResult: RouteResult | null = null;
      let bestCost = Infinity;
      let bestViolatingMeters = Infinity;
      let previousAttempt: { violatingMeters: number; cost: number } | null = null;
      let retriedForPenalty = false;

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

          const cost = result.features[0].properties.totalCost ?? 0;
          const distance = result.features[0].properties.totalDistance ?? 0;
          const violatingMeters = this.pathViolationMeters(result, effectiveDims);
          if (this.isBetterCandidate(violatingMeters, cost, bestViolatingMeters, bestCost)) {
            bestResult = result;
            bestCost = cost;
            bestViolatingMeters = violatingMeters;
          }

          const penalized = violatingMeters > 0;
          const stalled = previousAttempt !== null &&
            !this.isBetterCandidate(violatingMeters, cost, previousAttempt.violatingMeters, previousAttempt.cost);

          if (!penalized) {
            break;
          }
          if (currentMargin >= maxMargin || stalled) {
            console.log(`Route search kept a penalized result (${violatingMeters.toFixed(0)}m constraint-violating, cost ${cost.toFixed(0)} vs distance ${distance.toFixed(0)}m) — bounding box expansion ${stalled ? 'stopped improving' : 'reached max extent'}`);
            break;
          }

          const newMargin = Math.min(currentMargin * 2, maxMargin);
          console.log(`Route search found a penalized result (${violatingMeters.toFixed(0)}m constraint-violating, cost ${cost.toFixed(0)} vs distance ${distance.toFixed(0)}m) — retrying with expanded bounding box from ${(currentMargin * 111).toFixed(0)}km to ${(newMargin * 111).toFixed(0)}km`);
          retriedForPenalty = true;
          previousAttempt = { violatingMeters, cost };
          currentMargin = newMargin;
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

      if (bestResult) {
        const result = bestResult;
        if (retriedForPenalty) {
          console.log(`Route search penalized-result retry ${bestViolatingMeters > 0 ? 'did not clear the penalty' : 'won'} (final cost ${bestCost.toFixed(0)}, ${bestViolatingMeters.toFixed(0)}m constraint-violating)`);
        }

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
    // When this result is a LEG of a via route it must stay un-finalized:
    // finalizeRoute ends in splitToSegmentFeatures, which replaces
    // features[0] with per-segment features that carry no
    // properties.segments — routeViaPoints' merge then crashes with
    // "segments is not iterable". The via caller finalizes once at the end.
    finalize: boolean = true,
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
        } catch (e) {
          const cause = e instanceof Error ? e.message : String(e);
          throw new Error(
            `No route found through the primary waterway network between the connection points: ${cause}`
          );
        }
      }

      // Connect user points to the primary network entry/exit
      await this.connectUserPoint(start, route, 'start');
      await this.connectUserPoint(end, route, 'end');

      if (finalize) await this.finalizeRoute(route, [], env);
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
        // User-drawn straight line, bypassing the graph. Snap the endpoint to
        // a nearby graph node only when the NEXT leg is auto-routed, so it
        // picks up exactly where the manual line ends; between two manual
        // legs (or before a manual final leg) the line must pass exactly
        // through the user's clicked point.
        const nextLegMode = i + 1 < via.length ? (via[i + 1].mode ?? 'auto') : (endMode ?? 'auto');
        const manual = await this.buildManualLeg(currentStart, nextPoint, `Via point ${i + 1}`, warnings, nextLegMode !== 'manual');
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

    // §4a.1 task 4: preload transit regions for this segment. Even when a
    // fixed `bbox` was passed in (e.g. routeViaPoints' adaptiveMargin box),
    // an expansion attempt that falls through to bboxFromPoints below can
    // still reach the full segmentMaxMargin box (see `bbox = undefined`
    // below), so load for that maximal extent up front rather than
    // re-checking coverage on every expansion.
    await this.db.ensureRegionsForBbox(bboxFromPoints(startPt, endPt, segmentMaxMargin));

    let bestResult: RouteResult | null = null;
    let bestCost = Infinity;
    let bestViolatingMeters = Infinity;
    let previousAttempt: { violatingMeters: number; cost: number } | null = null;
    let retriedForPenalty = false;

    while (currentMargin <= segmentMaxMargin) {
      const segmentBbox = bbox ?? bboxFromPoints(startPt, endPt, currentMargin);
      try {
        const result = await this.astarSearch(startLat, startLon, endLat, endLon, coastDistanceMeters, dims, segmentBbox, env);

        const cost = result.features[0].properties.totalCost ?? 0;
        const distance = result.features[0].properties.totalDistance ?? 0;
        const violatingMeters = this.pathViolationMeters(result, dims);
        if (this.isBetterCandidate(violatingMeters, cost, bestViolatingMeters, bestCost)) {
          bestResult = result;
          bestCost = cost;
          bestViolatingMeters = violatingMeters;
        }

        const penalized = violatingMeters > 0;
        const stalled = previousAttempt !== null &&
          !this.isBetterCandidate(violatingMeters, cost, previousAttempt.violatingMeters, previousAttempt.cost);

        if (!penalized) break;
        bbox = undefined;
        if (currentMargin >= segmentMaxMargin || stalled) {
          console.log(`Route search for ${label} kept a penalized result (${violatingMeters.toFixed(0)}m constraint-violating, cost ${cost.toFixed(0)} vs distance ${distance.toFixed(0)}m) — bounding box expansion ${stalled ? 'stopped improving' : 'reached max extent'}`);
          break;
        }

        const newMargin = Math.min(currentMargin * 2, segmentMaxMargin);
        console.log(`Route search for ${label} found a penalized result (${violatingMeters.toFixed(0)}m constraint-violating, cost ${cost.toFixed(0)} vs distance ${distance.toFixed(0)}m) — retrying with expanded bounding box from ${(currentMargin * 111).toFixed(0)}km to ${(newMargin * 111).toFixed(0)}km`);
        retriedForPenalty = true;
        previousAttempt = { violatingMeters, cost };
        currentMargin = newMargin;
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

    if (bestResult) {
      if (retriedForPenalty) {
        console.log(`Route search for ${label} penalized-result retry ${bestViolatingMeters > 0 ? 'did not clear the penalty' : 'won'} (final cost ${bestCost.toFixed(0)}, ${bestViolatingMeters.toFixed(0)}m constraint-violating)`);
      }
      this.addViolationWarnings(bestResult, warnings, label, startPt, endPt, dims);
      return bestResult;
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
        const fallback = await this.fallbackRoute(startNode, endNode, startPt, endPt, coastDistanceMeters, [], dims, env, false);
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
   * When both start and end fall inside the same navmesh_regions polygon,
   * the route is a single funnel path with no point-graph traversal at all.
   * Returns null (falls through to normal A*) whenever that's not the case,
   * including when either point resolves to no region or to different regions.
   */
  /**
   * splitToSegmentFeatures (called from finalizeRoute) assumes
   * coordinates.length === segments.length + 1 — one LineString hop per
   * segment. A funnel-computed multi-point polyline breaks that invariant if
   * represented as a single segment spanning many coordinates (the extra
   * points silently get dropped). This expands an N-point polyline into N-1
   * segments, one per consecutive coordinate pair, so every point survives
   * into the final per-segment GeoJSON features. Only the true endpoints
   * (when known) carry a real node id; interior synthetic points use -1,
   * matching connectUserPoint's existing off-graph-point convention.
   */
  private buildSubSegments(
    points: Array<[number, number]>, // [lat, lon], >= 2 points
    attrs: { minDepth: number; maxAirDraft: number; minWidth?: number; costFactor: number; trafficMode: number; edgeTypeId?: number },
    fromNodeId: number,
    toNodeId: number,
  ): NonNullable<RouteResult['features'][0]['properties']['segments']> {
    const segs: NonNullable<RouteResult['features'][0]['properties']['segments']> = [];
    for (let i = 0; i < points.length - 1; i++) {
      const distance = Math.round(this.haversineDistance(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]));
      segs.push({
        from: i === 0 ? fromNodeId : -1,
        to: i === points.length - 2 ? toNodeId : -1,
        distance,
        minDepth: attrs.minDepth,
        maxAirDraft: attrs.maxAirDraft,
        minWidth: attrs.minWidth,
        costFactor: attrs.costFactor,
        trafficMode: attrs.trafficMode,
        edgeTypeId: attrs.edgeTypeId,
      });
    }
    return segs;
  }

  private async trySameRegionNavmeshRoute(
    start: { latitude: number; longitude: number },
    end: { latitude: number; longitude: number },
    _dims: VesselDimensions,
  ): Promise<RouteResult | null> {
    const startRegion = this.db.findNavmeshRegionAt(start.latitude, start.longitude);
    if (!startRegion) return null;
    const endRegion = this.db.findNavmeshRegionAt(end.latitude, end.longitude);
    if (!endRegion || endRegion !== startRegion) return null;

    const result = this.db.funnelPathBetweenPoints(startRegion, start.latitude, start.longitude, end.latitude, end.longitude);
    if (!result) return null;

    const coordinates: [number, number][] = result.path.map(([lat, lon]) => [lon, lat]);
    const segments = this.buildSubSegments(
      result.path,
      { minDepth: startRegion.depthCeilingM, maxAirDraft: -1, costFactor: 1.0, trafficMode: TRAFFIC_TWO_WAY },
      -1, -1,
    );
    const distance = Math.round(result.distance);

    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {
          totalDistance: distance,
          totalCost: distance,
          segments,
        },
      }],
    };
  }

  /**
   * Build the multi-candidate boundary-node seed map for a navmesh region a
   * user point falls inside: a live `funnelPathFromPoint` call for each of
   * the region's anchors, plus a cheap composed (anchor result + precomputed
   * anchor<->node shortcut edge) cost for every other boundary node — never
   * a second live call per node. See the boundary-shortcut-sparsification
   * fix in NEXT_PHASES.md: this is what turns 695+713 uncached live calls
   * into ~40, without narrowing the actual candidate set A* searches/tests
   * against (narrowing that set is what caused the regression — see the
   * comment at this method's call site).
   */
  private seedNavmeshCandidates(region: NavmeshRegion, lat: number, lon: number): Map<number, FunnelResult> | null {
    const candidates = new Map<number, FunnelResult>();
    for (const anchorId of region.anchorNodeIds) {
      const r = this.db.funnelPathFromPoint(region, lat, lon, anchorId);
      if (r) candidates.set(anchorId, r);
    }

    for (const nodeId of region.boundaryNodeIds) {
      if (candidates.has(nodeId)) continue;
      let bestDistance = Infinity;
      let bestAnchorPrefix: FunnelResult | null = null;
      let bestShortcut: { distance: number; path_points?: Array<[number, number]> } | null = null;
      for (const [anchorId, anchorPrefix] of candidates) {
        const shortcut = this.db.getPrecomputedNavmeshShortcut(anchorId, nodeId);
        if (!shortcut) continue;
        const total = anchorPrefix.distance + shortcut.distance;
        if (total < bestDistance) {
          bestDistance = total;
          bestAnchorPrefix = anchorPrefix;
          bestShortcut = shortcut;
        }
      }
      if (!bestAnchorPrefix || !bestShortcut) continue;

      const nodeCoord = this.db.getNodeSync(nodeId);
      if (!nodeCoord) continue;
      const path: Array<[number, number]> = [...bestAnchorPrefix.path, ...(bestShortcut.path_points ?? []), [nodeCoord.lat, nodeCoord.lon]];
      candidates.set(nodeId, { distance: bestDistance, path });
    }

    return candidates.size > 0 ? candidates : null;
  }

  /**
   * Splice a funnel-computed prefix (user start point -> boundary node) and/or
   * suffix (boundary node -> user end point) onto an astarSearch result whose
   * first/last node was resolved via navmesh multi-candidate seeding. Mirrors
   * connectUserPoint's synthetic-segment convention (from/to: -1 for the
   * off-graph endpoint) — and makes connectUserPoint itself a no-op afterward,
   * since coords[0]/coords[last] already exactly equal the user's point.
   */
  private splicePrefixSuffix(
    result: RouteResult,
    prefix?: { boundaryNodeId: number } & FunnelResult,
    suffix?: { boundaryNodeId: number } & FunnelResult,
  ): void {
    const feature = result.features[0];
    if (!feature) return;
    const coords = feature.geometry.coordinates;
    const segments = feature.properties.segments!;

    const attrs = { minDepth: -1, maxAirDraft: -1, costFactor: 1.0, trafficMode: TRAFFIC_TWO_WAY };

    if (prefix) {
      // prefix.path goes userPoint -> boundary node vertex; drop the last
      // point, which duplicates coords[0] (the boundary node's own coordinate).
      const pts: [number, number][] = prefix.path.slice(0, -1).map(([lat, lon]) => [lon, lat]);
      coords.unshift(...pts);
      segments.unshift(...this.buildSubSegments(prefix.path, attrs, -1, prefix.boundaryNodeId));
      feature.properties.totalDistance = (feature.properties.totalDistance ?? 0) + Math.round(prefix.distance);
    }

    if (suffix) {
      // suffix.path goes userPoint -> boundary node vertex (funnelPathFromPoint's
      // direction); reverse to boundary node -> userPoint before appending.
      const reversed = [...suffix.path].reverse();
      const pts: [number, number][] = reversed.slice(1).map(([lat, lon]) => [lon, lat]);
      coords.push(...pts);
      segments.push(...this.buildSubSegments(reversed, attrs, suffix.boundaryNodeId, -1));
      feature.properties.totalDistance = (feature.properties.totalDistance ?? 0) + Math.round(suffix.distance);
    }
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
    let startNode: number | null = await this.db.findNearestNode(startLat, startLon);
    let endNode: number | null = await this.db.findNearestNode(endLat, endLon);

    const startRegion = this.db.findNavmeshRegionAt(startLat, startLon);
    const endRegion = this.db.findNavmeshRegionAt(endLat, endLon);

    if ((!startNode && !startRegion) || (!endNode && !endRegion)) {
      throw new Error('Could not find routing nodes near start or end point');
    }

    // Multi-candidate boundary-node seeding/goal-testing (spec §6 items 1-4):
    // when a point lands inside a navmesh region, let real A* cost comparison
    // pick the cheapest boundary node to enter/exit through, rather than
    // pre-selecting a single "nearest" one — important in concave regions
    // where nearest-by-straight-line isn't necessarily cheapest by graph cost.
    // Every boundary node stays a valid candidate (dropping the rest would
    // narrow the A* goal test to just the anchors, whose "last mile" funnel
    // cost back to the literal point isn't reflected by the search
    // heuristic — that let A* settle on a cheap-to-reach-but-far anchor with
    // a large, unaccounted-for suffix, worse than not restricting at all).
    // What NEXT_PHASES.md's fix actually buys is avoiding a *live*
    // `funnelPathFromPoint` call per boundary node (695+713 of them,
    // uncached, in the confirmed regression): only the ~40 anchors get a
    // live call; every other node's cost is composed cheaply from the
    // nearest live anchor result plus a precomputed anchor<->node shortcut
    // edge (`addAnchorShortcutEdges`, database.ts).
    const startCandidates = startRegion ? this.seedNavmeshCandidates(startRegion, startLat, startLon) : null;
    const endCandidates = endRegion ? this.seedNavmeshCandidates(endRegion, endLat, endLon) : null;
    if (!startCandidates && startNode === null) {
      throw new Error('Could not find routing nodes near start point');
    }
    if (!endCandidates && endNode === null) {
      throw new Error('Could not find routing nodes near end point');
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
        console.log(`[routeiq] ${label} node ${node} → ${best} (better depth, ${Math.round(bestDist)}m away)`);
      }
      return best;
    };

    // Skip the shallow-water node-improvement heuristic when a region resolved
    // valid boundary candidates — navmesh regions are open water by
    // construction, so "improve to a deeper nearby node" doesn't apply, and
    // real A* cost comparison across candidates already does a better job.
    if (!endCandidates && endNode !== null) {
      const improvedEnd = await improveNode(endNode, endLat, endLon, 'End');
      if (improvedEnd !== endNode) endNode = improvedEnd;
    }
    if (!startCandidates && startNode !== null) {
      const improvedStart = await improveNode(startNode, startLat, startLon, 'Start');
      if (improvedStart !== startNode) startNode = improvedStart;
    }

    // Expand bbox to include the actual snapped node coordinates (and, for
    // navmesh-resolved endpoints, the whole region's extent) so the strict
    // isInsideBBox check below never rejects a valid start/end candidate.
    if (bbox) {
      if (startNode !== null) {
        const snapStart = await this.db.getNodeById(startNode);
        if (snapStart) {
          bbox.minLat = Math.min(bbox.minLat, snapStart.lat);
          bbox.maxLat = Math.max(bbox.maxLat, snapStart.lat);
          bbox.minLon = Math.min(bbox.minLon, snapStart.lon);
          bbox.maxLon = Math.max(bbox.maxLon, snapStart.lon);
        }
      }
      if (endNode !== null) {
        const snapEnd = await this.db.getNodeById(endNode);
        if (snapEnd) {
          bbox.minLat = Math.min(bbox.minLat, snapEnd.lat);
          bbox.maxLat = Math.max(bbox.maxLat, snapEnd.lat);
          bbox.minLon = Math.min(bbox.minLon, snapEnd.lon);
          bbox.maxLon = Math.max(bbox.maxLon, snapEnd.lon);
        }
      }
      if (startRegion) {
        bbox.minLat = Math.min(bbox.minLat, startRegion.bbox.minLat);
        bbox.maxLat = Math.max(bbox.maxLat, startRegion.bbox.maxLat);
        bbox.minLon = Math.min(bbox.minLon, startRegion.bbox.minLon);
        bbox.maxLon = Math.max(bbox.maxLon, startRegion.bbox.maxLon);
      }
      if (endRegion) {
        bbox.minLat = Math.min(bbox.minLat, endRegion.bbox.minLat);
        bbox.maxLat = Math.max(bbox.maxLat, endRegion.bbox.maxLat);
        bbox.minLon = Math.min(bbox.minLon, endRegion.bbox.minLon);
        bbox.maxLon = Math.max(bbox.maxLon, endRegion.bbox.maxLon);
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

    // Initialize: either the single literal nearest node (unchanged path), or
    // one open-set entry per navmesh boundary-node candidate with g = the
    // funnel prefix distance from the user's point to that boundary node.
    if (startCandidates) {
      for (const [nodeId, prefix] of startCandidates) {
        const coord = this.db.getNodeSync(nodeId);
        if (!coord) continue;
        gScore.set(nodeId, prefix.distance);
        tSec.set(nodeId, 0);
        const h = this.haversineDistance(coord.lat, coord.lon, endLat, endLon) * minMultiplier;
        openSet.push({ nodeId, g: prefix.distance, f: prefix.distance + h, parent: null });
      }
    } else {
      gScore.set(startNode!, 0);
      tSec.set(startNode!, 0);
      openSet.push({
        nodeId: startNode!,
        g: 0,
        f: this.haversineDistance(startLat, startLon, endLat, endLon) * minMultiplier,
        parent: null,
      });
    }

    let goalReached = false;
    let reachedNode: number | null = null;
    let iterations = 0;
    const maxIterations = 5000000; // Safety limit (5000K suffices for trans-continental routes like NL→Italy ~2000nm)
    const skipReasons: SearchSkipReasons = { land: 0, obstacle: 0, airDraft: 0, draft: 0, beam: 0, coastDistance: 0, bbox: 0 };

    // Ensure start is inside the bounding box (skipped for navmesh-resolved
    // starts — the bbox was already expanded to cover the whole region above).
    if (bbox && !startCandidates && startNode !== null) {
      const startCoords = await this.db.getNodeById(startNode);
      if (startCoords && !isInsideBBox(startCoords.lat, startCoords.lon, bbox)) {
        throw new Error('Start node is outside the routing bounding box');
      }
    }

    // Best true total cost found so far for finishing the route, and the
    // node it finishes through — see the goal-test note below for why this
    // can't just stop on the first candidate touched.
    let bestGoalCost = Infinity;

    while (!openSet.isEmpty() && iterations < maxIterations) {
      iterations++;

      // Yield to the macrotask queue periodically so a long CPU-bound search
      // doesn't starve the SignalK server's event loop (I/O, NMEA, WebSocket
      // broadcasts). await on the synchronously-resolved getOutgoingEdges below
      // only drains microtasks, which never lets macrotasks run — setImmediate
      // does. ~10k iterations keeps each blocking burst to a few ms.
      if (iterations % 10000 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }

      // Once any goal candidate is known, no future pop can beat it once the
      // open set's best remaining f (an admissible lower bound on true
      // remaining cost, including any navmesh suffix) is no better than that
      // candidate's already-known true total — stop.
      if (reachedNode !== null) {
        const top = openSet.peek();
        if (!top || top.f >= bestGoalCost) break;
      }

      const current = openSet.pop()!;

      if (closedSet.has(current.nodeId)) {
        continue;
      }

      closedSet.add(current.nodeId);

      // A node finishes the route one of two ways: it IS the literal
      // nearest-graph-node target (suffix cost 0), or it's one of the
      // destination navmesh region's boundary-node candidates, whose own
      // precomputed funnel "suffix" (that boundary node -> the literal end
      // point, from seedNavmeshCandidates) still has to be paid before the
      // journey is actually over. Reaching *some* boundary node cheaply via
      // the graph does not mean the cheapest finish has been found — a
      // pricier-to-reach boundary node can still be cheaper overall if its
      // own suffix is much shorter (e.g. one that's actually close to the
      // literal end point vs. one that's merely close by graph distance).
      // Comparing true totals here (instead of stopping on first touch) is
      // the fix for a real regression: the old immediate-stop let A* settle
      // for whichever boundary node was cheapest to reach by graph alone,
      // even when that meant crossing a heavily constraint-penalized edge
      // while a clean, only-slightly-more-expensive-to-reach boundary node
      // (e.g. next to an opening bridge) sat unexplored in the open set.
      const suffix = endCandidates?.get(current.nodeId);
      let candidateTotal: number | null = null;
      if (current.nodeId === endNode) candidateTotal = current.g;
      if (suffix !== undefined) {
        const withSuffix = current.g + suffix.distance;
        if (candidateTotal === null || withSuffix < candidateTotal) candidateTotal = withSuffix;
      }
      if (candidateTotal !== null && candidateTotal < bestGoalCost) {
        bestGoalCost = candidateTotal;
        reachedNode = current.nodeId;
        goalReached = true;
      }

      // Get outgoing edges from current node
      const edges = await this.db.getOutgoingEdges(current.nodeId);

      for (const edge of edges) {
        if (closedSet.has(edge.target)) {
          continue;
        }

        // Bounding box check — skip nodes outside the box
        if (bbox && !isInsideBBox(edge.lat, edge.lon, bbox)) {
          skipReasons.bbox++;
          continue;
        }

        // Apply soft safety constraints
        const penalty = this.getEdgePenalty(edge, minCoastDistanceMeters, dims, skipReasons);
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
        // penalty is a sum of per-meter violation RATES (see
        // VIOLATION_RATE_CONSTRAINT/VIOLATION_RATE_COAST) — multiplying by
        // the edge's own length keeps the surcharge proportional to how
        // much violating distance is actually being crossed, rather than a
        // flat per-edge charge that would bias the search toward many
        // short violating edges over one long one. Math.max(1, ...) only
        // guards against a zero-length edge silently escaping the penalty.
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

    if (!goalReached || reachedNode === null) {
      // Report what the search actually ran into instead of always blaming
      // vessel constraints — a disconnected graph, an undersized bounding
      // box, or a genuine land/obstacle block all hit this same failure
      // path, and previously got the identical generic message regardless.
      const causes: string[] = [];
      if (skipReasons.land > 0) causes.push(`${skipReasons.land} edge(s) blocked by land`);
      if (skipReasons.obstacle > 0) causes.push(`${skipReasons.obstacle} edge(s) blocked by an obstacle`);
      if (skipReasons.draft > 0) causes.push(`${skipReasons.draft} edge(s) too shallow for draft ${dims.draft}m`);
      if (skipReasons.airDraft > 0) causes.push(`${skipReasons.airDraft} edge(s) with insufficient air draft for airDraft ${dims.airDraft}m`);
      if (skipReasons.beam > 0) causes.push(`${skipReasons.beam} edge(s) too narrow for beam ${dims.beam}m`);
      if (skipReasons.coastDistance > 0) causes.push(`${skipReasons.coastDistance} edge(s) closer to shore than the requested minCoastDistance`);
      if (skipReasons.bbox > 0) causes.push(`${skipReasons.bbox} edge(s) outside the current search bounding box`);

      let detail: string;
      if (causes.length === 0) {
        detail = iterations >= maxIterations
          ? 'the search exceeded its iteration limit before finding a path — the area may be too large for the current bounding box.'
          : 'the destination appears unreachable from the start — the graph may be disconnected here (no edges connect the two areas), independent of vessel size or coast-distance settings.';
      } else {
        detail = `during the search, ran into: ${causes.join(', ')}.` +
          (iterations >= maxIterations ? ' The search also exceeded its iteration limit before finishing.' : '');
      }

      throw new Error(
        `No route found between the given points — ${detail} ` +
        `(vessel dims: draft=${dims.draft}m, beam=${dims.beam}m, airDraft=${dims.airDraft}m, minCoastDistance=${(minCoastDistanceMeters / 1852).toFixed(2)}nm)`
      );
    }

    // Reconstruct path. path[0] is whichever seeded candidate A* actually
    // used (the literal startNode, or — with multi-candidate seeding — the
    // real-cost-cheapest boundary node), since only seed nodes are absent
    // from `parent`.
    const path: number[] = [];
    let current: number | null = reachedNode;
    while (current !== null) {
      path.unshift(current);
      current = parent.get(current) ?? null;
    }

    // Compress collinear waypoints (cheap pre-pass before LOS smoothing)
    const compressedPath = this.compressCollinear(path);

    // Apply string-pulling to remove unnecessary grid staircasing
    const smoothedPath = await this.smoothPath(compressedPath);

    // Build GeoJSON response
    const result = await this.buildRouteResult(smoothedPath, path, gScore.get(reachedNode) || 0);

    const prefix = startCandidates?.get(path[0]);
    const suffix = endCandidates?.get(reachedNode);
    if (prefix || suffix) {
      this.splicePrefixSuffix(
        result,
        prefix ? { boundaryNodeId: path[0], ...prefix } : undefined,
        suffix ? { boundaryNodeId: reachedNode, ...suffix } : undefined,
      );
    }

    return result;
  }

  /**
   * Total length (meters) of segments in a result whose depth, air-draft,
   * or beam falls short of the given vessel's requirement — i.e. the
   * portion of the route that only "succeeded" by crossing a hard-
   * constraint-violating edge (see VIOLATION_RATE_CONSTRAINT). Zero means
   * the path is clean on these three classes.
   *
   * Coast-distance is deliberately excluded: VIOLATION_RATE_COAST is a
   * comfort preference (stay N meters off the coast), not a physical
   * limit, and it legitimately fires on plenty of otherwise-fine routes
   * near any coastline. Counting it here would make the bbox-expansion
   * retry (below) trigger almost unconditionally instead of only when a
   * route is actually forced through a depth/air/beam violation.
   */
  private pathViolationMeters(result: RouteResult, dims: VesselDimensions): number {
    const segments = result.features[0]?.properties.segments;
    if (!segments) return 0;
    const minDepth = (dims.draft || 2.0) + this.config.safetyMarginDraft;
    const minAirDraft = (dims.airDraft || 0) + this.config.safetyMarginAirDraft;
    const minBeam = (dims.beam || 4.0) + this.config.safetyMarginBeam;

    let meters = 0;
    for (const seg of segments) {
      const depthViolation = seg.minDepth >= 0 && seg.minDepth < minDepth;
      const airDraftViolation = seg.maxAirDraft >= 0 && seg.maxAirDraft < minAirDraft;
      const beamViolation = typeof seg.minWidth === 'number' && seg.minWidth >= 0 && seg.minWidth < minBeam;
      if (depthViolation || airDraftViolation || beamViolation) {
        meters += seg.distance || 0;
      }
    }
    return meters;
  }

  /**
   * Ordering used to pick the "best" result across bbox-expansion retries
   * (see pathViolationMeters): fewer constraint-violating meters always
   * wins first, regardless of cost — the whole point of retrying with a
   * wider box is to escape one that's hiding a clean route, so a clean
   * result must beat a penalized one even if the penalized one happens to
   * be cheaper on paper. Cost only breaks ties between two results at the
   * same violation level (typically two clean routes, or two routes
   * forced through the same amount of violation).
   */
  private isBetterCandidate(
    violatingMetersA: number, costA: number,
    violatingMetersB: number, costB: number,
  ): boolean {
    if (violatingMetersA !== violatingMetersB) return violatingMetersA < violatingMetersB;
    return costA < costB;
  }

  // Per-class violation RATES: unitless "one violating meter costs N clean
  // meters", multiplied by edge.distance in the A* edge-cost term below
  // (getEdgePenalty returns the sum of rates for whichever classes an edge
  // violates; multiple violated classes stack, e.g. depth+air = 600x/m).
  // Replaces the old flat +1,000,000 (constraint) / +50,000 (coast) added
  // per edge regardless of its length, which made a single mis-flagged
  // edge cost more than a 100x detour (Round 14 regression) and made many
  // short violating edges collectively cheaper than one long clean edge
  // (a contour-hugging bias) since the flat constant dwarfed edge.distance.
  //
  // depth/air-draft/beam: physical constraint violations — strongly
  // avoided, but a genuinely-only-option crossing should still beat an
  // absurd detour. At 300x, a 211m violating edge costs ~63km-equivalent:
  // enough to lose to almost any real detour, but not enough to lose to a
  // 100x-longer one.
  private static readonly VIOLATION_RATE_CONSTRAINT = 300;
  // coast-distance: a comfort preference (stay clear of the coast by the
  // requested margin), not a hard physical limit — softer than the
  // constraint classes above so it doesn't dominate route choice the way
  // it did at the old flat +50,000.
  private static readonly VIOLATION_RATE_COAST = 50;

  private getEdgePenalty(
    edge: EdgeRow & { lat: number; lon: number },
    minCoastDistanceMeters: number,
    dims: VesselDimensions,
    skipReasons?: SearchSkipReasons,
  ): number {
    if (edge.crosses_land === 1) {
      if (skipReasons) skipReasons.land++;
      return -1;
    }
    if (edge.crosses_obstacle === 1) {
      if (skipReasons) skipReasons.obstacle++;
      return -1;
    }

    let penalty = 0;

    if (typeof edge.max_air_draft === 'number' && edge.max_air_draft >= 0 && edge.max_air_draft < (dims.airDraft || 0) + this.config.safetyMarginAirDraft) {
      penalty += RoutingEngine.VIOLATION_RATE_CONSTRAINT;
      if (skipReasons) skipReasons.airDraft++;
    }

    const minDepth = (dims.draft || 2.0) + this.config.safetyMarginDraft;
    if (typeof edge.min_depth === 'number' && edge.min_depth >= 0 && edge.min_depth < minDepth) {
      penalty += RoutingEngine.VIOLATION_RATE_CONSTRAINT;
      if (skipReasons) skipReasons.draft++;
    }
    if (typeof edge.min_width === 'number' && edge.min_width >= 0 && edge.min_width < (dims.beam || 4.0) + this.config.safetyMarginBeam) {
      penalty += RoutingEngine.VIOLATION_RATE_CONSTRAINT;
      if (skipReasons) skipReasons.beam++;
    }
    if (edge.edge_type_id === EDGE_TYPE_COASTAL && edge.distance_to_land < minCoastDistanceMeters) {
      penalty += RoutingEngine.VIOLATION_RATE_COAST;
      if (skipReasons) skipReasons.coastDistance++;
    }

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
      if (i > 0) {
        const prevNode = smoothedPath[i - 1];
        const currNode = smoothedPath[i];
        let edge = await this.db.getEdge(prevNode, currNode);

        if (!edge && originalPath !== smoothedPath) {
          edge = this.db.aggregateSegmentEdges(prevNode, currNode, originalPath);
        }

        if (edge) {
          totalDistance += edge.distance;
          if (edge.path_points && edge.path_points.length > 0) {
            // A funnel-computed navmesh edge carries the interior polyline of
            // its taut path — expand it into one sub-segment per point pair
            // (see buildSubSegments) instead of one segment spanning many
            // coordinates, which splitToSegmentFeatures can't represent.
            const fromCoord = this.db.getNodeSync(prevNode);
            const toCoord = this.db.getNodeSync(currNode);
            const pts: Array<[number, number]> = [
              fromCoord ? [fromCoord.lat, fromCoord.lon] : edge.path_points[0],
              ...edge.path_points,
              toCoord ? [toCoord.lat, toCoord.lon] : edge.path_points[edge.path_points.length - 1],
            ];
            for (const [lat, lon] of edge.path_points) coordinates.push([lon, lat]);
            segments.push(...this.buildSubSegments(pts, {
              minDepth: edge.min_depth, maxAirDraft: edge.max_air_draft, minWidth: edge.min_width,
              costFactor: edge.cost_factor, trafficMode: edge.traffic_mode, edgeTypeId: edge.edge_type_id,
            }, prevNode, currNode));
          } else {
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
          }
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

      const node = await this.db.getNodeById(smoothedPath[i]);
      if (node) coordinates.push([node.lon, node.lat]);
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

  // Human-readable span suffix for a bridge crossing, e.g. " (opening span)"
  // or " (fixed, 18.4m)". S-57 gives every span of a bridge the same OBJNAM,
  // so this is what lets a route report distinguish which span was crossed.
  private static formatSpanSuffix(subtype: string | undefined, height: number | undefined): string {
    if (subtype === 'opening') return ' (opening span)';
    if (subtype === 'fixed') {
      return typeof height === 'number' ? ` (fixed, ${height.toFixed(1)}m)` : ' (fixed span)';
    }
    return '';
  }

  private async detectCrossings(coordinates: [number, number][]): Promise<RouteCrossing[]> {
    if (coordinates.length === 0) return [];

    const MARGIN = 0.002; // ~222 m, comfortably larger than MAX_DIST (150 m) below
    const CHUNK = 64; // points per segmented bbox query

    // Segmented, deduped POI fetch: instead of one query over the bbox of
    // the entire route (which pulls in every POI in that rectangle, not
    // just ones near the polyline), walk the route in fixed-size chunks and
    // query each chunk's own (much smaller) bbox. Consecutive chunks share
    // their boundary point so a crossing right at a chunk edge is still
    // covered by both neighboring queries.
    //
    // Correctness: every route vertex lies in some chunk, and each chunk's
    // query box is that chunk's vertex extent expanded by MARGIN >= MAX_DIST,
    // so any POI within MAX_DIST of any vertex is inside at least one
    // chunk's box. The union of chunk results is therefore a superset of
    // the single-whole-route-bbox result restricted to the near-route
    // corridor, and deduping by id turns that union into a proper set —
    // so detectCrossings' output is unchanged; only far-off-route POIs that
    // would have been fetched-then-rejected are never fetched at all.
    const poiById = new Map<number, Awaited<ReturnType<typeof this.db.getPoisInBBox>>[number]>();
    for (let i = 0; i < coordinates.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, coordinates.length - 1);
      let cMinLat = Infinity, cMaxLat = -Infinity, cMinLon = Infinity, cMaxLon = -Infinity;
      for (let j = i; j <= end; j++) {
        const [lon, lat] = coordinates[j];
        if (lat < cMinLat) cMinLat = lat;
        if (lat > cMaxLat) cMaxLat = lat;
        if (lon < cMinLon) cMinLon = lon;
        if (lon > cMaxLon) cMaxLon = lon;
      }
      const chunkPois = await this.db.getPoisInBBox(
        cMinLat - MARGIN, cMinLon - MARGIN,
        cMaxLat + MARGIN, cMaxLon + MARGIN,
      );
      for (const poi of chunkPois) poiById.set(poi.id, poi);
      if (end >= coordinates.length - 1) break;
    }
    const pois = [...poiById.values()];

    const bridgePois = pois.filter(p => p.typeId === POI_TYPE_BRIDGE);
    const lockPois = pois.filter(p => p.typeId === POI_TYPE_LOCK);
    const MAX_DIST = 150; // m: how close the route must pass to a POI to count as a crossing
    const MERGE_ROUTE_DIST = 300; // m along-route: same-name events closer than this are one physical crossing

    // Cumulative along-route distance per coordinate, used only to decide
    // whether two same-named hits are the same physical crossing or two
    // distinct passages of a like-named feature further down the route.
    const cumDist: number[] = [0];
    for (let i = 1; i < coordinates.length; i++) {
      const [lon1, lat1] = coordinates[i - 1];
      const [lon2, lat2] = coordinates[i];
      cumDist.push(cumDist[i - 1] + this.haversineDistance(lat1, lon1, lat2, lon2));
    }

    type Poi = typeof bridgePois[0];

    // For a set of same-typed POIs: group by name (S-57 gives every span of
    // one bridge/lock complex the same OBJNAM), then walk the route once per
    // name group. At each coordinate within MAX_DIST, attach the *nearest*
    // POI in the group (nearest-span attachment). Consecutive in-range
    // coordinates collapse into a single run (one physical crossing); runs
    // that are close together along the route are merged too, so a cluster
    // of spans near one crossing point never produces more than one entry.
    const detectForGroup = (
      groupPois: Poi[],
      build: (poi: Poi) => RouteCrossing,
    ): RouteCrossing[] => {
      const byName = new Map<string, Poi[]>();
      for (const poi of groupPois) {
        const arr = byName.get(poi.name);
        if (arr) arr.push(poi); else byName.set(poi.name, [poi]);
      }

      const out: Array<{ crossing: RouteCrossing; dist: number; coordIdx: number }> = [];
      for (const group of byName.values()) {
        let current: { poi: Poi; dist: number; coordIdx: number } | null = null;
        const runs: Array<{ poi: Poi; dist: number; coordIdx: number }> = [];
        for (let i = 0; i < coordinates.length; i++) {
          const [lon, lat] = coordinates[i];
          let bestPoi: Poi | null = null;
          let bestDist = Infinity;
          for (const poi of group) {
            const d = this.haversineDistance(lat, lon, poi.lat, poi.lon);
            if (d <= MAX_DIST && d < bestDist) { bestDist = d; bestPoi = poi; }
          }
          if (bestPoi) {
            if (!current || bestDist < current.dist) current = { poi: bestPoi, dist: bestDist, coordIdx: i };
          } else if (current) {
            runs.push(current);
            current = null;
          }
        }
        if (current) runs.push(current);

        // Merge runs *within this name group* that are close together along
        // the route into one crossing, keeping the geometrically nearest span.
        const merged: Array<{ poi: Poi; dist: number; coordIdx: number }> = [];
        for (const run of runs) {
          const prev = merged.length > 0 ? merged[merged.length - 1] : undefined;
          if (prev && cumDist[run.coordIdx] - cumDist[prev.coordIdx] < MERGE_ROUTE_DIST) {
            if (run.dist < prev.dist) merged[merged.length - 1] = run;
          } else {
            merged.push(run);
          }
        }
        for (const run of merged) {
          out.push({ crossing: build(run.poi), dist: run.dist, coordIdx: run.coordIdx });
        }
      }
      out.sort((a, b) => a.coordIdx - b.coordIdx);
      return out.map(e => e.crossing);
    };

    const bridgeCrossings = detectForGroup(bridgePois, (poi) => {
      const props = poi.properties as Record<string, unknown>;
      const subtype = props?.subtype as string | undefined;
      const height = props?.height as number | undefined;
      return {
        type: 'bridge',
        name: `${poi.name}${RoutingEngine.formatSpanSuffix(subtype, height)}`,
        subtype,
        height,
        position: { latitude: poi.lat, longitude: poi.lon },
      };
    });
    const lockCrossings = detectForGroup(lockPois, (poi) => ({
      type: 'lock',
      name: poi.name,
      position: { latitude: poi.lat, longitude: poi.lon },
    }));

    return [...bridgeCrossings, ...lockCrossings];
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

        // Never string-pull across a funnel-augmented hop: it's already the
        // taut/optimal path through its navmesh region, and this straight-line
        // LOS check samples too coarsely to trust cutting a corner across it.
        if (!skippingInland) {
          for (let m = i; m < j; m++) {
            const hopEdge = this.db.getEdgeSync(path[m], path[m + 1]);
            if (hopEdge?.path_points && hopEdge.path_points.length > 0) {
              skippingInland = true;
              break;
            }
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