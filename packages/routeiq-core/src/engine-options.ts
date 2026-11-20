/**
 * Engine options, and the per-request resolution of everything that depends on
 * the boat or the user.
 *
 * The engine holds no vessel or user state: a request carries its own draft,
 * beam, air draft, speed, margins, waits and tide choice, and
 * `resolveRouteInputs` turns that plus these defaults into one `RouteInputs`
 * object per request (and per departure scan), which is then passed down the
 * search. Two requests on one engine therefore never see each other's values.
 */

import type { RouteInputs, RoutingRequest } from "./types.js";
import { CORE_VERSION } from "./version.js";

/** What the engine falls back on for a vessel dimension the request left out. */
export interface DefaultVessel {
  /** Metres. 0 = unknown draft, so only the safety margin is required. */
  draft: number;
  /** Metres. */
  beam: number;
  /** Metres. 0 = unknown air draft (no overhead clearance is checked). */
  airDraft: number;
}

export interface EngineOptions {
  /** Degrees. Initial margin of the A* search box around start and end. */
  bboxMarginDeg: number;
  /** Degrees. Largest search box before the search gives up on a box. */
  bboxMaxExtentDeg: number;
  /** Metres. Radius for line-of-sight smoothing node search; 0 = smoothing off. */
  losSearchRadiusM: number;
  /** Metres. Largest deviation when simplifying a route to waypoints. */
  waypointToleranceM: number;
  /** Metres. A straight connector longer than this is reported as a coverage
   *  gap; 0 = never. */
  coverageGapM: number;
  /** Ratio. How much longer a fully compliant route may be before a shorter
   *  one with constraint violations is preferred; 0 = no bound. */
  maxPenaltyDetourRatio: number;
  /** Knots. Speed through the water when the request gives none. */
  defaultSpeedKnots: number;
  /** Minutes. Wait at a lock when neither the request nor the data gives one. */
  defaultLockWaitMinutes: number;
  /** Minutes. Wait at an opening bridge span, likewise. */
  defaultBridgeWaitMinutes: number;
  /** Metres added to the draft when the request gives no margin. */
  defaultSafetyMarginDraftM: number;
  /** Metres added to the beam when the request gives no margin. */
  defaultSafetyMarginBeamM: number;
  /** Metres added to the air draft when the request gives no margin. */
  defaultSafetyMarginAirDraftM: number;
  /** Whether tides are used when the request does not say. */
  defaultUseTides: boolean;
  /** Dimensions used when the request lacks them and strict mode is off. */
  defaultVessel: DefaultVessel;
  /**
   * Strict mode. When true a request without draft, beam, air draft and
   * speedKnots is rejected with a RouteRequestError (`VESSEL_INCOMPLETE`)
   * instead of being routed with `defaultVessel` and `defaultSpeedKnots`.
   */
  requireVesselInRequest: boolean;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  bboxMarginDeg: 1.0,
  bboxMaxExtentDeg: 10.0,
  losSearchRadiusM: 0,
  waypointToleranceM: 30,
  coverageGapM: 1500,
  maxPenaltyDetourRatio: 3.0,
  defaultSpeedKnots: 5.0,
  defaultLockWaitMinutes: 60,
  defaultBridgeWaitMinutes: 30,
  defaultSafetyMarginDraftM: 0.3,
  defaultSafetyMarginBeamM: 2.0,
  defaultSafetyMarginAirDraftM: 1.5,
  defaultUseTides: false,
  defaultVessel: { draft: 0, beam: 4, airDraft: 0 },
  requireVesselInRequest: false,
};

/** Codes a RouteRequestError can carry. */
export type RouteRequestErrorCode = "VESSEL_INCOMPLETE";

/**
 * A request the engine refuses before searching, as opposed to a route it
 * could not find. `code` is stable and machine-readable, `params` carries the
 * values a client needs to translate the message, `message` is English.
 */
export class RouteRequestError extends Error {
  readonly code: RouteRequestErrorCode;
  readonly params: Record<string, unknown>;

  constructor(
    code: RouteRequestErrorCode,
    params: Record<string, unknown>,
    message: string,
  ) {
    super(message);
    this.name = "RouteRequestError";
    this.code = code;
    this.params = params;
  }
}

/** Slowest speed the engine plans with, knots. */
export const MIN_SPEED_KNOTS = 0.5;

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The effective inputs for one request: request value, else option default.
 * Called once at the start of a request and once at the start of a departure
 * scan. In strict mode, throws RouteRequestError (`VESSEL_INCOMPLETE`) when
 * the request lacks draft, beam, airDraft or speedKnots.
 */
export function resolveRouteInputs(
  request: RoutingRequest,
  options: EngineOptions,
): RouteInputs {
  if (options.requireVesselInRequest) {
    const missing = (
      ["draft", "beam", "airDraft", "speedKnots"] as const
    ).filter((k) => !isNum(request[k]));
    if (missing.length > 0) {
      throw new RouteRequestError(
        "VESSEL_INCOMPLETE",
        { missing },
        `The request must carry the vessel and speed; missing: ${missing.join(", ")}`,
      );
    }
  }
  const parsedDeparture = request.departureTime
    ? Date.parse(request.departureTime)
    : NaN;
  return {
    draft: request.draft ?? options.defaultVessel.draft,
    beam: request.beam ?? options.defaultVessel.beam,
    airDraft: request.airDraft ?? options.defaultVessel.airDraft,
    speedKnots: Math.max(
      MIN_SPEED_KNOTS,
      request.speedKnots ?? options.defaultSpeedKnots,
    ),
    safetyMarginDraft:
      request.safetyMarginDraft ?? options.defaultSafetyMarginDraftM,
    safetyMarginBeam:
      request.safetyMarginBeam ?? options.defaultSafetyMarginBeamM,
    safetyMarginAirDraft:
      request.safetyMarginAirDraft ?? options.defaultSafetyMarginAirDraftM,
    departureTime: Number.isFinite(parsedDeparture)
      ? new Date(parsedDeparture).toISOString()
      : null,
    useTides: request.useTides ?? options.defaultUseTides,
    lockWaitMinutes: request.lockWaitMinutes ?? options.defaultLockWaitMinutes,
    bridgeWaitMinutes:
      request.bridgeWaitMinutes ?? options.defaultBridgeWaitMinutes,
    minCoastDistance: request.minCoastDistance ?? 0,
    lang: request.lang ?? null,
    describe: request.describe !== false,
    coreVersion: CORE_VERSION,
  };
}
