/**
 * Stable codes.
 *
 * Every warning, crossing note and failure the engine produces carries a
 * `code` (UPPER_SNAKE) and `params` (numbers in SI units: metres, seconds;
 * plus the ids and names needed to render the text). Logs, tests and clients
 * match on the code; the English `message` next to it is only a rendering of
 * the code with its params (see messages.ts), so it may be reworded, and a
 * client may render the same code in its own words.
 *
 * Codes are never reused for a different meaning. A warning that renders in
 * more than one way has one code per way (`CONNECTOR_START` and
 * `COVERAGE_GAP_START` are both `start_connecting`-style legs, told apart by
 * the gap threshold). The `type` field of a warning is unchanged and stays the
 * coarse family; the code is the precise one.
 *
 * The params of each code are listed in the catalogue (messages.ts) by the
 * placeholders its templates use.
 */

/** Route-level warnings (`RouteResult.warnings`). */
export const ROUTE_WARNING_CODES = [
  /** A via point no route reaches; it is left out. params: via (1-based). */
  "VIA_SKIPPED",
  /** A via point is cut off from the network and was bridged. params: via. */
  "VIA_LEG_DISCONNECTED",
  /** The destination is cut off from the network and was bridged. */
  "END_LEG_DISCONNECTED",
  /** A manual leg to a via point may cross land. params: via. */
  "MANUAL_LEG_MAY_CROSS_LAND_VIA",
  /** The manual leg to the destination may cross land. */
  "MANUAL_LEG_MAY_CROSS_LAND_END",
  /** Straight connector from the start to the network. params: distance (m). */
  "CONNECTOR_START",
  /** Straight connector from the network to the destination. params: distance. */
  "CONNECTOR_END",
  /** Start connector long enough to be a hole in the data. params: distance. */
  "COVERAGE_GAP_START",
  /** Destination connector long enough to be a hole in the data. */
  "COVERAGE_GAP_END",
  /** The (single-leg) route is constrained for the vessel. params: legs,
   *  distance (m), depth/depthCharted/depthRequired, airDraft/airDraftRequired,
   *  width/beamRequired (m; each group only when it applies). */
  "ROUTE_CONSTRAINED",
  /** A via leg is constrained. params as ROUTE_CONSTRAINED plus via. */
  "VIA_LEG_CONSTRAINED",
  /** The final leg of a via route is constrained. params as ROUTE_CONSTRAINED. */
  "END_LEG_CONSTRAINED",
  /** A supplied vessel dimension was unusable and dropped; the engine default
   *  applies. params: dimension (draft|beam|airDraft), value, max (m). */
  "VESSEL_DIMENSION_IGNORED",
  /** As above, with the dimension configured on the server used instead. */
  "VESSEL_DIMENSION_IGNORED_CONFIGURED",
  /** The route was found but its description could not be read. params:
   *  reason. */
  "DESCRIPTION_UNAVAILABLE",
] as const;
export type RouteWarningCode = (typeof ROUTE_WARNING_CODES)[number];

/** Warnings on an itinerary leg (`ItineraryPoint.leg.warnings`). */
export const LEG_WARNING_CODES = [
  /** params: minDepth (m, charted). */
  "LEG_SHALLOW",
  /** params: minDepth (charted), minDepthAtPassage (m, with the tide). */
  "LEG_SHALLOW_AT_PASSAGE",
  /** params: minWidth (m). */
  "LEG_NARROW",
  /** params: maxAirDraft (m, lowest clearance), requiredAirDraft (m). */
  "LEG_LOW_CLEARANCE",
] as const;
export type LegWarningCode = (typeof LEG_WARNING_CODES)[number];

/** Warnings from the routing database's description of the route. */
export const DESCRIPTION_WARNING_CODES = [
  /** Depth unknown along the stretch. */
  "DEPTH_UNKNOWN",
  /** Depth not charted here. params: quality (the database's id). */
  "DEPTH_NOT_CHARTED",
  /** A line that is not surveyed or reviewed. params: origin. */
  "ORIGIN_UNREVIEWED",
  /** A notice from the data (text is the database's own, not translated).
   *  params: severity, text, name?. */
  "NOTICE",
] as const;
export type DescriptionWarningCode = (typeof DESCRIPTION_WARNING_CODES)[number];

/** Notes on a crossing (`RouteCrossing.note`, with `noteCode`/`noteParams`). */
export const CROSSING_NOTE_CODES = [
  /** An opening span low enough to pass closed. params: airDraft, margin,
   *  closedHeight (m). */
  "CROSSING_PASSES_CLOSED",
  /** As above, and no other structure in the group charges a wait either. */
  "CROSSING_PASSES_CLOSED_NO_WAIT",
] as const;
export type CrossingNoteCode = (typeof CROSSING_NOTE_CODES)[number];

/** Everything a `warnings` entry can carry as `code`. */
export type WarningCode =
  | RouteWarningCode
  | LegWarningCode
  | DescriptionWarningCode;

/** Why a route request failed (`RouteFailure.code`). */
export const FAILURE_CODES = [
  /** No path between the points. params.reason says which kind. */
  "NO_PATH",
  /** A point lies outside every routing region the engine knows. */
  "OUTSIDE_COVERAGE",
  /** No routing node near a point. params: point (start|end|either). */
  "NO_NODE_NEAR_POINT",
  /** The calculation hit a configured budget (reserved; none is configured). */
  "BUDGET_EXCEEDED",
  /** The calculation was aborted (reserved). */
  "ABORTED",
  /** Strict mode: the request lacks vessel or speed. params: missing. */
  "VESSEL_INCOMPLETE",
  /** A routing region the route needs could not be used. */
  "REGION_UNAVAILABLE",
  /** The request is unusable (not a coordinate pair, ...). params: field. */
  "INVALID_REQUEST",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * Catalogue keys that are not a warning or failure code of their own: the
 * wordings of a failure code (`NO_PATH` has several), the request validator's
 * messages, and the export descriptions. A key is the unit of translation.
 */
export const OTHER_MESSAGE_KEYS = [
  "NO_NODE_NEAR_SEARCH",
  "NO_PATH_DISCONNECTED",
  "NO_PATH_PRIMARY_NETWORK",
  "NO_PATH_GRAPH_CONNECTED",
  "NO_PATH_DESTINATION",
  "NO_PATH_START_OUTSIDE_BOX",
  "NO_PATH_SEARCH",
  "ROUTE_RETRIED_SUFFIX",
  "INVALID_BODY",
  "MISSING_ENDPOINTS",
  "INVALID_COORDINATE",
  "INVALID_VIA_COORDINATE",
  "COORDINATE_OUT_OF_RANGE",
  "VIA_COORDINATE_OUT_OF_RANGE",
  "INVALID_VIA",
  "INVALID_VIA_MODE",
  "INVALID_END_MODE",
  "TOO_MANY_VIAS",
  "INVALID_DEPARTURE_TIME",
  "INVALID_NUMBER_METERS",
  "INVALID_RANGE_METERS",
  "INVALID_NUMBER_NM",
  "INVALID_RANGE_NM",
  "INVALID_RANGE_MINUTES",
  "INVALID_NUMBER_KNOTS",
  "INVALID_RANGE_KNOTS",
  "INVALID_BOOLEAN",
  "INVALID_LANG",
  "MANUAL_LEGS_NOT_ALLOWED",
  "ROUTE_TOO_LONG",
  "ROUTE_DESCRIPTION_GPX",
  "ROUTE_DESCRIPTION_SIGNALK",
] as const;
export type OtherMessageKey = (typeof OTHER_MESSAGE_KEYS)[number];

/** Every key the catalogue has an entry for. */
export type MessageKey =
  | RouteWarningCode
  | LegWarningCode
  | DescriptionWarningCode
  | CrossingNoteCode
  | FailureCode
  | OtherMessageKey;

/** All codes that appear on a warning, note or failure, in one list. */
export const ALL_CODES: readonly string[] = [
  ...ROUTE_WARNING_CODES,
  ...LEG_WARNING_CODES,
  ...DESCRIPTION_WARNING_CODES,
  ...CROSSING_NOTE_CODES,
  ...FAILURE_CODES,
];
