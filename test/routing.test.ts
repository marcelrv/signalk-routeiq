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
    const overlayPath = path.join(fixturesDir, 'user-edits.sqlite');
    if (fs.existsSync(overlayPath)) {
      fs.unlinkSync(overlayPath);
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

    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES
      (1420000018500000, 52.0, 5.0, ${regionId}),
      (1420100018501000, 52.01, 5.01, ${regionId}),
      (1420200018502000, 52.02, 5.02, ${regionId}),
      (1420300018503000, 52.03, 5.03, ${regionId}),
      (1420400018504000, 52.04, 5.04, ${regionId})`);

    run(`CREATE TABLE edge_type_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL)`);
    run(`INSERT INTO edge_type_enum VALUES (0, 'coastal'), (1, 'inland')`);
    run(`CREATE TABLE poi_type_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL)`);
    run(`INSERT INTO poi_type_enum VALUES (0, 'harbour'), (1, 'lock'), (2, 'bridge'), (3, 'fairway'), (4, 'waterway')`);

    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.2, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 0,
      traffic_mode INTEGER DEFAULT 0
    )`);
    run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode) VALUES
      (1420000018500000, 1420100018501000, 1500, 5.0, 20.0, 10.0, 0.8, 500, 0, 0),
      (1420100018501000, 1420000018500000, 1500, 5.0, 20.0, 10.0, 0.8, 500, 0, 0),
      (1420100018501000, 1420200018502000, 1500, 5.0, 20.0, 10.0, 0.8, 500, 0, 0),
      (1420200018502000, 1420100018501000, 1500, 5.0, 20.0, 10.0, 0.8, 500, 0, 0),
      (1420200018502000, 1420300018503000, 1500, 5.0, 20.0, 10.0, 0.8, 500, 0, 0),
      (1420300018503000, 1420200018502000, 1500, 5.0, 20.0, 10.0, 0.8, 500, 0, 0),
      (1420300018503000, 1420400018504000, 1500, 5.0, 20.0, 10.0, 0.8, 500, 0, 0),
      (1420400018504000, 1420300018503000, 1500, 5.0, 20.0, 10.0, 0.8, 500, 0, 0)`);

    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    run(`INSERT INTO pois (id, name, type_id, properties, lat, lon) VALUES
      (1, 'Port of Rotterdam', 0, NULL, 51.9244, 4.4777),
      (2, 'Marina Amsterdam', 0, NULL, 52.3676, 4.9041),
      (3, 'Lock Merwede', 1, NULL, 51.8833, 5.0333)`);

    raw.close();

    // Small land polygon used by the manual-leg land-crossing warning test
    fs.writeFileSync(path.join(fixturesDir, 'land_polygons.geojson'), JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [4.99, 52.05], [5.01, 52.05], [5.01, 52.06], [4.99, 52.06], [4.99, 52.05],
          ]],
        },
      }],
    }));

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
    const landPath = path.join(fixturesDir, 'land_polygons.geojson');
    if (fs.existsSync(landPath)) {
      fs.unlinkSync(landPath);
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

  describe('calculateRoute — manual legs', () => {
    it('routes a fully manual leg as a straight line (endMode: manual)', async () => {
      const route = await engine.calculateRoute({
        start: { latitude: 52.0, longitude: 5.0 },
        end: { latitude: 52.04, longitude: 5.04 },
        endMode: 'manual',
        minCoastDistance: 0,
      });

      assert.strictEqual(route.type, 'FeatureCollection');
      assert.strictEqual(route.features.length, 1, 'one straight segment expected');
      assert.strictEqual(route.features[0].properties.mode, 'manual');
      assert.strictEqual(route.features[0].geometry.coordinates.length, 2);
      // Straight-line distance start→end is ~5.2 km
      assert.ok(route.totalDistance! > 5000 && route.totalDistance! < 5500,
        `expected ~5.2km straight line, got ${route.totalDistance}`);
    });

    it('does not require graph coverage for manual legs', async () => {
      // Same coordinates that make the auto router throw "No routing nodes"
      const route = await engine.calculateRoute({
        start: { latitude: 0.0, longitude: 0.0 },
        end: { latitude: 1.0, longitude: 1.0 },
        endMode: 'manual',
      });
      assert.strictEqual(route.features.length, 1);
      assert.strictEqual(route.features[0].properties.mode, 'manual');
    });

    it('mixes a manual first leg with an auto-routed remainder', async () => {
      const route = await engine.calculateRoute({
        start: { latitude: 52.0, longitude: 5.0 },
        end: { latitude: 52.04, longitude: 5.04 },
        via: [{ latitude: 52.02, longitude: 5.02, mode: 'manual' }],
        minCoastDistance: 0,
      });

      assert.ok(route.features.length >= 2, 'manual + auto features expected');
      const manualFeatures = route.features.filter(f => f.properties.mode === 'manual');
      const autoFeatures = route.features.filter(f => f.properties.mode === undefined);
      assert.strictEqual(manualFeatures.length, 1, 'exactly one manual segment');
      assert.ok(autoFeatures.length >= 1, 'auto segments after the manual leg');
      // Manual leg comes first in the feature order
      assert.strictEqual(route.features[0].properties.mode, 'manual');
    });

    it('snaps a manual endpoint to a nearby graph node so auto routing picks up there', async () => {
      // ~60 m NE of node (52.02, 5.02) — inside the 150 m snap radius
      const route = await engine.calculateRoute({
        start: { latitude: 52.0, longitude: 5.0 },
        end: { latitude: 52.04, longitude: 5.04 },
        via: [{ latitude: 52.0205, longitude: 5.0205, mode: 'manual' }],
        minCoastDistance: 0,
      });

      const manual = route.features.find(f => f.properties.mode === 'manual');
      assert.ok(manual, 'manual feature present');
      const endCoord = manual!.geometry.coordinates[manual!.geometry.coordinates.length - 1];
      assert.ok(Math.abs(endCoord[1] - 52.02) < 1e-9 && Math.abs(endCoord[0] - 5.02) < 1e-9,
        `manual endpoint should snap to node (52.02, 5.02), got (${endCoord[1]}, ${endCoord[0]})`);
    });

    it('keeps the exact user destination on a manual final leg (no snapping)', async () => {
      // ~60 m from node (52.04, 5.04); a manual FINAL leg must not snap away
      const route = await engine.calculateRoute({
        start: { latitude: 52.0, longitude: 5.0 },
        end: { latitude: 52.0405, longitude: 5.0405 },
        via: [{ latitude: 52.02, longitude: 5.02 }],
        endMode: 'manual',
        minCoastDistance: 0,
      });
      const manual = route.features[route.features.length - 1];
      assert.strictEqual(manual.properties.mode, 'manual');
      const endCoord = manual.geometry.coordinates[manual.geometry.coordinates.length - 1];
      assert.ok(Math.abs(endCoord[1] - 52.0405) < 1e-9 && Math.abs(endCoord[0] - 5.0405) < 1e-9,
        `manual final leg must end at the exact destination, got (${endCoord[1]}, ${endCoord[0]})`);
    });

    it('warns when a manual leg crosses land', async () => {
      // land fixture (see before()) covers 52.05–52.06 / 4.99–5.01
      const route = await engine.calculateRoute({
        start: { latitude: 52.045, longitude: 5.005 },
        end: { latitude: 52.065, longitude: 5.005 },
        endMode: 'manual',
      });
      assert.ok(route.warnings, 'expected warnings');
      const w = route.warnings!.find(w => w.type === 'manual_segment');
      assert.ok(w, 'expected a manual_segment land-crossing warning');
    });

    it('rejects nothing: a manual leg never fails, even where auto routing would', async () => {
      // Draft that blocks every edge of the graph — manual ignores constraints
      engine.setVesselDimensions({ draft: 100.0, beam: 4.0, airDraft: 10.0 });
      const route = await engine.calculateRoute({
        start: { latitude: 52.0, longitude: 5.0 },
        end: { latitude: 52.04, longitude: 5.04 },
        endMode: 'manual',
        minCoastDistance: 0,
      });
      engine.setVesselDimensions({ draft: 2.0, beam: 4.0, airDraft: 10.0 });
      assert.strictEqual(route.features[0].properties.mode, 'manual');
      // No depth violations reported for manual segments (minDepth is unknown)
      const depthWarnings = (route.warnings || []).filter(w => w.type === 'via_constrained');
      assert.strictEqual(depthWarnings.length, 0, 'manual legs carry no constraint violations');
    });
  });

  describe('setVesselDimensions', () => {
    it('should update vessel dimensions', () => {
      engine.setVesselDimensions({ draft: 3.0, beam: 5.0, airDraft: 15.0 });
    });
  });

  describe('graph editor — edge CRUD', () => {
    const SRC = 1420000018500000;
    const TGT = 1420100018501000;

    it('updateEdge persists values in memory and getEdgesInBBox returns them', async () => {
      await db.updateEdge(0, SRC, TGT, { max_air_draft: 99, min_width: 88, cost_factor: 0.5 });
      const edges = await db.getEdgesInBBox(51.9, 4.9, 52.1, 5.1, 100);
      const updated: any = edges.find(e => e.source === SRC && e.target === TGT);
      assert.ok(updated, 'Edge should be found in bbox');
      assert.strictEqual(updated.max_air_draft, 99, 'max_air_draft should be 99');
      assert.strictEqual(updated.min_width, 88, 'min_width should be 88');
      assert.strictEqual(updated.cost_factor, 0.5, 'cost_factor should be 0.5');
    });

    it('updateEdge does not create duplicate entries', async () => {
      const edgesBefore: any[] = await db.getEdgesInBBox(51.9, 4.9, 52.1, 5.1, 100);
      const countBefore = edgesBefore.filter((e: any) => e.source === SRC && e.target === TGT).length;
      await db.updateEdge(0, SRC, TGT, { min_depth: 42 });
      const edgesAfter: any[] = await db.getEdgesInBBox(51.9, 4.9, 52.1, 5.1, 100);
      const countAfter = edgesAfter.filter((e: any) => e.source === SRC && e.target === TGT).length;
      assert.strictEqual(countAfter, countBefore, 'Should not create duplicate edges on update');
    });

    it('updateEdge persists to overlay SQLite', async () => {
      const overlayPath = path.join(fixturesDir, 'user-edits.sqlite');
      const raw = new DatabaseSync(overlayPath);
      const row: any = raw.prepare('SELECT max_air_draft, min_width, cost_factor, min_depth FROM edges WHERE source = ? AND target = ?').get(SRC, TGT);
      raw.close();
      assert.ok(row, 'Edge should exist in overlay');
      assert.strictEqual(row.max_air_draft, 99, 'Overlay max_air_draft should be 99');
      assert.strictEqual(row.min_width, 88, 'Overlay min_width should be 88');
      assert.strictEqual(row.min_depth, 42, 'Overlay min_depth should be 42');
    });

    it('addEdge sets source_lat/source_lon in memory', async () => {
      const newSrc = 1420300018503000;
      const newTgt = 1420400018504000;
      await db.addEdge(0, { source: newSrc, target: newTgt, distance: 2000, min_depth: 5, max_air_draft: 25, min_width: 12, cost_factor: 0.8, distance_to_land: 300, edge_type_id: 1, traffic_mode: 0 });
      const edges: any[] = await db.getEdgesInBBox(51.9, 4.9, 52.1, 5.1, 100);
      const added: any = edges.find(e => e.source === newSrc && e.target === newTgt);
      assert.ok(added, 'New edge should be found in bbox');
      assert.strictEqual(added.source_lat, 52.03, `source_lat should be 52.03, got ${added.source_lat}`);
      assert.strictEqual(added.source_lon, 5.03, `source_lon should be 5.03, got ${added.source_lon}`);
      assert.strictEqual(added.target_lat, 52.04, `target_lat should be 52.04, got ${added.target_lat}`);
      assert.strictEqual(added.target_lon, 5.04, `target_lon should be 5.04, got ${added.target_lon}`);
    });
  });
});

describe('Itinerary', async () => {
  const { simplifyIndices, buildItinerary } = await import('../dist/itinerary.js');

  // L-shaped route: 10 segments due east along lat 52.0 (lon 4.00→4.10),
  // then 5 segments due north along lon 4.10 (lat 52.00→52.05).
  const coords: [number, number][] = [];
  for (let i = 0; i <= 10; i++) coords.push([4.0 + i * 0.01, 52.0]);
  for (let i = 1; i <= 5; i++) coords.push([4.1, 52.0 + i * 0.01]);
  const segments = coords.slice(1).map((_, i) => ({
    distance: i < 10 ? 700 : 1113,
    minDepth: i === 2 ? 3.5 : -1,
    maxAirDraft: -1,
  }));

  it('drops collinear points but keeps the corner', () => {
    const kept = simplifyIndices(coords, 30);
    assert.deepStrictEqual(kept, [0, 10, coords.length - 1]);
  });

  it('keeps every point when tolerance is 0', () => {
    const kept = simplifyIndices(coords, 0);
    assert.strictEqual(kept.length, coords.length);
  });

  it('builds start/turn/end with leg aggregates and crossing chainage', () => {
    const crossings = [
      { type: 'bridge' as const, name: 'Testbrug', subtype: 'fixed', height: 12,
        position: { latitude: 52.0, longitude: 4.05 } }, // at coord index 5
    ];
    const { waypoints, itinerary } = buildItinerary(coords, segments, crossings, [], 30);

    assert.strictEqual(waypoints.length, 3, 'simplified to start/corner/end');

    assert.strictEqual(itinerary.length, 3);
    const [start, turn, end] = itinerary;
    assert.strictEqual(start.kind, 'start');
    assert.strictEqual(turn.kind, 'turn');
    assert.strictEqual(end.kind, 'end');

    // Chainage from graph edge distances
    assert.strictEqual(start.distanceFromStart, 0);
    assert.strictEqual(turn.distanceFromStart, 7000);
    assert.strictEqual(end.distanceFromStart, 7000 + 5 * 1113);

    // Turning from due east (090°) onto due north (000°) is ~90° to port
    assert.ok(Math.abs((turn.turn ?? 0) + 90) < 3, `expected ~-90, got ${turn.turn}`);
    assert.ok(Math.abs((start.courseToNext ?? 0) - 90) < 3, `expected ~090, got ${start.courseToNext}`);

    // First leg: 10 edges of 700 m, one with a known depth, and the bridge
    assert.strictEqual(start.leg!.distance, 7000);
    assert.strictEqual(start.leg!.minDepth, 3.5);
    assert.strictEqual(start.leg!.crossings!.length, 1);
    assert.strictEqual(start.leg!.crossings![0].distanceFromStart, 5 * 700);
    // Second leg: no known depth, no crossings
    assert.strictEqual(turn.leg!.distance, 5 * 1113);
    assert.strictEqual(turn.leg!.minDepth, undefined);
    assert.strictEqual(turn.leg!.crossings, undefined);
  });

  it('marks via points with their request index', () => {
    const via = [{ latitude: 52.0, longitude: 4.03 }]; // coord index 3
    const { itinerary } = buildItinerary(coords, segments, [], via, 30);
    const viaEntry = itinerary.find((p) => p.kind === 'via');
    assert.ok(viaEntry, 'via entry present');
    assert.strictEqual(viaEntry!.viaIndex, 0);
    assert.strictEqual(viaEntry!.distanceFromStart, 3 * 700);
    assert.strictEqual(itinerary[0].leg!.distance, 3 * 700, 'first leg ends at the via point');
  });
});
