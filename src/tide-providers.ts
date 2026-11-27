/**
 * Signal K implementations of the routeiq-core tide providers:
 *
 * - signalk-tidal-currents (/signalk/v2/api/currents): harmonic current
 *   stations with set/drift (CurrentsClient).
 * - signalk-tides (https://github.com/openwatersio/signalk-tides,
 *   /signalk/v2/api/tides): tide-height predictions (TidesClient).
 *
 * Both reach the plugin with the caller's login (see server-access.ts), so
 * their caches are kept per login.
 */

import type {
  CurrentProvider,
  CurrentStationDto,
  CurrentTimelineDto,
  TideHeightProvider,
  TideStationInfo,
  TideTimelineDto,
} from "routeiq-core";
import {
  callerKey,
  CurrentsApiHandle,
  GetJson,
  loopbackGetJson,
  TideSource,
} from "./server-access.js";

/** Hard cap on cache entries per Map — a backstop behind TTL pruning so a
 *  vessel wandering through many coordinate buckets can't grow these maps
 *  unbounded even within the TTL window. */
const CACHE_MAX_ENTRIES = 500;

/** Delete expired entries (age >= ttlMs) from `map`, then, if it's still
 *  over `CACHE_MAX_ENTRIES`, evict the oldest entries (smallest `at`) until
 *  it's under the cap. Call before every cache `.set(...)`. */
function pruneCache<T>(
  map: Map<string, { at: number; data: T }>,
  ttlMs: number,
): void {
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
 * Reached over HTTP on this server (signalk-tides offers nothing in-process),
 * with the caller's login — see server-access.ts. Cache entries are kept per
 * login, so one caller's answer is never served to another.
 */
export class TidesClient implements TideHeightProvider {
  private baseUrl: string;
  private source: TideSource;
  private stationCache = new Map<
    string,
    { at: number; data: TideStationInfo[] }
  >();
  private timelineCache = new Map<
    string,
    { at: number; data: TideTimelineDto }
  >();
  private static CACHE_TTL_MS = 6 * 3600_000;

  constructor(
    baseUrl: string,
    getJson: GetJson = loopbackGetJson,
    source?: TideSource,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.source =
      source ?? new TideSource("signalk-tides", this.baseUrl, getJson);
  }

  private api(path: string): string {
    return `${this.baseUrl}/signalk/v2/api/tides${path}`;
  }

  private get(url: string, what: string): Promise<unknown> {
    return this.source.get(url, what);
  }

  /** Nearest stations (the API returns up to 10, closest first). */
  async findStations(lat: number, lon: number): Promise<TideStationInfo[]> {
    const key = `${callerKey()}|${lat.toFixed(1)},${lon.toFixed(1)}`;
    const hit = this.stationCache.get(key);
    if (hit && Date.now() - hit.at < TidesClient.CACHE_TTL_MS) return hit.data;

    const raw = (await this.get(
      this.api(`/stations?latitude=${lat}&longitude=${lon}`),
      "tides station search",
    )) as Array<Record<string, unknown>>;
    const data = (Array.isArray(raw) ? raw : [])
      .filter(
        (s) =>
          typeof s.latitude === "number" && typeof s.longitude === "number",
      )
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
  async fetchTimeline(
    stationId: string,
    startMs: number,
    endMs: number,
  ): Promise<TideTimelineDto> {
    // Round the window outward to whole hours so scan steps share cache entries.
    const HOUR = 3600_000;
    const s = Math.floor(startMs / HOUR) * HOUR;
    const e = Math.ceil(endMs / HOUR) * HOUR;
    const key = `${callerKey()}|${stationId}|${s}|${e}`;
    const hit = this.timelineCache.get(key);
    if (hit && Date.now() - hit.at < TidesClient.CACHE_TTL_MS) return hit.data;

    const url = this.api(
      `/stations/${stationId}/timeline` +
        `?start=${encodeURIComponent(new Date(s).toISOString())}` +
        `&end=${encodeURIComponent(new Date(e).toISOString())}`,
    );
    const data = (await this.get(
      url,
      `tides timeline for ${stationId}`,
    )) as TideTimelineDto;
    pruneCache(this.timelineCache, TidesClient.CACHE_TTL_MS);
    this.timelineCache.set(key, { at: Date.now(), data });
    return data;
  }

  /** Availability probe: plugin reachable and knows stations near (lat, lon). */
  async probe(
    lat: number,
    lon: number,
  ): Promise<{ available: boolean; stations: TideStationInfo[] }> {
    try {
      const stations = await this.findStations(lat, lon);
      return { available: stations.length > 0, stations };
    } catch {
      return { available: false, stations: [] };
    }
  }
}

/**
 * Client for the signalk-tidal-currents plugin — real harmonic current
 * stations with flood/ebb axes. Calls the plugin in-process through its
 * `currentsApi` handle when it has emitted one, else its REST API
 * (/signalk/v2/api/currents) on this server with the caller's login — see
 * server-access.ts. Responses are cached so departure scans reuse fetches;
 * those fetched over HTTP per login, so one caller's answer is never served
 * to another (the in-process answers need no login and are shared).
 */
/** A stable number per in-process handle, for cache keys. */
const handleIds = new WeakMap<CurrentsApiHandle, number>();
let nextHandleId = 1;

export class CurrentsClient implements CurrentProvider {
  private baseUrl: string;
  private source: TideSource;
  private handle: () => CurrentsApiHandle | null;
  private stationCache = new Map<
    string,
    { at: number; data: CurrentStationDto[] }
  >();
  private timelineCache = new Map<
    string,
    { at: number; data: CurrentTimelineDto }
  >();
  private static CACHE_TTL_MS = 6 * 3600_000;

  constructor(
    baseUrl: string,
    handle: () => CurrentsApiHandle | null = () => null,
    getJson: GetJson = loopbackGetJson,
    source?: TideSource,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.handle = handle;
    this.source =
      source ?? new TideSource("signalk-tidal-currents", this.baseUrl, getJson);
  }

  private api(path: string): string {
    return `${this.baseUrl}/signalk/v2/api/currents${path}`;
  }

  private get(url: string, what: string): Promise<unknown> {
    return this.source.get(url, what);
  }

  /** Cache-key prefix: the login for HTTP answers; in-process, the handle
   *  itself, so a handle the provider replaced (after its restart, say) never
   *  serves its predecessor's answers. */
  private keyPrefix(handle: CurrentsApiHandle | null): string {
    if (!handle) return `http:${callerKey()}`;
    let id = handleIds.get(handle);
    if (id === undefined) handleIds.set(handle, (id = nextHandleId++));
    return `ip${id}`;
  }

  /** Nearest vector-capable current stations to a position. */
  async findStations(lat: number, lon: number): Promise<CurrentStationDto[]> {
    const handle = this.handle();
    const key = `${this.keyPrefix(handle)}|${lat.toFixed(1)},${lon.toFixed(1)}`;
    const hit = this.stationCache.get(key);
    if (hit && Date.now() - hit.at < CurrentsClient.CACHE_TTL_MS)
      return hit.data;
    const raw = (
      handle
        ? await this.source.call("currents station search", () =>
            handle.findStations(lat, lon, 10),
          )
        : await this.get(
            this.api(`/stations?latitude=${lat}&longitude=${lon}&limit=10`),
            "currents station search",
          )
    ) as CurrentStationDto[];
    const data = (Array.isArray(raw) ? raw : []).filter((s) => s.vectorCapable);
    pruneCache(this.stationCache, CurrentsClient.CACHE_TTL_MS);
    this.stationCache.set(key, { at: Date.now(), data });
    return data;
  }

  async fetchTimeline(
    stationId: string,
    startMs: number,
    endMs: number,
  ): Promise<CurrentTimelineDto> {
    const HOUR = 3600_000;
    const s = Math.floor(startMs / HOUR) * HOUR;
    const e = Math.ceil(endMs / HOUR) * HOUR;
    const handle = this.handle();
    const key = `${this.keyPrefix(handle)}|${stationId}|${s}|${e}`;
    const hit = this.timelineCache.get(key);
    if (hit && Date.now() - hit.at < CurrentsClient.CACHE_TTL_MS)
      return hit.data;
    const startIso = new Date(s).toISOString();
    const endIso = new Date(e).toISOString();
    const data = (
      handle
        ? await this.source.call(`currents timeline for ${stationId}`, () =>
            handle.getTimeline(stationId, startIso, endIso, 10),
          )
        : await this.get(
            this.api(
              `/stations/${stationId}/timeline` +
                `?start=${encodeURIComponent(startIso)}` +
                `&end=${encodeURIComponent(endIso)}&step=10`,
            ),
            `currents timeline for ${stationId}`,
          )
    ) as CurrentTimelineDto;
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
