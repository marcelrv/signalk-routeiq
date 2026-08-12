import * as fs from "fs";
import * as path from "path";
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { RoutingDatabase } from "../dist/database.js";
import { RoutingEngine } from "../dist/routing.js";
import { prepareTidalFlowField, TidesClient } from "../dist/tides.js";
import { DEFAULT_CONFIG } from "../dist/types.js";

// Charted depths are referenced to LAT, so they are the low-water case and the
// router used to treat every hour of the day as low water. These cover the two
// halves of making that time-dependent: the height lookup itself, and an actual
// route that takes a different channel at high water than at low.
//
// The rise is deliberately measured from the *fetched window's* low water
// rather than from a declared datum — see TideHeightField. Nothing here knows
// whether the upstream level is above LAT or MSL, and guessing wrong would
// overstate the water permanently, in the direction that runs a boat aground.

const HOUR_MS = 3_600_000;
const TIDE_PERIOD_MS = 12.42 * HOUR_MS; // one semidiurnal cycle
const AMPLITUDE_M = 0.75; // so the full range, and the largest rise, is 1.5 m

/** A synthetic tide: a sinusoid at 10-minute steps, `datumOffset` metres away
 *  from whatever anyone else's zero is. Low water at `lowWaterMs`. */
function levelsFor(
  startMs: number,
  endMs: number,
  lowWaterMs: number,
  datumOffset: number,
): Array<{ time: string; level: number }> {
  const out: Array<{ time: string; level: number }> = [];
  for (let t = startMs; t <= endMs; t += 600_000) {
    const phase = ((t - lowWaterMs) / TIDE_PERIOD_MS) * 2 * Math.PI;
    out.push({
      time: new Date(t).toISOString(),
      level: datumOffset + AMPLITUDE_M * (1 - Math.cos(phase)),
    });
  }
  return out;
}

/** Stub tides client. Stations are placed around the fixture so all three sit
 *  well inside the 60 km the height fit accepts. */
function stubTidesClient(
  lowWaterMs: number,
  stations: Array<{ id: string; lat: number; lon: number; offset: number }>,
): TidesClient {
  const byId = new Map(stations.map((s) => [s.id, s]));
  return {
    findStations: async () =>
      stations.map((s) => ({
        id: s.id,
        name: s.id,
        latitude: s.lat,
        longitude: s.lon,
      })),
    fetchTimeline: async (id: string, startMs: number, endMs: number) => ({
      timeline: levelsFor(startMs, endMs, lowWaterMs, byId.get(id)!.offset),
    }),
  } as unknown as TidesClient;
}

const STATIONS = [
  { id: "north", lat: 52.08, lon: 5.0, offset: 0 },
  // Deliberately different datum offsets: the fit works on each station's rise
  // above its own minimum, so these must not affect the answer at all.
  { id: "south", lat: 51.92, lon: 5.0, offset: 12.5 },
  { id: "east", lat: 52.0, lon: 5.12, offset: -3.25 },
];

describe("tide-informed depth", () => {
  describe("riseAt — the height lookup", () => {
    const lowWaterMs = Date.parse("2026-08-11T00:00:00Z");

    async function fieldAt(lowMs: number, stations = STATIONS) {
      return prepareTidalFlowField(
        stubTidesClient(lowMs, stations),
        [{ latitude: 52.0, longitude: 5.0 }],
        lowMs,
        lowMs + 8 * HOUR_MS,
        2.0,
      );
    }

    it("reads zero at low water and the full range at high water", async () => {
      const field = (await fieldAt(lowWaterMs))!;
      assert.ok(field, "expected a height field from the stub client");

      const atLow = field.riseAt(52.0, 5.0, lowWaterMs);
      assert.ok(atLow !== null);
      assert.ok(
        Math.abs(atLow!) < 0.02,
        `expected ~0 m at low water, got ${atLow}`,
      );

      const atHigh = field.riseAt(52.0, 5.0, lowWaterMs + TIDE_PERIOD_MS / 2);
      assert.ok(atHigh !== null);
      assert.ok(
        Math.abs(atHigh! - 2 * AMPLITUDE_M) < 0.02,
        `expected ~${2 * AMPLITUDE_M} m at high water, got ${atHigh}`,
      );
    });

    it("is unmoved by the stations disagreeing about their datum", async () => {
      // STATIONS carry offsets of 0, +12.5 and -3.25 m. If the fit used raw
      // levels instead of each station's rise above its own minimum, the
      // interpolated answer would be dragged towards their mean.
      const spread = (await fieldAt(lowWaterMs))!;
      const aligned = (await fieldAt(
        lowWaterMs,
        STATIONS.map((s) => ({ ...s, offset: 0 })),
      ))!;
      const t = lowWaterMs + 3 * HOUR_MS;
      const a = spread.riseAt(52.0, 5.0, t)!;
      const b = aligned.riseAt(52.0, 5.0, t)!;
      assert.ok(a !== null && b !== null);
      assert.ok(
        Math.abs(a - b) < 1e-6,
        `datum offsets must cancel: ${a} vs ${b}`,
      );
    });

    it("declines to answer with fewer than three stations", async () => {
      // Not 0 — a caller has to be able to tell "no tide" from "no idea", or
      // it will quietly treat ignorance as low water and call it conservative.
      const field = await fieldAt(lowWaterMs, STATIONS.slice(0, 2));
      assert.strictEqual(field!.riseAt(52.0, 5.0, lowWaterMs), null);
    });

    it("declines to answer outside the fetched window", async () => {
      // levelAt clamps to the ends of the series, which is harmless for a
      // gradient but would report the first or last level as though current.
      const field = (await fieldAt(lowWaterMs))!;
      assert.strictEqual(
        field.riseAt(52.0, 5.0, lowWaterMs - 5 * HOUR_MS),
        null,
      );
      assert.strictEqual(
        field.riseAt(52.0, 5.0, lowWaterMs + 40 * HOUR_MS),
        null,
      );
    });

    it("reports the largest rise the window holds, for the skip guard", async () => {
      const field = (await fieldAt(lowWaterMs))!;
      assert.ok(
        Math.abs(field.maxRiseM - 2 * AMPLITUDE_M) < 0.02,
        `expected maxRiseM ~${2 * AMPLITUDE_M}, got ${field.maxRiseM}`,
      );
    });
  });

  describe("depthAtPassage — folding the rise into a charted depth", () => {
    const engine = Object.create(RoutingEngine.prototype) as any;
    engine._config = { ...DEFAULT_CONFIG };
    const env = {
      departureMs: 0,
      offsetSec: 0,
      speedMs: 3,
      flow: {},
      heights: { riseAt: () => 1.0, maxRiseM: 1.5 },
    };

    it("adds the rise to a known depth", () => {
      assert.strictEqual(engine.depthAtPassage(1.5, 52, 5, 1000, env), 2.5);
    });

    it("leaves an unknown depth unknown", () => {
      // -1 means "the chart does not say", and -1 + 1.0 would turn that into a
      // shallow reading nobody has any evidence for.
      assert.strictEqual(engine.depthAtPassage(-1, 52, 5, 1000, env), -1);
    });

    it("leaves the depth alone when there is no tide to consult", () => {
      assert.strictEqual(
        engine.depthAtPassage(1.5, 52, 5, 1000, undefined),
        1.5,
      );
      assert.strictEqual(
        engine.depthAtPassage(1.5, 52, 5, undefined, env),
        1.5,
      );
      const silent = { ...env, heights: { riseAt: () => null, maxRiseM: 1.5 } };
      assert.strictEqual(engine.depthAtPassage(1.5, 52, 5, 1000, silent), 1.5);
    });
  });

  describe("segmentDepthAtPassage — which legs the tide may touch", () => {
    const engine = Object.create(RoutingEngine.prototype) as any;
    engine._config = { ...DEFAULT_CONFIG };
    const env = {
      departureMs: 0,
      offsetSec: 0,
      speedMs: 3,
      flow: {},
      heights: { riseAt: () => 2.0, maxRiseM: 2.0 },
    };
    const from = [5.0, 52.0];
    const to = [5.01, 52.0];

    it("covers a real charted depth even on a leg with synthetic node ids", () => {
      // The segment connectUserPoint builds when it snaps to the nearest edge
      // carries that edge's real charted depth but -1 for both node ids.
      // Excluding it by node id, as the first cut did, left the last stretch
      // before the destination judged at low water — the approach to a berth,
      // which is the one place this feature most needs to work.
      const seg = { from: -1, to: -1, minDepth: 0.5 };
      assert.strictEqual(
        engine.segmentDepthAtPassage(seg, from, to, 1000, env),
        2.5,
      );
    });

    it("leaves a leg drawn across land alone", () => {
      // markOverland writes 0 to say "this crosses dry land". No tide answers
      // that, and adding one would clear the warning that says so.
      const seg = { from: -1, to: -1, minDepth: 0, crossesLand: true };
      assert.strictEqual(
        engine.segmentDepthAtPassage(seg, from, to, 1000, env),
        0,
      );
    });

    it("still leaves an unknown depth unknown", () => {
      const seg = { from: 1, to: 2, minDepth: -1 };
      assert.strictEqual(
        engine.segmentDepthAtPassage(seg, from, to, 1000, env),
        -1,
      );
    });
  });

  describe("a route that takes a different channel at high water", () => {
    const fixturesDir = "./test/fixtures/tide-depth";
    const dbPath = path.join(fixturesDir, "tide_depth.sqlite");
    const overlayPath = path.join(fixturesDir, "user-edits.sqlite");
    let db: RoutingDatabase;

    // Same geometry as test/bbox-penalty-retry.test.ts: a short direct hop and
    // a long way round, so the only reason to take the detour is depth.
    const A = { lat: 52.0, lon: 5.0 };
    const B = { lat: 52.0, lon: 5.035 };
    const C = { lat: 51.984, lon: 4.984 };
    const lowWaterMs = Date.parse("2026-08-11T00:00:00Z");
    const highWaterMs = lowWaterMs + TIDE_PERIOD_MS / 2;

    before(async () => {
      if (!fs.existsSync(fixturesDir))
        fs.mkdirSync(fixturesDir, { recursive: true });
      for (const p of [dbPath, overlayPath])
        if (fs.existsSync(p)) fs.unlinkSync(p);

      const raw = new DatabaseSync(dbPath, { open: true });
      const run = (sql: string, params: unknown[] = []) =>
        raw.prepare(sql).run(...(params as any[]));
      run(`CREATE TABLE metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, description TEXT, last_update_date TEXT NOT NULL
      )`);
      run(`INSERT INTO metadata (country, name, description, last_update_date)
           VALUES ('TIDE', 'Tide Depth Fixture', 'Synthetic', '2026-01-01T00:00:00Z')`);
      run(
        `CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL, lon REAL, resolution REAL DEFAULT 0.0, node_depth REAL DEFAULT -1, region_id INTEGER)`,
      );
      run(`INSERT INTO nodes (id, lat, lon, region_id) VALUES
        (1, ${A.lat}, ${A.lon}, 1), (2, ${B.lat}, ${B.lon}, 1), (3, ${C.lat}, ${C.lon}, 1)`);
      run(`CREATE TABLE edges (
        source INTEGER, target INTEGER, distance REAL,
        min_depth REAL, max_air_draft REAL, min_width REAL,
        cost_factor REAL DEFAULT 1.0, distance_to_land REAL,
        edge_type_id INTEGER DEFAULT 1, traffic_mode INTEGER DEFAULT 0
      )`);
      // A<->B is 1.5 m charted, against a required 2.3 m (draft 2.0 + margin
      // 0.3): short of it at low water, comfortably clear at high. The detour
      // through C is deep but 2.5x longer.
      run(`INSERT INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode) VALUES
        (1, 2, 2396, 1.5, 20.0, 10.0, 1.0, 5000, 1, 0),
        (2, 1, 2396, 1.5, 20.0, 10.0, 1.0, 5000, 1, 0),
        (1, 3, 2089, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
        (3, 1, 2089, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
        (3, 2, 3919, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0),
        (2, 3, 3919, 10.0, 20.0, 10.0, 1.0, 5000, 1, 0)`);
      run(
        `CREATE TABLE pois (id INTEGER PRIMARY KEY, name TEXT, type_id INTEGER, properties TEXT, lat REAL, lon REAL)`,
      );
      raw.close();

      db = new RoutingDatabase(fixturesDir);
      await db.init();
      await db.loadGraph();
    });

    after(async () => {
      await db.close();
      for (const p of [dbPath, overlayPath])
        if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    function engineFor(lowMs: number): RoutingEngine {
      const engine = new RoutingEngine(db, { ...DEFAULT_CONFIG });
      engine.setVesselDimensions({ draft: 2.0, beam: 4.0, airDraft: 5.0 });
      engine.setTidesClient(stubTidesClient(lowMs, STATIONS));
      return engine;
    }

    async function routeAt(departureMs: number, useTides = true) {
      return engineFor(lowWaterMs).calculateRoute({
        start: { latitude: A.lat, longitude: A.lon },
        end: { latitude: B.lat, longitude: B.lon },
        minCoastDistance: 0,
        useTides,
        departureTime: new Date(departureMs).toISOString(),
      });
    }

    /** Did the route go the long way round, through C? */
    function viaDetour(route: {
      features?: Array<{ geometry: { coordinates: number[][] } }>;
    }): boolean {
      const coords = (route.features ?? []).flatMap(
        (f) => f.geometry.coordinates,
      );
      return coords.some(
        ([lon, lat]) =>
          Math.abs(lat - C.lat) < 1e-6 && Math.abs(lon - C.lon) < 1e-6,
      );
    }

    it("takes the deep way round at low water", async () => {
      const route = await routeAt(lowWaterMs);
      assert.ok(
        viaDetour(route),
        "expected the detour through C while the tide is out",
      );
    });

    it("takes the short shallow channel at high water", async () => {
      const route = await routeAt(highWaterMs);
      assert.ok(
        !viaDetour(route),
        "expected the direct hop once the tide has risen",
      );
      assert.ok(
        route.totalDistance! < 3000,
        `expected the ~2396 m direct route, got ${route.totalDistance}`,
      );
    });

    it("reports the charted depth and the passage depth side by side", async () => {
      const route = await routeAt(highWaterMs);
      // finalizeRoute splits the route into one feature per segment, so the
      // depths live on the feature properties by the time a client sees them.
      const props = route.features!.map((f) => f.properties);
      const shallow = props.find((p) => p.minDepth === 1.5);
      assert.ok(
        shallow,
        "the direct route should still report its charted 1.5 m",
      );
      assert.ok(
        shallow!.minDepthAtPassage! > 2.3,
        `expected the passage depth to clear 2.3 m, got ${shallow!.minDepthAtPassage}`,
      );
      assert.ok(
        Math.abs(shallow!.tideRiseM! - (shallow!.minDepthAtPassage! - 1.5)) <
          0.01,
        "tideRiseM should be the difference between the two",
      );
      assert.strictEqual(route.tide?.depthAware, true);
    });

    it("leaves the route alone when tides are off", async () => {
      // The invariant from feature-tidal-routing.md: with tides off nothing
      // about the answer changes, however deep the water really is.
      const route = await routeAt(highWaterMs, false);
      assert.ok(
        viaDetour(route),
        "expected the charted-only detour with tides off",
      );
      assert.strictEqual(route.tide?.depthAware, undefined);
      const props = route.features!.map((f) => f.properties);
      assert.ok(props.every((p) => p.minDepthAtPassage === undefined));
    });
  });
});
