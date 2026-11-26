/**
 * The message catalogue: every user-facing text the engine produces (warnings,
 * itinerary phrases, failure messages, request-validation messages, export
 * descriptions), keyed by stable code (codes.ts), in English and Dutch.
 *
 * `format(key, params, lang)` renders one. An unknown language reads as
 * English; a region tag falls back to its language (`nl-BE` -> `nl`).
 *
 * Templates
 *   A template is a string with `{name}` placeholders filled from `params`, or
 *   a function for the few texts that are assembled from parts. A placeholder
 *   may carry a format: `{name:f1}` (one decimal), `{name:nm1}` (metres as
 *   nautical miles, one decimal), `{name:list}`, `{name:space}` (underscores to
 *   spaces), `{name:dim}` (a vessel dimension's name), `{name:pt}` (start/end
 *   word) and `{name:hm}` (seconds as 1h30m). Numbers use the language's
 *   decimal mark: a point in English, a comma in Dutch. A placeholder with no
 *   value is left as written, so a template and its params that disagree show
 *   up in the output (and in the tests) instead of vanishing.
 *
 * English is the reference text: the wording here is what the engine has always
 * said, character for character. A client is free to render a code in its own
 * words from `code` + `params` instead.
 */

import type { MessageKey } from "./codes.js";

export const MESSAGE_LANGUAGES = ["en", "nl"] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

export type MessageParams = Record<string, unknown>;

/** What a function template gets besides its params. */
export interface MessageContext {
  lang: MessageLanguage;
  /** A number as text in the language's decimal mark (`digits` fixed
   *  decimals when given). */
  num(n: number, digits?: number): string;
  /** Renders another catalogue entry in the same language. */
  format(key: MessageKey, params?: MessageParams): string;
  /** Renders a nested cause (`{ code, params }` of a failure, or
   *  `{ message }`) in the same language. */
  cause(value: unknown): string;
}

type Template =
  | string
  | ((params: MessageParams, ctx: MessageContext) => string);

export interface CatalogueEntry {
  en: Template;
  nl: Template;
}

/** Language to render in: the tag's language when the catalogue has it, else
 *  English. Case-insensitive, `-` or `_` separated. */
export function resolveMessageLanguage(
  tag: string | null | undefined,
): MessageLanguage {
  if (typeof tag !== "string") return "en";
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return (MESSAGE_LANGUAGES as readonly string[]).includes(primary)
    ? (primary as MessageLanguage)
    : "en";
}

/** A measured value and the limit it misses, as text: one decimal, or two
 *  when one decimal would print them the same (17.05 vs 17.06 would both
 *  read 17.1, a shortfall that looks like none). */
export function limitPair(value: number, limit: number): [string, string] {
  const a = value.toFixed(1);
  const b = limit.toFixed(1);
  return a === b ? [value.toFixed(2), limit.toFixed(2)] : [a, b];
}

// ---------------------------------------------------------------------------
// Words that differ per language
// ---------------------------------------------------------------------------

const DIMENSION_WORD: Record<MessageLanguage, Record<string, string>> = {
  en: { draft: "draft", beam: "beam", airDraft: "air draft" },
  nl: { draft: "diepgang", beam: "breedte", airDraft: "doorvaarthoogte" },
};

const POINT_WORD: Record<MessageLanguage, Record<string, string>> = {
  en: { start: "start", end: "end", either: "start or end" },
  nl: { start: "startpunt", end: "eindpunt", either: "start- of eindpunt" },
};

const HOUR_MINUTE_UNITS: Record<MessageLanguage, [string, string]> = {
  en: ["h", "m"],
  nl: ["u", "m"],
};

/** Decimal mark: English keeps the point, Dutch uses a comma. */
function mark(text: string, lang: MessageLanguage): string {
  return lang === "nl" ? text.replace(".", ",") : text;
}

function makeContext(lang: MessageLanguage): MessageContext {
  const ctx: MessageContext = {
    lang,
    num: (n, digits) =>
      mark(digits === undefined ? String(n) : n.toFixed(digits), lang),
    format: (key, params = {}) => formatResolved(key, params, lang),
    cause: (value) => formatCause(value, lang),
  };
  return ctx;
}

/** `1h30m` / `45m`, like the export has always written a duration. */
function hourMinutes(seconds: number, lang: MessageLanguage): string {
  const [h, m] = HOUR_MINUTE_UNITS[lang];
  const mins = Math.round(seconds / 60);
  const mm = String(mins % 60).padStart(2, "0");
  return Math.floor(mins / 60) > 0
    ? `${Math.floor(mins / 60)}${h}${mm}${m}`
    : `${mins % 60}${m}`;
}

function applyFormat(
  value: unknown,
  spec: string | undefined,
  lang: MessageLanguage,
): string {
  if (spec === undefined) {
    if (typeof value === "number") return mark(String(value), lang);
    if (Array.isArray(value)) return value.map(String).join(", ");
    return String(value);
  }
  if (spec === "list") {
    return Array.isArray(value) ? value.map(String).join(", ") : String(value);
  }
  if (spec === "space") return String(value).replace(/_/g, " ");
  if (spec === "dim") {
    return DIMENSION_WORD[lang][String(value)] ?? String(value);
  }
  if (spec === "pt") return POINT_WORD[lang][String(value)] ?? String(value);
  if (spec === "hm") return hourMinutes(Number(value), lang);
  const fixed = /^f(\d)$/.exec(spec);
  if (fixed) return mark(Number(value).toFixed(Number(fixed[1])), lang);
  const nm = /^nm(\d)$/.exec(spec);
  if (nm) return mark((Number(value) / 1852).toFixed(Number(nm[1])), lang);
  return String(value);
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)(?::([a-z0-9]+))?\}/g;

function fill(
  template: string,
  params: MessageParams,
  lang: MessageLanguage,
): string {
  return template.replace(PLACEHOLDER, (whole, name: string, spec?: string) => {
    const value = params[name];
    return value === undefined || value === null
      ? whole
      : applyFormat(value, spec, lang);
  });
}

function formatResolved(
  key: MessageKey,
  params: MessageParams,
  lang: MessageLanguage,
): string {
  const entry = CATALOGUE[key];
  if (!entry) return String(key);
  const template = entry[lang];
  return typeof template === "function"
    ? template(params, makeContext(lang))
    : fill(template, params, lang);
}

/**
 * Renders the catalogue entry for `key` with `params`, in `lang` (any tag; see
 * resolveMessageLanguage). An unknown key renders as the key itself.
 */
export function format(
  key: MessageKey,
  params: MessageParams = {},
  lang?: string | null,
): string {
  return formatResolved(key, params, resolveMessageLanguage(lang));
}

/** A failure's wording. A cause is stored as `{ code, params }` (rendered
 *  here) or `{ message }` (an error that is not one of ours, shown as is). */
function formatCause(value: unknown, lang: MessageLanguage): string {
  if (typeof value === "object" && value !== null) {
    const v = value as { code?: unknown; params?: unknown; message?: unknown };
    if (typeof v.code === "string") {
      const params =
        typeof v.params === "object" && v.params !== null
          ? (v.params as MessageParams)
          : {};
      return formatFailure(v.code, params, lang);
    }
    if (typeof v.message === "string") return v.message;
  }
  return String(value);
}

/**
 * The catalogue key that words a failure: its code, or for `NO_PATH` and
 * `NO_NODE_NEAR_POINT` the more specific wording `params.reason` selects.
 */
export function failureMessageKey(
  code: string,
  params: MessageParams,
): MessageKey {
  if (code === "NO_PATH") {
    const reason = params.reason;
    switch (reason) {
      case "disconnected":
        return "NO_PATH_DISCONNECTED";
      case "primary_network":
        return "NO_PATH_PRIMARY_NETWORK";
      case "graph_connected":
        return "NO_PATH_GRAPH_CONNECTED";
      case "destination":
        return "NO_PATH_DESTINATION";
      case "start_outside_box":
        return "NO_PATH_START_OUTSIDE_BOX";
      default:
        return "NO_PATH_SEARCH";
    }
  }
  if (code === "NO_NODE_NEAR_POINT" && params.reason === "search") {
    return "NO_NODE_NEAR_SEARCH";
  }
  return code as MessageKey;
}

/** The text of a failure: the wording of its code, plus the "retried" suffix
 *  when the search was repeated from the nearest nodes. */
export function formatFailure(
  code: string,
  params: MessageParams,
  lang?: string | null,
): string {
  const l = resolveMessageLanguage(lang);
  const base = formatResolved(failureMessageKey(code, params), params, l);
  return params.retried === true
    ? base + formatResolved("ROUTE_RETRIED_SUFFIX", {}, l)
    : base;
}

// ---------------------------------------------------------------------------
// Texts assembled from parts
// ---------------------------------------------------------------------------

/** Why a leg is constrained: depth, clearance and width reasons, joined. */
function constraintReasons(p: MessageParams, ctx: MessageContext): string {
  const reasons: string[] = [];
  const nl = ctx.lang === "nl";
  const atText = (n: number): string => ctx.num(n, 1);
  if (typeof p.depth === "number" && typeof p.depthRequired === "number") {
    const [depth, need] = limitPair(p.depth, p.depthRequired);
    const d = mark(depth, ctx.lang);
    const r = mark(need, ctx.lang);
    if (typeof p.depthCharted === "number") {
      reasons.push(
        nl
          ? `diepte ${d} m bij passage (${atText(p.depthCharted)} m gekarteerd) < vereist ${r} m`
          : `depth ${d}m at passage (${atText(p.depthCharted)}m charted) < required ${r}m`,
      );
    } else {
      reasons.push(
        nl ? `diepte ${d} m < vereist ${r} m` : `depth ${d}m < required ${r}m`,
      );
    }
  }
  if (
    typeof p.airDraft === "number" &&
    typeof p.airDraftRequired === "number"
  ) {
    const [have, need] = limitPair(p.airDraft, p.airDraftRequired);
    const h = mark(have, ctx.lang);
    const r = mark(need, ctx.lang);
    reasons.push(
      nl
        ? `doorvaarthoogte ${h} m < vereist ${r} m`
        : `air draft ${h}m < required ${r}m`,
    );
  }
  if (typeof p.width === "number" && typeof p.beamRequired === "number") {
    const [have, need] = limitPair(p.width, p.beamRequired);
    const h = mark(have, ctx.lang);
    const r = mark(need, ctx.lang);
    reasons.push(
      nl
        ? `breedte ${h} m < vereiste scheepsbreedte ${r} m`
        : `width ${h}m < required beam ${r}m`,
    );
  }
  return reasons.join("; ");
}

function constrained(
  en: (to: string) => string,
  nl: (to: string) => string,
): CatalogueEntry {
  const make =
    (lang: MessageLanguage) =>
    (p: MessageParams, ctx: MessageContext): string => {
      const via = p.via === undefined ? "" : String(p.via);
      const reasons = constraintReasons(p, ctx);
      const distance = ctx.num(Number(p.distance) / 1852, 1);
      const legs = String(p.legs);
      return lang === "nl"
        ? `${nl(via)}: beperkt voor ${legs} traject(en) ${distance} Nm — ${reasons}`
        : `${en(via)}: constrained for ${legs} leg(s) ${distance}Nm — ${reasons}`;
    };
  return { en: make("en"), nl: make("nl") };
}

/** The ` (file covers this area but is not used: why)` tail of a no-node
 *  message, when a refused routing file covers the point. */
function coverageTail(p: MessageParams, lang: MessageLanguage): string {
  if (typeof p.file !== "string") return "";
  const why = typeof p.reason === "string" ? p.reason : "";
  return lang === "nl"
    ? ` (${p.file} dekt dit gebied maar wordt niet gebruikt: ${why})`
    : ` (${p.file} covers this area but is not used: ${why})`;
}

function noNodeNear(
  p: MessageParams,
  ctx: MessageContext,
  search: boolean,
): string {
  const point = POINT_WORD[ctx.lang][String(p.point)] ?? String(p.point);
  const tail = coverageTail(p, ctx.lang);
  if (ctx.lang === "nl") {
    return `${search ? "Kon geen routeringsknooppunten vinden bij het" : "Geen routeringsknooppunten gevonden bij het"} ${point}${tail}`;
  }
  return `${search ? "Could not find routing nodes near" : "No routing nodes found near"} ${point} point${tail}`;
}

const SKIP_WORDS: Record<
  MessageLanguage,
  Record<string, (p: MessageParams, ctx: MessageContext) => string>
> = {
  en: {
    land: (p) => `${p.land} edge(s) blocked by land`,
    obstacle: (p) => `${p.obstacle} edge(s) blocked by an obstacle`,
    draft: (p, c) =>
      `${p.draftEdges} edge(s) too shallow for draft ${c.num(Number(p.draft))}m`,
    airDraft: (p, c) =>
      `${p.airDraftEdges} edge(s) with insufficient air draft for airDraft ${c.num(Number(p.airDraft))}m`,
    beam: (p, c) =>
      `${p.beamEdges} edge(s) too narrow for beam ${c.num(Number(p.beam))}m`,
    coastDistance: (p) =>
      `${p.coastDistanceEdges} edge(s) closer to shore than the requested minCoastDistance`,
    bbox: (p) =>
      `${p.bboxEdges} edge(s) outside the current search bounding box`,
  },
  nl: {
    land: (p) => `${p.land} verbinding(en) geblokkeerd door land`,
    obstacle: (p) =>
      `${p.obstacle} verbinding(en) geblokkeerd door een obstakel`,
    draft: (p, c) =>
      `${p.draftEdges} verbinding(en) te ondiep voor diepgang ${c.num(Number(p.draft))} m`,
    airDraft: (p, c) =>
      `${p.airDraftEdges} verbinding(en) met onvoldoende doorvaarthoogte voor hoogte ${c.num(Number(p.airDraft))} m`,
    beam: (p, c) =>
      `${p.beamEdges} verbinding(en) te smal voor breedte ${c.num(Number(p.beam))} m`,
    coastDistance: (p) =>
      `${p.coastDistanceEdges} verbinding(en) dichter bij de kust dan de gevraagde minimale kustafstand`,
    bbox: (p) => `${p.bboxEdges} verbinding(en) buiten het huidige zoekgebied`,
  },
};

const SKIP_ORDER = [
  "land",
  "obstacle",
  "draft",
  "airDraft",
  "beam",
  "coastDistance",
  "bbox",
] as const;

/** Edge counts per reason, as `params.skipped` records them. */
function searchFailure(p: MessageParams, ctx: MessageContext): string {
  const skipped = (p.skipped ?? {}) as Record<string, number>;
  const view: MessageParams = {
    land: skipped.land,
    obstacle: skipped.obstacle,
    draftEdges: skipped.draft,
    airDraftEdges: skipped.airDraft,
    beamEdges: skipped.beam,
    coastDistanceEdges: skipped.coastDistance,
    bboxEdges: skipped.bbox,
    draft: p.draft,
    airDraft: p.airDraft,
    beam: p.beam,
  };
  const causes = SKIP_ORDER.filter((k) => (skipped[k] ?? 0) > 0).map((k) =>
    SKIP_WORDS[ctx.lang][k](view, ctx),
  );
  const limit = p.iterationLimit === true;
  const nl = ctx.lang === "nl";
  let detail: string;
  if (causes.length === 0) {
    detail = limit
      ? nl
        ? "het zoekproces overschreed zijn iteratielimiet voordat er een pad gevonden was — het gebied is mogelijk te groot voor het huidige zoekgebied."
        : "the search exceeded its iteration limit before finding a path — the area may be too large for the current bounding box."
      : nl
        ? "het doel lijkt vanaf de start onbereikbaar — het netwerk is hier mogelijk onderbroken (geen verbindingen tussen de twee gebieden), los van scheepsafmetingen of kustafstand-instellingen."
        : "the destination appears unreachable from the start — the graph may be disconnected here (no edges connect the two areas), independent of vessel size or coast-distance settings.";
  } else {
    detail = nl
      ? `tijdens het zoeken zijn de volgende beperkingen tegengekomen: ${causes.join(", ")}.` +
        (limit
          ? " Het zoekproces overschreed ook zijn iteratielimiet voordat het klaar was."
          : "")
      : `during the search, ran into: ${causes.join(", ")}.` +
        (limit
          ? " The search also exceeded its iteration limit before finishing."
          : "");
  }
  const coast = ctx.num(Number(p.minCoastDistance) / 1852, 2);
  const draft = ctx.num(Number(p.draft));
  const beam = ctx.num(Number(p.beam));
  const air = ctx.num(Number(p.airDraft));
  return nl
    ? `Geen route gevonden tussen de opgegeven punten — ${detail} (scheepsafmetingen: diepgang=${draft} m, breedte=${beam} m, doorvaarthoogte=${air} m, minimale kustafstand=${coast} Nm)`
    : `No route found between the given points — ${detail} ` +
        `(vessel dims: draft=${draft}m, beam=${beam}m, airDraft=${air}m, minCoastDistance=${coast}nm)`;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const CATALOGUE: Record<MessageKey, CatalogueEntry> = {
  // --- route warnings ------------------------------------------------------
  VIA_SKIPPED: {
    en: "Via point {via} is unreachable via any route — skipped.",
    nl: "Tussenpunt {via} is via geen enkele route bereikbaar — overgeslagen.",
  },
  VIA_LEG_DISCONNECTED: {
    en: "Via point {via} is disconnected in the waterway network — bridged via nearest reachable node.",
    nl: "Tussenpunt {via} ligt los van het vaarwegennetwerk — overbrugd via het dichtstbijzijnde bereikbare knooppunt.",
  },
  END_LEG_DISCONNECTED: {
    en: "Destination is disconnected in the waterway network — bridged via nearest reachable node.",
    nl: "De bestemming ligt los van het vaarwegennetwerk — overbrugd via het dichtstbijzijnde bereikbare knooppunt.",
  },
  MANUAL_LEG_MAY_CROSS_LAND_VIA: {
    en: "Manual leg to via point {via} may cross land or uncharted water — verify against the chart.",
    nl: "Handmatig traject naar tussenpunt {via} kan over land of niet-gekarteerd water lopen — controleer dit op de kaart.",
  },
  MANUAL_LEG_MAY_CROSS_LAND_END: {
    en: "Manual leg to destination may cross land or uncharted water — verify against the chart.",
    nl: "Handmatig traject naar de bestemming kan over land of niet-gekarteerd water lopen — controleer dit op de kaart.",
  },
  CONNECTOR_START: {
    en: "{distance}m from the start position to the nearest charted waterway.",
    nl: "{distance} m van de startpositie naar de dichtstbijzijnde gekarteerde vaarweg.",
  },
  CONNECTOR_END: {
    en: "{distance}m from the nearest charted waterway to the destination.",
    nl: "{distance} m van de dichtstbijzijnde gekarteerde vaarweg naar de bestemming.",
  },
  COVERAGE_GAP_START: {
    en: "{distance}m from the start position to the nearest charted waterway — a straight line, not a routed path, and not depth-checked. Likely a gap in the routing data covering this area.",
    nl: "{distance} m van de startpositie naar de dichtstbijzijnde gekarteerde vaarweg — een rechte lijn, geen berekende route en niet op diepte gecontroleerd. Waarschijnlijk een gat in de routeringsgegevens voor dit gebied.",
  },
  COVERAGE_GAP_END: {
    en: "{distance}m from the nearest charted waterway to the destination — a straight line, not a routed path, and not depth-checked. Likely a gap in the routing data covering this area.",
    nl: "{distance} m van de dichtstbijzijnde gekarteerde vaarweg naar de bestemming — een rechte lijn, geen berekende route en niet op diepte gecontroleerd. Waarschijnlijk een gat in de routeringsgegevens voor dit gebied.",
  },
  ROUTE_CONSTRAINED: constrained(
    () => "Route to destination",
    () => "Route naar bestemming",
  ),
  VIA_LEG_CONSTRAINED: constrained(
    (via) => `Route to Via point ${via}`,
    (via) => `Route naar tussenpunt ${via}`,
  ),
  END_LEG_CONSTRAINED: constrained(
    () => "Route to Destination",
    () => "Route naar bestemming",
  ),
  VESSEL_DIMENSION_IGNORED: {
    en: "Ignored the supplied {dimension:dim} ({value}) — expected a number between 0 and {max} meters. The default {dimension:dim} was used instead.",
    nl: "De opgegeven {dimension:dim} ({value}) is genegeerd — verwacht een getal tussen 0 en {max} meter. In plaats daarvan is de standaardwaarde voor {dimension:dim} gebruikt.",
  },
  VESSEL_DIMENSION_IGNORED_CONFIGURED: {
    en: "Ignored the supplied {dimension:dim} ({value}) — expected a number between 0 and {max} meters. Routed with the {dimension:dim} configured on the server instead; check the vessel dimensions in Signal K.",
    nl: "De opgegeven {dimension:dim} ({value}) is genegeerd — verwacht een getal tussen 0 en {max} meter. In plaats daarvan is de op de server ingestelde {dimension:dim} gebruikt; controleer de scheepsafmetingen in Signal K.",
  },
  DESCRIPTION_UNAVAILABLE: {
    en: "Route description unavailable: {reason}",
    nl: "Routebeschrijving niet beschikbaar: {reason}",
  },

  // --- itinerary leg warnings ----------------------------------------------
  LEG_SHALLOW: {
    en: "Shallow ({minDepth:f1}m)",
    nl: "Ondiep ({minDepth:f1} m)",
  },
  LEG_SHALLOW_AT_PASSAGE: {
    en: "Shallow ({minDepth:f1}m charted, {minDepthAtPassage:f1}m at passage)",
    nl: "Ondiep ({minDepth:f1} m gekarteerd, {minDepthAtPassage:f1} m bij passage)",
  },
  LEG_NARROW: {
    en: "Narrow ({minWidth:f1}m)",
    nl: "Smal ({minWidth:f1} m)",
  },
  LEG_LOW_CLEARANCE: {
    en: (p) => {
      const [have, need] = limitPair(
        Number(p.maxAirDraft),
        Number(p.requiredAirDraft),
      );
      return `Low clearance (${have}m, need ${need}m)`;
    },
    nl: (p) => {
      const [have, need] = limitPair(
        Number(p.maxAirDraft),
        Number(p.requiredAirDraft),
      );
      return `Lage doorvaarthoogte (${mark(have, "nl")} m, nodig ${mark(need, "nl")} m)`;
    },
  },

  // --- route description warnings ------------------------------------------
  DEPTH_UNKNOWN: {
    en: "Depth unknown along this stretch",
    nl: "Diepte onbekend op dit traject",
  },
  DEPTH_NOT_CHARTED: {
    en: "Depth not charted here ({quality:space})",
    nl: "Diepte hier niet gekarteerd ({quality:space})",
  },
  ORIGIN_UNREVIEWED: {
    en: "This line is {origin}, not surveyed or reviewed as the charted ones",
    nl: "Deze lijn is {origin}, niet opgemeten of gecontroleerd zoals de gekarteerde lijnen",
  },
  NOTICE: { en: "{text}", nl: "{text}" },

  // --- crossing notes ------------------------------------------------------
  CROSSING_PASSES_CLOSED: {
    en: "passes closed (air draft {airDraft:f1} m + {margin:f1} m margin < closed {closedHeight:f1} m)",
    nl: "kan gesloten gepasseerd worden (doorvaarthoogte {airDraft:f1} m + {margin:f1} m marge < gesloten {closedHeight:f1} m)",
  },
  CROSSING_PASSES_CLOSED_NO_WAIT: {
    en: "passes closed (air draft {airDraft:f1} m + {margin:f1} m margin < closed {closedHeight:f1} m), no wait",
    nl: "kan gesloten gepasseerd worden (doorvaarthoogte {airDraft:f1} m + {margin:f1} m marge < gesloten {closedHeight:f1} m), geen wachttijd",
  },

  // --- failures ------------------------------------------------------------
  NO_PATH: {
    en: "No route found between the given points",
    nl: "Geen route gevonden tussen de opgegeven punten",
  },
  OUTSIDE_COVERAGE: {
    en: (p, c) => noNodeNear(p, c, false),
    nl: (p, c) => noNodeNear(p, c, false),
  },
  NO_NODE_NEAR_POINT: {
    en: (p, c) => noNodeNear(p, c, false),
    nl: (p, c) => noNodeNear(p, c, false),
  },
  BUDGET_EXCEEDED: {
    en: "The route calculation exceeded its budget",
    nl: "De routeberekening heeft haar limiet overschreden",
  },
  ABORTED: {
    en: "The route calculation was aborted",
    nl: "De routeberekening is afgebroken",
  },
  VESSEL_INCOMPLETE: {
    en: "The request must carry the vessel and speed; missing: {missing:list}",
    nl: "De aanvraag moet het schip en de snelheid bevatten; ontbrekend: {missing:list}",
  },
  REGION_UNAVAILABLE: {
    en: (p, c) =>
      p.point === undefined
        ? "A routing region needed for this route could not be loaded"
        : noNodeNear(p, c, false),
    nl: (p, c) =>
      p.point === undefined
        ? "Een voor deze route benodigd routeringsgebied kon niet worden geladen"
        : noNodeNear(p, c, false),
  },
  INVALID_REQUEST: {
    en: "Invalid route request — start and end must be latitude/longitude coordinates",
    nl: "Ongeldige routeaanvraag — start en einde moeten breedte-/lengtegraadcoördinaten zijn",
  },
  NO_NODE_NEAR_SEARCH: {
    en: (p, c) => noNodeNear(p, c, true),
    nl: (p, c) => noNodeNear(p, c, true),
  },
  NO_PATH_DISCONNECTED: {
    en: "No route found — the start and end are in disconnected parts of the waterway network (e.g. separated by a lock or unconnected water body) and no bridging point could be found at either end.",
    nl: "Geen route gevonden — het start- en eindpunt liggen in niet-verbonden delen van het vaarwegennetwerk (bijvoorbeeld gescheiden door een sluis of een los water) en aan geen van beide kanten kon een overbruggingspunt worden gevonden.",
  },
  NO_PATH_PRIMARY_NETWORK: {
    en: (p, c) =>
      `No route found through the primary waterway network between the connection points: ${c.cause(p.cause)}`,
    nl: (p, c) =>
      `Geen route gevonden door het hoofdvaarwegennetwerk tussen de aansluitpunten: ${c.cause(p.cause)}`,
  },
  NO_PATH_GRAPH_CONNECTED: {
    en: (p, c) =>
      "No route found — graph is connected but A* could not find a path. " +
      "This should not happen with soft constraints enabled." +
      (p.cause === undefined ? "" : ` Last search error: ${c.cause(p.cause)}`),
    nl: (p, c) =>
      "Geen route gevonden — het netwerk is samenhangend, maar het zoekalgoritme vond geen pad. " +
      "Dit zou niet mogen gebeuren met zachte beperkingen." +
      (p.cause === undefined ? "" : ` Laatste zoekfout: ${c.cause(p.cause)}`),
  },
  NO_PATH_DESTINATION: {
    en: (p, c) =>
      "No route found to destination" +
      (p.cause === undefined ? "" : `: ${c.cause(p.cause)}`),
    nl: (p, c) =>
      "Geen route gevonden naar de bestemming" +
      (p.cause === undefined ? "" : `: ${c.cause(p.cause)}`),
  },
  NO_PATH_START_OUTSIDE_BOX: {
    en: "Start node is outside the routing bounding box",
    nl: "Het startknooppunt ligt buiten het zoekgebied van de route",
  },
  NO_PATH_SEARCH: { en: searchFailure, nl: searchFailure },
  ROUTE_RETRIED_SUFFIX: {
    en: " [retried from the nearest nodes after the better-depth endpoint(s) found no path]",
    nl: " [opnieuw geprobeerd vanaf de dichtstbijzijnde knooppunten nadat het eindpunt met betere diepte geen pad opleverde]",
  },

  // --- request validation --------------------------------------------------
  INVALID_BODY: {
    en: "Invalid request — expected a JSON object",
    nl: "Ongeldige aanvraag — een JSON-object werd verwacht",
  },
  MISSING_ENDPOINTS: {
    en: "Missing required fields: start and end coordinates",
    nl: "Verplichte velden ontbreken: start- en eindcoördinaten",
  },
  INVALID_COORDINATE: {
    en: "Invalid coordinate format. Expected {latitude, longitude}",
    nl: "Ongeldig coördinaatformaat. Verwacht: {latitude, longitude}",
  },
  INVALID_VIA_COORDINATE: {
    en: "Invalid via coordinate format. Expected {latitude, longitude}",
    nl: "Ongeldig coördinaatformaat voor tussenpunt. Verwacht: {latitude, longitude}",
  },
  COORDINATE_OUT_OF_RANGE: {
    en: "Coordinate out of range — expected latitude -90..90 and longitude -180..180",
    nl: "Coördinaat buiten bereik — breedtegraad -90..90 en lengtegraad -180..180 verwacht",
  },
  VIA_COORDINATE_OUT_OF_RANGE: {
    en: "Via coordinate out of range — expected latitude -90..90 and longitude -180..180",
    nl: "Coördinaat van tussenpunt buiten bereik — breedtegraad -90..90 en lengtegraad -180..180 verwacht",
  },
  INVALID_VIA: {
    en: "Invalid via — expected an array of {latitude, longitude, mode?}",
    nl: "Ongeldig via — een lijst van {latitude, longitude, mode?} werd verwacht",
  },
  INVALID_VIA_MODE: {
    en: "Invalid via mode — expected 'auto' or 'manual'",
    nl: "Ongeldige via-modus — 'auto' of 'manual' werd verwacht",
  },
  INVALID_END_MODE: {
    en: "Invalid endMode — expected 'auto' or 'manual'",
    nl: "Ongeldige endMode — 'auto' of 'manual' werd verwacht",
  },
  TOO_MANY_VIAS: {
    en: "Too many via points (max {max})",
    nl: "Te veel tussenpunten (maximaal {max})",
  },
  INVALID_DEPARTURE_TIME: {
    en: "Invalid departureTime — expected an ISO 8601 date string",
    nl: "Ongeldige departureTime — een ISO 8601-datumtekst werd verwacht",
  },
  INVALID_NUMBER_METERS: {
    en: "Invalid {field} — expected a number in meters",
    nl: "Ongeldige {field} — een getal in meters werd verwacht",
  },
  INVALID_RANGE_METERS: {
    en: "Invalid {field} — expected 0..{max} meters",
    nl: "Ongeldige {field} — 0..{max} meter werd verwacht",
  },
  INVALID_NUMBER_NM: {
    en: "Invalid {field} — expected a number in nautical miles",
    nl: "Ongeldige {field} — een getal in zeemijlen werd verwacht",
  },
  INVALID_RANGE_NM: {
    en: "Invalid {field} — expected 0..{max} nautical miles",
    nl: "Ongeldige {field} — 0..{max} zeemijl werd verwacht",
  },
  INVALID_RANGE_MINUTES: {
    en: "Invalid {field} — expected 0..{max} minutes",
    nl: "Ongeldige {field} — 0..{max} minuten werd verwacht",
  },
  INVALID_NUMBER_KNOTS: {
    en: "Invalid {field} — expected a number of knots",
    nl: "Ongeldige {field} — een aantal knopen werd verwacht",
  },
  INVALID_RANGE_KNOTS: {
    en: "Invalid {field} — expected more than 0 and at most {max} knots",
    nl: "Ongeldige {field} — meer dan 0 en ten hoogste {max} knopen werd verwacht",
  },
  INVALID_BOOLEAN: {
    en: "Invalid {field} — expected true or false",
    nl: "Ongeldige {field} — true of false werd verwacht",
  },
  INVALID_LANG: {
    en: "Invalid lang — expected a language tag of at most {max} characters",
    nl: "Ongeldige lang — een taalcode van ten hoogste {max} tekens werd verwacht",
  },
  MANUAL_LEGS_NOT_ALLOWED: {
    en: "Manual legs are not accepted — every leg is routed automatically",
    nl: "Handmatige trajecten worden niet geaccepteerd — elk traject wordt automatisch berekend",
  },
  ROUTE_TOO_LONG: {
    en: "The route is too long — {nm} nautical miles in a straight line, at most {max} are accepted",
    nl: "De route is te lang — {nm} zeemijl hemelsbreed, er worden er hoogstens {max} geaccepteerd",
  },

  // --- exports -------------------------------------------------------------
  ROUTE_DESCRIPTION_GPX: {
    en: (p, c) =>
      `Route calculated by ${p.provider} - Distance: ${c.num(Number(p.distance), 0)}m, Cost: ${c.num(Number(p.cost), 2)}` +
      durationTail(p, c),
    nl: (p, c) =>
      `Route berekend door ${p.provider} - Afstand: ${c.num(Number(p.distance), 0)} m, Kosten: ${c.num(Number(p.cost), 2)}` +
      durationTail(p, c),
  },
  ROUTE_DESCRIPTION_SIGNALK: {
    en: (p, c) =>
      `Route calculated by ${p.provider} - Distance: ${c.num(Number(p.distance), 0)}m`,
    nl: (p, c) =>
      `Route berekend door ${p.provider} - Afstand: ${c.num(Number(p.distance), 0)} m`,
  },
};

/** `, Duration: 1h30m (10m waiting)` when the route has a duration. */
function durationTail(p: MessageParams, ctx: MessageContext): string {
  if (typeof p.duration !== "number") return "";
  const nl = ctx.lang === "nl";
  const total = hourMinutes(p.duration, ctx.lang);
  const waiting =
    typeof p.waiting === "number" && p.waiting > 0
      ? nl
        ? ` (${hourMinutes(p.waiting, ctx.lang)} wachttijd)`
        : ` (${hourMinutes(p.waiting, ctx.lang)} waiting)`
      : "";
  return (nl ? `, Duur: ${total}` : `, Duration: ${total}`) + waiting;
}
