/**
 * Route description: where a finished route runs, by water.
 *
 * The routing database groups edges into edge sequences, each in one named
 * water body (SPEC-WAYS-AND-WATERWAYS.md in signalk-router-pipeline). After a
 * route is found, the db worker looks those up for the route's node pairs
 * (route-metadata.ts); this module, pure and main-thread, groups the answer
 * into legs and hangs the part inside each itinerary leg on the itinerary.
 *
 * Display only: nothing here feeds a routing cost.
 */

import {
  ItineraryPoint,
  RouteDescriptionLeg,
  RouteDescriptionWarning,
  RouteWaterPart,
} from "./types.js";

/** What the worker knows about one edge sequence, enums already resolved. */
export interface DescribedSequence {
  waterBodyId: number | null;
  origin: string; // origin_enum description, 'other' for an unknown id
  originWarn: boolean; // imported or community
  depthQuality: string; // depth_quality_enum description, 'unknown' for an unknown id
  depthQualityWarn: boolean; // rank below 'charted'
}

export interface DescribedWaterBody {
  name?: string; // best name for the requested language
  kind: string;
}

export interface DescribedNotice {
  severity: number;
  text: string;
  name: string | null;
}

/** Worker answer for `describeRoute`. Keys of the records are ids as strings. */
export interface DescribeWorkerResult {
  /** One entry per requested pair; null when the pair is in no sequence. */
  perPair: Array<{ seq: number | null; notices?: number[] } | null>;
  sequences: Record<string, DescribedSequence>;
  waterBodies: Record<string, DescribedWaterBody>;
  notices: Record<string, DescribedNotice>;
}

/** The part of a route segment the description needs. */
export interface DescribableSegment {
  distance?: number;
}

function warningKey(w: RouteDescriptionWarning): string {
  if (w.type === "depth_quality") return `d:${w.quality}`;
  if (w.type === "origin") return `o:${w.origin}`;
  return `n:${w.severity}:${w.text}`;
}

function addWarnings(
  into: RouteDescriptionWarning[],
  more: RouteDescriptionWarning[],
): void {
  const seen = new Set(into.map(warningKey));
  for (const w of more) {
    const k = warningKey(w);
    if (!seen.has(k)) {
      seen.add(k);
      into.push(w);
    }
  }
}

/** Warnings for one edge sequence plus the notices on one pair. */
function warningsFor(
  seq: DescribedSequence | undefined,
  noticeIds: number[] | undefined,
  notices: Record<string, DescribedNotice>,
): RouteDescriptionWarning[] {
  const out: RouteDescriptionWarning[] = [];
  if (seq?.depthQualityWarn) {
    out.push({
      type: "depth_quality",
      quality: seq.depthQuality,
      message:
        seq.depthQuality === "unknown"
          ? "Depth unknown along this stretch"
          : `Depth not charted here (${seq.depthQuality.replace(/_/g, " ")})`,
    });
  }
  if (seq?.originWarn) {
    out.push({
      type: "origin",
      origin: seq.origin,
      message: `This line is ${seq.origin}, not surveyed or reviewed as the charted ones`,
    });
  }
  for (const id of noticeIds ?? []) {
    const n = notices[String(id)];
    if (!n) continue;
    out.push({
      type: "notice",
      severity: n.severity,
      text: n.text,
      ...(n.name ? { name: n.name } : {}),
      message: n.text,
    });
  }
  return out;
}

/**
 * Group the route's segments into legs.
 *
 * A leg is a run of segments in the same water body; a route may enter an edge
 * sequence partway, so the distance is the sum of the route's own segments, not
 * the sequence's stored distance. A sequence with no water body has no name
 * (its parent is only reachable through a water body), so such runs, and
 * segments in no sequence at all, merge into unnamed legs.
 *
 * Returns undefined when nothing on the route has a name or a warning, so a
 * database without the tables leaves `description` off the result.
 */
export function buildRouteDescription(
  segments: DescribableSegment[],
  described: DescribeWorkerResult,
): RouteDescriptionLeg[] | undefined {
  const legs: RouteDescriptionLeg[] = [];
  let chainage = 0;
  let last: number | null | undefined; // water body id of the open leg
  let any = false;

  for (let i = 0; i < segments.length; i++) {
    const dist = segments[i].distance ?? 0;
    const info = described.perPair[i] ?? null;
    const seq =
      info && info.seq !== null
        ? described.sequences[String(info.seq)]
        : undefined;
    const waterBodyId = seq?.waterBodyId ?? null;
    const body =
      waterBodyId !== null
        ? described.waterBodies[String(waterBodyId)]
        : undefined;
    const warnings = warningsFor(seq, info?.notices, described.notices);
    if (body?.name || warnings.length > 0) any = true;

    if (legs.length > 0 && last === waterBodyId) {
      const leg = legs[legs.length - 1];
      leg.distance += dist;
      addWarnings(leg.warnings, warnings);
    } else {
      legs.push({
        distanceFromStart: chainage,
        distance: dist,
        ...(waterBodyId !== null ? { waterBodyId } : {}),
        ...(body?.name ? { name: body.name } : {}),
        ...(body ? { kind: body.kind } : {}),
        warnings,
      });
      last = waterBodyId;
    }
    chainage += dist;
  }

  if (!any) return undefined;
  for (const leg of legs) {
    leg.distanceFromStart = Math.round(leg.distanceFromStart);
    leg.distance = Math.round(leg.distance);
  }
  return legs;
}

/** Parts of an itinerary leg shorter than this, with no warning, are left out of `leg.waters`. */
const MIN_WATER_PART_M = 100;

/**
 * Hang the part of the description inside each itinerary leg on the itinerary
 * as `leg.waters`, so a client never has to work out the overlap itself.
 * Only waters with a name or a warning are listed, and slivers under
 * MIN_WATER_PART_M without a warning are dropped; neighbours in the same water
 * (which a turn or a dropped sliver can separate) are merged again.
 */
export function attachWaters(
  itinerary: ItineraryPoint[],
  description: RouteDescriptionLeg[],
): void {
  for (let i = 0; i < itinerary.length - 1; i++) {
    const point = itinerary[i];
    if (!point.leg) continue;
    const from = point.distanceFromStart;
    const to = itinerary[i + 1].distanceFromStart;
    const waters: RouteWaterPart[] = [];
    let lastLeg: RouteDescriptionLeg | undefined;
    for (const leg of description) {
      const overlap =
        Math.min(to, leg.distanceFromStart + leg.distance) -
        Math.max(from, leg.distanceFromStart);
      if (overlap < 1) continue;
      // A sliver is skipped without breaking the merge of its neighbours.
      if (overlap < MIN_WATER_PART_M && leg.warnings.length === 0) continue;
      if (!leg.name && leg.warnings.length === 0) {
        lastLeg = undefined; // a gap: do not merge the waters either side of it
        continue;
      }
      if (lastLeg && lastLeg.waterBodyId === leg.waterBodyId && waters.length) {
        const prev = waters[waters.length - 1];
        prev.distance += Math.round(overlap);
        addWarnings(prev.warnings, leg.warnings);
      } else {
        waters.push({
          ...(leg.name ? { name: leg.name } : {}),
          ...(leg.kind ? { kind: leg.kind } : {}),
          distance: Math.round(overlap),
          warnings: [...leg.warnings],
        });
      }
      lastLeg = leg;
    }
    if (waters.length > 0) point.leg.waters = waters;
  }
}
