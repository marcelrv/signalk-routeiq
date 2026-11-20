/**
 * Request validation shared by every caller of the engine.
 *
 * `validateRouteRequest` takes an untrusted body (parsed JSON of any shape)
 * and returns either a clean `RoutingRequest` or the first problem found, with
 * a stable `code`, the offending `field`, an English `message` and `params`
 * for translation. Everything caller-specific (how many vias, whether manual
 * legs or coordinate aliases are accepted, numeric ranges, whether a bad
 * dimension is an error) is a parameter, in `RequestLimits`.
 *
 * Nothing here touches the engine or any database.
 */

import type { LegMode, RouteWarning, RoutingRequest } from "./types.js";

/** The vessel dimensions a request can carry. */
export type VesselDimensionKey = "draft" | "beam" | "airDraft";

export const VESSEL_DIM_KEYS: readonly VesselDimensionKey[] = [
  "draft",
  "beam",
  "airDraft",
];

/** Plausible upper bounds (metres) per vessel dimension. A value outside them
 *  never reaches the engine, because a bad dimension fails *open* on a safety
 *  constraint instead of erroring: the depth test compares
 *  `edge.min_depth < draft + safetyMarginDraft`, so a string draft makes that
 *  sum a string and every comparison NaN-false (no edge is ever too shallow),
 *  and a negative draft puts the threshold below every real depth. Same shape
 *  for air draft and beam. Recognisable spellings of a real number are still
 *  read (see coerceVesselDimension) — it is the unreadable ones that must not
 *  slip through. */
export const VESSEL_DIM_MAX_M: Record<VesselDimensionKey, number> = {
  draft: 30,
  beam: 100,
  airDraft: 150,
};

/** Human wording for warnings and errors — "airDraft" reads badly in prose. */
export const VESSEL_DIM_LABEL: Record<VesselDimensionKey, string> = {
  draft: "draft",
  beam: "beam",
  airDraft: "air draft",
};

/** Turns a dimension supplied by a client — or read straight off a Signal K
 *  path — into metres.
 *
 *  Beyond a plain number this accepts the two shapes that legitimately reach
 *  us carrying a perfectly good value:
 *   - a numeric string, from a form field or a settings file that stored the
 *     draft as text ("2");
 *   - Signal K's own `design.draft`, whose value is an *object*
 *     (`{maximum, minimum, current}`), plus the `{value: ...}` delta wrapper.
 *     A UI reading `vessels/self` directly gets that object, not a scalar.
 *
 *  Anything else (an empty string, "2 meters", a bare object) is undefined —
 *  never NaN, and never a string that would survive into an arithmetic
 *  comparison. See VESSEL_DIM_MAX_M for why that distinction is a safety
 *  property and not just tidiness. */
export function coerceVesselDimension(
  value: unknown,
  depth = 0,
): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  // Bounded so a hand-crafted body of nested wrappers can't recurse forever.
  if (typeof value === "object" && value !== null && depth < 4) {
    const obj = value as Record<string, unknown>;
    for (const key of ["value", "maximum", "current"] as const) {
      const nested = coerceVesselDimension(obj[key], depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** Short, log-safe rendering of a rejected value, for the warning text. */
function describeValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > 60 ? text.slice(0, 57) + "…" : text;
}

/** What a caller accepts. Spread DEFAULT_REQUEST_LIMITS and override. */
export interface RequestLimits {
  /** Most via points a request may carry. */
  maxVias: number;
  /** Nautical miles. Longest start→vias→end straight-line distance accepted;
   *  absent = no limit. */
  maxStraightLineNm?: number;
  /** Accept `mode: "manual"` on vias and `endMode: "manual"`. When false they
   *  are rejected (`auto` stays valid). */
  allowManualLegs: boolean;
  /** Read `lat`, `lng` and `lon` as `latitude`/`longitude` when the long names
   *  are absent. */
  acceptCoordinateAliases: boolean;
  /** Strict: an unusable vessel dimension is an error, because the caller has
   *  no fallback for it. Non-strict: it is dropped and reported as a warning,
   *  and the engine's default applies. */
  strict: boolean;
  /** Metres. Largest value accepted per dimension. */
  maxDimensionM: Record<VesselDimensionKey, number>;
  /** Nautical miles. Largest `minCoastDistance`. */
  maxCoastDistanceNm: number;
  /** Minutes. Largest lock or bridge wait. */
  maxWaitMinutes: number;
  /** Knots. Largest `speedKnots`; the value must also be above 0. */
  maxSpeedKnots: number;
  /** Metres. Largest safety margin (0 is allowed). */
  maxSafetyMarginM: number;
  /** Longest `lang` string. */
  maxLangLength: number;
  /**
   * Non-strict only. The trailing sentence of the "Ignored the supplied …"
   * warning, which says what was used instead, so the caller can name its own
   * fallback. Receives the dimension's label ("draft", "air draft").
   */
  ignoredDimensionHint?: (label: string) => string;
}

export const DEFAULT_REQUEST_LIMITS: RequestLimits = {
  maxVias: 25,
  allowManualLegs: true,
  acceptCoordinateAliases: false,
  strict: false,
  maxDimensionM: { ...VESSEL_DIM_MAX_M },
  maxCoastDistanceNm: 100,
  maxWaitMinutes: 24 * 60,
  maxSpeedKnots: 60,
  maxSafetyMarginM: 100,
  maxLangLength: 35,
};

export type RequestErrorCode =
  | "INVALID_BODY"
  | "MISSING_ENDPOINTS"
  | "INVALID_COORDINATE"
  | "COORDINATE_OUT_OF_RANGE"
  | "INVALID_VIA"
  | "TOO_MANY_VIAS"
  | "INVALID_LEG_MODE"
  | "MANUAL_LEGS_NOT_ALLOWED"
  | "ROUTE_TOO_LONG"
  | "INVALID_DEPARTURE_TIME"
  | "INVALID_DIMENSION"
  | "INVALID_VALUE";

export interface RequestValidationError {
  code: RequestErrorCode;
  /** The request field at fault ("start", "via[2]", "draft", ...). */
  field: string;
  /** English. */
  message: string;
  /** Values a client needs to word the message itself. */
  params: Record<string, unknown>;
}

export type RequestValidation =
  | {
      ok: true;
      /** A new, clean request: known fields only, aliases resolved, nulls
       *  dropped, unusable dimensions removed (non-strict). */
      request: RoutingRequest;
      /** Non-fatal findings (a dropped vessel dimension). */
      warnings: RouteWarning[];
      /** Top-level body fields that are not part of the request. Not an
       *  error and not a warning: they are ignored. */
      unknownFields: string[];
    }
  | {
      ok: false;
      error: RequestValidationError;
      /** Warnings raised before the error was found. */
      warnings: RouteWarning[];
      unknownFields: string[];
    };

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "start",
  "end",
  "via",
  "endMode",
  "minCoastDistance",
  "draft",
  "beam",
  "airDraft",
  "departureTime",
  "useTides",
  "speedKnots",
  "safetyMarginDraft",
  "safetyMarginBeam",
  "safetyMarginAirDraft",
  "lockWaitMinutes",
  "bridgeWaitMinutes",
  "lang",
  "describe",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(
  code: RequestErrorCode,
  field: string,
  message: string,
  params: Record<string, unknown> = {},
): { error: RequestValidationError } {
  return { error: { code, field, message, params } };
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

type Point = { latitude: number; longitude: number };

/** Reads a coordinate pair, or says why it is not one. */
function readPoint(
  raw: unknown,
  aliases: boolean,
): { point: Point } | { problem: "format" | "range" } {
  if (!isRecord(raw)) return { problem: "format" };
  let latitude = raw.latitude;
  let longitude = raw.longitude;
  if (aliases) {
    if (typeof latitude !== "number") latitude = raw.lat;
    if (typeof longitude !== "number") longitude = raw.lng ?? raw.lon;
  }
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return { problem: "format" };
  }
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return { problem: "range" };
  }
  return { point: { latitude, longitude } };
}

/** The numeric and boolean fields of a request, written back onto it. */
export interface ConstraintFields {
  draft?: unknown;
  beam?: unknown;
  airDraft?: unknown;
  minCoastDistance?: unknown;
  lockWaitMinutes?: unknown;
  bridgeWaitMinutes?: unknown;
  speedKnots?: unknown;
  safetyMarginDraft?: unknown;
  safetyMarginBeam?: unknown;
  safetyMarginAirDraft?: unknown;
  useTides?: unknown;
  describe?: unknown;
  lang?: unknown;
}

/**
 * Checks the vessel dimensions, coast distance, waits, speed, margins, flags
 * and language of a request and writes the usable values into `out`
 * (null → absent; a dropped dimension → absent). Returns the first error, and
 * the warnings raised so far. Shared by validateRouteRequest and the plugin's
 * `validateRequestConstraints`, which normalises a request in place.
 */
export function checkRequestConstraints(
  body: ConstraintFields,
  limits: RequestLimits,
  out: ConstraintFields,
): { error?: RequestValidationError; warnings: RouteWarning[] } {
  const warnings: RouteWarning[] = [];

  for (const key of VESSEL_DIM_KEYS) {
    const raw = body[key];
    if (raw === undefined || raw === null) {
      out[key] = undefined;
      continue;
    }
    const max = limits.maxDimensionM[key];
    const value = coerceVesselDimension(raw);
    if (value === undefined || value < 0 || value > max) {
      if (limits.strict) {
        const message =
          value === undefined
            ? `Invalid ${key} — expected a number in meters`
            : `Invalid ${key} — expected 0..${max} meters`;
        return {
          ...fail("INVALID_DIMENSION", key, message, { max }),
          warnings,
        };
      }
      out[key] = undefined;
      const label = VESSEL_DIM_LABEL[key];
      const hint = limits.ignoredDimensionHint
        ? limits.ignoredDimensionHint(label)
        : `The default ${label} was used instead.`;
      warnings.push({
        type: "vessel_dimension_ignored",
        message:
          `Ignored the supplied ${label} (${describeValue(raw)}) — ` +
          `expected a number between 0 and ${max} meters. ` +
          hint,
      });
      continue;
    }
    out[key] = value;
  }

  const numeric = (
    key:
      | "minCoastDistance"
      | "lockWaitMinutes"
      | "bridgeWaitMinutes"
      | "speedKnots"
      | "safetyMarginDraft"
      | "safetyMarginBeam"
      | "safetyMarginAirDraft",
    valid: (v: number) => boolean,
    typeMessage: string,
    rangeMessage: string,
    params: Record<string, unknown>,
  ): RequestValidationError | undefined => {
    let v = body[key];
    if (v === null) v = undefined;
    out[key] = v;
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return fail("INVALID_VALUE", key, typeMessage, params).error;
    }
    if (!valid(v))
      return fail("INVALID_VALUE", key, rangeMessage, params).error;
    return undefined;
  };

  let error = numeric(
    "minCoastDistance",
    (v) => v >= 0 && v <= limits.maxCoastDistanceNm,
    "Invalid minCoastDistance — expected a number in nautical miles",
    `Invalid minCoastDistance — expected 0..${limits.maxCoastDistanceNm} nautical miles`,
    { min: 0, max: limits.maxCoastDistanceNm },
  );
  if (error) return { error, warnings };

  // Waits are per-request overrides of the defaults. Zero is meaningful (a lock
  // that never holds you up), so only the range is checked.
  for (const key of ["lockWaitMinutes", "bridgeWaitMinutes"] as const) {
    error = numeric(
      key,
      (v) => v >= 0 && v <= limits.maxWaitMinutes,
      `Invalid ${key} — expected 0..${limits.maxWaitMinutes} minutes`,
      `Invalid ${key} — expected 0..${limits.maxWaitMinutes} minutes`,
      { min: 0, max: limits.maxWaitMinutes },
    );
    if (error) return { error, warnings };
  }

  error = numeric(
    "speedKnots",
    (v) => v > 0 && v <= limits.maxSpeedKnots,
    `Invalid speedKnots — expected a number of knots`,
    `Invalid speedKnots — expected more than 0 and at most ${limits.maxSpeedKnots} knots`,
    { max: limits.maxSpeedKnots },
  );
  if (error) return { error, warnings };

  for (const key of [
    "safetyMarginDraft",
    "safetyMarginBeam",
    "safetyMarginAirDraft",
  ] as const) {
    error = numeric(
      key,
      (v) => v >= 0 && v <= limits.maxSafetyMarginM,
      `Invalid ${key} — expected a number in meters`,
      `Invalid ${key} — expected 0..${limits.maxSafetyMarginM} meters`,
      { min: 0, max: limits.maxSafetyMarginM },
    );
    if (error) return { error, warnings };
  }

  for (const key of ["useTides", "describe"] as const) {
    let v = body[key];
    if (v === null) v = undefined;
    out[key] = v;
    if (v !== undefined && typeof v !== "boolean") {
      return {
        ...fail(
          "INVALID_VALUE",
          key,
          `Invalid ${key} — expected true or false`,
        ),
        warnings,
      };
    }
  }

  let lang = body.lang;
  if (lang === null) lang = undefined;
  out.lang = lang;
  if (
    lang !== undefined &&
    (typeof lang !== "string" || lang.length > limits.maxLangLength)
  ) {
    return {
      ...fail(
        "INVALID_VALUE",
        "lang",
        `Invalid lang — expected a language tag of at most ${limits.maxLangLength} characters`,
        { max: limits.maxLangLength },
      ),
      warnings,
    };
  }
  return { warnings };
}

/**
 * Validate an untrusted route request body.
 *
 * Checks, in this order (the first problem is the one reported): the body is
 * an object; start and end are present and are coordinates in range; via is
 * an array of coordinates with `auto`/`manual` modes, within `maxVias`;
 * `endMode`; `departureTime` is an ISO 8601 string that parses; the vessel,
 * coast, wait, speed, margin, flag and language fields; manual legs are
 * allowed if used; the straight-line distance is within `maxStraightLineNm`.
 */
export function validateRouteRequest(
  body: unknown,
  limits: RequestLimits,
): RequestValidation {
  if (!isRecord(body)) {
    return {
      ok: false,
      ...fail(
        "INVALID_BODY",
        "body",
        "Invalid request — expected a JSON object",
      ),
      warnings: [],
      unknownFields: [],
    };
  }
  const unknownFields = Object.keys(body).filter((k) => !KNOWN_FIELDS.has(k));
  const refuse = (
    e: { error: RequestValidationError },
    warnings: RouteWarning[] = [],
  ): RequestValidation => ({ ok: false, ...e, warnings, unknownFields });

  if (!body.start || !body.end) {
    return refuse(
      fail(
        "MISSING_ENDPOINTS",
        !body.start ? "start" : "end",
        "Missing required fields: start and end coordinates",
      ),
    );
  }

  const rangeMessage = (what: string): string =>
    `${what} out of range — expected latitude -90..90 and longitude -180..180`;
  const ends: Record<"start" | "end", Point> = {} as Record<
    "start" | "end",
    Point
  >;
  for (const key of ["start", "end"] as const) {
    const r = readPoint(body[key], limits.acceptCoordinateAliases);
    if ("problem" in r) {
      return refuse(
        r.problem === "format"
          ? fail(
              "INVALID_COORDINATE",
              key,
              "Invalid coordinate format. Expected {latitude, longitude}",
            )
          : fail("COORDINATE_OUT_OF_RANGE", key, rangeMessage("Coordinate")),
      );
    }
    ends[key] = r.point;
  }

  // 'auto' is the default; only 'manual' changes behaviour — anything else is
  // rejected.
  let via: Array<Point & { mode?: LegMode }> | undefined;
  if (body.via !== undefined) {
    if (!Array.isArray(body.via)) {
      return refuse(
        fail(
          "INVALID_VIA",
          "via",
          "Invalid via — expected an array of {latitude, longitude, mode?}",
        ),
      );
    }
    via = [];
    for (let i = 0; i < body.via.length; i++) {
      const raw = body.via[i];
      const r = readPoint(raw, limits.acceptCoordinateAliases);
      if ("problem" in r) {
        return refuse(
          r.problem === "format"
            ? fail(
                "INVALID_COORDINATE",
                `via[${i}]`,
                "Invalid via coordinate format. Expected {latitude, longitude}",
              )
            : fail(
                "COORDINATE_OUT_OF_RANGE",
                `via[${i}]`,
                rangeMessage("Via coordinate"),
              ),
        );
      }
      const mode = (raw as Record<string, unknown>).mode;
      if (mode !== undefined && mode !== "auto" && mode !== "manual") {
        return refuse(
          fail(
            "INVALID_LEG_MODE",
            `via[${i}].mode`,
            "Invalid via mode — expected 'auto' or 'manual'",
          ),
        );
      }
      via.push(mode === undefined ? r.point : { ...r.point, mode });
    }
    if (via.length > limits.maxVias) {
      return refuse(
        fail(
          "TOO_MANY_VIAS",
          "via",
          `Too many via points (max ${limits.maxVias})`,
          { max: limits.maxVias },
        ),
      );
    }
  }

  const endMode = body.endMode;
  if (endMode !== undefined && endMode !== "auto" && endMode !== "manual") {
    return refuse(
      fail(
        "INVALID_LEG_MODE",
        "endMode",
        "Invalid endMode — expected 'auto' or 'manual'",
      ),
    );
  }

  const departureTime = body.departureTime;
  if (
    departureTime !== undefined &&
    (typeof departureTime !== "string" ||
      !Number.isFinite(Date.parse(departureTime)))
  ) {
    return refuse(
      fail(
        "INVALID_DEPARTURE_TIME",
        "departureTime",
        "Invalid departureTime — expected an ISO 8601 date string",
      ),
    );
  }

  const fields: ConstraintFields = {};
  const checked = checkRequestConstraints(body, limits, fields);
  if (checked.error) return refuse({ error: checked.error }, checked.warnings);
  const warnings = checked.warnings;

  if (!limits.allowManualLegs) {
    const at = via?.findIndex((v) => v.mode === "manual") ?? -1;
    if (at >= 0 || endMode === "manual") {
      return refuse(
        fail(
          "MANUAL_LEGS_NOT_ALLOWED",
          at >= 0 ? `via[${at}].mode` : "endMode",
          "Manual legs are not accepted — every leg is routed automatically",
        ),
        warnings,
      );
    }
  }

  if (limits.maxStraightLineNm !== undefined) {
    const chain = [ends.start, ...(via ?? []), ends.end];
    let metres = 0;
    for (let i = 1; i < chain.length; i++) {
      metres += haversineM(
        chain[i - 1].latitude,
        chain[i - 1].longitude,
        chain[i].latitude,
        chain[i].longitude,
      );
    }
    const nm = metres / 1852;
    if (nm > limits.maxStraightLineNm) {
      return refuse(
        fail(
          "ROUTE_TOO_LONG",
          "end",
          `The route is too long — ${Math.round(nm)} nautical miles in a straight line, at most ${limits.maxStraightLineNm} are accepted`,
          { nm: Math.round(nm), max: limits.maxStraightLineNm },
        ),
        warnings,
      );
    }
  }

  const request: RoutingRequest = { start: ends.start, end: ends.end };
  if (via) request.via = via;
  if (endMode !== undefined) request.endMode = endMode;
  if (departureTime !== undefined) request.departureTime = departureTime;
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) (request as unknown as Record<string, unknown>)[k] = v;
  }
  return { ok: true, request, warnings, unknownFields };
}
