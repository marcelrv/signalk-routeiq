/**
 * RoutingDatabase without a plugin data directory: an explicit file list,
 * read-only mode, the pinned loading policy, coverage and status without
 * loading, the data version, and an in-memory RoutingStore.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase, GraphEditError } from 'routeiq-core';
import type { RegionFileEntry, RoutingStore } from 'routeiq-core';
import { directoryDatabaseOptions, scanRoutingDataDir } from '../dist-tsc/data-dir.js';
import { probeReadOnlyConnection, readOnlyHonoured, SqliteWorkerStore } from 'routeiq-core';
import { RoutingEngine } from 'routeiq-core';
import { DEFAULT_CONFIG } from '../dist-tsc/types.js';
import { testOptions } from './engine-helper.js';
import { upgradeToPoiModel } from './poi-model-fixture.js';

const ZEELANDBRUG = path.join('test', 'fixtures', 'zeelandbrug', 'netherlands.sqlite');

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'routeiq-options-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.chmodSync(d, 0o755);
      for (const f of fs.readdirSync(d)) fs.chmodSync(path.join(d, f), 0o644);
    } catch {
      /* already gone */
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function nodeIdFor(lat: number, lon: number): number {
  const latInt = Math.round((Math.round(lat * 100000) / 100000 + 90) * 100000);
  const lonInt = Math.round((Math.round(lon * 100000) / 100000 + 180) * 100000);
  return latInt * 36_000_000 + lonInt;
}

/** Three nodes in a row, 0.05 degrees apart, from (lat, lon) eastwards. */
function regionNodes(lat: number, lon: number): Array<{ id: number; lat: number; lon: number }> {
  return [0, 1, 2].map((i) => ({ id: nodeIdFor(lat, lon + i * 0.05), lat, lon: lon + i * 0.05 }));
}

/** A tiny region file of the current format whose coverage box is the degree
 *  square at (lat, lon). `poiModel: false` leaves it in the old format, which
 *  the database refuses. */
function buildRegion(
  file: string,
  o: { country: string; lat: number; lon: number; updated?: string; poiModel?: boolean },
): void {
  const raw = new DatabaseSync(file, { open: true });
  const run = (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...(params as any[]));
  run(`CREATE TABLE metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL,
    bounding_box TEXT
  )`);
  run(
    `INSERT INTO metadata (country, name, description, last_update_date, bounding_box)
     VALUES (?, ?, '', ?, ?)`,
    [
      o.country,
      `Region ${o.country}`,
      o.updated ?? '2026-01-01T00:00:00Z',
      JSON.stringify({ min_lat: o.lat - 0.5, min_lon: o.lon - 0.5, max_lat: o.lat + 0.5, max_lon: o.lon + 0.5 }),
    ],
  );
  run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
  run(`CREATE TABLE edges (
    source INTEGER, target INTEGER, distance REAL, min_depth REAL,
    max_air_draft REAL, min_width REAL, cost_factor REAL DEFAULT 1.0,
    distance_to_land REAL, edge_type_id INTEGER DEFAULT 0,
    traffic_mode INTEGER DEFAULT 0, edge_kind_id INTEGER DEFAULT 0
  )`);
  const nodes = regionNodes(o.lat, o.lon);
  for (const n of nodes) run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [n.id, n.lat, n.lon]);
  for (let i = 0; i + 1 < nodes.length; i++) {
    for (const [s, t] of [
      [nodes[i].id, nodes[i + 1].id],
      [nodes[i + 1].id, nodes[i].id],
    ]) {
      run(
        `INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edge_kind_id)
         VALUES (?, ?, 3500, 9.0, 30.0, 40.0, 1.0, 500, 0, 0, 0)`,
        [s, t],
      );
    }
  }
  run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
  if (o.poiModel !== false) upgradeToPoiModel(raw);
  raw.close();
}

const A = { country: 'AA', lat: 50.5, lon: 3.5, updated: '2026-02-01T00:00:00Z' };
const B = { country: 'BB', lat: 40.5, lon: 3.5, updated: '2026-03-01T00:00:00Z' };

function entry(dir: string, name: string, enabled = true): RegionFileEntry {
  return { path: path.join(dir, name), enabled };
}

const route = (lat: number, lon: number) => ({
  start: { latitude: lat, longitude: lon },
  end: { latitude: lat, longitude: lon + 0.1 },
  minCoastDistance: 0,
  describe: false,
});

function engineOn(db: RoutingDatabase): RoutingEngine {
  return new RoutingEngine(db, testOptions({ ...DEFAULT_CONFIG }, { draft: 1, beam: 3, airDraft: 10 }));
}

/** name -> size and mtime of every file in a directory. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).sort()) {
    const st = fs.statSync(path.join(dir, f));
    out[f] = `${st.size}:${st.mtimeMs}`;
  }
  return out;
}

/** A RoutingStore decorator that records every path the database opens. */
function spyOn(store: object, seen: string[]): any {
  return new Proxy(store, {
    get(target: any, key) {
      const v = target[key];
      if (typeof v !== 'function') return v;
      return (...args: any[]) => {
        if (key === 'peekMetadata' || key === 'openAll') seen.push(...args[0]);
        if (key === 'openDb') seen.push(args[0]);
        return v.apply(target, args);
      };
    },
  });
}

describe('explicit file list', () => {
  it('opens only the listed files, never one that merely sits in the directory', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    buildRegion(path.join(dir, 'b.sqlite'), B);
    const { SqliteWorkerStore } = await import('routeiq-core');
    for (const policy of ['dynamic', 'pinned', 'bulk'] as const) {
      const seen: string[] = [];
      const db = new RoutingDatabase({
        files: [entry(dir, 'a.sqlite')],
        policy,
        store: spyOn(new SqliteWorkerStore(), seen),
      });
      await db.init();
      await db.loadGraph();
      // The point lies in b.sqlite's box too: asking for it must not open it.
      await db.ensureRegionsLoaded([{ latitude: B.lat, longitude: B.lon }]);
      assert.deepStrictEqual(db.getStatus().files.map((f) => f.filename), ['a.sqlite'], policy);
      assert.ok(!db.hasKnownDatabase('b.sqlite'), policy);
      assert.ok(seen.length > 0 && seen.every((p) => p === path.join(dir, 'a.sqlite')), `${policy}: ${seen}`);
      await db.close();
    }
  });

  it('asks a file-list function again on reloadMetadata, and an empty list fails init', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    buildRegion(path.join(dir, 'b.sqlite'), B);
    const listed: RegionFileEntry[] = [entry(dir, 'a.sqlite')];
    const db = new RoutingDatabase({ files: () => [...listed], fileSource: 'test list' });
    await db.init();
    assert.deepStrictEqual(db.getCoverageStatus().map((f) => f.filename), ['a.sqlite']);
    listed.push(entry(dir, 'b.sqlite', false));
    await db.reloadMetadata();
    const byName = Object.fromEntries(db.getCoverageStatus().map((f) => [f.filename, f.state]));
    assert.deepStrictEqual(byName, { 'a.sqlite': 'not_loaded', 'b.sqlite': 'disabled' });
    await db.close();

    await assert.rejects(new RoutingDatabase({ files: [], fileSource: 'test list' }).init(), /No \.sqlite files found in test list/);
  });

  it('the plugin-side scan lists both states, skips the overlay, and returns absolute paths', () => {
    const dir = tmpDir();
    for (const f of ['x.sqlite', 'y.sqlite.disabled', 'user-edits.sqlite', 'notes.txt', 'user-edits.sqlite.disabled']) {
      fs.writeFileSync(path.join(dir, f), '');
    }
    const found = scanRoutingDataDir(dir)
      .map((e) => [e.enabled, path.basename(e.path)])
      .sort();
    assert.deepStrictEqual(found, [
      [false, 'y.sqlite.disabled'],
      [true, 'x.sqlite'],
    ]);
    assert.throws(() => scanRoutingDataDir(path.join(dir, 'missing')), /Cannot read routing data directory/);
    const prev = process.cwd();
    process.chdir(path.dirname(dir));
    try {
      for (const e of scanRoutingDataDir(path.basename(dir))) assert.ok(path.isAbsolute(e.path), e.path);
    } finally {
      process.chdir(prev);
    }
  });

  it('the scan lists only the active file when both states exist, skips directories, keeps symlinks to files', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'x.sqlite'), '');
    fs.writeFileSync(path.join(dir, 'x.sqlite.disabled'), '');
    fs.mkdirSync(path.join(dir, 'folder.sqlite'));
    fs.writeFileSync(path.join(dir, 'real.dat'), '');
    fs.symlinkSync(path.join(dir, 'real.dat'), path.join(dir, 'link.sqlite'));
    const found = scanRoutingDataDir(dir)
      .map((e) => [e.enabled, path.basename(e.path)])
      .sort();
    assert.deepStrictEqual(found, [
      [true, 'link.sqlite'],
      [true, 'x.sqlite'],
    ]);
  });

  it('a file list naming the same file twice is rejected', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    fs.copyFileSync(path.join(dir, 'a.sqlite'), path.join(dir, 'a.sqlite.disabled'));
    const db = new RoutingDatabase({ files: [entry(dir, 'a.sqlite'), entry(dir, 'a.sqlite.disabled', false)] });
    await assert.rejects(db.init(), /names "a\.sqlite" twice/);
    await db.close();
  });
});

describe('overlay contract', () => {
  it('an overlay that is not the store, or has no path, makes the constructor throw', async () => {
    const files = [{ path: '/memory/mem.sqlite', enabled: true }];
    const mem = new MemoryStore();
    const other = { openOverlay: async () => {} } as any;
    assert.throws(() => new RoutingDatabase({ files, store: mem, overlay: other, overlayPath: '/x' }), /same object as the store/);
    assert.throws(() => new RoutingDatabase({ files, store: mem, overlayPath: '/x' }), /store has no overlay/);
    const sqlite = new (class extends MemoryStore { openOverlay = async () => {}; })();
    assert.throws(() => new RoutingDatabase({ files, store: sqlite, overlay: sqlite as any }), /needs an overlayPath/);
    // Read-only ignores overlay settings, as before.
    assert.doesNotThrow(() => new RoutingDatabase({ files, store: mem, overlay: other, overlayPath: '/x', readOnly: true }));
  });
});

describe('read-only support probe', () => {
  it('honours read-only only when the write was refused as a read-only error', () => {
    assert.strictEqual(readOnlyHonoured({ threw: true, readOnlyError: true }), true);
    assert.strictEqual(readOnlyHonoured({ threw: false, readOnlyError: false }), false);
    assert.strictEqual(readOnlyHonoured({ threw: true, readOnlyError: false }), false);
  });

  it('on this Node a read-only connection refuses the probe and a normal one does not', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'x.sqlite');
    const w = new DatabaseSync(file);
    w.exec('CREATE TABLE t (a)');
    w.close();
    const before = snapshot(dir);

    const ro = new DatabaseSync(file, { readOnly: true });
    assert.strictEqual(probeReadOnlyConnection(ro), true);
    assert.strictEqual(ro.isTransaction, false, 'no transaction is left open');
    ro.close();

    const rw = new DatabaseSync(file);
    assert.strictEqual(probeReadOnlyConnection(rw), false);
    assert.strictEqual(rw.isTransaction, false, 'no transaction is left open');
    assert.strictEqual((rw.prepare('SELECT COUNT(*) AS c FROM sqlite_master').get() as { c: number }).c, 1);
    rw.close();
    assert.deepStrictEqual(snapshot(dir), before, 'the file is as it was');
  });
});

describe('read-only mode', () => {
  for (const policy of ['bulk', 'dynamic', 'pinned'] as const) {
    it(`routes from read-only files and writes nothing (${policy})`, async () => {
      const dir = tmpDir();
      fs.copyFileSync(ZEELANDBRUG, path.join(dir, 'netherlands.sqlite'));
      fs.chmodSync(path.join(dir, 'netherlands.sqlite'), 0o444);
      fs.chmodSync(dir, 0o555);
      const before = snapshot(dir);

      const db = new RoutingDatabase({
        ...directoryDatabaseOptions(dir, { readOnly: true }),
        policy,
      });
      try {
        await db.init();
        await db.loadGraph();
        const result = await engineOn(db).calculateRoute({
          start: { latitude: 51.613, longitude: 3.885 },
          end: { latitude: 51.609, longitude: 3.896 },
          minCoastDistance: 0,
        });
        assert.ok(result.features.length > 0, 'a route was found');

        const status = db.getStatus();
        assert.strictEqual(status.readOnly, true);
        assert.strictEqual(status.overlayPresent, false);
        assert.deepStrictEqual(await db.getOverlayStats(), { nodes: 0, edges: 0, deletedNodes: 0, deletedEdges: 0 });

        const edgeSource = [...(db as any).edgesBySource.keys()][0] as number;
        const edgeTarget = (db as any).edgesBySource.get(edgeSource)[0].target as number;
        const isReadOnlyError = (e: unknown) => e instanceof GraphEditError && e.code === 'READ_ONLY';
        const statsBefore = await db.getStats();
        await assert.rejects(db.updateNode(0, edgeSource, { node_depth: 3 }), isReadOnlyError);
        await assert.rejects(db.updateEdge(0, edgeSource, edgeTarget, { min_depth: 3 }), isReadOnlyError);
        await assert.rejects(db.deleteNode(0, edgeSource), isReadOnlyError);
        await assert.rejects(db.deleteEdge(0, edgeSource, edgeTarget), isReadOnlyError);
        await assert.rejects(db.addNode(0, { id: 1, lat: 51.6, lon: 3.9 }), isReadOnlyError);
        await assert.rejects(
          db.addEdge(0, { source: edgeSource, target: edgeTarget, distance: 10 }),
          isReadOnlyError,
        );
        await assert.rejects(db.clearOverlayDeletedEdges(), isReadOnlyError);
        assert.deepStrictEqual(await db.getStats(), statsBefore, 'a refused edit left the graph as it was');
      } finally {
        await db.close();
      }

      assert.deepStrictEqual(snapshot(dir), before, 'no file was created or modified');
      assert.ok(!fs.existsSync(path.join(dir, 'user-edits.sqlite')), 'no overlay was created');
    });
  }

  it('without read-only the overlay is created and edits work', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    const db = new RoutingDatabase({ ...directoryDatabaseOptions(dir, { dynamicLoading: false }) });
    await db.init();
    await db.loadGraph();
    assert.ok(fs.existsSync(path.join(dir, 'user-edits.sqlite')));
    assert.strictEqual(db.getStatus().overlayPresent, true);
    const [first] = regionNodes(A.lat, A.lon);
    await db.updateNode(0, first.id, { node_depth: 4 });
    await db.close();
  });

  it('a database with no overlay configured rejects edits with NO_OVERLAY', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    const db = new RoutingDatabase({ files: [entry(dir, 'a.sqlite')], policy: 'bulk' });
    await db.init();
    await db.loadGraph();
    await assert.rejects(
      db.deleteNode(0, regionNodes(A.lat, A.lon)[0].id),
      (e: unknown) => e instanceof GraphEditError && e.code === 'NO_OVERLAY',
    );
    assert.ok(!fs.existsSync(path.join(dir, 'user-edits.sqlite')));
    await db.close();
  });
});

describe('pinned loading policy', () => {
  it('loads every enabled region at loadGraph and never loads or evicts afterwards', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    buildRegion(path.join(dir, 'b.sqlite'), B);
    buildRegion(path.join(dir, 'c.sqlite'), { country: 'CC', lat: 30.5, lon: 3.5 });
    const db = new RoutingDatabase({
      files: [entry(dir, 'a.sqlite'), entry(dir, 'b.sqlite'), entry(dir, 'c.sqlite', false)],
      policy: 'pinned',
      // The caps belong to the dynamic policy; pinned ignores them.
      maxLoadedRegions: 1,
      maxLoadedRegionEdges: 1,
    });
    await db.init();
    assert.deepStrictEqual(db.getLoadingStatus().filenames, [], 'nothing before loadGraph');
    await db.loadGraph();
    const states = () => Object.fromEntries(db.getStatus().files.map((f) => [f.filename, f.state]));
    assert.deepStrictEqual(states(), { 'a.sqlite': 'loaded', 'b.sqlite': 'loaded', 'c.sqlite': 'disabled' });
    assert.strictEqual(db.getPolicy(), 'pinned');
    assert.strictEqual(db.isDynamicLoadingEnabled(), false);

    // The on-demand paths do nothing, and a route does not evict.
    await db.ensureRegionsLoaded([{ latitude: 30.5, longitude: 3.5 }]);
    await db.ensureRegionsForBbox({ minLat: 29, minLon: 3, maxLat: 31, maxLon: 4 });
    await db.eagerLoadForPosition(30.5, 3.5, 5);
    await db.eagerLoadIfSingle();
    const result = await engineOn(db).calculateRoute(route(A.lat, A.lon));
    assert.ok(result.features.length > 0);
    await db.enforceRegionCapForTest();
    assert.deepStrictEqual(states(), { 'a.sqlite': 'loaded', 'b.sqlite': 'loaded', 'c.sqlite': 'disabled' });
    await db.close();
  });

  it('a second loadGraph during the first waits for the load, and both fail together', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    const db = new RoutingDatabase({ files: [entry(dir, 'a.sqlite')], policy: 'pinned' });
    await db.init();
    const first = db.loadGraph();
    const second = db.loadGraph();
    await second;
    assert.strictEqual(db.getStatus().counts.loaded, 1, 'loaded when the second call resolves');
    await first;
    await db.close();

    const bad = new RoutingDatabase({ files: [entry(dir, 'a.sqlite')], policy: 'pinned' });
    await bad.init();
    (bad as any).store.loadNavmeshRegions = async () => {
      throw new Error('synthetic read failure');
    };
    const r = await Promise.allSettled([bad.loadGraph(), bad.loadGraph()]);
    assert.deepStrictEqual(r.map((x) => x.status), ['rejected', 'rejected']);
    await bad.close();
  });

  it('an enabled file that is refused for its format fails loadGraph, also on retry; a disabled one does not', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    buildRegion(path.join(dir, 'old.sqlite'), { country: 'OLD', lat: 10.5, lon: 3.5, poiModel: false });
    buildRegion(path.join(dir, 'off.sqlite'), { country: 'OFF', lat: 20.5, lon: 3.5, poiModel: false });
    const db = new RoutingDatabase({
      files: [entry(dir, 'a.sqlite'), entry(dir, 'old.sqlite'), entry(dir, 'off.sqlite', false)],
      policy: 'pinned',
    });
    await db.init();
    await assert.rejects(db.loadGraph(), /old\.sqlite/);
    await assert.rejects(db.loadGraph(), /old\.sqlite/, 'a retry fails the same way');
    await db.close();

    const ok = new RoutingDatabase({
      files: [entry(dir, 'a.sqlite'), entry(dir, 'old.sqlite', false), entry(dir, 'off.sqlite', false)],
      policy: 'pinned',
    });
    await ok.init();
    await ok.loadGraph();
    await ok.close();
  });

  it('a failed load closes the handle it opened', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    const db = new RoutingDatabase({ files: [entry(dir, 'a.sqlite')], policy: 'dynamic' });
    await db.init();
    const store = (db as any).store;
    const closed: number[] = [];
    const close = store.closeDb.bind(store);
    store.closeDb = (i: number) => (closed.push(i), close(i));
    const load = store.loadNavmeshRegions;
    store.loadNavmeshRegions = async () => {
      throw new Error('synthetic read failure');
    };
    await assert.rejects(db.loadDatabaseGraph('a.sqlite'), /synthetic read failure/);
    assert.deepStrictEqual(closed, [0]);
    store.loadNavmeshRegions = load;
    await db.loadDatabaseGraph('a.sqlite');
    assert.deepStrictEqual(closed, [0], 'a merged region is not closed');
    await db.close();
  });

  it('dynamic keeps loading on demand and evicting under its cap', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    buildRegion(path.join(dir, 'b.sqlite'), B);
    const db = new RoutingDatabase({
      files: [entry(dir, 'a.sqlite'), entry(dir, 'b.sqlite')],
      policy: 'dynamic',
      maxLoadedRegions: 1,
    });
    await db.init();
    await db.loadGraph();
    await db.ensureRegionsLoaded([{ latitude: A.lat, longitude: A.lon }]);
    assert.deepStrictEqual(db.getLoadingStatus().filenames, ['a.sqlite']);
    await db.ensureRegionsLoaded([{ latitude: B.lat, longitude: B.lon }]);
    await db.enforceRegionCapForTest();
    assert.deepStrictEqual(db.getLoadingStatus().filenames, ['b.sqlite'], 'a.sqlite was evicted');
    await db.close();
  });
});

describe('coverage without loading', () => {
  it('answers from the coverage index and loads nothing', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    buildRegion(path.join(dir, 'b.sqlite'), B);
    buildRegion(path.join(dir, 'off.sqlite'), { country: 'OFF', lat: 20.5, lon: 3.5 });
    buildRegion(path.join(dir, 'old.sqlite'), { country: 'OLD', lat: 10.5, lon: 3.5, poiModel: false });
    const { SqliteWorkerStore } = await import('routeiq-core');
    const opened: string[] = [];
    const db = new RoutingDatabase({
      files: [entry(dir, 'a.sqlite'), entry(dir, 'b.sqlite'), entry(dir, 'off.sqlite', false), entry(dir, 'old.sqlite')],
      policy: 'dynamic',
      store: spyOn(new SqliteWorkerStore(), opened),
    });
    await db.init();
    await db.loadGraph();
    const openedAtInit = opened.length;
    const stateOf = () => Object.fromEntries(db.getStatus().files.map((f) => [f.filename, f.state]));
    const before = stateOf();

    const c = db.checkCoverage([
      { lat: A.lat, lon: A.lon },
      { lat: B.lat, lon: B.lon },
      { lat: 20.5, lon: 3.5 }, // only the disabled file covers it
      { lat: 10.5, lon: 3.5 }, // only the refused file covers it
      { lat: 0, lon: 0 },
    ]);
    assert.deepStrictEqual(
      c.points.map((p) => [p.served, p.loaded, p.regions.map((r) => r.filename)]),
      [
        [true, false, ['a.sqlite']],
        [true, false, ['b.sqlite']],
        [false, false, []],
        [false, false, []],
        [false, false, []],
      ],
    );
    assert.strictEqual(c.served, false);
    assert.strictEqual(c.loaded, false);
    assert.strictEqual(db.checkCoverage([{ lat: A.lat, lon: A.lon }, { lat: B.lat, lon: B.lon }]).served, true);
    const box = db.checkCoverage({ minLat: 40, minLon: 3, maxLat: 51, maxLon: 4 });
    assert.deepStrictEqual(box.regions.map((r) => r.filename), ['a.sqlite', 'b.sqlite']);
    assert.strictEqual(box.served, true);

    assert.deepStrictEqual(stateOf(), before, 'no state changed');
    assert.strictEqual(opened.length, openedAtInit, 'no file was opened to answer');
    assert.ok(Object.values(stateOf()).filter((s) => s === 'loaded').length === 0);

    await db.loadDatabaseGraph('a.sqlite');
    const after = db.checkCoverage([{ lat: A.lat, lon: A.lon }, { lat: B.lat, lon: B.lon }]);
    assert.deepStrictEqual(after.points.map((p) => p.loaded), [true, false]);
    assert.strictEqual(after.served, true);
    assert.strictEqual(after.loaded, false);
    assert.strictEqual(db.checkCoverage([{ lat: A.lat, lon: A.lon }]).loaded, true);
    await db.close();
  });
});

describe('status and data version', () => {
  it('reports every file, the policy and the data version', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    buildRegion(path.join(dir, 'b.sqlite'), B);
    buildRegion(path.join(dir, 'off.sqlite'), { country: 'OFF', lat: 20.5, lon: 3.5 });
    buildRegion(path.join(dir, 'old.sqlite'), { country: 'OLD', lat: 10.5, lon: 3.5, poiModel: false });
    const db = new RoutingDatabase({
      ...directoryDatabaseOptions(dir, { dynamicLoading: true }),
      files: [entry(dir, 'b.sqlite'), entry(dir, 'a.sqlite'), entry(dir, 'off.sqlite', false), entry(dir, 'old.sqlite')],
      overlayPath: path.join(dir, 'user-edits.sqlite'),
    });
    await db.init();
    await db.loadGraph();
    await db.loadDatabaseGraph('b.sqlite');

    const status = db.getStatus();
    assert.strictEqual(status.policy, 'dynamic');
    assert.strictEqual(status.readOnly, false);
    assert.strictEqual(status.overlayPresent, true);
    assert.deepStrictEqual(status.counts, {
      listed: 4,
      enabled: 3,
      loaded: 1,
      loading: 0,
      notLoaded: 1,
      disabled: 1,
      unsupported: 1,
    });
    const file = (name: string) => status.files.find((f) => f.filename === name)!;
    assert.deepStrictEqual(
      [file('b.sqlite').state, file('b.sqlite').enabled, file('a.sqlite').state, file('off.sqlite').enabled],
      ['loaded', true, 'not_loaded', false],
    );
    assert.deepStrictEqual(file('b.sqlite').stats, { nodes: 3, edges: 4, pois: 0 });
    assert.strictEqual(file('a.sqlite').formatError, null);
    assert.match(file('old.sqlite').formatError ?? '', /older database format/);
    assert.strictEqual(file('old.sqlite').state, 'unsupported');
    // The same refusal is in the catalog behind GET /databases.
    const catalog = await db.getDatabaseCatalog();
    assert.strictEqual(catalog.find((c) => c.filename === 'old.sqlite')!.formatError, file('old.sqlite').formatError);

    assert.deepStrictEqual(db.getDataVersion(), [{ filename: 'b.sqlite', lastUpdateDate: B.updated }]);
    assert.deepStrictEqual(
      db.getDataVersion('all').map((v) => v.filename),
      ['a.sqlite', 'b.sqlite', 'off.sqlite', 'old.sqlite'],
      'sorted by filename',
    );
    assert.deepStrictEqual(file('a.sqlite').version, { filename: 'a.sqlite', lastUpdateDate: A.updated });

    // A route echoes the data it was calculated from: the loaded regions only.
    const r1 = await engineOn(db).calculateRoute(route(B.lat, B.lon));
    assert.deepStrictEqual(r1.inputs?.data, [{ filename: 'b.sqlite', lastUpdateDate: B.updated }]);
    await db.loadDatabaseGraph('a.sqlite');
    const r2 = await engineOn(db).calculateRoute(route(A.lat, A.lon));
    assert.deepStrictEqual(r2.inputs?.data, [
      { filename: 'a.sqlite', lastUpdateDate: A.updated },
      { filename: 'b.sqlite', lastUpdateDate: B.updated },
    ]);
    await db.close();
  });
});

/** A RoutingStore over a hand-made graph: no files, no worker. */
class MemoryStore implements RoutingStore {
  readonly opened: string[] = [];
  private readonly nodes = regionNodes(52, 5);
  private readonly meta = {
    id: 1,
    country: 'MEM',
    name: 'Memory region',
    description: null,
    lastUpdateDate: '2026-05-05T00:00:00Z',
    tags: null,
    boundingBox: JSON.stringify({ min_lat: 51.5, min_lon: 4.5, max_lat: 52.5, max_lon: 5.5 }),
    boundaryGeometry: null,
    schemaVersion: 4,
    contributor: null,
    url: null,
    filename: 'mem.sqlite',
  };
  private readonly flags = {
    hasCrossesLand: false,
    hasCrossesObstacle: false,
    hasNodeDepth: false,
    hasRegionId: false,
    hasEdgeKind: false,
  };
  private readonly stats = { nodes: 3, edges: 4, pois: 0 };

  async openAll(paths: string[]) {
    this.opened.push(...paths);
    return { ...this.flags, filenames: ['mem.sqlite'], descriptionErrors: {}, formatErrors: {} };
  }
  async peekMetadata(paths: string[]) {
    return paths.map((p) => ({
      path: p,
      filename: path.basename(p),
      coverage: { boundingBox: { min_lat: 51.5, min_lon: 4.5, max_lat: 52.5, max_lon: 5.5 }, boundaryGeometry: null },
      meta: this.meta,
      flags: this.flags,
      stats: this.stats,
      formatError: null,
    }));
  }
  async openDb(p: string) {
    this.opened.push(p);
    return { dbIndex: 0, filename: path.basename(p), flags: this.flags, descriptionError: null };
  }
  async closeDb() {}
  async loadNodes() {
    return this.nodes.map((n) => ({ ...n, node_depth: -1, region_id: 0, node_depth_known: false, db_index: 0 }));
  }
  async loadEdges() {
    const edges = [];
    for (let i = 0; i + 1 < this.nodes.length; i++) {
      for (const [s, t] of [
        [this.nodes[i].id, this.nodes[i + 1].id],
        [this.nodes[i + 1].id, this.nodes[i].id],
      ]) {
        edges.push({
          source: s, target: t, distance: 3500, min_depth: 9, max_air_draft: 30, min_width: 40,
          cost_factor: 1, distance_to_land: 500, edge_type_id: 0, traffic_mode: 0, edge_kind_id: 0,
          min_depth_known: true, db_index: 0,
        });
      }
    }
    return edges;
  }
  async loadPois() { return []; }
  async loadNavmeshRegions() { return []; }
  async getMetadata() { return [{ ...this.meta, stats: this.stats }]; }
  async describeRoute(pairs: unknown[]) {
    return { perPair: pairs.map(() => null), sequences: {}, waterBodies: {}, notices: {} };
  }
  async poiInfo() { return {}; }
  async routePois(pairs: unknown[]) { return pairs.map(() => ({ poiIds: [], known: false })); }
  async close() {}
}

describe('a route with no length', () => {
  it('still carries the inputs and the data version', async () => {
    const dir = tmpDir();
    buildRegion(path.join(dir, 'a.sqlite'), A);
    const db = new RoutingDatabase({ files: [entry(dir, 'a.sqlite')], policy: 'bulk' });
    await db.init();
    await db.loadGraph();
    const here = { latitude: A.lat, longitude: A.lon };
    const result = await engineOn(db).calculateRoute({ start: here, end: here, minCoastDistance: 0, describe: false });
    assert.ok(result.inputs, 'inputs present');
    assert.deepStrictEqual(result.inputs?.data, [{ filename: 'a.sqlite', lastUpdateDate: A.updated }]);
    await db.close();
  });
});

describe('an in-memory RoutingStore', () => {
  for (const policy of ['bulk', 'dynamic', 'pinned'] as const) {
    it(`backs a graph the engine can route on, without files or a worker (${policy})`, async () => {
      const store = new MemoryStore();
      const db = new RoutingDatabase({
        files: [{ path: '/memory/mem.sqlite', enabled: true }],
        policy,
        store,
        readOnly: true,
      });
      await db.init();
      await db.loadGraph();
      if (policy === 'dynamic') await db.ensureRegionsLoaded([{ latitude: 52, longitude: 5 }]);
      const result = await engineOn(db).calculateRoute(route(52, 5));
      assert.ok(result.features.length > 0, 'a route was found');
      assert.ok((result.totalDistance ?? 0) > 5000, 'it ran the length of the three nodes');
      assert.deepStrictEqual(result.inputs?.data, [{ filename: 'mem.sqlite', lastUpdateDate: '2026-05-05T00:00:00Z' }]);
      assert.deepStrictEqual(await db.getStats(), { nodes: 3, edges: 4, pois: 0 });
      await assert.rejects(db.deleteNode(0, 1), (e: unknown) => e instanceof GraphEditError);
      await db.close();
    });
  }
});

describe('store handles across close', () => {
  it('a dbIndex from before close() is refused after the store reopens another file', async () => {
    const dir = tmpDir();
    const a = path.join(dir, 'a.sqlite');
    const b = path.join(dir, 'b.sqlite');
    buildRegion(a, A);
    buildRegion(b, B);
    const store = new SqliteWorkerStore();
    try {
      const opened = (await store.openDb(a)) as { dbIndex: number };
      const oldIndex = opened.dbIndex;
      assert.ok((await store.loadNodes({ dbIndexes: [oldIndex] })).length > 0);
      await store.close();
      const reopened = (await store.openDb(b)) as { dbIndex: number };
      assert.notStrictEqual(reopened.dbIndex, oldIndex, 'the new file gets a new handle');
      await assert.rejects(store.loadNodes({ dbIndexes: [oldIndex] }), /Stale database handle/);
      await assert.rejects(store.loadEdges({ dbIndexes: [oldIndex] }), /Stale database handle/);
      await assert.rejects(store.closeDb(oldIndex), /Stale database handle/);
      assert.ok((await store.loadNodes({ dbIndexes: [reopened.dbIndex] })).length > 0, 'the new handle works');
      // A re-initialisation ends the handles of the set before it as well.
      await store.openAll([a, b]);
      await assert.rejects(store.loadNodes({ dbIndexes: [reopened.dbIndex] }), /Stale database handle/);
    } finally {
      await store.close();
    }
  });
});
