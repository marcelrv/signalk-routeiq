import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase, POI_TYPE_HARBOUR, POI_TYPE_LOCK, POI_TYPE_BRIDGE } from '../dist/database.js';
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

// M?: getEdgesInBBox/getPoisInBBox/getNearestPoi spatial-index (edgeGrid/
// poiGrid) differential check. Two POIs inside region A's square, one inside
// region B's bbox — known independently of RoutingDatabase's internals (this
// is exactly what the fixture builder below inserts into the pois tables),
// used to brute-force an expected getPoisInBBox/getNearestPoi answer without
// touching the private poiGrid/pois fields.
const POI_A1 = { id: 9001, name: 'Region A Harbour', typeId: POI_TYPE_HARBOUR, lat: 10.3, lon: 10.7 };
const POI_A2 = { id: 9002, name: 'Region A Lock', typeId: POI_TYPE_LOCK, lat: 10.85, lon: 10.15 };
const POI_B1 = { id: 9101, name: 'Region B Bridge', typeId: POI_TYPE_BRIDGE, lat: 50.004, lon: 50.006 };
const KNOWN_POIS = [POI_A1, POI_A2, POI_B1];

function bruteForcePoisInBBox(minLat: number, minLon: number, maxLat: number, maxLon: number): typeof KNOWN_POIS {
  return KNOWN_POIS
    .filter(p => p.lat >= minLat && p.lat <= maxLat && p.lon >= minLon && p.lon <= maxLon)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function bruteForceNearestPoi(lat: number, lon: number, maxDist: number): number | null {
  let bestId: number | null = null;
  let bestDist = Infinity;
  for (const p of KNOWN_POIS) {
    const d = haversine(lat, lon, p.lat, p.lon);
    if (d < bestDist && d <= maxDist) { bestDist = d; bestId = p.id; }
  }
  return bestId;
}

/** Grid-free reference for getEdgesInBBox: walks exactly the same node set
 *  the old full scan effectively walked (every source node with at least one
 *  outgoing edge) via the public getOutgoingEdges() accessor — never touches
 *  the private edgeGrid/edgesBySource fields — and applies the identical
 *  endpoint-in-bbox test getEdgesInBBox itself uses. `nodeIds` must include
 *  every loaded source node or this under-counts. */
async function bruteForceEdgesInBBox(
  db: RoutingDatabase, nodeIds: number[],
  minLat: number, minLon: number, maxLat: number, maxLon: number,
): Promise<Array<{ source: number; target: number }>> {
  const results: Array<{ source: number; target: number }> = [];
  for (const id of nodeIds) {
    const edges = await db.getOutgoingEdges(id);
    for (const e of edges) {
      const slat = (e as any).source_lat ?? 0;
      const slon = (e as any).source_lon ?? 0;
      if ((slat >= minLat && slat <= maxLat && slon >= minLon && slon <= maxLon) ||
          (e.lat >= minLat && e.lat <= maxLat && e.lon >= minLon && e.lon <= maxLon)) {
        results.push({ source: e.source, target: e.target });
      }
    }
  }
  return results;
}

function sortPairs(pairs: Array<{ source: number; target: number }>): Array<{ source: number; target: number }> {
  return [...pairs].sort((a, b) => a.source - b.source || a.target - b.target);
}

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
    runA(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    for (const p of [POI_A1, POI_A2]) {
      runA(`INSERT INTO pois (id, name, type_id, properties, lat, lon) VALUES (?, ?, ?, NULL, ?, ?)`,
        [p.id, p.name, p.typeId, p.lat, p.lon]);
    }
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
    runB(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    runB(`INSERT INTO pois (id, name, type_id, properties, lat, lon) VALUES (?, ?, ?, NULL, ?, ?)`,
      [POI_B1.id, POI_B1.name, POI_B1.typeId, POI_B1.lat, POI_B1.lon]);
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
      // Region A: 4 perimeter nodes, 8 directed edges (4 pairs x 2 directions), 2 POIs.
      assert.deepStrictEqual(byFilename.get('region-a.sqlite')?.stats, { nodes: 4, edges: 8, pois: 2 });
      // Region B: 2 nodes, 2 directed edges (C->D and D->C), 1 POI.
      assert.deepStrictEqual(byFilename.get('region-b.sqlite')?.stats, { nodes: 2, edges: 2, pois: 1 });
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

    // Edge/POI spatial-index refactor (database.ts poiGrid/edgeGrid, #8)
    // differential check: with both databases loaded, the grid-backed
    // getEdgesInBBox/getPoisInBBox/getNearestPoi must agree exactly with a
    // grid-free reference — bruteForceEdgesInBBox (walks getOutgoingEdges()
    // per known node, a public accessor, never touching the private
    // edgeGrid/edgesBySource) and bruteForcePoisInBBox/bruteForceNearestPoi
    // (computed directly from the fixture's own known POI list, never
    // touching the private poiGrid/pois fields).
    it('edge/POI spatial index: grid-backed queries agree with a grid-free brute-force reference', async () => {
      const allKnownNodeIds = KNOWN_NODES.map(n => n.id);

      const bboxCases: Array<[number, number, number, number, string]> = [
        [REGION_A_BBOX.min_lat, REGION_A_BBOX.min_lon, REGION_A_BBOX.max_lat, REGION_A_BBOX.max_lon, 'region A only'],
        [REGION_B_BBOX.min_lat, REGION_B_BBOX.min_lon, REGION_B_BBOX.max_lat, REGION_B_BBOX.max_lon, 'region B only'],
        // Union box spanning both regions' coordinate ranges.
        [9.9, 9.9, 50.1, 50.1, 'union of A and B'],
        // Overlaps neither region.
        [20, 20, 21, 21, 'empty'],
      ];

      for (const [minLat, minLon, maxLat, maxLon, label] of bboxCases) {
        const expectedEdges = sortPairs(await bruteForceEdgesInBBox(db, allKnownNodeIds, minLat, minLon, maxLat, maxLon));
        const actualEdges = sortPairs((await db.getEdgesInBBox(minLat, minLon, maxLat, maxLon, 5000))
          .map(e => ({ source: e.source, target: e.target })));
        assert.deepStrictEqual(actualEdges, expectedEdges, `getEdgesInBBox mismatch (${label})`);

        const expectedPois = bruteForcePoisInBBox(minLat, minLon, maxLat, maxLon).map(p => p.id);
        const actualPois = (await db.getPoisInBBox(minLat, minLon, maxLat, maxLon, 2000)).map(p => p.id);
        assert.deepStrictEqual(actualPois, expectedPois, `getPoisInBBox mismatch (${label})`);
      }

      // Sanity: region A's box is non-empty and distinct from region B's —
      // otherwise the equality checks above would pass vacuously.
      assert.ok((await db.getEdgesInBBox(REGION_A_BBOX.min_lat, REGION_A_BBOX.min_lon, REGION_A_BBOX.max_lat, REGION_A_BBOX.max_lon)).length > 0);
      assert.ok((await db.getPoisInBBox(REGION_A_BBOX.min_lat, REGION_A_BBOX.min_lon, REGION_A_BBOX.max_lat, REGION_A_BBOX.max_lon)).length > 0);

      const nearestCases: Array<[number, number, number, string]> = [
        [10.31, 10.69, 5000, 'near POI A1'],
        [10.84, 10.16, 5000, 'near POI A2'],
        [50.003, 50.005, 5000, 'near POI B1'],
        [0, 0, 1000, 'far from every POI'],
      ];
      for (const [lat, lon, maxDist, label] of nearestCases) {
        const expected = bruteForceNearestPoi(lat, lon, maxDist);
        const actual = await db.getNearestPoi(lat, lon, maxDist);
        assert.strictEqual(actual?.id ?? null, expected, `getNearestPoi mismatch (${label})`);
      }
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

    // Cache-invalidation proof (database.ts invalidateBBoxCaches, #8): the
    // previous test already built poiGrid/edgeGrid while BOTH databases were
    // loaded (via getEdgesInBBox/getPoisInBBox/getNearestPoi in the
    // "edge/POI spatial index" test above). If unloadDatabaseGraph failed to
    // call invalidateBBoxCaches(), these caches would still be the
    // both-loaded snapshot and region A's now-evicted edges/POIs would
    // wrongly still appear here.
    it('unloading a database invalidates the poiGrid/edgeGrid caches — stale results would fail this', async () => {
      const edgesInRegionA = await db.getEdgesInBBox(
        REGION_A_BBOX.min_lat, REGION_A_BBOX.min_lon, REGION_A_BBOX.max_lat, REGION_A_BBOX.max_lon,
      );
      assert.deepStrictEqual(edgesInRegionA, [], 'region A\'s edges must be gone from getEdgesInBBox post-unload');

      const poisInRegionA = await db.getPoisInBBox(
        REGION_A_BBOX.min_lat, REGION_A_BBOX.min_lon, REGION_A_BBOX.max_lat, REGION_A_BBOX.max_lon,
      );
      assert.deepStrictEqual(poisInRegionA, [], 'region A\'s POIs must be gone from getPoisInBBox post-unload');

      const nearestNearA1 = await db.getNearestPoi(POI_A1.lat, POI_A1.lon, 5000);
      assert.strictEqual(nearestNearA1, null, 'POI A1 must no longer be found by getNearestPoi post-unload');

      // Region B is unaffected — its edges/POI must still be reported.
      const edgesInRegionB = await db.getEdgesInBBox(
        REGION_B_BBOX.min_lat, REGION_B_BBOX.min_lon, REGION_B_BBOX.max_lat, REGION_B_BBOX.max_lon,
      );
      assert.strictEqual(edgesInRegionB.length, 2, 'region B\'s 2 edges should still be reported');

      const nearestNearB1 = await db.getNearestPoi(POI_B1.lat, POI_B1.lon, 5000);
      assert.strictEqual(nearestNearB1?.id, POI_B1.id, 'POI B1 should still be found by getNearestPoi');
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

      // Reload's own invalidateBBoxCaches() call (loadDatabaseGraphInner)
      // means the grid-backed bbox queries see region A's edges/POIs again
      // too, not just getEdgeSync/getStats — a stale poiGrid/edgeGrid built
      // during the region-B-only window would still show region A empty here.
      const poisInRegionA = await db.getPoisInBBox(
        REGION_A_BBOX.min_lat, REGION_A_BBOX.min_lon, REGION_A_BBOX.max_lat, REGION_A_BBOX.max_lon,
      );
      assert.deepStrictEqual(poisInRegionA.map(p => p.id).sort(), [POI_A1.id, POI_A2.id].sort());

      const nearestNearA1 = await db.getNearestPoi(POI_A1.lat, POI_A1.lon, 5000);
      assert.strictEqual(nearestNearA1?.id, POI_A1.id);
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

    // #9 regression: unloadDatabaseGraph must not leave a dangling overlay
    // edge behind when the node it points at gets evicted with the region
    // being unloaded. Placed last in this describe block (both databases are
    // loaded again here — region A was just reloaded above, region B was
    // never unloaded) so it doesn't disturb the load/unload/reload ordering
    // the earlier tests in this block depend on.
    it('#9: an overlay edge dangling into an evicted region\'s node is cleaned up on unload', async () => {
      // A region-B node (source) and a region-A node (target), both
      // currently loaded — exactly what a graph-editor "connect node" action
      // does (see api.ts's addEdge(0, ...) call sites), and exactly what
      // addEdge requires (it throws if either endpoint isn't in `nodes`).
      const bNodeId = nodeIdFor(C[0], C[1]);
      const dNodeId = nodeIdFor(D[0], D[1]);
      const aNodeId = REGION_A_NODE_IDS[3]; // V3 — untouched by the routing tests above (which use V0/V2)

      await db.addEdge(0, { source: bNodeId, target: aNodeId, distance: 0 });

      // Confirm the overlay edge is present while both regions are loaded.
      const beforeEdge = db.getEdgeSync(bNodeId, aNodeId);
      assert.ok(beforeEdge, 'expected the overlay edge to be present while both regions are loaded');
      const outgoingBefore = await db.getOutgoingEdges(bNodeId);
      assert.ok(outgoingBefore.some(e => e.target === aNodeId),
        'expected getOutgoingEdges(bNode) to include the overlay edge');
      // Region B's own pre-existing C->D edge must also be there, as a
      // baseline for the "still present after unload" check below.
      assert.ok(outgoingBefore.some(e => e.target === dNodeId),
        'expected region B\'s own C->D edge to be present before unload');

      // Evict region A: node V3 (aNodeId) gets deleted (its refcount hits
      // zero), which would leave the overlay edge above dangling unless
      // unloadDatabaseGraph's cleanup pass (the #9 fix) sweeps it out.
      await db.unloadDatabaseGraph('region-a.sqlite');

      assert.strictEqual(db.getEdgeSync(bNodeId, aNodeId), null,
        'the overlay edge pointing at the now-evicted region-A node must be gone, not dangling');
      const outgoingAfter = await db.getOutgoingEdges(bNodeId);
      assert.ok(!outgoingAfter.some(e => e.target === aNodeId),
        'getOutgoingEdges(bNode) must no longer contain an edge targeting the removed region-A node');

      // Region B's own intact edge must have survived the cleanup pass —
      // proof the sweep only removes edges with a missing endpoint, not
      // every edge touching a source that also happened to have a dangling
      // one.
      assert.ok(outgoingAfter.some(e => e.target === dNodeId),
        'region B\'s own C->D edge must survive the dangling-edge cleanup pass');

      // Restore region A so this shared `db` instance ends the describe
      // block loaded the same way it would have without this test.
      await db.loadDatabaseGraph('region-a.sqlite');
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
