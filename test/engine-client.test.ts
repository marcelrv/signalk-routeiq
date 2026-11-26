/**
 * The worker host and its typed client: the engine in a worker_thread, one job
 * at a time, abort, hard stop and restart, a versioned protocol, GPX from held
 * results only, bounded POI answers.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  EngineClient,
  EngineWorkerError,
  PROTOCOL_VERSION,
  RouteFailure,
  RouteRequestError,
  RoutingDatabase,
  RoutingEngine,
  type EngineClientOptions,
  type Logger,
  type RoutingRequest,
} from 'routeiq-core';
import { directoryDatabaseOptions, scanRoutingDataDir } from '../dist-tsc/data-dir.js';
import { toEngineOptions } from '../dist-tsc/engine-options.js';
import { DEFAULT_CONFIG } from '../dist-tsc/types.js';

const FIXTURE = path.join('test', 'fixtures', 'zeelandbrug');
const pt = (latitude: number, longitude: number) => ({ latitude, longitude });
const START = pt(51.613, 3.885);
const END = pt(51.609, 3.896);
const VESSEL = { draft: 2.0, beam: 5.0, airDraft: 19.5 };
const FAKE_TIDES = path.resolve('test', 'fixtures', 'fake-tide-provider.mjs');
const PROVIDER = { name: 'test-provider', version: '1.0.0' };

const request = (over: Partial<RoutingRequest> = {}): RoutingRequest => ({
  start: START,
  end: END,
  minCoastDistance: 0,
  ...VESSEL,
  ...over,
});

const tmpDirs: string[] = [];
function tmpData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeiq-client-'));
  fs.copyFileSync(path.join(FIXTURE, 'netherlands.sqlite'), path.join(dir, 'netherlands.sqlite'));
  tmpDirs.push(dir);
  return dir;
}

function clientOptions(dir: string, over: Partial<EngineClientOptions> = {}): EngineClientOptions {
  const { logger: _dbLogger, files: _files, ...database } = directoryDatabaseOptions(dir, { dynamicLoading: true });
  const { logger: _engineLogger, ...engine } = toEngineOptions({ ...DEFAULT_CONFIG });
  return { engine, database: { ...database, files: scanRoutingDataDir(dir) }, ...over };
}

const clients: EngineClient[] = [];
function makeClient(over: Partial<EngineClientOptions> = {}): EngineClient {
  const c = new EngineClient(clientOptions(tmpData(), over));
  clients.push(c);
  return c;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  assert.fail('expected a rejection');
}

/** One client for the tests that only use the host normally (its first route
 *  loads the region, which is most of the time a route takes here). */
let sharedClient: EngineClient | null = null;
function shared(): EngineClient {
  sharedClient ??= makeClient();
  return sharedClient;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('engine client', () => {
  it('starts the host, initialises it and reports its status', async () => {
    const client = shared();
    await client.ready;
    const { status, dataVersion, counters } = await client.status();
    assert.strictEqual(status.counts.listed, 1);
    assert.strictEqual(status.files[0].filename, 'netherlands.sqlite');
    assert.ok(Array.isArray(dataVersion));
    assert.strictEqual(counters.routes.calculated, 0);
    assert.strictEqual(client.restartCount, 0);
  });

  it('a route through the worker deep-equals the in-process result', async () => {
    const dir = tmpData();
    const db = new RoutingDatabase({ ...directoryDatabaseOptions(dir, { dynamicLoading: true }), logger: undefined });
    await db.init();
    await db.loadGraph();
    const engine = new RoutingEngine(db, { ...toEngineOptions({ ...DEFAULT_CONFIG }), logger: undefined });
    const client = makeClient();
    try {
      for (const req of [request(), request({ via: [pt(51.6265, 3.91)] })]) {
        const local = await engine.calculateRoute(req);
        const { result, resultId } = await client.route(req);
        assert.strictEqual(typeof resultId, 'string');
        delete (local as { calculatedAt?: string }).calculatedAt;
        delete (result as { calculatedAt?: string }).calculatedAt;
        assert.deepStrictEqual(result, local);
      }
    } finally {
      await db.close();
    }
  });

  it('failures cross as codes and params and are thrown again as RouteFailure', async () => {
    const client = shared();
    const outside = await rejection(client.route(request({ start: pt(50.0, 3.9) })));
    assert.ok(outside instanceof RouteFailure);
    assert.strictEqual(outside.code, 'OUTSIDE_COVERAGE');
    assert.deepStrictEqual(outside.params, { point: 'start' });
    assert.strictEqual(outside.message, 'No routing nodes found near start point');

    const budget = await rejection(client.route(request(), { budget: { maxIterations: 5 } }));
    assert.ok(budget instanceof RouteFailure);
    assert.strictEqual(budget.code, 'BUDGET_EXCEEDED');
    assert.strictEqual(budget.params.limit, 'maxIterations');

    const invalid = await rejection(client.route({ ...request(), start: { latitude: 'x' } } as unknown as RoutingRequest));
    assert.ok(invalid instanceof RouteRequestError);
    assert.strictEqual(invalid.code, 'INVALID_REQUEST');

    // The host went on after each failure, and counted them.
    const { counters } = await client.status();
    assert.ok(counters.budgetHits >= 1);
    assert.ok(counters.failuresByCode.OUTSIDE_COVERAGE >= 1);
    assert.ok(counters.routes.failed >= 3);
  });

  it('runs one job at a time, in order', async () => {
    const client = shared();
    const order: string[] = [];
    const jobs = [
      client.route(request()).then(() => order.push('a')),
      client.status().then(() => order.push('b')),
      client.route(request({ via: [pt(51.6265, 3.91)] })).then(() => order.push('c')),
    ];
    await Promise.all(jobs);
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
  });

  describe('abort', () => {
    it('a queued job is cancelled at once and never reaches the host', async () => {
      const client = shared();
      const before = (await client.status()).counters;
      const first = client.route(request());
      const second = client.route(request());
      const third = client.status();
      client.abort(second.jobId);
      const e = await rejection(second);
      assert.ok(e instanceof RouteFailure && e.code === 'ABORTED');
      await first;
      await third;
      const { counters } = await client.status();
      assert.strictEqual(counters.routes.calculated, before.routes.calculated + 1, 'the aborted route was never run');
      assert.strictEqual(counters.failuresByCode.ABORTED, before.failuresByCode.ABORTED);
    });

    it('a signal that is already aborted rejects without queueing', async () => {
      const client = shared();
      const ac = new AbortController();
      ac.abort();
      const e = await rejection(client.route(request(), { signal: ac.signal }));
      assert.ok(e instanceof RouteFailure && e.code === 'ABORTED');
    });

    it('a running job is rejected with ABORTED and the host serves the next job', async () => {
      const client = shared();
      await client.ready;
      const ac = new AbortController();
      const running = client.route(request({ via: [pt(51.6265, 3.91)] }), { signal: ac.signal });
      const next = client.status();
      await tick();
      ac.abort();
      const e = await rejection(running);
      assert.ok(e instanceof RouteFailure && e.code === 'ABORTED');
      await next;
      const after = await client.route(request());
      assert.ok(after.result.features.length > 0);
    });
  });

  describe('hard stop and restart', () => {
    it('replaces a hung worker, rejects that job, keeps the queued ones and reports ready again', async () => {
      const client = makeClient({
        engine: { ...clientOptions(tmpData()).engine, budget: { maxWallMs: 50 } },
        hardStopGraceMs: 100,
        testHooks: { hangOnRoute: true },
      });
      let readyCount = 0;
      client.onReady(() => readyCount++);
      await client.ready;
      assert.strictEqual(readyCount, 1);
      const hung = client.route(request());
      const queued = client.status();
      const e = await rejection(hung);
      assert.ok(e instanceof EngineWorkerError);
      assert.strictEqual(e.code, 'WORKER_RESTARTED');
      // The job that was queued behind it ran on the new worker.
      const { status } = await queued;
      assert.strictEqual(status.counts.listed, 1);
      await client.ready;
      assert.strictEqual(client.restartCount, 1);
      assert.strictEqual(readyCount, 2);
    });

    it('an aborted job that does not end within the grace period replaces the worker too', async () => {
      const client = makeClient({ hardStopGraceMs: 100, testHooks: { hangOnRoute: true } });
      await client.ready;
      const hung = client.route(request());
      await tick();
      client.abort(hung.jobId);
      assert.ok((await rejection(hung)) instanceof RouteFailure);
      const { status } = await client.status();
      assert.strictEqual(status.counts.listed, 1);
      assert.strictEqual(client.restartCount, 1);
    });

    it('an unexpected exit rejects the running job and the next call gets a fresh worker', async () => {
      const client = makeClient({ testHooks: { crashOnRoute: true } });
      await client.ready;
      const crashed = await rejection(client.route(request()));
      assert.ok(crashed instanceof EngineWorkerError);
      assert.strictEqual(crashed.code, 'WORKER_EXITED');
      const { status } = await client.status();
      assert.strictEqual(status.counts.listed, 1);
      assert.strictEqual(client.restartCount, 1);
    });
  });

  describe('result ids across worker replacement', () => {
    it('an id from a replaced worker fails with UNKNOWN_RESULT; the new worker issues its own', async () => {
      // The second search job hangs: the first one's result is held by the
      // first worker, which is then replaced.
      const client = makeClient({ hardStopGraceMs: 100, testHooks: { hangOnJobNumber: 2 } });
      const first = await client.route(request());
      assert.ok((await client.gpx(first.resultId, 'x', PROVIDER)).startsWith('<?xml'));
      const hung = await rejection(client.route(request(), { budget: { maxWallMs: 50 } }));
      assert.ok(hung instanceof EngineWorkerError && hung.code === 'WORKER_RESTARTED');
      await client.ready;
      assert.strictEqual(client.restartCount, 1);
      const stale = await rejection(client.gpx(first.resultId, 'x', PROVIDER));
      assert.ok(stale instanceof EngineWorkerError && stale.code === 'UNKNOWN_RESULT');
      // The new worker counts from 1 again, yet its ids differ from the old ones.
      const next = await client.route(request());
      assert.notStrictEqual(next.resultId, first.resultId);
      assert.ok((await client.gpx(next.resultId, 'x', PROVIDER)).startsWith('<?xml'));
    });
  });

  describe('closing during startup', () => {
    it('rejects the pending ready promise with CLOSED', async () => {
      const client = makeClient();
      const ready = client.ready;
      const outcome = rejection(ready);
      await client.close();
      const e = await outcome;
      assert.ok(e instanceof EngineWorkerError && e.code === 'CLOSED');
    });
  });

  describe('departures', () => {
    const scanRequest = { ...request(), departureTime: '2026-08-11T06:00:00.000Z' };

    it('returns the full step list, equal to the in-process scan', async () => {
      const dir = tmpData();
      const db = new RoutingDatabase({ ...directoryDatabaseOptions(dir, { dynamicLoading: true }), logger: undefined });
      await db.init();
      await db.loadGraph();
      const engine = new RoutingEngine(db, { ...toEngineOptions({ ...DEFAULT_CONFIG }), logger: undefined });
      try {
        const local = await engine.scanDepartures(scanRequest, 3, 60);
        const viaClient = await shared().departures(scanRequest, { hours: 3, stepMinutes: 60 });
        assert.strictEqual(viaClient.length, RoutingEngine.departureScanSteps(3, 60));
        assert.deepStrictEqual(viaClient, local);
      } finally {
        await db.close();
      }
    });

    it('is stopped by its budget as a whole, and by an abort', async () => {
      const client = shared();
      const budget = await rejection(client.departures(scanRequest, { hours: 3, stepMinutes: 60 }, { budget: { maxIterations: 50 } }));
      assert.ok(budget instanceof RouteFailure && budget.code === 'BUDGET_EXCEEDED');
      const ac = new AbortController();
      ac.abort();
      const aborted = await rejection(client.departures(scanRequest, {}, { signal: ac.signal }));
      assert.ok(aborted instanceof RouteFailure && aborted.code === 'ABORTED');
    });

    it('a hung scan with a finite wall budget is replaced like a hung route', async () => {
      const client = makeClient({ hardStopGraceMs: 100, testHooks: { hangOnRoute: true } });
      await client.ready;
      const e = await rejection(client.departures(scanRequest, {}, { budget: { maxWallMs: 50 } }));
      assert.ok(e instanceof EngineWorkerError && e.code === 'WORKER_RESTARTED');
      const { status } = await client.status();
      assert.strictEqual(status.counts.listed, 1);
    });
  });

  describe('tide providers loaded in the worker', () => {
    const tideRequest = (): RoutingRequest => ({
      ...request(),
      useTides: true,
      departureTime: '2026-08-11T06:00:00.000Z',
    });

    it('a tides-on route through the client equals the in-process result with the same provider', async () => {
      const options = { lowWaterMs: Date.parse('2026-08-11T03:00:00Z') };
      const provider = ((await import(pathToFileURL(FAKE_TIDES).href)) as { default: (o: unknown) => never }).default(options);
      const dir = tmpData();
      const db = new RoutingDatabase({ ...directoryDatabaseOptions(dir, { dynamicLoading: true }), logger: undefined });
      await db.init();
      await db.loadGraph();
      const engine = new RoutingEngine(db, { ...toEngineOptions({ ...DEFAULT_CONFIG }), logger: undefined });
      engine.setTidesClient(provider);
      const client = makeClient({ providers: { tideHeights: { module: FAKE_TIDES, options } } });
      try {
        const local = await engine.calculateRoute(tideRequest());
        const { result } = await client.route(tideRequest());
        assert.strictEqual(local.tide?.source, 'heights', 'the provider was consulted in-process');
        assert.strictEqual(result.tide?.source, 'heights', 'and in the host');
        delete (local as { calculatedAt?: string }).calculatedAt;
        delete (result as { calculatedAt?: string }).calculatedAt;
        assert.deepStrictEqual(result, local);
        // Without the provider the same request has no tide data.
        const bare = await makeClient().route(tideRequest());
        assert.notStrictEqual(bare.result.tide?.source, 'heights');
      } finally {
        await db.close();
      }
    });

    it('refuses a module that is not an absolute path, with a neutral INIT_FAILED', async () => {
      const client = makeClient({ providers: { tideHeights: { module: './relative.mjs' } } });
      const e = await rejection(client.ready);
      assert.ok(e instanceof EngineWorkerError && e.code === 'INIT_FAILED');
      assert.ok(!e.message.includes('relative'), 'no path in the message');
    });
  });

  describe('protocol', () => {
    it('refuses a host init with another protocol version', async () => {
      const client = makeClient({ protocolVersion: PROTOCOL_VERSION + 1 });
      const e = await rejection(client.ready);
      assert.ok(e instanceof EngineWorkerError);
      assert.strictEqual(e.code, 'PROTOCOL_MISMATCH');
      const call = await rejection(client.status());
      assert.ok(call instanceof EngineWorkerError && call.code === 'PROTOCOL_MISMATCH');
    });

    it('fails init, with a neutral message, when the data cannot be opened', async () => {
      const dir = tmpData();
      const options = clientOptions(dir);
      options.database.files = [];
      const client = new EngineClient(options);
      clients.push(client);
      const e = await rejection(client.ready);
      assert.ok(e instanceof EngineWorkerError && e.code === 'INIT_FAILED');
      assert.ok(!e.message.includes(dir), 'no path in the message');
    });

    it('closing rejects what is queued and refuses new calls', async () => {
      const client = makeClient();
      await client.ready;
      const a = client.route(request());
      a.catch(() => undefined);
      const b = client.status();
      const bFailed = rejection(b);
      await client.close();
      assert.ok((await bFailed) instanceof EngineWorkerError);
      const e = await rejection(client.status());
      assert.ok(e instanceof EngineWorkerError && e.code === 'CLOSED');
    });
  });

  describe('GPX from held results only', () => {
    it('builds GPX from a result id and rejects any other', async () => {
      const client = shared();
      const { resultId } = await client.route(request());
      const gpx = await client.gpx(resultId, 'Test <route> & "more"', PROVIDER);
      assert.ok(gpx.startsWith('<?xml'));
      assert.ok(gpx.includes('Test &lt;route&gt; &amp; &quot;more&quot;'));
      const e = await rejection(client.gpx('nonexistent:1', 'x', PROVIDER));
      assert.ok(e instanceof EngineWorkerError);
      assert.strictEqual(e.code, 'UNKNOWN_RESULT');
    });

    it('keeps only the last N results', async () => {
      const client = makeClient({ retainedResults: 2 });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await client.route(request())).resultId);
      const gone = await rejection(client.gpx(ids[0], 'x', PROVIDER));
      assert.ok(gone instanceof EngineWorkerError && gone.code === 'UNKNOWN_RESULT');
      assert.ok((await client.gpx(ids[1], 'x', PROVIDER)).startsWith('<?xml'));
      assert.ok((await client.gpx(ids[2], 'x', PROVIDER)).startsWith('<?xml'));
    });
  });

  describe('logging', () => {
    it('forwards the host and database log lines to the client logger', async () => {
      const lines: Array<{ level: string; message: string }> = [];
      const at = (level: string) => (message: string) => void lines.push({ level, message });
      const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
      const client = makeClient({ logger });
      await client.route(request());
      await client.status();
      assert.ok(
        lines.some((l) => l.message.startsWith('[routeiq]') || l.message.startsWith('[db-worker]')),
        JSON.stringify(lines),
      );
    });
  });

  describe('bounded queries', () => {
    it('POI box, search and nearest answers honour the configured caps', async () => {
      const dir = tmpData();
      const base = clientOptions(dir);
      const client = new EngineClient({
        ...base,
        database: { ...base.database, limits: { maxBBoxResults: 1, maxSearchResults: 1, maxNearestRadiusM: 5, maxSearchQueryLength: 5 } },
      });
      clients.push(client);
      await client.route(request()); // loads the region the POIs are read from
      const box = { minLat: 51.5, minLon: 3.8, maxLat: 51.7, maxLon: 4.0 };
      const all = await client.pois(box, 10_000);
      assert.strictEqual(all.length, 1, 'capped at the configured maximum');
      // The query is cut to 5 characters and control characters are removed.
      const found = await client.search('Zeel\u0000\u001fandbrug that is much too long');
      assert.ok(found.length <= 1);
      assert.ok(found.every((p) => (p.name ?? '').toLowerCase().includes('zeel')));
      assert.deepStrictEqual(await client.search('\u0000\u0001'), []);
      // The nearest POI is searched within 5 m at most, whatever radius is asked.
      const SPAN = { lat: 51.62829183121914, lon: 3.9130527614890074 };
      assert.strictEqual(await client.nearestPoi(SPAN.lat + 0.001, SPAN.lon, 50_000), null);
      // A negative or fractional count is not a slice from the end.
      assert.deepStrictEqual(await client.search('a', -1), []);
      assert.deepStrictEqual(await client.pois(box, -5), (await client.pois(box, 1)));
      assert.strictEqual((await client.pois(box, 0.4)).length, 1);
      const near = await client.nearestPoi(SPAN.lat, SPAN.lon, 50_000);
      assert.ok(near && near.id === 12447782162321);
    });

    it('the default POI cap is 500, as before', async () => {
      const client = shared();
      await client.route(request());
      const box = { minLat: 51.0, minLon: 3.0, maxLat: 52.5, maxLon: 5.0 };
      const pois = await client.pois(box, 1_000_000);
      assert.ok(pois.length >= 1 && pois.length <= 500);
      assert.ok((await client.coverage()).length === 1);
    });
  });
});
