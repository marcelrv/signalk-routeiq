import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

describe('RoutingEngine', () => {
  let db: RoutingDatabase;
  let engine: RoutingEngine;
  const fixturesDir = './test/fixtures';
  const testDbPath = path.join(fixturesDir, 'test_routing.sqlite');

  before(async () => {
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Create and populate the test database using raw DatabaseSync
    const raw = new DatabaseSync(testDbPath, { open: true });
    const run = (sql: string, params: any[] = []) => {
      raw.prepare(sql).run(...params);
    };

    // Deterministic node IDs from _coord_to_id formula:
    // lat_int = int((round(lat,5) + 90.0) * 100000)
    // lon_int = int((round(lon,5) + 180.0) * 100000)
    // id = lat_int * 100000000 + lon_int
    //
    // (52.0, 5.0)   → lat_int=14200000 lon_int=18500000 id=1420000018500000
    // (52.01, 5.01) → lat_int=14201000 lon_int=18501000 id=1420100018501000
    // (52.02, 5.02) → lat_int=14202000 lon_int=18502000 id=1420200018502000
    // (52.03, 5.03) → lat_int=14203000 lon_int=18503000 id=1420300018503000
    // (52.04, 5.04) → lat_int=14204000 lon_int=18504000 id=1420400018504000

    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      last_update_date TEXT NOT NULL
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date)
         VALUES ('TEST', 'Test Region', 'Test data for routing', '2025-01-01T00:00:00Z')`);
    const regionId = 1;

    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, region_id INTEGER)`);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES
      (1420000018500000, 52.0, 5.0, ${regionId}),
      (1420100018501000, 52.01, 5.01, ${regionId}),
      (1420200018502000, 52.02, 5.02, ${regionId}),
      (1420300018503000, 52.03, 5.03, ${regionId}),
      (1420400018504000, 52.04, 5.04, ${regionId})`);

    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      is_fairway INTEGER, direction_penalty REAL, distance_to_land REAL,
      edge_type TEXT DEFAULT 'coastal',
      is_one_way INTEGER DEFAULT 0,
      traffic_dir INTEGER DEFAULT 1
    )`);
    run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, is_fairway, direction_penalty, distance_to_land) VALUES
      (1420000018500000, 1420100018501000, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (1420100018501000, 1420000018500000, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (1420100018501000, 1420200018502000, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (1420200018502000, 1420100018501000, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (1420200018502000, 1420300018503000, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (1420300018503000, 1420200018502000, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (1420300018503000, 1420400018504000, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (1420400018504000, 1420300018503000, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500)`);

    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type TEXT, properties TEXT, lat REAL, lon REAL)`);
    run(`INSERT INTO pois (id, name, type, properties, lat, lon) VALUES
      (1, 'Port of Rotterdam', 'port', NULL, 51.9244, 4.4777),
      (2, 'Marina Amsterdam', 'marina', NULL, 52.3676, 4.9041),
      (3, 'Lock Merwede', 'lock', NULL, 51.8833, 5.0333)`);

    raw.close();

    // Open via RoutingDatabase with the fixtures directory
    db = new RoutingDatabase(fixturesDir);
    await db.init();
    await db.loadGraph();

    engine = new RoutingEngine(db, DEFAULT_CONFIG);
  });

  after(async () => {
    await db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('calculateRoute', () => {
    it('should calculate a route between two points', async () => {
      const route = await engine.calculateRoute({
        start: { latitude: 52.0, longitude: 5.0 },
        end: { latitude: 52.04, longitude: 5.04 },
        minCoastDistance: 0,
      });

      assert.strictEqual(route.type, 'FeatureCollection');
      assert.ok(route.features.length >= 1);
      assert.strictEqual(route.features[0].geometry.type, 'LineString');
      assert.ok(route.features[0].geometry.coordinates.length === 2);
      assert.ok(route.totalDistance! > 0);
    });

    it('should return an error when no route exists', async () => {
      await assert.rejects(
        engine.calculateRoute({
          start: { latitude: 0.0, longitude: 0.0 },
          end: { latitude: 1.0, longitude: 1.0 },
        }),
        /No routing nodes found near start point/
      );
    });

    it('should return warnings when vessel draft constraints block the route', async () => {
      engine.setVesselDimensions({ draft: 100.0, beam: 4.0, airDraft: 10.0 });

      const route = await engine.calculateRoute({
        start: { latitude: 52.0, longitude: 5.0 },
        end: { latitude: 52.04, longitude: 5.04 },
        minCoastDistance: 0,
      });

      assert.strictEqual(route.type, 'FeatureCollection');
      assert.ok(route.warnings, 'Expected warnings when constraints block the route');
      const constraintWarning = route.warnings!.find(w => w.type === 'via_constrained');
      assert.ok(constraintWarning, 'Expected a via_constrained warning for draft constraint violation');
    });
  });

  describe('setVesselDimensions', () => {
    it('should update vessel dimensions', () => {
      engine.setVesselDimensions({ draft: 3.0, beam: 5.0, airDraft: 15.0 });
    });
  });
});
