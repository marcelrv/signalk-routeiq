/**
 * The passage profile saved with a route (issue #50).
 *
 * A calculated route's times — total, the part spent waiting at locks and
 * opening spans, departure/arrival when the plan is dated — written into the
 * Signal K route resource as `feature.properties.passageProfile`, so another
 * plugin can read them back without routing again. The format is documented
 * in docs/passage-profile.md; bump PASSAGE_PROFILE_VERSION on any change that
 * would break a reader.
 *
 * Built from the server's own RouteResult fields only. The profile is tied to
 * the geometry it was calculated for by `geometry.hash`: RouteIQ never sees a
 * route edited in another app, so a reader recomputes the hash over the
 * resource's current coordinates and treats a mismatch as a stale profile.
 */
import crypto from "crypto";
import fs from "fs";
import { RouteResult, WarnLevel } from "./types.js";

export const PASSAGE_PROFILE_VERSION = 1;
export const GEOMETRY_HASH_METHOD = "lonlat-e5";

const KNOTS_TO_MS = 1852 / 3600;

let providerVersion: string | undefined;
function packageVersion(): string {
  if (providerVersion !== undefined) return providerVersion;
  let version = "";
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // unreadable package.json: report no version rather than fail the save
  }
  providerVersion = version;
  return version;
}

/**
 * The canonical form of a route's geometry: each position as integer
 * 1e-5 degrees (`Math.round(v * 100000)`, about a metre), `lon,lat`, joined
 * with `;`. Altitude is dropped. The precision absorbs float noise from a
 * round trip through a host while any real edit still changes it.
 */
export function canonicalGeometry(
  coords: ReadonlyArray<ArrayLike<number>>,
): string {
  // `+ 0` turns -0 into 0, which String() would print the same anyway; kept
  // explicit because other languages do print "-0".
  const e5 = (v: number) => String(Math.round(v * 100000) + 0);
  return coords.map((c) => `${e5(c[0])},${e5(c[1])}`).join(";");
}

/** `sha256:<hex>` over canonicalGeometry. */
export function geometryHash(coords: ReadonlyArray<ArrayLike<number>>): string {
  return (
    "sha256:" +
    crypto.createHash("sha256").update(canonicalGeometry(coords)).digest("hex")
  );
}

/** Whether every element is a finite [lon, lat, ...] position. */
export function isPositionList(v: unknown): v is Array<[number, number]> {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    v.every(
      (c) =>
        Array.isArray(c) &&
        c.length >= 2 &&
        Number.isFinite(c[0]) &&
        Number.isFinite(c[1]),
    )
  );
}

/** The geometry a route resource is saved with: the simplified waypoints. */
export function savedCoordinates(
  route: RouteResult,
): Array<[number, number]> | undefined {
  const w = route.waypoints;
  if (!Array.isArray(w) || w.length < 2) return undefined;
  const coords = w.map((p) => [p.longitude, p.latitude] as [number, number]);
  return isPositionList(coords) ? coords : undefined;
}

export interface PassageProfileWarning {
  type: string;
  level?: WarnLevel;
  message: string;
  distanceFromStart?: number; // m, where it starts along the route
}

export interface PassageProfile {
  version: number;
  provider: { name: "signalk-routeiq"; version: string };
  calculatedAt: string | null;
  geometry: { hash: string; method: string; pointCount: number };
  distance: number | null; // m
  duration: {
    total: number; // s, moving + waiting
    moving: number; // s
    waiting: number; // s
    waitingIncludedInTotal: true;
  };
  departure: string | null; // ISO; null = an undated plan
  arrival: string | null;
  assumptions: {
    speedThroughWater: number | null; // m/s
    lockWait: number | null; // s, default per lock
    bridgeWait: number | null; // s, default per opening span
    tide: { enabled: boolean; estimated?: boolean; source?: string };
  };
  waits: Array<{
    type: "bridge" | "lock";
    name: string;
    structure?: string;
    distanceFromStart?: number; // m
    seconds: number;
  }>;
  warnings: PassageProfileWarning[];
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The profile for `route` as saved with geometry `coords`. Undefined when the
 * route carries no time (nothing to keep).
 */
export function buildPassageProfile(
  route: RouteResult,
  coords: ReadonlyArray<ArrayLike<number>>,
): PassageProfile | undefined {
  const total = finiteOrNull(route.totalSeconds);
  if (total === null || total < 0) return undefined;
  const waiting = Math.min(
    total,
    Math.max(0, finiteOrNull(route.totalWaitSeconds) ?? 0),
  );
  const a = route.timingAssumptions;
  const knots = finiteOrNull(a?.averageSpeedKnots);
  const lockMin = finiteOrNull(a?.lockWaitMinutes);
  const bridgeMin = finiteOrNull(a?.bridgeWaitMinutes);
  const isoOrNull = (v: unknown): string | null =>
    typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
  // Dated only when the server said both ends: a plan without a departure
  // time is undated, not "leaving now".
  const departure = isoOrNull(route.departureTime);
  const arrival = departure ? isoOrNull(route.arrivalTime) : null;

  const tide: PassageProfile["assumptions"]["tide"] = route.tide?.enabled
    ? {
        enabled: true,
        estimated: route.tide.estimated,
        ...(route.tide.source ? { source: route.tide.source } : {}),
      }
    : { enabled: false };

  const waits: PassageProfile["waits"] = (route.crossings ?? [])
    .filter((c) => typeof c.waitSeconds === "number" && c.waitSeconds > 0)
    .map((c) => ({
      type: c.type,
      name: c.name,
      ...(c.structure !== undefined ? { structure: c.structure } : {}),
      ...(typeof c.distanceFromStart === "number"
        ? { distanceFromStart: c.distanceFromStart }
        : {}),
      seconds: c.waitSeconds as number,
    }));

  return {
    version: PASSAGE_PROFILE_VERSION,
    provider: { name: "signalk-routeiq", version: packageVersion() },
    calculatedAt: isoOrNull(route.calculatedAt),
    geometry: {
      hash: geometryHash(coords),
      method: GEOMETRY_HASH_METHOD,
      pointCount: coords.length,
    },
    distance: finiteOrNull(route.totalDistance),
    duration: {
      total,
      moving: total - waiting,
      waiting,
      waitingIncludedInTotal: true,
    },
    departure,
    arrival,
    assumptions: {
      speedThroughWater:
        knots === null ? null : Math.round(knots * KNOTS_TO_MS * 1000) / 1000,
      lockWait: lockMin === null ? null : Math.round(lockMin * 60),
      bridgeWait: bridgeMin === null ? null : Math.round(bridgeMin * 60),
      tide,
    },
    waits,
    warnings: collectWarnings(route),
  };
}

/**
 * Everything the route result warns about, flattened: route-level warnings,
 * the shallow/narrow warnings on itinerary legs and the warnings from the
 * route description. Kept so a reader that only checks time or fuel still
 * sees that the passage itself carries cautions.
 */
function collectWarnings(route: RouteResult): PassageProfileWarning[] {
  const out: PassageProfileWarning[] = [];
  for (const w of route.warnings ?? []) {
    if (w && typeof w.message === "string") {
      out.push({ type: String(w.type), message: w.message });
    }
  }
  const located = (w: {
    type: string;
    level: WarnLevel;
    message: string;
    at?: Array<{ distanceFromStart: number }>;
  }): PassageProfileWarning => ({
    type: w.type,
    level: w.level,
    message: w.message,
    ...(w.at && w.at.length && Number.isFinite(w.at[0].distanceFromStart)
      ? { distanceFromStart: w.at[0].distanceFromStart }
      : {}),
  });
  for (const p of route.itinerary ?? []) {
    for (const w of p.leg?.warnings ?? []) out.push(located(w));
  }
  for (const leg of route.description ?? []) {
    for (const w of leg.warnings ?? []) out.push(located(w));
  }
  return out;
}
