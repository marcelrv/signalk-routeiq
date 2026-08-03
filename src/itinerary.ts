/**
 * Route simplification and itinerary building.
 *
 * The routing graph is a dense quadtree mesh, so a raw path contains many
 * near-collinear micro-jogs. This module derives from it, server-side, the two
 * client-facing representations (single source of truth for all frontends —
 * webapp, Freeboard-SK extension, third parties):
 *
 * - `waypoints`  — a navigable polyline: Douglas-Peucker with a bounded
 *   deviation (meters) from the computed path, safe to load as an actual
 *   chartplotter/autopilot route.
 * - `itinerary`  — the human-readable plan: start/end, via points and major
 *   course changes, each annotated with chainage, course, and aggregates of
 *   the leg to the next entry (distance, min depth/width, max air draft,
 *   bridge/lock crossings) computed from the exact graph edges.
 */

import { ItineraryPoint, RouteCrossing, RouteWaypoint } from "./types.js";

/** Subset of the per-edge segment attributes the itinerary needs. */
export interface PathSegment {
  distance: number;
  minDepth?: number;
  maxAirDraft?: number;
  minWidth?: number;
  seconds?: number; // tide-corrected traversal time
  currentKn?: number; // estimated along-track current, + = fair
}

type LonLat = [number, number];

const EARTH_M_PER_DEG_LAT = 111320;

/** Great-circle initial bearing in degrees true [0, 360). */
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = (Math.atan2(y, x) * 180) / Math.PI;
  return (θ + 360) % 360;
}

/** Signed course change from bearing b1 to b2, in (-180, 180]. */
function signedTurn(b1: number, b2: number): number {
  let d = b2 - b1;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Douglas-Peucker on [lon, lat] coordinates with tolerance in meters.
 * Returns the kept indices (sorted, always including first and last).
 * The simplified line deviates at most `toleranceM` from the original.
 */
export function simplifyIndices(
  coords: LonLat[],
  toleranceM: number,
): number[] {
  if (coords.length <= 2 || toleranceM <= 0) {
    return coords.map((_, i) => i);
  }

  // Local equirectangular projection (meters); fine at route scale.
  const latMid = (coords[0][1] + coords[coords.length - 1][1]) / 2;
  const mPerDegLon = EARTH_M_PER_DEG_LAT * Math.cos((latMid * Math.PI) / 180);
  const pts = coords.map(([lon, lat]) => [
    lon * mPerDegLon,
    lat * EARTH_M_PER_DEG_LAT,
  ]);

  const keep = new Array<boolean>(coords.length).fill(false);
  keep[0] = keep[coords.length - 1] = true;

  const stack: Array<[number, number]> = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let maxDist = -1;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let dist: number;
      if (len2 === 0) {
        dist = Math.hypot(px - ax, py - ay);
      } else {
        // Perpendicular distance to the (clamped) chord a→b
        const t = Math.max(
          0,
          Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2),
        );
        dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    if (maxDist > toleranceM) {
      keep[maxIdx] = true;
      stack.push([a, maxIdx], [maxIdx, b]);
    }
  }

  const kept: number[] = [];
  for (let i = 0; i < coords.length; i++) if (keep[i]) kept.push(i);
  return kept;
}

/**
 * Cumulative distance (m) at every coordinate. Uses the graph edge distances
 * when the segments align with the coordinates (segment i spans coord i→i+1),
 * falling back to haversine where they do not.
 */
export function cumulativeDistances(
  coords: LonLat[],
  segments: PathSegment[],
): number[] {
  const cum = new Array<number>(coords.length).fill(0);
  for (let i = 1; i < coords.length; i++) {
    const seg = segments[i - 1];
    const d =
      seg && typeof seg.distance === "number" && seg.distance > 0
        ? seg.distance
        : haversineM(
            coords[i - 1][1],
            coords[i - 1][0],
            coords[i][1],
            coords[i][0],
          );
    cum[i] = cum[i - 1] + d;
  }
  return cum;
}

/** Index of the coordinate closest to (lat, lon). */
export function closestCoordIndex(
  coords: LonLat[],
  lat: number,
  lon: number,
): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineM(lat, lon, coords[i][1], coords[i][0]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export interface ItineraryResult {
  waypoints: RouteWaypoint[];
  itinerary: ItineraryPoint[];
}

/**
 * Build the simplified waypoint list and the itinerary for a computed route.
 *
 * @param coords     full route geometry ([lon, lat]), aligned with `segments`
 * @param segments   per-edge attributes; segment i spans coords i → i+1
 * @param crossings  bridges/locks on the route (mutated: distanceFromStart is set)
 * @param via        the user's via points, marked as itinerary entries
 * @param toleranceM Douglas-Peucker tolerance for the navigable waypoints
 */
export function buildItinerary(
  coords: LonLat[],
  segments: PathSegment[],
  crossings: RouteCrossing[],
  via: Array<{ latitude: number; longitude: number }>,
  toleranceM: number,
): ItineraryResult {
  if (coords.length < 2) {
    return {
      waypoints: coords.map(([lon, lat]) => ({
        latitude: lat,
        longitude: lon,
      })),
      itinerary: [],
    };
  }

  const cum = cumulativeDistances(coords, segments);
  const totalKm = cum[cum.length - 1] / 1000;
  const kept = simplifyIndices(coords, toleranceM);

  // Annotate crossings with chainage along the route.
  for (const c of crossings) {
    const idx = closestCoordIndex(
      coords,
      c.position.latitude,
      c.position.longitude,
    );
    c.distanceFromStart = Math.round(cum[idx]);
  }
  crossings.sort(
    (a, b) => (a.distanceFromStart ?? 0) - (b.distanceFromStart ?? 0),
  );

  // --- major course changes, evaluated on the simplified polyline so grid
  // micro-jogs cannot register as turns ---
  // Adaptive threshold: short hops list gentler turns than long passages.
  const turnThreshold = Math.max(15, Math.min(50, 20 + totalKm * 0.5));
  const turns: Array<{ idx: number; change: number }> = [];
  for (let k = 1; k < kept.length - 1; k++) {
    const [pLon, pLat] = coords[kept[k - 1]];
    const [cLon, cLat] = coords[kept[k]];
    const [nLon, nLat] = coords[kept[k + 1]];
    const change = signedTurn(
      bearingDeg(pLat, pLon, cLat, cLon),
      bearingDeg(cLat, cLon, nLat, nLon),
    );
    if (Math.abs(change) > turnThreshold) {
      turns.push({ idx: kept[k], change: Math.abs(change) });
    }
  }
  // Keep the itinerary glanceable: drop the weakest turns beyond the cap.
  const MAX_TURNS = 15;
  if (turns.length > MAX_TURNS) {
    turns.sort((a, b) => b.change - a.change);
    turns.length = MAX_TURNS;
  }

  // Assemble itinerary indices: start, turns, via points, end.
  const entries = new Map<number, ItineraryPoint["kind"]>();
  entries.set(0, "start");
  for (const t of turns) entries.set(t.idx, "turn");
  const viaIdxByCoord = new Map<number, number>();
  for (let v = 0; v < via.length; v++) {
    const idx = closestCoordIndex(coords, via[v].latitude, via[v].longitude);
    if (idx > 0 && idx < coords.length - 1) {
      entries.set(idx, "via"); // via wins over a coinciding turn
      viaIdxByCoord.set(idx, v);
    }
  }
  entries.set(coords.length - 1, "end");

  const indices = [...entries.keys()].sort((a, b) => a - b);

  const itinerary: ItineraryPoint[] = indices.map((idx, i) => {
    const [lon, lat] = coords[idx];
    const point: ItineraryPoint = {
      kind:
        idx === 0
          ? "start"
          : idx === coords.length - 1
            ? "end"
            : entries.get(idx)!,
      latitude: lat,
      longitude: lon,
      distanceFromStart: Math.round(cum[idx]),
    };
    if (viaIdxByCoord.has(idx)) point.viaIndex = viaIdxByCoord.get(idx);

    const nextIdx = indices[i + 1];
    if (nextIdx !== undefined) {
      const [nLon, nLat] = coords[nextIdx];
      point.courseToNext = Math.round(bearingDeg(lat, lon, nLat, nLon));
      if (i > 0) {
        const [pLon, pLat] = coords[indices[i - 1]];
        point.turn = Math.round(
          signedTurn(
            bearingDeg(pLat, pLon, lat, lon),
            bearingDeg(lat, lon, nLat, nLon),
          ),
        );
      }

      // Aggregate the exact graph edges of this leg.
      let minDepth = Infinity;
      let minWidth = Infinity;
      let maxAirDraft = Infinity;
      let legDistance = 0;
      let legSeconds = 0;
      let hasSeconds = false;
      let currentWeighted = 0;
      let currentDist = 0;
      for (let s = idx; s < nextIdx && s < segments.length; s++) {
        const seg = segments[s];
        if (!seg) continue;
        legDistance += seg.distance ?? 0;
        if (typeof seg.minDepth === "number" && seg.minDepth >= 0)
          minDepth = Math.min(minDepth, seg.minDepth);
        if (typeof seg.minWidth === "number" && seg.minWidth >= 0)
          minWidth = Math.min(minWidth, seg.minWidth);
        if (typeof seg.maxAirDraft === "number" && seg.maxAirDraft >= 0)
          maxAirDraft = Math.min(maxAirDraft, seg.maxAirDraft);
        if (typeof seg.seconds === "number") {
          legSeconds += seg.seconds;
          hasSeconds = true;
        }
        if (typeof seg.currentKn === "number") {
          currentWeighted += seg.currentKn * (seg.distance ?? 0);
          currentDist += seg.distance ?? 0;
        }
      }
      const legStart = cum[idx];
      const legEnd = cum[nextIdx];
      const isLastLeg = i === indices.length - 2;
      const legCrossings = crossings.filter((c) => {
        const d = c.distanceFromStart ?? 0;
        return d >= legStart && (isLastLeg ? d <= legEnd : d < legEnd);
      });
      point.leg = {
        distance: Math.round(legDistance > 0 ? legDistance : legEnd - legStart),
        ...(minDepth < Infinity ? { minDepth } : {}),
        ...(minWidth < Infinity ? { minWidth } : {}),
        ...(maxAirDraft < Infinity ? { maxAirDraft } : {}),
        ...(hasSeconds ? { seconds: Math.round(legSeconds) } : {}),
        ...(currentDist > 0
          ? {
              currentKn:
                Math.round((currentWeighted / currentDist) * 100) / 100,
            }
          : {}),
        ...(legCrossings.length > 0 ? { crossings: legCrossings } : {}),
      };
    }
    return point;
  });

  return {
    waypoints: kept.map((idx) => ({
      latitude: coords[idx][1],
      longitude: coords[idx][0],
    })),
    itinerary,
  };
}
