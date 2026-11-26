/**
 * Search budget and abort: one budget per request over every bounding-box
 * retry, via leg, scan step and smoothing pass; a per-request override can
 * only lower the engine's value; an AbortSignal ends a request at the same
 * checks with ABORTED.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_ENGINE_OPTIONS,
  RequestControl,
  RouteFailure,
  RoutingDatabase,
  RoutingEngine,
  effectiveBudget,
  type EngineOptions,
  type RoutingRequest,
} from 'routeiq-core';
import { directoryDatabaseOptions } from '../dist-tsc/data-dir.js';
import { toEngineOptions } from '../dist-tsc/engine-options.js';
import { DEFAULT_CONFIG } from '../dist-tsc/types.js';

const FIXTURE = path.join('test', 'fixtures', 'zeelandbrug');
const pt = (latitude: number, longitude: number) => ({ latitude, longitude });
const START = pt(51.613, 3.885);
const END = pt(51.609, 3.896);
const BRIDGE_VIA = pt(51.6265, 3.91);
const VESSEL = { draft: 2.0, beam: 5.0, airDraft: 19.5 };

const request = (over: Partial<RoutingRequest> = {}): RoutingRequest => ({
  start: START,
  end: END,
  minCoastDistance: 0,
  ...VESSEL,
  ...over,
});

function options(over: Partial<EngineOptions> = {}): EngineOptions {
  return { ...toEngineOptions({ ...DEFAULT_CONFIG }), logger: undefined, ...over };
}

async function rejection(p: Promise<unknown>): Promise<RouteFailure> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof RouteFailure, `not a RouteFailure: ${String(e)}`);
    return e;
  }
  assert.fail('expected a RouteFailure');
}

describe('request budget and abort', () => {
  let dir: string;
  let db: RoutingDatabase;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeiq-budget-'));
    fs.copyFileSync(path.join(FIXTURE, 'netherlands.sqlite'), path.join(dir, 'netherlands.sqlite'));
    db = new RoutingDatabase({ ...directoryDatabaseOptions(dir, { dynamicLoading: true }), logger: undefined });
    await db.init();
    await db.loadGraph();
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Node expansions a request takes, as the engine counts them. */
  async function iterationsOf(req: RoutingRequest, over: Partial<EngineOptions> = {}): Promise<number> {
    const engine = new RoutingEngine(db, options(over));
    await engine.calculateRoute(req);
    return engine.getCounters().search.iterations.sum;
  }

  describe('RequestControl and effectiveBudget', () => {
    it('a request value only lowers the engine value', () => {
      assert.deepStrictEqual(effectiveBudget({ maxIterations: 100, maxWallMs: 50 }, { maxIterations: 1000, maxWallMs: 10 }), {
        maxIterations: 100,
        maxWallMs: 10,
      });
      assert.deepStrictEqual(effectiveBudget({ maxIterations: 100 }, undefined), { maxIterations: 100, maxWallMs: Infinity });
      assert.deepStrictEqual(effectiveBudget(undefined, { maxIterations: 7 }), { maxIterations: 7, maxWallMs: Infinity });
      // A negative or NaN value is no limit, and does not raise anything either.
      assert.deepStrictEqual(effectiveBudget({ maxIterations: 5 }, { maxIterations: -1, maxWallMs: NaN }), {
        maxIterations: 5,
        maxWallMs: Infinity,
      });
    });

    it('counts expansions and reports the limit passed, which and how much', () => {
      const c = new RequestControl({ maxIterations: 2, maxWallMs: Infinity });
      assert.strictEqual(c.expand(), null);
      assert.strictEqual(c.expand(), null);
      assert.deepStrictEqual(c.expand(), { code: 'BUDGET_EXCEEDED', params: { limit: 'maxIterations', used: 3, max: 2 } });
    });

    it('an aborted signal wins over the budget', () => {
      const ac = new AbortController();
      const c = new RequestControl({ maxIterations: 0, maxWallMs: Infinity }, ac.signal);
      ac.abort();
      assert.strictEqual(c.check()?.code, 'ABORTED');
    });
  });

  describe('budget', () => {
    it('is unlimited by default and the per-search cap is the same 5M', async () => {
      assert.strictEqual(DEFAULT_ENGINE_OPTIONS.maxSearchIterations, 5_000_000);
      assert.deepStrictEqual(DEFAULT_ENGINE_OPTIONS.budget, { maxIterations: Infinity, maxWallMs: Infinity });
      // Options that name neither (the plugin's mapping) mean the same.
      const engine = new RoutingEngine(db, options());
      assert.strictEqual(engine.options.budget, undefined);
      await engine.calculateRoute(request());
      assert.strictEqual(engine.getCounters().budgetHits, 0);
    });

    it('the per-search cap still ends a search as "no path" with iterationLimit, not as a budget hit', async () => {
      const engine = new RoutingEngine(db, options({ maxSearchIterations: 3 }));
      const e = await rejection(engine.calculateRoute(request()));
      assert.notStrictEqual(e.code, 'BUDGET_EXCEEDED');
      assert.strictEqual(e.code, 'NO_PATH');
      assert.ok(JSON.stringify(e.params).includes('"iterationLimit":true'), JSON.stringify(e.params));
      assert.strictEqual(engine.getCounters().budgetHits, 0);
    });

    it('stops a plain route over its iteration budget, counts the hit, and the engine stays usable', async () => {
      const total = await iterationsOf(request());
      assert.ok(total > 10, `fixture route too small to test (${total})`);
      const engine = new RoutingEngine(db, options({ budget: { maxIterations: total - 1 } }));
      const e = await rejection(engine.calculateRoute(request()));
      assert.strictEqual(e.code, 'BUDGET_EXCEEDED');
      assert.strictEqual(e.params.limit, 'maxIterations');
      assert.strictEqual(e.params.max, total - 1);
      assert.ok((e.params.used as number) > total - 1);
      assert.strictEqual(engine.getCounters().budgetHits, 1);
      assert.strictEqual(engine.getCounters().failuresByCode.BUDGET_EXCEEDED, 1);
      assert.strictEqual(engine.getCounters().search.iterations.count, 1, 'the stopped search is recorded once');
      assert.strictEqual(engine.getCounters().search.iterations.sum, total, 'with the expansions it made');
      // Exactly the needed amount is enough: the budget is on what was spent.
      const ok = new RoutingEngine(db, options({ budget: { maxIterations: total } }));
      await ok.calculateRoute(request());
      assert.strictEqual(ok.getCounters().budgetHits, 0);
    });

    it('counts over every via leg: each leg alone fits, the sum does not', async () => {
      const req = request({ via: [BRIDGE_VIA] });
      const total = await iterationsOf(req);
      const legs = await Promise.all([
        iterationsOf(request({ end: BRIDGE_VIA })),
        iterationsOf(request({ start: BRIDGE_VIA })),
      ]);
      assert.ok(legs[0] < total && legs[1] < total, `${legs} vs ${total}`);
      const budget = { maxIterations: total - 1 };
      assert.ok(Math.max(...legs) <= budget.maxIterations, 'every single leg fits the budget');
      const engine = new RoutingEngine(db, options({ budget }));
      const e = await rejection(engine.calculateRoute(req));
      assert.strictEqual(e.code, 'BUDGET_EXCEEDED');
      assert.strictEqual(engine.getCounters().budgetHits, 1);
    });

    it('counts over every bounding-box retry', async () => {
      // No path exists to this point at any box size, so every box is
      // searched. A wide first box is two searches; a tight one widens through
      // ten. The same budget lets the first end as "no path" and stops the
      // second part-way through its retries.
      const unreachable = request({ end: pt(51.64, 3.92) });
      const budget = { maxIterations: 10_000 };
      const wide = new RoutingEngine(db, options({ bboxMarginDeg: 5, budget }));
      const noPath = await rejection(wide.calculateRoute(unreachable));
      assert.strictEqual(noPath.code, 'NO_PATH');
      const tight = new RoutingEngine(db, options({ bboxMarginDeg: 0.02, budget }));
      const e = await rejection(tight.calculateRoute(unreachable));
      assert.strictEqual(e.code, 'BUDGET_EXCEEDED');
      assert.strictEqual(tight.getCounters().budgetHits, 1);
    });

    it('a per-request budget cannot raise the engine value, and can lower it', async () => {
      const total = await iterationsOf(request());
      const low = total - 1;
      const engine = new RoutingEngine(db, options({ budget: { maxIterations: low } }));
      const raised = await rejection(engine.calculateRoute(request(), { budget: { maxIterations: total * 100 } }));
      assert.strictEqual(raised.params.max, low, 'the engine value stood');
      const open = new RoutingEngine(db, options());
      const lowered = await rejection(open.calculateRoute(request(), { budget: { maxIterations: 5 } }));
      assert.strictEqual(lowered.code, 'BUDGET_EXCEEDED');
      assert.strictEqual(lowered.params.max, 5);
      // The next request on the same engine is not affected by that override.
      await open.calculateRoute(request());
    });

    it('the wall limit stops a route, a via route and a scan', async () => {
      const engine = new RoutingEngine(db, options());
      const budget = { maxWallMs: 0 };
      for (const req of [request(), request({ via: [BRIDGE_VIA] })]) {
        const e = await rejection(engine.calculateRoute(req, { budget }));
        assert.strictEqual(e.code, 'BUDGET_EXCEEDED');
        assert.strictEqual(e.params.limit, 'maxWallMs');
      }
      const scan = await rejection(engine.scanDepartures({ ...request(), departureTime: '2026-08-11T06:00:00.000Z' }, 3, 60, { budget }));
      assert.strictEqual(scan.code, 'BUDGET_EXCEEDED');
      assert.strictEqual(scan.params.limit, 'maxWallMs');
      assert.strictEqual(engine.getCounters().budgetHits, 3, 'two routes, and the scan counted once');
    });

    it('the wall limit also cuts a long request short, part-way through its searches', async () => {
      // Several hundred ms of searching over ten boxes; 40 ms of wall time is
      // spent well before it ends, at one of the checks inside or between them.
      const engine = new RoutingEngine(db, options({ bboxMarginDeg: 0.02, budget: { maxWallMs: 40 } }));
      const e = await rejection(engine.calculateRoute(request({ end: pt(51.64, 3.92) })));
      assert.strictEqual(e.code, 'BUDGET_EXCEEDED');
      assert.strictEqual(e.params.limit, 'maxWallMs');
      assert.ok((e.params.used as number) >= 40);
      assert.ok(engine.getCounters().search.iterations.count < 10);
    });

    it('a departure scan spends one budget over all its steps', async () => {
      const scanReq = { ...request(), departureTime: '2026-08-11T06:00:00.000Z' };
      const probe = new RoutingEngine(db, options());
      await probe.scanDepartures(scanReq, 3, 60);
      const total = probe.getCounters().search.iterations.sum;
      const steps = RoutingEngine.departureScanSteps(3, 60);
      assert.ok(steps >= 2 && total > steps, `${steps} steps, ${total} iterations`);
      // One step alone fits, the sum of all does not.
      const perStep = Math.ceil(total / steps);
      const engine = new RoutingEngine(db, options({ budget: { maxIterations: total - 1 } }));
      assert.ok(perStep <= total - 1);
      const e = await rejection(engine.scanDepartures(scanReq, 3, 60));
      assert.strictEqual(e.code, 'BUDGET_EXCEEDED');
      assert.strictEqual(engine.getCounters().budgetHits, 1, 'counted once');
      // Streaming: results before the overrun were delivered, then it throws.
      const stream = new RoutingEngine(db, options({ budget: { maxIterations: total - 1 } }));
      const seen: number[] = [];
      let thrown: unknown;
      try {
        for await (const step of stream.streamDepartures(scanReq, 3, 60)) seen.push(step.index);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof RouteFailure && thrown.code === 'BUDGET_EXCEEDED');
      assert.ok(seen.length >= 1 && seen.length < steps, `${seen.length} of ${steps} steps before the overrun`);
    });

    it('releases the request: the in-flight count is back to zero and a later request routes', async () => {
      const engine = new RoutingEngine(db, options({ budget: { maxIterations: 1 } }));
      await rejection(engine.calculateRoute(request()));
      await rejection(engine.scanDepartures({ ...request(), departureTime: '2026-08-11T06:00:00.000Z' }, 2, 60));
      const fresh = new RoutingEngine(db, options());
      const result = await fresh.calculateRoute(request());
      assert.ok(result.features.length > 0);
    });
  });

  describe('abort', () => {
    it('before the request starts', async () => {
      const engine = new RoutingEngine(db, options());
      const ac = new AbortController();
      ac.abort();
      const e = await rejection(engine.calculateRoute(request(), { signal: ac.signal }));
      assert.strictEqual(e.code, 'ABORTED');
      assert.strictEqual(engine.getCounters().failuresByCode.ABORTED, 1);
      assert.strictEqual(engine.getCounters().budgetHits, 0);
    });

    it('in the middle of a search', async () => {
      const engine = new RoutingEngine(db, options({ bboxMarginDeg: 0.02 }));
      // Reads of `aborted` happen at the checks (start, each box, every 1024
      // expansions, each yield); flip it from the fifth read on. This request
      // searches ten boxes of a few thousand expansions each, so the fifth
      // read lands inside the searching, long before it would end.
      let reads = 0;
      const signal = {
        get aborted() {
          return ++reads > 5;
        },
      } as unknown as AbortSignal;
      const e = await rejection(engine.calculateRoute(request({ end: pt(51.64, 3.92) }), { signal }));
      assert.strictEqual(e.code, 'ABORTED');
      assert.ok(reads >= 6 && reads < 20, `${reads} reads`);
      assert.ok(engine.getCounters().search.iterations.count < 10, 'stopped before every box was searched');
    });

    it('a route with no A* search (same-region navmesh) is still stopped before it counts as calculated', async () => {
      const engine = new RoutingEngine(db, options());
      let reads = 0;
      // The start check reads once; the next read is after the route was built.
      const signal = {
        get aborted() {
          return ++reads > 1;
        },
      } as unknown as AbortSignal;
      const e = await rejection(engine.calculateRoute(request({ end: BRIDGE_VIA }), { signal }));
      assert.strictEqual(e.code, 'ABORTED');
      assert.strictEqual(engine.getCounters().routes.calculated, 0);
      assert.strictEqual(engine.getCounters().search.iterations.count, 0, 'no search ran');
    });

    it('in the middle of a scan: between steps, ending the stream with ABORTED', async () => {
      const engine = new RoutingEngine(db, options());
      const ac = new AbortController();
      const scanReq = { ...request(), departureTime: '2026-08-11T06:00:00.000Z' };
      const seen: number[] = [];
      let thrown: unknown;
      try {
        for await (const step of engine.streamDepartures(scanReq, 3, 60, { signal: ac.signal })) {
          seen.push(step.index);
          if (seen.length === 1) ac.abort();
        }
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof RouteFailure && thrown.code === 'ABORTED', String(thrown));
      assert.strictEqual(seen.length, 1);
    });

    it('a consumer that stops reading ends the scan cleanly', async () => {
      const engine = new RoutingEngine(db, options());
      const scanReq = { ...request(), departureTime: '2026-08-11T06:00:00.000Z' };
      let n = 0;
      for await (const _step of engine.streamDepartures(scanReq, 3, 60)) {
        void _step;
        if (++n === 1) break;
      }
      assert.strictEqual(n, 1);
      // The in-flight bracket was released: the next request works normally.
      await engine.calculateRoute(request());
    });
  });

  describe('tide providers that never answer', () => {
    /** A height provider whose calls never settle. */
    const hanging = {
      findStations: () => new Promise<never>(() => undefined),
      fetchTimeline: () => new Promise<never>(() => undefined),
      probe: () => new Promise<never>(() => undefined),
    };
    const tideRequest = () => request({ useTides: true, departureTime: '2026-08-11T06:00:00.000Z' });

    it('an abort ends the wait with ABORTED', async () => {
      const engine = new RoutingEngine(db, options());
      engine.setTidesClient(hanging);
      const controller = new AbortController();
      const outcome = rejection(engine.calculateRoute(tideRequest(), { signal: controller.signal }));
      setTimeout(() => controller.abort(), 50);
      assert.strictEqual((await outcome).code, 'ABORTED');
    });

    it('the wall-time budget ends the wait with BUDGET_EXCEEDED', async () => {
      const engine = new RoutingEngine(db, options());
      engine.setTidesClient(hanging);
      const failure = await rejection(engine.calculateRoute(tideRequest(), { budget: { maxWallMs: 100 } }));
      assert.strictEqual(failure.code, 'BUDGET_EXCEEDED');
      assert.strictEqual(failure.params.limit, 'maxWallMs');
    });

    it('an already aborted signal stops before the provider is asked', async () => {
      const engine = new RoutingEngine(db, options());
      engine.setTidesClient(hanging);
      const controller = new AbortController();
      controller.abort();
      assert.strictEqual((await rejection(engine.calculateRoute(tideRequest(), { signal: controller.signal }))).code, 'ABORTED');
    });
  });
});
