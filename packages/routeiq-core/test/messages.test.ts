import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  ALL_CODES,
  CATALOGUE,
  CROSSING_NOTE_CODES,
  DESCRIPTION_WARNING_CODES,
  FAILURE_CODES,
  LEG_WARNING_CODES,
  MESSAGE_LANGUAGES,
  OTHER_MESSAGE_KEYS,
  ROUTE_WARNING_CODES,
  SILENT_LOGGER,
  failureMessageKey,
  format,
  formatFailure,
  resolveLogger,
  resolveMessageLanguage,
  type MessageKey,
} from '../dist/index.js';

type Sample = { params: Record<string, unknown>; en: string };

const CONSTRAINED = {
  legs: 2,
  distance: 3704,
  depth: 1.2,
  depthRequired: 2.3,
  airDraft: 11,
  airDraftRequired: 21,
  width: 4.5,
  beamRequired: 6,
};
const CONSTRAINED_TEXT =
  ': constrained for 2 leg(s) 2.0Nm — depth 1.2m < required 2.3m; air draft 11.0m < required 21.0m; width 4.5m < required beam 6.0m';
const SEARCH = {
  reason: 'search',
  skipped: { land: 3, obstacle: 0, draft: 2, airDraft: 0, beam: 1, coastDistance: 0, bbox: 4 },
  iterationLimit: false,
  draft: 2,
  beam: 4.5,
  airDraft: 19.5,
  minCoastDistance: 1852,
};
const IGNORED = ' (abc) — expected a number between 0 and 150 meters. ';

/**
 * Every key of the catalogue, with params to render it and the English text
 * the engine produced before the catalogue existed (written out here by hand,
 * not read back from the catalogue). Typed on MessageKey, so a key added to the
 * catalogue without a sample here does not compile.
 */
const SAMPLES: Record<MessageKey, Sample> = {
  VIA_SKIPPED: { params: { via: 2 }, en: 'Via point 2 is unreachable via any route — skipped.' },
  VIA_LEG_DISCONNECTED: {
    params: { via: 1 },
    en: 'Via point 1 is disconnected in the waterway network — bridged via nearest reachable node.',
  },
  END_LEG_DISCONNECTED: {
    params: {},
    en: 'Destination is disconnected in the waterway network — bridged via nearest reachable node.',
  },
  MANUAL_LEG_MAY_CROSS_LAND_VIA: {
    params: { via: 3 },
    en: 'Manual leg to via point 3 may cross land or uncharted water — verify against the chart.',
  },
  MANUAL_LEG_MAY_CROSS_LAND_END: {
    params: {},
    en: 'Manual leg to destination may cross land or uncharted water — verify against the chart.',
  },
  CONNECTOR_START: { params: { distance: 45 }, en: '45m from the start position to the nearest charted waterway.' },
  CONNECTOR_END: { params: { distance: 45 }, en: '45m from the nearest charted waterway to the destination.' },
  COVERAGE_GAP_START: {
    params: { distance: 4000 },
    en: '4000m from the start position to the nearest charted waterway — a straight line, not a routed path, and not depth-checked. Likely a gap in the routing data covering this area.',
  },
  COVERAGE_GAP_END: {
    params: { distance: 4000 },
    en: '4000m from the nearest charted waterway to the destination — a straight line, not a routed path, and not depth-checked. Likely a gap in the routing data covering this area.',
  },
  ROUTE_CONSTRAINED: { params: CONSTRAINED, en: 'Route to destination' + CONSTRAINED_TEXT },
  VIA_LEG_CONSTRAINED: { params: { ...CONSTRAINED, via: 2 }, en: 'Route to Via point 2' + CONSTRAINED_TEXT },
  END_LEG_CONSTRAINED: { params: CONSTRAINED, en: 'Route to Destination' + CONSTRAINED_TEXT },
  VESSEL_DIMENSION_IGNORED: {
    params: { dimension: 'airDraft', value: 'abc', max: 150 },
    en: 'Ignored the supplied air draft' + IGNORED + 'The default air draft was used instead.',
  },
  VESSEL_DIMENSION_IGNORED_CONFIGURED: {
    params: { dimension: 'airDraft', value: 'abc', max: 150 },
    en:
      'Ignored the supplied air draft' +
      IGNORED +
      'Routed with the air draft configured on the server instead; check the vessel dimensions in Signal K.',
  },
  DESCRIPTION_UNAVAILABLE: { params: { reason: 'boom' }, en: 'Route description unavailable: boom' },
  LEG_SHALLOW: { params: { minDepth: 1.5 }, en: 'Shallow (1.5m)' },
  LEG_SHALLOW_AT_PASSAGE: {
    params: { minDepth: 1.5, minDepthAtPassage: 2.3 },
    en: 'Shallow (1.5m charted, 2.3m at passage)',
  },
  LEG_NARROW: { params: { minWidth: 3.9 }, en: 'Narrow (3.9m)' },
  LEG_LOW_CLEARANCE: {
    params: { maxAirDraft: 17.05, requiredAirDraft: 15.56 + 1.5 },
    en: 'Low clearance (17.05m, need 17.06m)',
  },
  DEPTH_UNKNOWN: { params: {}, en: 'Depth unknown along this stretch' },
  DEPTH_NOT_CHARTED: { params: { quality: 'not_surveyed' }, en: 'Depth not charted here (not surveyed)' },
  ORIGIN_UNREVIEWED: {
    params: { origin: 'imported' },
    en: 'This line is imported, not surveyed or reviewed as the charted ones',
  },
  NOTICE: { params: { text: 'Bridge works until May' }, en: 'Bridge works until May' },
  CROSSING_PASSES_CLOSED: {
    params: { airDraft: 1.5, margin: 0.3, closedHeight: 2 },
    en: 'passes closed (air draft 1.5 m + 0.3 m margin < closed 2.0 m)',
  },
  CROSSING_PASSES_CLOSED_NO_WAIT: {
    params: { airDraft: 1.5, margin: 0.3, closedHeight: 2 },
    en: 'passes closed (air draft 1.5 m + 0.3 m margin < closed 2.0 m), no wait',
  },
  NO_PATH: { params: {}, en: 'No route found between the given points' },
  OUTSIDE_COVERAGE: { params: { point: 'start' }, en: 'No routing nodes found near start point' },
  NO_NODE_NEAR_POINT: { params: { point: 'end' }, en: 'No routing nodes found near end point' },
  BUDGET_EXCEEDED: { params: {}, en: 'The route calculation exceeded its budget' },
  ABORTED: { params: {}, en: 'The route calculation was aborted' },
  VESSEL_INCOMPLETE: {
    params: { missing: ['airDraft', 'speedKnots'] },
    en: 'The request must carry the vessel and speed; missing: airDraft, speedKnots',
  },
  REGION_UNAVAILABLE: {
    params: { point: 'start', file: 'a.sqlite', reason: 'Rebuild it with the factory.' },
    en: 'No routing nodes found near start point (a.sqlite covers this area but is not used: Rebuild it with the factory.)',
  },
  INVALID_REQUEST: {
    params: { field: 'start' },
    en: 'Invalid route request — start and end must be latitude/longitude coordinates',
  },
  NO_NODE_NEAR_SEARCH: {
    params: { point: 'either' },
    en: 'Could not find routing nodes near start or end point',
  },
  NO_PATH_DISCONNECTED: {
    params: {},
    en: 'No route found — the start and end are in disconnected parts of the waterway network (e.g. separated by a lock or unconnected water body) and no bridging point could be found at either end.',
  },
  NO_PATH_PRIMARY_NETWORK: {
    params: { cause: { message: 'inner' } },
    en: 'No route found through the primary waterway network between the connection points: inner',
  },
  NO_PATH_GRAPH_CONNECTED: {
    params: { cause: { message: 'inner' } },
    en: 'No route found — graph is connected but A* could not find a path. This should not happen with soft constraints enabled. Last search error: inner',
  },
  NO_PATH_DESTINATION: { params: { cause: { message: 'inner' } }, en: 'No route found to destination: inner' },
  NO_PATH_START_OUTSIDE_BOX: { params: {}, en: 'Start node is outside the routing bounding box' },
  NO_PATH_SEARCH: {
    params: SEARCH,
    en:
      'No route found between the given points — during the search, ran into: 3 edge(s) blocked by land, ' +
      '2 edge(s) too shallow for draft 2m, 1 edge(s) too narrow for beam 4.5m, ' +
      '4 edge(s) outside the current search bounding box. ' +
      '(vessel dims: draft=2m, beam=4.5m, airDraft=19.5m, minCoastDistance=1.00nm)',
  },
  ROUTE_RETRIED_SUFFIX: {
    params: {},
    en: ' [retried from the nearest nodes after the better-depth endpoint(s) found no path]',
  },
  INVALID_BODY: { params: {}, en: 'Invalid request — expected a JSON object' },
  MISSING_ENDPOINTS: { params: {}, en: 'Missing required fields: start and end coordinates' },
  INVALID_COORDINATE: { params: {}, en: 'Invalid coordinate format. Expected {latitude, longitude}' },
  INVALID_VIA_COORDINATE: { params: {}, en: 'Invalid via coordinate format. Expected {latitude, longitude}' },
  COORDINATE_OUT_OF_RANGE: {
    params: {},
    en: 'Coordinate out of range — expected latitude -90..90 and longitude -180..180',
  },
  VIA_COORDINATE_OUT_OF_RANGE: {
    params: {},
    en: 'Via coordinate out of range — expected latitude -90..90 and longitude -180..180',
  },
  INVALID_VIA: { params: {}, en: 'Invalid via — expected an array of {latitude, longitude, mode?}' },
  INVALID_VIA_MODE: { params: {}, en: "Invalid via mode — expected 'auto' or 'manual'" },
  INVALID_END_MODE: { params: {}, en: "Invalid endMode — expected 'auto' or 'manual'" },
  TOO_MANY_VIAS: { params: { max: 25 }, en: 'Too many via points (max 25)' },
  INVALID_DEPARTURE_TIME: { params: {}, en: 'Invalid departureTime — expected an ISO 8601 date string' },
  INVALID_NUMBER_METERS: { params: { field: 'draft' }, en: 'Invalid draft — expected a number in meters' },
  INVALID_RANGE_METERS: { params: { field: 'beam', max: 100 }, en: 'Invalid beam — expected 0..100 meters' },
  INVALID_NUMBER_NM: {
    params: { field: 'minCoastDistance' },
    en: 'Invalid minCoastDistance — expected a number in nautical miles',
  },
  INVALID_RANGE_NM: {
    params: { field: 'minCoastDistance', max: 100 },
    en: 'Invalid minCoastDistance — expected 0..100 nautical miles',
  },
  INVALID_RANGE_MINUTES: {
    params: { field: 'lockWaitMinutes', max: 1440 },
    en: 'Invalid lockWaitMinutes — expected 0..1440 minutes',
  },
  INVALID_NUMBER_KNOTS: { params: { field: 'speedKnots' }, en: 'Invalid speedKnots — expected a number of knots' },
  INVALID_RANGE_KNOTS: {
    params: { field: 'speedKnots', max: 60 },
    en: 'Invalid speedKnots — expected more than 0 and at most 60 knots',
  },
  INVALID_BOOLEAN: { params: { field: 'useTides' }, en: 'Invalid useTides — expected true or false' },
  INVALID_LANG: {
    params: { max: 35 },
    en: 'Invalid lang — expected a language tag of at most 35 characters',
  },
  MANUAL_LEGS_NOT_ALLOWED: {
    params: {},
    en: 'Manual legs are not accepted — every leg is routed automatically',
  },
  ROUTE_TOO_LONG: {
    params: { nm: 900, max: 500 },
    en: 'The route is too long — 900 nautical miles in a straight line, at most 500 are accepted',
  },
  ROUTE_DESCRIPTION_GPX: {
    params: { provider: 'Probe Planner', distance: 4000, cost: 1, duration: 5400, waiting: 600 },
    en: 'Route calculated by Probe Planner - Distance: 4000m, Cost: 1.00, Duration: 1h30m (10m waiting)',
  },
  ROUTE_DESCRIPTION_SIGNALK: {
    params: { provider: 'Probe Planner', distance: 4000 },
    en: 'Route calculated by Probe Planner - Distance: 4000m',
  },
};

const KEYS = Object.keys(SAMPLES) as MessageKey[];

describe('message catalogue', () => {
  it('has an entry in every language for every code and key, and no stray ones', () => {
    const expected = new Set<string>([
      ...ROUTE_WARNING_CODES,
      ...LEG_WARNING_CODES,
      ...DESCRIPTION_WARNING_CODES,
      ...CROSSING_NOTE_CODES,
      ...FAILURE_CODES,
      ...OTHER_MESSAGE_KEYS,
    ]);
    assert.deepStrictEqual(new Set(Object.keys(CATALOGUE)), expected);
    assert.deepStrictEqual(new Set(KEYS), expected);
    for (const code of ALL_CODES) assert.ok(CATALOGUE[code as MessageKey], `no entry for ${code}`);
    for (const key of KEYS) {
      for (const lang of MESSAGE_LANGUAGES) {
        assert.ok(CATALOGUE[key][lang], `${key} has no ${lang} text`);
      }
    }
  });

  it('lists every code once, UPPER_SNAKE', () => {
    assert.strictEqual(new Set(ALL_CODES).size, ALL_CODES.length);
    for (const code of ALL_CODES) assert.match(code, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
  });

  for (const key of KEYS) {
    it(`${key}: renders in en and nl with no placeholder left`, () => {
      const { params } = SAMPLES[key];
      for (const lang of MESSAGE_LANGUAGES) {
        const text = format(key, params, lang);
        assert.ok(text.length > 0, `${key}/${lang} is empty`);
        // A template and its params that disagree leave `{name}` behind. The two
        // request-error texts that spell out a coordinate pair print braces on
        // purpose: "{latitude, longitude}".
        const braces = text.replace(/\{latitude, longitude(, mode\?)?\}/g, '');
        assert.ok(!/[{}]/.test(braces), `${key}/${lang} left a placeholder: ${text}`);
      }
    });

    it(`${key}: English is the text the engine always produced`, () => {
      assert.strictEqual(format(key, SAMPLES[key].params, 'en'), SAMPLES[key].en);
    });

    it(`${key}: Dutch is a translation, not a copy`, () => {
      // A database notice is the database's own text, in whatever language it has.
      if (key === 'NOTICE') return;
      assert.notStrictEqual(format(key, SAMPLES[key].params, 'nl'), format(key, SAMPLES[key].params, 'en'));
    });
  }

  it('leaves a placeholder with no value visible instead of dropping it', () => {
    assert.strictEqual(format('VIA_SKIPPED', {}, 'en'), 'Via point {via} is unreachable via any route — skipped.');
  });

  it('renders an unknown key as the key', () => {
    assert.strictEqual(format('NO_SUCH_CODE' as MessageKey, {}, 'en'), 'NO_SUCH_CODE');
  });
});

describe('language resolution', () => {
  it('reads an unknown or missing language as English', () => {
    for (const tag of ['de', 'fr-CA', 'xx', '', undefined, null]) {
      assert.strictEqual(resolveMessageLanguage(tag), 'en', String(tag));
      assert.strictEqual(format('VIA_SKIPPED', { via: 1 }, tag), 'Via point 1 is unreachable via any route — skipped.');
    }
  });

  it('falls back from a region tag to its language, in any case', () => {
    for (const tag of ['nl', 'nl-BE', 'nl_NL', 'NL-be', ' nl-NL ']) {
      assert.strictEqual(resolveMessageLanguage(tag), 'nl', tag);
    }
    assert.strictEqual(resolveMessageLanguage('en-GB'), 'en');
    assert.strictEqual(
      format('VIA_SKIPPED', { via: 1 }, 'nl-BE'),
      'Tussenpunt 1 is via geen enkele route bereikbaar — overgeslagen.',
    );
  });

  it('writes numbers with a decimal comma in Dutch and a point in English', () => {
    assert.strictEqual(format('LEG_SHALLOW', { minDepth: 1.5 }, 'en'), 'Shallow (1.5m)');
    assert.strictEqual(format('LEG_SHALLOW', { minDepth: 1.5 }, 'nl'), 'Ondiep (1,5 m)');
    assert.strictEqual(
      format('LEG_SHALLOW_AT_PASSAGE', { minDepth: 1.5, minDepthAtPassage: 2.25 }, 'nl'),
      'Ondiep (1,5 m gekarteerd, 2,3 m bij passage)',
    );
    assert.strictEqual(
      format('LEG_LOW_CLEARANCE', { maxAirDraft: 6.7, requiredAirDraft: 17.06 }, 'nl'),
      'Lage doorvaarthoogte (6,7 m, nodig 17,1 m)',
    );
    assert.match(format('ROUTE_CONSTRAINED', CONSTRAINED, 'nl'), /^Route naar bestemming: beperkt voor 2 traject\(en\) 2,0 Nm — diepte 1,2 m < vereist 2,3 m; doorvaarthoogte 11,0 m < vereist 21,0 m; breedte 4,5 m < vereiste scheepsbreedte 6,0 m$/);
    assert.strictEqual(
      format('CROSSING_PASSES_CLOSED', { airDraft: 1.5, margin: 0.3, closedHeight: 2 }, 'nl'),
      'kan gesloten gepasseerd worden (doorvaarthoogte 1,5 m + 0,3 m marge < gesloten 2,0 m)',
    );
    assert.strictEqual(
      format('ROUTE_DESCRIPTION_GPX', SAMPLES.ROUTE_DESCRIPTION_GPX.params, 'nl'),
      'Route berekend door Probe Planner - Afstand: 4000 m, Kosten: 1,00, Duur: 1u30m (10m wachttijd)',
    );
  });

  it('names a vessel dimension and a point in the language', () => {
    assert.match(format('VESSEL_DIMENSION_IGNORED', { dimension: 'airDraft', value: 'x', max: 150 }, 'nl'), /^De opgegeven doorvaarthoogte \(x\)/);
    assert.match(format('NO_NODE_NEAR_SEARCH', { point: 'start' }, 'nl'), /bij het startpunt$/);
  });
});

describe('failure wording', () => {
  it('picks the wording by code and reason', () => {
    assert.strictEqual(failureMessageKey('NO_PATH', { reason: 'disconnected' }), 'NO_PATH_DISCONNECTED');
    assert.strictEqual(failureMessageKey('NO_PATH', { reason: 'search' }), 'NO_PATH_SEARCH');
    assert.strictEqual(failureMessageKey('NO_PATH', {}), 'NO_PATH_SEARCH');
    assert.strictEqual(failureMessageKey('NO_NODE_NEAR_POINT', { reason: 'search', point: 'end' }), 'NO_NODE_NEAR_SEARCH');
    assert.strictEqual(failureMessageKey('NO_NODE_NEAR_POINT', { point: 'end' }), 'NO_NODE_NEAR_POINT');
    assert.strictEqual(failureMessageKey('VESSEL_INCOMPLETE', {}), 'VESSEL_INCOMPLETE');
  });

  it('renders a nested cause in the reader language, and a foreign one as it is', () => {
    const cause = { code: 'NO_NODE_NEAR_POINT', params: { point: 'start', reason: 'search' } };
    assert.strictEqual(
      formatFailure('NO_PATH', { reason: 'destination', cause }, 'en'),
      'No route found to destination: Could not find routing nodes near start point',
    );
    assert.strictEqual(
      formatFailure('NO_PATH', { reason: 'destination', cause }, 'nl'),
      'Geen route gevonden naar de bestemming: Kon geen routeringsknooppunten vinden bij het startpunt',
    );
    assert.strictEqual(
      formatFailure('NO_PATH', { reason: 'destination', cause: { message: 'plain error' } }, 'nl'),
      'Geen route gevonden naar de bestemming: plain error',
    );
  });

  it('appends the retried suffix when the search was repeated', () => {
    assert.strictEqual(
      formatFailure('NO_PATH', { reason: 'start_outside_box', retried: true }, 'en'),
      'Start node is outside the routing bounding box [retried from the nearest nodes after the better-depth endpoint(s) found no path]',
    );
  });

  it('says that the search hit its iteration limit', () => {
    const base = { ...SEARCH, skipped: {} };
    assert.match(formatFailure('NO_PATH', { ...base, iterationLimit: true }, 'en'), /the search exceeded its iteration limit before finding a path/);
    assert.match(formatFailure('NO_PATH', { ...base, iterationLimit: false }, 'en'), /the destination appears unreachable from the start/);
    assert.match(
      formatFailure('NO_PATH', { ...SEARCH, iterationLimit: true }, 'en'),
      /bounding box\. The search also exceeded its iteration limit before finishing\. \(vessel dims/,
    );
  });
});

describe('logger', () => {
  it('is silent by default and returns the logger it is given', () => {
    const calls: string[] = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      assert.strictEqual(SILENT_LOGGER[level]('x', { a: 1 }), undefined);
      assert.strictEqual(resolveLogger(undefined)[level], SILENT_LOGGER[level]);
    }
    const mine = { debug: () => calls.push('d'), info: () => calls.push('i'), warn: () => calls.push('w'), error: () => calls.push('e') };
    assert.strictEqual(resolveLogger(mine), mine);
    assert.deepStrictEqual(calls, []);
  });
});
