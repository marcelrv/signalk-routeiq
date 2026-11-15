import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';
import { RouteSearchError, RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';
import { upgradeToPoiModel } from './poi-model-fixture.js';

// The start node's "better depth" swap. When every edge from the nearest
// node toward the destination is too shallow, astarSearch looks within 2 km
// for a node with a deep edge and starts there instead. It used to take the
// nearest such node blindly: from a harbour whose only exit is a little too
// shallow it jumped to a tiny island of deep water (in the field, a stray
// user-edit), every bounding box failed, and the user got "graph is
// connected but A* could not find a path".
//
//   I1 (51.996, 5.000) == I2 (51.993, 5.000)    island, deep, unconnected
//
//   H (52.000, 5.000) -- 2.0 m -- K (52.000, 5.010) ====== D (52.000, 5.050)
//   harbour (start)    shallow     channel end      deep    destination
//
//   M (52.003, 5.000) ====== deep ====== far loop to D (only in "other water")
//
// Draft 1.9 + safetyMarginDraft 0.2 needs 2.1 m, so H's only exit is shallow.
// I1 (445 m) is the nearest deep node but leads nowhere; K (686 m) is deep
// but H reaches it along the channel anyway. Neither is a better start: the
// route has to start at H and carry a depth warning for H-K.

const H = { lat: 52.0, lon: 5.0 };
const K = { lat: 52.0, lon: 5.01 };
const D = { lat: 52.0, lon: 5.05 };
const I1 = { lat: 51.996, lon: 5.0 };
const I2 = { lat: 51.993, lon: 5.0 };
// "Other water": M, 333 m north of H, joins D only by a loop far longer than
// the 4 km the swap looks along the waterway, so H does not lead into it.
const M = { lat: 52.003, lon: 5.0 };
const M2 = { lat: 52.03, lon: 5.0 };
const M3 = { lat: 52.03, lon: 5.05 };

const NODE_H = 1, NODE_K = 2, NODE_D = 3, NODE_I1 = 4, NODE_I2 = 5;
const NODE_M = 6, NODE_M2 = 7, NODE_M3 = 8;

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function buildFixture(dir: string, withOtherWater: boolean): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));

  const raw = new DatabaseSync(path.join(dir, 'start_swap.sqlite'), { open: true });
  const run = (sql: string, params: any[] = []) => raw.prepare(sql).run(...params);
  run(`CREATE TABLE metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL
  )`);
  run(`INSERT INTO metadata (country, name, description, last_update_date)
       VALUES ('TEST', 'Start Swap Region', 'Synthetic fixture', '2026-01-01T00:00:00Z')`);
  run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
  run(`CREATE TABLE edge_type_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL)`);
  run(`INSERT INTO edge_type_enum VALUES (0, 'coastal'), (1, 'inland')`);
  run(`CREATE TABLE poi_type_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL)`);
  run(`INSERT INTO poi_type_enum VALUES (0, 'harbour'), (1, 'lock'), (2, 'bridge')`);
  run(`CREATE TABLE edges (
    source INTEGER, target INTEGER, distance REAL,
    min_depth REAL, max_air_draft REAL, min_width REAL,
    cost_factor REAL DEFAULT 1.0, distance_to_land REAL,
    edge_type_id INTEGER DEFAULT 1, traffic_mode INTEGER DEFAULT 0
  )`);
  run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);

  const nodes: Array<[number, { lat: number; lon: number }]> = [
    [NODE_H, H], [NODE_K, K], [NODE_D, D], [NODE_I1, I1], [NODE_I2, I2],
  ];
  // Both directions of each link; inland (edge_type_id 1) so the coastal
  // distance rule never applies — depth is the only constraint in play.
  const links: Array<[number, number, number]> = [
    [NODE_H, NODE_K, 2.0],
    [NODE_K, NODE_D, 10.0],
    [NODE_I1, NODE_I2, 10.0],
  ];
  if (withOtherWater) {
    nodes.push([NODE_M, M], [NODE_M2, M2], [NODE_M3, M3]);
    links.push([NODE_M, NODE_M2, 10.0], [NODE_M2, NODE_M3, 10.0], [NODE_M3, NODE_D, 10.0]);
  }
  const pos = new Map(nodes);
  for (const [id, p] of nodes) {
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [id, p.lat, p.lon]);
  }
  for (const [a, b, depth] of links) {
    const dist = metres(pos.get(a)!, pos.get(b)!);
    for (const [s, t] of [[a, b], [b, a]]) {
      run(
        `INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode)
         VALUES (?, ?, ?, ?, 20.0, 50.0, 1.0, 5000, 1, 0)`,
        [s, t, dist, depth],
      );
    }
  }
  upgradeToPoiModel(raw);
  raw.close();
}

function makeEngine(db: RoutingDatabase): RoutingEngine {
  const engine = new RoutingEngine(db, {
    ...DEFAULT_CONFIG,
    safetyMarginDraft: 0.2,
    lineOfSightSampleInterval: 0,
    lineOfSightSearchRadius: 0,
  });
  engine.setVesselDimensions({ draft: 1.9, beam: 3.6, airDraft: 16 });
  return engine;
}

const request = {
  start: { latitude: H.lat, longitude: H.lon },
  end: { latitude: D.lat, longitude: D.lon },
  minCoastDistance: 0,
};

/** Whether a route vertex sits on `p` (to ~1 m). */
function passes(route: any, p: { lat: number; lon: number }): boolean {
  return route.features.some((f: any) =>
    (f.geometry?.coordinates ?? []).some(
      ([lon, lat]: [number, number]) => Math.abs(lat - p.lat) < 1e-5 && Math.abs(lon - p.lon) < 1e-5,
    ),
  );
}

describe('start-node better-depth swap', () => {
  const dir = './test/fixtures/start-node-swap';
  let db: RoutingDatabase;

  before(async () => {
    buildFixture(dir, false);
    db = new RoutingDatabase(dir);
    await db.init();
    await db.loadGraph();
  });

  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('routes a slightly shallow harbour exit with a depth warning instead of jumping to an island', async () => {
    const route = await makeEngine(db).calculateRoute(request);
    assert.ok(passes(route, H), 'the route starts at the harbour node');
    assert.ok(passes(route, K), 'the route sails the shallow channel H-K');
    assert.ok(!passes(route, I1) && !passes(route, I2), 'the route never touches the island');
    const depth = (route.warnings ?? []).find(
      (w: any) => w.type === 'via_constrained' && /depth/.test(w.message),
    );
    assert.ok(depth, `expected a shallow-depth warning, got ${JSON.stringify(route.warnings)}`);
  });

  it('retries from the nearest node when a swapped start still leads nowhere', async () => {
    // Defeat the island check so the swap lands on I1 again, as it did
    // before: the search from there fails and must be redone from H.
    const anyDb = db as any;
    const orig = anyDb.leadsAnywhere;
    anyDb.leadsAnywhere = () => true;
    const engine = makeEngine(db) as any;
    const origLocal = engine.localGraphReach.bind(engine);
    engine.localGraphReach = async () => new Set<number>();
    try {
      const route = await engine.calculateRoute(request);
      assert.ok(passes(route, H) && passes(route, K), 'the retry routes from the harbour node');
      assert.ok(!passes(route, I1), 'the route never touches the island');
    } finally {
      anyDb.leadsAnywhere = orig;
      engine.localGraphReach = origLocal;
    }
  });

  it('puts the last A* error in the final "No route found" message', async () => {
    const engine = makeEngine(db) as any;
    engine.astarSearch = async () => {
      throw new RouteSearchError('No route found between the given points — synthetic cause');
    };
    await assert.rejects(engine.calculateRoute(request), (e: Error) => {
      assert.match(e.message, /graph is connected but A\* could not find a path/);
      assert.match(e.message, /Last search error: .*synthetic cause/);
      return true;
    });
  });

  it('lets an unexpected (non-A*) error propagate instead of widening the box', async () => {
    const engine = makeEngine(db) as any;
    let calls = 0;
    engine.pathViolationMeters = async () => {
      calls++;
      throw new TypeError('synthetic bug');
    };
    await assert.rejects(engine.calculateRoute(request), /synthetic bug/);
    assert.strictEqual(calls, 1, 'no retry with a wider box after a bug');
  });
});

describe('start-node better-depth swap into other water', () => {
  const dir = './test/fixtures/start-node-swap-other';
  let db: RoutingDatabase;

  before(async () => {
    buildFixture(dir, true);
    db = new RoutingDatabase(dir);
    await db.init();
    await db.loadGraph();
  });

  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('still swaps to deep water the harbour does not lead into nearby', async () => {
    const route = await makeEngine(db).calculateRoute(request);
    assert.ok(passes(route, M), 'the route starts in the other, deep water at M');
    assert.ok(!passes(route, I1), 'the route never touches the island');
  });
});
