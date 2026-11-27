/**
 * The engine keeps no vessel or user state. What the boat and the user supply
 * (dimensions, speed, margins, waits, tides) comes with each request; the
 * options only hold defaults. Pinned here: strict mode, isolation between
 * requests on one engine, per-request speed and margins, and the `inputs`
 * echo on every result.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  CORE_VERSION,
  DEFAULT_ENGINE_OPTIONS,
  RouteRequestError,
  type EngineOptions,
  type RoutingRequest,
} from 'routeiq-core';
import { RoutingDatabase } from 'routeiq-core';
import { createDirectoryDatabase } from '../dist-tsc/data-dir.js';
import { RoutingEngine } from 'routeiq-core';
import { DEFAULT_CONFIG } from '../dist-tsc/types.js';
import { testOptions } from './engine-helper.js';

const FIXTURE = path.join('test', 'fixtures', 'zeelandbrug');
const pt = (latitude: number, longitude: number) => ({ latitude, longitude });
// A short stretch without a bridge or lock, and the longer one through the bridge.
const SHORT: RoutingRequest = { start: pt(51.613, 3.885), end: pt(51.6135, 3.8875), minCoastDistance: 0 };
const THROUGH_BRIDGE: RoutingRequest = { start: pt(51.613, 3.885), end: pt(51.609, 3.896), minCoastDistance: 0 };
const BOAT = { draft: 2.0, beam: 5.0, airDraft: 19.5, speedKnots: 5 };

/** The inputs without the data version, which the data test below covers. */
function withoutData(inputs: object | undefined): object {
  const { data, ...rest } = (inputs ?? {}) as { data?: unknown };
  assert.ok(Array.isArray(data), 'the inputs name the data the route was calculated from');
  return rest;
}

describe('engine per-request inputs', () => {
  let dir: string;
  let db: RoutingDatabase;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeiq-per-request-'));
    fs.copyFileSync(path.join(FIXTURE, 'netherlands.sqlite'), path.join(dir, 'netherlands.sqlite'));
    db = createDirectoryDatabase(dir);
    await db.init();
    await db.loadGraph();
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const options = (over: Partial<EngineOptions> = {}): EngineOptions => ({
    ...testOptions({ ...DEFAULT_CONFIG }),
    ...over,
  });

  describe('strict mode', () => {
    const strict = () => new RoutingEngine(db, options({ requireVesselInRequest: true }));

    it('rejects a request without draft, beam, airDraft or speedKnots', async () => {
      await assert.rejects(strict().calculateRoute({ ...SHORT }), (e: unknown) => {
        assert.ok(e instanceof RouteRequestError);
        assert.strictEqual(e.code, 'VESSEL_INCOMPLETE');
        assert.deepStrictEqual(e.params, { missing: ['draft', 'beam', 'airDraft', 'speedKnots'] });
        assert.match(e.message, /draft, beam, airDraft, speedKnots/);
        return true;
      });
    });

    it('names only what is missing', async () => {
      await assert.rejects(
        strict().calculateRoute({ ...SHORT, draft: 2, beam: 4, speedKnots: 5 }),
        (e: unknown) => e instanceof RouteRequestError && e.params.missing instanceof Array && e.params.missing.join() === 'airDraft',
      );
      // 0 is a value (an unknown air draft is sent as 0), not a missing one.
      const route = await strict().calculateRoute({ ...SHORT, draft: 2, beam: 4, airDraft: 0, speedKnots: 5 });
      assert.strictEqual(route.inputs?.airDraft, 0);
    });

    it('does not fall back on the default vessel or speed', async () => {
      const engine = new RoutingEngine(db, options({ requireVesselInRequest: true, defaultSpeedKnots: 9 }));
      await assert.rejects(engine.calculateRoute({ ...SHORT, ...BOAT, speedKnots: undefined }), RouteRequestError);
    });

    it('refuses a departure scan before its first step', async () => {
      const engine = strict();
      await assert.rejects(engine.scanDepartures({ ...SHORT }, 2, 60), RouteRequestError);
    });

    it('routes a complete request', async () => {
      const route = await strict().calculateRoute({ ...SHORT, ...BOAT });
      assert.ok(route.totalDistance! > 0);
    });

    it('is off by default', () => {
      assert.strictEqual(DEFAULT_ENGINE_OPTIONS.requireVesselInRequest, false);
    });
  });

  describe('no shared state between requests', () => {
    it('two requests with different dimensions on one engine do not see each other', async () => {
      const engine = new RoutingEngine(db, options());
      const shallow = { ...THROUGH_BRIDGE, draft: 2.0, beam: 5.0, airDraft: 19.5 };
      const deep = { ...THROUGH_BRIDGE, draft: 8.0, beam: 5.0, airDraft: 19.5 };

      const alone = await engine.calculateRoute(shallow);
      assert.ok(!(alone.warnings ?? []).some((w) => w.type === 'via_constrained'));

      // Concurrent, in both orders: the deep boat's request must not leak into
      // the shallow one, nor the other way round.
      for (const order of [[shallow, deep], [deep, shallow]]) {
        const [a, b] = await Promise.all(order.map((r) => engine.calculateRoute(r)));
        const byDraft = new Map([[order[0].draft, a], [order[1].draft, b]]);
        assert.strictEqual(byDraft.get(8.0)!.inputs?.draft, 8.0);
        assert.strictEqual(byDraft.get(2.0)!.inputs?.draft, 2.0);
        assert.ok((byDraft.get(8.0)!.warnings ?? []).some((w) => w.type === 'via_constrained'));
        assert.deepStrictEqual(byDraft.get(2.0)!.warnings, alone.warnings);
        assert.strictEqual(byDraft.get(2.0)!.totalDistance, alone.totalDistance);
      }
    });

    it('a request without dimensions gets the engine defaults, whatever ran before', async () => {
      const engine = new RoutingEngine(db, options());
      await engine.calculateRoute({ ...SHORT, draft: 8, beam: 9, airDraft: 40, speedKnots: 12 });
      const next = await engine.calculateRoute({ ...SHORT });
      assert.strictEqual(next.inputs?.draft, DEFAULT_ENGINE_OPTIONS.defaultVessel.draft);
      assert.strictEqual(next.inputs?.beam, DEFAULT_ENGINE_OPTIONS.defaultVessel.beam);
      assert.strictEqual(next.inputs?.airDraft, DEFAULT_ENGINE_OPTIONS.defaultVessel.airDraft);
      assert.strictEqual(next.inputs?.speedKnots, DEFAULT_ENGINE_OPTIONS.defaultSpeedKnots);
    });

    it('the engine exposes no vessel state to set', () => {
      const engine = new RoutingEngine(db, options()) as unknown as Record<string, unknown>;
      for (const name of ['setVesselDimensions', 'vesselDims', 'vesselDimensions', 'config']) {
        assert.strictEqual(name in engine, false, name);
      }
    });
  });

  describe('per-request speed and margins', () => {
    it('speedKnots changes the timing, and the default applies without it', async () => {
      const engine = new RoutingEngine(db, options());
      const slow = await engine.calculateRoute({ ...SHORT, ...BOAT, speedKnots: 5 });
      const fast = await engine.calculateRoute({ ...SHORT, ...BOAT, speedKnots: 10 });
      const dflt = await engine.calculateRoute({ ...SHORT, draft: BOAT.draft, beam: BOAT.beam, airDraft: BOAT.airDraft });
      assert.ok(fast.totalSeconds! < slow.totalSeconds!);
      assert.ok(Math.abs(slow.totalSeconds! / fast.totalSeconds! - 2) < 0.1);
      assert.strictEqual(dflt.totalSeconds, slow.totalSeconds, 'the option default is 5 knots');
      assert.strictEqual(slow.timingAssumptions?.averageSpeedKnots, 5);
      assert.strictEqual(fast.timingAssumptions?.averageSpeedKnots, 10);

      const fasterDefault = new RoutingEngine(db, options({ defaultSpeedKnots: 10 }));
      const viaOption = await fasterDefault.calculateRoute({ ...SHORT, draft: 2, beam: 5, airDraft: 19.5 });
      assert.strictEqual(viaOption.totalSeconds, fast.totalSeconds);
    });

    it('a speed below the engine floor is planned with at the floor, and echoed so', async () => {
      const route = await new RoutingEngine(db, options()).calculateRoute({ ...SHORT, ...BOAT, speedKnots: 0.1 });
      assert.strictEqual(route.inputs?.speedKnots, 0.5);
      assert.strictEqual(route.timingAssumptions?.averageSpeedKnots, 0.5);
    });

    it('safety margins change the constraints a route is checked against', async () => {
      const engine = new RoutingEngine(db, options());
      const base = { ...THROUGH_BRIDGE, draft: 2.0, beam: 5.0, airDraft: 19.5 };
      const normal = await engine.calculateRoute(base);
      const wide = await engine.calculateRoute({ ...base, safetyMarginDraft: 6 });
      const none = (r: typeof normal) => !(r.warnings ?? []).some((w) => w.type === 'via_constrained');
      assert.ok(none(normal));
      assert.ok(!none(wide), 'a 6 m under-keel margin leaves the fixture too shallow');
      assert.strictEqual(wide.inputs?.safetyMarginDraft, 6);
      assert.strictEqual(normal.inputs?.safetyMarginDraft, DEFAULT_CONFIG.safetyMarginDraft);
    });

    it('an option margin applies when the request gives none', async () => {
      const engine = new RoutingEngine(db, options({ defaultSafetyMarginDraftM: 6 }));
      const r = await engine.calculateRoute({ ...THROUGH_BRIDGE, draft: 2.0, beam: 5.0, airDraft: 19.5 });
      assert.ok((r.warnings ?? []).some((w) => w.type === 'via_constrained'));
      assert.strictEqual(r.inputs?.safetyMarginDraft, 6);
    });

    it('the waits and the tide choice come from the request, else the options', async () => {
      const engine = new RoutingEngine(db, options({ defaultLockWaitMinutes: 11, defaultBridgeWaitMinutes: 7 }));
      const a = await engine.calculateRoute({ ...SHORT, ...BOAT });
      assert.deepStrictEqual([a.inputs?.lockWaitMinutes, a.inputs?.bridgeWaitMinutes, a.inputs?.useTides], [11, 7, false]);
      const b = await engine.calculateRoute({ ...SHORT, ...BOAT, lockWaitMinutes: 0, bridgeWaitMinutes: 3, useTides: false });
      assert.deepStrictEqual([b.inputs?.lockWaitMinutes, b.inputs?.bridgeWaitMinutes], [0, 3]);
      assert.deepStrictEqual(
        [b.timingAssumptions?.lockWaitMinutes, b.timingAssumptions?.bridgeWaitMinutes],
        [0, 3],
      );
    });
  });

  describe('inputs echo', () => {
    it('carries the effective values on a successful route', async () => {
      const engine = new RoutingEngine(db, options());
      const route = await engine.calculateRoute({
        ...SHORT,
        draft: 1.7,
        beam: 3.9,
        airDraft: 12.5,
        speedKnots: 6,
        safetyMarginDraft: 0.5,
        safetyMarginBeam: 1,
        safetyMarginAirDraft: 2,
        lockWaitMinutes: 15,
        bridgeWaitMinutes: 5,
        minCoastDistance: 0,
        lang: 'nl',
        describe: false,
        useTides: false,
        departureTime: '2026-08-03T06:00:00+02:00',
      });
      assert.deepStrictEqual(withoutData(route.inputs), {
        draft: 1.7,
        beam: 3.9,
        airDraft: 12.5,
        speedKnots: 6,
        safetyMarginDraft: 0.5,
        safetyMarginBeam: 1,
        safetyMarginAirDraft: 2,
        departureTime: '2026-08-03T04:00:00.000Z',
        useTides: false,
        lockWaitMinutes: 15,
        bridgeWaitMinutes: 5,
        minCoastDistance: 0,
        lang: 'nl',
        describe: false,
        coreVersion: CORE_VERSION,
      });
    });

    it('is the full effective set when the request gives nothing', async () => {
      const route = await new RoutingEngine(db, options()).calculateRoute({ start: SHORT.start, end: SHORT.end });
      assert.deepStrictEqual(withoutData(route.inputs), {
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

    it('is on routes with vias and manual legs too', async () => {
      const engine = new RoutingEngine(db, options());
      const withVia = await engine.calculateRoute({ ...THROUGH_BRIDGE, ...BOAT, via: [pt(51.6265, 3.91)] });
      assert.strictEqual(withVia.inputs?.draft, BOAT.draft);
      const manual = await engine.calculateRoute({ ...SHORT, ...BOAT, endMode: 'manual' });
      assert.strictEqual(manual.inputs?.beam, BOAT.beam);
    });

    it('is a copy: changing it does not change the next route', async () => {
      const engine = new RoutingEngine(db, options());
      const a = await engine.calculateRoute({ ...SHORT, ...BOAT });
      a.inputs!.draft = 99;
      const b = await engine.calculateRoute({ ...SHORT, ...BOAT });
      assert.strictEqual(b.inputs?.draft, BOAT.draft);
    });

    it('is absent from a failed route (an error is thrown, as before)', async () => {
      const engine = new RoutingEngine(db, options());
      await assert.rejects(engine.calculateRoute({ ...SHORT, ...BOAT, start: pt(50, 3.9) }), /No routing nodes found/);
    });
  });
});
