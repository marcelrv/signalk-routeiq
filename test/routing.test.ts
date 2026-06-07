/**
 * Tests for the Routing Engine
 */

import * as fs from 'fs';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

describe('RoutingEngine', () => {
  let db: RoutingDatabase;
  let engine: RoutingEngine;
  const testDbPath = './test/fixtures/test_routing.sqlite';

  before(async () => {
    // Create test database with sample data
    if (!fs.existsSync('./test/fixtures')) {
      fs.mkdirSync('./test/fixtures', { recursive: true });
    }

    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    db = new RoutingDatabase(testDbPath);

    // Create tables and insert test data before init (init validates schema)
    const run = (sql: string, params: any[] = []) => {
      return new Promise<void>((resolve, reject) => {
        db['db'].run(sql, params, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    };

    // Create tables
    await run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL)`);
    await run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      is_fairway INTEGER, direction_penalty REAL, distance_to_land REAL
    )`);
    await run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type TEXT, lat REAL, lon REAL)`);

    // Now init will pass since tables exist
    await db.init();

    // Insert test data
    await run(`INSERT INTO nodes (id, lat, lon) VALUES 
      (1, 52.0, 5.0),
      (2, 52.01, 5.01),
      (3, 52.02, 5.02),
      (4, 52.03, 5.03),
      (5, 52.04, 5.04)`);

    await run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, is_fairway, direction_penalty, distance_to_land) VALUES
      (1, 2, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (2, 1, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (2, 3, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (3, 2, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (3, 4, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (4, 3, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (4, 5, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500),
      (5, 4, 1500, 5.0, 20.0, 10.0, 1, 1.0, 500)`);

    await run(`INSERT INTO pois (id, name, type, lat, lon) VALUES
      (1, 'Port of Rotterdam', 'port', 51.9244, 4.4777),
      (2, 'Marina Amsterdam', 'marina', 52.3676, 4.9041),
      (3, 'Lock Merwede', 'lock', 51.8833, 5.0333)`);

    // Load graph into memory
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
      assert.strictEqual(route.features.length, 1);
      assert.strictEqual(route.features[0].geometry.type, 'LineString');
      assert.ok(route.features[0].geometry.coordinates.length > 0);
      assert.ok(route.features[0].properties.totalDistance > 0);
    });

    it('should return an error when no route exists', async () => {
      await assert.rejects(
        engine.calculateRoute({
          start: { latitude: 0.0, longitude: 0.0 }, // Far from any nodes
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
      assert.strictEqual(route.warnings!.length, 1);
      assert.strictEqual(route.warnings![0].type, 'end_unreachable');
    });
  });

  describe('setVesselDimensions', () => {
    it('should update vessel dimensions', () => {
      engine.setVesselDimensions({ draft: 3.0, beam: 5.0, airDraft: 15.0 });
      // Dimensions are stored internally, we can't directly test this
      // but we can verify it doesn't throw
    });
  });
});
