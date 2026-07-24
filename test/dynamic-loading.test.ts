import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

// §4a — dynamic database loading (PHASE_4_DESIGN.md). Covers:
//  (a) non-dynamic mode is unaffected — already covered by every other
//      *.test.js file staying green with `new RoutingDatabase(dir)` left at
//      its own constructor default (false; DEFAULT_CONFIG.dynamicLoading
//      itself defaults to true as of 2026-07-20, but those tests construct
//      RoutingDatabase directly and never read that config field); not
//      re-tested here.
//  (b) dynamic mode: init() peeks without loading; a route request inside
//      a not-yet-loaded database's bbox triggers an inline on-demand load
//      and returns the same result as the non-dynamic bulk-load path.
//  (c) load -> unload -> reload keeps the graph consistent: node/edge
//      counts (including synthetic funnel/anchor-shortcut edges) return to
//      their pre-load values, no leak.
//  (d) unload refuses to drop the last loaded database.

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

// §4a task 3 (coverageIndex-as-single-source-of-truth refactor) regression:
// getCoverageStatus() (GET .../databases/status's sibling per-file state
// inspector), getLoadingStatus() (GET .../databases/status), and
// getDatabaseCatalog() (GET .../databases) all derive from coverageIndex
// alone, so the set of "loaded" filenames each one reports must always
// agree — assert that after a load and after an unload. Sorted before
// comparing: coverageIndex's Map iteration order is discovery/insertion
// order, not load-completion order, and this assertion is about set
// membership, not ordering.
async function loadedFilenamesFromAllReadModels(db: RoutingDatabase): Promise<{
  coverage: string[]; loadingStatus: string[]; catalog: string[];
}> {
  const coverage = db.getCoverageStatus()
    .filter(s => s.state === 'loaded')
    .map(s => s.filename)
    .sort();
  const loadingStatus = [...db.getLoadingStatus().filenames].sort();
  const catalog = (await db.getDatabaseCatalog())
    .filter(d => d.state === 'loaded')
    .map(d => d.filename)
    .sort();
  return { coverage, loadingStatus, catalog };
}

async function assertReadModelsConsistent(db: RoutingDatabase, expectedLoaded: string[]): Promise<void> {
  const expected = [...expectedLoaded].sort();
  const { coverage, loadingStatus, catalog } = await loadedFilenamesFromAllReadModels(db);
  assert.deepStrictEqual(coverage, expected, 'getCoverageStatus() loaded filenames mismatch');
  assert.deepStrictEqual(loadingStatus, expected, 'getLoadingStatus().filenames mismatch');
  assert.deepStrictEqual(catalog, expected, 'getDatabaseCatalog() filenames mismatch');
}

// Region A: a 4-boundary-node square, triangulated along one diagonal —
// enough for addAnchorShortcutEdges to synthesize genuine new in-memory
// edges (not just upgrade an existing one): the 4 perimeter pairs already
// have a real Phase-1 edge_kind_id=1 DB edge between them (ring-adjacent,
// only upgraded in place), but the 2 *diagonal* pairs (V0<->V2, V1<->V3) do
// not — those can only come from addFunnelShortcutEdge, making them a
// clean synthetic-edge-leak detector for the unload path.
const V0: [number, number] = [10, 10];
const V1: [number, number] = [10, 11];
const V2: [number, number] = [11, 11];
const V3: [number, number] = [11, 10];
const VERTICES = [V0, V1, V2, V3];
const TRIANGLES = [[0, 3, 2], [0, 2, 1]];
const RING = [V0, V1, V2, V3, V0];
const REGION_A_NODE_IDS = VERTICES.map(([lat, lon]) => nodeIdFor(lat, lon));
const REGION_A_BBOX = { min_lat: 9.9, min_lon: 9.9, max_lat: 11.1, max_lon: 11.1 };

// Region B: a trivial 2-node plain graph, far from region A, no
// navmesh_regions table at all — exists purely so region A can be unloaded
// without tripping the "would leave zero loaded databases" guard, and so
// the on-demand trigger (test b) has a database it should NOT touch.
const C: [number, number] = [50, 50];
const D: [number, number] = [50.01, 50.01];
const REGION_B_BBOX = { min_lat: 49.9, min_lon: 49.9, max_lat: 50.1, max_lon: 50.1 };

// M4/M6 spatial-index refactor (database.ts) differential check: the exact
// set of nodes both fixture databases contain, known independently of
// RoutingDatabase's internals (this is just the same VERTICES/C/D the
// fixture builder above inserts into the two sqlite files). Used below to
// brute-force an expected answer for the grid-backed query methods
// (findNearestNode/getNodesInRadius/findKNearestMainGraphNodes/
// getNodesInBBox) without touching RoutingDatabase's private `nodes` map —
// a from-scratch reference computed the same way the pre-refactor full-scan
// code computed it, so a passing test proves the grid is not silently
// dropping or misplacing candidates (the exact failure mode a cos(lat)
// under-correction or an incremental-update bug would produce).
const KNOWN_NODES: Array<{ id: number; lat: number; lon: number }> = [
  ...VERTICES.map(([lat, lon], i) => ({ id: REGION_A_NODE_IDS[i], lat, lon })),
  { id: nodeIdFor(C[0], C[1]), lat: C[0], lon: C[1] },
  { id: nodeIdFor(D[0], D[1]), lat: D[0], lon: D[1] },
];

function bruteForceNearest(lat: number, lon: number, maxDist: number): number | null {
  let bestId: number | null = null;
  let bestDist = maxDist;
  for (const n of KNOWN_NODES) {
    const d = haversine(lat, lon, n.lat, n.lon);
    if (d < bestDist) { bestDist = d; bestId = n.id; }
  }
  return bestId;
}

function bruteForceWithinRadius(lat: number, lon: number, radius: number): Array<{ id: number; distance: number }> {
  return KNOWN_NODES
    .map(n => ({ id: n.id, distance: haversine(lat, lon, n.lat, n.lon) }))
    .filter(n => n.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

describe('§4a dynamic database loading', () => {
  const fixturesDir = './test/fixtures/dynamic-loading';
  const regionAPath = path.join(fixturesDir, 'region-a.sqlite');
  const regionBPath = path.join(fixturesDir, 'region-b.sqlite');
  const overlayPath = path.join(fixturesDir, 'user-edits.sqlite');

  function buildFixtures(): void {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    for (const p of [regionAPath, regionBPath, overlayPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    const a = new DatabaseSync(regionAPath, { open: true });
    const runA = (sql: string, params: unknown[] = []) => a.prepare(sql).run(...(params as any[]));
    runA(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL,
      bounding_box TEXT
    )`);
    runA(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box)
          VALUES ('TESTA', 'Dynamic Loading Region A', 'Synthetic square+diagonal fixture', '2026-01-01T00:00:00Z', ?)`,
      [JSON.stringify(REGION_A_BBOX)]);
    runA(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    for (const [i, [lat, lon]] of VERTICES.entries()) {
      runA(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [REGION_A_NODE_IDS[i], lat, lon]);
    }
    runA(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.0, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
      edge_kind_id INTEGER DEFAULT 0
    )`);
    // Perimeter only (ring-adjacency) — V0-V1, V1-V2, V2-V3, V3-V0, both directions.
    const perimeter: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 0]];
    for (const [i, j] of perimeter) {
      const d = Math.round(haversine(VERTICES[i][0], VERTICES[i][1], VERTICES[j][0], VERTICES[j][1]));
      runA(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES (?, ?, ?, 5.0, 20.0, 10.0, 1.0, 500, 0, 0, 1)`,
        [REGION_A_NODE_IDS[i], REGION_A_NODE_IDS[j], d]);
      runA(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES (?, ?, ?, 5.0, 20.0, 10.0, 1.0, 500, 0, 0, 1)`,
        [REGION_A_NODE_IDS[j], REGION_A_NODE_IDS[i], d]);
    }
    runA(`CREATE TABLE navmesh_regions (
      id INTEGER PRIMARY KEY, region_id INTEGER, boundary_geometry TEXT,
      vertices TEXT, triangles TEXT, triangle_adjacency TEXT,
      boundary_node_ids TEXT, depth_ceiling_m REAL
    )`);
    runA(`INSERT INTO navmesh_regions (region_id, boundary_geometry, vertices, triangles, triangle_adjacency, boundary_node_ids, depth_ceiling_m)
          VALUES (1, ?, ?, ?, NULL, ?, 5.0)`, [
      JSON.stringify({ type: 'Polygon', coordinates: [RING] }),
      JSON.stringify(VERTICES),
      JSON.stringify(TRIANGLES),
      JSON.stringify(REGION_A_NODE_IDS),
    ]);
    a.close();

    const b = new DatabaseSync(regionBPath, { open: true });
    const runB = (sql: string, params: unknown[] = []) => b.prepare(sql).run(...(params as any[]));
    runB(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL,
      bounding_box TEXT
    )`);
    runB(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box)
          VALUES ('TESTB', 'Dynamic Loading Region B', 'Plain 2-node fixture, far from A', '2026-01-01T00:00:00Z', ?)`,
      [JSON.stringify(REGION_B_BBOX)]);
    const cId = nodeIdFor(C[0], C[1]);
    const dId = nodeIdFor(D[0], D[1]);
    runB(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    runB(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 2)`, [cId, C[0], C[1]]);
    runB(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 2)`, [dId, D[0], D[1]]);
    runB(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.0, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
      edge_kind_id INTEGER DEFAULT 0
    )`);
    const dCD = Math.round(haversine(C[0], C[1], D[0], D[1]));
    runB(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES (?, ?, ?, 5.0, 20.0, 10.0, 1.0, 500, 0, 0, 0)`,
      [cId, dId, dCD]);
    runB(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES (?, ?, ?, 5.0, 20.0, 10.0, 1.0, 500, 0, 0, 0)`,
      [dId, cId, dCD]);
    b.close();
  }

  function cleanupFixtures(): void {
    for (const p of [regionAPath, regionBPath, overlayPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  describe('(b) on-demand load on a route request', () => {
    let dynDb: RoutingDatabase;
    let staticDb: RoutingDatabase;

    before(async () => {
      buildFixtures();
      dynDb = new RoutingDatabase(fixturesDir, true);
      await dynDb.init();
      await dynDb.loadGraph(); // no-op in dynamic mode
    });

    after(async () => {
      await dynDb.close();
      if (staticDb!) await staticDb.close();
      cleanupFixtures();
    });

    it('init() peeks metadata/coverage without loading any database', () => {
      const status = dynDb.getCoverageStatus();
      const byFilename = new Map(status.map(s => [s.filename, s]));
      assert.strictEqual(byFilename.get('region-a.sqlite')?.state, 'not_loaded');
      assert.strictEqual(byFilename.get('region-b.sqlite')?.state, 'not_loaded');
      assert.deepStrictEqual(byFilename.get('region-a.sqlite')?.coverage, REGION_A_BBOX);
      assert.deepStrictEqual(byFilename.get('region-b.sqlite')?.coverage, REGION_B_BBOX);
    });

    it('peekMetadata reports real node/edge/POI counts for not-yet-loaded databases', () => {
      const status = dynDb.getCoverageStatus();
      const byFilename = new Map(status.map(s => [s.filename, s]));
      // Region A: 4 perimeter nodes, 8 directed edges (4 pairs x 2 directions), no pois table.
      assert.deepStrictEqual(byFilename.get('region-a.sqlite')?.stats, { nodes: 4, edges: 8, pois: 0 });
      // Region B: 2 nodes, 2 directed edges (C->D and D->C), no pois table.
      assert.deepStrictEqual(byFilename.get('region-b.sqlite')?.stats, { nodes: 2, edges: 2, pois: 0 });
    });

    it('a route request inside region A triggers an inline on-demand load, and matches the non-dynamic route', async () => {
      const dynEngine = new RoutingEngine(dynDb, DEFAULT_CONFIG);
      dynEngine.setVesselDimensions({ draft: 0, beam: 4, airDraft: 0 });

      const request = {
        start: { latitude: V0[0] - 0.0001, longitude: V0[1] },
        end: { latitude: V2[0] + 0.0001, longitude: V2[1] },
        minCoastDistance: 0,
      };

      const dynRoute = await dynEngine.calculateRoute(request);
      assert.ok(dynRoute.totalDistance! > 0, 'expected a non-empty on-demand route');

      // Region A loaded on demand; region B was never touched by this request.
      const status = new Map(dynDb.getCoverageStatus().map(s => [s.filename, s.state]));
      assert.strictEqual(status.get('region-a.sqlite'), 'loaded');
      assert.strictEqual(status.get('region-b.sqlite'), 'not_loaded');

      // Same request against the non-dynamic bulk-load path (both files
      // loaded up front, today's default behavior) must produce the same
      // route — dynamic loading changes *when* data is loaded, never what
      // routing computes from it.
      staticDb = new RoutingDatabase(fixturesDir, false);
      await staticDb.init();
      await staticDb.loadGraph();
      const staticEngine = new RoutingEngine(staticDb, DEFAULT_CONFIG);
      staticEngine.setVesselDimensions({ draft: 0, beam: 4, airDraft: 0 });
      const staticRoute = await staticEngine.calculateRoute(request);

      assert.strictEqual(dynRoute.totalDistance, staticRoute.totalDistance);
      assert.deepStrictEqual(
        dynRoute.features.map(f => f.geometry.coordinates),
        staticRoute.features.map(f => f.geometry.coordinates),
      );
    });
  });

  describe('(c)/(d) load -> unload -> reload cycle, and the last-loaded-database guard', () => {
    let db: RoutingDatabase;
    let baseline: { nodes: number; edges: number; pois: number };
    let baselineEdgesBySourceSize: number;

    before(async () => {
      buildFixtures();
      db = new RoutingDatabase(fixturesDir, true);
      await db.init();
      await db.loadGraph();
    });

    after(async () => {
      await db.close();
      cleanupFixtures();
    });

    it('loads both databases explicitly via loadDatabaseGraph', async () => {
      await db.loadDatabaseGraph('region-a.sqlite');
      await db.loadDatabaseGraph('region-b.sqlite');
      const status = new Map(db.getCoverageStatus().map(s => [s.filename, s.state]));
      assert.strictEqual(status.get('region-a.sqlite'), 'loaded');
      assert.strictEqual(status.get('region-b.sqlite'), 'loaded');

      baseline = await db.getStats();
      baselineEdgesBySourceSize = db.getEdgesBySourceSize();
      // 4 nodes (region A) + 2 nodes (region B) = 6.
      assert.strictEqual(baseline.nodes, 6);
      // Region A: 4 ring edges x2 directions (8) + 2 diagonal shortcuts x2
      // directions (4, synthetic — see addFunnelShortcutEdge) = 12.
      // Region B: 2 directed edges. Total = 14.
      assert.strictEqual(baseline.edges, 14);
      assert.strictEqual(db.getNavmeshRegions().length, 1);
      // 4 distinct region-A source nodes + 2 distinct region-B source nodes.
      assert.strictEqual(baselineEdgesBySourceSize, 6);
    });

    it('§4a task 3: after a load, getCoverageStatus/getLoadingStatus/getDatabaseCatalog agree on the loaded set', async () => {
      await assertReadModelsConsistent(db, ['region-a.sqlite', 'region-b.sqlite']);
    });

    it('the diagonal V0<->V2 pair is a genuine synthetic edge, not a DB row', async () => {
      const edge = db.getEdgeSync(REGION_A_NODE_IDS[0], REGION_A_NODE_IDS[2]);
      assert.ok(edge, 'expected addFunnelShortcutEdge to have synthesized V0->V2');
      assert.strictEqual(edge!.edge_kind_id, 1 /* EDGE_KIND_NAVMESH_BOUNDARY */);
    });

    // Spatial-index refactor (database.ts M4/M6) differential check: with
    // both databases loaded (region A's 4 nodes around (10-11, 10-11) and
    // region B's 2 nodes around (50, 50)), the grid-backed query methods
    // must agree exactly with an independent brute-force computation over
    // the fixture's own known node list — proving the grid never drops a
    // candidate the old full scan would have found (the failure mode a
    // missing cos(lat) longitude correction, an off-by-one cell range, or a
    // stale incremental-update would produce).
    it('spatial-index refactor: grid-backed queries agree with an independent brute-force check', async () => {
      // Deliberately off-center/off-diagonal: the exact center (10.5,10.5)
      // and the exact C-D midpoint (50.005,50.005) are precise geometric
      // ties between two fixture nodes (equal haversine distance to the
      // double, e.g. V0 and V1 both at lon 10.5) — a real but order-
      // dependent ambiguity that the old full-scan code resolved by Map
      // insertion order and the grid-backed code may resolve differently
      // (different candidate visiting order), without either being "wrong"
      // (same minimal distance either way). Picking points with a strictly
      // closest node sidesteps that inherent ambiguity so this test asserts
      // real candidate-set correctness, not arbitrary tie-breaking order.
      const queryPoints: Array<[number, number]> = [
        [10.4, 10.6],     // inside region A's square, off-center — V1 uniquely nearest
        [10, 10],         // exactly on V0
        [10.999, 10.001], // just inside V3's corner
        [50.006, 50.004], // near region B's C/D pair, off their midpoint — D uniquely nearest
        [0, 0],           // farther than maxDist from every known node
      ];

      for (const [lat, lon] of queryPoints) {
        const expectedNearest = bruteForceNearest(lat, lon, 500000);
        const actualNearest = await db.findNearestNode(lat, lon, 500000);
        assert.strictEqual(actualNearest, expectedNearest, `findNearestNode mismatch at (${lat},${lon})`);

        const expectedRadius = bruteForceWithinRadius(lat, lon, 500000).map(n => n.id);
        const actualRadius = (await db.getNodesInRadius(lat, lon, 500000)).map(n => n.id);
        assert.deepStrictEqual(actualRadius, expectedRadius, `getNodesInRadius mismatch at (${lat},${lon})`);

        // Every KNOWN_NODES entry has a non-zero region_id (region A: 1,
        // region B: 2), so findKNearestMainGraphNodes's c.regionId===0 skip
        // never excludes any of them here — same candidate set as above.
        const expectedK = bruteForceWithinRadius(lat, lon, 500000).slice(0, 3).map(n => n.id);
        const actualK = (await db.findKNearestMainGraphNodes(lat, lon, 3, 500000)).map(n => n.id);
        assert.deepStrictEqual(actualK, expectedK, `findKNearestMainGraphNodes mismatch at (${lat},${lon})`);
      }

      // Box query: region A's own bbox should return exactly its 4 nodes,
      // none of region B's (which sit at (50,50), nowhere near this box).
      const bboxResult = await db.getNodesInBBox(9.9, 9.9, 11.1, 11.1, 100);
      assert.deepStrictEqual(
        bboxResult.map(n => n.id).sort((a, b) => a - b),
        [...REGION_A_NODE_IDS].sort((a, b) => a - b),
      );

      // hasNodeWithinRadius sanity check (also grid-backed — findNearestEdge's
      // sibling method, unconverted by M4 but exercising the same grid).
      assert.strictEqual(db.hasNodeWithinRadius(10.5, 10.5, 500000), true);
      assert.strictEqual(db.hasNodeWithinRadius(0, 0, 1000), false);
    });

    it('routes across the fixture while both databases are loaded', async () => {
      const engine = new RoutingEngine(db, DEFAULT_CONFIG);
      engine.setVesselDimensions({ draft: 0, beam: 4, airDraft: 0 });
      const route = await engine.calculateRoute({
        start: { latitude: V0[0] - 0.0001, longitude: V0[1] },
        end: { latitude: V2[0] + 0.0001, longitude: V2[1] },
        minCoastDistance: 0,
      });
      assert.ok(route.totalDistance! > 0);
    });

    it('unloadDatabaseGraph removes exactly one database\'s nodes/edges/regions, including synthetic ones', async () => {
      const result = await db.unloadDatabaseGraph('region-a.sqlite');
      assert.strictEqual(result.nodesRemoved, 4);
      assert.strictEqual(result.edgesRemoved, 12);

      const stats = await db.getStats();
      assert.strictEqual(stats.nodes, 2, 'only region B\'s 2 nodes should remain');
      assert.strictEqual(stats.edges, 2, 'only region B\'s 2 edges should remain');
      assert.strictEqual(db.getNavmeshRegions().length, 0, 'region A\'s navmesh region should be gone');
      assert.strictEqual(db.getEdgesBySourceSize(), baselineEdgesBySourceSize - 4,
        'edgesBySource should have exactly region B\'s 2 source keys left');

      const status = new Map(db.getCoverageStatus().map(s => [s.filename, s.state]));
      assert.strictEqual(status.get('region-a.sqlite'), 'not_loaded');
      assert.strictEqual(status.get('region-b.sqlite'), 'loaded');
    });

    it('§4a task 3: after an unload, all three read models shrink together consistently', async () => {
      await assertReadModelsConsistent(db, ['region-b.sqlite']);
    });

    it('(d) refuses to unload the only remaining loaded database', async () => {
      await assert.rejects(
        () => db.unloadDatabaseGraph('region-b.sqlite'),
        /only loaded database/i,
      );
      // Still loaded — the rejected call must not have partially mutated state.
      const status = new Map(db.getCoverageStatus().map(s => [s.filename, s.state]));
      assert.strictEqual(status.get('region-b.sqlite'), 'loaded');
    });

    it('reload brings region A back to byte-for-byte the same counts as the original load', async () => {
      await db.loadDatabaseGraph('region-a.sqlite');

      const status = new Map(db.getCoverageStatus().map(s => [s.filename, s.state]));
      assert.strictEqual(status.get('region-a.sqlite'), 'loaded');

      const stats = await db.getStats();
      assert.deepStrictEqual(stats, baseline);
      assert.strictEqual(db.getEdgesBySourceSize(), baselineEdgesBySourceSize);
      assert.strictEqual(db.getNavmeshRegions().length, 1);

      // The diagonal synthetic edge exists again post-reload.
      const edge = db.getEdgeSync(REGION_A_NODE_IDS[0], REGION_A_NODE_IDS[2]);
      assert.ok(edge, 'expected the synthetic shortcut to be recreated on reload');
    });

    it('routes correctly again after the reload', async () => {
      const engine = new RoutingEngine(db, DEFAULT_CONFIG);
      engine.setVesselDimensions({ draft: 0, beam: 4, airDraft: 0 });
      const route = await engine.calculateRoute({
        start: { latitude: V0[0] - 0.0001, longitude: V0[1] },
        end: { latitude: V2[0] + 0.0001, longitude: V2[1] },
        minCoastDistance: 0,
      });
      assert.ok(route.totalDistance! > 0);
    });
  });

  describe('§4a M5: bounded working set (maxLoadedRegions LRU cap)', () => {
    it('maxLoadedRegions=0 (default) keeps every loaded region — no eviction', async () => {
      buildFixtures();
      const db = new RoutingDatabase(fixturesDir, true, 0);
      try {
        await db.init();
        await db.loadGraph(); // no-op in dynamic mode

        await db.loadDatabaseGraph('region-a.sqlite');
        await db.loadDatabaseGraph('region-b.sqlite');

        // Drive a route (beginRoute/endRoute) exactly like RoutingEngine
        // does, then give the fire-and-forget enforcement pass a chance to
        // run via the test seam — with the cap off it must be a no-op.
        db.beginRoute();
        db.endRoute();
        await db.enforceRegionCapForTest();

        const status = new Map(db.getCoverageStatus().map(s => [s.filename, s.state]));
        assert.strictEqual(status.get('region-a.sqlite'), 'loaded');
        assert.strictEqual(status.get('region-b.sqlite'), 'loaded');
      } finally {
        await db.close();
        cleanupFixtures();
      }
    });

    it('maxLoadedRegions=1 evicts the least-recently-used region once a route completes', async () => {
      buildFixtures();
      const db = new RoutingDatabase(fixturesDir, true, 1);
      try {
        await db.init();
        await db.loadGraph(); // no-op in dynamic mode

        // Load region A first (older), then region B (more recently used —
        // loadDatabaseGraphInner touches recency on every successful load).
        await db.loadDatabaseGraph('region-a.sqlite');
        await db.loadDatabaseGraph('region-b.sqlite');

        let status = new Map(db.getCoverageStatus().map(s => [s.filename, s.state]));
        assert.strictEqual(status.get('region-a.sqlite'), 'loaded');
        assert.strictEqual(status.get('region-b.sqlite'), 'loaded');

        // Simulate a route finishing: beginRoute/endRoute is exactly the
        // wrapper RoutingEngine.calculateRoute uses around a search
        // (routing.ts). enforceRegionCap() is fire-and-forget off endRoute,
        // so await the public test seam for a deterministic assertion point
        // rather than racing the background pass.
        db.beginRoute();
        db.endRoute();
        await db.enforceRegionCapForTest();

        status = new Map(db.getCoverageStatus().map(s => [s.filename, s.state]));
        assert.strictEqual(status.get('region-a.sqlite'), 'not_loaded',
          'region A is the least-recently-used region and should be evicted');
        assert.strictEqual(status.get('region-b.sqlite'), 'loaded',
          'region B was more recently used and should be the one kept');

        const loadedCount = db.getCoverageStatus().filter(s => s.state === 'loaded').length;
        assert.strictEqual(loadedCount, 1, 'loaded count should be trimmed to the cap');
      } finally {
        await db.close();
        cleanupFixtures();
      }
    });

    it('a route in progress blocks eviction — enforceRegionCap no-ops while activeRouteCount > 0', async () => {
      buildFixtures();
      const db = new RoutingDatabase(fixturesDir, true, 1);
      try {
        await db.init();
        await db.loadGraph();

        await db.loadDatabaseGraph('region-a.sqlite');
        await db.loadDatabaseGraph('region-b.sqlite');

        // beginRoute() without a matching endRoute() simulates a route still
        // in flight — enforcement must not evict anything while that holds.
        db.beginRoute();
        await db.enforceRegionCapForTest();

        const status = new Map(db.getCoverageStatus().map(s => [s.filename, s.state]));
        assert.strictEqual(status.get('region-a.sqlite'), 'loaded');
        assert.strictEqual(status.get('region-b.sqlite'), 'loaded');

        // Ending the route now (activeRouteCount -> 0) allows the next
        // enforcement pass to trim as usual.
        db.endRoute();
        await db.enforceRegionCapForTest();
        const after = new Map(db.getCoverageStatus().map(s => [s.filename, s.state]));
        assert.strictEqual(after.get('region-a.sqlite'), 'not_loaded');
        assert.strictEqual(after.get('region-b.sqlite'), 'loaded');
      } finally {
        await db.close();
        cleanupFixtures();
      }
    });
  });

  describe('unload rejects unknown filenames', () => {
    it('loadDatabaseGraph/unloadDatabaseGraph reject a filename the coverage index has never seen', async () => {
      buildFixtures();
      const db = new RoutingDatabase(fixturesDir, true);
      try {
        await db.init();
        await assert.rejects(() => db.loadDatabaseGraph('does-not-exist.sqlite'), /Unknown database/);
        await assert.rejects(() => db.unloadDatabaseGraph('does-not-exist.sqlite'), /Unknown database/);
      } finally {
        await db.close();
        cleanupFixtures();
      }
    });
  });

  describe('§4a.1 task 4 — transit-region on-demand loading', () => {
    // Three plain (non-navmesh) regions in a west-to-east line:
    // TRANSIT-START -- TRANSIT-MID -- TRANSIT-END. A route request from a
    // point inside TRANSIT-START to a point inside TRANSIT-END has no
    // waypoint anywhere near TRANSIT-MID, but the search bounding box (the
    // start-end chord, expanded by margin, capped by routingBBoxMaxExtent)
    // spans clean across it — reproducing the live bug this task fixes:
    // before ensureRegionsForBbox, TRANSIT-MID never loaded and a route
    // drew a straight chord across it instead of a shot at routing through
    // it. The route computation itself is expected to fail here (the three
    // regions' graphs aren't connected to each other), which is fine — the
    // assertion is about *loading*, not route success.
    const transitDir = './test/fixtures/dynamic-loading-transit';
    const startPath = path.join(transitDir, 'transit-start.sqlite');
    const midPath = path.join(transitDir, 'transit-mid.sqlite');
    const endPath = path.join(transitDir, 'transit-end.sqlite');

    const START_BBOX = { min_lat: 9.9, min_lon: 9.9, max_lat: 11.1, max_lon: 11.1 };
    const MID_BBOX = { min_lat: 9.9, min_lon: 14.9, max_lat: 11.1, max_lon: 16.1 };
    const END_BBOX = { min_lat: 9.9, min_lon: 19.9, max_lat: 11.1, max_lon: 21.1 };

    function buildPlainRegion(
      dbPath: string, country: string, bbox: typeof START_BBOX,
      pointA: [number, number], pointB: [number, number],
    ): void {
      const sdb = new DatabaseSync(dbPath, { open: true });
      const run = (sql: string, params: unknown[] = []) => sdb.prepare(sql).run(...(params as any[]));
      run(`CREATE TABLE metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL,
        bounding_box TEXT
      )`);
      run(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box)
           VALUES (?, ?, 'Transit-loading fixture', '2026-01-01T00:00:00Z', ?)`,
        [country, `Transit region ${country}`, JSON.stringify(bbox)]);
      const idA = nodeIdFor(pointA[0], pointA[1]);
      const idB = nodeIdFor(pointB[0], pointB[1]);
      run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
      run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [idA, pointA[0], pointA[1]]);
      run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [idB, pointB[0], pointB[1]]);
      run(`CREATE TABLE edges (
        source INTEGER, target INTEGER, distance REAL,
        min_depth REAL, max_air_draft REAL, min_width REAL,
        cost_factor REAL DEFAULT 1.0, distance_to_land REAL,
        edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
        edge_kind_id INTEGER DEFAULT 0
      )`);
      const d = Math.round(haversine(pointA[0], pointA[1], pointB[0], pointB[1]));
      run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES (?, ?, ?, 5.0, 20.0, 10.0, 1.0, 500, 0, 0, 0)`,
        [idA, idB, d]);
      run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id) VALUES (?, ?, ?, 5.0, 20.0, 10.0, 1.0, 500, 0, 0, 0)`,
        [idB, idA, d]);
      sdb.close();
    }

    let transitDb: RoutingDatabase;

    before(async () => {
      if (!fs.existsSync(transitDir)) fs.mkdirSync(transitDir, { recursive: true });
      for (const p of [startPath, midPath, endPath]) if (fs.existsSync(p)) fs.unlinkSync(p);
      buildPlainRegion(startPath, 'TSTART', START_BBOX, [10.4, 10.4], [10.6, 10.6]);
      buildPlainRegion(midPath, 'TMID', MID_BBOX, [10.4, 15.4], [10.6, 15.6]);
      buildPlainRegion(endPath, 'TEND', END_BBOX, [10.4, 20.4], [10.6, 20.6]);

      transitDb = new RoutingDatabase(transitDir, true);
      await transitDb.init();
      await transitDb.loadGraph(); // no-op in dynamic mode
    });

    after(async () => {
      await transitDb.close();
      for (const p of [startPath, midPath, endPath]) if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    it('a route request loads a transited region with no start/dest/via waypoint inside it', async () => {
      const before = new Map(transitDb.getCoverageStatus().map(s => [s.filename, s.state]));
      assert.strictEqual(before.get('transit-start.sqlite'), 'not_loaded');
      assert.strictEqual(before.get('transit-mid.sqlite'), 'not_loaded');
      assert.strictEqual(before.get('transit-end.sqlite'), 'not_loaded');

      const engine = new RoutingEngine(transitDb, DEFAULT_CONFIG);
      engine.setVesselDimensions({ draft: 0, beam: 4, airDraft: 0 });

      const start = { latitude: 10.5, longitude: 10.5 }; // inside transit-start, nowhere near mid/end
      const end = { latitude: 10.5, longitude: 20.5 };    // inside transit-end, nowhere near mid/start

      try {
        await engine.calculateRoute({ start, end, minCoastDistance: 0 });
      } catch {
        // Expected: the three regions' graphs are disconnected from each
        // other, so no actual path exists. Loading — the thing under test
        // — happens up front, before the search runs, regardless.
      }

      const after = new Map(transitDb.getCoverageStatus().map(s => [s.filename, s.state]));
      assert.strictEqual(after.get('transit-start.sqlite'), 'loaded', 'start region should load (waypoint containment)');
      assert.strictEqual(after.get('transit-end.sqlite'), 'loaded', 'end region should load (waypoint containment)');
      assert.strictEqual(
        after.get('transit-mid.sqlite'), 'loaded',
        'transit region — no waypoint inside it, but on the direct path between start and end — should load too (§4a.1 task 4)',
      );
    });
  });
});
