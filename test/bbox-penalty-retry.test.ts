import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

// Regression fixture for the "penalized-but-successful" bbox bug: a tight
// routingBBoxMargin can leave only a constraint-violating edge reachable
// (e.g. a shallow direct link) while a clean, unconstrained route exists
// just outside the initial search box but within routingBBoxMaxExtent. The
// old expansion loop only retried on "no route found" — a search that
// "succeeded" via the penalized edge suppressed expansion entirely and
// silently returned the bad route.
//
//   A (52.000, 5.000) ------ shallow, min_depth 0.5 ------ B (52.000, 5.035)
//     \                                                   /
//      \ deep, 2089m                          deep, 3919m/
//       \                                               /
//        C (51.984, 4.984)  -- (only reachable once the bbox widens) --
//
// A tight bbox around A/B (margin 0.01°, ~1.1km) excludes C entirely, so the
// only path A* can find is the direct shallow A-B edge: it "succeeds" but
// with a large constraint penalty baked into totalCost. The clean A-C-B
// detour (~6.0km, no penalty) only becomes reachable once the bbox expands
// past 0.02° (the very next doubling), where it is *cheaper* than the
// penalized direct edge and A* picks it outright.
//
// A/C and B/C are each placed >2km from A and B respectively (Euclidean),
// deliberately outside the engine's shallow-water "improve start/end node"
// heuristic search radius (2000m) — otherwise that heuristic would silently
// re-target the search onto a different node before the bbox logic under
// test even runs.
describe('bbox expansion retries on a penalized (not just failed) result', () => {
  const fixturesDir = './test/fixtures/bbox-penalty-retry';
  const dbPath = path.join(fixturesDir, 'test_bbox_penalty.sqlite');
  let db: RoutingDatabase;

  const A = { lat: 52.000, lon: 5.000 };
  const B = { lat: 52.000, lon: 5.035 };
  const C = { lat: 51.984, lon: 4.984 };
  const NODE_A = 1, NODE_B = 2, NODE_C = 3;

  before(async () => {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    for (const p of [dbPath, path.join(fixturesDir, 'user-edits.sqlite')]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    const raw = new DatabaseSync(dbPath, { open: true });
    const run = (sql: string, params: any[] = []) => raw.prepare(sql).run(...params);

    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      last_update_date TEXT NOT NULL
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date)
         VALUES ('TEST', 'BBox Penalty Retry Region', 'Synthetic fixture', '2026-01-01T00:00:00Z')`);

    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES
      (${NODE_A}, ${A.lat}, ${A.lon}, 1),
      (${NODE_B}, ${B.lat}, ${B.lon}, 1),
      (${NODE_C}, ${C.lat}, ${C.lon}, 1)`);

    run(`CREATE TABLE edge_type_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL)`);
    run(`INSERT INTO edge_type_enum VALUES (0, 'coastal'), (1, 'inland')`);
    run(`CREATE TABLE poi_type_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL)`);
    run(`INSERT INTO poi_type_enum VALUES (0, 'harbour'), (1, 'lock'), (2, 'bridge'), (3, 'fairway'), (4, 'waterway')`);

    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.0, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 1,
      traffic_mode INTEGER DEFAULT 0
    )`);
    // edge_type_id=1 (inland) throughout so the coastal min-distance penalty
    // never applies here — only the intentional depth violation on A<->B.
    run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode) VALUES
      (${NODE_A}, ${NODE_B}, 2396, 0.5, 20.0, 10.0, 1.0, 5000, 1, 0),
      (${NODE_B}, ${NODE_A}, 2396, 0.5, 20.0, 10.0, 1.0, 5000, 1, 0),
      (${NODE_A}, ${NODE_C}, 2089, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (${NODE_C}, ${NODE_A}, 2089, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (${NODE_C}, ${NODE_B}, 3919, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (${NODE_B}, ${NODE_C}, 3919, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0)`);

    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);

    raw.close();

    db = new RoutingDatabase(fixturesDir);
    await db.init();
    await db.loadGraph();
  });

  after(async () => {
    await db.close();
    for (const p of [dbPath, path.join(fixturesDir, 'user-edits.sqlite')]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('expands the bbox and picks the clean detour when the only in-box route is constraint-penalized', async () => {
    // Tight initial margin (~1.1km) excludes C; a max extent of 0.5° gives
    // plenty of room for the single doubling (0.01 -> 0.02) that's actually
    // needed to reach it.
    const engine = new RoutingEngine(db, {
      ...DEFAULT_CONFIG,
      routingBBoxMargin: 0.01,
      routingBBoxMaxExtent: 0.5,
    });
    engine.setVesselDimensions({ draft: 2.0, beam: 4.0, airDraft: 10.0 });

    const route = await engine.calculateRoute({
      start: { latitude: A.lat, longitude: A.lon },
      end: { latitude: B.lat, longitude: B.lon },
      minCoastDistance: 0,
    });

    // The clean A-C-B detour is ~6.0km; the direct shallow A-B edge is
    // ~2.4km. Only the retry-after-expansion can find the longer, clean route
    // — and only the "keep the better result" rule picks it over the shorter
    // but massively-penalized direct edge.
    assert.ok(route.totalDistance! > 5500 && route.totalDistance! < 6500,
      `expected the ~6.0km clean detour via C, got ${route.totalDistance}m`);

    // No constraint-penalty inflation in the winning cost — this is exactly
    // the check that would fail under the old bug, where the search silently
    // kept the penalized direct A-B result (cost > 1,000,000, in fact here
    // > 2,000,000,000 since the penalty scales with the violating edge's
    // length).
    assert.ok(route.totalCost! < 1_000_000,
      `expected a clean cost with no depth-violation penalty, got ${route.totalCost}`);
    // Cost should track distance closely (cost_factor 1.0, no penalty).
    assert.ok(Math.abs(route.totalCost! - route.totalDistance!) < 50,
      `expected cost ≈ distance for an unpenalized route, got cost=${route.totalCost} distance=${route.totalDistance}`);

    // No draft-violation warning: the winning route never touches the
    // shallow A-B edge.
    const draftWarning = (route.warnings || []).find(w => w.type === 'via_constrained');
    assert.strictEqual(draftWarning, undefined, 'clean route should carry no depth-constraint warning');
  });

  it('falls back to the penalized direct edge when max extent cannot reach the clean detour', async () => {
    // Max extent capped at 0.015° — past the first doubling (0.02 would
    // reach C) but short of the second, so the retry can widen the box once
    // and still never reach the clean detour. The engine must still return
    // *a* route (the penalized one) rather than failing outright.
    const engine = new RoutingEngine(db, {
      ...DEFAULT_CONFIG,
      routingBBoxMargin: 0.01,
      routingBBoxMaxExtent: 0.015,
    });
    engine.setVesselDimensions({ draft: 2.0, beam: 4.0, airDraft: 10.0 });

    const route = await engine.calculateRoute({
      start: { latitude: A.lat, longitude: A.lon },
      end: { latitude: B.lat, longitude: B.lon },
      minCoastDistance: 0,
    });

    assert.ok(route.totalDistance! < 3000, `expected the short direct A-B edge, got ${route.totalDistance}m`);
    // Old-bug signature: cost dominated by the depth-violation penalty
    // (penalty scales with the violating edge's length here, hence >2e9
    // rather than merely >1e6 — either way it's nowhere near clean).
    assert.ok(route.totalCost! > 1_000_000, `expected the depth-violation penalty to dominate cost, got ${route.totalCost}`);
    const draftWarning = (route.warnings || []).find(w => w.type === 'via_constrained');
    assert.ok(draftWarning, 'expected a depth-constraint warning on the fallback route');
  });
});
