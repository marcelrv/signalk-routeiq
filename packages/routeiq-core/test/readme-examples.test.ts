// The code examples of README.md, compiled and run against the Zeelandbrug
// fixture. Each `// region:<name>` block below appears verbatim in a
// ```ts example:<name> block of the README (the import specifier excepted), and
// the last test fails when the two differ, so the README cannot drift from the
// API.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// region:imports
import {
  DEFAULT_ENGINE_OPTIONS,
  DEFAULT_REQUEST_LIMITS,
  EngineClient,
  RouteFailure,
  RoutingDatabase,
  RoutingEngine,
  format,
  validateRouteRequest,
  type EngineClientOptions,
  type Logger,
  type RouteResult,
  type RoutingRequest,
} from '../dist/index.js';
// endregion:imports

// region:quick-start
async function quickStart(dataFile: string): Promise<RouteResult> {
  const database = new RoutingDatabase({
    files: [{ path: dataFile, enabled: true }],
    policy: 'pinned',
    readOnly: true,
  });
  await database.init();
  await database.loadGraph(); // `pinned`: loads every listed region
  try {
    const engine = new RoutingEngine(database, DEFAULT_ENGINE_OPTIONS);
    const controller = new AbortController();
    return await engine.calculateRoute(
      {
        start: { latitude: 51.613, longitude: 3.885 },
        end: { latitude: 51.609, longitude: 3.896 },
        draft: 1.6,
        beam: 4.2,
        airDraft: 12,
        speedKnots: 6,
      },
      { budget: { maxWallMs: 30_000 }, signal: controller.signal },
    );
  } finally {
    await database.close();
  }
}
// endregion:quick-start

// region:worker-host
async function inWorker(dataFile: string): Promise<string> {
  const client = new EngineClient({
    engine: { ...DEFAULT_ENGINE_OPTIONS, requireVesselInRequest: true },
    database: {
      files: [{ path: dataFile, enabled: true }],
      policy: 'pinned',
      readOnly: true,
    },
    hardStopGraceMs: 5000,
  });
  try {
    await client.ready;
    const job = client.route(
      {
        start: { latitude: 51.613, longitude: 3.885 },
        end: { latitude: 51.609, longitude: 3.896 },
        draft: 1.6,
        beam: 4.2,
        airDraft: 12,
        speedKnots: 6,
      },
      { budget: { maxWallMs: 30_000 } },
    );
    // client.abort(job.jobId) would cancel it; so would a signal in the options.
    const { resultId, result } = await job;
    if (result.features.length === 0) throw new Error('empty route');
    return await client.gpx(resultId, 'Example route', {
      name: 'my-app',
      version: '1.0.0',
    });
  } finally {
    await client.close();
  }
}
// endregion:worker-host

// region:providers
function withTideProviders(
  base: EngineClientOptions,
  tideModule: string,
): EngineClientOptions {
  return {
    ...base,
    providers: {
      // An absolute path or a file: URL; the module's default export is
      // called with `options` and returns the provider.
      tideHeights: { module: tideModule, options: { region: 'north-sea' } },
    },
  };
}
// endregion:providers

// region:validation
function parseBody(body: unknown): RoutingRequest {
  const checked = validateRouteRequest(body, {
    ...DEFAULT_REQUEST_LIMITS,
    strict: true,
    maxVias: 10,
    maxStraightLineNm: 500,
  });
  if (!checked.ok) {
    // checked.error: { code, field, message, params }
    throw new Error(`${checked.error.field}: ${checked.error.message}`);
  }
  return checked.request;
}
// endregion:validation

// region:errors
async function describeOutcome(
  engine: RoutingEngine,
  request: RoutingRequest,
): Promise<string> {
  try {
    const route = await engine.calculateRoute(request);
    // Warnings carry a stable code and the values behind the text.
    return (route.warnings ?? []).map((w) => `${w.code} ${w.message}`).join('; ');
  } catch (error) {
    if (error instanceof RouteFailure) {
      // error.code is one of NO_PATH, OUTSIDE_COVERAGE, BUDGET_EXCEEDED, ...
      // error.params and error.message are safe to show.
      return `${error.code}: ${error.message}`;
    }
    throw error;
  }
}
// endregion:errors

// region:logging
function onlyProblems(lines: string[]): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}
// endregion:logging

const here = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(here, '..', '..', '..', 'test', 'fixtures', 'zeelandbrug', 'netherlands.sqlite');
const START = { latitude: 51.613, longitude: 3.885 };
const END = { latitude: 51.609, longitude: 3.896 };
const VESSEL = { draft: 1.6, beam: 4.2, airDraft: 12, speedKnots: 6 };

describe('README examples', () => {
  it('quick start routes in-process, read-only, with a budget', async () => {
    const route = await quickStart(DATA_FILE);
    assert.ok(route.features.length > 0);
    assert.strictEqual(route.inputs?.draft, 1.6);
    assert.strictEqual(route.inputs?.speedKnots, 6);
    assert.ok(route.inputs?.data?.some((d) => d.filename === 'netherlands.sqlite'));
  });

  it('the worker host routes and exports GPX by result id', async () => {
    const gpx = await inWorker(DATA_FILE);
    assert.match(gpx, /<gpx/);
  });

  it('the provider options type-check and keep the base options', () => {
    const base: EngineClientOptions = {
      engine: DEFAULT_ENGINE_OPTIONS,
      database: { files: [{ path: DATA_FILE, enabled: true }] },
    };
    const options = withTideProviders(base, '/opt/tides.mjs');
    assert.strictEqual(options.providers?.tideHeights?.module, '/opt/tides.mjs');
    assert.strictEqual(options.database, base.database);
  });

  it('the validator accepts a clean body and refuses a bad one', () => {
    const request = parseBody({ start: START, end: END, ...VESSEL });
    assert.deepStrictEqual(request.start, START);
    assert.throws(() => parseBody({ start: { latitude: 91, longitude: 0 }, end: END, ...VESSEL }), /start/);
  });

  it('a strict engine refuses an incomplete request with a coded failure', async () => {
    const lines: string[] = [];
    const database = new RoutingDatabase({
      files: [{ path: DATA_FILE, enabled: true }],
      policy: 'pinned',
      readOnly: true,
      logger: onlyProblems(lines),
    });
    await database.init();
    await database.loadGraph();
    try {
      const engine = new RoutingEngine(database, { ...DEFAULT_ENGINE_OPTIONS, requireVesselInRequest: true });
      const refused = await describeOutcome(engine, { start: START, end: END });
      assert.match(refused, /^VESSEL_INCOMPLETE: /);
      const accepted = await describeOutcome(engine, { start: START, end: END, ...VESSEL });
      assert.strictEqual(typeof accepted, 'string');
      assert.strictEqual(engine.getCounters().routes.calculated, 1);
    } finally {
      await database.close();
    }
  });

  it('the logger example is a Logger and the catalogue renders in Dutch', () => {
    const lines: string[] = [];
    const logger = onlyProblems(lines);
    logger.warn('w');
    logger.info('i');
    assert.deepStrictEqual(lines, ['w']);
    const missing = { missing: ['draft'] };
    assert.notStrictEqual(format('VESSEL_INCOMPLETE', missing, 'nl'), format('VESSEL_INCOMPLETE', missing, 'en'));
  });

  it('every example block of the README is a region of this file', () => {
    const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
    const source = readFileSync(join(here, '..', 'test', 'readme-examples.test.ts'), 'utf8');
    const blocks = [...readme.matchAll(/```ts example:([\w-]+)\n([\s\S]*?)```/g)];
    const names = new Set<string>();
    for (const [, name, body] of blocks) {
      const region = new RegExp(`// region:${name}\\n([\\s\\S]*?)// endregion:${name}`).exec(source);
      assert.ok(region, `region ${name} exists in the test`);
      const normalise = (s: string): string => s.replaceAll("'../dist/index.js'", "'routeiq-core'").trim();
      assert.strictEqual(normalise(body), normalise(region[1]), `README block ${name} equals the tested code`);
      names.add(name);
    }
    const regions = [...source.matchAll(/\/\/ region:([\w-]+)/g)].map((m) => m[1]);
    assert.ok(regions.length >= 7);
    for (const r of regions) assert.ok(names.has(r), `region ${r} is shown in the README`);
  });
});
