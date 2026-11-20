import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist-tsc/database.js';
import { createDirectoryDatabase } from '../dist-tsc/data-dir.js';
import { RoutingEngine } from '../dist-tsc/routing.js';
import { DEFAULT_CONFIG } from '../dist-tsc/types.js';
import { upgradeToPoiModel } from './poi-model-fixture.js';
import { inputsFor, testOptions } from './engine-helper.js';

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

/** Per-edge attribute overrides, for the one edge both files author. */
type EdgeAttrs = { min_depth?: number; max_air_draft?: number };
type EdgeSpec = [Pt, Pt] | [Pt, Pt, EdgeAttrs];

// Undirected pairs; the builder writes both directions of each. S0<->S1 is
// the one edge both files hold — everything else is exclusive to its side.
//
// The two files deliberately disagree on the shared edge, which a real
// rebuild can leave behind: west says 12 m of depth and a 40 m air draft,
// east says 7.5 m of depth and does not know the air draft (-1, the UNKNOWN
// convention consumers exclude from constraint checks). The merge has to fail
// safe on both counts, and the pair is chosen so that neither "first wins"
// nor "last wins" can produce the expected answer by accident.
const SHARED_DEPTH_WEST = 12.0;
const SHARED_DEPTH_EAST = 7.5;
const SHARED_AIR_DRAFT_WEST = 40.0;
const WEST_EDGES: Array<EdgeSpec> = [
  [W0, W1], [W1, S0], [S0, WS],
  [S0, S1, { min_depth: SHARED_DEPTH_WEST, max_air_draft: SHARED_AIR_DRAFT_WEST }],
];
const EAST_EDGES: Array<EdgeSpec> = [
  [S0, S1, { min_depth: SHARED_DEPTH_EAST, max_air_draft: -1 }],
  [S0, ES], [S1, E0], [E0, E1],
];

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
    bbox: typeof WEST_BBOX, nodes: Array<[string, Pt]>, edges: Array<EdgeSpec>,
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
    // Both directions of each pair, so the fold is exercised on the shared
    // edge in each direction independently.
    for (const [a, b, attrs] of edges as Array<[Pt, Pt, EdgeAttrs | undefined]>) {
      const d = Math.round(haversine(a.lat, a.lon, b.lat, b.lon));
      const minDepth = attrs?.min_depth ?? 12.0;
      const airDraft = attrs?.max_air_draft ?? 40.0;
      for (const [from, to] of [[a, b], [b, a]]) {
        run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id)
             VALUES (?, ?, ?, ?, ?, 50.0, 1.0, 500, 0, 0, 0)`,
          [nodeIdFor(from.lat, from.lon), nodeIdFor(to.lat, to.lon), d, minDepth, airDraft]);
      }
    }
    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    upgradeToPoiModel(db);
    db.close();
  }

  function buildFixtures(): void {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    // The overlay goes too: a run that died before its cleanup would otherwise
    // leave user-edit rows behind for the next run's merge to pick up, which
    // is exactly the contamination the cleanup below exists to prevent.
    for (const p of [westPath, eastPath, overlayPath]) if (fs.existsSync(p)) fs.unlinkSync(p);
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
      db = createDirectoryDatabase(fixturesDir, true);
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

    // The half that was missing until the dedupe landed: the union stored an
    // edge both files author once per file, inflating the adjacency of
    // precisely the nodes every cross-region route must traverse (24,506
    // duplicate entries on the CT<->RI pair alone).
    it('de-duplication: an edge both files author is stored once', async () => {
      const targets = await adjacencyTargets(db, ID.S0);
      assert.strictEqual(countOf(targets, ID.S1), 1, 'S0->S1 is authored by both files and should be stored once');
      assert.strictEqual(targets.length, 4, 'S0 should have exactly 4 outgoing edges: W1, WS, ES, S1');

      const s1Targets = await adjacencyTargets(db, ID.S1);
      assert.strictEqual(countOf(s1Targets, ID.S0), 1, 'S1->S0 is authored by both files and should be stored once');
      assert.strictEqual(s1Targets.length, 2, 'S1 should have exactly 2 outgoing edges: S0, E0');
    });

    it('the merged graph holds 14 edges, not the 16 rows the two files carry', async () => {
      // 8 directed rows per file; the shared edge contributes 2 of each
      // file's rows and collapses to 2 entries rather than 4.
      const stats = await db.getStats();
      assert.strictEqual(stats.edges, 14);
    });

    it('where the two files disagree, the more constrained value wins', async () => {
      // Neither insertion order can produce this pair by accident: west loads
      // first and yet loses the depth, east loads second and yet loses the
      // air draft.
      for (const [from, to] of [[ID.S0, ID.S1], [ID.S1, ID.S0]]) {
        const edge = db.getEdgeSync(from, to);
        assert.ok(edge, 'the shared seam edge should be present in both directions');
        assert.strictEqual(edge!.min_depth, SHARED_DEPTH_EAST,
          'the shallower of the two files\' depths should win');
        assert.strictEqual(edge!.max_air_draft, SHARED_AIR_DRAFT_WEST,
          'a known air draft should beat the other file\'s -1 (unknown, excluded from constraint checks)');
      }
    });
  });

  describe('the seam is crossable, and a route across it is routed rather than teleported', () => {
    let db: RoutingDatabase;

    before(async () => {
      buildFixtures();
      db = createDirectoryDatabase(fixturesDir, true);
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
      const engine = new RoutingEngine(db, testOptions(DEFAULT_CONFIG, { draft: 0, beam: 4, airDraft: 0 }));

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

    it('a route that starts on the graph raises no coverage-gap warning', async () => {
      // The no-false-alarm half of the check below: endpoints sitting on the
      // charted graph produce short connectors or none at all.
      const engine = new RoutingEngine(db, testOptions(DEFAULT_CONFIG, { draft: 0, beam: 4, airDraft: 0 }));
      const route = await engine.calculateRoute({
        start: { latitude: W0.lat, longitude: W0.lon },
        end: { latitude: E1.lat, longitude: E1.lon },
        minCoastDistance: 0,
      });
      assert.deepStrictEqual(
        (route.warnings ?? []).filter(w => w.type === 'coverage_gap'), [],
        'a fully routed leg must not be reported as a coverage gap',
      );
    });

    // §9.3: an unstitched seam does not fail loudly. The start is projected
    // onto the nearest *reachable* waterway — possibly across the hole — and
    // joined with a straight line carrying minDepth -1, which every constraint
    // check then skips. Measured legs of 3,485-4,597 m, reported only as
    // start_connecting, which this repo's own webapp filters out of the
    // warnings pane as noise. Route distance says nothing either: one such
    // route came back *shorter* than its single-file baseline (x0.89) by
    // cutting the corner.
    it('a start far from any charted waterway is reported as a coverage gap, not a connection', async () => {
      const engine = new RoutingEngine(db, testOptions(DEFAULT_CONFIG, { draft: 0, beam: 4, airDraft: 0 }));

      // ~4.4 km south of W0 — inside the measured gap band (3,485-4,597 m) and
      // well clear of the largest healthy connector seen on real data (893 m).
      const strandedStart = { latitude: W0.lat - 0.04, longitude: W0.lon };
      const route = await engine.calculateRoute({
        start: strandedStart,
        end: { latitude: E1.lat, longitude: E1.lon },
        minCoastDistance: 0,
      });

      const gaps = (route.warnings ?? []).filter(w => w.type === 'coverage_gap');
      assert.strictEqual(gaps.length, 1, `expected exactly one coverage_gap warning, got ${JSON.stringify(route.warnings)}`);
      assert.ok(gaps[0].distanceMeters! > DEFAULT_CONFIG.coverageGapMeters,
        'the reported distance should be what tripped the threshold');
      assert.match(gaps[0].message, /not a routed path/);
      // The ordinary connecting warning is replaced, not accompanied — one
      // leg, one warning, so a client filtering the routine type by name
      // cannot hide this one along with it.
      assert.deepStrictEqual(
        (route.warnings ?? []).filter(w => w.type === 'start_connecting'), [],
        'the long connector should not also be reported as a routine connection',
      );
    });

    it('coverageGapMeters = 0 turns the check off', async () => {
      const engine = new RoutingEngine(db, testOptions({ ...DEFAULT_CONFIG, coverageGapMeters: 0 }, { draft: 0, beam: 4, airDraft: 0 }));
      const route = await engine.calculateRoute({
        start: { latitude: W0.lat - 0.04, longitude: W0.lon },
        end: { latitude: E1.lat, longitude: E1.lon },
        minCoastDistance: 0,
      });
      const warnings = route.warnings ?? [];
      assert.deepStrictEqual(warnings.filter(w => w.type === 'coverage_gap'), []);
      assert.ok(warnings.some(w => w.type === 'start_connecting'),
        'with the check off, the same leg falls back to the routine warning');
    });
  });

  describe('unloading one half keeps what the other half still contributes', () => {
    let db: RoutingDatabase;

    before(async () => {
      buildFixtures();
      db = createDirectoryDatabase(fixturesDir, true);
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
    // unloadDatabaseGraph drops edges by dbIndex. Before de-duplication the
    // S0<->S1 edge was stored twice — once tagged west, once east — so
    // evicting west left the east copy behind and the seam survived by
    // accident of the very duplication the dedupe removes. Storing it once
    // means the surviving row can be tagged with the file being evicted, and
    // a plain filter would cut a seam edge that a still-loaded file authors:
    // no failed route, just a silent hole where the two regions used to join.
    // spliceEdge's extraDbIndexes is what closes that, by handing the edge to
    // a remaining contributor instead.
    it('an edge both files authored survives eviction of one of them', async () => {
      const edge = db.getEdgeSync(ID.S0, ID.S1);
      assert.ok(edge, 'S0->S1 is still authored by the loaded east file and must survive the west eviction');
      const back = db.getEdgeSync(ID.S1, ID.S0);
      assert.ok(back, 'S1->S0 is still authored by the loaded east file and must survive the west eviction');
      // Handed over, not merely left behind: the surviving row must no longer
      // claim the evicted file, or a second eviction would mis-target it.
      assert.notStrictEqual(edge!.dbIndex, 0, 'the surviving edge should have been handed to the east file');
    });

    it('the east half is intact and still connected across the old seam', async () => {
      const component = await undirectedComponent(db, ID.E1, Object.values(ID));
      assert.deepStrictEqual(
        [...component].sort((a, b) => a - b),
        [ID.S0, ID.S1, ID.ES, ID.E0, ID.E1].sort((a, b) => a - b),
        'expected exactly the east file\'s 5 nodes to remain, still one component',
      );
    });

    // Runs last: it puts the west half back, which the assertions above
    // depend on being gone.
    it('reloading the evicted half restores its edges without re-duplicating the shared one', async () => {
      await db.loadDatabaseGraph('region-west.sqlite');

      const targets = await adjacencyTargets(db, ID.S0);
      assert.strictEqual(countOf(targets, ID.S1), 1, 'the shared edge should still be stored once after a reload');
      assert.strictEqual(targets.length, 4, 'S0 should be back to W1, WS, ES, S1');
      const stats = await db.getStats();
      assert.strictEqual(stats.edges, 14, 'a load -> unload -> load cycle should not leak edges');
      assert.strictEqual(stats.nodes, 8);
    });
  });

  describe('a user edit at the seam is folded in, not stored as a second edge', () => {
    // updateEdge writes a row into the user-edits overlay, which the loader
    // then merges alongside the file rows for the same (source,target) — a
    // third contributor to the same seam edge, and a duplicate entry before
    // this change. It is folded by the same more-constrained rule the two
    // files get, deliberately: the overlay row fills every column the edit did
    // not mention with a placeholder, so `distance` there is 0. A rule that
    // let the edit overwrite wholesale would put a zero-length edge at the
    // seam, which is why these tests pin the distance as well as the depth.
    const EDITED_DEPTH = 3.25;
    let first: RoutingDatabase;
    let reopened: RoutingDatabase;

    before(async () => {
      buildFixtures();
      first = createDirectoryDatabase(fixturesDir, true);
      await first.init();
      await first.loadGraph();
      await first.loadDatabaseGraph('region-west.sqlite');
      await first.loadDatabaseGraph('region-east.sqlite');
      await first.updateEdge(0, ID.S0, ID.S1, { min_depth: EDITED_DEPTH });
      await first.close();

      // A second instance over the same directory: the two region files are
      // untouched on disk, the edit exists only as an overlay row.
      reopened = createDirectoryDatabase(fixturesDir, true);
      await reopened.init();
      await reopened.loadGraph();
      await reopened.loadDatabaseGraph('region-west.sqlite');
      await reopened.loadDatabaseGraph('region-east.sqlite');
    });

    after(async () => {
      await reopened.close();
      cleanupFixtures();
    });

    it('the edit lands in both directions, stored once each', async () => {
      // updateEdge writes the one direction it was given; opening the overlay
      // backfills the reverse of every bidirectional overlay edge, so both
      // directions carry the edit by the time the graph is rebuilt.
      for (const [from, to] of [[ID.S0, ID.S1], [ID.S1, ID.S0]]) {
        const edge = reopened.getEdgeSync(from, to);
        assert.ok(edge, 'the edited seam edge should be present after the reload');
        assert.strictEqual(edge!.min_depth, EDITED_DEPTH,
          'the edit is shallower than either file and should win the fold');
      }
      const targets = await adjacencyTargets(reopened, ID.S0);
      assert.strictEqual(countOf(targets, ID.S1), 1, 'the edit should not add a second copy of the edge');
      assert.strictEqual(targets.length, 4);
    });

    it('the edit does not drag the overlay row\'s placeholder columns in with it', async () => {
      // The regression this pins: an overlay row the edit left unspecified
      // carries distance 0 and -1 limits. Folding must not let those through,
      // or the seam edge becomes free to traverse and unconstrained.
      const edge = reopened.getEdgeSync(ID.S0, ID.S1)!;
      assert.ok(edge.distance > 0, `seam edge distance should stay real, got ${edge.distance}`);
      assert.strictEqual(edge.max_air_draft, SHARED_AIR_DRAFT_WEST,
        'the west file\'s known air draft should still win over -1');
      assert.strictEqual(edge.min_width, 50.0, 'the files\' width should survive the overlay placeholder');
    });
  });
});

// A route found in an earlier, narrower bounding box must be judged against
// the graph as it is after a wider box loaded more regions. Loading the east
// file folds its shallower copy of the shared S0-S1 seam edge into the edge
// the west file loaded (spliceEdge keeps the tighter value); the route the
// first box found still runs along that edge, and can be the one returned.
//
//   W0 ---- W1 ---- S0 ==== S1          (west file; first box)
//                   S0 ==== S1 ---- E0  (east file; only the wider box)
//
// W0-W1 is under a 5 m clearance, so the first route is penalized and the
// box widens. The wider box loads east (its bounding box starts east of the
// first box), which makes S0-S1 7.5 m deep instead of 12 m. A* there finds
// the same path, now more penalized and so costlier, and the first box's
// route wins the tie on violating meters by its lower cost.
describe('a route kept from an earlier box reports seam limits a later load tightened', () => {
  const dir = './test/fixtures/seam-refresh';
  const files = ['west.sqlite', 'east.sqlite', 'user-edits.sqlite'].map(f => path.join(dir, f));
  const rW0 = P(52.000, 4.900);
  const rW1 = P(52.010, 4.950);
  const rS0 = P(52.000, 5.000);
  const rS1 = P(52.010, 5.050);
  const rE0 = P(52.000, 5.100);
  const id = (p: Pt) => nodeIdFor(p.lat, p.lon);

  function build(
    file: string, country: string, bbox: typeof WEST_BBOX, nodes: Pt[],
    edges: Array<[Pt, Pt, number, number]>, // a, b, min_depth, max_air_draft
  ): void {
    const raw = new DatabaseSync(file, { open: true });
    const run = (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...(params as any[]));
    run(`CREATE TABLE metadata (id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL, bounding_box TEXT)`);
    run(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box)
         VALUES (?, ?, 'Seam refresh fixture', '2026-01-01T00:00:00Z', ?)`, [country, country, JSON.stringify(bbox)]);
    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    for (const p of nodes) run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [id(p), p.lat, p.lon]);
    run(`CREATE TABLE edges (source INTEGER, target INTEGER, distance REAL, min_depth REAL, max_air_draft REAL,
      min_width REAL, cost_factor REAL DEFAULT 1.0, distance_to_land REAL, edge_type_id INTEGER DEFAULT 0,
      traffic_mode INTEGER DEFAULT 0, edge_kind_id INTEGER DEFAULT 0)`);
    for (const [a, b, depth, air] of edges) {
      const d = Math.round(haversine(a.lat, a.lon, b.lat, b.lon));
      for (const [from, to] of [[a, b], [b, a]]) {
        run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id)
             VALUES (?, ?, ?, ?, ?, 50.0, 1.0, 500, 1, 0, 0)`, [id(from), id(to), d, depth, air]);
      }
    }
    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    upgradeToPoiModel(raw);
    raw.close();
  }

  let db: RoutingDatabase;

  before(async () => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f);
    build(files[0], 'REFW', { min_lat: 51.99, min_lon: 4.89, max_lat: 52.02, max_lon: 5.051 },
      [rW0, rW1, rS0, rS1], [[rW0, rW1, 12, 5], [rW1, rS0, 12, 40], [rS0, rS1, 12, 40]]);
    // Starts east of the first box (around W0..S1 at 0.005° it ends at
    // 5.055), inside the doubled one (5.06).
    build(files[1], 'REFE', { min_lat: 51.99, min_lon: 5.058, max_lat: 52.02, max_lon: 5.11 },
      [rS0, rS1, rE0], [[rS0, rS1, 7.5, 40], [rS1, rE0, 12, 40]]);
  });

  beforeEach(async () => {
    db = createDirectoryDatabase(dir, true);
    await db.init();
    await db.loadGraph();
    await db.loadDatabaseGraph('west.sqlite');
  });

  afterEach(async () => {
    await db.close();
    // A test's overlay edits must not reach the next one.
    if (fs.existsSync(files[2])) fs.unlinkSync(files[2]);
  });

  after(() => {
    for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  it('the returned route carries the tightened seam depth and warns about it', async () => {
    assert.strictEqual(db.getEdgeSync(id(rS0), id(rS1))!.min_depth, 12);
    const engine = new RoutingEngine(db, testOptions({
      ...DEFAULT_CONFIG,
      routingBBoxMargin: 0.005,
      routingBBoxMaxExtent: 0.01,
    }, { draft: 8, beam: 4, airDraft: 10 }));
    // Needs 8.3 m: clear of the west file's 12 m, not of the east's 7.5 m.

    const route = await engine.calculateRoute({
      start: { latitude: rW0.lat, longitude: rW0.lon },
      end: { latitude: rS1.lat, longitude: rS1.lon },
      minCoastDistance: 0,
    });

    // The wider box did load east, and the merge tightened the seam edge.
    assert.strictEqual(db.getEdgeSync(id(rS0), id(rS1))!.min_depth, 7.5);
    const depths = route.features.map((f: any) => f.properties.minDepth)
      .filter((d: unknown): d is number => typeof d === 'number' && d >= 0);
    assert.ok(depths.length > 0, 'the route has charted segments');
    assert.strictEqual(Math.min(...depths), 7.5,
      'the route reports the 7.5 m the seam edge now has, not the 12 m it had when found');
    const text = JSON.stringify(route.warnings ?? []);
    assert.match(text, /depth 7\.5m/, `a depth warning names the tightened seam: ${text}`);
  });

  it('a region another request loads while a candidate is scored is caught', async () => {
    // One box, no widening: only the final refresh can see the load.
    const engine = new RoutingEngine(db, testOptions({
      ...DEFAULT_CONFIG,
      routingBBoxMargin: 0.005,
      routingBBoxMaxExtent: 0.005,
    }, { draft: 8, beam: 4, airDraft: 10 })) as any;
    const score = engine.pathViolationMeters.bind(engine);
    let loaded = false;
    engine.pathViolationMeters = async (...args: unknown[]) => {
      // Another request's load lands while the first scoring awaits.
      if (!loaded) {
        loaded = true;
        await db.loadDatabaseGraph('east.sqlite');
      }
      return score(...args);
    };

    const route = await engine.calculateRoute({
      start: { latitude: rW0.lat, longitude: rW0.lon },
      end: { latitude: rS1.lat, longitude: rS1.lon },
      minCoastDistance: 0,
    });

    assert.ok(loaded, 'east loaded during scoring');
    const depths = route.features.map((f: any) => f.properties.minDepth)
      .filter((d: unknown): d is number => typeof d === 'number' && d >= 0);
    assert.strictEqual(Math.min(...depths), 7.5);
    assert.match(JSON.stringify(route.warnings ?? []), /depth 7\.5m/);
  });

  it('a region loaded during the final refresh is caught before selection', async () => {
    const engine = new RoutingEngine(db, testOptions({
      ...DEFAULT_CONFIG,
      routingBBoxMargin: 0.005,
      routingBBoxMaxExtent: 0.005,
    }, { draft: 8, beam: 4, airDraft: 10 })) as any;
    const score = engine.pathViolationMeters.bind(engine);
    let calls = 0;
    engine.pathViolationMeters = async (...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        // While the candidate is scored: an edit makes W1-S0 11 m, so the
        // final refresh has a change to recount.
        for (const [a, b] of [[rW1, rS0], [rS0, rW1]])
          db.getEdgeSync(id(a), id(b))!.min_depth = 11;
        (db as any).graphGeneration++;
      } else if (calls === 2) {
        // That recount awaits, and another request's load lands.
        await db.loadDatabaseGraph('east.sqlite');
      }
      return score(...args);
    };

    const route = await engine.calculateRoute({
      start: { latitude: rW0.lat, longitude: rW0.lon },
      end: { latitude: rS1.lat, longitude: rS1.lon },
      minCoastDistance: 0,
    });

    assert.ok(calls >= 3, 'the refresh ran again after the load');
    const depths = route.features.map((f: any) => f.properties.minDepth)
      .filter((d: unknown): d is number => typeof d === 'number' && d >= 0);
    assert.strictEqual(Math.min(...depths), 7.5);
  });

  it('a load that fails part-way leaves the loaded seam edge as it was', async () => {
    const store = (db as any).store;
    const load = store.loadNavmeshRegions;
    store.loadNavmeshRegions = async () => {
      throw new Error('synthetic navmesh read failure');
    };
    await assert.rejects(db.loadDatabaseGraph('east.sqlite'), /synthetic navmesh read failure/);
    store.loadNavmeshRegions = load;

    const edge = db.getEdgeSync(id(rS0), id(rS1))!;
    assert.strictEqual(edge.min_depth, 12, 'the failed file\'s 7.5 m is not merged in');
    assert.strictEqual(db.getEdgeSync(id(rS1), id(rE0)), null, 'nor are its own edges');
    assert.strictEqual(db.getNodeSync(id(rE0)), null, 'nor its nodes');

    // And it loads cleanly on the next try.
    await db.loadDatabaseGraph('east.sqlite');
    assert.strictEqual(db.getEdgeSync(id(rS0), id(rS1))!.min_depth, 7.5);
  });

  it('an earlier via leg is warned about a seam a later leg\'s load tightened', async () => {
    // One box, no widening: the leg is found and warned about on west alone.
    const engine = new RoutingEngine(db, testOptions({
      ...DEFAULT_CONFIG,
      routingBBoxMargin: 0.005,
      routingBBoxMaxExtent: 0.005,
    })) as any;
    const dims = inputsFor(engine.options, { draft: 8, beam: 4, airDraft: 10 });
    const warnings: any[] = [];
    const leg = await engine.tryRouteSegment(
      rW0.lat, rW0.lon, rS1.lat, rS1.lon, 0, 0, warnings, dims);
    assert.ok(leg, 'the leg is found');
    assert.strictEqual(warnings.length, 1);
    assert.doesNotMatch(warnings[0].message, /depth/, 'west alone: only the clearance');

    // What a later leg's wider box does.
    await db.loadDatabaseGraph('east.sqlite');
    await engine.recheckViaLegs([leg], warnings);

    assert.strictEqual(warnings.length, 1, 'the leg\'s warning is replaced, not added to');
    assert.match(warnings[0].message, /depth 7\.5m/);
    assert.match(warnings[0].message, /air draft 5\.0m/);
  });

  it('with tides on, a via leg is re-warned on a graph change that leaves its limits alone', async () => {
    const engine = new RoutingEngine(db, testOptions({
      ...DEFAULT_CONFIG,
      routingBBoxMargin: 0.005,
      routingBBoxMaxExtent: 0.005,
    })) as any;
    const dims = inputsFor(engine.options, { draft: 8, beam: 4, airDraft: 10 });
    const env = {
      departureMs: Date.parse('2026-08-12T00:00:00Z'),
      offsetSec: 0,
      speedMs: 3,
      flow: { sample: () => ({ u: 0, v: 0 }) },
      heights: undefined,
    };
    const warnings: any[] = [];
    const leg = await engine.tryRouteSegment(
      rW0.lat, rW0.lon, rS1.lat, rS1.lon, 0, 0, warnings, dims, undefined, env);
    assert.ok(leg, 'the leg is found');
    assert.strictEqual(warnings.length, 1);
    // What connectUserPoint does when it adds a start connector.
    delete leg.crossings;
    // A load that links a lock to the leg (edge_pois) but changes no limit.
    db.graphGeneration++;

    let rebuilt = 0;
    const add = engine.addViolationWarnings.bind(engine);
    engine.addViolationWarnings = async (...args: unknown[]) => {
      rebuilt++;
      return add(...args);
    };
    await engine.recheckViaLegs([leg], warnings);

    assert.strictEqual(rebuilt, 1, 'the leg\'s warning is rebuilt with the crossings as they are now');
    assert.strictEqual(warnings.length, 1, 'and replaces the old one');
  });

  it('an earlier via leg is warned about a limit an edge edit tightened', async () => {
    const engine = new RoutingEngine(db, testOptions({
      ...DEFAULT_CONFIG,
      routingBBoxMargin: 0.005,
      routingBBoxMaxExtent: 0.005,
    })) as any;
    const warnings: any[] = [];
    const leg = await engine.tryRouteSegment(
      rW0.lat, rW0.lon, rS1.lat, rS1.lon, 0, 0, warnings, inputsFor(engine.options, { draft: 8, beam: 4, airDraft: 10 }));
    assert.ok(leg, 'the leg is found');
    assert.doesNotMatch(warnings[0].message, /depth/);

    // A user edit while later legs are searched.
    await db.updateEdge(0, id(rS0), id(rS1), { min_depth: 6 });
    await engine.recheckViaLegs([leg], warnings);

    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0].message, /depth 6\.0m/);
  });

  it('a candidate whose recount throws stays behind, so a later refresh retries it', async () => {
    const engine = new RoutingEngine(db, testOptions({
      ...DEFAULT_CONFIG,
      routingBBoxMargin: 0.005,
      routingBBoxMaxExtent: 0.005,
    })) as any;
    const dims = inputsFor(engine.options, { draft: 8, beam: 4, airDraft: 10 });
    const leg = await engine.tryRouteSegment(
      rW0.lat, rW0.lon, rS1.lat, rS1.lon, 0, 0, [], dims);
    const before = db.graphGeneration;
    const c = { result: leg, violatingMeters: 0, cost: 0, distance: 0, generation: before };
    await db.loadDatabaseGraph('east.sqlite'); // tightens S0-S1 to 7.5 m

    const recount = engine.pathViolationMeters.bind(engine);
    engine.pathViolationMeters = async () => { throw new Error('synthetic POI lookup failure'); };
    await assert.rejects(engine.refreshCandidateLimits([c], dims), /synthetic POI lookup failure/);
    assert.strictEqual(c.generation, before, 'not stamped as current with the old count');

    engine.pathViolationMeters = recount;
    await engine.refreshCandidateLimits([c], dims);
    assert.strictEqual(c.generation, db.graphGeneration);
    assert.ok(c.violatingMeters > 0, 'the retry counts the tightened seam');
  });

  it('a node deleted while a load is reading is not put back by it', async () => {
    const store = (db as any).store;
    const load = store.loadNavmeshRegions.bind(store);
    store.loadNavmeshRegions = async (selector?: unknown) => {
      // The user deletes S1 after the load took its deletion snapshot.
      await db.deleteNode(0, id(rS1));
      return load(selector);
    };
    try {
      await db.loadDatabaseGraph('east.sqlite');
    } finally {
      store.loadNavmeshRegions = load;
    }
    assert.strictEqual(db.getNodeSync(id(rS1)), null, 'S1 stays deleted');
    assert.strictEqual(db.getEdgeSync(id(rS0), id(rS1)), null);
    assert.strictEqual(db.getEdgeSync(id(rS1), id(rE0)), null);
    assert.ok(db.getNodeSync(id(rE0)), 'the rest of the file still loads');
  });
});
