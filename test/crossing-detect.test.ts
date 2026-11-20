/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures reach into private engine/database members */
/**
 * Which bridges and locks a route lists (#57): exactly the parts the databases
 * link to the route's edges (`edge_pois`, spec §2.14), and on a stretch no
 * file knows (connector, navmesh shortcut, overlay edge) the parts within
 * FALLBACK_MAX_DIST (50 m) of the line.
 *
 * Fixtures are real database files, built in metres east/north of an origin
 * at 52 N, so the 50 m rule and the distances in the cases can be read off.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { RoutingDatabase } from "../dist-tsc/database.js";
import { createDirectoryDatabase } from "../dist-tsc/data-dir.js";
import { RoutingEngine } from "../dist-tsc/routing.js";
import { DEFAULT_CONFIG } from "../dist-tsc/types.js";
import { upgradeToPoiModel } from "./poi-model-fixture.js";
import { POIS_DDL } from "./poi-model-fixture.js";
import { testOptions } from './engine-helper.js';

const LAT0 = 52.0;
const LON0 = 5.0;
/** Degrees of latitude / longitude per metre at the origin. */
const DLAT = 1 / 110540;
const DLON = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const pos = (x: number, y: number): [number, number] => [
  LON0 + x * DLON,
  LAT0 + y * DLAT,
];

interface NodeSpec {
  id: number;
  x: number;
  y: number;
}
interface PoiSpec {
  id: number;
  type: number; // 1 lock, 2 bridge, 5 chamber, 6 span
  parent?: number;
  name?: string;
  properties?: Record<string, unknown>;
  info?: Record<string, unknown>;
  x?: number;
  y?: number;
}
interface FileSpec {
  country: string;
  nodes: NodeSpec[];
  edges: Array<[number, number]>;
  pois?: PoiSpec[];
  edgePois?: Array<[number, number, number]>;
}

function buildFile(file: string, spec: FileSpec): void {
  const db = new DatabaseSync(file, { open: true });
  const run = (sql: string, params: unknown[] = []) =>
    db.prepare(sql).run(...(params as any[]));
  run(`CREATE TABLE metadata (id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
       description TEXT, last_update_date TEXT NOT NULL, bounding_box TEXT)`);
  run(
    `INSERT INTO metadata (country, name, description, last_update_date, bounding_box) VALUES (?, ?, 'fixture', '2026-01-01T00:00:00Z', ?)`,
    [
      spec.country,
      `Region ${spec.country}`,
      JSON.stringify({
        min_lat: 51.9,
        min_lon: 4.9,
        max_lat: 52.1,
        max_lon: 5.2,
      }),
    ],
  );
  run(
    `CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`,
  );
  for (const n of spec.nodes) {
    const [lon, lat] = pos(n.x, n.y);
    run("INSERT INTO nodes (id, lat, lon, region_id) VALUES (?, ?, ?, 1)", [
      n.id,
      lat,
      lon,
    ]);
  }
  run(`CREATE TABLE edges (source INTEGER, target INTEGER, distance REAL, min_depth REAL, max_air_draft REAL, min_width REAL,
       cost_factor REAL DEFAULT 1.0, distance_to_land REAL, edge_type_id INTEGER DEFAULT 1, traffic_mode INTEGER DEFAULT 0)`);
  const at = new Map(spec.nodes.map((n) => [n.id, n]));
  for (const [a, b] of spec.edges) {
    const d = Math.hypot(
      at.get(a)!.x - at.get(b)!.x,
      at.get(a)!.y - at.get(b)!.y,
    );
    for (const [s, t] of [
      [a, b],
      [b, a],
    ])
      run(
        "INSERT INTO edges VALUES (?, ?, ?, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0)",
        [s, t, d],
      );
  }
  run(POIS_DDL);
  for (const p of spec.pois ?? []) {
    const [lon, lat] = pos(p.x ?? 0, p.y ?? 0);
    run(
      "INSERT INTO pois (id, type_id, parent_id, name, properties, info, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        p.id,
        p.type,
        p.parent ?? null,
        p.name ?? null,
        JSON.stringify(p.properties ?? {}),
        p.info ? JSON.stringify(p.info) : null,
        lat,
        lon,
      ],
    );
  }
  upgradeToPoiModel(db);
  for (const [a, b, poi] of spec.edgePois ?? []) {
    run("INSERT INTO edge_pois (source, target, poi_id) VALUES (?, ?, ?)", [
      Math.min(a, b),
      Math.max(a, b),
      poi,
    ]);
  }
  db.close();
}

/** Nodes 1..n in a line along the x axis, `step` metres apart. */
const line = (n: number, step: number): NodeSpec[] =>
  Array.from({ length: n }, (_v, i) => ({ id: i + 1, x: i * step, y: 0 }));

interface Fixture {
  db: RoutingDatabase;
  engine: RoutingEngine;
  nodes: Map<number, NodeSpec>;
  close(): Promise<void>;
}

/** Open the given files (dynamic loading, each loaded) as one database. */
async function openFixture(files: FileSpec[]): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routeiq-crossdetect-"));
  files.forEach((f, i) => buildFile(path.join(dir, `f${i}.sqlite`), f));
  const db = createDirectoryDatabase(dir, true);
  await db.init();
  await db.loadGraph();
  for (let i = 0; i < files.length; i++)
    await db.loadDatabaseGraph(`f${i}.sqlite`);
  const engine = new RoutingEngine(db, testOptions(DEFAULT_CONFIG, { draft: 1.0, beam: 3.0, airDraft: 5.0 }));
  const nodes = new Map(files.flatMap((f) => f.nodes).map((n) => [n.id, n]));
  return {
    db,
    engine,
    nodes,
    close: async () => {
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Found = {
  name: string;
  distanceFromStart?: number;
  type: string;
  structure?: string;
  partId?: number;
  passage?: number;
  waitMinutes?: number;
  height?: number;
  waitSeconds?: number;
  lockSpan?: [number, number];
};
type Seg = { from: number; to: number; lockIds?: number[] };

/**
 * Detect along a route given as node ids (a node id with no entry in
 * `nodes` is placed with `extra`, and no edge of any file joins it).
 */
async function detect(
  fx: Fixture,
  ids: number[],
  extra: Record<number, [number, number]> = {},
) {
  const coords = ids.map((id) => {
    const n = fx.nodes.get(id);
    return n ? pos(n.x, n.y) : pos(...extra[id]);
  });
  const segments: Seg[] = ids.slice(1).map((to, i) => ({ from: ids[i], to }));
  const crossings = (await (fx.engine as any).detectRouteStructures(
    coords,
    segments,
  )) as Found[];
  return { crossings, segments };
}

const BRIDGE = 2;
const LOCK = 1;
const CHAMBER = 5;
const SPAN = 6;

describe("route structures: a bridge on a crossing canal is not on the route (#57)", () => {
  let fx: Fixture;
  before(async () => {
    // Route 1-2-3-4-5, 200 m between nodes. Bridge X is under edge 2-3.
    // Bridge Y is on a crossing canal (6-7) 60 m north of the line at x = 300:
    // 60 m from the route, and 116 m from the nearest vertex, so the old
    // 150 m vertex rule listed it. The file links Y to its own canal's edge only.
    fx = await openFixture([
      {
        country: "AAA",
        nodes: [
          ...line(5, 200),
          { id: 6, x: 300, y: 130 },
          { id: 7, x: 300, y: -10 },
        ],
        edges: [
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [6, 7],
        ],
        pois: [
          {
            id: 300,
            type: BRIDGE,
            name: "Bridge X",
            properties: { typical_wait_minutes: 5 },
            x: 300,
            y: 0,
          },
          {
            id: 301,
            type: SPAN,
            parent: 300,
            name: "X span",
            properties: { subtype: "opening" },
            x: 300,
            y: 0,
          },
          {
            id: 310,
            type: BRIDGE,
            name: "Bridge Y",
            properties: { typical_wait_minutes: 5 },
            x: 300,
            y: 60,
          },
          {
            id: 311,
            type: SPAN,
            parent: 310,
            name: "Y span",
            properties: { subtype: "opening" },
            info: { height: 2.4 },
            x: 300,
            y: 60,
          },
          // On the start connector of the calculated-route case only (west of
          // node 1, where no file has an edge).
          { id: 320, type: BRIDGE, name: "Bridge W", x: -75, y: 0 },
          { id: 321, type: SPAN, parent: 320, x: -75, y: 0 },
        ],
        edgePois: [
          [2, 3, 301],
          [6, 7, 311],
        ],
      },
    ]);
  });
  after(() => fx.close());

  it("lists the linked bridge X with its whole, part and wait, and not the unlinked bridge Y", async () => {
    const { crossings } = await detect(fx, [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(
      crossings.map((c) => [c.type, c.structure, c.partId, c.waitMinutes]),
      [["bridge", "300", 301, 5]],
    );
    assert.match(crossings[0].name, /^Bridge X/);
    assert.deepStrictEqual(
      crossings.map((c) => c.passage),
      [0],
      "one pass of X is passage 0",
    );
  });

  it("charges the route one opening wait: only X, as a calculated route", async () => {
    const r = await fx.engine.calculateRoute({
      start: { latitude: pos(0, 0)[1], longitude: pos(0, 0)[0] },
      end: { latitude: pos(800, 0)[1], longitude: pos(800, 0)[0] },
      minCoastDistance: 0,
    });
    assert.deepStrictEqual(
      (r.crossings ?? []).map((c) => c.structure),
      ["300"],
    );
    const sum = (r.crossings ?? []).reduce(
      (s, c) => s + (c.waitSeconds ?? 0),
      0,
    );
    assert.strictEqual(sum, 5 * 60, "X's five minutes");
    assert.strictEqual(
      r.totalWaitSeconds,
      sum,
      "the total is the listed crossings' waits and nothing else",
    );
    assert.ok((r.crossings ?? []).every((c) => c.structure !== "310"));
  });

  it("lists Y when the route does take its canal", async () => {
    const { crossings } = await detect(fx, [6, 7]);
    assert.deepStrictEqual(
      crossings.map((c) => [c.structure, c.partId, c.height]),
      [["310", 311, 2.4]],
    );
  });

  it("lists X twice, at the chainage of each passage, when the route turns back under it", async () => {
    // 1-2-3 and back 3-2-1: X (x = 300) is passed at 300 m and again at 500 m.
    const { crossings } = await detect(fx, [1, 2, 3, 2, 1]);
    assert.deepStrictEqual(
      crossings.map((c) => c.structure),
      ["300", "300"],
    );
    // Out and back is two passes of one structure: told apart by `passage`.
    assert.deepStrictEqual(
      crossings.map((c) => c.passage),
      [0, 1],
    );
    // Within a metre or two: the fixture's edge lengths and node positions
    // round differently.
    const at = crossings.map((c) => c.distanceFromStart ?? NaN);
    assert.ok(
      Math.abs(at[0] - 300) <= 2 && Math.abs(at[1] - 500) <= 2,
      `${at}`,
    );
  });

  it("lists X twice when the route turns back a little past it, over an edge in between", async () => {
    // 1-2-3-4 then back 4-3-2: X (x = 300) is passed at 300 m and at 500 m,
    // less than the 300 m merge distance apart, with the turn on edge 3-4.
    const { crossings } = await detect(fx, [1, 2, 3, 4, 3, 2]);
    assert.deepStrictEqual(
      crossings.map((c) => c.structure),
      ["300", "300"],
    );
  });

  it("detects again on the final line after the start connector is added", async () => {
    // The user starts 150 m west of node 1; Bridge W sits on that connector.
    const r = await fx.engine.calculateRoute({
      start: { latitude: pos(-150, 0)[1], longitude: pos(-150, 0)[0] },
      end: { latitude: pos(800, 0)[1], longitude: pos(800, 0)[0] },
      minCoastDistance: 0,
    });
    assert.deepStrictEqual(
      (r.crossings ?? []).map((c) => [c.structure, c.distanceFromStart]),
      [
        ["320", 75],
        ["300", 450],
      ],
    );
  });
});

describe("route structures: locks", () => {
  let fx: Fixture;
  before(async () => {
    // Lock L's chamber is in the route's own canal (node 3, edge 3-4 runs through it).
    // Lock P's chamber is in a parallel canal 8-9, 40 m north of the line: within
    // 50 m of the route, so a geometric rule would list it.
    fx = await openFixture([
      {
        country: "AAA",
        nodes: [
          ...line(5, 200),
          { id: 8, x: 300, y: 40 },
          { id: 9, x: 500, y: 40 },
        ],
        edges: [
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [8, 9],
        ],
        pois: [
          {
            id: 200,
            type: LOCK,
            name: "Lock L",
            properties: { typical_wait_minutes: 20 },
            x: 500,
            y: 0,
          },
          {
            id: 201,
            type: CHAMBER,
            parent: 200,
            name: "L chamber",
            x: 400,
            y: 0,
          },
          {
            id: 100,
            type: LOCK,
            name: "Lock P",
            properties: { typical_wait_minutes: 20 },
            x: 400,
            y: 40,
          },
          {
            id: 101,
            type: CHAMBER,
            parent: 100,
            name: "P chamber",
            x: 400,
            y: 40,
          },
        ],
        edgePois: [
          [3, 4, 201],
          [8, 9, 101],
        ],
      },
    ]);
  });
  after(() => fx.close());

  it("lists the linked chamber, not the chamber of the parallel canal, and marks the segments with the lock id", async () => {
    const { crossings, segments } = await detect(fx, [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(
      crossings.map((c) => [c.type, c.structure, c.partId]),
      [["lock", "200", 201]],
    );
    assert.deepStrictEqual(
      segments.map((s) => s.lockIds ?? null),
      [null, null, [200], null],
    );
  });

  it("gives the lock its span and its wait in a calculated route, and the parallel lock none", async () => {
    const r = await fx.engine.calculateRoute({
      start: { latitude: pos(0, 0)[1], longitude: pos(0, 0)[0] },
      end: { latitude: pos(800, 0)[1], longitude: pos(800, 0)[0] },
      minCoastDistance: 0,
    });
    const locks = (r.crossings ?? []).filter((c) => c.type === "lock");
    assert.deepStrictEqual(
      locks.map((c) => c.structure),
      ["200"],
    );
    assert.ok(locks[0].lockSpan, "the lock has a span taken from the edges");
    assert.strictEqual(
      r.totalWaitSeconds,
      20 * 60,
      "one locking, charged once",
    );
  });
});

describe("route structures: a chamber midway along a long edge", () => {
  let fx: Fixture;
  before(async () => {
    // Edge 2-3 is 4 km long and the chamber sits 2 km from either end, so it is
    // listed only because edge_pois links it (the 50 m line rule cannot see it).
    fx = await openFixture([
      {
        country: "AAA",
        nodes: [
          { id: 1, x: 0, y: 0 },
          { id: 2, x: 200, y: 0 },
          { id: 3, x: 4200, y: 0 },
          { id: 4, x: 4400, y: 0 },
        ],
        edges: [
          [1, 2],
          [2, 3],
          [3, 4],
        ],
        pois: [
          {
            id: 300,
            type: LOCK,
            name: "Long Lock",
            properties: { typical_wait_minutes: 60 },
            x: 2200,
            y: 0,
          },
          {
            id: 301,
            type: CHAMBER,
            parent: 300,
            name: "Long chamber",
            properties: { typical_wait_minutes: 7 },
            x: 2200,
            y: 0,
          },
        ],
        edgePois: [[2, 3, 301]],
      },
    ]);
  });
  after(() => fx.close());

  it("lists the chamber with its whole, though it is far from every route vertex", async () => {
    const { crossings } = await detect(fx, [1, 2, 3, 4]);
    assert.deepStrictEqual(
      crossings.map((c) => [c.type, c.structure, c.partId]),
      [["lock", "300", 301]],
    );
  });

  it("charges the chamber's own wait once in a calculated route", async () => {
    const r = await fx.engine.calculateRoute({
      start: { latitude: pos(0, 0)[1], longitude: pos(0, 0)[0] },
      end: { latitude: pos(4400, 0)[1], longitude: pos(4400, 0)[0] },
      minCoastDistance: 0,
    });
    const locks = (r.crossings ?? []).filter((c) => c.type === "lock");
    assert.deepStrictEqual(
      locks.map((c) => c.structure),
      ["300"],
    );
    assert.strictEqual(
      r.totalWaitSeconds,
      7 * 60,
      "7 minutes, not the whole's 60",
    );
  });
});

describe("route structures: a stretch no file knows uses the 50 m line rule", () => {
  let fx: Fixture;
  before(async () => {
    // The route goes from node 901 to 902 (no edge of any file), 200 m east.
    // Bridges (x, y from the line's start):
    //   Z (39, 10)   10 m from the line, 40 m from the nearest vertex
    //   W (100, 45)  45 m from the line, 110 m from either vertex
    //   Y (100, 60)  60 m from the line, 117 m from the nearest vertex (old rule listed it)
    //   V (100, -55) 55 m from the line
    const span = (
      id: number,
      whole: number,
      x: number,
      y: number,
    ): PoiSpec[] => [
      { id: whole, type: BRIDGE, name: `Bridge ${id}`, x, y },
      {
        id,
        type: SPAN,
        parent: whole,
        name: `span ${id}`,
        properties: { subtype: "fixed" },
        x,
        y,
      },
    ];
    fx = await openFixture([
      {
        country: "AAA",
        nodes: [
          { id: 1, x: -500, y: 0 },
          { id: 2, x: -400, y: 0 },
        ],
        edges: [[1, 2]],
        pois: [
          ...span(1, 11, 39, 10),
          ...span(2, 12, 100, 45),
          ...span(3, 13, 100, 60),
          ...span(4, 14, 100, -55),
        ],
      },
    ]);
  });
  after(() => fx.close());

  it("lists a bridge 10 m from the line but 40 m from the nearest vertex, and one at 45 m; not those at 55 m and 60 m", async () => {
    const { crossings, segments } = await detect(fx, [901, 902], {
      901: [0, 0],
      902: [200, 0],
    });
    assert.deepStrictEqual(crossings.map((c) => c.structure).sort(), [
      "11",
      "12",
    ]);
    assert.ok(
      segments.every((s) => s.lockIds === undefined),
      "no lock spans without data",
    );
  });
});

describe("route structures: a bridge with several spans is one crossing", () => {
  let fx: Fixture;
  before(async () => {
    // Both spans of Bridge M are linked to edge 2-3: 8 m and 15 m from the line.
    fx = await openFixture([
      {
        country: "AAA",
        nodes: line(3, 200),
        edges: [
          [1, 2],
          [2, 3],
        ],
        pois: [
          { id: 300, type: BRIDGE, name: "Bridge M", x: 300, y: 0 },
          {
            id: 301,
            type: SPAN,
            parent: 300,
            name: "near span",
            properties: { subtype: "fixed" },
            info: { height: 3.1 },
            x: 300,
            y: 8,
          },
          {
            id: 302,
            type: SPAN,
            parent: 300,
            name: "far span",
            properties: { subtype: "opening" },
            x: 320,
            y: 15,
          },
        ],
        edgePois: [
          [2, 3, 301],
          [2, 3, 302],
        ],
      },
    ]);
  });
  after(() => fx.close());

  it("lists the whole once, with the span nearest the line", async () => {
    const { crossings } = await detect(fx, [1, 2, 3]);
    assert.strictEqual(crossings.length, 1, JSON.stringify(crossings));
    assert.strictEqual(crossings[0].structure, "300");
    assert.strictEqual(crossings[0].partId, 301);
    assert.strictEqual(crossings[0].height, 3.1);
  });
});

describe("route structures: a route over both a file and a connector", () => {
  let fx: Fixture;
  before(async () => {
    // File stretch 1-2-3 (200 m legs). Linked bridge X under 2-3; unlinked
    // bridge Y 30 m off that stretch, which the 50 m rule would list if the
    // fallback reached it. The route then continues over a connector 3 -> 904
    // (no edge in any file) to x = 600: bridge Z is 20 m off it, bridge Q 80 m.
    const span = (
      id: number,
      whole: number,
      x: number,
      y: number,
    ): PoiSpec[] => [
      { id: whole, type: BRIDGE, name: `Bridge ${whole}`, x, y },
      { id, type: SPAN, parent: whole, properties: { subtype: "fixed" }, x, y },
    ];
    fx = await openFixture([
      {
        country: "AAA",
        nodes: line(3, 200),
        edges: [
          [1, 2],
          [2, 3],
        ],
        pois: [
          ...span(1, 21, 300, 0),
          ...span(2, 22, 100, 30),
          ...span(3, 23, 500, 20),
          ...span(4, 24, 500, 80),
        ],
        edgePois: [[2, 3, 1]],
      },
    ]);
  });
  after(() => fx.close());

  it("lists the file stretch's linked bridge and the connector's bridge within 50 m, and neither unlinked one nor the one at 80 m", async () => {
    const { crossings } = await detect(fx, [1, 2, 3, 904], { 904: [600, 0] });
    assert.deepStrictEqual(
      crossings.map((c) => c.structure),
      ["21", "23"],
    );
  });
});

describe("route structures: two files", () => {
  const nodes = line(3, 200);
  const bridge = (
    whole: number,
    span: number,
    x: number,
    y: number,
  ): PoiSpec[] => [
    { id: whole, type: BRIDGE, name: `Bridge ${whole}`, x, y },
    {
      id: span,
      type: SPAN,
      parent: whole,
      properties: { subtype: "fixed" },
      x,
      y,
    },
  ];

  it("a seam pair held by two files gives the union of their links; a file that lacks the pair has no say", async () => {
    // Files A and B both hold 2-3 (a seam); A links bridge P, B links bridge Q.
    // File C does not hold 2-3 but has an edge_pois row for it, to bridge R.
    const fx = await openFixture([
      {
        country: "AAA",
        nodes,
        edges: [
          [1, 2],
          [2, 3],
        ],
        pois: bridge(41, 1, 300, 0),
        edgePois: [[2, 3, 1]],
      },
      {
        country: "BBB",
        nodes,
        edges: [[2, 3]],
        pois: bridge(42, 2, 320, 0),
        edgePois: [[2, 3, 2]],
      },
      {
        country: "CCC",
        nodes,
        edges: [[1, 2]],
        pois: bridge(43, 3, 300, 0),
        edgePois: [[2, 3, 3]],
      },
    ]);
    try {
      const { crossings } = await detect(fx, [1, 2, 3]);
      assert.deepStrictEqual(crossings.map((c) => c.structure).sort(), [
        "41",
        "42",
      ]);
    } finally {
      await fx.close();
    }
  });

  it("the same POI id linked in two files gives one crossing", async () => {
    const both = {
      nodes,
      edges: [
        [1, 2],
        [2, 3],
      ] as Array<[number, number]>,
      pois: bridge(51, 1, 300, 0),
      edgePois: [[2, 3, 1]] as Array<[number, number, number]>,
    };
    const fx = await openFixture([
      { country: "AAA", ...both },
      { country: "BBB", ...both },
    ]);
    try {
      const { crossings } = await detect(fx, [1, 2, 3]);
      assert.deepStrictEqual(
        crossings.map((c) => [c.structure, c.partId]),
        [["51", 1]],
      );
    } finally {
      await fx.close();
    }
  });
});

describe("route structures: stretches the files do not hold", () => {
  const span = (id: number, whole: number, x: number, y: number): PoiSpec[] => [
    { id: whole, type: BRIDGE, name: `Bridge ${whole}`, x, y },
    { id, type: SPAN, parent: whole, properties: { subtype: "fixed" }, x, y },
  ];
  let fx: Fixture;
  before(async () => {
    fx = await openFixture([
      {
        country: "AAA",
        nodes: line(3, 200),
        edges: [[1, 2]],
        pois: [
          ...span(1, 61, 300, 20),
          ...span(2, 62, 900, 20),
          ...span(3, 63, 100, 20),
        ],
        // One link, so the file vouches for its edges (a file without any
        // edge_pois row has no say, see below).
        edgePois: [[1, 2, 3]],
      },
    ]);
    // A navmesh-style synthetic edge: in memory only, tagged with the dbIndex of
    // the file whose region made it, which does not hold the pair 2-3.
    const edges = (fx.db as any).edgesBySource as Map<number, any[]>;
    const synthetic = {
      distance: 200,
      min_depth: 10,
      max_air_draft: -1,
      min_width: -1,
      cost_factor: 1,
      distance_to_land: 9999,
      edge_type_id: 1,
      traffic_mode: 0,
      edge_kind_id: 1, // navmesh boundary, as addFunnelShortcutEdge makes them
      dbIndex: 0,
    };
    for (const [s, t] of [
      [2, 3],
      [3, 2],
    ]) {
      if (!edges.has(s)) edges.set(s, []);
      edges.get(s)!.push({ ...synthetic, source: s, target: t });
    }
  });
  after(() => fx.close());

  it("a pair tagged with a file's dbIndex that the file does not hold is unknown, so a bridge 20 m away is listed", async () => {
    assert.ok(
      (fx.db as any).getEdgeSync(2, 3)?.dbIndex === 0,
      "fixture: the synthetic edge is tagged",
    );
    assert.deepStrictEqual(
      (
        await fx.db.getRoutePois([
          [2, 3],
          [1, 2],
        ])
      ).map((r) => r.known),
      [false, true],
    );
    const { crossings } = await detect(fx, [2, 3]);
    assert.deepStrictEqual(
      crossings.map((c) => c.structure),
      ["61"],
    );
  });

  it("coordinate spans with no segment use the fallback", async () => {
    const coords = [pos(0, 0), pos(400, 0)];
    const none = (await (fx.engine as any).detectRouteStructures(
      coords,
      [],
    )) as Found[];
    assert.deepStrictEqual(none.map((c) => c.structure).sort(), ["61", "63"]);
  });

  it("crossings on one long segment are ordered and merged by where the line passes them, not by the segment's start", async () => {
    const coords = [pos(0, 0), pos(1000, 0)];
    const found = (await (fx.engine as any).detectRouteStructures(coords, [
      { from: 901, to: 902 },
    ])) as Found[];
    assert.deepStrictEqual(
      found.map((c) => c.structure),
      ["63", "61", "62"],
      "x = 100, 300, 900",
    );
  });
});

describe("route structures: a file that links nothing", () => {
  let fx: Fixture;
  before(async () => {
    // Route 1-2-3 (200 m legs) over a file with POIs but no edge_pois row at
    // all: it never linked its parts, so it cannot say an edge passes none.
    // Bridge X sits on the line at x = 300; bridge Y is 80 m off it.
    fx = await openFixture([
      {
        country: "AAA",
        nodes: line(3, 200),
        edges: [
          [1, 2],
          [2, 3],
        ],
        pois: [
          { id: 70, type: BRIDGE, name: "Bridge X", x: 300, y: 0 },
          { id: 71, type: SPAN, parent: 70, x: 300, y: 0 },
          { id: 80, type: BRIDGE, name: "Bridge Y", x: 300, y: 80 },
          { id: 81, type: SPAN, parent: 80, x: 300, y: 80 },
        ],
      },
    ]);
  });
  after(() => fx.close());

  it("leaves its edges unknown, so its bridges are found by the 50 m rule", async () => {
    assert.deepStrictEqual(
      (
        await fx.db.getRoutePois([
          [1, 2],
          [2, 3],
        ])
      ).map((r) => r.known),
      [false, false],
    );
    const { crossings } = await detect(fx, [1, 2, 3]);
    assert.deepStrictEqual(
      crossings.map((c) => c.structure),
      ["70"],
    );
  });
});

describe("route structures: an aggregated segment with one unknown edge", () => {
  let fx: Fixture;
  before(async () => {
    // Nodes 1-2-3-4 on a line, 200 m apart. The file holds 1-2 and 2-3 (and
    // links bridge X under 1-2), but not 3-4. Bridge Y is 30 m off the known
    // edge 2-3 and unlinked; bridge Z is 20 m off the unknown edge 3-4.
    const span = (
      id: number,
      whole: number,
      x: number,
      y: number,
    ): PoiSpec[] => [
      { id: whole, type: BRIDGE, name: `Bridge ${whole}`, x, y },
      { id, type: SPAN, parent: whole, properties: { subtype: "fixed" }, x, y },
    ];
    fx = await openFixture([
      {
        country: "AAA",
        nodes: [...line(4, 200), { id: 9, x: 600, y: 300 }],
        edges: [
          [1, 2],
          [2, 3],
          [4, 9],
        ],
        pois: [
          ...span(1, 91, 100, 0),
          ...span(2, 92, 300, 30),
          ...span(3, 93, 500, 20),
        ],
        edgePois: [[1, 2, 1]],
      },
    ]);
  });
  after(() => fx.close());

  it("judges only the unknown edge by distance: X and Z, not Y beside the known edge", async () => {
    const seg = { from: 1, to: 4, nodes: [1, 2, 3, 4] };
    const found = (await (fx.engine as any).detectRouteStructures(
      [pos(0, 0), pos(600, 0)],
      [seg],
    )) as Found[];
    assert.deepStrictEqual(
      found.map((c) => c.structure),
      ["91", "93"],
    );
  });

  it("places a bridge on a shared unknown edge where the route passes it, not on the first sub-segment", async () => {
    // Three sub-segments (a funnel polyline without a one-to-one node match)
    // all naming the whole edge sequence 1-2-3-4: each is as far from the
    // unknown edge 3-4 as the others, so only their own lines can say which
    // passes Z (x = 500).
    const subs = [0, 1, 2].map(() => ({
      from: 1,
      to: 4,
      nodes: [1, 2, 3, 4],
    }));
    const found = (await (fx.engine as any).detectRouteStructures(
      [pos(0, 0), pos(200, 0), pos(400, 0), pos(600, 0)],
      subs,
    )) as Found[];
    assert.deepStrictEqual(
      found.map((c) => c.structure),
      ["91", "93"],
    );
    const z = found[1].distanceFromStart ?? NaN;
    assert.ok(Math.abs(z - 500) <= 2, `Z at ${z} m, not 200 m`);
  });
});

describe("route structures: a turn-back that returns on other edges", () => {
  let fx: Fixture;
  before(async () => {
    // Out along y = 0 (1-2-3) under span A of bridge X at x = 300, across to
    // the parallel channel (3-4, 20 m) and back west along y = 20 (4-5)
    // under span B of the same bridge. The return shares no edge with the
    // way out, and the two passages are only ~220 m apart along the route.
    fx = await openFixture([
      {
        country: "AAA",
        nodes: [
          ...line(3, 200),
          { id: 4, x: 400, y: 20 },
          { id: 5, x: 200, y: 20 },
        ],
        edges: [
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
        ],
        pois: [
          {
            id: 400,
            type: BRIDGE,
            name: "Bridge X",
            properties: { typical_wait_minutes: 5 },
            x: 300,
            y: 10,
          },
          {
            id: 401,
            type: SPAN,
            parent: 400,
            properties: { subtype: "opening" },
            x: 300,
            y: 0,
          },
          {
            id: 402,
            type: SPAN,
            parent: 400,
            properties: { subtype: "opening" },
            x: 300,
            y: 20,
          },
        ],
        edgePois: [
          [2, 3, 401],
          [4, 5, 402],
        ],
      },
    ]);
  });
  after(() => fx.close());

  it("lists X once per passage, each with the span it went through", async () => {
    const { crossings } = await detect(fx, [1, 2, 3, 4, 5]);
    assert.deepStrictEqual(
      crossings.map((c) => [c.structure, c.partId]),
      [
        ["400", 401],
        ["400", 402],
      ],
    );
  });

  it("still lists one crossing for a single passage", async () => {
    const { crossings } = await detect(fx, [1, 2, 3]);
    assert.deepStrictEqual(
      crossings.map((c) => [c.structure, c.partId]),
      [["400", 401]],
    );
  });
});

describe("route structures: the fallback box far north", () => {
  it("reaches at least 50 m east and west of the line at 65 N", async () => {
    const boxes: number[][] = [];
    const engine = Object.create(RoutingEngine.prototype) as any;
    engine._options = testOptions({ ...DEFAULT_CONFIG });
    engine.toRadians = (d: number) => (d * Math.PI) / 180;
    engine.db = {
      getRoutePois: async (pairs: unknown[]) =>
        pairs.map(() => ({ poiIds: [], known: false })),
      getPoisInBBox: async (...a: number[]) => {
        boxes.push(a);
        return [];
      },
    };
    const lat = 65;
    const line: [number, number][] = [
      [10, lat],
      [10.001, lat],
    ];
    await engine.detectRouteStructures(line, [{ from: 1, to: 2 }]);
    const [, minLon, , maxLon] = boxes[0];
    const mPerDeg = 111320 * Math.cos((lat * Math.PI) / 180);
    assert.ok((line[0][0] - minLon) * mPerDeg >= 50, "west margin");
    assert.ok((maxLon - line[1][0]) * mPerDeg >= 50, "east margin");
  });
});

describe("route structures: connector segments are never a turn-back", () => {
  let fx: Fixture;
  before(async () => {
    // A file that vouches for its edges, and a bridge beside nothing it holds.
    fx = await openFixture([
      {
        country: "AAA",
        nodes: line(2, 200),
        edges: [[1, 2]],
        pois: [
          { id: 81, type: BRIDGE, name: "Bridge 81", x: 2000, y: 10 },
          { id: 8, type: SPAN, parent: 81, x: 2000, y: 10 },
          { id: 82, type: BRIDGE, name: "Bridge 82", x: 100, y: 300 },
          { id: 9, type: SPAN, parent: 82, x: 100, y: 300 },
        ],
        edgePois: [[1, 2, 9]],
      },
    ]);
  });
  after(() => fx.close());

  it("lists a bridge once when the end connector's two -1 to -1 segments both pass it, heading back", async () => {
    // As connectUserPoint's end connector: along the snapped edge, then back
    // toward the user's point. Both within 50 m of the bridge.
    const coords = [pos(1800, 0), pos(2020, 0), pos(1985, 35)];
    const found = (await (fx.engine as any).detectRouteStructures(coords, [
      { from: -1, to: -1 },
      { from: -1, to: -1 },
    ])) as Found[];
    assert.deepStrictEqual(
      found.map((c) => c.structure),
      ["81"],
    );
  });
});

describe("route structures: a long lock with an unlinked edge in it", () => {
  let fx: Fixture;
  before(async () => {
    // Chamber 7 is linked to edges 1-2, 2-3, 4-5 and 5-6, not 3-4 (the file
    // holds it, so it is known and passes nothing). Its point sits at the
    // lock's west end: the second stretch's hits are 360 m from it (past
    // MERGE_ROUTE_DIST), but only 240 m after the first stretch's last hit.
    fx = await openFixture([
      {
        country: "AAA",
        nodes: line(6, 120),
        edges: [
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [5, 6],
        ],
        pois: [
          { id: 71, type: LOCK, name: "Lock 71", x: 0, y: 5 },
          { id: 7, type: CHAMBER, parent: 71, x: 0, y: 5 },
        ],
        edgePois: [
          [1, 2, 7],
          [2, 3, 7],
          [4, 5, 7],
          [5, 6, 7],
        ],
      },
    ]);
  });
  after(() => fx.close());

  it("is one passage: the gap is measured from where the first stretch ends", async () => {
    const { crossings } = await detect(fx, [1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(
      crossings.map((c) => c.structure),
      ["71"],
    );
  });
});

describe("route structures: a hard turn at a bridge is one passage", () => {
  let fx: Fixture;
  // Bridge X sits where the route bends, at (100, 5). The route is on no
  // file's edges (ids 11..13 are off-graph), so both legs are judged by the
  // 50 m fallback and both pass the span.
  const bend = (deg: number): Record<number, [number, number]> => {
    const r = (deg * Math.PI) / 180;
    return {
      11: [0, 0],
      12: [100, 0],
      13: [100 + 100 * Math.cos(r), 100 * Math.sin(r)],
    };
  };
  before(async () => {
    fx = await openFixture([
      {
        country: "AAA",
        nodes: [
          { id: 1, x: 0, y: -2000 },
          { id: 2, x: 200, y: -2000 },
        ],
        edges: [[1, 2]],
        pois: [
          { id: 500, type: BRIDGE, name: "Bridge X", x: 100, y: 5 },
          {
            id: 501,
            type: SPAN,
            parent: 500,
            properties: { subtype: "opening" },
            x: 100,
            y: 5,
          },
        ],
      },
    ]);
  });
  after(() => fx.close());

  it("lists the bridge once when the route turns 130 degrees under it", async () => {
    const { crossings } = await detect(fx, [11, 12, 13], bend(130));
    assert.deepStrictEqual(
      crossings.map((c) => c.structure),
      ["500"],
    );
  });

  it("still lists it twice when the route comes straight back (170 degrees)", async () => {
    const { crossings } = await detect(fx, [11, 12, 13], bend(170));
    assert.deepStrictEqual(
      crossings.map((c) => c.structure),
      ["500", "500"],
    );
  });
});

describe("route structures: a connector that cuts the first edge keeps its links", () => {
  let fx: Fixture;
  before(async () => {
    // Route 1-2-3 (200 m steps). Edge 1-2 runs through chamber 81 of lock 80;
    // the chamber's point sits 80 m off the line, beyond the 50 m fallback,
    // so only the edge_pois link can find it.
    fx = await openFixture([
      {
        country: "AAA",
        nodes: line(3, 200),
        edges: [
          [1, 2],
          [2, 3],
        ],
        pois: [
          { id: 80, type: LOCK, name: "Lock 80", x: 100, y: 80 },
          { id: 81, type: CHAMBER, parent: 80, x: 100, y: 80 },
        ],
        edgePois: [[1, 2, 81]],
      },
    ]);
  });
  after(() => fx.close());

  it("still lists the lock and marks the cut segment with it", async () => {
    const engine = fx.engine as any;
    const route = await engine.buildRouteResult([1, 2, 3], [1, 2, 3], 0);
    // The user starts 30 m south of the first edge, 60 m along it: the
    // connector projects onto the edge and replaces its first segment.
    const [lon, lat] = pos(60, -30);
    await engine.connectUserPoint(
      { latitude: lat, longitude: lon },
      route,
      "start",
    );
    const coords = route.features[0].geometry.coordinates;
    const segments = route.features[0].properties.segments as Seg[];
    assert.strictEqual(segments[1].from, -1, "fixture: the edge was cut");
    const crossings = (await engine.detectRouteStructures(
      coords,
      segments,
    )) as Found[];
    assert.deepStrictEqual(
      crossings.filter((c) => c.type === "lock").map((c) => c.structure),
      ["80"],
    );
    assert.deepStrictEqual(segments[1].lockIds, [80]);
  });
});

describe("route structures: the pass through a structure (#60)", () => {
  let fx: Fixture;
  before(async () => {
    // Route 1..6 along x, 200 m between nodes. Lock 700: chamber 701 on edges
    // 2-3, 3-4, 4-5 (x 200..800), a span over each head (702 on 1-2 at
    // x = 100, 703 on 5-6 at x = 900), 800 m apart. Bridge 710 has two spans
    // just as far apart (711 on 1-2, 712 on 5-6).
    fx = await openFixture([
      {
        country: "PAS",
        nodes: line(6, 200),
        edges: [
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [5, 6],
        ],
        pois: [
          { id: 700, type: LOCK, name: "Long lock", x: 500, y: 0 },
          { id: 701, type: CHAMBER, parent: 700, x: 500, y: 0 },
          {
            id: 702,
            type: SPAN,
            parent: 700,
            name: "Lower head",
            x: 100,
            y: 0,
          },
          {
            id: 703,
            type: SPAN,
            parent: 700,
            name: "Upper head",
            x: 900,
            y: 0,
          },
          { id: 710, type: BRIDGE, name: "Long bridge", x: 500, y: 0 },
          { id: 711, type: SPAN, parent: 710, x: 100, y: 0 },
          { id: 712, type: SPAN, parent: 710, x: 900, y: 0 },
        ],
        edgePois: [
          [2, 3, 701],
          [3, 4, 701],
          [4, 5, 701],
          [1, 2, 702],
          [5, 6, 703],
          [1, 2, 711],
          [5, 6, 712],
        ],
      },
    ]);
  });
  after(() => fx.close());

  const passes = (cs: Found[], structure: string, type: string) =>
    cs
      .filter((c) => c.structure === structure && c.type === type)
      .map((c) => [c.partId, c.passage]);

  it("keeps the spans over both heads of a long lock in one pass", async () => {
    const { crossings } = await detect(fx, [1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(passes(crossings, "700", "bridge"), [
      [702, 0],
      [703, 0],
    ]);
    assert.deepStrictEqual(passes(crossings, "700", "lock"), [[701, 0]]);
  });

  it("counts a bridge run beyond the merge distance as another pass", async () => {
    // Not a lock: a structure met again further on is a second pass (a loop
    // round an island under the same bridge looks just like this).
    const { crossings } = await detect(fx, [1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(passes(crossings, "710", "bridge"), [
      [711, 0],
      [712, 1],
    ]);
  });

  it("counts out and back through the lock as two passes", async () => {
    const { crossings } = await detect(fx, [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]);
    assert.deepStrictEqual(passes(crossings, "700", "bridge"), [
      [702, 0],
      [703, 0],
      [703, 1],
      [702, 1],
    ]);
    assert.deepStrictEqual(passes(crossings, "700", "lock"), [
      [701, 0],
      [701, 1],
    ]);
  });
});
