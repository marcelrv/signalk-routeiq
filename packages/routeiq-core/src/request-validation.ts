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

import type { MessageKey } from "./codes.js";
import { format } from "./messages.js";
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
   * Non-strict only. What the "Ignored the supplied …" warning says was used
   * instead: `"default"` (the engine's default dimension; the default) or
   * `"configured"` (the dimension configured on the server).
   */
  ignoredDimensionFallback?: "default" | "configured";
  /**
   * Language of the messages: `"request"` follows the body's `lang` (a
   * language the catalogue lacks reads as English), any other value is a
   * language tag used for every request. Default `"request"`.
   */
  messageLanguage?: "request" | string;
}

/** The language the messages for this body are written in. */
function messageLang(limits: RequestLimits, body: unknown): string {
  const lang = limits.messageLanguage ?? "request";
  if (lang !== "request") return lang;
  return isRecord(body) && typeof body.lang === "string" ? body.lang : "en";
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
  /** The message catalogue key `message` was rendered from. Errors that
   *  share a `code` (a wrong type and an out-of-range number are both
   *  `INVALID_VALUE`) differ here. */
  messageKey: MessageKey;
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

/** A validation error. `key` words it (catalogue); the text may use the field
 *  name, which is not part of `params`. */
function fail(
  lang: string,
  code: RequestErrorCode,
  key: MessageKey,
  field: string,
  params: Record<string, unknown> = {},
): { error: RequestValidationError } {
  return {
    error: {
      code,
      field,
      message: format(key, { field, ...params }, lang),
      messageKey: key,
      params,
    },
  };
}

/** What a value was, for the `received` param: its JSON kind, with numbers
 *  that are not finite named apart. */
function receivedKind(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? "number" : "nonFinite";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
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
  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(Math.min(1, Math.max(0, a))),
      Math.sqrt(Math.min(1, Math.max(0, 1 - a))),
    )
  );
}

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;

/** ISO-8601 date-time (`YYYY-MM-DDTHH:MM[:SS[.sss]]`, optional `Z` or
 *  `±HH:MM`) that names a real instant. RFC 2822 / toUTCString forms are out. */
function isIsoDateTime(value: string): boolean {
  const m = ISO_DATE_TIME.exec(value);
  if (!m) return false;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  // Date.parse rolls an impossible day over (Feb 30 reads as Mar 2), so the
  // calendar date is checked from its components.
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]) return false;
  const offset = m[7];
  if (offset !== undefined && offset !== "Z") {
    if (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)
      return false;
  }
  return Number.isFinite(Date.parse(value));
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
    // An alias is only a stand-in for an absent canonical key.
    if (latitude === undefined) latitude = raw.lat;
    if (longitude === undefined) longitude = raw.lng ?? raw.lon;
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
  const lang = messageLang(limits, body);

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
        return {
          ...fail(
            lang,
            "INVALID_DIMENSION",
            value === undefined
              ? "INVALID_NUMBER_METERS"
              : "INVALID_RANGE_METERS",
            key,
            value === undefined
              ? { max, received: receivedKind(raw) }
              : { max, value },
          ),
          warnings,
        };
      }
      out[key] = undefined;
      const code =
        limits.ignoredDimensionFallback === "configured"
          ? "VESSEL_DIMENSION_IGNORED_CONFIGURED"
          : "VESSEL_DIMENSION_IGNORED";
      const params = { dimension: key, value: describeValue(raw), max };
      warnings.push({
        type: "vessel_dimension_ignored",
        code,
        params,
        message: format(code, params, lang),
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
    typeKey: MessageKey,
    rangeKey: MessageKey,
    params: Record<string, unknown>,
  ): RequestValidationError | undefined => {
    let v = body[key];
    if (v === null) v = undefined;
    out[key] = v;
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return fail(lang, "INVALID_VALUE", typeKey, key, {
        ...params,
        received: receivedKind(v),
      }).error;
    }
    if (!valid(v))
      return fail(lang, "INVALID_VALUE", rangeKey, key, {
        ...params,
        value: v,
      }).error;
    return undefined;
  };

  let error = numeric(
    "minCoastDistance",
    (v) => v >= 0 && v <= limits.maxCoastDistanceNm,
    "INVALID_NUMBER_NM",
    "INVALID_RANGE_NM",
    { min: 0, max: limits.maxCoastDistanceNm },
  );
  if (error) return { error, warnings };

  // Waits are per-request overrides of the defaults. Zero is meaningful (a lock
  // that never holds you up), so only the range is checked.
  for (const key of ["lockWaitMinutes", "bridgeWaitMinutes"] as const) {
    error = numeric(
      key,
      (v) => v >= 0 && v <= limits.maxWaitMinutes,
      "INVALID_RANGE_MINUTES",
      "INVALID_RANGE_MINUTES",
      { min: 0, max: limits.maxWaitMinutes },
    );
    if (error) return { error, warnings };
  }

  error = numeric(
    "speedKnots",
    (v) => v > 0 && v <= limits.maxSpeedKnots,
    "INVALID_NUMBER_KNOTS",
    "INVALID_RANGE_KNOTS",
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
      "INVALID_NUMBER_METERS",
      "INVALID_RANGE_METERS",
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
        ...fail(lang, "INVALID_VALUE", "INVALID_BOOLEAN", key),
        warnings,
      };
    }
  }

  let langValue = body.lang;
  if (langValue === null) langValue = undefined;
  out.lang = langValue;
  if (
    langValue !== undefined &&
    (typeof langValue !== "string" || langValue.length > limits.maxLangLength)
  ) {
    return {
      ...fail(lang, "INVALID_VALUE", "INVALID_LANG", "lang", {
        max: limits.maxLangLength,
      }),
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
  const lang = messageLang(limits, body);
  if (!isRecord(body)) {
    return {
      ok: false,
      ...fail(lang, "INVALID_BODY", "INVALID_BODY", "body"),
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
        lang,
        "MISSING_ENDPOINTS",
        "MISSING_ENDPOINTS",
        !body.start ? "start" : "end",
      ),
    );
  }

  const ends: Record<"start" | "end", Point> = {} as Record<
    "start" | "end",
    Point
  >;
  for (const key of ["start", "end"] as const) {
    const r = readPoint(body[key], limits.acceptCoordinateAliases);
    if ("problem" in r) {
      return refuse(
        r.problem === "format"
          ? fail(lang, "INVALID_COORDINATE", "INVALID_COORDINATE", key)
          : fail(
              lang,
              "COORDINATE_OUT_OF_RANGE",
              "COORDINATE_OUT_OF_RANGE",
              key,
            ),
      );
    }
    ends[key] = r.point;
  }

  // 'auto' is the default; only 'manual' changes behaviour — anything else is
  // rejected.
  let via: Array<Point & { mode?: LegMode }> | undefined;
  if (body.via !== undefined) {
    if (!Array.isArray(body.via)) {
      return refuse(fail(lang, "INVALID_VIA", "INVALID_VIA", "via"));
    }
    if (body.via.length > limits.maxVias) {
      return refuse(
        fail(lang, "TOO_MANY_VIAS", "TOO_MANY_VIAS", "via", {
          max: limits.maxVias,
        }),
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
                lang,
                "INVALID_COORDINATE",
                "INVALID_VIA_COORDINATE",
                `via[${i}]`,
              )
            : fail(
                lang,
                "COORDINATE_OUT_OF_RANGE",
                "VIA_COORDINATE_OUT_OF_RANGE",
                `via[${i}]`,
              ),
        );
      }
      const mode = (raw as Record<string, unknown>).mode;
      if (mode !== undefined && mode !== "auto" && mode !== "manual") {
        return refuse(
          fail(lang, "INVALID_LEG_MODE", "INVALID_VIA_MODE", `via[${i}].mode`),
        );
      }
      via.push(mode === undefined ? r.point : { ...r.point, mode });
    }
  }

  const endMode = body.endMode;
  if (endMode !== undefined && endMode !== "auto" && endMode !== "manual") {
    return refuse(
      fail(lang, "INVALID_LEG_MODE", "INVALID_END_MODE", "endMode"),
    );
  }

  const departureTime = body.departureTime;
  if (
    departureTime !== undefined &&
    (typeof departureTime !== "string" || !isIsoDateTime(departureTime))
  ) {
    return refuse(
      fail(
        lang,
        "INVALID_DEPARTURE_TIME",
        "INVALID_DEPARTURE_TIME",
        "departureTime",
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
          lang,
          "MANUAL_LEGS_NOT_ALLOWED",
          "MANUAL_LEGS_NOT_ALLOWED",
          at >= 0 ? `via[${at}].mode` : "endMode",
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
    if (!Number.isFinite(nm) || nm > limits.maxStraightLineNm) {
      return refuse(
        fail(lang, "ROUTE_TOO_LONG", "ROUTE_TOO_LONG", "end", {
          nm: Number.isFinite(nm) ? Math.round(nm) : 0,
          max: limits.maxStraightLineNm,
        }),
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
