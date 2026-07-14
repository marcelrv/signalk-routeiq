import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

// Deterministic node ID formula per routing-database-format-specification.md §2.7
function nodeIdFor(lat: number, lon: number): number {
  const latInt = Math.round((Math.round(lat * 100000) / 100000 + 90) * 100000);
  const lonInt = Math.round((Math.round(lon * 100000) / 100000 + 180) * 100000);
  return latInt * 36_000_000 + lonInt;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Same L-shaped concave fixture as test/navmesh.test.ts (see that file's
// comment for the hand-verified triangle decomposition) — duplicated here
// since integration fixtures are self-contained sqlite builders, not shared
// helper imports.
const P0: [number, number] = [0, 0];
const P1: [number, number] = [0, 3];
const P2: [number, number] = [1, 3];
const P3: [number, number] = [1, 1];
const P4: [number, number] = [3, 1];
const P5: [number, number] = [3, 0];
const P6: [number, number] = [0.5, 3]; // boundary node A
const P7: [number, number] = [2.5, 0]; // boundary node B
const P8: [number, number] = [0, 1];
const VERTICES = [P0, P1, P2, P3, P4, P5, P6, P7, P8];
const TRIANGLES = [
  [8, 1, 6], [8, 6, 2], [8, 2, 3],
  [0, 8, 3], [0, 3, 4], [4, 5, 7], [4, 7, 0],
];
const RING = [[0, 0], [1, 0], [3, 0], [3, 0.5], [3, 1], [1, 1], [1, 3], [0, 3], [0, 2.5], [0, 0]];
const NODE_A = nodeIdFor(P6[0], P6[1]);
const NODE_B = nodeIdFor(P7[0], P7[1]);
const STRAIGHT_DISTANCE = Math.round(haversine(P6[0], P6[1], P7[0], P7[1]));

describe('navmesh_regions consumption (integration)', () => {
  // Dedicated subdirectory, not the shared ./test/fixtures root — node --test
  // runs test files concurrently (separate processes) but they'd otherwise
  // all scan the same directory (RoutingDatabase.init() globs *.sqlite), so
  // this file's fixtures must not collide with routing.test.ts's.
  const fixturesDir = './test/fixtures/navmesh';
  const navmeshDbPath = path.join(fixturesDir, 'test_navmesh.sqlite');
  const plainDbPath = path.join(fixturesDir, 'test_navmesh_plain.sqlite');
  let db: RoutingDatabase;
  let engine: RoutingEngine;

  before(async () => {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    for (const p of [navmeshDbPath, plainDbPath, path.join(fixturesDir, 'user-edits.sqlite')]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    // --- navmesh fixture: two boundary nodes joined by a Phase-1-style
    // straight-line edge_kind_id=1 fallback edge, plus the navmesh_regions
    // row precomputeFunnelEdges should upgrade that edge from. ---
    const navDb = new DatabaseSync(navmeshDbPath);
    const run = (sql: string, params: unknown[] = []) => navDb.prepare(sql).run(...(params as any[]));

    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date)
         VALUES ('TEST', 'Navmesh Test Region', 'L-shaped concave fixture', '2026-01-01T00:00:00Z')`);

    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [NODE_A, P6[0], P6[1]]);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [NODE_B, P7[0], P7[1]]);

    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.2, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
      edge_kind_id INTEGER DEFAULT 0
    )`);
    run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES
      (?, ?, ?, 5.0, 20.0, 10.0, 1.0, 500, 0, 0, 1)`, [NODE_A, NODE_B, STRAIGHT_DISTANCE]);
    run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES
      (?, ?, ?, 5.0, 20.0, 10.0, 1.0, 500, 0, 0, 1)`, [NODE_B, NODE_A, STRAIGHT_DISTANCE]);

    run(`CREATE TABLE navmesh_regions (
      id INTEGER PRIMARY KEY, region_id INTEGER, boundary_geometry TEXT,
      vertices TEXT, triangles TEXT, triangle_adjacency TEXT,
      boundary_node_ids TEXT, depth_ceiling_m REAL
    )`);
    run(`INSERT INTO navmesh_regions (region_id, boundary_geometry, vertices, triangles, triangle_adjacency, boundary_node_ids, depth_ceiling_m)
         VALUES (1, ?, ?, ?, NULL, ?, 5.0)`, [
      JSON.stringify({ type: 'Polygon', coordinates: [RING] }),
      JSON.stringify(VERTICES),
      JSON.stringify(TRIANGLES),
      JSON.stringify([NODE_A, NODE_B]),
    ]);

    navDb.close();

    // --- plain fixture: ordinary graph, no navmesh_regions table at all —
    // tests that loading it alongside the navmesh fixture still degrades
    // gracefully (per-handle table_info probe in db-worker.ts). ---
    const plainDb = new DatabaseSync(plainDbPath);
    const runPlain = (sql: string, params: unknown[] = []) => plainDb.prepare(sql).run(...(params as any[]));
    runPlain(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL
    )`);
    runPlain(`INSERT INTO metadata (country, name, description, last_update_date)
               VALUES ('PLAIN', 'Plain Region', 'No navmesh_regions table', '2026-01-01T00:00:00Z')`);
    const plainA = nodeIdFor(52.0, 5.0);
    const plainB = nodeIdFor(52.01, 5.01);
    runPlain(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    runPlain(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, 52.0, 5.0, 2)`, [plainA]);
    runPlain(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, 52.01, 5.01, 2)`, [plainB]);
    runPlain(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.2, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
      edge_kind_id INTEGER DEFAULT 0
    )`);
    runPlain(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES
      (?, ?, 1400, 5.0, 20.0, 10.0, 0.8, 500, 0, 0, 0)`, [plainA, plainB]);
    runPlain(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES
      (?, ?, 1400, 5.0, 20.0, 10.0, 0.8, 500, 0, 0, 0)`, [plainB, plainA]);
    plainDb.close();

    db = new RoutingDatabase(fixturesDir);
    await db.init();
    await db.loadGraph();
    engine = new RoutingEngine(db, DEFAULT_CONFIG);
    engine.setVesselDimensions({ draft: 0, beam: 4, airDraft: 0 });
  });

  after(async () => {
    await db.close();
    for (const p of [navmeshDbPath, plainDbPath, path.join(fixturesDir, 'user-edits.sqlite')]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('loads the navmesh_regions row and the plain (Phase-0-style) DB alongside it without error', async () => {
    assert.strictEqual(db.getNavmeshRegions().length, 1);
  });

  it('upgrades the straight-line fallback edge to the funnel-computed distance', async () => {
    const edge = db.getEdgeSync(NODE_A, NODE_B);
    assert.ok(edge, 'fallback edge should exist');
    assert.ok(edge!.distance > STRAIGHT_DISTANCE,
      `expected funnel distance > straight-line ${STRAIGHT_DISTANCE}, got ${edge!.distance}`);
    assert.ok(edge!.path_points && edge!.path_points.length > 0, 'expected an interior polyline on the upgraded edge');
  });

  it('calculateRoute between the two boundary nodes returns a bent path at the funnel distance, not the straight-line one', async () => {
    // Offset a few meters from the exact node coordinates so findNearestNode
    // (not an exact hit) resolves them, same as a real user click would.
    const route = await engine.calculateRoute({
      start: { latitude: P6[0] - 0.0001, longitude: P6[1] },
      end: { latitude: P7[0] + 0.0001, longitude: P7[1] },
      minCoastDistance: 0,
    });
    assert.ok(route.features.length >= 1);
    const totalCoords = route.features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
    assert.ok(totalCoords > 3, `expected a bent multi-point route, got ${totalCoords} coordinates`);
    assert.ok(route.totalDistance! > STRAIGHT_DISTANCE,
      `expected funnel-length route > straight-line ${STRAIGHT_DISTANCE}, got ${route.totalDistance}`);
  });

  it('routes directly via the same-region funnel fast path when both endpoints are inside the region interior (no graph traversal)', async () => {
    // Bottom arm (x:1-3,y:0-1) and left column (x:0-1,y:0-3) of the L —
    // neither point is near an existing graph node.
    const route = await engine.calculateRoute({
      start: { latitude: 0.5, longitude: 2 },
      end: { latitude: 2, longitude: 0.5 },
      minCoastDistance: 0,
    });
    // Each polyline hop of the bent funnel path becomes its own per-segment
    // feature (splitToSegmentFeatures splits on segments, not on the whole
    // route) — a bent path spanning N points yields N-1 features. The taut
    // (correct) path around this L's reflex corner is exactly 3 points —
    // start, the corner at P3=(1,1), end — i.e. 2 features / 4 coordinates
    // total. A buggy funnel that hugs extra portal vertices instead of
    // cutting straight to the corner would produce more than that; a
    // straight 2-point line (no bend at all) would incorrectly cut through
    // the L's missing notch. This is a direct regression guard for the
    // left/right portal-vertex swap bug fixed in navmesh.ts's funnel()
    // (see NEXT_PHASES.md Phase 2 Hardening Round 3).
    assert.strictEqual(route.features.length, 2, `expected exactly one bend (2 features), got ${route.features.length}`);
    const totalCoords = route.features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
    assert.strictEqual(totalCoords, 4, `expected the minimal taut bent path (4 coordinates), got ${totalCoords}`);
    const [startLon, startLat] = route.features[0].geometry.coordinates[0];
    assert.ok(Math.abs(startLat - 0.5) < 1e-9 && Math.abs(startLon - 2) < 1e-9,
      'route should start exactly at the requested interior point');
    const [bendLon, bendLat] = route.features[0].geometry.coordinates[1];
    assert.ok(Math.abs(bendLat - P3[0]) < 1e-6 && Math.abs(bendLon - P3[1]) < 1e-6,
      `expected the bend to sit exactly at the reflex corner P3=(${P3[0]},${P3[1]}), got (${bendLat},${bendLon})`);
    const directDistance = haversine(0.5, 2, P3[0], P3[1]) + haversine(P3[0], P3[1], 2, 0.5);
    assert.ok(Math.abs(route.totalDistance! - directDistance) < 1,
      `expected the taut two-segment distance ~${directDistance.toFixed(1)}m, got ${route.totalDistance}m (inflation indicates the funnel is hugging extra vertices)`);
  });

  it('non-navmesh routing on the plain fixture is unaffected', async () => {
    const route = await engine.calculateRoute({
      start: { latitude: 52.0, longitude: 5.0 },
      end: { latitude: 52.01, longitude: 5.01 },
      minCoastDistance: 0,
    });
    assert.strictEqual(route.type, 'FeatureCollection');
    assert.ok(route.totalDistance! > 0);
  });
});

// ---------------------------------------------------------------------------
// Boundary-shortcut-sparsification regression (NEXT_PHASES.md). Real regions
// have hundreds of ring-order boundary nodes by design (§1.3's k-NN chords
// were deliberately abandoned in favor of ring-adjacency) — the confirmed
// live-scenario regression was: (a) a fixed boundary-node-count precompute
// cap silently disabled navmesh consumption entirely above 150 nodes, and
// (b) even without the cap, ring-adjacency edges alone never gave two
// *distant* boundary nodes a cheap way to reach each other, forcing the
// router to zigzag the whole fine ring. This fixture is an NxN grid
// triangulation (a real interior mesh, not a single-hub fan — a fan's
// triangle-dual graph is topologically just the ring again, no shortcut is
// geometrically reachable through it) whose perimeter alone already exceeds
// the old cap, with only ring-adjacency edges pre-populated between
// perimeter nodes (mirroring the real pipeline output) — so any interior
// shortcut found here can only have come from `addAnchorShortcutEdges`.
// ---------------------------------------------------------------------------

describe('navmesh boundary-shortcut sparsification (regression)', () => {
  const fixturesDir = './test/fixtures/navmesh-large';
  const dbPath = path.join(fixturesDir, 'test_navmesh_large.sqlite');
  const N = 40; // (N+1)x(N+1) vertex grid; perimeter = 4N = 160, past the old 150-node cap
  const STEP_DEG = 0.002;

  const idx = (r: number, c: number) => r * (N + 1) + c;
  const vertices: Array<[number, number]> = [];
  for (let r = 0; r <= N; r++) {
    for (let c = 0; c <= N; c++) vertices.push([r * STEP_DEG, c * STEP_DEG]);
  }
  const triangles: Array<[number, number, number]> = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      triangles.push([idx(r, c), idx(r, c + 1), idx(r + 1, c + 1)]);
      triangles.push([idx(r, c), idx(r + 1, c + 1), idx(r + 1, c)]);
    }
  }

  // Perimeter, walked in ring order: bottom row L->R, right column B->T,
  // top row R->L, left column T->B (each corner counted once).
  const perimeterIdx: number[] = [];
  for (let c = 0; c < N; c++) perimeterIdx.push(idx(0, c));
  for (let r = 0; r < N; r++) perimeterIdx.push(idx(r, N));
  for (let c = N; c > 0; c--) perimeterIdx.push(idx(N, c));
  for (let r = N; r > 0; r--) perimeterIdx.push(idx(r, 0));
  const PERIMETER_COUNT = perimeterIdx.length; // 4N = 160

  const rimNodeIds = perimeterIdx.map(i => nodeIdFor(vertices[i][0], vertices[i][1]));
  const ringCoords = [...perimeterIdx, perimeterIdx[0]].map(i => [vertices[i][1], vertices[i][0]]);

  let db: RoutingDatabase;
  let warnings: string[] = [];
  let originalWarn: typeof console.warn;

  before(async () => {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    const overlayPath = path.join(fixturesDir, 'user-edits.sqlite');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(overlayPath)) fs.unlinkSync(overlayPath);

    const sdb = new DatabaseSync(dbPath);
    const run = (sql: string, params: unknown[] = []) => sdb.prepare(sql).run(...(params as any[]));

    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date)
         VALUES ('TEST', 'Large Navmesh Region', '(N+1)x(N+1) grid, 160-node perimeter', '2026-01-01T00:00:00Z')`);

    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.2, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
      edge_kind_id INTEGER DEFAULT 0
    )`);

    for (let i = 0; i < PERIMETER_COUNT; i++) {
      const [lat, lon] = vertices[perimeterIdx[i]];
      run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [rimNodeIds[i], lat, lon]);
    }
    // Only ring-adjacency edges — same as the real pipeline's output — no
    // pre-existing shortcuts between non-adjacent perimeter nodes.
    for (let i = 0; i < PERIMETER_COUNT; i++) {
      const j = (i + 1) % PERIMETER_COUNT;
      const d = haversineMeters(vertices[perimeterIdx[i]][0], vertices[perimeterIdx[i]][1], vertices[perimeterIdx[j]][0], vertices[perimeterIdx[j]][1]);
      run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES
        (?, ?, ?, 5.0, -1, -1, 1.0, 9999, 0, 0, 1)`, [rimNodeIds[i], rimNodeIds[j], d]);
      run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES
        (?, ?, ?, 5.0, -1, -1, 1.0, 9999, 0, 0, 1)`, [rimNodeIds[j], rimNodeIds[i], d]);
    }

    run(`CREATE TABLE navmesh_regions (
      id INTEGER PRIMARY KEY, region_id INTEGER, boundary_geometry TEXT,
      vertices TEXT, triangles TEXT, triangle_adjacency TEXT,
      boundary_node_ids TEXT, depth_ceiling_m REAL
    )`);
    run(`INSERT INTO navmesh_regions (region_id, boundary_geometry, vertices, triangles, triangle_adjacency, boundary_node_ids, depth_ceiling_m)
         VALUES (1, ?, ?, ?, NULL, ?, 5.0)`, [
      JSON.stringify({ type: 'Polygon', coordinates: [ringCoords] }),
      JSON.stringify(vertices),
      JSON.stringify(triangles),
      JSON.stringify(rimNodeIds),
    ]);
    sdb.close();

    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

    db = new RoutingDatabase(fixturesDir);
    await db.init();
    await db.loadGraph();
  });

  after(async () => {
    console.warn = originalWarn;
    await db.close();
    const overlayPath = path.join(fixturesDir, 'user-edits.sqlite');
    for (const p of [dbPath, overlayPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('never disables navmesh consumption via a boundary-node-count cap (the confirmed regression)', () => {
    assert.ok(!warnings.some(w => w.includes('exceeds precompute cap')),
      `expected no precompute-cap warning, got: ${JSON.stringify(warnings)}`);
  });

  it('bounds anchor count well below the full boundary-node set', () => {
    const region = db.getNavmeshRegions()[0];
    assert.strictEqual(region.boundaryNodeIds.length, PERIMETER_COUNT);
    assert.ok(region.anchorNodeIds.length <= 40, `expected <=40 anchors, got ${region.anchorNodeIds.length}`);
    assert.ok(region.anchorNodeIds.length > 1);
  });

  it('gives two opposite-corner boundary nodes a direct single-hop edge, not a ~80-hop ring walk', () => {
    // (0,0) and (N,N) are on opposite sides of the perimeter — with only
    // ring-adjacency edges (the pre-fix graph), reaching one from the other
    // requires walking ~half the perimeter (PERIMETER_COUNT/2 = 80 hops).
    // The actual point of `addAnchorShortcutEdges` is turning that into a
    // single precomputed edge; how close that edge's *distance* gets to the
    // true geometric diagonal depends on navmesh.ts's corridor-search/funnel
    // quality for a given mesh shape (out of scope here — validated
    // separately against the real Zeeland pipeline output), so this only
    // asserts the direct hop exists and isn't a pathological blow-up.
    const oppositePos = Math.floor(PERIMETER_COUNT / 2);
    const nodeA = rimNodeIds[0];
    const nodeB = rimNodeIds[oppositePos];
    const [latA, lonA] = vertices[perimeterIdx[0]];
    const [latB, lonB] = vertices[perimeterIdx[oppositePos]];
    const chord = haversineMeters(latA, lonA, latB, lonB);

    const edge = db.getEdgeSync(nodeA, nodeB);
    assert.ok(edge, 'expected a direct edge between opposite-corner nodes after the anchor-shortcut pass');
    assert.ok(edge!.distance < chord * 2,
      `expected a bounded shortcut distance, got ${edge!.distance}m (chord ${chord}m)`);
  });
});

// ---------------------------------------------------------------------------
// Round 9 master finding regression: a navmesh region with empty
// boundary_node_ids (the exact real-world shape found in zeeland.sqlite,
// where the pipeline never populates it for depth-split regions) must warn
// loudly instead of silently skipping the funnel-edge upgrade — see
// NEXT_PHASES.md, "Design question: warn on empty boundaryNodeIds".
// ---------------------------------------------------------------------------

describe('empty boundary_node_ids (Round 9 warn-on-empty)', () => {
  const fixturesDir = './test/fixtures/navmesh-empty-boundary';
  const dbPath = path.join(fixturesDir, 'test_empty_boundary.sqlite');

  let db: RoutingDatabase;
  let warnings: string[] = [];
  let originalWarn: typeof console.warn;

  before(async () => {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    const overlayPath = path.join(fixturesDir, 'user-edits.sqlite');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(overlayPath)) fs.unlinkSync(overlayPath);

    const sdb = new DatabaseSync(dbPath);
    const run = (sql: string, params: unknown[] = []) => sdb.prepare(sql).run(...(params as any[]));

    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date)
         VALUES ('TEST', 'Empty Boundary Region', 'depth-split region with no boundary_node_ids', '2026-01-01T00:00:00Z')`);
    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.2, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
      edge_kind_id INTEGER DEFAULT 0
    )`);
    run(`CREATE TABLE navmesh_regions (
      id INTEGER PRIMARY KEY, region_id INTEGER, boundary_geometry TEXT,
      vertices TEXT, triangles TEXT, triangle_adjacency TEXT,
      boundary_node_ids TEXT, depth_ceiling_m REAL
    )`);
    // region_id=1 duplicated across rows mirrors the real generated
    // database (region_id is not a unique key there — see the "load index"
    // note in database.ts's precomputeFunnelEdges warning).
    run(`INSERT INTO navmesh_regions (region_id, boundary_geometry, vertices, triangles, triangle_adjacency, boundary_node_ids, depth_ceiling_m)
         VALUES (1, ?, ?, ?, NULL, '[]', 6.0)`, [
      JSON.stringify({ type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] }),
      JSON.stringify([[0, 0], [0, 1], [1, 1], [1, 0]]),
      JSON.stringify([[0, 1, 2], [0, 2, 3]]),
    ]);
    sdb.close();

    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

    db = new RoutingDatabase(fixturesDir);
    await db.init();
    await db.loadGraph();
  });

  after(async () => {
    console.warn = originalWarn;
    await db.close();
    const overlayPath = path.join(fixturesDir, 'user-edits.sqlite');
    for (const p of [dbPath, overlayPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('loads the region with zero boundary nodes rather than erroring', () => {
    assert.strictEqual(db.getNavmeshRegions().length, 1);
    assert.strictEqual(db.getNavmeshRegions()[0].boundaryNodeIds.length, 0);
  });

  it('warns loudly instead of silently skipping the funnel-edge upgrade', () => {
    assert.ok(warnings.some(w => w.includes('no') && w.includes('boundary_node_ids')),
      `expected a per-region empty-boundary warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(warnings.some(w => w.includes('1/1') && w.includes('empty')),
      `expected a summary warning, got: ${JSON.stringify(warnings)}`);
  });
});

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
