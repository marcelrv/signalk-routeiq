import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEFAULT_REQUEST_LIMITS,
  checkRequestConstraints,
  coerceVesselDimension,
  validateRouteRequest,
  type RequestLimits,
} from '../dist/index.js';

const start = { latitude: 52, longitude: 5 };
const end = { latitude: 52.1, longitude: 5.1 };
const ok = (body: unknown, limits: Partial<RequestLimits> = {}) => {
  const r = validateRouteRequest(body, { ...DEFAULT_REQUEST_LIMITS, ...limits });
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r;
};
const bad = (body: unknown, limits: Partial<RequestLimits> = {}) => {
  const r = validateRouteRequest(body, { ...DEFAULT_REQUEST_LIMITS, ...limits });
  assert.ok(!r.ok, 'expected the request to be rejected');
  return r.ok ? (undefined as never) : r.error;
};

describe('validateRouteRequest: shape and coordinates', () => {
  it('accepts a minimal request and returns a clean copy', () => {
    const body = { start, end };
    const r = ok(body);
    assert.deepStrictEqual(r.request, { start, end });
    assert.notStrictEqual(r.request, body);
    assert.deepStrictEqual(r.warnings, []);
    assert.deepStrictEqual(r.unknownFields, []);
  });

  it('rejects a body that is not an object', () => {
    for (const body of [undefined, null, 'x', 3, [start, end]]) {
      assert.strictEqual(bad(body).code, 'INVALID_BODY');
    }
  });

  it('requires start and end', () => {
    const e = bad({ start });
    assert.strictEqual(e.code, 'MISSING_ENDPOINTS');
    assert.strictEqual(e.field, 'end');
    assert.strictEqual(e.message, 'Missing required fields: start and end coordinates');
    assert.strictEqual(bad({ end }).field, 'start');
  });

  it('requires finite numeric coordinates', () => {
    for (const p of [{ latitude: '52', longitude: 5 }, { latitude: 52 }, 'here', { latitude: null, longitude: 5 }]) {
      const e = bad({ start: p, end });
      assert.strictEqual(e.code, 'INVALID_COORDINATE');
      assert.strictEqual(e.message, 'Invalid coordinate format. Expected {latitude, longitude}');
    }
  });

  it('rejects coordinates out of range, accepts the limits', () => {
    for (const p of [
      { latitude: 90.01, longitude: 0 },
      { latitude: -90.01, longitude: 0 },
      { latitude: 0, longitude: 180.5 },
      { latitude: 0, longitude: -181 },
    ]) {
      assert.strictEqual(bad({ start: p, end }).code, 'COORDINATE_OUT_OF_RANGE');
      assert.strictEqual(bad({ start, end, via: [p] }).code, 'COORDINATE_OUT_OF_RANGE');
    }
    ok({ start: { latitude: -90, longitude: -180 }, end: { latitude: 90, longitude: 180 } });
  });

  it('reads the coordinate aliases only when asked to', () => {
    const aliased = { start: { lat: 52, lng: 5 }, end: { lat: 52.1, lon: 5.1 } };
    assert.strictEqual(bad(aliased).code, 'INVALID_COORDINATE');
    assert.strictEqual(bad(aliased, { acceptCoordinateAliases: false }).code, 'INVALID_COORDINATE');
    const r = ok(aliased, { acceptCoordinateAliases: true });
    assert.deepStrictEqual(r.request.start, { latitude: 52, longitude: 5 });
    assert.deepStrictEqual(r.request.end, { latitude: 52.1, longitude: 5.1 });
    // the long names win when both are there
    const both = ok({ start: { latitude: 1, longitude: 2, lat: 9, lng: 9 }, end }, { acceptCoordinateAliases: true });
    assert.deepStrictEqual(both.request.start, { latitude: 1, longitude: 2 });
  });
});

describe('validateRouteRequest: vias and leg modes', () => {
  it('keeps vias with their modes, and drops other point fields', () => {
    const r = ok({ start, end, via: [{ latitude: 52.05, longitude: 5.05, mode: 'manual', name: 'x' }, { latitude: 52.06, longitude: 5.06 }] });
    assert.deepStrictEqual(r.request.via, [
      { latitude: 52.05, longitude: 5.05, mode: 'manual' },
      { latitude: 52.06, longitude: 5.06 },
    ]);
  });

  it('rejects a via that is not an array, or a bad via', () => {
    assert.strictEqual(bad({ start, end, via: 'x' }).message, 'Invalid via — expected an array of {latitude, longitude, mode?}');
    assert.strictEqual(bad({ start, end, via: null }).code, 'INVALID_VIA');
    const e = bad({ start, end, via: [start, { latitude: 'a', longitude: 1 }] });
    assert.strictEqual(e.field, 'via[1]');
    assert.strictEqual(e.message, 'Invalid via coordinate format. Expected {latitude, longitude}');
  });

  it('checks the via mode and endMode', () => {
    const e = bad({ start, end, via: [{ ...start, mode: 'swim' }] });
    assert.strictEqual(e.code, 'INVALID_LEG_MODE');
    assert.strictEqual(e.message, "Invalid via mode — expected 'auto' or 'manual'");
    assert.strictEqual(bad({ start, end, endMode: 'swim' }).message, "Invalid endMode — expected 'auto' or 'manual'");
    ok({ start, end, endMode: 'auto', via: [{ ...start, mode: 'auto' }] });
  });

  it('takes maxVias as a parameter', () => {
    const via = [start, start, start];
    ok({ start, end, via }, { maxVias: 3 });
    const e = bad({ start, end, via }, { maxVias: 2 });
    assert.strictEqual(e.code, 'TOO_MANY_VIAS');
    assert.strictEqual(e.message, 'Too many via points (max 2)');
    assert.deepStrictEqual(e.params, { max: 2 });
    ok({ start, end, via: [] }, { maxVias: 0 });
  });

  it('rejects manual legs when they are not allowed, auto stays valid', () => {
    const off = { allowManualLegs: false };
    assert.strictEqual(bad({ start, end, endMode: 'manual' }, off).code, 'MANUAL_LEGS_NOT_ALLOWED');
    const e = bad({ start, end, via: [{ ...start, mode: 'auto' }, { ...start, mode: 'manual' }] }, off);
    assert.strictEqual(e.code, 'MANUAL_LEGS_NOT_ALLOWED');
    assert.strictEqual(e.field, 'via[1].mode');
    ok({ start, end, endMode: 'auto', via: [{ ...start, mode: 'auto' }] }, off);
    ok({ start, end, endMode: 'manual' }, { allowManualLegs: true });
  });

  it('limits the straight-line distance start to vias to end', () => {
    // 1 degree of latitude is 60 nm.
    const far = { latitude: 53, longitude: 5 };
    ok({ start, end: far });
    ok({ start, end: far }, { maxStraightLineNm: 61 });
    const e = bad({ start, end: far }, { maxStraightLineNm: 59 });
    assert.strictEqual(e.code, 'ROUTE_TOO_LONG');
    assert.deepStrictEqual(e.params, { nm: 60, max: 59 });
    // the chain counts: out to 52+1, back to start's latitude, is 120 nm
    const there = { latitude: 53, longitude: 5 };
    const r = bad({ start, via: [there], end: start }, { maxStraightLineNm: 100 });
    assert.strictEqual(r.code, 'ROUTE_TOO_LONG');
    ok({ start, via: [there], end: start }, { maxStraightLineNm: 125 });
  });
});

describe('validateRouteRequest: departure time', () => {
  it('accepts an ISO 8601 string and keeps it as given', () => {
    const r = ok({ start, end, departureTime: '2026-08-03T06:00:00+02:00' });
    assert.strictEqual(r.request.departureTime, '2026-08-03T06:00:00+02:00');
  });
  it('rejects what does not parse, or is not a string', () => {
    for (const departureTime of ['soon', '', 1754200000000, null, {}]) {
      const e = bad({ start, end, departureTime });
      assert.strictEqual(e.code, 'INVALID_DEPARTURE_TIME');
      assert.strictEqual(e.message, 'Invalid departureTime — expected an ISO 8601 date string');
    }
  });
});

describe('validateRouteRequest: vessel dimensions', () => {
  it('reads numbers, numeric strings and Signal K shaped values', () => {
    const r = ok({ start, end, draft: '1.8', beam: { value: 3.5 }, airDraft: { maximum: 14 } });
    assert.deepStrictEqual([r.request.draft, r.request.beam, r.request.airDraft], [1.8, 3.5, 14]);
  });

  it('drops an unusable dimension with a warning when not strict, saying what was used instead', () => {
    const r = ok(
      { start, end, draft: 'deep', beam: -2, airDraft: 100000 },
      { ignoredDimensionFallback: 'configured' },
    );
    assert.deepStrictEqual([r.request.draft, r.request.beam, r.request.airDraft], [undefined, undefined, undefined]);
    assert.ok(!('draft' in r.request));
    assert.strictEqual(r.warnings.length, 3);
    assert.strictEqual(r.warnings[0].type, 'vessel_dimension_ignored');
    assert.strictEqual(r.warnings[0].code, 'VESSEL_DIMENSION_IGNORED_CONFIGURED');
    assert.deepStrictEqual(r.warnings[0].params, { dimension: 'draft', value: 'deep', max: 30 });
    assert.strictEqual(
      r.warnings[0].message,
      'Ignored the supplied draft (deep) — expected a number between 0 and 30 meters. Routed with the draft configured on the server instead; check the vessel dimensions in Signal K.',
    );
    assert.match(r.warnings[2].message, /air draft \(100000\).*0 and 150 meters\. Routed with the air draft configured on the server instead/);
  });

  it('has a default hint when the caller gives none', () => {
    const r = ok({ start, end, beam: 'wide' });
    assert.match(r.warnings[0].message, /The default beam was used instead\.$/);
    assert.strictEqual(r.warnings[0].code, 'VESSEL_DIMENSION_IGNORED');
  });

  it('words its messages in the limits language, or in the body lang when it follows the request', () => {
    const dutch = ok({ start, end, beam: 'wide' }, { messageLanguage: 'nl' });
    assert.match(dutch.warnings[0].message, /^De opgegeven breedte \(wide\) is genegeerd/);
    const follow = ok({ start, end, beam: 'wide', lang: 'nl-BE' });
    assert.match(follow.warnings[0].message, /^De opgegeven breedte/);
    const fixed = ok({ start, end, beam: 'wide', lang: 'nl' }, { messageLanguage: 'en' });
    assert.match(fixed.warnings[0].message, /^Ignored the supplied beam/);
    const err = bad({ start, end, draft: 'deep' }, { strict: true, messageLanguage: 'nl' });
    assert.strictEqual(err.code, 'INVALID_DIMENSION');
    assert.strictEqual(err.message, 'Ongeldige draft — een getal in meters werd verwacht');
    assert.strictEqual(bad(undefined, { messageLanguage: 'nl' }).message, 'Ongeldige aanvraag — een JSON-object werd verwacht');
  });

  it('is an error in strict mode, there being no fallback', () => {
    const type = bad({ start, end, draft: 'deep' }, { strict: true });
    assert.strictEqual(type.code, 'INVALID_DIMENSION');
    assert.strictEqual(type.field, 'draft');
    assert.strictEqual(type.message, 'Invalid draft — expected a number in meters');
    assert.strictEqual(bad({ start, end, beam: 101 }, { strict: true }).message, 'Invalid beam — expected 0..100 meters');
    assert.strictEqual(bad({ start, end, airDraft: -1 }, { strict: true }).code, 'INVALID_DIMENSION');
    // valid values and absent ones are untouched
    const r = ok({ start, end, draft: 2, beam: null }, { strict: true });
    assert.deepStrictEqual(r.warnings, []);
  });

  it('takes the ranges as parameters', () => {
    ok({ start, end, draft: 40 }, { maxDimensionM: { draft: 50, beam: 100, airDraft: 150 } });
    const r = ok({ start, end, draft: 40 });
    assert.strictEqual(r.request.draft, undefined);
    const e = bad({ start, end, draft: 40 }, { strict: true });
    assert.strictEqual(e.message, 'Invalid draft — expected 0..30 meters');
    assert.strictEqual(bad({ start, end, draft: 6 }, { strict: true, maxDimensionM: { draft: 5, beam: 1, airDraft: 1 } }).message, 'Invalid draft — expected 0..5 meters');
  });

  it('coerces like the plugin always did', () => {
    assert.strictEqual(coerceVesselDimension(' 2.4 '), 2.4);
    assert.strictEqual(coerceVesselDimension('2 meters'), undefined);
    assert.strictEqual(coerceVesselDimension({ value: { maximum: '2' } }), 2);
  });
});

describe('validateRouteRequest: numbers, flags, language', () => {
  it('checks minCoastDistance 0..100 and the waits 0..1440', () => {
    ok({ start, end, minCoastDistance: 0, lockWaitMinutes: 0, bridgeWaitMinutes: 1440 });
    assert.strictEqual(bad({ start, end, minCoastDistance: 'far' }).message, 'Invalid minCoastDistance — expected a number in nautical miles');
    assert.strictEqual(bad({ start, end, minCoastDistance: 101 }).message, 'Invalid minCoastDistance — expected 0..100 nautical miles');
    assert.strictEqual(bad({ start, end, minCoastDistance: -1 }).code, 'INVALID_VALUE');
    assert.strictEqual(bad({ start, end, lockWaitMinutes: 1441 }).message, 'Invalid lockWaitMinutes — expected 0..1440 minutes');
    assert.strictEqual(bad({ start, end, bridgeWaitMinutes: -5 }).message, 'Invalid bridgeWaitMinutes — expected 0..1440 minutes');
    assert.strictEqual(bad({ start, end, lockWaitMinutes: 'long' }).field, 'lockWaitMinutes');
    ok({ start, end, minCoastDistance: 150 }, { maxCoastDistanceNm: 200 });
    assert.strictEqual(bad({ start, end, lockWaitMinutes: 61 }, { maxWaitMinutes: 60 }).code, 'INVALID_VALUE');
  });

  it('checks speedKnots is above 0 and within the limit', () => {
    ok({ start, end, speedKnots: 0.1 });
    ok({ start, end, speedKnots: 60 });
    for (const speedKnots of [0, -1, 61, '5', Number.NaN]) {
      assert.strictEqual(bad({ start, end, speedKnots }).field, 'speedKnots', String(speedKnots));
    }
    ok({ start, end, speedKnots: 100 }, { maxSpeedKnots: 120 });
    assert.strictEqual(bad({ start, end, speedKnots: 11 }, { maxSpeedKnots: 10 }).code, 'INVALID_VALUE');
  });

  it('checks the safety margins are 0..limit', () => {
    ok({ start, end, safetyMarginDraft: 0, safetyMarginBeam: 2, safetyMarginAirDraft: 100 });
    for (const key of ['safetyMarginDraft', 'safetyMarginBeam', 'safetyMarginAirDraft']) {
      assert.strictEqual(bad({ start, end, [key]: -0.1 }).field, key);
      assert.strictEqual(bad({ start, end, [key]: 101 }).field, key);
      assert.strictEqual(bad({ start, end, [key]: '1' }).field, key);
    }
    assert.strictEqual(bad({ start, end, safetyMarginDraft: 6 }, { maxSafetyMarginM: 5 }).code, 'INVALID_VALUE');
  });

  it('wants booleans for useTides and describe', () => {
    const r = ok({ start, end, useTides: true, describe: false });
    assert.deepStrictEqual([r.request.useTides, r.request.describe], [true, false]);
    for (const key of ['useTides', 'describe']) {
      for (const v of ['yes', 1, 0, {}]) assert.strictEqual(bad({ start, end, [key]: v }).field, key);
    }
  });

  it('wants lang to be a short string', () => {
    assert.strictEqual(ok({ start, end, lang: 'de-CH' }).request.lang, 'de-CH');
    assert.strictEqual(bad({ start, end, lang: 5 }).field, 'lang');
    assert.strictEqual(bad({ start, end, lang: 'x'.repeat(36) }).field, 'lang');
    ok({ start, end, lang: 'x'.repeat(36) }, { maxLangLength: 40 });
  });

  it('treats null as not supplied', () => {
    const r = ok({ start, end, minCoastDistance: null, speedKnots: null, useTides: null, lang: null, draft: null });
    assert.deepStrictEqual(r.request, { start, end });
  });
});

describe('validateRouteRequest: unknown fields', () => {
  it('lists unknown top-level fields apart from the warnings, and leaves them out', () => {
    const r = ok({ start, end, colour: 'red', scanHours: 12 });
    assert.deepStrictEqual(r.unknownFields, ['colour', 'scanHours']);
    assert.deepStrictEqual(r.warnings, []);
    assert.ok(!('colour' in r.request));
  });

  it('reports them on a rejected request too', () => {
    const r = validateRouteRequest({ start, colour: 'red' }, DEFAULT_REQUEST_LIMITS);
    assert.ok(!r.ok);
    assert.deepStrictEqual(r.unknownFields, ['colour']);
  });
});

describe('checkRequestConstraints', () => {
  it('writes the usable values and stops at the first error, keeping the warnings so far', () => {
    const out: Record<string, unknown> = {};
    const r = checkRequestConstraints({ draft: 'deep', minCoastDistance: 'far' }, DEFAULT_REQUEST_LIMITS, out);
    assert.strictEqual(r.error?.field, 'minCoastDistance');
    assert.strictEqual(r.warnings.length, 1);
    assert.ok('draft' in out && out.draft === undefined);
  });
});
