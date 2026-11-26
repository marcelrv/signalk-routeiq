/**
 * The engine's observability surface: the injected logger (and the worker
 * thread's lines reaching it), stable failure codes, the message language
 * option, and the counters.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  RouteFailure,
  RouteRequestError,
  RouteSearchError,
  RoutingDatabase,
  RoutingEngine,
  failureInfo,
  formatFailure,
  type EngineOptions,
  type Logger,
  type RoutingRequest,
} from 'routeiq-core';
import { directoryDatabaseOptions } from '../dist-tsc/data-dir.js';
import { toEngineOptions } from '../dist-tsc/engine-options.js';
import { inputsFor } from './engine-helper.js';
import { DEFAULT_CONFIG } from '../dist-tsc/types.js';

const FIXTURE = path.join('test', 'fixtures', 'zeelandbrug');
const pt = (latitude: number, longitude: number) => ({ latitude, longitude });
const START = pt(51.613, 3.885);
const END = pt(51.609, 3.896);
const VESSEL = { draft: 2.0, beam: 5.0, airDraft: 19.5 };

interface Entry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

function spyLogger(): { logger: Logger; entries: Entry[] } {
  const entries: Entry[] = [];
  const at = (level: Entry['level']) => (message: string) => {
    entries.push({ level, message });
  };
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, entries };
}

function tmpCopy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeiq-observability-'));
  fs.copyFileSync(path.join(FIXTURE, 'netherlands.sqlite'), path.join(dir, 'netherlands.sqlite'));
  return dir;
}

async function openDb(dir: string, logger: Logger | undefined, dynamic = false): Promise<RoutingDatabase> {
  const db = new RoutingDatabase({ ...directoryDatabaseOptions(dir, { dynamicLoading: dynamic }), logger });
  await db.init();
  await db.loadGraph();
  return db;
}

/** The plugin's mapping (English texts), with what a test wants changed. */
function options(over: Partial<EngineOptions> = {}): EngineOptions {
  return { ...toEngineOptions({ ...DEFAULT_CONFIG }), logger: undefined, ...over };
}

const request = (over: Partial<RoutingRequest> = {}): RoutingRequest => ({
  start: START,
  end: END,
  minCoastDistance: 0,
  ...VESSEL,
  ...over,
});

describe('logger', () => {
  let dir: string;
  before(() => {
    dir = tmpCopy();
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is silent when none is given: nothing reaches the console', async () => {
    const seen: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    for (const k of Object.keys(saved) as Array<keyof typeof saved>) {
      console[k] = (...a: unknown[]) => void seen.push(`${k}: ${a.join(' ')}`);
    }
    try {
      const db = await openDb(dir, undefined, true);
      const engine = new RoutingEngine(db, options());
      await engine.calculateRoute(request());
      await engine.calculateRoute(request({ ...VESSEL, draft: 8 })).catch(() => undefined);
      await engine.calculateRoute(request({ start: pt(10, 10) })).catch(() => undefined);
      await db.close();
    } finally {
      Object.assign(console, saved);
    }
    assert.deepStrictEqual(seen, []);
  });

  it('receives what the worker thread logs, as messages from the main thread', async () => {
    const { logger, entries } = spyLogger();
    const db = await openDb(dir, logger, true);
    await db.loadDatabaseGraph('netherlands.sqlite');
    await db.close();
    const worker = entries.filter((e) => e.message.startsWith('[db-worker]'));
    assert.ok(worker.length > 0, `no worker line reached the logger: ${JSON.stringify(entries)}`);
    assert.ok(worker.every((e) => e.level === 'info' || e.level === 'warn' || e.level === 'error'));
    assert.ok(
      worker.some((e) => e.level === 'info' && /^\[db-worker\] Opened database on demand: .*netherlands\.sqlite \(dbIndex=\d+\)$/.test(e.message)),
      JSON.stringify(worker),
    );
    // The database's own lines come through the same logger.
    assert.ok(entries.some((e) => e.message.startsWith('[routeiq] Loaded database netherlands.sqlite')));
  });

  it('gets no coordinates, request bodies or positions at info and above', async () => {
    const { logger, entries } = spyLogger();
    const db = await openDb(dir, logger, true);
    const engine = new RoutingEngine(db, options({ logger }));
    await engine.calculateRoute(request());
    await engine.calculateRoute(request({ via: [pt(51.6265, 3.91)] }));
    // a penalised route (retries with wider boxes, logging each) and failures
    await engine.calculateRoute(request({ draft: 8 }));
    await engine.calculateRoute(request({ start: pt(10, 10) })).catch(() => undefined);
    // the vessel position that loads a region
    await db.eagerLoadForPosition(51.613, 3.885);
    await db.close();
    assert.ok(entries.length > 5, 'the flow should have logged something');
    const loud = entries.filter((e) => e.level !== 'debug');
    for (const e of loud) {
      assert.ok(!/-?\d{1,3}\.\d{4,}/.test(e.message), `a coordinate-like number at ${e.level}: ${e.message}`);
      assert.ok(!/51\.6|3\.8|3\.9/.test(e.message), `a route coordinate at ${e.level}: ${e.message}`);
    }
    // The position is logged, at debug only.
    assert.ok(entries.some((e) => e.level === 'debug' && e.message.includes('Vessel position')) || entries.every((e) => !e.message.includes('Vessel position')));
    assert.ok(loud.every((e) => !e.message.includes('Vessel position')));
  });

  it('reports a vessel position at debug when it loads a region', async () => {
    const { logger, entries } = spyLogger();
    const unloaded = tmpCopy();
    try {
      const db = new RoutingDatabase({ ...directoryDatabaseOptions(unloaded, { dynamicLoading: true }), logger });
      await db.init();
      await db.eagerLoadForPosition(51.613, 3.885);
      await db.close();
      const position = entries.filter((e) => e.message.includes('Vessel position'));
      assert.strictEqual(position.length, 1);
      assert.strictEqual(position[0].level, 'debug');
    } finally {
      fs.rmSync(unloaded, { recursive: true, force: true });
    }
  });
});

describe('structured failures', () => {
  let dir: string;
  let db: RoutingDatabase;
  let log: ReturnType<typeof spyLogger>;
  before(async () => {
    dir = tmpCopy();
    log = spyLogger();
    db = await openDb(dir, log.logger);
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const engine = (over: Partial<EngineOptions> = {}) => new RoutingEngine(db, options({ logger: log.logger, ...over }));
  const failure = async (e: RoutingEngine, req: RoutingRequest): Promise<RouteFailure> => {
    try {
      await e.calculateRoute(req);
    } catch (err) {
      assert.ok(err instanceof RouteFailure, `not a RouteFailure: ${err}`);
      return err;
    }
    throw new assert.AssertionError({ message: 'expected the route to fail' });
  };

  it('OUTSIDE_COVERAGE: the start is outside every region (the old message, name and text)', async () => {
    const f = await failure(engine(), request({ start: pt(50.0, 3.9) }));
    assert.strictEqual(f.code, 'OUTSIDE_COVERAGE');
    assert.deepStrictEqual(f.params, { point: 'start' });
    assert.strictEqual(f.message, 'No routing nodes found near start point');
    assert.strictEqual(f.name, 'Error');
    assert.strictEqual(f.blocking, undefined);
    assert.deepStrictEqual(failureInfo(f), { code: 'OUTSIDE_COVERAGE', params: { point: 'start' } });
    assert.strictEqual((await failure(engine(), request({ end: pt(50.0, 3.9) }))).params.point, 'end');
  });

  it('NO_NODE_NEAR_POINT: the regions cannot say, and no node is near', async () => {
    const original = db.coverageProblemAt;
    db.coverageProblemAt = () => null;
    try {
      const f = await failure(engine(), request({ start: pt(50.0, 3.9) }));
      assert.strictEqual(f.code, 'NO_NODE_NEAR_POINT');
      assert.strictEqual(f.message, 'No routing nodes found near start point');
    } finally {
      db.coverageProblemAt = original;
    }
  });

  it('REGION_UNAVAILABLE: a refused file covers the point, naming the file and why', async () => {
    const original = db.coverageProblemAt;
    db.coverageProblemAt = () => ({ kind: 'unsupported', file: 'a.sqlite', reason: 'Rebuild it with the factory.' });
    try {
      const f = await failure(engine(), request({ start: pt(50.0, 3.9) }));
      assert.strictEqual(f.code, 'REGION_UNAVAILABLE');
      assert.deepStrictEqual(f.params, { point: 'start', file: 'a.sqlite', reason: 'Rebuild it with the factory.' });
      assert.strictEqual(
        f.message,
        'No routing nodes found near start point (a.sqlite covers this area but is not used: Rebuild it with the factory.)',
      );
    } finally {
      db.coverageProblemAt = original;
    }
  });

  it('REGION_UNAVAILABLE: a region that fails to load, with the detail in the log and not in the message', async () => {
    const original = db.ensureRegionsLoaded;
    db.ensureRegionsLoaded = async () => {
      throw new Error('SELECT * FROM nodes: disk I/O error (/var/data/region.sqlite)');
    };
    log.entries.length = 0;
    try {
      const f = await failure(engine(), request());
      assert.strictEqual(f.code, 'REGION_UNAVAILABLE');
      assert.strictEqual(f.message, 'A routing region needed for this route could not be loaded');
      assert.ok(!/SELECT|region\.sqlite|\/var/.test(f.message));
      assert.ok(log.entries.some((e) => e.level === 'error' && /disk I\/O error/.test(e.message)));
    } finally {
      db.ensureRegionsLoaded = original;
    }
  });

  it('INVALID_REQUEST: a start that is not a coordinate pair', async () => {
    const e = engine();
    for (const [field, req] of [
      ['start', request({ start: null as never })],
      ['end', request({ end: { latitude: 'x', longitude: 1 } as never })],
      ['via[1]', request({ via: [pt(51.62, 3.9), undefined as never] })],
    ] as const) {
      const f = await failure(e, req);
      assert.ok(f instanceof RouteRequestError);
      assert.strictEqual(f.code, 'INVALID_REQUEST');
      assert.deepStrictEqual(f.params, { field });
      assert.strictEqual(f.name, 'RouteRequestError');
    }
  });

  it('VESSEL_INCOMPLETE: strict mode, worded in the request language when the option follows it', async () => {
    const strict = engine({ requireVesselInRequest: true, messageLanguage: 'request' });
    const f = await failure(strict, { start: START, end: END, draft: 2, beam: 5 });
    assert.strictEqual(f.code, 'VESSEL_INCOMPLETE');
    assert.deepStrictEqual(f.params, { missing: ['airDraft', 'speedKnots'] });
    assert.strictEqual(f.message, 'The request must carry the vessel and speed; missing: airDraft, speedKnots');
    const nl = await failure(strict, { start: START, end: END, draft: 2, beam: 5, lang: 'nl-BE' });
    assert.strictEqual(nl.message, 'De aanvraag moet het schip en de snelheid bevatten; ontbrekend: airDraft, speedKnots');
  });

  describe('NO_PATH, from a search that finds none', () => {
    const noPath = (e: RoutingEngine, search: () => Promise<never>) => {
      (e as any).astarSearch = search;
      return e;
    };
    const reason = {
      search: () =>
        RouteSearchError.create(
          'NO_PATH',
          {
            reason: 'search',
            skipped: { land: 0, obstacle: 0, draft: 3, airDraft: 0, beam: 0, coastDistance: 0, bbox: 0 },
            iterationLimit: false,
            draft: 2,
            beam: 5,
            airDraft: 19.5,
            minCoastDistance: 0,
          },
          'en',
          [{ dimension: 'draft', value: 2, need: 2.3 }],
        ),
    };

    // The graph is connected as far as the fallback can tell.
    const connected = async <T>(run: () => Promise<T>): Promise<T> => {
      const real = db.getReachableNodes;
      db.getReachableNodes = (() => ({ has: () => true, size: 1 })) as never;
      try {
        return await run();
      } finally {
        db.getReachableNodes = real;
      }
    };

    it('graph_connected: the last search failure rides along, with its blocking list', async () => {
      const f = await connected(() =>
        failure(
          noPath(engine(), async () => {
            throw reason.search();
          }),
          request(),
        ),
      );
      assert.strictEqual(f.code, 'NO_PATH');
      assert.strictEqual(f.params.reason, 'graph_connected');
      const cause = f.params.cause as { code: string; params: Record<string, unknown> };
      assert.strictEqual(cause.code, 'NO_PATH');
      assert.strictEqual(cause.params.reason, 'search');
      assert.match(f.message, /^No route found — graph is connected but A\* could not find a path\. .* Last search error: No route found between the given points — during the search, ran into: 3 edge\(s\) too shallow for draft 2m\./);
      // Rendered again in Dutch, the nested cause is Dutch too.
      assert.match(formatFailure(f.code, f.params, 'nl'), /Laatste zoekfout: Geen route gevonden tussen de opgegeven punten — tijdens het zoeken/);
    });

    it('destination: a via route whose final leg finds no path', async () => {
      const f = await failure(
        noPath(engine(), async () => {
          throw reason.search();
        }),
        request({ via: [pt(51.6265, 3.91)] }),
      );
      assert.strictEqual(f.code, 'NO_PATH');
      assert.strictEqual(f.params.reason, 'destination');
      assert.strictEqual((f.params.cause as { code: string }).code, 'NO_PATH');
      assert.match(f.message, /^No route found to destination: /);
    });

    it('a plain failure message keeps its text as the cause', async () => {
      const f = await connected(() =>
        failure(
          noPath(engine(), async () => {
            throw new RouteSearchError('hand-made text');
          }),
          request(),
        ),
      );
      assert.deepStrictEqual(f.params.cause, { message: 'hand-made text' });
      assert.match(f.message, /Last search error: hand-made text$/);
    });

    it('disconnected: neither end can be bridged to the main network', async () => {
      const e = engine();
      const real = db.getReachableNodes.bind(db);
      const realNear = db.findNearestNodeInSet.bind(db);
      db.getReachableNodes = (n: number) => new Set([n]);
      db.findNearestNodeInSet = async () => null;
      try {
        const f = await failure(
          noPath(e, async () => {
            throw reason.search();
          }),
          request(),
        );
        assert.strictEqual(f.code, 'NO_PATH');
        assert.deepStrictEqual(f.params, { reason: 'disconnected' });
        assert.match(f.message, /^No route found — the start and end are in disconnected parts of the waterway network/);
      } finally {
        db.getReachableNodes = real;
        db.findNearestNodeInSet = realNear;
      }
    });

    it('primary_network: the bridged route through the main network finds no path either', async () => {
      const e = engine();
      const real = db.getReachableNodes.bind(db);
      const realNear = db.findNearestNodeInSet.bind(db);
      let n = 0;
      db.getReachableNodes = (id: number) => new Set([id]);
      db.findNearestNodeInSet = async () => ({ id: ++n, lat: 51.61, lon: 3.89 }) as never;
      try {
        const f = await failure(
          noPath(e, async () => {
            throw reason.search();
          }),
          request(),
        );
        assert.strictEqual(f.params.reason, 'primary_network');
        assert.match(f.message, /^No route found through the primary waterway network between the connection points: No route found between the given points/);
      } finally {
        db.getReachableNodes = real;
        db.findNearestNodeInSet = realNear;
      }
    });
  });

  it('a search that exhausts its frontier fails as NO_PATH, with the counts as numbers and the limits in blocking', async () => {
    // One shallow edge out of the start node and nothing beyond it: the search
    // looks at that edge, penalises it for the draft, and runs out of graph.
    const e = engine();
    const inputs = inputsFor(e.options, { ...VESSEL });
    const startNode = (await db.findNearestNode(START.latitude, START.longitude)) as number;
    const real = db.getOutgoingEdges.bind(db);
    const first = (await real(startNode))[0];
    // (Every node offers that one edge: the start point lies inside a navmesh
    // region, so the search starts from its boundary nodes, not one node.)
    db.getOutgoingEdges = (async (id: number) => [
      { ...first, source: id, min_depth: 0.1, max_air_draft: 100, min_width: 100 },
    ]) as never;
    let thrown: unknown;
    try {
      await (e as any).astarSearch(START.latitude, START.longitude, END.latitude, END.longitude, 0, inputs, undefined, undefined, false);
    } catch (err) {
      thrown = err;
    } finally {
      db.getOutgoingEdges = real;
    }
    assert.ok(thrown instanceof RouteSearchError, String(thrown));
    assert.strictEqual(thrown.code, 'NO_PATH');
    assert.strictEqual(thrown.params.reason, 'search');
    assert.strictEqual(thrown.params.iterationLimit, false);
    assert.deepStrictEqual(
      [thrown.params.draft, thrown.params.beam, thrown.params.airDraft, thrown.params.minCoastDistance],
      [2, 5, 19.5, 0],
    );
    const skipped = thrown.params.skipped as Record<string, number>;
    assert.deepStrictEqual({ ...skipped, draft: 0 }, { land: 0, obstacle: 0, draft: 0, airDraft: 0, beam: 0, coastDistance: 0, bbox: 0 });
    assert.ok(skipped.draft >= 1);
    // The dimension the search saw an edge violate, the vessel's own value and
    // what it needed (draft + margin); nothing else is named.
    assert.deepStrictEqual(thrown.blocking, [{ dimension: 'draft', value: 2, need: 2.3 }]);
    assert.strictEqual(
      thrown.message,
      `No route found between the given points — during the search, ran into: ${skipped.draft} edge(s) too shallow for draft 2m. ` +
        '(vessel dims: draft=2m, beam=5m, airDraft=19.5m, minCoastDistance=0.00nm)',
    );
    // Worded again from the params alone, the text is the same.
    assert.strictEqual(formatFailure(thrown.code, thrown.params, 'en'), thrown.message);
    assert.deepStrictEqual(thrown.failure.blocking, thrown.blocking);
  });

  it('RouteSearchError keeps working as before: a text alone is a NO_PATH failure', () => {
    const e = new RouteSearchError('some text');
    assert.ok(e instanceof RouteFailure && e instanceof Error);
    assert.strictEqual(e.name, 'RouteSearchError');
    assert.strictEqual(e.code, 'NO_PATH');
    assert.deepStrictEqual(e.params, {});
    assert.strictEqual(e.message, 'some text');
  });

  it('keeps its blocking list only when there is something in it', () => {
    assert.strictEqual(new RouteFailure('NO_PATH', {}, 'm', []).blocking, undefined);
    const blocking = [{ dimension: 'airDraft' as const, value: 19.5, need: 21 }];
    assert.deepStrictEqual(new RouteFailure('NO_PATH', {}, 'm', blocking).failure, { code: 'NO_PATH', params: {}, blocking });
  });

  it('BUDGET_EXCEEDED and ABORTED are reserved: nothing throws them yet, the catalogue words them', () => {
    for (const code of ['BUDGET_EXCEEDED', 'ABORTED'] as const) {
      const f = RouteFailure.create(code, {}, 'nl');
      assert.strictEqual(f.code, code);
      assert.ok(f.message.startsWith('De routeberekening'));
    }
  });

  it('a departure scan step carries the failure code and params', async () => {
    const e = engine();
    const steps = await e.scanDepartures({ ...request({ start: pt(50.0, 3.9) }), departureTime: '2026-08-11T06:00:00.000Z' }, 1, 60);
    assert.ok(steps.length >= 1);
    assert.strictEqual(steps[0].error, 'No routing nodes found near start point');
    assert.strictEqual(steps[0].code, 'OUTSIDE_COVERAGE');
    assert.deepStrictEqual(steps[0].params, { point: 'start' });
  });
});

describe('message language', () => {
  let dir: string;
  let db: RoutingDatabase;
  before(async () => {
    dir = tmpCopy();
    db = await openDb(dir, undefined);
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deep = (lang?: string) => request({ draft: 8, ...(lang ? { lang } : {}) });

  it('"request" follows the request lang: warnings, leg warnings and failures in Dutch', async () => {
    const engine = new RoutingEngine(db, options({ messageLanguage: 'request' }));
    const route = await engine.calculateRoute(deep('nl'));
    const warn = route.warnings?.find((w) => w.code === 'ROUTE_CONSTRAINED');
    assert.ok(warn, JSON.stringify(route.warnings));
    assert.match(warn.message, /^Route naar bestemming: beperkt voor \d+ traject\(en\) \d,\d Nm — /);
    assert.strictEqual(warn.type, 'via_constrained');
    const legWarnings = (route.itinerary ?? []).flatMap((p) => p.leg?.warnings ?? []);
    assert.ok(legWarnings.some((w) => w.code === 'LEG_LOW_CLEARANCE' && /^Lage doorvaarthoogte \(\d+,\d m, nodig \d+,\d m\)$/.test(w.message)), JSON.stringify(legWarnings));
    const f = await engine.calculateRoute(request({ start: pt(50, 3.9), lang: 'nl' })).catch((e) => e as RouteFailure) as RouteFailure;
    assert.strictEqual(f.code, 'OUTSIDE_COVERAGE');
    assert.strictEqual(f.message, 'Geen routeringsknooppunten gevonden bij het startpunt');
  });

  it('"request" with no lang, or one the catalogue lacks, reads English', async () => {
    const engine = new RoutingEngine(db, options({ messageLanguage: 'request' }));
    for (const lang of [undefined, 'de', 'fr-CA']) {
      const f = await engine.calculateRoute(request({ start: pt(50, 3.9), ...(lang ? { lang } : {}) })).catch((e) => e as Error) as Error;
      assert.strictEqual(f.message, 'No routing nodes found near start point', String(lang));
    }
  });

  it('"en" keeps every text English whatever the request asks (the plugin mapping)', async () => {
    assert.strictEqual(toEngineOptions({ ...DEFAULT_CONFIG }).messageLanguage, 'en');
    const engine = new RoutingEngine(db, options());
    const route = await engine.calculateRoute(deep('nl'));
    assert.ok(route.warnings?.every((w) => !/Route naar|Nm — diepte|doorvaarthoogte/.test(w.message)));
    assert.ok(route.warnings?.some((w) => /^Route to destination: constrained for/.test(w.message)));
    const f = await engine.calculateRoute(request({ start: pt(50, 3.9), lang: 'nl' })).catch((e) => e as Error) as Error;
    assert.strictEqual(f.message, 'No routing nodes found near start point');
  });

  it('any other value fixes the language for every request', async () => {
    const engine = new RoutingEngine(db, options({ messageLanguage: 'nl' }));
    const route = await engine.calculateRoute(deep('en'));
    assert.ok(route.warnings?.some((w) => /^Route naar bestemming: beperkt voor/.test(w.message)));
  });

  it('the language of the water names is still the request lang, whatever the message language', async () => {
    const engine = new RoutingEngine(db, options({ messageLanguage: 'en' }));
    const route = await engine.calculateRoute(request({ lang: 'nl' }));
    assert.strictEqual(route.inputs?.lang, 'nl');
  });
});

describe('counters', () => {
  let dir: string;
  let db: RoutingDatabase;
  before(async () => {
    dir = tmpCopy();
    db = await openDb(dir, undefined, true);
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('start at zero with every failure code present', () => {
    const c = new RoutingEngine(db, options()).getCounters();
    assert.strictEqual(c.routes.calculated, 0);
    assert.strictEqual(c.routes.failed, 0);
    assert.deepStrictEqual(Object.keys(c.failuresByCode).sort(), [
      'ABORTED', 'BUDGET_EXCEEDED', 'INVALID_REQUEST', 'NO_NODE_NEAR_POINT', 'NO_PATH', 'OUTSIDE_COVERAGE', 'REGION_UNAVAILABLE', 'VESSEL_INCOMPLETE',
    ]);
    assert.deepStrictEqual(c.search, { iterations: { sum: 0, count: 0 }, timeMs: { sum: 0, count: 0 } });
    assert.strictEqual(c.budgetHits, 0);
  });

  it('count routes, failures by code, search iterations and time, and regions', async () => {
    const engine = new RoutingEngine(db, options());
    await engine.calculateRoute(request());
    await engine.calculateRoute(request({ start: pt(50, 3.9) })).catch(() => undefined);
    await engine.calculateRoute(request({ end: pt(50, 3.9) })).catch(() => undefined);
    await engine.calculateRoute(request({ start: null as never })).catch(() => undefined);
    const c = engine.getCounters();
    assert.strictEqual(c.routes.calculated, 1);
    assert.strictEqual(c.routes.failed, 3);
    assert.strictEqual(c.failuresByCode.OUTSIDE_COVERAGE, 2);
    assert.strictEqual(c.failuresByCode.INVALID_REQUEST, 1);
    assert.strictEqual(c.failuresByCode.NO_PATH, 0);
    assert.strictEqual(c.failuresOther, 0);
    assert.strictEqual(c.budgetHits, 0);
    assert.ok(c.search.iterations.count >= 1 && c.search.iterations.sum > 0);
    assert.strictEqual(c.search.timeMs.count, c.search.iterations.count);
    assert.ok(c.search.timeMs.sum > 0);
    assert.strictEqual(c.regions.loadsTotal, 1);
    assert.strictEqual(c.regions.loaded.length, 1);
    const [region] = c.regions.loaded;
    assert.strictEqual(region.filename, 'netherlands.sqlite');
    assert.ok(region.nodes > 0 && region.edges > 0 && region.estimatedBytes > 0);
    assert.strictEqual(c.regions.estimatedBytes, region.estimatedBytes);
  });

  it('are a snapshot, and per engine', async () => {
    const engine = new RoutingEngine(db, options());
    const before = engine.getCounters();
    await engine.calculateRoute(request());
    assert.strictEqual(before.routes.calculated, 0, 'an earlier snapshot does not change');
    assert.strictEqual(engine.getCounters().routes.calculated, 1);
    assert.strictEqual(new RoutingEngine(db, options()).getCounters().routes.calculated, 0);
  });

  it('count a failure that is not one of the engine\'s as "other"', async () => {
    const engine = new RoutingEngine(db, options());
    (engine as any).calculateRouteImpl = async () => {
      throw new TypeError('bug');
    };
    await engine.calculateRoute(request()).catch(() => undefined);
    const c = engine.getCounters();
    assert.strictEqual(c.failuresOther, 1);
    assert.strictEqual(c.routes.failed, 1);
  });

  it('hold numbers only', async () => {
    const engine = new RoutingEngine(db, options());
    await engine.calculateRoute(request());
    const json = JSON.stringify(engine.getCounters());
    assert.ok(!/51\.6|3\.8|3\.9/.test(json.replace(/"estimatedBytes":\d+/g, '')));
  });
});

// Keep the hooks the runner imports referenced.
void afterEach;
void beforeEach;
