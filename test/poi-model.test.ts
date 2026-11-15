/**
 * The routing database's POI model as routeiq reads it (format spec §1.1
 * format generation, §1.2 schema version 4, §2.10 wholes and parts, §2.14
 * edge_pois): files that are not in the model are refused with a message,
 * a route reports the whole and uses the part, `info` is read on demand.
 *
 * Fixture: five nodes in a line along 52.0N, ~690 m apart (node i at lon
 * 5.00 + 0.01 * (i - 1)); the edges between neighbours; the POIs below, each
 * part sitting on a node (a producer puts a node inside every chamber).
 *
 *   Test Lock (whole 100, wait 20)   chamber 101 on edge 2-3
 *     span 401 over its head ("Road bridge", parent 100)   on edge 3-4
 *   Lock B (whole 200, wait 20)      chamber 201 on edge 4-5, own wait 0
 *   Test Bridge (whole 300)          spans 301 (fixed, info.height 3.2) and 302
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';
import { EDGE_POIS_DDL, POIS_DDL, upgradeToPoiModel } from './poi-model-fixture.js';

const LAT = 52.0;
const lonOf = (node: number) => 5.0 + 0.01 * (node - 1);

interface PoiSpec {
  id: number;
  type: number;
  parent?: number | null;
  name?: string | null;
  properties?: string | Record<string, unknown> | null;
  info?: string | Record<string, unknown> | null;
  lat?: number;
  lon?: number;
}

interface FileSpec {
  country: string;
  nodes: number[];
  /** Node pairs; both directions are written. */
  edges: Array<[number, number]>;
  pois?: PoiSpec[];
  edgePois?: Array<[number, number, number]>;
  /** How the file is finished: the current model (default), or an older or newer file. */
  format?:
    | { kind: 'model'; formatGeneration?: number; schemaVersion?: number }
    | { kind: 'schema3' } // pois without parent_id/info, no edge_pois, schema_version 3
    | { kind: 'no-edge-pois' } // schema 4 and parent_id, but no edge_pois table
    | { kind: 'no-generation-column' }; // schema 4 model, metadata has no format_generation
}

const json = (v: PoiSpec['properties']) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));

function buildFile(file: string, spec: FileSpec): void {
  const db = new DatabaseSync(file, { open: true });
  const run = (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as SQLInputValue[]));
  run(`CREATE TABLE metadata (id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
       description TEXT, last_update_date TEXT NOT NULL, bounding_box TEXT)`);
  run(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box) VALUES (?, ?, 'fixture', '2026-01-01T00:00:00Z', ?)`,
    [spec.country, `Region ${spec.country}`, JSON.stringify({ min_lat: 51.9, min_lon: 4.9, max_lat: 52.1, max_lon: 5.2 })]);
  run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
  for (const n of spec.nodes) run('INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)', [n, LAT, lonOf(n)]);
  run(`CREATE TABLE edges (source INTEGER, target INTEGER, distance REAL, min_depth REAL, max_air_draft REAL, min_width REAL,
       cost_factor REAL DEFAULT 1.0, distance_to_land REAL, edge_type_id INTEGER DEFAULT 1, traffic_mode INTEGER DEFAULT 0)`);
  for (const [a, b] of spec.edges) {
    for (const [s, t] of [[a, b], [b, a]]) {
      run('INSERT INTO edges VALUES (?, ?, 690, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0)', [s, t]);
    }
  }
  const format = spec.format ?? { kind: 'model' };
  const model = format.kind === 'model' || format.kind === 'no-generation-column' || format.kind === 'no-edge-pois';
  run(model ? POIS_DDL : `CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
  for (const p of spec.pois ?? []) {
    const lat = p.lat ?? LAT;
    const lon = p.lon ?? lonOf(1);
    if (model) {
      run('INSERT INTO pois (id, type_id, parent_id, name, properties, info, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [p.id, p.type, p.parent ?? null, p.name ?? null, json(p.properties), json(p.info), lat, lon]);
    } else {
      run('INSERT INTO pois (id, name, type_id, properties, lat, lon) VALUES (?, ?, ?, ?, ?, ?)', [p.id, p.name ?? '', p.type, json(p.properties), lat, lon]);
    }
  }
  switch (format.kind) {
    case 'model':
      upgradeToPoiModel(db, { formatGeneration: format.formatGeneration, schemaVersion: format.schemaVersion });
      break;
    case 'schema3':
      db.exec('ALTER TABLE metadata ADD COLUMN schema_version INTEGER');
      db.exec('UPDATE metadata SET schema_version = 3');
      break;
    case 'no-edge-pois':
      db.exec('ALTER TABLE metadata ADD COLUMN schema_version INTEGER');
      db.exec('UPDATE metadata SET schema_version = 4');
      break;
    case 'no-generation-column':
      db.exec('ALTER TABLE metadata ADD COLUMN schema_version INTEGER');
      db.exec('UPDATE metadata SET schema_version = 4');
      db.exec(EDGE_POIS_DDL);
      break;
  }
  if (model && format.kind !== 'no-edge-pois') {
    for (const [a, b, poi] of spec.edgePois ?? []) {
      run('INSERT INTO edge_pois (source, target, poi_id) VALUES (?, ?, ?)', [Math.min(a, b), Math.max(a, b), poi]);
    }
  }
  db.close();
}

const MODEL_POIS: PoiSpec[] = [
  { id: 100, type: 1, name: 'Test Lock', properties: { typical_wait_minutes: 20 }, info: { kind: 'lock' }, lon: lonOf(2.5) },
  { id: 101, type: 5, parent: 100, name: 'Test Lock chamber', lon: lonOf(2) },
  { id: 401, type: 6, parent: 100, name: 'Road bridge', properties: { subtype: 'opening', typical_wait_minutes: 3 }, info: { kind: 'bascule' }, lon: lonOf(3) },
  { id: 200, type: 1, name: 'Lock B', properties: { typical_wait_minutes: 20 }, lon: lonOf(4) },
  { id: 201, type: 5, parent: 200, name: 'Lock B chamber', properties: { typical_wait_minutes: 0 }, lon: lonOf(4) },
  { id: 300, type: 2, name: 'Test Bridge', info: { kind: 'bridge' }, lon: lonOf(1) },
  { id: 301, type: 6, parent: 300, name: 'Test Bridge span 1', properties: { subtype: 'fixed' }, info: { height: 3.2, height_source: 'chart' }, lat: LAT + 0.0002, lon: lonOf(1) },
  { id: 302, type: 6, parent: 300, name: 'Test Bridge span 2', properties: { subtype: 'opening', closed_height: 1.5 }, lat: LAT + 0.0004, lon: lonOf(1) + 0.0001 },
  { id: 1, type: 0, name: 'Test Harbour', properties: {}, info: { refs: [{ scheme: 'osm', id: 'node/1' }] }, lat: LAT + 0.01, lon: lonOf(1) },
];
const MODEL_EDGE_POIS: Array<[number, number, number]> = [[2, 3, 101], [3, 4, 401], [4, 5, 201], [1, 2, 301]];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routeiq-poimodel-'));
}

describe('files that are not in the POI model are refused', () => {
  let dir: string;
  before(() => {
    dir = tmpDir();
    buildFile(path.join(dir, 'good.sqlite'), { country: 'GOOD', nodes: [1, 2], edges: [[1, 2]], pois: MODEL_POIS, edgePois: MODEL_EDGE_POIS });
    buildFile(path.join(dir, 'gen1.sqlite'), { country: 'GEN1', nodes: [1, 2], edges: [[1, 2]], format: { kind: 'model', formatGeneration: 1 } });
    buildFile(path.join(dir, 'schema3.sqlite'), { country: 'SCH3', nodes: [1, 2], edges: [[1, 2]], format: { kind: 'schema3' } });
    buildFile(path.join(dir, 'noedgepois.sqlite'), { country: 'NOEP', nodes: [1, 2], edges: [[1, 2]], format: { kind: 'no-edge-pois' } });
    buildFile(path.join(dir, 'v3model.sqlite'), { country: 'V3M', nodes: [1, 2], edges: [[1, 2]], format: { kind: 'model', schemaVersion: 3 } });
    buildFile(path.join(dir, 'nogen.sqlite'), { country: 'NOGN', nodes: [1, 2], edges: [[1, 2]], format: { kind: 'no-generation-column' } });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const dynamic of [true, false]) {
    describe(dynamic ? 'dynamic loading' : 'bulk loading', () => {
      let db: RoutingDatabase;
      before(async () => {
        db = new RoutingDatabase(dir, dynamic);
        await db.init();
        await db.loadGraph();
      });
      after(async () => {
        await db.close();
      });

      const byName = async () => new Map((await db.getDatabaseCatalog()).map((c) => [c.filename, c]));

      it('a format generation this build does not know is listed as unsupported, with a message naming the generation', async () => {
        const e = (await byName()).get('gen1.sqlite')!;
        assert.strictEqual(e.state, 'unsupported');
        assert.match(e.formatError!, /format generation 1/);
      });

      it('a file without pois.parent_id and edge_pois is refused because those are missing, with a message to rebuild it', async () => {
        const e = (await byName()).get('schema3.sqlite')!;
        assert.strictEqual(e.state, 'unsupported');
        assert.match(e.formatError!, /older database format.*no pois\.parent_id and edge_pois.*Rebuild it with the factory/);
      });

      it('a file is judged by presence, not by schema_version: the model\'s columns under schema_version 3 are read', async () => {
        const e = (await byName()).get('v3model.sqlite')!;
        assert.notStrictEqual(e.state, 'unsupported');
        assert.strictEqual(e.formatError, null);
      });

      it('a file with parent_id but no edge_pois table is refused as an older format', async () => {
        const e = (await byName()).get('noedgepois.sqlite')!;
        assert.strictEqual(e.state, 'unsupported');
        assert.match(e.formatError!, /older database format/);
      });

      it('a file without a format_generation column is generation 0 and is read', async () => {
        const e = (await byName()).get('nogen.sqlite')!;
        assert.notStrictEqual(e.state, 'unsupported');
        assert.strictEqual(e.formatError, null);
      });

      it('a current file has no formatError, and refused files are not counted as available', async () => {
        const good = (await byName()).get('good.sqlite')!;
        assert.strictEqual(good.formatError, null);
        assert.notStrictEqual(good.state, 'unsupported');
        assert.strictEqual(db.getLoadingStatus().available, 3, 'good + v3model + nogen only');
        assert.strictEqual(db.getLoadingStatus().unsupported, 3, 'gen1, schema3, noedgepois');
      });

      it('a refused file never enters the graph', async () => {
        const nodes = await db.getStats();
        assert.strictEqual(nodes.nodes, dynamic ? 0 : 2, 'bulk mode holds the readable files\' shared 2 nodes; dynamic loads nothing yet');
        if (dynamic) {
          await assert.rejects(db.loadDatabaseGraph('gen1.sqlite'), /format generation 1/);
          await assert.rejects(db.loadDatabaseGraph('schema3.sqlite'), /Rebuild it with the factory/);
          // An explicit load must not turn a refused file back into a loadable one.
          const byState = new Map(db.getCoverageStatus().map((c) => [c.filename, c.state]));
          assert.strictEqual(byState.get('gen1.sqlite'), 'unsupported');
          assert.strictEqual(byState.get('schema3.sqlite'), 'unsupported');
          assert.strictEqual(db.getLoadingStatus().available, 3);
        }
      });
    });
  }

  it('a file replaced on disk by an old-format one after the peek stays unsupported when loaded, and is not retried', async () => {
    const d = tmpDir();
    try {
      buildFile(path.join(d, 'a.sqlite'), { country: 'AAA', nodes: [1, 2], edges: [[1, 2]] });
      const db = new RoutingDatabase(d, true);
      await db.init();
      fs.unlinkSync(path.join(d, 'a.sqlite'));
      buildFile(path.join(d, 'a.sqlite'), { country: 'AAA', nodes: [1, 2], edges: [[1, 2]], format: { kind: 'schema3' } });
      await assert.rejects(db.loadDatabaseGraph('a.sqlite'), /a\.sqlite: .*Rebuild it with the factory/);
      assert.strictEqual(db.getCoverageStatus()[0].state, 'unsupported');
      assert.strictEqual(db.getLoadingStatus().available, 0);
      assert.strictEqual(db.getLoadingStatus().unsupported, 1);
      // The area it covers is reported with the reason when a route finds no graph there.
      assert.match(db.unsupportedCoverageNote(52.0, 5.05), /a\.sqlite covers this area but is not used: .*Rebuild it/);
      assert.strictEqual(db.unsupportedCoverageNote(10, 10), '');
      await db.close();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('a directory holding only refused files fails to start, saying why', async () => {
    const only = tmpDir();
    try {
      buildFile(path.join(only, 'schema3.sqlite'), { country: 'SCH3', nodes: [1, 2], edges: [[1, 2]], format: { kind: 'schema3' } });
      const db = new RoutingDatabase(only, false);
      await assert.rejects(db.init(), /schema3\.sqlite: Built with an older database format/);
      await db.close();
    } finally {
      fs.rmSync(only, { recursive: true, force: true });
    }
  });
});

describe('POIs: wholes, parts, info on demand', () => {
  let dir: string;
  let db: RoutingDatabase;

  before(async () => {
    dir = tmpDir();
    const many: PoiSpec[] = [];
    for (let i = 0; i < 600; i++) many.push({ id: 10_000 + i, type: 0, name: `Crowd ${i}`, lat: 52.03 + i * 1e-5, lon: 5.03 });
    buildFile(path.join(dir, 'a.sqlite'), {
      country: 'AAA',
      nodes: [1, 2, 3, 4, 5],
      edges: [[1, 2], [2, 3], [3, 4], [4, 5]],
      pois: [
        ...MODEL_POIS,
        { id: 900, type: 9, name: 'Mystery', lat: LAT + 0.001, lon: lonOf(2) },
        { id: 901, type: 4, name: 'Test Waterway', lat: LAT + 0.001, lon: lonOf(2) },
        { id: 902, type: 0, name: 'Bad JSON Harbour', properties: '{not json', info: '[1,2]', lat: LAT + 0.002, lon: lonOf(2) },
        ...many,
      ],
      edgePois: MODEL_EDGE_POIS,
    });
    db = new RoutingDatabase(dir, false);
    await db.init();
    await db.loadGraph();
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a POI type this build does not know: it is neither drawn nor searched, and never a harbour', async () => {
    const inBox = await db.getPoisInBBox(LAT - 0.01, 5.0, LAT + 0.01, 5.05);
    assert.ok(!inBox.some((p) => p.id === 900 || p.id === 901), 'types 9 and 4 are dropped at load');
    assert.deepStrictEqual((await db.searchPois('Mystery')).map((p) => p.id), []);
    assert.deepStrictEqual((await db.searchPois('Test Waterway')).map((p) => p.id), []);
    assert.strictEqual(db.getPoiRow(900), undefined);
  });

  it('the map query returns parts and harbours, never a whole, each once', async () => {
    const ids = (await db.getPoisInBBox(LAT - 0.01, 5.0, LAT + 0.01, 5.05)).map((p) => p.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [1, 101, 201, 301, 302, 401, 902]);
  });

  it('search lists wholes and harbours, and not the parts of a whole', async () => {
    const r = await db.searchPois('Test');
    assert.deepStrictEqual(r.map((p) => p.id).sort((a, b) => a - b), [1, 100, 300]);
    assert.ok(r.every((p) => p.typeId !== 5 && p.typeId !== 6), 'no chamber or span in the list');
    const lock = await db.searchPois('Test Lock');
    assert.deepStrictEqual(lock.map((p) => p.id), [100], 'the lock is found once, not once per chamber or span');
  });

  it('carries info as its own field beside properties, for the map, search and nearest queries', async () => {
    const span = (await db.getPoisInBBox(...[LAT - 0.01, 5.0, LAT + 0.01, 5.05] as [number, number, number, number])).find((p) => p.id === 301)!;
    assert.deepStrictEqual(span.properties, { subtype: 'fixed' });
    assert.deepStrictEqual(span.info, { height: 3.2, height_source: 'chart' });
    const found = (await db.searchPois('Test Bridge')).find((p) => p.id === 300)!;
    assert.deepStrictEqual(found.info, { kind: 'bridge' });
    assert.deepStrictEqual(found.properties, {});
    const near = await db.getNearestPoi(LAT + 0.0002, lonOf(1), 100);
    assert.strictEqual(near?.id, 301);
    assert.strictEqual(near?.info.height, 3.2);
    assert.strictEqual(near?.parentId, 300);
  });

  it('does not hold info in memory: it is read from the file when asked', async () => {
    const row = db.getPoiRow(301) as unknown as Record<string, unknown>;
    assert.ok(row && !('info' in row), 'the loaded POI row has no info');
    assert.deepStrictEqual(await db.getPoiInfo([301, 100, 12345]), {
      '301': { height: 3.2, height_source: 'chart' },
      '100': { kind: 'lock' },
    });
    assert.deepStrictEqual(await db.getPoiInfo([]), {});
  });

  it('reads malformed properties or info as empty instead of failing the query', async () => {
    const bad = (await db.getPoisInBBox(LAT - 0.01, 5.0, LAT + 0.01, 5.05)).find((p) => p.id === 902)!;
    assert.deepStrictEqual(bad.properties, {});
    assert.deepStrictEqual(bad.info, {}, 'an info that is not an object is absent');
    const r = await db.searchPois('Bad JSON');
    assert.deepStrictEqual(r[0].properties, {});
  });

  it('returns at most 500 POIs for one box by default (the API clamps a larger request to it)', async () => {
    const r = await db.getPoisInBBox(52.02, 5.02, 52.05, 5.04);
    assert.strictEqual(r.length, 500);
  });

  it('over the cap, the map keeps the POIs nearest the box centre, not the first in grid order', async () => {
    const r = await db.getPoisInBBox(52.02, 5.02, 52.05, 5.04, 5);
    const centreLat = (52.02 + 52.05) / 2;
    const all = await db.getPoisInBBox(52.02, 5.02, 52.05, 5.04, 10_000);
    const d = (p: { lat: number; lon: number }) => (p.lat - centreLat) ** 2 + (p.lon - 5.03) ** 2;
    const nearest = [...all].sort((a, b) => d(a) - d(b)).slice(0, 5).map((p) => p.id).sort();
    assert.deepStrictEqual(r.map((p) => p.id).sort(), nearest);
  });

  it('route building can ask for parts only, uncapped and without info', async () => {
    const parts = await db.getPoisInBBox(51.95, 4.95, 52.05, 5.1, Number.MAX_SAFE_INTEGER, { types: new Set([5, 6]), includeInfo: false });
    assert.deepStrictEqual(parts.map((p) => p.id).sort((a, b) => a - b), [101, 201, 301, 302, 401]);
    assert.ok(parts.every((p) => Object.keys(p.info).length === 0), 'no info was read');
    const crowd = await db.getPoisInBBox(52.02, 5.02, 52.05, 5.04, Number.MAX_SAFE_INTEGER, { types: new Set([0]) });
    assert.strictEqual(crowd.length, 600, 'no 500 cap when the caller asks for none');
  });

  it('gives a part its whole, and a whole its parts', () => {
    const chamber = db.getPoiRow(101)!;
    assert.strictEqual(db.getPoiParent(chamber)?.id, 100);
    assert.deepStrictEqual(db.getPoiChildren(100).map((p) => p.id).sort(), [101, 401]);
    assert.strictEqual(db.getPoiParent(db.getPoiRow(100)!), undefined, 'a whole has no parent');
  });
});

describe('a route reports the whole and uses the part', () => {
  let dir: string;
  let db: RoutingDatabase;
  let engine: RoutingEngine;

  before(async () => {
    dir = tmpDir();
    buildFile(path.join(dir, 'a.sqlite'), {
      country: 'AAA',
      nodes: [1, 2, 3, 4, 5],
      edges: [[1, 2], [2, 3], [3, 4], [4, 5]],
      pois: MODEL_POIS,
      edgePois: MODEL_EDGE_POIS,
    });
    db = new RoutingDatabase(dir, false);
    await db.init();
    await db.loadGraph();
    engine = new RoutingEngine(db, DEFAULT_CONFIG);
    engine.setVesselDimensions({ draft: 1.0, beam: 3.0, airDraft: 5.0 });
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const route = () =>
    engine.calculateRoute({
      start: { latitude: LAT, longitude: lonOf(1) },
      end: { latitude: LAT, longitude: lonOf(5) },
      minCoastDistance: 0,
    });

  it('groups the two spans of one bridge into one crossing named after the bridge, with the whole\'s id as structure', async () => {
    const r = await route();
    const bridges = (r.crossings ?? []).filter((c) => c.structure === '300');
    assert.strictEqual(bridges.length, 1, `got ${JSON.stringify(r.crossings)}`);
    assert.match(bridges[0].name, /^Test Bridge /);
    assert.strictEqual(bridges[0].type, 'bridge');
  });

  it('reports a lock under its own name with the chamber used, and the span over its head as a bridge of that lock', async () => {
    const r = await route();
    const locks = (r.crossings ?? []).filter((c) => c.type === 'lock');
    assert.deepStrictEqual(locks.map((c) => [c.name, c.structure, c.partId]).sort(), [
      ['Lock B', '200', 201],
      ['Test Lock', '100', 101],
    ]);
    const span = (r.crossings ?? []).find((c) => c.name.startsWith('Road bridge'))!;
    assert.strictEqual(span.type, 'bridge');
    assert.strictEqual(span.structure, '100', 'the span is a part of the lock it is carried over');
  });

  it('takes the wait from the lock, and from a chamber that overrides it (0 included)', async () => {
    const r = await route();
    const lockA = r.crossings!.find((c) => c.structure === '100' && c.type === 'lock')!;
    const lockB = r.crossings!.find((c) => c.structure === '200')!;
    assert.strictEqual(lockA.waitMinutes, 20, 'chamber 101 has no value of its own: the lock\'s applies');
    assert.strictEqual(lockB.waitMinutes, 0, 'chamber 201 stands open: its 0 overrides the lock\'s 20');
    assert.strictEqual(lockB.waitSeconds, undefined, 'a 0-minute lock charges nothing');
    assert.strictEqual(r.totalWaitSeconds, 20 * 60, 'only Test Lock costs time (its span opens with it)');
  });

  it('places the lock from the edges: crossings carry a lockSpan taken from edge_pois', async () => {
    const r = await route();
    const lockA = r.crossings!.find((c) => c.structure === '100' && c.type === 'lock')!;
    assert.ok(lockA.lockSpan, 'the edges through chamber 101 and under span 401 gave the lock an extent');
    assert.ok(lockA.lockSpan![1] > lockA.lockSpan![0]);
  });

  it('marks the segments that pass a chamber, or a span over a lock head, with the lock\'s id', async () => {
    const path1 = [1, 2, 3, 4, 5];
    const result = await (engine as unknown as EngineProbe).buildRouteResult(path1, path1, 0);
    const segs = result.features[0].properties.segments as Array<{ lockIds?: number[] }>;
    assert.deepStrictEqual(segs.map((s) => s.lockIds ?? null), [
      null, // 1-2: only a bridge span of a bridge whole
      [100], // 2-3: chamber 101 of Test Lock
      [100], // 3-4: span 401, carried over Test Lock's head, has no chamber of its own here
      [200], // 4-5: chamber 201 of Lock B
    ]);
  });

  it('gives a span over a lock head the lock, from edge_pois alone', async () => {
    // Direction does not matter: pairs are normalised.
    const seg: { from: number; to: number; nodes: number[]; lockIds?: number[] } = { from: 3, to: 4, nodes: [4, 3] };
    await (engine as unknown as EngineProbe).detectRouteStructures([[lonOf(3), LAT], [lonOf(4), LAT]], [seg]);
    assert.deepStrictEqual(seg.lockIds, [100]);
  });

  it('answers routePois per pair: the parts it passes, and whether any file knew the pair', async () => {
    const r = await db.getRoutePois([[1, 2], [2, 3], [3, 4], [4, 5], [2, 5], [99, 100]]);
    assert.deepStrictEqual(r.map((x) => [x.poiIds, x.known]), [
      [[301], true],
      [[101], true],
      [[401], true],
      [[201], true],
      [[], false], // not an edge of any file
      [[], false],
    ]);
  });
});

describe('edge_pois of several files are united', () => {
  let dir: string;
  let db: RoutingDatabase;

  before(async () => {
    dir = tmpDir();
    // Two files share the pair 2-3 (a seam). Each knows a different chamber of the same lock,
    // and both files hold the whole and both chambers (spec §2.10: parts are written in every
    // database with an edge_pois row pointing to them).
    const lockPois: PoiSpec[] = [
      { id: 100, type: 1, name: 'Seam Lock', properties: { typical_wait_minutes: 10 }, lon: lonOf(2.5) },
      { id: 101, type: 5, parent: 100, lon: lonOf(2.5) },
      { id: 102, type: 5, parent: 100, lon: lonOf(2.5) },
    ];
    buildFile(path.join(dir, 'west.sqlite'), { country: 'WST', nodes: [1, 2, 3], edges: [[1, 2], [2, 3]], pois: lockPois, edgePois: [[2, 3, 101]] });
    buildFile(path.join(dir, 'east.sqlite'), { country: 'EST', nodes: [2, 3, 4], edges: [[2, 3], [3, 4]], pois: lockPois, edgePois: [[2, 3, 102]] });
    db = new RoutingDatabase(dir, true);
    await db.init();
    await db.loadGraph();
    await db.loadDatabaseGraph('west.sqlite');
    await db.loadDatabaseGraph('east.sqlite');
  });
  after(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('takes the union of the rows of every file that holds the pair; a file that lacks the pair has no say', async () => {
    const r = await db.getRoutePois([[2, 3], [1, 2], [3, 4]]);
    assert.deepStrictEqual(r[0].poiIds.sort(), [101, 102]);
    assert.deepStrictEqual(r[1], { poiIds: [], known: true }, 'only west holds 1-2, and it lists none');
    assert.deepStrictEqual(r[2], { poiIds: [], known: true });
  });

  it('when two files disagree on info for one POI, the first file loaded wins', async () => {
    const d = tmpDir();
    try {
      const mk = (country: string, h: number): FileSpec => ({
        country, nodes: [1, 2], edges: [[1, 2]],
        pois: [{ id: 7, type: 6, parent: 8, name: 'S', info: { height: h } }, { id: 8, type: 2, name: 'B' }],
      });
      buildFile(path.join(d, 'a.sqlite'), mk('AAA', 3));
      buildFile(path.join(d, 'b.sqlite'), mk('BBB', 4));
      const db2 = new RoutingDatabase(d, false);
      await db2.init();
      await db2.loadGraph();
      assert.deepStrictEqual(await db2.getPoiInfo([7]), { '7': { height: 3 } });
      await db2.close();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('holds a whole present in both files once', async () => {
    assert.strictEqual((await db.searchPois('Seam Lock')).length, 1);
    assert.deepStrictEqual(db.getPoiChildren(100).map((p) => p.id).sort(), [101, 102]);
  });
});

/** Private RoutingEngine methods these tests call. */
interface EngineProbe {
  buildRouteResult(
    path: number[],
    pathCopy: number[],
    n: number,
  ): Promise<{ features: Array<{ properties: { segments: unknown } }> }>;
  detectRouteStructures(coords: [number, number][], segs: unknown[]): Promise<unknown[]>;
}
/** RoutingDatabase with its edge lookup and message channel replaced. */
interface DbProbe {
  getEdgeSync: (a: number, b: number) => object | null;
  sendMessage: (t: string, p: { pairs: Array<{ dbIndexes: number[] | null }> }) => Promise<unknown[]>;
  getRoutePois(pairs: Array<[number, number]>): Promise<unknown>;
}

describe('POI lookups: direction and ground distance', () => {
  it('getRoutePois asks the files of both directions, and every file when one is untagged', async () => {
    const sent: Array<{ pairs: Array<{ dbIndexes: number[] | null }> }> = [];
    const edges = new Map<string, object>();
    const db = Object.create(RoutingDatabase.prototype) as DbProbe;
    db.getEdgeSync = (a: number, b: number) => edges.get(`${a}>${b}`) ?? null;
    db.sendMessage = async (_t: string, p: { pairs: Array<{ dbIndexes: number[] | null }> }) => {
      sent.push(p);
      return [];
    };
    edges.set('1>2', { dbIndex: 0 });
    edges.set('2>1', { dbIndex: 1, extraDbIndexes: [2, -1, 0] });
    edges.set('3>4', { dbIndex: 3 });
    edges.set('5>6', { dbIndex: 0 });
    edges.set('6>5', {}); // untagged (bulk mode)
    await db.getRoutePois([[1, 2], [3, 4], [4, 3], [5, 6], [8, 9]]);
    const idx = sent[0].pairs.map((p) => (p.dbIndexes ? [...p.dbIndexes].sort() : null));
    assert.deepStrictEqual(idx, [[0, 1, 2], [3], [3], null, []]);
  });

  it('over the cap, the POI nearest in metres is kept, not in degrees', async () => {
    const d = tmpDir();
    try {
      buildFile(path.join(d, 'a.sqlite'), {
        country: 'CAP', nodes: [1, 2], edges: [[1, 2]],
        pois: [
          { id: 1, type: 0, name: 'North', lat: 52.01, lon: 5.0 }, // 1.11 km
          { id: 2, type: 0, name: 'East', lat: 52.0, lon: 5.012 }, // 0.82 km at 52N
        ],
      });
      const db = new RoutingDatabase(d, false);
      await db.init();
      await db.loadGraph();
      const r = await db.getPoisInBBox(51.9, 4.9, 52.1, 5.1, 1, { includeInfo: false });
      assert.deepStrictEqual(r.map((p) => p.id), [2]);
      await db.close();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
