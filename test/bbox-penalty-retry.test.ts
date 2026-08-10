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
    // kept the penalized direct A-B result. Cost should track distance
    // closely (cost_factor 1.0, no penalty) rather than asserting cost is
    // below some magic threshold, since the violation-rate constants are an
    // implementation detail the test shouldn't hardcode.
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
    // Cost should be dominated by the depth-violation surcharge rather than
    // genuine distance/cost_factor: a clean edge here costs ≈ distance
    // (cost_factor 1.0), so a cost far above distance is the signature of
    // the violation rate kicking in — checked as a ratio rather than a
    // magic absolute value, since the exact rate is an implementation
    // detail (see VIOLATION_RATE_CONSTRAINT in src/routing.ts).
    assert.ok(route.totalCost! > route.totalDistance! * 100,
      `expected the depth-violation penalty to dominate cost, got cost=${route.totalCost} distance=${route.totalDistance}`);
    const draftWarning = (route.warnings || []).find(w => w.type === 'via_constrained');
    assert.ok(draftWarning, 'expected a depth-constraint warning on the fallback route');
  });
});

// Round 19: the old flat +1,000,000-per-violation penalty made a violating
// edge's cost independent of how long that edge actually was — any detour,
// however absurd, would eventually be "cheap" by comparison once it grew
// past the flat constant, but a short violating edge could never win
// against even a very long clean detour (a single mis-flagged 211m
// air-draft edge could cost ~211,000km-equivalent — see Round 14). Rate-
// based scaling (VIOLATION_RATE_CONSTRAINT × violating meters, see
// src/routing.ts) makes the tradeoff bounded and legible: a short violating
// edge is preferred over a detour that costs more than the violation
// surcharge, and loses to a detour that costs less.
//
//   A (52.000, 5.000) ------ direct, 2396m, depth-violating ------ B (52.000, 5.035)
//     \                                                           /
//      \ clean, detourLegDistance                clean, detourLegDistance
//       \                                                       /
//        C (51.984, 4.984)
//
// Same node geometry as the bbox-retry fixture above (A/B 2.4km apart, C
// >2km from each) so the shallow-water "improve start/end node" heuristic
// doesn't fire and silently re-target the search onto a different node
// before the cost-tradeoff logic under test even runs — that heuristic
// snaps the start point onto any node with a deep path within 2000m, and a
// closer A/B spacing (which would otherwise be more natural for a 1000m
// "direct" edge) put B itself inside that radius, defeating the test.
//
// The direct edge's total cost is fixed at 2396 + 2396*VIOLATION_RATE_CONSTRAINT
// = 721,196. Only the per-leg distance assigned to the A-C/C-B detour edges
// changes between the two cases below (C stays geographically close to A/B
// so the default 1°-margin bbox always sees the whole graph in one pass —
// this test isolates the cost comparison, not the bbox-retry mechanics
// already covered above).
describe('violation-rate tradeoff is bounded, not all-or-nothing (Round 19)', () => {
  const fixturesDir = './test/fixtures/bbox-penalty-retry-tradeoff';
  const A = { lat: 52.000, lon: 5.000 };
  const B = { lat: 52.000, lon: 5.035 };
  const C = { lat: 51.984, lon: 4.984 };
  const NODE_A = 21, NODE_B = 22, NODE_C = 23;
  const DIRECT_DISTANCE = 2396; // meters; direct A-B edge violates depth
  // 2396 base + 2396 * 300 (VIOLATION_RATE_CONSTRAINT) surcharge.
  const DIRECT_TOTAL_COST_APPROX = DIRECT_DISTANCE + DIRECT_DISTANCE * 300;

  async function buildFixture(detourLegAC: number, detourLegCB: number): Promise<RoutingDatabase> {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    const dbPath = path.join(fixturesDir, 'test_tradeoff.sqlite');
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
         VALUES ('TEST', 'Tradeoff Region', 'Synthetic fixture', '2026-01-01T00:00:00Z')`);

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
    // Direct A<->B: shallow (min_depth 0.5 < required 2.3), violates depth.
    run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode) VALUES
      (${NODE_A}, ${NODE_B}, ${DIRECT_DISTANCE}, 0.5, 20.0, 10.0, 1.0, 5000, 1, 0),
      (${NODE_B}, ${NODE_A}, ${DIRECT_DISTANCE}, 0.5, 20.0, 10.0, 1.0, 5000, 1, 0)`);
    // Clean detour A<->C<->B, deep enough on both legs.
    run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode) VALUES
      (${NODE_A}, ${NODE_C}, ${detourLegAC}, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (${NODE_C}, ${NODE_A}, ${detourLegAC}, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (${NODE_C}, ${NODE_B}, ${detourLegCB}, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
      (${NODE_B}, ${NODE_C}, ${detourLegCB}, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0)`);

    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);

    raw.close();

    const db = new RoutingDatabase(fixturesDir);
    await db.init();
    await db.loadGraph();
    return db;
  }

  async function cleanup(db: RoutingDatabase) {
    await db.close();
    for (const p of [
      path.join(fixturesDir, 'test_tradeoff.sqlite'),
      path.join(fixturesDir, 'user-edits.sqlite'),
    ]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  it('picks the clean detour when its cost is below the violation surcharge', async () => {
    // Detour legs 2089m/3919m (~6008m total, cost ≈ 6008 at cost_factor 1.0)
    // is far cheaper than the 721,196 direct-edge total — the detour wins.
    const db = await buildFixture(2089, 3919);
    try {
      const engine = new RoutingEngine(db, DEFAULT_CONFIG);
      engine.setVesselDimensions({ draft: 2.0, beam: 4.0, airDraft: 10.0 });

      const route = await engine.calculateRoute({
        start: { latitude: A.lat, longitude: A.lon },
        end: { latitude: B.lat, longitude: B.lon },
        minCoastDistance: 0,
      });

      assert.ok(route.totalDistance! > 5500 && route.totalDistance! < 6500,
        `expected the ~6.0km clean detour via C, got ${route.totalDistance}m`);
      assert.ok(route.totalCost! < DIRECT_TOTAL_COST_APPROX,
        `expected the cheap detour to beat the direct edge's violation-inflated cost, got ${route.totalCost}`);
      const draftWarning = (route.warnings || []).find(w => w.type === 'via_constrained');
      assert.strictEqual(draftWarning, undefined, 'clean detour should carry no depth-constraint warning');
    } finally {
      await cleanup(db);
    }
  });

  it('picks the direct violating edge (with warning) when the only detour costs more than the violation', async () => {
    // Detour legs 500,000m each way (~1,000,000m total) cost more than the
    // 721,196 direct-edge total — this is exactly the case that was
    // impossible under the old flat +1,000,000 scaling, where a violating
    // edge always lost regardless of how long the alternative detour was.
    // (The detour legs' graph `distance` is set far larger than C's real
    // geo separation from A/B on purpose — the A* heuristic uses geo
    // distance and stays admissible either way, and this keeps C safely
    // outside the start/end node-improvement search radius; see the
    // geometry note above.)
    const db = await buildFixture(500_000, 500_000);
    try {
      const engine = new RoutingEngine(db, DEFAULT_CONFIG);
      engine.setVesselDimensions({ draft: 2.0, beam: 4.0, airDraft: 10.0 });

      const route = await engine.calculateRoute({
        start: { latitude: A.lat, longitude: A.lon },
        end: { latitude: B.lat, longitude: B.lon },
        minCoastDistance: 0,
      });

      assert.ok(route.totalDistance! < 3000,
        `expected the short direct A-B edge to win, got ${route.totalDistance}m`);
      assert.ok(Math.abs(route.totalCost! - DIRECT_TOTAL_COST_APPROX) < 10,
        `expected cost close to the direct edge's violation-inflated total, got ${route.totalCost}`);
      const draftWarning = (route.warnings || []).find(w => w.type === 'via_constrained');
      assert.ok(draftWarning, 'expected a depth-constraint warning on the direct route');
    } finally {
      await cleanup(db);
    }
  });
});


// maxPenaltyDetourRatio bounds how far a route may detour to clear a
// violation. The comparison that applied it used to be folded pairwise into a
// running best, and because that relation is NOT transitive the winner
// depended on the order the bbox retries happened to produce candidates: a
// route far past the ratio could win by being compared against an
// intermediate rather than against the shortest route. selectBestCandidate
// measures every candidate against one fixed yardstick instead, so these
// assert the same set gives the same answer in any order.
describe('maxPenaltyDetourRatio selects independently of attempt order', () => {
  const RATIO = 3;

  function engineWithRatio(): any {
    return new RoutingEngine({} as never, {
      ...DEFAULT_CONFIG,
      maxPenaltyDetourRatio: RATIO,
    });
  }

  // (violating meters, cost, distance)
  const SHORT_DIRTY = { result: 'short-dirty', violatingMeters: 10, cost: 1, distance: 10_000 };
  const MID = { result: 'mid', violatingMeters: 5, cost: 1, distance: 25_000 };
  const LONG_CLEAN = { result: 'long-clean', violatingMeters: 0, cost: 1, distance: 70_000 };

  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    const out: T[][] = [];
    items.forEach((item, i) => {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      for (const p of permutations(rest)) out.push([item, ...p]);
    });
    return out;
  }

  it('rejects a 7x detour however the attempts are ordered', () => {
    // 70km is 7x the shortest route, past the ratio, so it must never win —
    // not even by way of the 25km candidate, which sits inside the bound
    // relative to 10km and previously laundered it through.
    //
    // 25km is the right answer: at 2.5x it is within the bound, and it halves
    // the violating meters. Bounding the trade must not disable it.
    const engine = engineWithRatio();
    for (const order of permutations([SHORT_DIRTY, MID, LONG_CLEAN])) {
      const picked = engine.selectBestCandidate(order);
      const where = order.map((c: any) => c.result).join(' -> ');
      assert.notEqual(
        picked.result,
        'long-clean',
        `order ${where} kept a 7x detour`,
      );
      assert.equal(picked.result, 'mid', `order ${where} picked ${picked.result}`);
    }
  });

  it('still prefers the cleaner route when the detour is within the ratio', () => {
    const engine = engineWithRatio();
    // 25km is 2.5x the 10km route — inside the bound, so clearing 10 violating
    // meters is worth it. Bounding the trade must not disable it.
    const withinBound = { result: 'clean-enough', violatingMeters: 0, cost: 1, distance: 25_000 };
    for (const order of permutations([SHORT_DIRTY, withinBound])) {
      assert.equal(engine.selectBestCandidate(order).result, 'clean-enough');
    }
  });

  it('is unbounded again at ratio 0, the documented escape hatch', () => {
    const engine: any = new RoutingEngine({} as never, {
      ...DEFAULT_CONFIG,
      maxPenaltyDetourRatio: 0,
    });
    for (const order of permutations([SHORT_DIRTY, MID, LONG_CLEAN])) {
      assert.equal(engine.selectBestCandidate(order).result, 'long-clean');
    }
  });

  it('returns null when every attempt failed', () => {
    assert.equal(engineWithRatio().selectBestCandidate([]), null);
  });

  it('breaks ties on cost, and keeps a candidate whose distance is unknown', () => {
    const engine = engineWithRatio();
    const dear = { result: 'dear', violatingMeters: 0, cost: 900, distance: 10_000 };
    const cheap = { result: 'cheap', violatingMeters: 0, cost: 100, distance: 10_000 };
    for (const order of permutations([dear, cheap])) {
      assert.equal(engine.selectBestCandidate(order).result, 'cheap');
    }
    // distance 0 means "not measured" — it must not be read as a 0m route that
    // makes every other candidate an infinite detour.
    const unmeasured = { result: 'unmeasured', violatingMeters: 0, cost: 1, distance: 0 };
    assert.equal(
      engine.selectBestCandidate([SHORT_DIRTY, unmeasured]).result,
      'unmeasured',
    );
  });
});
