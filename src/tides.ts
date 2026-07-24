/**
 * Tidal current estimation for tide-aware routing.
 *
 * Data source: the signalk-tides plugin (https://github.com/bkeepers/signalk-tides)
 * which serves offline harmonic tide-HEIGHT predictions at
 * /signalk/v2/api/tides (station search by position, 10-minute timelines).
 * It provides no current (set/drift) data, so v1 derives an ESTIMATED
 * current from the height stations — see prepareTidalFlowField().
 *
 * Architecture note: FlowField is the provider-agnostic abstraction the
 * routing engine consumes. Future providers (ENC TS_PAD panels, RWS
 * stroomatlas, GRIB currents, and eventually WIND) implement the same
 * interface; the engine only ever sees sample(lat, lon, t) → (u, v).
 */

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
   *  signalk-tidal-currents) or 'height-estimate' (derived from tide heights). */
  readonly source: 'stations' | 'height-estimate';
}

export const KNOTS_TO_MS = 0.514444;

interface StationTimeline {
  station: TideStationInfo;
  startMs: number;
  stepMs: number;
  levels: number[];
  maxAbsDhDt: number; // m/s over the fetched window, for phase normalization
}

interface TimelineResponse {
  timeline?: Array<{ time: string; level: number }>;
}

/** Hard cap on cache entries per Map — a backstop behind TTL pruning so a
 *  vessel wandering through many coordinate buckets can't grow these maps
 *  unbounded even within the TTL window. */
const CACHE_MAX_ENTRIES = 500;

/** Delete expired entries (age >= ttlMs) from `map`, then, if it's still
 *  over `CACHE_MAX_ENTRIES`, evict the oldest entries (smallest `at`) until
 *  it's under the cap. Call before every cache `.set(...)`. */
function pruneCache<T>(map: Map<string, { at: number; data: T }>, ttlMs: number): void {
  const now = Date.now();
  for (const [k, v] of map) {
    if (now - v.at >= ttlMs) map.delete(k);
  }
  if (map.size >= CACHE_MAX_ENTRIES) {
    const entries = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
    const toEvict = map.size - CACHE_MAX_ENTRIES + 1;
    for (let i = 0; i < toEvict; i++) map.delete(entries[i][0]);
  }
}

/**
 * Client for the signalk-tides REST API with response caching, so a 24 h
 * departure scan (dozens of route calculations) reuses one set of fetches.
 */
export class TidesClient {
  private baseUrl: string;
  private stationCache = new Map<string, { at: number; data: TideStationInfo[] }>();
  private timelineCache = new Map<string, { at: number; data: TimelineResponse }>();
  private static CACHE_TTL_MS = 6 * 3600_000;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private api(path: string): string {
    return `${this.baseUrl}/signalk/v2/api/tides${path}`;
  }

  /** Nearest stations (the API returns up to 10, closest first). */
  async findStations(lat: number, lon: number): Promise<TideStationInfo[]> {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const hit = this.stationCache.get(key);
    if (hit && Date.now() - hit.at < TidesClient.CACHE_TTL_MS) return hit.data;

    const resp = await fetch(this.api(`/stations?latitude=${lat}&longitude=${lon}`));
    if (!resp.ok) throw new Error(`tides station search failed (${resp.status})`);
    const raw = (await resp.json()) as Array<Record<string, unknown>>;
    const data = (Array.isArray(raw) ? raw : [])
      .filter((s) => typeof s.latitude === 'number' && typeof s.longitude === 'number')
      .map((s) => ({
        id: String(s.id),
        name: String(s.name ?? s.id),
        latitude: s.latitude as number,
        longitude: s.longitude as number,
      }));
    pruneCache(this.stationCache, TidesClient.CACHE_TTL_MS);
    this.stationCache.set(key, { at: Date.now(), data });
    return data;
  }

  /** Height timeline (fixed 10-minute interval) for [startMs, endMs]. */
  async fetchTimeline(stationId: string, startMs: number, endMs: number): Promise<TimelineResponse> {
    // Round the window outward to whole hours so scan steps share cache entries.
    const HOUR = 3600_000;
    const s = Math.floor(startMs / HOUR) * HOUR;
    const e = Math.ceil(endMs / HOUR) * HOUR;
    const key = `${stationId}|${s}|${e}`;
    const hit = this.timelineCache.get(key);
    if (hit && Date.now() - hit.at < TidesClient.CACHE_TTL_MS) return hit.data;

    const url = this.api(
      `/stations/${stationId}/timeline` +
      `?start=${encodeURIComponent(new Date(s).toISOString())}` +
      `&end=${encodeURIComponent(new Date(e).toISOString())}`,
    );
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`tides timeline failed for ${stationId} (${resp.status})`);
    const data = (await resp.json()) as TimelineResponse;
    pruneCache(this.timelineCache, TidesClient.CACHE_TTL_MS);
    this.timelineCache.set(key, { at: Date.now(), data });
    return data;
  }

  /** Availability probe: plugin reachable and knows stations near (lat, lon). */
  async probe(lat: number, lon: number): Promise<{ available: boolean; stations: TideStationInfo[] }> {
    try {
      const stations = await this.findStations(lat, lon);
      return { available: stations.length > 0, stations };
    } catch {
      return { available: false, stations: [] };
    }
  }
}

const EARTH_M_PER_DEG_LAT = 111_320;

/**
 * Height-derived tidal flow field (v1 "estimated current" model).
 *
 * Magnitude: dh/dt at the nearest station, normalized by that station's max
 * |dh/dt| over the window → phase in [0, 1], times the configured spring
 * current. Direction: water flows down the sea-surface slope, taken from a
 * least-squares plane through the heights of the nearby stations. With
 * fewer than 3 stations the direction is indeterminate → zero flow
 * (conservative: never invents a favorable current).
 */
class HeightGradientFlowField implements FlowField {
  readonly maxSpeedMs: number;
  readonly stations: TideStationInfo[];
  readonly estimated = true;
  readonly source = 'height-estimate' as const;

  private timelines: StationTimeline[];
  private sampleCache = new Map<string, FlowVector>();
  private static CACHE_MAX = 200_000;

  constructor(timelines: StationTimeline[], maxCurrentKnots: number) {
    this.timelines = timelines;
    this.maxSpeedMs = maxCurrentKnots * KNOTS_TO_MS;
    this.stations = timelines.map((t) => t.station);
  }

  private levelAt(tl: StationTimeline, timeMs: number): number {
    const pos = (timeMs - tl.startMs) / tl.stepMs;
    const i = Math.max(0, Math.min(tl.levels.length - 2, Math.floor(pos)));
    const f = Math.max(0, Math.min(1, pos - i));
    return tl.levels[i] * (1 - f) + tl.levels[i + 1] * f;
  }

  private dhDtAt(tl: StationTimeline, timeMs: number): number {
    const h1 = this.levelAt(tl, timeMs - tl.stepMs / 2);
    const h2 = this.levelAt(tl, timeMs + tl.stepMs / 2);
    return (h2 - h1) / (tl.stepMs / 1000); // m/s
  }

  sample(lat: number, lon: number, timeMs: number): FlowVector {
    if (this.timelines.length < 3) return { u: 0, v: 0 };

    // Memoize on ~2 km / 10 min buckets — A* revisits nearby edges at
    // similar times, and the tide field is smooth at that scale.
    const key = `${Math.round(lat * 50)},${Math.round(lon * 50)},${Math.round(timeMs / 600_000)}`;
    const cached = this.sampleCache.get(key);
    if (cached) return cached;

    const mPerDegLon = EARTH_M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

    // Nearest stations to this sample point (they are few — linear scan).
    const withDist = this.timelines.map((tl) => {
      const dx = (tl.station.longitude - lon) * mPerDegLon;
      const dy = (tl.station.latitude - lat) * EARTH_M_PER_DEG_LAT;
      return { tl, dx, dy, d2: dx * dx + dy * dy };
    }).sort((a, b) => a.d2 - b.d2);

    const MAX_STATION_DIST_M = 60_000;
    const near = withDist.filter((w) => w.d2 < MAX_STATION_DIST_M * MAX_STATION_DIST_M).slice(0, 6);
    const result: FlowVector = { u: 0, v: 0 };

    if (near.length >= 3) {
      // Least-squares plane h = a + b·x + c·y through station heights (x, y
      // in meters relative to the sample point). (b, c) = surface gradient.
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sh = 0, shx = 0, shy = 0;
      for (const w of near) {
        const h = this.levelAt(w.tl, timeMs);
        sx += w.dx; sy += w.dy; sxx += w.dx * w.dx; syy += w.dy * w.dy;
        sxy += w.dx * w.dy; sh += h; shx += h * w.dx; shy += h * w.dy;
      }
      const n = near.length;
      // Solve the 3x3 normal equations via Cramer's rule.
      const det =
        n * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
      if (Math.abs(det) > 1e-9) {
        const b =
          (n * (shx * syy - sxy * shy) - sh * (sx * syy - sxy * sy) + sy * (sx * shy - shx * sy)) / det;
        const c =
          (n * (sxx * shy - shx * sxy) - sx * (sx * shy - shx * sy) + sh * (sx * sxy - sxx * sy)) / det;
        const gradLen = Math.hypot(b, c);
        // Typical tidal surface slope is ~1e-5; below a tenth of that the
        // direction is numerically meaningless.
        if (gradLen > 1e-7) {
          const phase = Math.min(1, Math.abs(this.dhDtAt(near[0].tl, timeMs)) / (near[0].tl.maxAbsDhDt || 1e-9));
          const speed = this.maxSpeedMs * phase;
          result.u = (-b / gradLen) * speed;
          result.v = (-c / gradLen) * speed;
        }
      }
    }

    if (this.sampleCache.size > HeightGradientFlowField.CACHE_MAX) this.sampleCache.clear();
    this.sampleCache.set(key, result);
    return result;
  }
}

// ── Real current stations via signalk-tidal-currents ─────────────────

interface CurrentStationDto {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  vectorCapable?: boolean;
  distanceKm?: number;
}

interface CurrentTimelineDto {
  timeline?: Array<{ time: string; u: number | null; v: number | null }>;
}

/**
 * Client for the signalk-tidal-currents plugin REST API
 * (/signalk/v2/api/currents) — real harmonic current stations with
 * flood/ebb axes. Responses are cached so departure scans reuse fetches.
 */
export class CurrentsClient {
  private baseUrl: string;
  private stationCache = new Map<string, { at: number; data: CurrentStationDto[] }>();
  private timelineCache = new Map<string, { at: number; data: CurrentTimelineDto }>();
  private static CACHE_TTL_MS = 6 * 3600_000;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private api(path: string): string {
    return `${this.baseUrl}/signalk/v2/api/currents${path}`;
  }

  /** Nearest vector-capable current stations to a position. */
  async findStations(lat: number, lon: number): Promise<CurrentStationDto[]> {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const hit = this.stationCache.get(key);
    if (hit && Date.now() - hit.at < CurrentsClient.CACHE_TTL_MS) return hit.data;
    const resp = await fetch(this.api(`/stations?latitude=${lat}&longitude=${lon}&limit=10`));
    if (!resp.ok) throw new Error(`currents station search failed (${resp.status})`);
    const raw = (await resp.json()) as CurrentStationDto[];
    const data = (Array.isArray(raw) ? raw : []).filter((s) => s.vectorCapable);
    pruneCache(this.stationCache, CurrentsClient.CACHE_TTL_MS);
    this.stationCache.set(key, { at: Date.now(), data });
    return data;
  }

  async fetchTimeline(stationId: string, startMs: number, endMs: number): Promise<CurrentTimelineDto> {
    const HOUR = 3600_000;
    const s = Math.floor(startMs / HOUR) * HOUR;
    const e = Math.ceil(endMs / HOUR) * HOUR;
    const key = `${stationId}|${s}|${e}`;
    const hit = this.timelineCache.get(key);
    if (hit && Date.now() - hit.at < CurrentsClient.CACHE_TTL_MS) return hit.data;
    const url = this.api(
      `/stations/${stationId}/timeline` +
      `?start=${encodeURIComponent(new Date(s).toISOString())}` +
      `&end=${encodeURIComponent(new Date(e).toISOString())}&step=10`,
    );
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`currents timeline failed for ${stationId} (${resp.status})`);
    const data = (await resp.json()) as CurrentTimelineDto;
    pruneCache(this.timelineCache, CurrentsClient.CACHE_TTL_MS);
    this.timelineCache.set(key, { at: Date.now(), data });
    return data;
  }

  async probe(lat: number, lon: number): Promise<boolean> {
    try {
      return (await this.findStations(lat, lon)).length > 0;
    } catch {
      return false;
    }
  }
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
 * within range, linear time interpolation. Positions out of range fall back
 * to the (estimated) height-gradient field when one is available.
 */
class StationFlowField implements FlowField {
  readonly maxSpeedMs: number;
  readonly stations: TideStationInfo[];
  readonly estimated: boolean;
  readonly source = 'stations' as const;

  constructor(
    private series: StationSeries[],
    private fallback: FlowField | null,
  ) {
    let max = fallback?.maxSpeedMs ?? 0;
    for (const s of series) {
      for (let i = 0; i < s.u.length; i++) {
        max = Math.max(max, Math.hypot(s.u[i], s.v[i]));
      }
    }
    this.maxSpeedMs = max;
    this.stations = [
      ...series.map((s) => s.info),
      ...(fallback ? fallback.stations : []),
    ];
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
    if (!best) {
      return this.fallback ? this.fallback.sample(lat, lon, timeMs) : { u: 0, v: 0 };
    }
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
 * miss mid-route stations), prefetches their set/drift timelines, and wires
 * the height-gradient field in as the out-of-range fallback.
 * Returns null when no vector-capable station is anywhere near the route.
 */
export async function prepareStationFlowField(
  client: CurrentsClient,
  anchors: Array<{ latitude: number; longitude: number }>,
  startMs: number,
  endMs: number,
  fallback: FlowField | null,
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
    const byId = new Map<string, CurrentStationDto>();
    for (const p of points) {
      for (const s of await client.findStations(p.latitude, p.longitude)) {
        byId.set(s.id, s);
      }
    }
    if (byId.size === 0) return null;

    const padMs = 3600_000;
    const results = await Promise.allSettled(
      [...byId.values()].map(async (st): Promise<StationSeries> => {
        const data = await client.fetchTimeline(st.id, startMs - padMs, endMs + padMs);
        const tl = (data.timeline ?? []).filter((e) => e.u !== null && e.v !== null);
        if (tl.length < 3) throw new Error('empty timeline');
        const t0 = Date.parse(tl[0].time);
        const stepMs = Date.parse(tl[1].time) - t0;
        return {
          info: { id: st.id, name: st.name, latitude: st.latitude, longitude: st.longitude },
          startMs: t0,
          stepMs,
          u: tl.map((e) => e.u as number),
          v: tl.map((e) => e.v as number),
        };
      }),
    );
    const series = results
      .filter((r): r is PromiseFulfilledResult<StationSeries> => r.status === 'fulfilled')
      .map((r) => r.value);
    if (series.length === 0) return null;
    return new StationFlowField(series, fallback);
  } catch (e) {
    console.warn(`[routeiq] station flow field unavailable: ${e}`);
    return null;
  }
}

/**
 * Prepare a tidal flow field covering a route request: find stations around
 * the request area, prefetch their height timelines for the travel window,
 * and return a synchronously sampleable field. Returns null when tides are
 * unavailable (plugin missing, no stations, fetch failures).
 */
export async function prepareTidalFlowField(
  client: TidesClient,
  points: Array<{ latitude: number; longitude: number }>,
  startMs: number,
  endMs: number,
  maxCurrentKnots: number,
): Promise<FlowField | null> {
  try {
    // Union of nearest stations at each anchor point (start / via / end).
    const byId = new Map<string, TideStationInfo>();
    for (const p of points) {
      for (const s of await client.findStations(p.latitude, p.longitude)) {
        byId.set(s.id, s);
      }
    }
    if (byId.size === 0) return null;

    const timelines: StationTimeline[] = [];
    // Pad the window so mid-route sampling and dh/dt differencing stay inside.
    const padMs = 3600_000;
    const results = await Promise.allSettled(
      [...byId.values()].map(async (station) => {
        const data = await client.fetchTimeline(station.id, startMs - padMs, endMs + padMs);
        const tl = data.timeline;
        if (!tl || tl.length < 3) throw new Error('empty timeline');
        const t0 = Date.parse(tl[0].time);
        const stepMs = Date.parse(tl[1].time) - t0;
        const levels = tl.map((e) => e.level);
        let maxAbsDhDt = 0;
        for (let i = 1; i < levels.length; i++) {
          maxAbsDhDt = Math.max(maxAbsDhDt, Math.abs(levels[i] - levels[i - 1]) / (stepMs / 1000));
        }
        return { station, startMs: t0, stepMs, levels, maxAbsDhDt } as StationTimeline;
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') timelines.push(r.value);
    }
    if (timelines.length === 0) return null;

    return new HeightGradientFlowField(timelines, maxCurrentKnots);
  } catch (e) {
    console.warn(`[routeiq] tidal flow field unavailable: ${e}`);
    return null;
  }
}
