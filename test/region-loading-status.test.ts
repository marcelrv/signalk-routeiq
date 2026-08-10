import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';

// A route or a position update can trigger a region to be read into the graph
// before the request can be answered, and that read is inline: the request
// takes tens of seconds with nothing to show for it. The coverage index has
// always known which region was mid-load ('loading'), but nothing reported it,
// so no client could say what the wait was for.
//
// getLoadingStatus() now carries those regions. It is deliberately the vehicle
// rather than getDatabaseCatalog(): the catalog makes a worker round-trip, and
// during a load the worker is the thing that is busy, so a poll would queue
// behind the very load it is asking about. getLoadingStatus reads the coverage
// index on the main thread and needs nothing from the worker.

function nodeIdFor(lat: number, lon: number): number {
  const latInt = Math.round((Math.round(lat * 100000) / 100000 + 90) * 100000);
  const lonInt = Math.round((Math.round(lon * 100000) / 100000 + 180) * 100000);
  return latInt * 36_000_000 + lonInt;
}

const REGION_NAME = 'Loading Status Fixture';

describe('regions being read into the graph are reported', () => {
  const fixturesDir = './test/fixtures/loading-status';
  const regionPath = path.join(fixturesDir, 'region.sqlite');
  const namelessPath = path.join(fixturesDir, 'nameless.sqlite');
  const overlayPath = path.join(fixturesDir, 'user-edits.sqlite');
  let db: RoutingDatabase;

  /** A second region whose metadata carries an empty name, for the fallback. */
  function buildNameless(): void {
    const raw = new DatabaseSync(namelessPath, { open: true });
    const run = (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...(params as any[]));
    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL,
      bounding_box TEXT
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box)
         VALUES ('NONAME', '', '', '2026-01-01T00:00:00Z', ?)`,
      [JSON.stringify({ min_lat: 40, min_lon: 3, max_lat: 41, max_lon: 4 })]);
    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL, min_depth REAL,
      max_air_draft REAL, min_width REAL, cost_factor REAL DEFAULT 1.0,
      distance_to_land REAL, edge_type_id INTEGER DEFAULT 0,
      traffic_mode INTEGER DEFAULT 0, edge_kind_id INTEGER DEFAULT 0
    )`);
    const a = nodeIdFor(40.5, 3.5);
    const b = nodeIdFor(40.5, 3.6);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, 40.5, 3.5, 1)`, [a]);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, 40.5, 3.6, 1)`, [b]);
    for (const [s, t] of [[a, b], [b, a]]) {
      run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id)
           VALUES (?, ?, 7000, 9.0, 30.0, 40.0, 1.0, 500, 0, 0, 0)`, [s, t]);
    }
    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    raw.close();
  }

  before(async () => {
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    for (const p of [regionPath, namelessPath, overlayPath]) if (fs.existsSync(p)) fs.unlinkSync(p);

    const raw = new DatabaseSync(regionPath, { open: true });
    const run = (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...(params as any[]));
    run(`CREATE TABLE metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL,
      bounding_box TEXT
    )`);
    run(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box)
         VALUES ('LOAD', ?, '', '2026-01-01T00:00:00Z', ?)`,
      [REGION_NAME, JSON.stringify({ min_lat: 50, min_lon: 3, max_lat: 51, max_lon: 4 })]);
    run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
    run(`CREATE TABLE edges (
      source INTEGER, target INTEGER, distance REAL, min_depth REAL,
      max_air_draft REAL, min_width REAL, cost_factor REAL DEFAULT 1.0,
      distance_to_land REAL, edge_type_id INTEGER DEFAULT 0,
      traffic_mode INTEGER DEFAULT 0, edge_kind_id INTEGER DEFAULT 0
    )`);
    const a = nodeIdFor(50.5, 3.5);
    const b = nodeIdFor(50.5, 3.6);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, 50.5, 3.5, 1)`, [a]);
    run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, 50.5, 3.6, 1)`, [b]);
    for (const [s, t] of [[a, b], [b, a]]) {
      run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id)
           VALUES (?, ?, 7000, 9.0, 30.0, 40.0, 1.0, 500, 0, 0, 0)`, [s, t]);
    }
    run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
    raw.close();
    buildNameless();

    db = new RoutingDatabase(fixturesDir, true);
    await db.init();
    await db.loadGraph();
  });

  after(async () => {
    await db.close();
    for (const p of [regionPath, namelessPath, overlayPath]) if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  it('reports nothing loading when nothing is', () => {
    assert.deepStrictEqual(db.getLoadingStatus().loading, []);
  });

  it('names the region while it is being read in, and stops naming it once done', async () => {
    // Deliberately not awaited yet: loadDatabaseGraph marks the entry
    // 'loading' before it yields, which is the whole point — a client polling
    // during the load has something to read.
    const pending = db.loadDatabaseGraph('region.sqlite');

    const during = db.getLoadingStatus();
    assert.strictEqual(during.loading.length, 1, 'the region being read in should be reported');
    assert.strictEqual(during.loading[0].filename, 'region.sqlite');
    assert.strictEqual(during.loading[0].name, REGION_NAME,
      'the human-readable name, not the filename — "Loading region.sqlite" is not what a helm reads');

    await pending;
    assert.deepStrictEqual(db.getLoadingStatus().loading, [],
      'a finished load must not leave the region reported as still loading');
    assert.ok(db.getLoadingStatus().filenames.includes('region.sqlite'));
  });

  it('falls back to the filename when the region has no name of its own', async () => {
    // Not every database carries a usable metadata name; the report must still
    // say something rather than "Loading undefined".
    const pending = db.loadDatabaseGraph('nameless.sqlite');
    const during = db.getLoadingStatus();
    const entry = during.loading.find(l => l.filename === 'nameless.sqlite');
    assert.ok(entry, 'the nameless region should still be reported');
    assert.strictEqual(entry!.name, 'nameless.sqlite');
    await pending;
  });

  it('is answerable without the worker, so a poll is not queued behind the load it asks about', () => {
    // getLoadingStatus is synchronous by construction. If it ever needed the
    // worker it would return a promise, and the indicator it feeds would
    // arrive only after the load it was meant to report on had finished.
    const result = db.getLoadingStatus();
    assert.ok(!(result instanceof Promise));
    assert.ok(Array.isArray(result.loading));
  });
});
