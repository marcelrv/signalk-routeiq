import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  CORE_VERSION,
  DEFAULT_ENGINE_OPTIONS,
  RouteRequestError,
  RoutingEngine,
  resolveRouteInputs,
  validateEngineOptions,
  type EngineOptions,
  type RoutingDatabase,
  type RoutingRequest,
} from '../dist/index.js';

const base: RoutingRequest = { start: { latitude: 52, longitude: 5 }, end: { latitude: 52.1, longitude: 5.1 } };
const options = (over: Partial<EngineOptions> = {}): EngineOptions => ({ ...DEFAULT_ENGINE_OPTIONS, ...over });

describe('validateEngineOptions', () => {
  it('accepts the defaults', () => {
    assert.doesNotThrow(() => validateEngineOptions(options()));
  });

  it('rejects a bounding box margin that cannot grow', () => {
    for (const bboxMarginDeg of [0, -1, NaN, Infinity]) {
      assert.throws(() => validateEngineOptions(options({ bboxMarginDeg })), /bboxMarginDeg/);
    }
  });

  it('rejects a maximum extent below the margin or not finite', () => {
    assert.throws(() => validateEngineOptions(options({ bboxMarginDeg: 2, bboxMaxExtentDeg: 1 })), /bboxMaxExtentDeg/);
    assert.throws(() => validateEngineOptions(options({ bboxMaxExtentDeg: NaN })), /bboxMaxExtentDeg/);
    assert.doesNotThrow(() => validateEngineOptions(options({ bboxMarginDeg: 1, bboxMaxExtentDeg: 1 })));
  });

  it('rejects other numbers that are not finite or out of range', () => {
    assert.throws(() => validateEngineOptions(options({ waypointToleranceM: NaN })), /waypointToleranceM/);
    assert.throws(() => validateEngineOptions(options({ coverageGapM: -1 })), /coverageGapM/);
    assert.throws(() => validateEngineOptions(options({ defaultLockWaitMinutes: Infinity })), /defaultLockWaitMinutes/);
    assert.throws(() => validateEngineOptions(options({ defaultVessel: { draft: NaN, beam: 4, airDraft: 0 } })), /defaultVessel\.draft/);
    assert.throws(() => validateEngineOptions(options({ maxSearchIterations: 0 })), /maxSearchIterations/);
  });

  it('names every problem in one error', () => {
    assert.throws(
      () => validateEngineOptions(options({ bboxMarginDeg: 0, losSearchRadiusM: NaN })),
      (e: unknown) => e instanceof RangeError && /bboxMarginDeg/.test(e.message) && /losSearchRadiusM/.test(e.message),
    );
  });

  it('is applied when an engine is constructed', () => {
    assert.throws(() => new RoutingEngine({} as RoutingDatabase, options({ bboxMarginDeg: 0 })), /Invalid engine options/);
  });
});

describe('resolveRouteInputs', () => {
  it('uses the option defaults for what the request leaves out', () => {
    assert.deepStrictEqual(resolveRouteInputs(base, options()), {
      draft: 0,
      beam: 4,
      airDraft: 0,
      speedKnots: 5,
      safetyMarginDraft: 0.3,
      safetyMarginBeam: 2,
      safetyMarginAirDraft: 1.5,
      departureTime: null,
      useTides: false,
      lockWaitMinutes: 60,
      bridgeWaitMinutes: 30,
      minCoastDistance: 0,
      lang: null,
      describe: true,
      coreVersion: CORE_VERSION,
    });
  });

  it('prefers the request, and treats 0 as a value', () => {
    const r = resolveRouteInputs(
      { ...base, draft: 0, beam: 3, airDraft: 12, speedKnots: 7, lockWaitMinutes: 0, bridgeWaitMinutes: 0, safetyMarginDraft: 0, useTides: true, lang: 'nl', describe: false, minCoastDistance: 0.5 },
      options({ defaultVessel: { draft: 2, beam: 5, airDraft: 20 }, defaultLockWaitMinutes: 10 }),
    );
    assert.deepStrictEqual(
      [r.draft, r.beam, r.airDraft, r.speedKnots, r.lockWaitMinutes, r.bridgeWaitMinutes, r.safetyMarginDraft, r.useTides, r.lang, r.describe, r.minCoastDistance],
      [0, 3, 12, 7, 0, 0, 0, true, 'nl', false, 0.5],
    );
  });

  it('uses the option defaults for the vessel, waits, margins, tides', () => {
    const r = resolveRouteInputs(
      base,
      options({
        defaultVessel: { draft: 2, beam: 5, airDraft: 20 },
        defaultSpeedKnots: 8,
        defaultLockWaitMinutes: 10,
        defaultBridgeWaitMinutes: 4,
        defaultSafetyMarginDraftM: 1,
        defaultSafetyMarginBeamM: 1.1,
        defaultSafetyMarginAirDraftM: 1.2,
        defaultUseTides: true,
      }),
    );
    assert.deepStrictEqual(
      [r.draft, r.beam, r.airDraft, r.speedKnots, r.lockWaitMinutes, r.bridgeWaitMinutes, r.safetyMarginDraft, r.safetyMarginBeam, r.safetyMarginAirDraft, r.useTides],
      [2, 5, 20, 8, 10, 4, 1, 1.1, 1.2, true],
    );
  });

  it('floors the speed at 0.5 knots and echoes it so', () => {
    assert.strictEqual(resolveRouteInputs({ ...base, speedKnots: 0.2 }, options()).speedKnots, 0.5);
    assert.strictEqual(resolveRouteInputs(base, options({ defaultSpeedKnots: 0 })).speedKnots, 0.5);
  });

  it('normalises the departure time to ISO UTC, null when none or unparseable', () => {
    assert.strictEqual(
      resolveRouteInputs({ ...base, departureTime: '2026-08-03T06:00:00+02:00' }, options()).departureTime,
      '2026-08-03T04:00:00.000Z',
    );
    assert.strictEqual(resolveRouteInputs({ ...base, departureTime: 'later' }, options()).departureTime, null);
  });

  it('shares nothing between calls', () => {
    const o = options();
    const a = resolveRouteInputs({ ...base, draft: 3 }, o);
    const b = resolveRouteInputs(base, o);
    assert.strictEqual(a.draft, 3);
    assert.strictEqual(b.draft, 0);
    a.draft = 9;
    assert.strictEqual(resolveRouteInputs(base, o).draft, 0);
    assert.deepStrictEqual(o.defaultVessel, { draft: 0, beam: 4, airDraft: 0 });
  });
});

describe('strict mode', () => {
  const strict = options({ requireVesselInRequest: true });
  const complete = { ...base, draft: 2, beam: 4, airDraft: 15, speedKnots: 5 };

  it('accepts a complete request, zeros included', () => {
    assert.strictEqual(resolveRouteInputs(complete, strict).draft, 2);
    assert.strictEqual(resolveRouteInputs({ ...complete, airDraft: 0 }, strict).airDraft, 0);
  });

  it('throws RouteRequestError VESSEL_INCOMPLETE naming what is missing', () => {
    assert.throws(
      () => resolveRouteInputs(base, strict),
      (e: unknown) => {
        assert.ok(e instanceof RouteRequestError);
        assert.ok(e instanceof Error);
        assert.strictEqual(e.name, 'RouteRequestError');
        assert.strictEqual(e.code, 'VESSEL_INCOMPLETE');
        assert.deepStrictEqual(e.params, { missing: ['draft', 'beam', 'airDraft', 'speedKnots'] });
        assert.match(e.message, /missing: draft, beam, airDraft, speedKnots/);
        return true;
      },
    );
    for (const key of ['draft', 'beam', 'airDraft', 'speedKnots'] as const) {
      const partial = { ...complete } as RoutingRequest;
      delete partial[key];
      assert.throws(
        () => resolveRouteInputs(partial, strict),
        (e: unknown) => e instanceof RouteRequestError && (e.params.missing as string[]).join() === key,
      );
    }
  });

  it('does not use the defaults, however they are set', () => {
    assert.throws(
      () => resolveRouteInputs(base, options({ requireVesselInRequest: true, defaultVessel: { draft: 2, beam: 4, airDraft: 15 }, defaultSpeedKnots: 5 })),
      RouteRequestError,
    );
  });

  it('a non-finite value counts as missing', () => {
    assert.throws(() => resolveRouteInputs({ ...complete, draft: Number.NaN }, strict), RouteRequestError);
  });
});
