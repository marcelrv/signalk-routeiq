/**
 * Tide data for tide-aware routing: the provider interfaces the engine reads
 * through, and the field math built on what they return.
 *
 * - TideHeightProvider: tide-HEIGHT predictions, used only for the depth
 *   under the keel at the time of passage — see prepareTideHeights().
 * - CurrentProvider: harmonic current stations with set/drift. The only
 *   source of tidal *current* — see prepareStationFlowField(). Away from its
 *   stations the flow is zero. A current is never estimated from heights.
 *
 * The engine only ever sees FlowField.sample(lat, lon, t) -> (u, v) and
 * TideHeightField.riseAt(); how the stations are reached (HTTP, in-process,
 * files, an in-memory fake) is the provider's business.
 */

import { SILENT_LOGGER, type Logger } from "./logger.js";

export interface FlowVector {
  u: number; // m/s, east component
  v: number; // m/s, north component
}

export interface TideStationInfo {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface FlowField {
  /** Synchronous and cheap — called inside the A* inner loop. */
  sample(lat: number, lon: number, timeMs: number): FlowVector;
  /** Upper bound on |flow| — keeps the A* heuristic admissible. */
  readonly maxSpeedMs: number;
  readonly stations: TideStationInfo[];
  /** True when values are model estimates rather than measured/official data. */
  readonly estimated: boolean;
  /** Where the vectors come from: 'stations' (harmonic current stations via
   *  signalk-tidal-currents) or 'heights' (none: only tide heights are known,
   *  so the flow is zero everywhere). */
  readonly source: "stations" | "heights";
}

/**
 * Tide height, for turning a charted depth into the depth actually under the
 * keel at the time of passage.
 *
 * The value is a *rise above the fetched window's low water*, not a height
 * above any declared datum. That is deliberate: nothing here knows whether the
 * upstream `level` is referenced to LAT, MSL or something else — the current
 * model never had to care, because it only ever uses differences — and a
 * charted depth is referenced to LAT. Guessing wrong would overstate the water
 * by about half the tidal range, permanently, in the direction that runs a boat
 * aground. Any window minimum is at or above LAT, so a rise measured from it is
 * at or below the true height above LAT, whatever the source datum is. It reads
 * low at neaps and on short windows; that is the safe way to be wrong.
 */
export interface TideHeightField {
  /** The height stations the field was built from. */
  readonly stations: TideStationInfo[];
  /** Metres of tide above low water at (lat, lon, timeMs), or null when it
   *  cannot be answered — too few stations, a degenerate fit, or a time
   *  outside the fetched window. Never negative, and never 0 as a stand-in
   *  for "don't know": callers must be able to tell those apart. */
  riseAt(lat: number, lon: number, timeMs: number): number | null;
  /** Largest rise any station sees in the window. Lets a caller skip the
   *  lookup for an edge too shallow for any tide to rescue. */
  readonly maxRiseM: number;
}

export const KNOTS_TO_MS = 0.514444;

/** How far a height station may be from a sample point and still describe it. */
const MAX_STATION_DIST_M = 60_000;

interface StationTimeline {
  station: TideStationInfo;
  startMs: number;
  stepMs: number;
  levels: number[];
  /** Lowest level in the window — this station's own low-water reference.
   *  Per station, so stations need not share a datum (or even be consistent
   *  with each other) for the rise to come out right. */
  minLevel: number;
}

/** A height timeline as a provider returns it (fixed step, metres). */
export interface TideTimelineDto {
  timeline?: Array<{ time: string; level: number }>;
}

/**
 * Source of tide heights. `findStations` answers the nearest stations to a
 * position; `fetchTimeline` the heights for [startMs, endMs] (providers may
 * round the window outward and cache); `probe` says whether any station is
 * known near a position. Implementations do their own caching and failure
 * handling; any rejection reads as "no data" to the callers here.
 */
export interface TideHeightProvider {
  findStations(lat: number, lon: number): Promise<TideStationInfo[]>;
  fetchTimeline(
    stationId: string,
    startMs: number,
    endMs: number,
  ): Promise<TideTimelineDto>;
  probe(
    lat: number,
    lon: number,
  ): Promise<{ available: boolean; stations: TideStationInfo[] }>;
}

const EARTH_M_PER_DEG_LAT = 111_320;

/**
 * Tide heights from the signalk-tides stations: the rise above low water at a
 * point, interpolated from the nearby stations with a least-squares plane.
 * With fewer than 3 stations in range there is no answer (null).
 */
class StationTideHeights implements TideHeightField {
  readonly maxRiseM: number;
  readonly stations: TideStationInfo[];

  private timelines: StationTimeline[];
  private riseCache = new Map<string, number | null>();
  private static CACHE_MAX = 200_000;

  constructor(timelines: StationTimeline[]) {
    this.timelines = timelines;
    this.stations = timelines.map((t) => t.station);
    let maxRise = 0;
    for (const tl of timelines) {
      for (const l of tl.levels) maxRise = Math.max(maxRise, l - tl.minLevel);
    }
    this.maxRiseM = maxRise;
  }

  /** True when timeMs sits inside the fetched series. levelAt clamps to the
   *  ends rather than failing: outside the window it would quietly report the
   *  first or last level as though it were current. */
  private inWindow(tl: StationTimeline, timeMs: number): boolean {
    const endMs = tl.startMs + (tl.levels.length - 1) * tl.stepMs;
    return timeMs >= tl.startMs && timeMs <= endMs;
  }

  /** The stations this sample point should be interpolated from: nearest
   *  first, within MAX_STATION_DIST_M, at most 6. */
  private nearStations(
    lat: number,
    lon: number,
  ): Array<{ tl: StationTimeline; dx: number; dy: number; d2: number }> {
    const mPerDegLon = EARTH_M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
    return this.timelines
      .map((tl) => {
        const dx = (tl.station.longitude - lon) * mPerDegLon;
        const dy = (tl.station.latitude - lat) * EARTH_M_PER_DEG_LAT;
        return { tl, dx, dy, d2: dx * dx + dy * dy };
      })
      .sort((a, b) => a.d2 - b.d2)
      .filter((w) => w.d2 < MAX_STATION_DIST_M * MAX_STATION_DIST_M)
      .slice(0, 6);
  }

  /**
   * Rise above low water at a point, by fitting a least-squares plane
   * h = a + bx + cy through each station's rise (not its raw level). With x
   * and y measured from the sample point, the intercept a *is* the
   * interpolated rise there.
   *
   * Fitting rises rather than levels is what makes the datum question go away:
   * a constant offset in one station's series cancels against its own minimum
   * before it ever reaches the fit.
   */
  riseAt(lat: number, lon: number, timeMs: number): number | null {
    if (this.timelines.length < 3) return null;

    // Quantize once, then answer for that instant. Keying the cache on a
    // 10-minute bucket while evaluating the raw time means two callers in the
    // same bucket share whichever answer arrived first — including a non-null
    // rise handed to a caller whose time is outside the window, and an answer
    // describing an instant minutes off the one asked about. On a rising tide
    // that lands permissive, which is the one direction this must not drift.
    const bucketMs = Math.round(timeMs / 600_000) * 600_000;
    const key = `${Math.round(lat * 50)},${Math.round(lon * 50)},${bucketMs}`;
    const cached = this.riseCache.get(key);
    if (cached !== undefined) return cached;

    const near = this.nearStations(lat, lon);
    // At least three stations, so the plane is determined: a permissive depth
    // answer from one distant or wrong-side station is the difference between
    // a detour and a grounding.
    const answer =
      near.length >= 3 && near.every((w) => this.inWindow(w.tl, bucketMs))
        ? this.fitRise(near, bucketMs)
        : null;

    if (this.riseCache.size > StationTideHeights.CACHE_MAX)
      this.riseCache.clear();
    this.riseCache.set(key, answer);
    return answer;
  }

  private fitRise(
    near: Array<{ tl: StationTimeline; dx: number; dy: number }>,
    timeMs: number,
  ): number | null {
    let sx = 0,
      sy = 0,
      sxx = 0,
      syy = 0,
      sxy = 0,
      sh = 0,
      shx = 0,
      shy = 0;
    for (const w of near) {
      const h = this.levelAt(w.tl, timeMs) - w.tl.minLevel;
      sx += w.dx;
      sy += w.dy;
      sxx += w.dx * w.dx;
      syy += w.dy * w.dy;
      sxy += w.dx * w.dy;
      sh += h;
      shx += h * w.dx;
      shy += h * w.dy;
    }
    const n = near.length;
    const det =
      n * (sxx * syy - sxy * sxy) -
      sx * (sx * syy - sxy * sy) +
      sy * (sx * sxy - sxx * sy);
    if (Math.abs(det) <= 1e-9) return null;
    // Cramer again, replacing the first column: the intercept of h = a + bx + cy.
    const a =
      (sh * (sxx * syy - sxy * sxy) -
        sx * (shx * syy - sxy * shy) +
        sy * (shx * sxy - sxx * shy)) /
      det;
    // A plane through scattered points can overshoot; the answer cannot be
    // below low water or above the biggest rise anyone in the set sees.
    return Math.max(0, Math.min(this.maxRiseM, a));
  }

  private levelAt(tl: StationTimeline, timeMs: number): number {
    const pos = (timeMs - tl.startMs) / tl.stepMs;
    const i = Math.max(0, Math.min(tl.levels.length - 2, Math.floor(pos)));
    const f = Math.max(0, Math.min(1, pos - i));
    return tl.levels[i] * (1 - f) + tl.levels[i + 1] * f;
  }
}

// ── Current stations ────────────────────────────────────────────────

export interface CurrentStationDto {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  vectorCapable?: boolean;
  distanceKm?: number;
}

export interface CurrentTimelineDto {
  timeline?: Array<{ time: string; u: number | null; v: number | null }>;
}

/**
 * Source of tidal currents. `findStations` answers the nearest
 * vector-capable stations to a position; `fetchTimeline` their set/drift
 * (u east, v north, m/s) for [startMs, endMs]; `probe` says whether any
 * such station is known near a position.
 */
export interface CurrentProvider {
  findStations(lat: number, lon: number): Promise<CurrentStationDto[]>;
  fetchTimeline(
    stationId: string,
    startMs: number,
    endMs: number,
  ): Promise<CurrentTimelineDto>;
  probe(lat: number, lon: number): Promise<boolean>;
}

interface StationSeries {
  info: TideStationInfo;
  startMs: number;
  stepMs: number;
  u: number[];
  v: number[];
}

/** Beyond this range a current station says nothing about local flow. */
const STATION_RANGE_M = 20_000;

/**
 * Flow field backed by real harmonic current stations: nearest station
 * within range, linear time interpolation. Out of range of every station the
 * flow is zero — no current is invented where nothing is known.
 */
class StationFlowField implements FlowField {
  readonly maxSpeedMs: number;
  readonly stations: TideStationInfo[];
  readonly estimated: boolean;
  readonly source = "stations" as const;

  constructor(private series: StationSeries[]) {
    let max = 0;
    for (const s of series) {
      for (let i = 0; i < s.u.length; i++) {
        max = Math.max(max, Math.hypot(s.u[i], s.v[i]));
      }
    }
    this.maxSpeedMs = max;
    this.stations = series.map((s) => s.info);
    // Station predictions themselves derive from community harmonic data.
    this.estimated = true;
  }

  sample(lat: number, lon: number, timeMs: number): FlowVector {
    const mPerDegLon = EARTH_M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
    let best: StationSeries | null = null;
    let bestD2 = STATION_RANGE_M * STATION_RANGE_M;
    for (const s of this.series) {
      const dx = (s.info.longitude - lon) * mPerDegLon;
      const dy = (s.info.latitude - lat) * EARTH_M_PER_DEG_LAT;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = s;
      }
    }
    if (!best) return { u: 0, v: 0 };
    const pos = (timeMs - best.startMs) / best.stepMs;
    const i = Math.max(0, Math.min(best.u.length - 2, Math.floor(pos)));
    const f = Math.max(0, Math.min(1, pos - i));
    return {
      u: best.u[i] * (1 - f) + best.u[i + 1] * f,
      v: best.v[i] * (1 - f) + best.v[i + 1] * f,
    };
  }
}

/**
 * Prepare a station-backed flow field for a route. Queries stations at the
 * anchor points AND at midpoints between them (long legs would otherwise
 * miss mid-route stations) and prefetches their set/drift timelines.
 * Returns null when no vector-capable station is anywhere near the route.
 */
export async function prepareStationFlowField(
  client: CurrentProvider,
  anchors: Array<{ latitude: number; longitude: number }>,
  startMs: number,
  endMs: number,
  logger: Logger = SILENT_LOGGER,
): Promise<FlowField | null> {
  try {
    // Densify: anchor points plus midpoints of consecutive anchors.
    const points = [...anchors];
    for (let i = 1; i < anchors.length; i++) {
      points.push({
        latitude: (anchors[i - 1].latitude + anchors[i].latitude) / 2,
        longitude: (anchors[i - 1].longitude + anchors[i].longitude) / 2,
      });
    }
    // All points at once: one slow answer then costs one wait, not one per
    // point.
    const byId = new Map<string, CurrentStationDto>();
    const found = await Promise.all(
      points.map((p) => client.findStations(p.latitude, p.longitude)),
    );
    for (const list of found) for (const s of list) byId.set(s.id, s);
    if (byId.size === 0) return null;

    const padMs = 3600_000;
    const results = await Promise.allSettled(
      [...byId.values()].map(async (st): Promise<StationSeries> => {
        const data = await client.fetchTimeline(
          st.id,
          startMs - padMs,
          endMs + padMs,
        );
        const tl = (data.timeline ?? []).filter(
          (e) => e.u !== null && e.v !== null,
        );
        if (tl.length < 3) throw new Error("empty timeline");
        const t0 = Date.parse(tl[0].time);
        const stepMs = Date.parse(tl[1].time) - t0;
        return {
          info: {
            id: st.id,
            name: st.name,
            latitude: st.latitude,
            longitude: st.longitude,
          },
          startMs: t0,
          stepMs,
          u: tl.map((e) => e.u as number),
          v: tl.map((e) => e.v as number),
        };
      }),
    );
    const series = results
      .filter(
        (r): r is PromiseFulfilledResult<StationSeries> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value);
    if (series.length === 0) return null;
    return new StationFlowField(series);
  } catch (e) {
    logger.warn(`[routeiq] station flow field unavailable: ${e}`);
    return null;
  }
}

/**
 * Prepare tide heights covering a route request: find height stations around
 * the request area, prefetch their timelines for the travel window, and return
 * a synchronously queryable field. Returns null when heights are unavailable
 * (plugin missing, no stations, fetch failures).
 */
export async function prepareTideHeights(
  client: TideHeightProvider,
  points: Array<{ latitude: number; longitude: number }>,
  startMs: number,
  endMs: number,
  logger: Logger = SILENT_LOGGER,
): Promise<TideHeightField | null> {
  try {
    // Union of nearest stations at each anchor point (start / via / end).
    const byId = new Map<string, TideStationInfo>();
    const found = await Promise.all(
      points.map((p) => client.findStations(p.latitude, p.longitude)),
    );
    for (const list of found) for (const s of list) byId.set(s.id, s);
    if (byId.size === 0) return null;

    const timelines: StationTimeline[] = [];
    // Pad the window so mid-route sampling stays inside it.
    const padMs = 3600_000;
    const results = await Promise.allSettled(
      [...byId.values()].map(async (station) => {
        const data = await client.fetchTimeline(
          station.id,
          startMs - padMs,
          endMs + padMs,
        );
        const tl = data.timeline;
        if (!tl || tl.length < 3) throw new Error("empty timeline");
        const t0 = Date.parse(tl[0].time);
        const stepMs = Date.parse(tl[1].time) - t0;
        const levels = tl.map((e) => e.level);
        const minLevel = Math.min(...levels);
        return {
          station,
          startMs: t0,
          stepMs,
          levels,
          minLevel,
        } as StationTimeline;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") timelines.push(r.value);
    }
    if (timelines.length === 0) return null;

    return new StationTideHeights(timelines);
  } catch (e) {
    logger.warn(`[routeiq] tide heights unavailable: ${e}`);
    return null;
  }
}

/** The flow when only tide heights are known: zero everywhere. Lets a route
 *  use the heights for depth without any current being applied. */
export function noCurrentField(stations: TideStationInfo[]): FlowField {
  return {
    sample: () => ({ u: 0, v: 0 }),
    maxSpeedMs: 0,
    stations,
    estimated: true,
    source: "heights",
  };
}
