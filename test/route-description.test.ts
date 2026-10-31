import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';
import {
  attachWaters,
  buildRouteDescription,
} from '../dist/route-description.js';
import {
  describePairs,
  detectDescribeFlags,
  findDescribeCollision,
  languageChain,
} from '../dist/route-metadata.js';

// Route description: water names and warnings along a found route, read from
// the edge sequence / water body tables of the routing database
// (SPEC-WAYS-AND-WATERWAYS.md in signalk-router-pipeline). Fixtures are built
// in a temp dir, never in the data dir.
//
//   N0 -- N1 -- N2 -- N3 -- N4 -- N5      lat 52, 0.01 deg apart (~690 m)
//   |-- seq 11 (Kanaal) --|-- seq 12 (Kanaal) --|-- seq 21 (Meer) --|
//   N0..N2 / N2..N3 are two sequences in ONE water body (merge), N3..N5 is
//   another water body with an imported origin, unknown depth and a notice.

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

const LAT = 52;
const LONS = [5.0, 5.01, 5.02, 5.03, 5.04, 5.05];
const NODE = LONS.map(lon => nodeIdFor(LAT, lon));

interface Fixture {
  /** Skip the description tables altogether (an old schema-2 style file). */
  plain?: boolean;
  /** Replace the default enum rows (ids/ranks) or sequences. */
  sequences?: Array<{ id: number; a: number; b: number; wb: number | null; origin: number; quality: number | null }>;
  waterBodies?: Array<{ id: number; name: string; kind: number | null }>;
  /** Extra rows in notices, with edge links over [index of from-node, to-node]. */
  notices?: Array<{ id: number; sourceClass: string; severity: number; text: string; edge: [number, number] }>;
  names?: Array<{ wb: number; lang: string; name: string; kind?: string }>;
}

const DEFAULT_SEQUENCES = [
  { id: 11, a: 0, b: 2, wb: 100, origin: 1, quality: 4 },
  { id: 12, a: 2, b: 3, wb: 100, origin: 1, quality: 4 },
  { id: 21, a: 3, b: 5, wb: 200, origin: 2, quality: 0 },
];
const DEFAULT_WATER_BODIES = [
  { id: 100, name: 'Kanaal', kind: 1 },
  { id: 200, name: 'Meer', kind: 3 },
];
const DEFAULT_NAMES = [
  { wb: 100, lang: 'de', name: 'Kanal Alt', kind: 'alternative' },
  { wb: 100, lang: 'de', name: 'Kanal', kind: 'official' },
  { wb: 100, lang: 'nl', name: 'Kanaal NL', kind: 'official' },
];
const DEFAULT_NOTICES = [
  { id: 1, sourceClass: 'NAVLINE', severity: 1, text: 'Shallow, depth unknown', edge: [4, 5] as [number, number] },
  { id: 2, sourceClass: 'RESARE', severity: 2, text: 'Chart restricted area', edge: [3, 4] as [number, number] },
];

function buildDb(dbPath: string, country: string, fx: Fixture = {}): void {
  const db = new DatabaseSync(dbPath, { open: true });
  const run = (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as any[]));
  run(`CREATE TABLE metadata (id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL, name TEXT NOT NULL,
       description TEXT, last_update_date TEXT NOT NULL, bounding_box TEXT)`);
  run(`INSERT INTO metadata (country, name, description, last_update_date, bounding_box) VALUES (?, ?, 'fixture', '2026-01-01T00:00:00Z', ?)`,
    [country, country, JSON.stringify({ min_lat: 51.9, min_lon: 4.9, max_lat: 52.1, max_lon: 5.2 })]);
  run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`);
  for (const lon of LONS) run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)`, [nodeIdFor(LAT, lon), LAT, lon]);
  const seqs = fx.sequences ?? DEFAULT_SEQUENCES;
  run(`CREATE TABLE edges (source INTEGER, target INTEGER, distance REAL, min_depth REAL, max_air_draft REAL, min_width REAL,
       cost_factor REAL DEFAULT 1.0, distance_to_land REAL, edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
       edge_kind_id INTEGER DEFAULT 0${fx.plain ? '' : ', edge_sequence_id INTEGER, depth_quality_id INTEGER DEFAULT 0'})`);
  run('CREATE INDEX idx_edges_source ON edges(source)');
  for (let i = 0; i + 1 < LONS.length; i++) {
    const d = Math.round(haversine(LAT, LONS[i], LAT, LONS[i + 1]));
    const seq = seqs.find(s => i >= s.a && i + 1 <= s.b);
    for (const [from, to] of [[i, i + 1], [i + 1, i]]) {
      if (fx.plain) {
        run(`INSERT INTO edges VALUES (?, ?, ?, 12.0, 40.0, 50.0, 1.0, 500, 0, 0, 0)`, [NODE[from], NODE[to], d]);
      } else {
        run(`INSERT INTO edges VALUES (?, ?, ?, 12.0, 40.0, 50.0, 1.0, 500, 0, 0, 0, ?, ?)`, [NODE[from], NODE[to], d, seq ? seq.id : null, seq?.quality ?? 0]);
      }
    }
  }
  run(`CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`);
  if (!fx.plain) {
    run('CREATE TABLE origin_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL)');
    for (const [id, d] of [[0, 'other'], [1, 'pipeline'], [2, 'imported'], [3, 'agent'], [4, 'manual'], [5, 'community']] as Array<[number, string]>) {
      run('INSERT INTO origin_enum VALUES (?, ?)', [id, d]);
    }
    run('CREATE TABLE depth_quality_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL, rank INTEGER NOT NULL)');
    for (const [id, d, r] of [[0, 'unknown', 0], [1, 'community', 10], [2, 'class_norm', 20], [3, 'published_minimum', 30], [4, 'charted', 40]] as Array<[number, string, number]>) {
      run('INSERT INTO depth_quality_enum VALUES (?, ?, ?)', [id, d, r]);
    }
    run('CREATE TABLE water_body_kind_enum (id INTEGER PRIMARY KEY, description TEXT NOT NULL)');
    for (const [id, d] of [[0, 'other'], [1, 'canal'], [2, 'river'], [3, 'lake'], [4, 'channel'], [5, 'sea_area'], [6, 'harbour'], [7, 'estuary']] as Array<[number, string]>) {
      run('INSERT INTO water_body_kind_enum VALUES (?, ?)', [id, d]);
    }
    run('CREATE TABLE water_bodies (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind_id INTEGER, parent_id INTEGER, country TEXT)');
    for (const w of fx.waterBodies ?? DEFAULT_WATER_BODIES) run('INSERT INTO water_bodies (id, name, kind_id) VALUES (?, ?, ?)', [w.id, w.name, w.kind]);
    run(`CREATE TABLE water_body_names (water_body_id INTEGER NOT NULL, lang TEXT NOT NULL, name TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'official', PRIMARY KEY (water_body_id, lang, name))`);
    for (const n of fx.names ?? DEFAULT_NAMES) run('INSERT INTO water_body_names VALUES (?, ?, ?, ?)', [n.wb, n.lang, n.name, n.kind ?? 'official']);
    run(`CREATE TABLE edge_sequences (id INTEGER PRIMARY KEY, node_a INTEGER NOT NULL, node_b INTEGER NOT NULL, water_body_id INTEGER,
         origin_id INTEGER NOT NULL DEFAULT 0, distance REAL, min_depth REAL, depth_quality_id INTEGER, max_air_draft REAL, min_width REAL,
         cost_ab REAL, cost_ba REAL, crosses_obstacle INTEGER DEFAULT 0)`);
    for (const s of seqs) {
      run('INSERT INTO edge_sequences (id, node_a, node_b, water_body_id, origin_id, depth_quality_id) VALUES (?, ?, ?, ?, ?, ?)',
        [s.id, NODE[s.a], NODE[s.b], s.wb, s.origin, s.quality]);
    }
    run(`CREATE TABLE notices (id INTEGER PRIMARY KEY, source_class TEXT NOT NULL, severity INTEGER NOT NULL, name TEXT, text TEXT)`);
    run(`CREATE TABLE edge_notices (source INTEGER, target INTEGER, notice_id INTEGER, severity INTEGER NOT NULL, reason TEXT, PRIMARY KEY (source, target, notice_id))`);
    for (const n of fx.notices ?? DEFAULT_NOTICES) {
      run('INSERT INTO notices (id, source_class, severity, name, text) VALUES (?, ?, ?, ?, ?)', [n.id, n.sourceClass, n.severity, 'Line', n.text]);
      for (const [f, t] of [[n.edge[0], n.edge[1]], [n.edge[1], n.edge[0]]]) {
        run('INSERT INTO edge_notices VALUES (?, ?, ?, ?, NULL)', [NODE[f], NODE[t], n.id, n.severity]);
      }
    }
  }
  db.close();
}

/** Close a handle that may already be closed (Windows cannot delete an open SQLite file). */
function closeQuietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routeiq-desc-'));
}

async function routeAcross(dir: string, lang?: string, opts: { loadAll?: string[] } = {}) {
  const db = new RoutingDatabase(dir, true);
  await db.init();
  await db.loadGraph();
  for (const f of opts.loadAll ?? []) await db.loadDatabaseGraph(f);
  const engine = new RoutingEngine(db, DEFAULT_CONFIG);
  engine.setVesselDimensions({ draft: 0, beam: 4, airDraft: 0 });
  try {
    const route = await engine.calculateRoute({
      start: { latitude: LAT, longitude: LONS[0] },
      end: { latitude: LAT, longitude: LONS[5] },
      minCoastDistance: 0,
      ...(lang ? { lang } : {}),
    });
    return { db, route };
  } catch (e) {
    await db.close();
    throw e;
  }
}

describe('route description from a routing database', () => {
  let dir: string;
  before(() => {
    dir = tmpDir();
    buildDb(path.join(dir, 'a_navlines.sqlite'), 'AAA');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('groups the route by water body and merges neighbouring sequences of one water', async () => {
    const { db, route } = await routeAcross(dir, undefined, { loadAll: ['a_navlines.sqlite'] });
    try {
      const d = route.description!;
      assert.ok(d, 'expected a description');
      assert.deepStrictEqual(d.map(l => l.name), ['Kanaal', 'Meer']);
      assert.deepStrictEqual(d.map(l => l.kind), ['canal', 'lake']);
      assert.strictEqual(d[0].distanceFromStart, 0);
      assert.ok(Math.abs(d[0].distance + d[1].distance - route.totalDistance!) < 2);
      assert.ok(Math.abs(d[0].distance - 3 * 686) < 30, `kanaal ${d[0].distance}`);
      // Kanaal: charted, pipeline -> no warnings. Meer: unknown depth, imported, one NAVLINE notice (RESARE ignored).
      assert.deepStrictEqual(d[0].warnings, []);
      assert.deepStrictEqual(d[1].warnings.map(w => w.type).sort(), ['depth_quality', 'notice', 'origin']);
      const notices = d[1].warnings.filter(w => w.type === 'notice');
      assert.strictEqual(notices.length, 1);
      assert.strictEqual((notices[0] as any).text, 'Shallow, depth unknown');
    } finally {
      await db.close();
    }
  });

  it('puts the part inside each itinerary leg on leg.waters', async () => {
    const { db, route } = await routeAcross(dir, undefined, { loadAll: ['a_navlines.sqlite'] });
    try {
      const legs = route.itinerary!.filter(p => p.leg);
      const waters = legs.flatMap(p => p.leg!.waters ?? []);
      assert.deepStrictEqual(waters.map(w => w.name), ['Kanaal', 'Meer']);
      const sum = waters.reduce((t, w) => t + w.distance, 0);
      assert.ok(Math.abs(sum - route.totalDistance!) < 3);
    } finally {
      await db.close();
    }
  });

  it('picks the name by language: de-CH -> de (official before alternative), unknown -> default', async () => {
    for (const [lang, expected] of [['de-CH', 'Kanal'], ['de', 'Kanal'], ['nl', 'Kanaal NL'], ['fr', 'Kanaal'], [undefined, 'Kanaal']] as Array<[string | undefined, string]>) {
      const { db, route } = await routeAcross(dir, lang, { loadAll: ['a_navlines.sqlite'] });
      try {
        assert.strictEqual(route.description![0].name, expected, `lang ${lang}`);
      } finally {
        await db.close();
      }
    }
  });

  it('does not describe the departure-scan steps', async () => {
    const db = new RoutingDatabase(dir, true);
    await db.init();
    await db.loadGraph();
    await db.loadDatabaseGraph('a_navlines.sqlite');
    const engine = new RoutingEngine(db, DEFAULT_CONFIG);
    engine.setVesselDimensions({ draft: 0, beam: 4, airDraft: 0 });
    let called = 0;
    const orig = db.describeRoute.bind(db);
    db.describeRoute = async (...a: Parameters<typeof orig>) => { called++; return orig(...a); };
    try {
      await engine.scanDepartures({
        start: { latitude: LAT, longitude: LONS[0] },
        end: { latitude: LAT, longitude: LONS[5] },
        minCoastDistance: 0,
      }, 2, 60);
      assert.strictEqual(called, 0);
    } finally {
      await db.close();
    }
  });
});

describe('old databases without the description tables', () => {
  it('route as before, with no description and no leg.waters', async () => {
    const withDir = tmpDir();
    const plainDir = tmpDir();
    try {
      buildDb(path.join(withDir, 'a_navlines.sqlite'), 'AAA');
      buildDb(path.join(plainDir, 'a_navlines.sqlite'), 'AAA', { plain: true });
      const a = await routeAcross(withDir, undefined, { loadAll: ['a_navlines.sqlite'] });
      const b = await routeAcross(plainDir, undefined, { loadAll: ['a_navlines.sqlite'] });
      try {
        assert.strictEqual(b.route.description, undefined);
        assert.ok(b.route.itinerary!.every(p => !p.leg?.waters));
        assert.deepStrictEqual((b.route.warnings ?? []).filter(w => w.type === 'description_unavailable'), []);
        assert.strictEqual(b.route.totalDistance, a.route.totalDistance);
        assert.strictEqual(b.route.features.length, a.route.features.length);
      } finally {
        await a.db.close();
        await b.db.close();
      }
    } finally {
      fs.rmSync(withDir, { recursive: true, force: true });
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

describe('describePairs: enums, ranks, origins, notices', () => {
  const dirs: string[] = [];
  const opened: DatabaseSync[] = [];
  function open(fx: Fixture): DatabaseSync {
    const d = tmpDir();
    dirs.push(d);
    const p = path.join(d, 'x.sqlite');
    buildDb(p, 'XXX', fx);
    const db = new DatabaseSync(p);
    opened.push(db);
    return db;
  }
  function handleOf(db: DatabaseSync, file = 'x.sqlite') {
    const edgeCols = db.prepare("PRAGMA table_info('edges')").all() as Array<{ name: string }>;
    return { db, path: `/tmp/${file}`, flags: detectDescribeFlags(db, edgeCols) };
  }
  after(() => {
    opened.forEach(closeQuietly);
    dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  });

  const pairOf = (i: number) => ({ source: NODE[i], target: NODE[i + 1] });

  it('treats unknown enum ids as other / unknown', () => {
    const db = open({
      sequences: [{ id: 11, a: 0, b: 5, wb: 100, origin: 9, quality: 77 }],
      waterBodies: [{ id: 100, name: 'Kanaal', kind: 42 }],
    });
    const r = describePairs([handleOf(db)], [pairOf(0)]);
    const seq = r.sequences['11'];
    assert.strictEqual(seq.origin, 'other');
    assert.strictEqual(seq.originWarn, false);
    assert.strictEqual(seq.depthQuality, 'unknown');
    assert.strictEqual(seq.depthQualityWarn, true);
    assert.strictEqual(r.waterBodies['100'].kind, 'other');
    db.close();
  });

  it('compares depth quality by rank against the charted row, never by id', () => {
    const db = open({ sequences: [
      { id: 1, a: 0, b: 1, wb: null, origin: 1, quality: 4 }, // charted
      { id: 2, a: 1, b: 2, wb: null, origin: 1, quality: 3 }, // published_minimum
      { id: 3, a: 2, b: 3, wb: null, origin: 1, quality: 50 }, // future level: id above charted, rank above
      { id: 4, a: 3, b: 4, wb: null, origin: 1, quality: 51 }, // future level: id above charted, rank below
    ] });
    db.prepare('INSERT INTO depth_quality_enum VALUES (50, ?, 55)').run('surveyed');
    db.prepare('INSERT INTO depth_quality_enum VALUES (51, ?, 35)').run('sketchy');
    const r = describePairs([handleOf(db)], [0, 1, 2, 3].map(pairOf));
    assert.strictEqual(r.sequences['1'].depthQualityWarn, false);
    assert.strictEqual(r.sequences['2'].depthQualityWarn, true);
    assert.strictEqual(r.sequences['3'].depthQualityWarn, false);
    assert.strictEqual(r.sequences['4'].depthQualityWarn, true);
    // And a renumbered charted row (id 9, rank 40) still sets the bar.
    db.prepare("UPDATE depth_quality_enum SET description = 'charted_old' WHERE id = 4").run();
    db.prepare("INSERT INTO depth_quality_enum VALUES (9, 'charted', 40)").run();
    const r2 = describePairs([handleOf(db)], [pairOf(0), pairOf(2)]);
    assert.strictEqual(r2.sequences['1'].depthQualityWarn, false, 'rank 40 meets charted rank 40');
    db.close();
  });

  it('warns on imported (2) and community (5) origins only', () => {
    const db = open({ sequences: [0, 1, 2, 3, 4].map(i => ({ id: i + 1, a: i, b: i + 1, wb: null, origin: [1, 2, 3, 4, 5][i], quality: 4 })) });
    const r = describePairs([handleOf(db)], [0, 1, 2, 3, 4].map(pairOf));
    assert.deepStrictEqual([1, 2, 3, 4, 5].map(i => r.sequences[String(i)].originWarn), [false, true, false, false, true]);
    db.close();
  });

  it('reads only NAVLINE notices', () => {
    const db = open({});
    const r = describePairs([handleOf(db)], [3, 4].map(pairOf));
    assert.deepStrictEqual(r.perPair[0]?.notices ?? [], [], 'RESARE notice on N3-N4 ignored');
    assert.deepStrictEqual(r.perPair[1]?.notices, [1]);
    assert.strictEqual(r.notices['1'].text, 'Shallow, depth unknown');
    db.close();
  });

  it('returns null for pairs that are not database edges, and for a handle without the tables', () => {
    const db = open({});
    const r = describePairs([handleOf(db)], [{ source: 1, target: 2 }, { ...pairOf(0), dbIndex: -1 }]);
    assert.deepStrictEqual(r.perPair, [null, null]);
    db.close();
    const plain = open({ plain: true });
    assert.deepStrictEqual(describePairs([handleOf(plain)], [pairOf(0)]).perPair, [null]);
    plain.close();
  });

  it('language chain', () => {
    assert.deepStrictEqual(languageChain('de-CH'), ['de-CH', 'de']);
    assert.deepStrictEqual(languageChain('nl'), ['nl']);
    assert.deepStrictEqual(languageChain("x'; DROP"), []);
    assert.deepStrictEqual(languageChain(undefined), []);
  });
});

describe('buildRouteDescription / attachWaters (pure)', () => {
  it('merges legs of one water body, keeps unnamed gaps apart, and splits across itinerary legs', () => {
    const segs = [{ distance: 100 }, { distance: 100 }, { distance: 50 }, { distance: 200 }];
    const described = {
      perPair: [{ seq: 1 }, { seq: 2 }, null, { seq: 3 }],
      sequences: {
        '1': { waterBodyId: 7, origin: 'pipeline', originWarn: false, depthQuality: 'charted', depthQualityWarn: false },
        '2': { waterBodyId: 7, origin: 'pipeline', originWarn: false, depthQuality: 'unknown', depthQualityWarn: true },
        '3': { waterBodyId: 7, origin: 'pipeline', originWarn: false, depthQuality: 'charted', depthQualityWarn: false },
      },
      waterBodies: { '7': { name: 'Maas', kind: 'river' } },
      notices: {},
    };
    const d = buildRouteDescription(segs, described)!;
    assert.deepStrictEqual(d.map(l => [l.name, l.distanceFromStart, l.distance]), [['Maas', 0, 200], [undefined, 200, 50], ['Maas', 250, 200]]);
    assert.strictEqual(d[0].warnings.length, 1);

    const itinerary: any[] = [
      { kind: 'start', distanceFromStart: 0, leg: { distance: 150 } },
      { kind: 'turn', distanceFromStart: 150, leg: { distance: 300 } },
      { kind: 'end', distanceFromStart: 450 },
    ];
    attachWaters(itinerary, d);
    assert.deepStrictEqual(itinerary[0].leg.waters.map((w: any) => [w.name, w.distance]), [['Maas', 150]]);
    assert.deepStrictEqual(itinerary[1].leg.waters.map((w: any) => [w.name, w.distance]), [['Maas', 250]] /* the 50 m gap is a sliver, so the Maas parts merge */);
  });

  it('drops slivers under 100 m without a warning and merges the water around them', () => {
    const w = (id: number | undefined, name: string | undefined, from: number, distance: number, warn = false) => ({
      distanceFromStart: from, distance, ...(id ? { waterBodyId: id } : {}), ...(name ? { name } : {}),
      warnings: warn ? [{ type: 'origin' as const, origin: 'imported', message: 'm' }] : [],
    });
    const itinerary = () => [
      { kind: 'start', distanceFromStart: 0, leg: { distance: 1000 } },
      { kind: 'end', distanceFromStart: 1000 },
    ] as any[];
    // Maas, 32 m other canal, Maas -> one Maas part (the sliver is not counted).
    let it = itinerary();
    attachWaters(it, [w(1, 'Maas', 0, 400), w(2, 'Bosscherveld', 400, 32), w(1, 'Maas', 432, 568)]);
    assert.deepStrictEqual(it[0].leg.waters.map((x: any) => [x.name, x.distance]), [['Maas', 968]]);
    // The same sliver with a warning stays.
    it = itinerary();
    attachWaters(it, [w(1, 'Maas', 0, 400), w(2, 'Bosscherveld', 400, 32, true), w(1, 'Maas', 432, 568)]);
    assert.deepStrictEqual(it[0].leg.waters.map((x: any) => x.name), ['Maas', 'Bosscherveld', 'Maas']);
    // An unnamed gap of 100 m or more keeps the two parts apart.
    it = itinerary();
    attachWaters(it, [w(1, 'Maas', 0, 400), w(undefined, undefined, 400, 100), w(1, 'Maas', 500, 500)]);
    assert.deepStrictEqual(it[0].leg.waters.map((x: any) => [x.name, x.distance]), [['Maas', 400], ['Maas', 500]]);
    // Top-level description is not touched by this.
  });

  it('returns undefined when nothing has a name or a warning', () => {
    assert.strictEqual(buildRouteDescription([{ distance: 10 }], { perPair: [null], sequences: {}, waterBodies: {}, notices: {} }), undefined);
  });
});

describe('id collisions between regional files', () => {
  const dirs: string[] = [];
  const opened: DatabaseSync[] = [];
  function handle(fx: Fixture, file: string) {
    const d = tmpDir();
    dirs.push(d);
    const p = path.join(d, file);
    buildDb(p, file, fx);
    const db = new DatabaseSync(p);
    opened.push(db);
    const edgeCols = db.prepare("PRAGMA table_info('edges')").all() as Array<{ name: string }>;
    return { db, path: p, flags: detectDescribeFlags(db, edgeCols) };
  }
  after(() => {
    opened.forEach(closeQuietly);
    dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  });

  it('accepts files that agree', () => {
    const a = handle({}, 'a_navlines.sqlite');
    const b = handle({}, 'b_navlines.sqlite');
    assert.strictEqual(findDescribeCollision(b, [a]), null);
  });

  it('names both files and the id when a sequence has different end nodes', () => {
    const a = handle({}, 'a_navlines.sqlite');
    const b = handle({ sequences: [{ id: 12, a: 2, b: 4, wb: 100, origin: 1, quality: 4 }] }, 'b_navlines.sqlite');
    const err = findDescribeCollision(b, [a])!;
    assert.ok(err, 'expected a collision');
    assert.match(err, /edge sequence id 12/);
    assert.match(err, /a_navlines\.sqlite/);
    assert.match(err, /b_navlines\.sqlite/);
  });

  it('names both files and the id when a water body has a different name or kind', () => {
    const a = handle({}, 'a_navlines.sqlite');
    const byName = handle({ waterBodies: [{ id: 100, name: 'Anders', kind: 1 }, { id: 200, name: 'Meer', kind: 3 }] }, 'b_navlines.sqlite');
    assert.match(findDescribeCollision(byName, [a])!, /water body id 100.*a_navlines\.sqlite.*b_navlines\.sqlite|water body id 100.*b_navlines\.sqlite.*a_navlines\.sqlite/);
    const byKind = handle({ waterBodies: [{ id: 100, name: 'Kanaal', kind: 2 }, { id: 200, name: 'Meer', kind: 3 }] }, 'c_navlines.sqlite');
    assert.match(findDescribeCollision(byKind, [a])!, /water body id 100/);
  });

  it('ignores a file without the tables', () => {
    const a = handle({}, 'a_navlines.sqlite');
    const old = handle({ plain: true }, 'old_navlines.sqlite');
    assert.strictEqual(findDescribeCollision(old, [a]), null);
    assert.strictEqual(findDescribeCollision(a, [old]), null);
  });

  it('skips a partner whose description is already off', () => {
    const a = handle({}, 'a_navlines.sqlite');
    const b = handle({ sequences: [{ id: 12, a: 2, b: 4, wb: 100, origin: 1, quality: 4 }] }, 'b_navlines.sqlite');
    assert.ok(findDescribeCollision(a, [b]), 'a clashes with a healthy b');
    assert.strictEqual(findDescribeCollision(a, [{ ...b, describeError: 'already off' }]), null);
  });

  it('after the first file is evicted and reloaded, it is not switched off by the colliding one', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    buildDb(path.join(dir, 'a_navlines.sqlite'), 'AAA');
    buildDb(path.join(dir, 'b_navlines.sqlite'), 'BBB', { sequences: [{ id: 12, a: 2, b: 4, wb: 100, origin: 1, quality: 4 }, { id: 11, a: 0, b: 2, wb: 100, origin: 1, quality: 4 }, { id: 21, a: 4, b: 5, wb: 200, origin: 2, quality: 0 }] });
    const db = new RoutingDatabase(dir, true);
    await db.init();
    await db.loadGraph();
    try {
      await db.loadDatabaseGraph('a_navlines.sqlite');
      await db.loadDatabaseGraph('b_navlines.sqlite'); // collides with a: b off
      await db.unloadDatabaseGraph('a_navlines.sqlite');
      await db.loadDatabaseGraph('a_navlines.sqlite'); // checked against b, which is already off
      const byName = new Map((await db.getDatabaseCatalog()).map(c => [c.filename, c]));
      assert.strictEqual(byName.get('a_navlines.sqlite')!.descriptionError, null);
      assert.match(byName.get('b_navlines.sqlite')!.descriptionError!, /edge sequence id 12/);
    } finally {
      await db.close();
    }
  });

  it('a colliding file still loads and routes, but its description is off and the catalog says why', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    buildDb(path.join(dir, 'a_navlines.sqlite'), 'AAA');
    buildDb(path.join(dir, 'b_navlines.sqlite'), 'BBB', { sequences: [{ id: 12, a: 2, b: 4, wb: 100, origin: 1, quality: 4 }, { id: 11, a: 0, b: 2, wb: 100, origin: 1, quality: 4 }, { id: 21, a: 4, b: 5, wb: 200, origin: 2, quality: 0 }] });
    const db = new RoutingDatabase(dir, true);
    await db.init();
    await db.loadGraph();
    await db.loadDatabaseGraph('a_navlines.sqlite');
    await db.loadDatabaseGraph('b_navlines.sqlite');
    try {
      const catalog = await db.getDatabaseCatalog();
      const byName = new Map(catalog.map(c => [c.filename, c]));
      assert.strictEqual(byName.get('a_navlines.sqlite')!.descriptionError, null);
      assert.match(byName.get('b_navlines.sqlite')!.descriptionError!, /edge sequence id 12/);
      assert.strictEqual(byName.get('b_navlines.sqlite')!.state, 'loaded');
      const engine = new RoutingEngine(db, DEFAULT_CONFIG);
      engine.setVesselDimensions({ draft: 0, beam: 4, airDraft: 0 });
      const route = await engine.calculateRoute({
        start: { latitude: LAT, longitude: LONS[0] },
        end: { latitude: LAT, longitude: LONS[5] },
        minCoastDistance: 0,
      });
      assert.ok(route.totalDistance! > 0);
      assert.ok(route.description, 'file a still describes');
    } finally {
      await db.close();
    }
  });
});

// Real data: a navline build from the pipeline (never the live data dir, and
// never the provenance database). Skipped when the file is not there.
const REAL = process.env.ROUTEIQ_NAVLINES_DB ?? '/tmp/nl_build/nl_navlines.sqlite';
describe('real navline database', { skip: !fs.existsSync(REAL) }, () => {
  let dir: string;
  before(() => {
    dir = tmpDir();
    fs.copyFileSync(REAL, path.join(dir, 'nl_navlines.sqlite'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function nijmegenMaastricht(lang?: string) {
    const db = new RoutingDatabase(dir, true);
    await db.init();
    await db.loadGraph();
    const engine = new RoutingEngine(db, { ...DEFAULT_CONFIG });
    engine.setVesselDimensions({ draft: 1.0, beam: 3, airDraft: 0 });
    try {
      return await engine.calculateRoute({
        start: { latitude: 51.8497, longitude: 5.8680 },
        end: { latitude: 50.8498, longitude: 5.6900 },
        minCoastDistance: 0,
        ...(lang ? { lang } : {}),
      });
    } finally {
      await db.close();
    }
  }

  it('Nijmegen to Maastricht runs through named waters with warnings', async () => {
    const route = await nijmegenMaastricht();
    const names = (route.description ?? []).map(l => l.name).filter(Boolean);
    assert.ok(names.length > 0, 'expected named legs');
    assert.ok(names.some(n => /Maas/.test(n!)), `expected a Maas leg, got ${names.join(', ')}`);
    const total = route.description!.reduce((t, l) => t + l.distance, 0);
    assert.ok(Math.abs(total - route.totalDistance!) < 50, `description covers ${total} of ${route.totalDistance}`);
    assert.ok(route.itinerary!.some(p => (p.leg?.waters?.length ?? 0) > 0));
  });

  it('an edge in a non-charted or imported sequence yields warnings', () => {
    const db = new DatabaseSync(path.join(dir, 'nl_navlines.sqlite'));
    try {
      const edgeCols = db.prepare("PRAGMA table_info('edges')").all() as Array<{ name: string }>;
      const handle = { db, path: 'nl_navlines.sqlite', flags: detectDescribeFlags(db, edgeCols) };
      const rows = db.prepare(`SELECT e.source, e.target, es.origin_id, es.depth_quality_id FROM edges e
        JOIN edge_sequences es ON es.id = e.edge_sequence_id
        WHERE es.depth_quality_id <> 4 OR es.origin_id IN (2, 5) LIMIT 20`).all() as Array<{ source: number; target: number }>;
      assert.ok(rows.length > 0, 'this build has non-charted or imported sequences');
      const r = describePairs([handle], rows.map(x => ({ source: x.source, target: x.target })));
      assert.ok(Object.values(r.sequences).some(sq => sq.depthQualityWarn || sq.originWarn));
    } finally {
      db.close();
    }
  });

  it('lang fr reads the Maas as Meuse when a French name exists', async () => {
    const wanted = new DatabaseSync(path.join(dir, 'nl_navlines.sqlite'));
    let hasFr: boolean;
    try {
      hasFr = (wanted.prepare("SELECT COUNT(*) AS c FROM water_body_names WHERE lang = 'fr' AND name LIKE 'Meuse%'").get() as { c: number }).c > 0;
    } finally {
      wanted.close();
    }
    const route = await nijmegenMaastricht('fr');
    const names = (route.description ?? []).map(l => l.name ?? '');
    if (hasFr) assert.ok(names.some(n => /Meuse/.test(n)), `got ${names.join(', ')}`);
    else assert.ok(names.length > 0);
  });
});
