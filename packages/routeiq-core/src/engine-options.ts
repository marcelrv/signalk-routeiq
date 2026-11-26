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

import { RouteFailure } from "./failure.js";
import type { Logger } from "./logger.js";
import { formatFailure } from "./messages.js";
import type { SearchBudget } from "./request-control.js";
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
  /**
   * Language of the texts the engine writes (warnings, itinerary phrases,
   * failure messages). `"request"` follows the request's `lang` (a language
   * the catalogue lacks reads as English); any other value is a language tag
   * every request is answered in, whatever its `lang`. The request's `lang`
   * still selects the language of water names either way.
   */
  messageLanguage: "request" | string;
  /**
   * Node expansions one A* search may make before it ends as "no path" with
   * `iterationLimit: true` in the failure params. Per search, not per request
   * (see `budget` for that). Default 5_000_000.
   */
  maxSearchIterations?: number;
  /**
   * What one whole request (a route, or a departure scan) may spend over all
   * its searches, retries, legs and steps. Default: unlimited. A request can
   * lower these through its call options, never raise them. Over the limit the
   * request throws `BUDGET_EXCEEDED`.
   */
  budget?: Partial<SearchBudget>;
  /** Where the engine logs to. Default: silent. */
  logger?: Logger;
}

/** Default of `EngineOptions.maxSearchIterations`: 5M suffices for
 *  trans-continental routes (about 2000 nm). */
export const DEFAULT_MAX_SEARCH_ITERATIONS = 5_000_000;

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
  messageLanguage: "request",
  maxSearchIterations: DEFAULT_MAX_SEARCH_ITERATIONS,
  budget: { maxIterations: Infinity, maxWallMs: Infinity },
};

/** Codes a RouteRequestError can carry. */
export type RouteRequestErrorCode = "VESSEL_INCOMPLETE" | "INVALID_REQUEST";

/**
 * A request the engine refuses before searching, as opposed to a route it
 * could not find. `code` is stable and machine-readable, `params` carries the
 * values a client needs to translate the message, `message` is rendered in the
 * engine's message language.
 */
export class RouteRequestError extends RouteFailure {
  declare readonly code: RouteRequestErrorCode;

  constructor(
    code: RouteRequestErrorCode,
    params: Record<string, unknown>,
    message: string,
  ) {
    super(code, params, message);
    this.name = "RouteRequestError";
  }
}

/**
 * The language to write a request's texts in: the option's fixed language, or
 * the request's own `lang` when the option is `"request"`. Not yet reduced to
 * a catalogue language; the catalogue does that (unknown reads as English).
 */
export function messageLanguageFor(
  options: Pick<EngineOptions, "messageLanguage">,
  requestLang: string | null | undefined,
): string {
  return options.messageLanguage === "request"
    ? (requestLang ?? "en")
    : options.messageLanguage;
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
        formatFailure(
          "VESSEL_INCOMPLETE",
          { missing },
          messageLanguageFor(options, request.lang),
        ),
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
