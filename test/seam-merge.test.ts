import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

// Cross-database seam merge — the runtime half of the build-time stitching
// mechanism (signalk-router-pipeline/STITCHING_DESIGN.md §8-§10.8).
//
// Adjacent region files are built with an overlap band against one shared
// seam-node registry, so a seam node authored in both files gets the same
// coordinate-hash id in both. loadDatabaseGraph is what turns that into a
// connected graph: a node id already present is merged rather than
// re-inserted, and both files' edges out of it are unioned.
//
// Measured across the Zeeland fixtures and all 12 real US East Coast region
// pairs, that union is correct (missing = 0, syntheticExtra = 0 everywhere)
// but the merge does NOT de-duplicate: where both files hold the *same* edge
// out of a shared node, the merged adjacency carries it twice (CT<->RI 24,506
// duplicate entries, DE<->NJ 1,820, and 62 of 211 shared nodes on the Zeeland
// pair). This fixture is the committed regression home for both halves —
// until now that verification lived only in throwaway harness scripts in the
// pipeline repo's local_only/.
//
// Geometry: a single collinear channel at lat 52, crossing a seam at lon 5.00,
// with a spur off the seam node on each side. West and east files overlap on
// the band 4.98-5.07, so S0 and S1 are authored by both.
//
//   WS(51.99,5.00)              ES(52.01,5.00)
//        \                          /
//   W0 -- W1 -- S0 ============== S1 -- E0 -- E1
//  4.90  4.95  5.00            5.05  5.10  5.15
//        west only  |  shared  |  east only
//
// S0 and S1 are in both files, and so is the S0<->S1 edge between them (the
// duplicate candidate). Each file also holds one edge out of S0 the other
// does not (S0->W1 and S0->WS west, S0->ES east) — the union candidates.

// Deterministic node ID formula per routing-database-format-specification.md
// §2.7. Coastal (type_int 0), so the type term drops out.
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

type Pt = { lat: number; lon: number };
const P = (lat: number, lon: number): Pt => ({ lat, lon });

// West-file-exclusive
const W0 = P(52.00, 4.90);
const W1 = P(52.00, 4.95);
const WS = P(51.99, 5.00);
// Shared across both files (the seam)
const S0 = P(52.00, 5.00);
const S1 = P(52.00, 5.05);
// East-file-exclusive
const ES = P(52.01, 5.00);
const E0 = P(52.00, 5.10);
const E1 = P(52.00, 5.15);

const ID = {
  W0: nodeIdFor(W0.lat, W0.lon), W1: nodeIdFor(W1.lat, W1.lon), WS: nodeIdFor(WS.lat, WS.lon),
  S0: nodeIdFor(S0.lat, S0.lon), S1: nodeIdFor(S1.lat, S1.lon),
  ES: nodeIdFor(ES.lat, ES.lon), E0: nodeIdFor(E0.lat, E0.lon), E1: nodeIdFor(E1.lat, E1.lon),
};

const WEST_NODES: Array<[string, Pt]> = [['W0', W0], ['W1', W1], ['WS', WS], ['S0', S0], ['S1', S1]];
const EAST_NODES: Array<[string, Pt]> = [['S0', S0], ['S1', S1], ['ES', ES], ['E0', E0], ['E1', E1]];

// Undirected pairs; the builder writes both directions of each. S0<->S1 is
// the one edge both files hold, written into each identically — everything
// else is exclusive to its side.
const WEST_EDGES: Array<[Pt, Pt]> = [[W0, W1], [W1, S0], [S0, WS], [S0, S1]];
const EAST_EDGES: Array<[Pt, Pt]> = [[S0, S1], [S0, ES], [S1, E0], [E0, E1]];

const WEST_BBOX = { min_lat: 51.98, min_lon: 4.88, max_lat: 52.02, max_lon: 5.07 };
const EAST_BBOX = { min_lat: 51.98, min_lon: 4.98, max_lat: 52.02, max_lon: 5.17 };

/** Every (source,target) pair either file authors, in both directions —
 *  the reference for "no synthetic edge was invented at the seam". */
function expectedDirectedPairs(): Set<string> {
  const pairs = new Set<string>();
  for (const [a, b] of [...WEST_EDGES, ...EAST_EDGES]) {
    pairs.add(`${nodeIdFor(a.lat, a.lon)}:${nodeIdFor(b.lat, b.lon)}`);
    pairs.add(`${nodeIdFor(b.lat, b.lon)}:${nodeIdFor(a.lat, a.lon)}`);
  }
  return pairs;
}

/** Undirected connected component containing `start`, walked over the merged
 *  in-memory graph via the public accessor only.
 *
 *  Deliberately undirected, and deliberately not getReachableNodes(): §10.5 of
 *  STITCHING_DESIGN records both traps this avoids. A single-anchor *forward*
 *  reachability probe wrongly reported NJ<->DE and NY<->NJ as 0% crossable —
 *  a shared node with inbound-only edges from one side reaches only the other,
 *  and the seam-nearest anchor can sit in an isolated pond present in both
 *  files. Only full component labelling answers "is this seam crossable". */
async function undirectedComponent(db: RoutingDatabase, start: number, universe: number[]): Promise<Set<number>> {
  const neighbours = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (const id of universe) {
    for (const e of await db.getOutgoingEdges(id)) {
      link(e.source, e.target);
      link(e.target, e.source);
    }
  }
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    for (const n of neighbours.get(queue.pop()!) ?? []) {
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  return seen;
}

/** Adjacency of `id` as a target-id list, one entry per stored edge — so a
 *  duplicated edge shows up as two identical entries rather than collapsing. */
async function adjacencyTargets(db: RoutingDatabase, id: number): Promise<number[]> {
  return (await db.getOutgoingEdges(id)).map(e => e.target).sort((a, b) => a - b);
}

function countOf<T>(items: T[], value: T): number {
  return items.filter(i => i === value).length;
}

describe('cross-database seam merge (STITCHING_DESIGN §8-§10.8)', () => {
  const fixturesDir = './test/fixtures/seam-merge';
  const westPath = path.join(fixturesDir, 'region-west.sqlite');
  const eastPath = path.join(fixturesDir, 'region-east.sqlite');
  const overlayPath = path.join(fixturesDir, 'user-edits.sqlite');

  function buildFile(
    dbPath: string, country: string, name: string, regionId: number,
    bbox: typeof WEST_BBOX, nodes: Array<[string, Pt]>, edges: Array<[Pt, Pt]>,
  ): void {
    const db = new DatabaseSync(dbPath, { open: true });
    const run = (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as any[]));
    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL,
      bounding_box TEXT
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box)
         VALUES (?, ?, 'Seam-merge fixture half', '2026-01-01T00:00:00Z', ?)`,
      [country, name, JSON.stringify(bbox)]);
    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    for (const [, p] of nodes) {
      run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, ?)`,
        [nodeIdFor(p.lat, p.lon), p.lat, p.lon, regionId]);
    }
    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.0, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
      edge_kind_id INTEGER DEFAULT 0
    )`);
    // Both directions, identical attributes on both sides of the seam — a
    // real build gives the two files the same values for a shared edge, which
    // is what makes "keep one copy" a safe fix rather than a lossy one.
    for (const [a, b] of edges) {
      const d = Math.round(haversine(a.lat, a.lon, b.lat, b.lon));
      for (const [from, to] of [[a, b], [b, a]]) {
        run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id)
             VALUES (?, ?, ?, 12.0, 40.0, 50.0, 1.0, 500, 0, 0, 0)`,
          [nodeIdFor(from.lat, from.lon), nodeIdFor(to.lat, to.lon), d]);
      }
    }
    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    db.close();
  }

  function buildFixtures(): void {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    for (const p of [westPath, eastPath]) if (fs.existsSync(p)) fs.unlinkSync(p);
    buildFile(westPath, 'SEAMW', 'Seam Fixture West', 1, WEST_BBOX, WEST_NODES, WEST_EDGES);
    buildFile(eastPath, 'SEAME', 'Seam Fixture East', 2, EAST_BBOX, EAST_NODES, EAST_EDGES);
  }

  function cleanupFixtures(): void {
    // The overlay is created by init(), not by the builder — leaving it
    // behind would carry any user-edit rows into the next run's merge.
    for (const p of [westPath, eastPath, overlayPath]) if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  describe('both halves loaded: node merge, edge union, de-duplication', () => {
    let db: RoutingDatabase;

    before(async () => {
      buildFixtures();
      db = new RoutingDatabase(fixturesDir, true);
      await db.init();
      await db.loadGraph();
      await db.loadDatabaseGraph('region-west.sqlite');
      await db.loadDatabaseGraph('region-east.sqlite');
    });

    after(async () => {
      await db.close();
      cleanupFixtures();
    });

    it('a seam node authored by both files is one node, present once in the spatial grid', async () => {
      // 8 distinct coordinates across two 5-node files: the 2 shared ones
      // must have merged rather than landed twice.
      const stats = await db.getStats();
      assert.strictEqual(stats.nodes, 8, 'expected 5 + 5 nodes with 2 shared to merge to 8');

      for (const [key, p] of [['S0', S0], ['S1', S1]] as Array<[keyof typeof ID, Pt]>) {
        const node = db.getNodeSync(ID[key]);
        assert.ok(node, `${key} should resolve after both files are loaded`);
        assert.strictEqual(node!.lat, p.lat);
        assert.strictEqual(node!.lon, p.lon);
      }

      // A double grid insert would return the same id twice here — the M6
      // failure mode the merge path guards against with its isNewNode check.
      const within = await db.getNodesInRadius(S0.lat, S0.lon, 50);
      const s0Hits = within.filter(n => n.id === ID.S0);
      assert.strictEqual(s0Hits.length, 1, 'S0 must appear exactly once in a grid-backed radius query');
    });

    it('union: a shared node carries the edges exclusive to each file', async () => {
      // The half of the merge that is already correct, and the half real
      // multi-region routing depends on: without it, whichever file loaded
      // second would lose its edges out of the seam node.
      const targets = await adjacencyTargets(db, ID.S0);
      for (const [key, side] of [['W1', 'west'], ['WS', 'west'], ['ES', 'east'], ['S1', 'both']] as Array<[keyof typeof ID, string]>) {
        assert.ok(targets.includes(ID[key]), `S0's merged adjacency is missing its ${side} edge to ${key}`);
      }
      const s1Targets = await adjacencyTargets(db, ID.S1);
      assert.ok(s1Targets.includes(ID.E0), "S1's merged adjacency is missing its east-only edge to E0");
      assert.ok(s1Targets.includes(ID.S0), "S1's merged adjacency is missing its edge back to S0");
    });

    it('no synthetic edge is invented at the seam — every merged edge is one a file authored', async () => {
      // The stitching mechanism is build-time only; the deferred runtime
      // proximity matcher (WS1) was never built and must not appear to have
      // been. Any pair here that no file wrote would be exactly that.
      const expected = expectedDirectedPairs();
      const universe = Object.values(ID);
      const unexpected: string[] = [];
      for (const id of universe) {
        for (const e of await db.getOutgoingEdges(id)) {
          const key = `${e.source}:${e.target}`;
          if (!expected.has(key)) unexpected.push(key);
        }
      }
      assert.deepStrictEqual(unexpected, [], 'merged graph holds an edge neither file authored');
    });

    // KNOWN OPEN DEFECT — the merge unions but never de-duplicates, so an
    // edge both files author is stored twice out of the shared node. Not a
    // correctness bug (A* just re-relaxes a neighbour it has already settled)
    // but it inflates the adjacency of precisely the nodes every cross-region
    // route must traverse, and CT<->RI's 24,506 duplicate entries show it is
    // not a rounding-error quantity. Remove the `todo` flag with the dedupe
    // fix in database.ts's loadDatabaseGraphInner.
    it('de-duplication: an edge both files author is stored once', { todo: 'dedupe on (source,target) is not implemented yet' }, async () => {
      const targets = await adjacencyTargets(db, ID.S0);
      assert.strictEqual(countOf(targets, ID.S1), 1, 'S0->S1 is authored by both files and should be stored once');
      assert.strictEqual(targets.length, 4, 'S0 should have exactly 4 outgoing edges: W1, WS, ES, S1');

      const s1Targets = await adjacencyTargets(db, ID.S1);
      assert.strictEqual(countOf(s1Targets, ID.S0), 1, 'S1->S0 is authored by both files and should be stored once');
      assert.strictEqual(s1Targets.length, 2, 'S1 should have exactly 2 outgoing edges: S0, E0');
    });

    it('documents the duplication that is there today, so the fix has to update this test', async () => {
      // Deliberately asserts the *current* behaviour, paired with the todo
      // above: whichever way the dedupe fix lands, one of these two tests
      // fails until both are updated together — the duplication cannot be
      // changed silently, in either direction.
      const targets = await adjacencyTargets(db, ID.S0);
      assert.strictEqual(countOf(targets, ID.S1), 2, 'expected the known duplicate S0->S1 (one per file)');
      assert.strictEqual(targets.length, 5, 'expected 4 distinct targets with S1 duplicated');
    });
  });

  describe('the seam is crossable, and a route across it is routed rather than teleported', () => {
    let db: RoutingDatabase;

    before(async () => {
      buildFixtures();
      db = new RoutingDatabase(fixturesDir, true);
      await db.init();
      await db.loadGraph();
      await db.loadDatabaseGraph('region-west.sqlite');
      await db.loadDatabaseGraph('region-east.sqlite');
    });

    after(async () => {
      await db.close();
      cleanupFixtures();
    });

    it('one undirected component holds nodes exclusive to both files', async () => {
      const component = await undirectedComponent(db, ID.W0, Object.values(ID));
      assert.ok(component.has(ID.E1), 'W0 and E1 are exclusive to opposite files and must share a component');
      // Every fixture node is on the one channel, so the component is all 8 —
      // a partial component would mean the seam merged but left an island.
      assert.strictEqual(component.size, 8, 'expected a single component spanning both files');
    });

    it('a route from the west half to the east half crosses the seam on real edges', async () => {
      const engine = new RoutingEngine(db, DEFAULT_CONFIG);
      engine.setVesselDimensions({ draft: 0, beam: 4, airDraft: 0 });

      const route = await engine.calculateRoute({
        start: { latitude: W0.lat, longitude: W0.lon },
        end: { latitude: E1.lat, longitude: E1.lon },
        minCoastDistance: 0,
      });
      assert.ok(route.totalDistance! > 0, 'expected a non-empty cross-seam route');

      // §9.3: an unstitched seam does not fail loudly — routeiq projects the
      // start onto the nearest reachable waterway, which may be on the far
      // side, and joins it with a straight line (measured 3,485-4,597 m legs
      // carrying minDepth -1). Route distance alone therefore proves nothing;
      // assert the seam nodes are actually on the path.
      const coords: Array<[number, number]> = [];
      for (const f of route.features ?? []) {
        const g: any = f.geometry;
        if (g?.type === 'LineString') coords.push(...g.coordinates);
      }
      const hits = (p: Pt) => coords.some(([lon, lat]) =>
        Math.abs(lat - p.lat) < 1e-6 && Math.abs(lon - p.lon) < 1e-6);
      assert.ok(hits(S0), 'route should pass through seam node S0');
      assert.ok(hits(S1), 'route should pass through seam node S1');

      // Straight-line W0->E1 is ~17 km along the channel the fixture lays out,
      // so a routed answer is close to it. A teleport would not be.
      const straight = haversine(W0.lat, W0.lon, E1.lat, E1.lon);
      assert.ok(route.totalDistance! < straight * 1.5,
        `expected a routed cross-seam distance near ${Math.round(straight)} m, got ${Math.round(route.totalDistance!)} m`);
    });
  });

  describe('unloading one half keeps what the other half still contributes', () => {
    let db: RoutingDatabase;

    before(async () => {
      buildFixtures();
      db = new RoutingDatabase(fixturesDir, true);
      await db.init();
      await db.loadGraph();
      await db.loadDatabaseGraph('region-west.sqlite');
      await db.loadDatabaseGraph('region-east.sqlite');
      await db.unloadDatabaseGraph('region-west.sqlite');
    });

    after(async () => {
      await db.close();
      cleanupFixtures();
    });

    it('the shared seam nodes survive on the east file\'s contribution', () => {
      // nodeDbCount's refcount: the west file contributed S0/S1 too, but the
      // east file still does, so evicting west must not take them with it.
      assert.ok(db.getNodeSync(ID.S0), 'S0 must survive — the east file also contributes it');
      assert.ok(db.getNodeSync(ID.S1), 'S1 must survive — the east file also contributes it');
    });

    it('west-exclusive nodes and their edges are gone', async () => {
      for (const key of ['W0', 'W1', 'WS'] as Array<keyof typeof ID>) {
        assert.strictEqual(db.getNodeSync(ID[key]), null, `${key} was west-exclusive and should be evicted`);
      }
      const targets = await adjacencyTargets(db, ID.S0);
      assert.ok(!targets.includes(ID.W1), "S0's west-only edge to W1 should be gone");
      assert.ok(!targets.includes(ID.WS), "S0's west-only edge to WS should be gone");
    });

    // THE GUARD THIS FIXTURE EXISTS FOR, alongside the dedupe itself.
    //
    // unloadDatabaseGraph drops edges by `e.dbIndex !== dbIndex`. Today the
    // S0<->S1 edge is stored twice — once tagged west, once east — so evicting
    // west leaves the east copy and the seam survives by accident of the very
    // duplication the dedupe fix removes. Dedupe on (source,target) that keeps
    // only the first contributor's row therefore silently breaks this: the
    // surviving row would still be tagged west and get filtered out here,
    // cutting the seam edge while a file that authors it is still loaded.
    //
    // So the fix needs per-edge contributor ref-counting (the edge-level
    // analogue of nodeDbCount), not just a de-duplicating splice. This test
    // passes today and must keep passing after the fix.
    it('an edge both files authored survives eviction of one of them', async () => {
      const edge = db.getEdgeSync(ID.S0, ID.S1);
      assert.ok(edge, 'S0->S1 is still authored by the loaded east file and must survive the west eviction');
      const back = db.getEdgeSync(ID.S1, ID.S0);
      assert.ok(back, 'S1->S0 is still authored by the loaded east file and must survive the west eviction');
    });

    it('the east half is intact and still connected across the old seam', async () => {
      const component = await undirectedComponent(db, ID.E1, Object.values(ID));
      assert.deepStrictEqual(
        [...component].sort((a, b) => a - b),
        [ID.S0, ID.S1, ID.ES, ID.E0, ID.E1].sort((a, b) => a - b),
        'expected exactly the east file\'s 5 nodes to remain, still one component',
      );
    });
  });
});
