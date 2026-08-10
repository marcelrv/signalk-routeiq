import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';

// Graph-editor edits to an *existing* edge did not survive a reload.
//
// Edits live in a separate overlay database that the loader merges over the
// region files. Nodes are merged into a Map, so an overlay node overwrites the
// file's and a depth edit sticks. Edges are merged into a per-source array and
// every reader takes `.find()` — the first match — while overlay rows are
// appended last, so the file's row was always the one found. The edit was
// still on disk, and still invisible.
//
// It could not be fixed by simply letting the overlay row win, because
// updateEdge writes a whole row and fills every column the edit did not
// mention with a placeholder: `distance` 0, the limits -1, `cost_factor` 1.2.
// Letting those through puts a zero-length, unconstrained edge in the graph.
// `distance = 0` is recognisable as junk; `cost_factor = 1.2` and
// `traffic_mode = 0` are perfectly plausible real values and are not.
//
// So the overlay now records which columns the user actually set
// (`edited_fields`), and only those outrank the file's own row. Rows written
// before that column existed carry no marker and keep the old conservative
// merge — nothing can recover their intent after the fact.

function nodeIdFor(lat: number, lon: number): number {
  const latInt = Math.round((Math.round(lat * 100000) / 100000 + 90) * 100000);
  const lonInt = Math.round((Math.round(lon * 100000) / 100000 + 180) * 100000);
  return latInt * 36_000_000 + lonInt;
}

// A three-node channel: A — B — C, all attributes known and distinctive, so a
// placeholder leaking through is unmistakable.
const A = { lat: 53.0, lon: 6.0 };
const B = { lat: 53.0, lon: 6.05 };
const C = { lat: 53.0, lon: 6.1 };
const ID = { A: nodeIdFor(A.lat, A.lon), B: nodeIdFor(B.lat, B.lon), C: nodeIdFor(C.lat, C.lon) };

const FILE_DEPTH = 7.5;
const FILE_AIR_DRAFT = 24.0;
const FILE_WIDTH = 40.0;
const FILE_DISTANCE = 3346;

describe('user edits survive a reload (overlay edited_fields)', () => {
  const fixturesDir = './test/fixtures/overlay-edits';
  const regionPath = path.join(fixturesDir, 'region.sqlite');
  const overlayPath = path.join(fixturesDir, 'user-edits.sqlite');

  function buildFixture(): void {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    for (const p of [regionPath, overlayPath]) if (fs.existsSync(p)) fs.unlinkSync(p);

    const db = new DatabaseSync(regionPath, { open: true });
    const run = (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as any[]));
    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL,
      bounding_box TEXT
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box)
         VALUES ('EDIT', 'Overlay Edit Fixture', 'Three-node channel', '2026-01-01T00:00:00Z', ?)`,
      [JSON.stringify({ min_lat: 52.9, min_lon: 5.9, max_lat: 53.1, max_lon: 6.2 })]);
    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    for (const p of [A, B, C]) {
      run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [nodeIdFor(p.lat, p.lon), p.lat, p.lon]);
    }
    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.0, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
      edge_kind_id INTEGER DEFAULT 0
    )`);
    for (const [x, y] of [[A, B], [B, C]]) {
      for (const [from, to] of [[x, y], [y, x]]) {
        run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id)
             VALUES (?, ?, ?, ?, ?, ?, 1.0, 500, 0, 0, 0)`,
          [nodeIdFor(from.lat, from.lon), nodeIdFor(to.lat, to.lon), FILE_DISTANCE, FILE_DEPTH, FILE_AIR_DRAFT, FILE_WIDTH]);
      }
    }
    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    db.close();
  }

  /** A second region covering the same water, which does describe A—C — the
   *  neighbour that arrives after an edge has been drawn by hand. */
  function buildOverlapRegion(): void {
    const p = path.join(fixturesDir, 'overlap.sqlite');
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const db = new DatabaseSync(p, { open: true });
    const run = (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as any[]));
    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL,
      bounding_box TEXT
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box)
         VALUES ('EDIT2', 'Overlapping Neighbour', '', '2026-01-01T00:00:00Z', ?)`,
      [JSON.stringify({ min_lat: 52.9, min_lon: 5.9, max_lat: 53.1, max_lon: 6.2 })]);
    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    for (const pt of [A, B, C]) {
      run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 2)`, [nodeIdFor(pt.lat, pt.lon), pt.lat, pt.lon]);
    }
    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL,
      min_depth REAL, max_air_draft REAL, min_width REAL,
      cost_factor REAL DEFAULT 1.0, distance_to_land REAL,
      edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
      edge_kind_id INTEGER DEFAULT 0
    )`);
    // Deliberately more constrained than the drawn edge on every column, so a
    // conservative fold would visibly win if the drawn row were not marked.
    for (const [from, to] of [[A, C], [C, A]]) {
      run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id)
           VALUES (?, ?, 6700, 2.0, 6.0, 5.0, 1.0, 500, 0, 0, 0)`,
        [nodeIdFor(from.lat, from.lon), nodeIdFor(to.lat, to.lon)]);
    }
    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    db.close();
  }

  function cleanup(): void {
    const overlap = path.join(fixturesDir, 'overlap.sqlite');
    for (const p of [regionPath, overlayPath, overlap]) if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  /** Open the fixture directory fresh — the overlay on disk is all that
   *  carries an edit from one instance to the next. */
  async function open(): Promise<RoutingDatabase> {
    const db = new RoutingDatabase(fixturesDir, true);
    await db.init();
    await db.loadGraph();
    await db.loadDatabaseGraph('region.sqlite');
    return db;
  }

  /** Same, through the non-dynamic bulk path, which merges every file and the
   *  overlay in one batch instead of per file. */
  async function openBulk(): Promise<RoutingDatabase> {
    const db = new RoutingDatabase(fixturesDir, false);
    await db.init();
    await db.loadGraph();
    return db;
  }

  describe('an edit that relaxes a limit — the case that was silently lost', () => {
    let reopened: RoutingDatabase;

    before(async () => {
      buildFixture();
      const first = await open();
      // The chart is pessimistic here: the skipper has sounded 9.2 m where the
      // file says 7.5. Nothing conservative about it, which is exactly why the
      // old more-constrained fold threw it away.
      await first.updateEdge(0, ID.A, ID.B, { min_depth: 9.2 });
      await first.close();
      reopened = await open();
    });

    after(async () => {
      await reopened.close();
      cleanup();
    });

    it('the edited depth is what the graph reports', () => {
      assert.strictEqual(reopened.getEdgeSync(ID.A, ID.B)?.min_depth, 9.2);
    });

    it('the columns the edit never mentioned keep the file\'s values, not the overlay placeholders', () => {
      // updateEdge stored distance 0, max_air_draft -1, min_width -1 for these.
      const edge = reopened.getEdgeSync(ID.A, ID.B)!;
      assert.strictEqual(edge.distance, FILE_DISTANCE, 'distance must not become the placeholder 0');
      assert.strictEqual(edge.max_air_draft, FILE_AIR_DRAFT, 'air draft must not become the placeholder -1');
      assert.strictEqual(edge.min_width, FILE_WIDTH, 'width must not become the placeholder -1');
    });

    it('the edge is stored once, not once per contributor', async () => {
      const targets = (await reopened.getOutgoingEdges(ID.A)).map(e => e.target);
      assert.deepStrictEqual(targets, [ID.B]);
    });

    it('the untouched edge further along the channel is unaffected', () => {
      assert.strictEqual(reopened.getEdgeSync(ID.B, ID.C)?.min_depth, FILE_DEPTH);
    });

    it('the reverse direction carries the edit too', () => {
      // Opening the overlay backfills the reverse of a two-way edge: an edit
      // to the waterway is not an edit to one direction of travel.
      assert.strictEqual(reopened.getEdgeSync(ID.B, ID.A)?.min_depth, 9.2);
    });
  });

  describe('successive edits to different columns', () => {
    let reopened: RoutingDatabase;

    before(async () => {
      buildFixture();
      const first = await open();
      await first.updateEdge(0, ID.A, ID.B, { min_depth: 9.2 });
      await first.close();
      // A separate session, so the second edit has to union with the marker
      // the first one left rather than replacing it.
      const second = await open();
      await second.updateEdge(0, ID.A, ID.B, { min_width: 12.0 });
      await second.close();
      reopened = await open();
    });

    after(async () => {
      await reopened.close();
      cleanup();
    });

    it('both edits are in force, and the rest of the row is still the file\'s', () => {
      const edge = reopened.getEdgeSync(ID.A, ID.B)!;
      assert.strictEqual(edge.min_depth, 9.2, 'the earlier edit should not be disowned by the later one');
      assert.strictEqual(edge.min_width, 12.0);
      assert.strictEqual(edge.max_air_draft, FILE_AIR_DRAFT);
      assert.strictEqual(edge.distance, FILE_DISTANCE);
    });
  });

  describe('the bulk (non-dynamic) load path behaves the same', () => {
    let reopened: RoutingDatabase;

    before(async () => {
      buildFixture();
      const first = await open();
      await first.updateEdge(0, ID.A, ID.B, { min_depth: 9.2 });
      await first.close();
      reopened = await openBulk();
    });

    after(async () => {
      await reopened.close();
      cleanup();
    });

    it('applies the edit and keeps the file\'s other columns', () => {
      const edge = reopened.getEdgeSync(ID.A, ID.B)!;
      assert.strictEqual(edge.min_depth, 9.2);
      assert.strictEqual(edge.distance, FILE_DISTANCE);
      assert.strictEqual(edge.max_air_draft, FILE_AIR_DRAFT);
    });
  });

  describe('an overlay row from before edited_fields existed', () => {
    let reopened: RoutingDatabase;

    before(async () => {
      buildFixture();
      // Force the overlay into existence with its current schema, then write a
      // row the way an older version did: a full row of placeholders around
      // one real value, and no marker saying which was which.
      const first = await open();
      await first.close();
      const ov = new DatabaseSync(overlayPath, { open: true });
      ov.prepare(
        `INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edited_fields)
         VALUES (?, ?, 0, 3.25, -1, -1, 1.2, 500, 0, 0, NULL)`,
      ).run(ID.A, ID.B);
      ov.close();
      reopened = await open();
    });

    after(async () => {
      await reopened.close();
      cleanup();
    });

    it('falls back to the conservative merge rather than trusting the placeholders', () => {
      const edge = reopened.getEdgeSync(ID.A, ID.B)!;
      // 3.25 is shallower than the file's 7.5, so the conservative fold takes
      // it — an unmarked row still cannot make the graph *less* constrained.
      assert.strictEqual(edge.min_depth, 3.25);
      // And its placeholders are still refused: -1 is the UNKNOWN convention,
      // which never beats a known reading.
      assert.strictEqual(edge.max_air_draft, FILE_AIR_DRAFT);
      assert.strictEqual(edge.min_width, FILE_WIDTH);
      assert.strictEqual(edge.distance, FILE_DISTANCE);
    });
  });

  describe('an edge drawn in this session, before any restart', () => {
    let db: RoutingDatabase;

    before(async () => {
      buildFixture();
      buildOverlapRegion();
      db = new RoutingDatabase(fixturesDir, true);
      await db.init();
      await db.loadGraph();
      await db.loadDatabaseGraph('region.sqlite');
      // A—C is a shortcut no region file describes yet, drawn by hand.
      await db.addEdge(0, {
        source: ID.A,
        target: ID.C,
        distance: 1234,
        min_depth: 15.0,
        max_air_draft: 99.0,
        min_width: 88.0,
      });
      // A second region covering the same water arrives afterwards, and it
      // does describe A—C. This is the ordering that catches an in-memory row
      // not yet marked as the user's: before a restart nothing had re-read it
      // from the overlay, so it looked like an ordinary unmarked edge.
      await db.loadDatabaseGraph('overlap.sqlite');
    });

    after(async () => {
      await db.close();
      cleanup();
    });

    it('is not folded over by a region loaded afterwards', () => {
      // Authored outright, not corrected, so the file's figures must not win
      // any column — including the ones where the file is the more
      // conservative reading, which is exactly what the fold would prefer.
      const edge = db.getEdgeSync(ID.A, ID.C)!;
      assert.strictEqual(edge.min_depth, 15.0, 'the drawn depth should stand, though the file says 2');
      assert.strictEqual(edge.max_air_draft, 99.0, 'the drawn air draft should stand, though the file says 6');
      assert.strictEqual(edge.min_width, 88.0, 'the drawn width should stand, though the file says 5');
    });

    it('behaves the same after a restart as it did before one', async () => {
      await db.close();
      db = new RoutingDatabase(fixturesDir, true);
      await db.init();
      await db.loadGraph();
      await db.loadDatabaseGraph('region.sqlite');
      await db.loadDatabaseGraph('overlap.sqlite');
      const edge = db.getEdgeSync(ID.A, ID.C)!;
      assert.strictEqual(edge.min_depth, 15.0);
      assert.strictEqual(edge.max_air_draft, 99.0);
      assert.strictEqual(edge.min_width, 88.0);
    });
  });

  describe('a node depth edit — the path that already worked', () => {
    let reopened: RoutingDatabase;

    before(async () => {
      buildFixture();
      const first = await open();
      await first.updateNode(0, ID.B, { node_depth: 4.75 });
      await first.close();
      reopened = await open();
    });

    after(async () => {
      await reopened.close();
      cleanup();
    });

    it('still survives a reload', () => {
      // Regression guard: nodes merge into a Map where the overlay overwrites,
      // which is why this half was never broken. It must stay that way.
      assert.strictEqual(reopened.getNodeSync(ID.B)?.nodeDepth, 4.75);
    });
  });
});
