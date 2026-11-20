/**
 * Golden-result tests for the routing engine.
 *
 * A fixed set of engine calls (route calculation, departure scan, request
 * validation) is recorded in full under test/golden/*.json, and each run must
 * reproduce those files exactly. They are a refactor-safety net: code can move
 * (into another package, into a worker thread, behind a time budget) and any
 * change in the results shows up as a failure naming the file.
 *
 * Updating the goldens
 *   UPDATE_GOLDEN=1 npm test        (or run just this test file with the env set)
 * writes every golden file and the run passes. Without it a missing golden
 * file FAILS the test. Review the resulting diff before committing it.
 *
 * Other switch
 *   GOLDEN_REVERSE=1 runs the cases in reverse order, to show that no case
 *   depends on another having run first.
 *
 * Determinism
 *   - Vessel dimensions are passed twice, to the engine (setVesselDimensions)
 *     and in each request, and the config is written out in full (GOLDEN_CONFIG)
 *     so that a changed default does not silently change an input.
 *   - Every case that has a time uses a fixed departureTime.
 *   - Fixture databases are copied to a temp directory (the engine creates a
 *     user-edits overlay next to the database it opens); the committed fixture
 *     is never touched.
 *   - The only field removed before comparing is `calculatedAt` on a
 *     RouteResult: finalizeRoute sets it from the wall clock (new Date()), and
 *     nothing else in a result is wall-clock or elapsed-time derived (with no
 *     tides the departure/arrival times are absent; with tides they come from
 *     the request's departureTime). Numbers are never rounded.
 *   - Files are written with sorted keys, 2-space indent and a trailing newline.
 *     The comparison is deepStrictEqual on the parsed JSON, so values that JSON
 *     cannot hold (undefined, NaN) read the same on both sides.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { validateRequestConstraints } from '../dist/api.js';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import type { CurrentsClient, TidesClient } from '../dist/tides.js';
import { DEFAULT_CONFIG } from '../dist/types.js';
import type { PluginConfig, RoutingRequest } from '../dist/types.js';
import { POIS_DDL, upgradeToPoiModel } from './poi-model-fixture.js';

const UPDATE = process.env.UPDATE_GOLDEN === '1';
const REVERSE = process.env.GOLDEN_REVERSE === '1';
const GOLDEN_DIR = path.join('test', 'golden');
const ZEELANDBRUG_FIXTURE = path.join('test', 'fixtures', 'zeelandbrug');

/** Every value a case depends on, spelled out. */
const GOLDEN_CONFIG: PluginConfig = {
  ...DEFAULT_CONFIG,
  routingDataDir: '',
  safetyMarginDraft: 0.3,
  safetyMarginAirDraft: 1.5,
  safetyMarginBeam: 2.0,
  routingBBoxMargin: 1.0,
  routingBBoxMaxExtent: 10.0,
  maxPenaltyDetourRatio: 3.0,
  coverageGapMeters: 1500,
  lineOfSightSearchRadius: 0,
  averageSpeedKnots: 5.0,
  lockWaitMinutes: 60,
  bridgeWaitMinutes: 30,
  waypointTolerance: 30,
  considerTides: false,
  dynamicLoading: true,
  eagerLoadAtPosition: true,
  loadRadiusNm: 0,
  maxLoadedRegions: 6,
  maxLoadedRegionEdges: 1_000_000,
};

const DEPARTURE = '2026-08-11T06:00:00.000Z';
const HOUR_MS = 3_600_000;

interface Dims {
  draft: number;
  beam: number;
  airDraft: number;
}
const VESSEL: Dims = { draft: 2.0, beam: 5.0, airDraft: 19.5 };

const pt = (latitude: number, longitude: number) => ({ latitude, longitude });

// ---------------------------------------------------------------------------
// Golden file plumbing
// ---------------------------------------------------------------------------

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

function serialise(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

/** Drop the one wall-clock field of a RouteResult (see the header comment). */
function normaliseRoute<T extends object>(route: T): object {
  const copy = JSON.parse(JSON.stringify(route)) as Record<string, unknown>;
  delete copy.calculatedAt;
  return copy;
}

function checkGolden(name: string, actual: unknown): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const text = serialise(actual);
  if (UPDATE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.ok(
    fs.existsSync(file),
    `golden file ${file} is missing; run with UPDATE_GOLDEN=1 to create it`,
  );
  assert.deepStrictEqual(
    JSON.parse(text),
    JSON.parse(fs.readFileSync(file, 'utf8')),
    `result differs from golden file ${file}; if the change is intended, rerun with UPDATE_GOLDEN=1 and review the diff`,
  );
}

/** The thrown error as a golden: class name and message. */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: normaliseRoute((await fn()) as object) };
  } catch (e) {
    return {
      error: {
        name: (e as Error).constructor.name,
        message: (e as Error).message,
      },
    };
  }
}

interface Case {
  name: string;
  run: () => Promise<unknown>;
}

function register(cases: Case[]): void {
  for (const c of REVERSE ? [...cases].reverse() : cases) {
    it(c.name, async () => {
      checkGolden(c.name, await c.run());
    });
  }
}

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `routeiq-golden-${tag}-`));
}

/** A fresh engine per case, so no case sees another's state. */
function newEngine(
  db: RoutingDatabase,
  config: PluginConfig = GOLDEN_CONFIG,
  dims: Dims = VESSEL,
): RoutingEngine {
  const engine = new RoutingEngine(db, { ...config });
  engine.setVesselDimensions({ ...dims });
  return engine;
}

async function openDb(dir: string): Promise<RoutingDatabase> {
  const db = new RoutingDatabase(dir);
  await db.init();
  await db.loadGraph();
  return db;
}

// ---------------------------------------------------------------------------
// Zeelandbrug fixture (real generated database)
// ---------------------------------------------------------------------------

describe('golden: zeelandbrug fixture', () => {
  let dir: string;
  let db: RoutingDatabase;

  before(async () => {
    dir = tmpDir('zb');
    fs.copyFileSync(
      path.join(ZEELANDBRUG_FIXTURE, 'netherlands.sqlite'),
      path.join(dir, 'netherlands.sqlite'),
    );
    db = await openDb(dir);
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const START = pt(51.613, 3.885);
  const END = pt(51.609, 3.896);
  const BRIDGE_VIA = pt(51.6265, 3.91);

  const route = (req: Partial<RoutingRequest>, dims: Dims = VESSEL) => () =>
    outcome(() =>
      newEngine(db).calculateRoute({
        start: START,
        end: END,
        minCoastDistance: 0,
        ...dims,
        ...req,
      }),
    );

  register([
    { name: 'zeelandbrug-opening-bridge', run: route({}) },
    {
      name: 'zeelandbrug-short-route',
      run: route({ end: pt(51.6135, 3.8875) }),
    },
    {
      name: 'zeelandbrug-one-via',
      run: route({ via: [BRIDGE_VIA] }),
    },
    {
      name: 'zeelandbrug-two-vias',
      run: route({ via: [pt(51.6185, 3.895), BRIDGE_VIA] }),
    },
    {
      name: 'zeelandbrug-manual-leg',
      run: route({ via: [{ ...BRIDGE_VIA, mode: 'manual' }] }),
    },
    {
      name: 'zeelandbrug-manual-end-leg',
      run: route({ endMode: 'manual' }),
    },
    // Same crossing area, two air drafts: the low one routes around the fixed
    // span (11 m charted), the high one goes through the crossing.
    {
      name: 'zeelandbrug-air-draft-low',
      run: route(
        { start: pt(51.62, 3.9), end: pt(51.63, 3.92) },
        { ...VESSEL, airDraft: 5.0 },
      ),
    },
    {
      name: 'zeelandbrug-air-draft-high',
      run: route(
        { start: pt(51.62, 3.9), end: pt(51.63, 3.92) },
        { ...VESSEL, airDraft: 25.0 },
      ),
    },
    {
      name: 'zeelandbrug-deep-draft',
      run: route({}, { ...VESSEL, draft: 8.0 }),
    },
    {
      name: 'zeelandbrug-min-coast-distance',
      run: route({ minCoastDistance: 0.5 }),
    },
    { name: 'zeelandbrug-lang-nl', run: route({ lang: 'nl' }) },
    { name: 'zeelandbrug-lang-en', run: route({ lang: 'en' }) },
    { name: 'zeelandbrug-describe-false', run: route({ describe: false }) },
    {
      name: 'zeelandbrug-error-start-far-from-graph',
      run: route({ start: pt(50.0, 3.9) }),
    },
  ]);
});

// ---------------------------------------------------------------------------
// POI-model fixture: locks, bridges, chambers, spans
// ---------------------------------------------------------------------------

describe('golden: POI-model fixture', () => {
  const LAT = 52.0;
  const lonOf = (node: number) => 5.0 + 0.01 * (node - 1);
  let dir: string;
  let db: RoutingDatabase;

  type Poi = [
    id: number,
    type: number,
    parent: number | null,
    name: string,
    properties: object | null,
    info: object | null,
    lat: number,
    lon: number,
  ];
  const POIS: Poi[] = [
    [100, 1, null, 'Test Lock', { typical_wait_minutes: 20 }, { kind: 'lock' }, LAT, lonOf(2.5)],
    [101, 5, 100, 'Test Lock chamber', null, null, LAT, lonOf(2)],
    [401, 6, 100, 'Road bridge', { subtype: 'opening', typical_wait_minutes: 3 }, { kind: 'bascule' }, LAT, lonOf(3)],
    [200, 1, null, 'Lock B', { typical_wait_minutes: 20 }, null, LAT, lonOf(4)],
    [201, 5, 200, 'Lock B chamber', { typical_wait_minutes: 0 }, null, LAT, lonOf(4)],
    [300, 2, null, 'Test Bridge', null, { kind: 'bridge' }, LAT, lonOf(1)],
    [301, 6, 300, 'Test Bridge span 1', { subtype: 'fixed' }, { height: 3.2, height_source: 'chart' }, LAT + 0.0002, lonOf(1)],
    [302, 6, 300, 'Test Bridge span 2', { subtype: 'opening', closed_height: 1.5 }, null, LAT + 0.0004, lonOf(1) + 0.0001],
    [1, 0, null, 'Test Harbour', {}, { refs: [{ scheme: 'osm', id: 'node/1' }] }, LAT + 0.01, lonOf(1)],
  ];
  const EDGE_POIS: Array<[number, number, number]> = [
    [2, 3, 101],
    [3, 4, 401],
    [4, 5, 201],
    [1, 2, 301],
  ];

  before(async () => {
    dir = tmpDir('poi');
    const raw = new DatabaseSync(path.join(dir, 'poi.sqlite'), { open: true });
    const run = (sql: string, params: unknown[] = []) =>
      raw.prepare(sql).run(...(params as SQLInputValue[]));
    run(`CREATE TABLE metadata (id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
         description TEXT, last_update_date TEXT NOT NULL, bounding_box TEXT)`);
    run(
      `INSERT INTO metadata (country, name, description, last_update_date, bounding_box) VALUES ('GLD', 'Golden POI fixture', 'fixture', '2026-01-01T00:00:00Z', ?)`,
      [JSON.stringify({ min_lat: 51.9, min_lon: 4.9, max_lat: 52.1, max_lon: 5.2 })],
    );
    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      run('INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)', [n, LAT, lonOf(n)]);
    }
    run(`CREATE TABLE edges (source INTEGER, target INTEGER, distance REAL, min_depth REAL, max_air_draft REAL, min_width REAL,
         cost_factor REAL DEFAULT 1.0, distance_to_land REAL, edge_type_id INTEGER DEFAULT 1, traffic_mode INTEGER DEFAULT 0)`);
    for (const [a, b] of [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]) {
      for (const [s, t] of [[a, b], [b, a]]) {
        run('INSERT INTO edges VALUES (?, ?, 690, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0)', [s, t]);
      }
    }
    run(POIS_DDL);
    for (const [id, type, parent, name, props, info, lat, lon] of POIS) {
      run(
        'INSERT INTO pois (id, type_id, parent_id, name, properties, info, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, type, parent, name, props && JSON.stringify(props), info && JSON.stringify(info), lat, lon],
      );
    }
    upgradeToPoiModel(raw);
    for (const [a, b, poi] of EDGE_POIS) {
      run('INSERT INTO edge_pois (source, target, poi_id) VALUES (?, ?, ?)', [Math.min(a, b), Math.max(a, b), poi]);
    }
    raw.close();
    db = await openDb(dir);
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const DIMS: Dims = { draft: 1.0, beam: 3.0, airDraft: 5.0 };
  const route = (req: Partial<RoutingRequest>, dims: Dims = DIMS) => () =>
    outcome(() =>
      newEngine(db, GOLDEN_CONFIG, DIMS).calculateRoute({
        start: pt(LAT, lonOf(1)),
        end: pt(LAT, lonOf(6)),
        minCoastDistance: 0,
        ...dims,
        ...req,
      }),
    );

  register([
    { name: 'poi-model-lock-and-bridge-default-waits', run: route({}) },
    {
      name: 'poi-model-wait-overrides',
      run: route({ lockWaitMinutes: 5, bridgeWaitMinutes: 2 }),
    },
    {
      name: 'poi-model-zero-waits',
      run: route({ lockWaitMinutes: 0, bridgeWaitMinutes: 0 }),
    },
    {
      name: 'poi-model-reverse-direction',
      run: route({ start: pt(LAT, lonOf(6)), end: pt(LAT, lonOf(1)) }),
    },
    {
      name: 'poi-model-via-between-structures',
      run: route({ via: [pt(LAT, lonOf(3.5))], lang: 'nl' }),
    },
    {
      name: 'poi-model-low-air-draft',
      run: route({}, { ...DIMS, airDraft: 2.0 }),
    },
  ]);
});

// ---------------------------------------------------------------------------
// Route description: water bodies, names, notices, leg warnings
// ---------------------------------------------------------------------------

describe('golden: route description fixture', () => {
  // N0 -- N1 -- N2 -- N3 -- N4 -- N5 on lat 52, 0.01 deg apart. Sequences:
  // 0..2 and 2..3 are one water body (Kanaal), 3..5 another (Meer). The edge
  // N4-N5 is shallow and narrow, so it carries leg warnings for the vessel.
  const LAT = 52;
  const LONS = [5.0, 5.01, 5.02, 5.03, 5.04, 5.05];
  const nodeId = (lon: number) =>
    Math.round((LAT + 90) * 100000) * 36_000_000 +
    Math.round((lon + 180) * 100000);
  const NODE = LONS.map(nodeId);
  const DIMS: Dims = { draft: 2.0, beam: 3.0, airDraft: 10.0 };
  let dir: string;
  let db: RoutingDatabase;

  before(async () => {
    dir = tmpDir('desc');
    const raw = new DatabaseSync(path.join(dir, 'desc.sqlite'), { open: true });
    const run = (sql: string, params: unknown[] = []) =>
      raw.prepare(sql).run(...(params as SQLInputValue[]));
    run(`CREATE TABLE metadata (id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL, name TEXT NOT NULL,
         description TEXT, last_update_date TEXT NOT NULL, bounding_box TEXT)`);
    run(
      `INSERT INTO metadata (country, name, description, last_update_date, bounding_box) VALUES ('GLW', 'Golden description fixture', 'fixture', '2026-01-01T00:00:00Z', ?)`,
      [JSON.stringify({ min_lat: 51.9, min_lon: 4.9, max_lat: 52.1, max_lon: 5.2 })],
    );
    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    for (const lon of LONS) {
      run('INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)', [nodeId(lon), LAT, lon]);
    }
    run(`CREATE TABLE edges (source INTEGER, target INTEGER, distance REAL, min_depth REAL, max_air_draft REAL, min_width REAL,
         cost_factor REAL DEFAULT 1.0, distance_to_land REAL, edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
         edge_kind_id INTEGER DEFAULT 0, edge_sequence_id INTEGER, depth_quality_id INTEGER DEFAULT 0)`);
    const seqOf = (i: number) => (i < 2 ? 11 : i < 3 ? 12 : 21);
    for (let i = 0; i + 1 < LONS.length; i++) {
      const shallow = i === 4;
      for (const [f, t] of [[i, i + 1], [i + 1, i]]) {
        run('INSERT INTO edges VALUES (?, ?, 690, ?, 40.0, ?, 1.0, 500, 0, 0, 0, ?, ?)', [
          NODE[f], NODE[t], shallow ? 1.5 : 12.0, shallow ? 3.0 : 50.0, seqOf(i), i < 3 ? 4 : 0,
        ]);
      }
    }
    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    run('CREATE TABLE origin_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL)');
    for (const [id, d] of [[0, 'other'], [1, 'pipeline'], [2, 'imported']] as Array<[number, string]>) {
      run('INSERT INTO origin_enum VALUES (?, ?)', [id, d]);
    }
    run('CREATE TABLE depth_quality_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL, rank INTEGER NOT NULL)');
    for (const [id, d, r] of [[0, 'unknown', 0], [1, 'community', 10], [4, 'charted', 40]] as Array<[number, string, number]>) {
      run('INSERT INTO depth_quality_enum VALUES (?, ?, ?)', [id, d, r]);
    }
    run('CREATE TABLE water_body_kind_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL)');
    for (const [id, d] of [[0, 'other'], [1, 'canal'], [3, 'lake']] as Array<[number, string]>) {
      run('INSERT INTO water_body_kind_enum VALUES (?, ?)', [id, d]);
    }
    run('CREATE TABLE water_bodies (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind_id INTEGER, parent_id INTEGER, country TEXT)');
    run("INSERT INTO water_bodies (id, name, kind_id) VALUES (100, 'Kanaal', 1), (200, 'Meer', 3)");
    run(`CREATE TABLE water_body_names (water_body_id INTEGER NOT NULL, lang TEXT NOT NULL, name TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'official', PRIMARY KEY (water_body_id, lang, name))`);
    run(`INSERT INTO water_body_names VALUES (100, 'de', 'Kanal Alt', 'alternative'), (100, 'de', 'Kanal', 'official'),
         (100, 'nl', 'Kanaal NL', 'official'), (200, 'en', 'Lake', 'official')`);
    run(`CREATE TABLE edge_sequences (id INTEGER PRIMARY KEY, node_a INTEGER NOT NULL, node_b INTEGER NOT NULL, water_body_id INTEGER,
         origin_id INTEGER NOT NULL DEFAULT 0, distance REAL, min_depth REAL, depth_quality_id INTEGER, max_air_draft REAL, min_width REAL,
         cost_ab REAL, cost_ba REAL, crosses_obstacle INTEGER DEFAULT 0)`);
    run('INSERT INTO edge_sequences (id, node_a, node_b, water_body_id, origin_id, depth_quality_id) VALUES (11, ?, ?, 100, 1, 4)', [NODE[0], NODE[2]]);
    run('INSERT INTO edge_sequences (id, node_a, node_b, water_body_id, origin_id, depth_quality_id) VALUES (12, ?, ?, 100, 1, 4)', [NODE[2], NODE[3]]);
    run('INSERT INTO edge_sequences (id, node_a, node_b, water_body_id, origin_id, depth_quality_id) VALUES (21, ?, ?, 200, 2, 0)', [NODE[3], NODE[5]]);
    run(`CREATE TABLE notices (id INTEGER PRIMARY KEY, source_class TEXT NOT NULL, severity INTEGER NOT NULL, name TEXT, text TEXT)`);
    run(`CREATE TABLE edge_notices (source INTEGER, target INTEGER, notice_id INTEGER, severity INTEGER NOT NULL, reason TEXT, PRIMARY KEY (source, target, notice_id))`);
    for (const [id, cls, sev, text, a, b] of [
      [1, 'NAVLINE', 1, 'Shallow, depth unknown', 4, 5],
      [2, 'RESARE', 2, 'Chart restricted area', 3, 4],
    ] as Array<[number, string, number, string, number, number]>) {
      run('INSERT INTO notices (id, source_class, severity, name, text) VALUES (?, ?, ?, ?, ?)', [id, cls, sev, 'Line', text]);
      for (const [f, t] of [[a, b], [b, a]]) {
        run('INSERT INTO edge_notices VALUES (?, ?, ?, ?, NULL)', [NODE[f], NODE[t], id, sev]);
      }
    }
    upgradeToPoiModel(raw);
    raw.close();
    db = await openDb(dir);
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const route = (req: Partial<RoutingRequest>) => () =>
    outcome(() =>
      newEngine(db, GOLDEN_CONFIG, DIMS).calculateRoute({
        start: pt(LAT, LONS[0]),
        end: pt(LAT, LONS[5]),
        minCoastDistance: 0,
        ...DIMS,
        ...req,
      }),
    );

  register([
    { name: 'description-no-lang', run: route({}) },
    { name: 'description-lang-nl', run: route({ lang: 'nl' }) },
    { name: 'description-lang-de-ch', run: route({ lang: 'de-CH' }) },
    { name: 'description-lang-en', run: route({ lang: 'en' }) },
    { name: 'description-describe-false', run: route({ lang: 'nl', describe: false }) },
    {
      name: 'description-reverse-direction',
      run: route({ start: pt(LAT, LONS[5]), end: pt(LAT, LONS[0]), lang: 'nl' }),
    },
  ]);
});

// ---------------------------------------------------------------------------
// Tides and departure scan on a small synthetic graph
// ---------------------------------------------------------------------------

describe('golden: tides and departure scan', () => {
  // A <-> B is a short channel charted 1.5 m deep (required 2.3 m: draft 2.0 +
  // margin 0.3), A -> C -> B a deep detour, so the route depends on the tide.
  const A = { lat: 52.0, lon: 5.0 };
  const B = { lat: 52.0, lon: 5.035 };
  const C = { lat: 51.984, lon: 4.984 };
  const TIDE_PERIOD_MS = 12.42 * HOUR_MS;
  const LOW_WATER_MS = Date.parse('2026-08-11T00:00:00Z');
  const STATIONS = [
    { id: 'north', lat: 52.08, lon: 5.0, offset: 0 },
    { id: 'south', lat: 51.92, lon: 5.0, offset: 12.5 },
    { id: 'east', lat: 52.0, lon: 5.12, offset: -3.25 },
  ];
  const TIDE_DIMS: Dims = { draft: 2.0, beam: 4.0, airDraft: 5.0 };
  let dir: string;
  let db: RoutingDatabase;

  /** Sinusoidal tide, 10-minute steps, low water at LOW_WATER_MS. */
  function levels(startMs: number, endMs: number, offset: number) {
    const out: Array<{ time: string; level: number }> = [];
    for (let t = startMs; t <= endMs; t += 600_000) {
      const phase = ((t - LOW_WATER_MS) / TIDE_PERIOD_MS) * 2 * Math.PI;
      out.push({
        time: new Date(t).toISOString(),
        level: offset + 0.75 * (1 - Math.cos(phase)),
      });
    }
    return out;
  }
  const tidesClient = (): TidesClient =>
    ({
      findStations: async () =>
        STATIONS.map((s) => ({ id: s.id, name: s.id, latitude: s.lat, longitude: s.lon })),
      fetchTimeline: async (id: string, startMs: number, endMs: number) => ({
        timeline: levels(startMs, endMs, STATIONS.find((s) => s.id === id)!.offset),
      }),
    }) as unknown as TidesClient;
  /** One current station near A: a steady 1 m/s eastward flow. */
  const currentsClient = (): CurrentsClient =>
    ({
      findStations: async () => [
        { id: 'cs', name: 'cs', latitude: 52.0, longitude: 5.02, vectorCapable: true },
      ],
      fetchTimeline: async (_id: string, startMs: number, endMs: number) => {
        const timeline = [];
        for (let t = startMs; t <= endMs; t += 600_000) {
          timeline.push({ time: new Date(t).toISOString(), u: 1, v: 0 });
        }
        return { timeline };
      },
    }) as unknown as CurrentsClient;

  before(async () => {
    dir = tmpDir('tide');
    const raw = new DatabaseSync(path.join(dir, 'tide.sqlite'), { open: true });
    const run = (sql: string, params: unknown[] = []) =>
      raw.prepare(sql).run(...(params as SQLInputValue[]));
    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date)
         VALUES ('GLT', 'Golden tide fixture', 'Synthetic', '2026-01-01T00:00:00Z')`);
    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES
      (1, ${A.lat}, ${A.lon}, 1), (2, ${B.lat}, ${B.lon}, 1), (3, ${C.lat}, ${C.lon}, 1)`);
    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.0, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 1, traffic_mode INTEGER DEFAULT 0
    )`);
    run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode) VALUES
      (1, 2, 2396, 1.5, 20.0, 10.0, 1.0, 5000, 1, 0),
      (2, 1, 2396, 1.5, 20.0, 10.0, 1.0, 5000, 1, 0),
      (1, 3, 2089, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (3, 1, 2089, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (3, 2, 3919, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (2, 3, 3919, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0)`);
    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    upgradeToPoiModel(raw);
    raw.close();
    db = await openDb(dir);
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const request = (req: Partial<RoutingRequest>): RoutingRequest => ({
    start: pt(A.lat, A.lon),
    end: pt(B.lat, B.lon),
    minCoastDistance: 0,
    useTides: true,
    departureTime: new Date(LOW_WATER_MS).toISOString(),
    ...TIDE_DIMS,
    ...req,
  });
  function tideEngine(opts: { currents: boolean }): RoutingEngine {
    const e = newEngine(db, GOLDEN_CONFIG, TIDE_DIMS);
    e.setTidesClient(tidesClient());
    if (opts.currents) e.setCurrentsClient(currentsClient());
    return e;
  }

  register([
    {
      name: 'tides-heights-low-water-detour',
      run: () => outcome(() => tideEngine({ currents: false }).calculateRoute(request({}))),
    },
    {
      name: 'tides-heights-high-water-direct',
      run: () =>
        outcome(() =>
          tideEngine({ currents: false }).calculateRoute(
            request({ departureTime: new Date(LOW_WATER_MS + TIDE_PERIOD_MS / 2).toISOString() }),
          ),
        ),
    },
    {
      name: 'tides-heights-and-current-stations',
      run: () =>
        outcome(() =>
          tideEngine({ currents: true }).calculateRoute(
            request({
              start: pt(A.lat, A.lon),
              end: pt(B.lat, B.lon),
              departureTime: new Date(LOW_WATER_MS + 8 * HOUR_MS).toISOString(),
            }),
          ),
        ),
    },
    {
      name: 'tides-off-request-flag',
      run: () =>
        outcome(() => tideEngine({ currents: false }).calculateRoute(request({ useTides: false }))),
    },
    {
      name: 'departure-scan-heights',
      run: async () => {
        const steps = await tideEngine({ currents: false }).scanDepartures(
          request({}),
          6,
          60,
        );
        return steps;
      },
    },
    {
      name: 'departure-scan-heights-and-current-stations',
      run: async () =>
        tideEngine({ currents: true }).scanDepartures(request({}), 4, 30),
    },
  ]);
});

// ---------------------------------------------------------------------------
// Request validation (src/api.ts)
// ---------------------------------------------------------------------------

describe('golden: validateRequestConstraints', () => {
  const base = (): Record<string, unknown> => ({
    start: pt(52, 5),
    end: pt(52.1, 5.1),
  });
  const inputs: Array<[string, Record<string, unknown>]> = [
    ['valid', { draft: 1.8, beam: 3.5, airDraft: 14, minCoastDistance: 0.5, lockWaitMinutes: 10, bridgeWaitMinutes: 0 }],
    ['numeric-strings', { draft: '1.8', beam: '3,5', airDraft: ' 14 ' }],
    ['bad-draft-string', { draft: 'deep', beam: 3.5 }],
    ['negative-beam', { draft: 1.8, beam: -2 }],
    ['out-of-range-air-draft', { airDraft: 100000 }],
    ['null-dimensions', { draft: null, beam: null, airDraft: null, minCoastDistance: null }],
    ['bad-min-coast-distance-string', { minCoastDistance: 'far' }],
    ['min-coast-distance-too-large', { minCoastDistance: 101 }],
    ['negative-min-coast-distance', { minCoastDistance: -1 }],
    ['bad-lock-wait', { lockWaitMinutes: 'long' }],
    ['lock-wait-too-large', { lockWaitMinutes: 1441 }],
    ['negative-bridge-wait', { bridgeWaitMinutes: -5 }],
  ];
  register(
    inputs.map(([label, extra]) => ({
      name: `validate-request-${label}`,
      run: async () => {
        const request = { ...base(), ...extra } as unknown as RoutingRequest;
        const result = validateRequestConstraints(request);
        return { result, request };
      },
    })),
  );
});
