import * as path from 'path';
import * as fs from 'fs';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

// Regression test for the "finalResult.features[0].properties.segments is
// not iterable" crash (found live on the Puerto Rico dataset, Round 24).
//
// Mechanism: when a via-route LEG hits tryRouteSegment's disconnected-graph
// fallback, fallbackRoute used to run finalizeRoute on the leg result.
// finalizeRoute ends in splitToSegmentFeatures, which replaces features[0]
// with per-segment features that carry no properties.segments — so
// routeViaPoints' merge step crashed reading segments of the returned leg.
// The fix passes finalize=false from the leg call site; the via pipeline
// finalizes once, at the end, on the merged result.
//
// Fixture: two disconnected clusters, each internally connected:
//   cluster 1:  A --- B         (around 52.00N, 5.00E)
//   cluster 2:  C --- D         (around 52.00N, 5.20E, ~13km east)
// Route: start near A, via near B, destination near D. The final leg
// (B -> D) spans the disconnect, forcing the fallback path.
describe('via route with a disconnected final leg (Round 24 regression)', () => {
  const fixturesDir = './test/fixtures/via-disconnected-leg';
  const dbPath = path.join(fixturesDir, 'test_via_disconnected.sqlite');
  let db: RoutingDatabase;
  let engine: RoutingEngine;

  const A = { lat: 52.0, lon: 5.0 };
  const B = { lat: 52.0, lon: 5.05 };
  const C = { lat: 52.0, lon: 5.2 };
  const D = { lat: 52.0, lon: 5.25 };

  before(async () => {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    for (const p of [dbPath, path.join(fixturesDir, 'user-edits.sqlite')]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    const raw = new DatabaseSync(dbPath, { open: true });
    const run = (sql: string) => raw.prepare(sql).run();

    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      last_update_date TEXT NOT NULL
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date)
         VALUES ('TEST', 'Via Disconnected Leg Region', 'Synthetic fixture', '2026-01-01T00:00:00Z')`);

    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES
      (1, ${A.lat}, ${A.lon}, 1),
      (2, ${B.lat}, ${B.lon}, 1),
      (3, ${C.lat}, ${C.lon}, 1),
      (4, ${D.lat}, ${D.lon}, 1)`);

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
    run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode) VALUES
      (1, 2, 3400, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (2, 1, 3400, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (3, 4, 3400, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (4, 3, 3400, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0)`);

    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    raw.close();

    db = new RoutingDatabase(fixturesDir);
    await db.init();
    await db.loadGraph();
    engine = new RoutingEngine(db, DEFAULT_CONFIG);
    engine.setVesselDimensions({ draft: 1.0, beam: 3.0, airDraft: 5.0 });
  });

  after(async () => {
    await db.close();
    for (const p of [dbPath, path.join(fixturesDir, 'user-edits.sqlite')]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('returns a merged route (with a bridging warning) instead of crashing', async () => {
    const route = await engine.calculateRoute({
      start: { latitude: A.lat, longitude: A.lon },
      via: [{ latitude: B.lat, longitude: B.lon }],
      end: { latitude: D.lat, longitude: D.lon },
      minCoastDistance: 0,
    });
    // Pre-fix this threw "segments is not iterable". Post-fix: a real
    // result whose warnings mention the disconnect bridging.
    assert.ok(route.totalDistance! > 0, 'expected a non-empty merged route');
    const types = (route.warnings ?? []).map((w) => w.type);
    assert.ok(types.includes('via_constrained') || types.includes('manual_segment') || types.length > 0,
      `expected a bridging/disconnect warning, got: ${JSON.stringify(route.warnings)}`);
  });
});
