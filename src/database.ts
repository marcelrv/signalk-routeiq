import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { BBox, PoiResult } from './types.js';
import * as Navmesh from './navmesh.js';

// Node type constants (encoded in the node ID via coordinate hashing)
export const NODE_TYPE_COASTAL = 0;
export const NODE_TYPE_INLAND = 1;

/** Extract node type integer from a type-packed node ID. */
export function getNodeTypeInt(id: number): number {
  return Math.floor(id / 648000000000000);
}

// Edge type constants
export const EDGE_TYPE_COASTAL = 0;
export const EDGE_TYPE_INLAND = 1;

// POI type constants
export const POI_TYPE_HARBOUR = 0;
export const POI_TYPE_LOCK = 1;
export const POI_TYPE_BRIDGE = 2;
export const POI_TYPE_FAIRWAY = 3;
export const POI_TYPE_WATERWAY = 4;

// Traffic mode: 0=two-way, 1=one-way fwd (source->target), 2=one-way rev
export const TRAFFIC_TWO_WAY = 0;
export const TRAFFIC_ONE_WAY_FWD = 1;
export const TRAFFIC_ONE_WAY_REV = 2;

// Edge kind: 0=centerline (default), 1=navmesh boundary (fallback/funnel-augmented),
// 2=lane, 3=macro (spec §2.5)
export const EDGE_KIND_CENTERLINE = 0;
export const EDGE_KIND_NAVMESH_BOUNDARY = 1;
export const EDGE_KIND_LANE = 2;
export const EDGE_KIND_MACRO = 3;

export interface EdgeRow {
  source: number;
  target: number;
  distance: number;
  min_depth: number;
  max_air_draft: number;
  min_width: number;
  cost_factor: number;
  distance_to_land: number;
  edge_type_id: number;
  traffic_mode: number;
  edge_kind_id?: number;
  crosses_land?: number;
  crosses_obstacle?: number;
  // No coordinates here by design: an edge's endpoints are always resolvable
  // from `this.nodes` via `source`/`target`, and every edge in edgesBySource
  // is guaranteed to have both endpoints present (the loaders skip edges
  // whose endpoints are missing; deleteNode/unloadDatabaseGraph sweep edges
  // whose endpoints go away). Caching lat/lon/source_lat/source_lon on the
  // row cost ~100 bytes/edge in separate V8 heap numbers — ~25 MB per 270k
  // edge region, several of which can be loaded at once.
  /** Intermediate [lat,lon] points of a funnel-computed navmesh path along this
   *  edge (set only when this edge_kind_id=1 edge was upgraded from a straight
   *  fallback chord to a real taut path by precomputeFunnelEdges). */
  path_points?: Array<[number, number]>;
  /** Worker handle index this edge came from (-1 = overlay), or the dbIndex
   *  of the navmesh region that produced it when it's a synthetic
   *  funnel/anchor-shortcut edge (see addFunnelShortcutEdge). Only
   *  meaningful in dynamic-loading mode, where unloadDatabaseGraph uses it
   *  to remove exactly one database's edges (real and synthetic) without
   *  touching any other loaded database's. */
  dbIndex?: number;
}

interface PoiRow {
  id: number;
  name: string;
  type_id: number;
  properties: string | null;
  lat: number;
  lon: number;
  /** Worker handle index this row was loaded from (-1 = overlay). Only
   *  populated in dynamic-loading mode; used by unloadDatabaseGraph to know
   *  which POIs belong to the database being evicted. */
  dbIndex?: number;
}

/** A navmesh region tagged with the worker dbIndex of the database it was
 *  loaded from, so unloadDatabaseGraph can drop exactly the regions (and,
 *  via addFunnelShortcutEdge, the synthetic funnel/anchor edges) that came
 *  from an evicted database. Non-dynamic mode also tags regions this way
 *  (harmless — dbIndex is simply never used for eviction there). */
type NavmeshRegionWithDb = Navmesh.NavmeshRegion & { dbIndex: number };

/** Coverage/state entry for one locally-discovered .sqlite file — the
 *  backing store for getCoverageStatus() and getDatabaseCatalog() (the
 *  latter backing GET .../databases) in both dynamic and non-dynamic mode
 *  (§4a task 1/5). Built by peekMetadata in dynamic mode before anything
 *  loads; derived from the bulk load's metadata in non-dynamic mode, where
 *  every file is always 'loaded'. */
export interface DatabaseCoverageEntry {
  filename: string;
  path: string;
  /** Parsed metadata.bounding_box JSON — kept in the same
   *  {min_lat,min_lon,max_lat,max_lon} shape getDatabaseCatalog() already
   *  exposes elsewhere in this file's public API, rather than converted to
   *  camelCase. */
  bbox: { min_lat: number; min_lon: number; max_lat: number; max_lon: number } | null;
  boundary: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  state: 'not_loaded' | 'loading' | 'loaded';
  /** Worker-side handle index once loaded; null while not_loaded. */
  dbIndex: number | null;
  meta: {
    id: number; country: string; name: string; description: string | null;
    lastUpdateDate: string; tags: string | null; boundingBox: string | null;
    boundaryGeometry: string | null; schemaVersion: number | null;
    contributor: string | null; url: string | null; filename: string;
  } | null;
  /** Row counts read directly off the file (peekMetadata's short-lived
   *  handle in dynamic mode; getMetadata()'s bulk-load round-trip in
   *  non-dynamic mode) -- available regardless of load state, unlike the
   *  in-memory graph, so a not-yet-loaded database can still report the
   *  same stats a loaded one shows. */
  stats: { nodes: number; edges: number; pois: number } | null;
}

export interface EdgeSnapResult {
  source: number;
  target: number;
  fraction: number;
  point: { lat: number; lon: number };
  distance: number;
  nearNode: number;
  farNode: number;
  edge: EdgeRow;
}

export class RoutingDatabase {
  private worker: Worker | null = null;
  private messageIdCounter = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>();
  private dbDir: string;
  private nodes: Map<number, { lat: number; lon: number; regionId: number; nodeDepth: number }> = new Map();
  private edgesBySource: Map<number, Array<EdgeRow>> = new Map();
  private pois: PoiRow[] = [];
  private navmeshRegions: NavmeshRegionWithDb[] = [];
  private spatialGrid: Map<string, number[]> = new Map();

  /** Lazy cache of `this.pois` bucketed into the same 0.01° grid cells as
   *  spatialGrid (see buildPoiGrid) — null whenever it may be stale, built
   *  on first use afterward. Backs getPoisInBBox/getNearestPoi so a map pan
   *  no longer linearly scans every loaded POI. Every build is from scratch
   *  over the current `this.pois`, so a rebuilt cache is always correct —
   *  correctness never depends on incrementally patching it. */
  private poiGrid: Map<string, PoiRow[]> | null = null;

  /** Lazy cache of edgesBySource's edges bucketed into the same 0.01° grid
   *  cells, each edge registered under BOTH its source-endpoint cell and its
   *  target-endpoint cell (see buildEdgeGrid) — necessary because a long
   *  (e.g. macro/anchor-shortcut) edge's two endpoints can fall in cells far
   *  apart, and a bbox query must find the edge from whichever endpoint (or
   *  neither, if only the middle crosses the box — same limitation the old
   *  full scan had, since path_points were never tested either). Null
   *  whenever it may be stale; rebuilt from scratch on next use, same
   *  correctness argument as poiGrid. Backs getEdgesInBBox. */
  private edgeGrid: Map<string, Array<EdgeRow>> | null = null;

  private hasCrossesLand: boolean = false;
  private hasCrossesObstacle: boolean = false;
  private hasNodeDepth: boolean = false;
  private hasRegionId: boolean = false;

  /** Non-dynamic bulk-load mode only: the worker-reported filename (falling
   *  back to the path's basename) for each dbPaths entry, in the same order
   *  init() opened them — the bridge rebuildCoverageIndexAfterBulkLoad()
   *  uses at the end of loadGraph() to assign the same `dbIndex` a plain
   *  positional index would have given (dbPaths[i] -> dbIndex i), without
   *  a separate cachedDatabaseList catalog. Not read by anything else. */
  private bulkFileList: Array<{ filename: string; path: string }> = [];

  /** True once loadGraph() completes successfully (in dynamic mode, once
   *  init()'s peek completes — see loadGraph()'s no-op branch). */
  private graphLoaded: boolean = false;

  /** §4a: when false (default), behavior is byte-for-byte identical to
   *  every deployment before this feature existed — init()/loadGraph() open
   *  and load every .sqlite in the data directory up front, same as always.
   *  When true, init() only peeks metadata/coverage and loadGraph() is a
   *  no-op; individual databases load on demand via loadDatabaseGraph(),
   *  triggered by ensureRegionsLoaded() or the /databases/load endpoint. */
  private dynamicLoading: boolean;

  /** filename -> coverage/state. Built by peekMetadata in dynamic mode
   *  before anything is opened; derived from the bulk load's metadata in
   *  non-dynamic mode (every file reported 'loaded'). The single
   *  authoritative "installed/loaded databases" catalog — every one of
   *  getDatabaseCatalog(), getLoadingStatus(), and getCoverageStatus()
   *  (backing GET .../databases, .../databases/status, and the `databases`
   *  field of the /databases/load and /databases/unload POST responses,
   *  respectively) derives its answer from this map alone, so they can
   *  never drift out of sync with each other. */
  private coverageIndex: Map<string, DatabaseCoverageEntry> = new Map();

  /** dbIndex -> node ids that database contributed to `nodes`, so
   *  unloadDatabaseGraph knows which ids to consider removing. Only
   *  populated by the per-file dynamic loader (loadDatabaseGraph). */
  private nodesByDbIndex: Map<number, Set<number>> = new Map();

  /** node id -> number of currently-loaded databases containing it.
   *  Coordinate-hash collisions at region seams mean a node id is not
   *  always unique to one database (PHASE_4_DESIGN.md §4a.1) — a node is
   *  only actually removed from `nodes` once this refcount reaches zero. */
  private nodeDbCount: Map<number, number> = new Map();

  /** True once the user-edits overlay's own added nodes/edges rows have
   *  been merged into memory at least once. In dynamic mode, every
   *  subsequent per-file load passes includeOverlay=false to db-worker so
   *  those rows are never merged a second time (which would duplicate them
   *  in edgesBySource). Reset only by close()/reload(). */
  private overlayMergedOnce: boolean = false;

  /** In-flight loadDatabaseGraph() calls keyed by filename, so concurrent
   *  callers racing to trigger the same on-demand load (e.g. two route
   *  requests landing in the same not-yet-loaded region) await the same
   *  load instead of double-loading it. */
  private loadingPromises: Map<string, Promise<void>> = new Map();

  /** Routes currently executing (see RoutingEngine.calculateRoute's
   *  beginRoute/endRoute wrapper) — unloadDatabaseGraph refuses while this
   *  is > 0, a simple guard against evicting a database's graph data out
   *  from under an in-progress search (PHASE_4_DESIGN.md §4a task 2). */
  private activeRouteCount: number = 0;

  /** §4a M5: bounded working-set cap. 0 (default) = unlimited, byte-for-byte
   *  today's behavior — enforceRegionCap() no-ops. >0 = keep at most this
   *  many databases in the 'loaded' state, evicting least-recently-used ones
   *  (see regionLastUsedAt) once no route is in flight. Only meaningful when
   *  dynamicLoading is also true. */
  private maxLoadedRegions: number;

  /** filename -> monotonic "last used" counter, driving LRU eviction in
   *  enforceRegionCap(). Bumped every time a region is loaded or found
   *  relevant to a route/position request (loadDatabaseGraphInner on
   *  success, and by ensureRegionsLoaded/ensureRegionsForBbox/
   *  eagerLoadForPosition for every region they touch — including ones
   *  already loaded — so an actively-used region is never the eviction
   *  candidate). A monotonic counter rather than Date.now() avoids clock-tie
   *  ambiguity between two regions touched in the same millisecond. Only
   *  ever consulted when maxLoadedRegions > 0. */
  private regionLastUsedAt: Map<string, number> = new Map();

  /** Source of the monotonic values in regionLastUsedAt. */
  private lruCounter: number = 0;

  constructor(dbDir: string, dynamicLoading: boolean = false, maxLoadedRegions: number = 0) {
    this.dbDir = dbDir;
    this.dynamicLoading = dynamicLoading;
    this.maxLoadedRegions = maxLoadedRegions;
  }

  /** Bump filename's LRU recency to "most recently used". See
   *  regionLastUsedAt. */
  private touchRegion(filename: string): void {
    this.regionLastUsedAt.set(filename, ++this.lruCounter);
  }

  isDynamicLoadingEnabled(): boolean {
    return this.dynamicLoading;
  }

  /** See activeRouteCount. Called by RoutingEngine.calculateRoute. */
  beginRoute(): void {
    this.activeRouteCount++;
  }

  endRoute(): void {
    if (this.activeRouteCount > 0) this.activeRouteCount--;
    if (this.activeRouteCount === 0) {
      // §4a M5: trim the working set now that no route is in flight. Fire-
      // and-forget — endRoute is sync and callers don't need to wait for
      // eviction. enforceRegionCap() re-checks activeRouteCount === 0 (and
      // unloadDatabaseGraph guards on it too), so a new route beginning
      // before this settles just makes enforcement a no-op, never unsafe.
      void this.enforceRegionCap().catch(() => {});
    }
  }

  /** Test seam only: enforceRegionCap() runs fire-and-forget off endRoute()
   *  so production code never awaits it; tests that need a deterministic
   *  point to assert post-eviction state can await this instead of racing
   *  the background pass. Behaves identically to what endRoute() triggers. */
  async enforceRegionCapForTest(): Promise<void> {
    await this.enforceRegionCap();
  }

  /** Basenames of every currently-loaded (state === 'loaded') database,
   *  derived from coverageIndex in that map's iteration (insertion) order —
   *  replaces what used to be a separately hand-synced loadedDbFilenames
   *  array. Backing data for getLoadingStatus().filenames. */
  private loadedFilenames(): string[] {
    const result: string[] = [];
    for (const entry of this.coverageIndex.values()) {
      if (entry.state === 'loaded') result.push(entry.filename);
    }
    return result;
  }

  private sendMessage(type: string, payload?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.messageIdCounter;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, type, payload });
    });
  }

  async init(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.dbDir).filter(f => f.endsWith('.sqlite') && f !== 'user-edits.sqlite');
    } catch (err: any) {
      throw new Error(`Cannot read routing data directory "${this.dbDir}": ${err.message}`);
    }
    if (files.length === 0) {
      throw new Error(`No .sqlite files found in routing data directory: ${this.dbDir}`);
    }

    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'db-worker.js');
    this.worker = new Worker(workerPath);

    this.worker.on('message', (msg: { id: number; type: string; result?: any; error?: string; chunk?: boolean; chunkIndex?: number; totalChunks?: number }) => {
      const pending = this.pending.get(msg.id);
      if (!pending) return;

      if (msg.error) {
        this.pending.delete(msg.id);
        pending.reject(new Error(msg.error));
        return;
      }

      // Edge-loading chunked response
      if (msg.chunk === true && msg.totalChunks !== undefined) {
        // Initialize accumulator on first chunk
        if (!(pending as any)._chunks) {
          (pending as any)._chunks = [];
        }
        (pending as any)._chunks.push(msg.result);
        // Resolve when all chunks arrive
        if ((pending as any)._chunks.length === msg.totalChunks) {
          this.pending.delete(msg.id);
          pending.resolve((pending as any)._chunks.flat());
        }
        return;
      }
      // Final marker (chunk=false) — normally already resolved by the last
      // chunk above. Exception: zero rows means the worker's chunk loop never
      // ran and this marker is the *only* message sent — resolve here with an
      // empty array, or this promise (and loadGraph() with it) hangs forever.
      if (msg.chunk === false) {
        if (!(pending as any)._chunks) {
          this.pending.delete(msg.id);
          pending.resolve([]);
        }
        return;
      }

      this.pending.delete(msg.id);
      pending.resolve(msg.result);
    });

    this.worker.on('error', (err) => {
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });

    const dbPaths = files.map(f => join(this.dbDir, f));

    if (!this.dynamicLoading) {
      // Legacy path (dynamicLoading explicitly set to false): open every
      // handle up front and load everything in loadGraph(). No longer the
      // default (flipped 2026-07-20, see types.ts) — kept for deployments
      // that genuinely have one region file and want today's simpler
      // eager-load behavior instead of the on-demand path.
      const schema = await this.sendMessage('init', { dbPaths });
      this.hasCrossesLand = schema.hasCrossesLand;
      this.hasCrossesObstacle = schema.hasCrossesObstacle;
      this.hasNodeDepth = schema.hasNodeDepth;
      this.hasRegionId = schema.hasRegionId;
      const filenames: string[] = schema.filenames || [];
      this.bulkFileList = dbPaths.map((p, i) => ({
        filename: filenames[i] || p.split('/').pop() || '',
        path: p,
      }));
    } else {
      // Dynamic loading: peek every file's metadata/coverage/schema-flags
      // without opening a lasting handle for any of them (§4a task 1). Real
      // graph data loads later, on demand — see loadDatabaseGraph() and
      // ensureRegionsLoaded().
      const peeked: Array<{
        path: string; filename: string;
        coverage: { boundingBox: DatabaseCoverageEntry['bbox']; boundaryGeometry: DatabaseCoverageEntry['boundary'] };
        meta: DatabaseCoverageEntry['meta'];
        flags: { hasCrossesLand: boolean; hasCrossesObstacle: boolean; hasNodeDepth: boolean; hasRegionId: boolean; hasEdgeKind: boolean };
        stats: DatabaseCoverageEntry['stats'];
      }> = await this.sendMessage('peekMetadata', { dbPaths });

      this.coverageIndex.clear();
      for (const p of peeked) {
        this.hasCrossesLand = this.hasCrossesLand || p.flags.hasCrossesLand;
        this.hasCrossesObstacle = this.hasCrossesObstacle || p.flags.hasCrossesObstacle;
        this.hasNodeDepth = this.hasNodeDepth || p.flags.hasNodeDepth;
        this.hasRegionId = this.hasRegionId || p.flags.hasRegionId;
        this.coverageIndex.set(p.filename, {
          filename: p.filename,
          path: p.path,
          bbox: p.coverage.boundingBox ?? null,
          boundary: p.coverage.boundaryGeometry ?? null,
          state: 'not_loaded',
          dbIndex: null,
          meta: p.meta,
          stats: p.stats ?? null,
        });
      }
      console.log(`[routeiq] Dynamic loading enabled: peeked ${peeked.length} database(s) in ${this.dbDir}, none loaded yet`);
    }

    // Open overlay (user-edits.sqlite) — created if not exists
    const overlayPath = join(this.dbDir, 'user-edits.sqlite');
    await this.sendMessage('openOverlay', { overlayPath });
    console.log(`[routeiq] User-edits overlay ready: ${overlayPath}`);
  }

  private regionIdCol(): string {
    return this.hasRegionId ? 'region_id' : '0 AS region_id';
  }

  async getMetadata(): Promise<Array<{
    id: number; country: string; name: string; description: string | null;
    lastUpdateDate: string; tags: string | null; boundingBox: string | null;
    boundaryGeometry: string | null; schemaVersion: number | null;
    contributor: string | null; url: string | null; filename: string;
    stats: { nodes: number; edges: number; pois: number };
  }>> {
    return this.sendMessage('getMetadata');
  }

  /** Backing data for GET .../databases — one record per entry in
   *  coverageIndex, i.e. every installed database in every state (not just
   *  currently-loaded ones), each record the union of what the old
   *  getDatabaseInfo() (rich metadata, loaded-only) and getCoverageStatus()
   *  (state/coverage, all installed) used to return separately. `state`,
   *  `coverage` (= entry.bbox), `dbIndex`, and `stats` always come from the
   *  entry itself; the descriptive fields come from entry.meta using the
   *  same JSON-parsing/null-handling getDatabaseInfo() used to apply
   *  (tags/boundingBox/boundaryGeometry parsed from JSON strings). Unlike
   *  the old loaded-only getDatabaseInfo(), a null entry.meta (e.g. a
   *  legacy database with no metadata table) no longer drops the record —
   *  the entry-derived fields are still emitted, with the meta-derived
   *  fields defaulted to null/empty so the database still appears in the
   *  catalog. `boundingBox` carries the same bbox shape as `coverage`; both
   *  keys are included so the frontend needs no field renames. */
  async getDatabaseCatalog(): Promise<Array<{
    filename: string; state: 'not_loaded' | 'loading' | 'loaded';
    coverage: DatabaseCoverageEntry['bbox']; dbIndex: number | null;
    stats: DatabaseCoverageEntry['stats'];
    id: number | null; country: string | null; name: string | null; description: string | null;
    lastUpdateDate: string | null; tags: string[];
    boundingBox: { min_lat: number; min_lon: number; max_lat: number; max_lon: number } | null;
    boundaryGeometry: any | null; schemaVersion: number | null;
    contributor: string | null; url: string | null;
  }>> {
    const result: Array<{
      filename: string; state: 'not_loaded' | 'loading' | 'loaded';
      coverage: DatabaseCoverageEntry['bbox']; dbIndex: number | null;
      stats: DatabaseCoverageEntry['stats'];
      id: number | null; country: string | null; name: string | null; description: string | null;
      lastUpdateDate: string | null; tags: string[];
      boundingBox: { min_lat: number; min_lon: number; max_lat: number; max_lon: number } | null;
      boundaryGeometry: any | null; schemaVersion: number | null;
      contributor: string | null; url: string | null;
    }> = [];
    for (const entry of this.coverageIndex.values()) {
      const m = entry.meta;
      result.push({
        filename: entry.filename,
        state: entry.state,
        coverage: entry.bbox,
        dbIndex: entry.dbIndex,
        stats: entry.stats,
        id: m ? m.id : null,
        country: m ? m.country : null,
        name: m ? m.name : null,
        description: m ? m.description : null,
        lastUpdateDate: m ? m.lastUpdateDate : null,
        tags: m && m.tags ? JSON.parse(m.tags) : [],
        boundingBox: m && m.boundingBox ? JSON.parse(m.boundingBox) : null,
        boundaryGeometry: m && m.boundaryGeometry ? JSON.parse(m.boundaryGeometry) : null,
        schemaVersion: m ? m.schemaVersion : null,
        contributor: m ? m.contributor : null,
        url: m ? m.url : null,
      });
    }
    return result;
  }

  /** Return loading status info. `available` is the number of installed
   *  databases known to the plugin (peeked in dynamic mode, all loaded in
   *  non-dynamic mode) — lets the UI distinguish "nothing installed" from
   *  "installed but none loaded yet under dynamic loading". */
  getLoadingStatus(): { loaded: boolean; filenames: string[]; available: number } {
    return {
      loaded: this.graphLoaded,
      filenames: this.loadedFilenames(),
      available: this.coverageIndex.size,
    };
  }

  /**
   * Re-scan the data directory for .sqlite files and merge fresh metadata
   * into coverageIndex — the single catalog every GET .../databases* route
   * reads from. Used after downloading a new database to show it in the
   * installed list without restart. Unlike a bulk rebuild, this preserves
   * the state/dbIndex of any database that's currently 'loading' or
   * 'loaded' (this method never touches actual graph data — only
   * coverageIndex's descriptive fields), and drops only the 'not_loaded'
   * entries for files no longer found on disk.
   */
  async reloadMetadata(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.dbDir).filter(f => f.endsWith('.sqlite') && f !== 'user-edits.sqlite');
    } catch {
      return;
    }
    if (files.length === 0) {
      this.mergeMetadataIntoCoverageIndex([]);
      return;
    }

    const dbPaths = files.map(f => join(this.dbDir, f));

    try {
      // Reuse the existing main worker's peekMetadata support instead of
      // spinning up a second Worker: it opens each file on a short-lived
      // handle just long enough to read metadata/coverage/stats and closes
      // it again, without touching `handles` — so a metadata refresh can
      // never disturb any database this worker already has loaded (unlike
      // `init`, which would reset `handles` and drop them).
      const peeked: Array<{
        path: string; filename: string;
        coverage: { boundingBox: DatabaseCoverageEntry['bbox']; boundaryGeometry: DatabaseCoverageEntry['boundary'] };
        meta: DatabaseCoverageEntry['meta'];
        stats: DatabaseCoverageEntry['stats'];
      }> = await this.sendMessage('peekMetadata', { dbPaths });

      this.mergeMetadataIntoCoverageIndex(peeked);
    } catch (err) {
      console.warn(`[routeiq] reloadMetadata: peekMetadata failed, coverage index left unchanged: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Shared by reloadMetadata() (and conceptually the same shape
   *  init()'s dynamic-mode peek loop builds for the initial boot-time peek):
   *  merge a fresh peekMetadata array into coverageIndex, keyed by filename.
   *  Preserves each existing entry's `state`/`dbIndex` (a metadata refresh
   *  never itself loads or unloads a database's graph data) and only adds
   *  brand-new entries as 'not_loaded'. Entries whose filename isn't in
   *  `peeked` and are still 'not_loaded' are dropped (the file is gone from
   *  disk); a 'loading'/'loaded' entry is left alone even if its file
   *  vanished, since this method never touches in-memory graph data. */
  private mergeMetadataIntoCoverageIndex(
    peeked: Array<{
      path: string; filename: string;
      coverage: { boundingBox: DatabaseCoverageEntry['bbox']; boundaryGeometry: DatabaseCoverageEntry['boundary'] };
      meta: DatabaseCoverageEntry['meta'];
      stats: DatabaseCoverageEntry['stats'];
    }>,
  ): void {
    const seen = new Set<string>();
    for (const p of peeked) {
      seen.add(p.filename);
      const existing = this.coverageIndex.get(p.filename);
      this.coverageIndex.set(p.filename, {
        filename: p.filename,
        path: p.path,
        bbox: p.coverage.boundingBox ?? null,
        boundary: p.coverage.boundaryGeometry ?? null,
        state: existing?.state ?? 'not_loaded',
        dbIndex: existing?.dbIndex ?? null,
        meta: p.meta,
        stats: p.stats ?? null,
      });
    }
    for (const [filename, entry] of this.coverageIndex) {
      if (!seen.has(filename) && entry.state === 'not_loaded') {
        this.coverageIndex.delete(filename);
      }
    }
  }

  private crossesLandCol(): string {
    return this.hasCrossesLand ? ', e.crosses_land' : '';
  }

  async loadGraph(): Promise<void> {
    if (this.dynamicLoading) {
      // Dynamic mode never bulk-loads at startup — init()'s peekMetadata
      // already built the coverage index, which is enough to mark the
      // engine ready-for-on-demand. loadDatabaseGraph() (via
      // ensureRegionsLoaded(), called from RoutingEngine.calculateRoute, or
      // the POST /databases/load endpoint) loads a specific region's actual
      // graph data later, the first time it's needed.
      this.graphLoaded = true;
      return;
    }

    const allNodes: Array<{ id: number; lat: number; lon: number; node_depth: number; region_id?: number }> = await this.sendMessage('loadNodes');
    for (const n of allNodes) {
      this.nodes.set(n.id, { lat: n.lat, lon: n.lon, regionId: n.region_id ?? 0, nodeDepth: n.node_depth });
    }

    // Apply overlay deletions — remove nodes/edges the user deleted
    const deletedNodeIds: number[] = await this.sendMessage('getDeletedNodeIds');
    const deletedEdges: Array<{ source: number; target: number }> = await this.sendMessage('getDeletedEdgePairs');

    for (const nid of deletedNodeIds) {
      this.nodes.delete(nid);
    }

    const deletedNodeSet = new Set(deletedNodeIds);
    const deletedEdgeSet = new Set(deletedEdges.map(d => `${d.source}:${d.target}`));

    const allEdges: Array<EdgeRow> = await this.sendMessage('loadEdges');
    for (const edge of allEdges) {
      // Skip if source or target was deleted
      if (deletedNodeSet.has(edge.source) || deletedNodeSet.has(edge.target)) continue;
      // Skip if this specific edge was deleted
      if (deletedEdgeSet.has(`${edge.source}:${edge.target}`)) continue;
      // Both endpoints must resolve — every consumer looks the edge's
      // coordinates up from `this.nodes`, so an edge with a dangling
      // endpoint has no usable geometry and is dropped here.
      if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) continue;
      if (!this.edgesBySource.has(edge.source)) {
        this.edgesBySource.set(edge.source, []);
      }
      this.edgesBySource.get(edge.source)!.push(edge);
    }

    this.buildSpatialIndex();

    const allPois: Array<{ id: number; name: string; type_id: number; properties: string | null; lat: number; lon: number }> = await this.sendMessage('loadPois');
    this.pois.push(...allPois);

    const metadata = await this.getMetadata();

    const rawRegions: Array<{
      region_id: number; boundary_geometry: string; vertices: string;
      triangles: string; triangle_adjacency: string | null;
      boundary_node_ids: string; depth_ceiling_m: number; db_index?: number;
    }> = await this.sendMessage('loadNavmeshRegions');
    this.navmeshRegions = rawRegions.map(r => ({
      ...Navmesh.buildNavmeshRegion(r, (id) => this.nodes.get(id)),
      dbIndex: r.db_index ?? -1,
    }));
    this.precomputeFunnelEdges();

    this.graphLoaded = true;

    // Populate the coverage index too so GET .../databases reports
    // something sensible in non-dynamic mode as well — every
    // locally-discovered file, all 'loaded' (today's unconditional
    // load-everything behavior, just also exposed through that catalog).
    this.rebuildCoverageIndexAfterBulkLoad(metadata);

    // Bulk load just repopulated `this.pois` and `edgesBySource` (incl. the
    // synthetic funnel/anchor edges precomputeFunnelEdges added above) —
    // any bbox-query cache built against the pre-load (empty) state is
    // stale.
    this.invalidateBBoxCaches();
  }

  /** Non-dynamic-mode counterpart to init()'s peekMetadata coverage-index
   *  build — derives the same DatabaseCoverageEntry shape from the bulk
   *  load's own metadata round-trip (init()'s bulkFileList gives the
   *  filename/path/dbIndex triple in the exact order+index dbPaths were
   *  opened in, so this reproduces the same dbIndex assignment a
   *  cachedDatabaseList array used to), so GET .../databases and
   *  getCoverageStatus() have something to report without changing
   *  anything about the bulk load itself. Never throws — malformed
   *  metadata JSON just leaves that file's coverage fields null, same
   *  tolerance as the rest of this file. */
  private rebuildCoverageIndexAfterBulkLoad(metadata: Array<{
    id: number; country: string; name: string; description: string | null;
    lastUpdateDate: string; tags: string | null; boundingBox: string | null;
    boundaryGeometry: string | null; schemaVersion: number | null;
    contributor: string | null; url: string | null; filename: string;
    stats: { nodes: number; edges: number; pois: number };
  }>): void {
    this.coverageIndex.clear();
    this.bulkFileList.forEach((file, index) => {
      const meta = metadata.find(m => m.filename === file.filename) ?? null;
      let bbox: DatabaseCoverageEntry['bbox'] = null;
      let boundary: DatabaseCoverageEntry['boundary'] = null;
      try {
        if (meta?.boundingBox) bbox = JSON.parse(meta.boundingBox);
        if (meta?.boundaryGeometry) boundary = JSON.parse(meta.boundaryGeometry);
      } catch { /* malformed metadata JSON — leave coverage null, non-fatal */ }
      this.coverageIndex.set(file.filename, {
        filename: file.filename,
        path: file.path,
        bbox, boundary,
        state: 'loaded',
        dbIndex: index,
        meta,
        stats: meta?.stats ?? null,
      });
    });
  }

  /**
   * Upgrade Phase 1's straight-line edge_kind_id=1 fallback edges between a
   * region's boundary nodes to the real funnel-computed taut path (spec §6's
   * "prefer the funnel-computed path over the fallback edges" runtime
   * strategy), and add genuine interior shortcuts between the region's
   * anchors (see NEXT_PHASES.md's "Boundary Shortcut Sparsification" fix) —
   * done once here, at graph-load time, so astarSearch's per-edge relaxation
   * loop never has to know navmesh regions exist at all.
   *
   * Defaults to every currently-loaded region (the non-dynamic bulk-load
   * behavior). Dynamic mode's per-file loader passes just the newly-loaded
   * database's own regions, so an incremental load never recomputes work
   * already done for regions loaded earlier (§4a task 2).
   */
  private precomputeFunnelEdges(regions: NavmeshRegionWithDb[] = this.navmeshRegions): void {
    let emptyCount = 0;
    regions.forEach((region, index) => {
      if (region.boundaryNodeIds.length === 0) {
        emptyCount++;
        // region_id is not a unique key in real generated databases (all rows
        // observed with region_id=1 in zeeland.sqlite) — log the load-order
        // index too so individual occurrences are distinguishable.
        console.warn(`[routeiq] Navmesh region_id=${region.regionId} (load index ${index}) has no ` +
          'boundary_node_ids — funnel-edge upgrade and anchor shortcuts are silently skipped for it, ' +
          'leaving only straight-line edge_kind_id=1 fallback edges (see NEXT_PHASES.md, Round 9 master finding).');
        return;
      }
      this.upgradeRingBoundaryEdges(region);
      this.addAnchorShortcutEdges(region);
    });
    if (emptyCount > 0) {
      console.warn(`[routeiq] ${emptyCount}/${regions.length} navmesh regions have empty ` +
        'boundary_node_ids — funnel-upgrade coverage is degraded for this database.');
    }
  }

  /** Upgrade existing ring-adjacency edge_kind_id=1 edges (Phase 1 only ever
   *  creates these between ring-adjacent perimeter vertices) to their real
   *  funnel-computed taut path. Cheap regardless of region size — each
   *  boundary node has ~2 such edges (prev/next in the ring), not one per
   *  pair, so there's no need to cap this by boundary-node count. */
  private upgradeRingBoundaryEdges(region: Navmesh.NavmeshRegion): void {
    const computed = new Map<string, Navmesh.FunnelResult>();
    const boundarySet = new Set(region.boundaryNodeIds);

    for (const nodeId of region.boundaryNodeIds) {
      const edges = this.edgesBySource.get(nodeId);
      if (!edges) continue;
      for (const edge of edges) {
        if (edge.edge_kind_id !== EDGE_KIND_NAVMESH_BOUNDARY) continue;
        if (!boundarySet.has(edge.target)) continue;

        // Always compute in a canonical (lo -> hi) direction so the cache
        // is correct regardless of which direction's edge row is visited
        // first — orientation is then just "did I ask for lo or hi first".
        const [lo, hi] = nodeId < edge.target ? [nodeId, edge.target] : [edge.target, nodeId];
        const pairKey = `${lo}:${hi}`;
        let result = computed.get(pairKey);
        if (!result) {
          result = Navmesh.funnelBetweenNodes(region, lo, hi) ?? undefined;
          if (result) computed.set(pairKey, result);
        }
        if (!result) continue;

        // Sanity guard: never let a degenerate funnel make routing worse
        // than doing nothing — keep the original straight-line fallback.
        if (result.distance > edge.distance * 3 + 50) continue;

        edge.distance = result.distance;
        const path = nodeId === lo ? result.path : [...result.path].reverse();
        edge.path_points = path.slice(1, -1);
      }
    }
  }

  /**
   * Ring-adjacency edges alone only ever connect two *immediately adjacent*
   * perimeter points — there was never a mechanism to cheaply cross a large
   * region between two *distant* boundary nodes, which is exactly what's
   * needed when a route crosses from one region, through a stitch point,
   * into an adjacent one. Fix: a genuine interior "highway" between every
   * pair of a small, bounded set of well-distributed anchors, plus a cheap
   * link from every other boundary node to its nearest 1-2 anchors (by real
   * geometric distance — see Round 4 comment below on why not ring index).
   */
  private addAnchorShortcutEdges(region: NavmeshRegionWithDb): void {
    const anchors = region.anchorNodeIds;
    if (anchors.length < 2) return;

    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        this.addFunnelShortcutEdge(region, anchors[i], anchors[j]);
      }
    }

    // Pick each non-anchor boundary node's nearest anchors by real (haversine)
    // geometric distance, not ring arc-index. Round 4 found ring arc-distance
    // a poor proxy on Zeeland's convoluted coastline — arc-adjacent doesn't
    // mean geometrically close — which both picked a lower-quality "nearest"
    // anchor and made its corridor search needlessly expensive (a genuinely
    // distant target visits far more of the triangle mesh). The distance
    // computation itself is 40 cheap haversine calls per node, negligible
    // next to the corridor search it feeds.
    const anchorSet = new Set(anchors);
    const anchorCoords: Array<{ id: number; pos: { lat: number; lon: number } }> = [];
    for (const id of anchors) {
      const pos = this.nodes.get(id);
      if (pos) anchorCoords.push({ id, pos });
    }

    region.boundaryNodeIds.forEach((nodeId) => {
      if (anchorSet.has(nodeId)) return;
      const nodePos = this.nodes.get(nodeId);
      if (!nodePos) return;
      const nearest = anchorCoords
        .map(a => ({ id: a.id, d: this.haversineMeters(nodePos.lat, nodePos.lon, a.pos.lat, a.pos.lon) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
      for (const { id } of nearest) {
        this.addFunnelShortcutEdge(region, nodeId, id);
      }
    });
  }

  /** Insert a new funnel-computed shortcut between two boundary nodes of the
   *  same region as a pair of directional in-memory edges (mirrors the shape
   *  `addEdge` builds, minus the async DB round-trip — these are derived,
   *  load-time-only edges, never persisted). No-op if a ring-adjacency
   *  edge_kind_id=1 edge already connects the pair directly — that one is
   *  handled (and upgraded) by `upgradeRingBoundaryEdges` instead. */
  private addFunnelShortcutEdge(region: NavmeshRegionWithDb, nodeA: number, nodeB: number): void {
    if (nodeA === nodeB) return;
    const alreadyDirectEdge = this.edgesBySource.get(nodeA)?.some(
      e => e.target === nodeB && e.edge_kind_id === EDGE_KIND_NAVMESH_BOUNDARY,
    );
    if (alreadyDirectEdge) return;

    const result = Navmesh.funnelBetweenNodes(region, nodeA, nodeB);
    if (!result) return;

    if (!this.nodes.has(nodeA) || !this.nodes.has(nodeB)) return;

    const forwardPath = result.path.slice(1, -1);
    const reversePath = [...forwardPath].reverse();
    const shared = {
      distance: result.distance,
      min_depth: region.depthCeilingM,
      max_air_draft: -1,
      min_width: -1,
      cost_factor: 1.0,
      distance_to_land: 9999,
      edge_type_id: EDGE_TYPE_COASTAL,
      traffic_mode: TRAFFIC_TWO_WAY,
      edge_kind_id: EDGE_KIND_NAVMESH_BOUNDARY,
      // Tags this synthetic edge with the dbIndex of the region that
      // created it, so unloadDatabaseGraph can remove it along with the
      // rest of that database's edges — these never exist in any .sqlite
      // file, so they'd otherwise leak in memory across an unload.
      dbIndex: region.dbIndex,
    };

    if (!this.edgesBySource.has(nodeA)) this.edgesBySource.set(nodeA, []);
    this.edgesBySource.get(nodeA)!.push({
      ...shared, source: nodeA, target: nodeB,
      path_points: forwardPath,
    });

    if (!this.edgesBySource.has(nodeB)) this.edgesBySource.set(nodeB, []);
    this.edgesBySource.get(nodeB)!.push({
      ...shared, source: nodeB, target: nodeA,
      path_points: reversePath,
    });
  }

  // ---------------------------------------------------------------------
  // §4a dynamic database loading — per-file load/unload, coverage index,
  // and on-demand resolution for route requests. Everything below is a
  // no-op (ensureRegionsLoaded) or simply unreachable from the API
  // (loadDatabaseGraph/unloadDatabaseGraph are only ever invoked when
  // dynamicLoading is true — see api.ts's /databases/load, /unload) when
  // dynamicLoading is false, so none of it can affect non-dynamic behavior.
  // ---------------------------------------------------------------------

  /** Coverage/state for every locally-known database, in both modes —
   *  folded into getDatabaseCatalog() (GET .../databases), and used
   *  directly as the `databases` field of the /databases/load and
   *  /databases/unload POST responses, and by tests as the per-file state
   *  inspector. */
  getCoverageStatus(): Array<{ filename: string; state: 'not_loaded' | 'loading' | 'loaded'; coverage: DatabaseCoverageEntry['bbox']; nodes?: number; stats: DatabaseCoverageEntry['stats'] }> {
    const result: Array<{ filename: string; state: 'not_loaded' | 'loading' | 'loaded'; coverage: DatabaseCoverageEntry['bbox']; nodes?: number; stats: DatabaseCoverageEntry['stats'] }> = [];
    for (const entry of this.coverageIndex.values()) {
      const nodes = entry.dbIndex !== null ? this.nodesByDbIndex.get(entry.dbIndex)?.size : undefined;
      result.push({ filename: entry.filename, state: entry.state, coverage: entry.bbox, nodes, stats: entry.stats });
    }
    return result;
  }

  /** True iff `filename` is a database this RoutingDatabase knows about
   *  locally (peeked or bulk-loaded), regardless of its current state. */
  hasKnownDatabase(filename: string): boolean {
    return this.coverageIndex.has(filename);
  }

  /**
   * Dynamic-loading mode only (no-op otherwise): given a route request's
   * anchor points (start/end/via), load every not-yet-loaded database whose
   * metadata bounding box contains one of them, synchronously, before the
   * caller proceeds to search the graph. Called from
   * RoutingEngine.calculateRoute before any node lookup.
   *
   * Waypoint containment only — a route can also *transit* a database it
   * has no waypoint inside (e.g. a strait between start and end). That case
   * is handled separately by ensureRegionsForBbox, called per search
   * attempt/segment once the search's bounding box is known (PHASE_4_DESIGN.md
   * §4a.1 task 4).
   */
  async ensureRegionsLoaded(points: Array<{ latitude: number; longitude: number }>): Promise<void> {
    if (!this.dynamicLoading) return;
    const toLoad = new Set<string>();
    for (const p of points) {
      for (const entry of this.coverageIndex.values()) {
        if (!entry.bbox) continue;
        if (p.latitude >= entry.bbox.min_lat && p.latitude <= entry.bbox.max_lat &&
            p.longitude >= entry.bbox.min_lon && p.longitude <= entry.bbox.max_lon) {
          // §4a M5: touch every region this request falls inside, whether or
          // not it's already loaded — an actively-relevant region must never
          // look like the LRU candidate to enforceRegionCap().
          this.touchRegion(entry.filename);
          if (entry.state !== 'loaded') toLoad.add(entry.filename);
        }
      }
    }
    for (const filename of toLoad) {
      const t0 = Date.now();
      console.log(`[routeiq] Route request falls inside not-yet-loaded database ${filename} — loading inline before search`);
      await this.loadDatabaseGraph(filename);
      console.log(`[routeiq] Inline on-demand load of ${filename} completed in ${Date.now() - t0}ms`);
    }
  }

  /**
   * Dynamic-loading mode only (no-op otherwise): given the bounding box a
   * route search is about to examine — already bounded by
   * routingBBoxMaxExtent, see routing.ts's tryRouteSegment/calculateRouteImpl —
   * load every not-yet-loaded database whose coverage bbox *intersects* it
   * (standard AABB overlap test), synchronously, before the caller proceeds
   * to search the graph. This is what makes transit regions available: a
   * database the route passes through but has no start/dest/via waypoint
   * inside (ensureRegionsLoaded above only covers waypoint containment).
   * Called from RoutingEngine per search attempt/segment, immediately
   * before astarSearch — PHASE_4_DESIGN.md §4a.1 task 4.
   */
  async ensureRegionsForBbox(bbox: BBox): Promise<void> {
    if (!this.dynamicLoading) return;
    const toLoad = new Set<string>();
    for (const entry of this.coverageIndex.values()) {
      if (!entry.bbox) continue;
      const intersects =
        entry.bbox.min_lat <= bbox.maxLat && entry.bbox.max_lat >= bbox.minLat &&
        entry.bbox.min_lon <= bbox.maxLon && entry.bbox.max_lon >= bbox.minLon;
      if (intersects) {
        // §4a M5: see ensureRegionsLoaded — touch relevant regions whether
        // newly loaded or already loaded.
        this.touchRegion(entry.filename);
        if (entry.state !== 'loaded') toLoad.add(entry.filename);
      }
    }
    for (const filename of toLoad) {
      const t0 = Date.now();
      console.log(`[routeiq] Route search bounding box overlaps not-yet-loaded database ${filename} — loading inline before search`);
      await this.loadDatabaseGraph(filename);
      console.log(`[routeiq] Inline on-demand load of ${filename} completed in ${Date.now() - t0}ms`);
    }
  }

  /** Dynamic mode only: eager-load every not-yet-loaded database whose
   *  coverage bbox contains the vessel position, optionally expanded by a
   *  `radiusNm` proactive band (load a region just before the vessel crosses
   *  into it). Called at startup once a position is known and on each
   *  throttled position update — so a positioned vessel boots with its local
   *  region loaded and routable instead of an empty graph. No-op in
   *  non-dynamic mode (everything is already loaded). */
  async eagerLoadForPosition(lat: number, lon: number, radiusNm: number = 0): Promise<void> {
    if (!this.dynamicLoading) return;
    // ~1 nm of latitude ≈ 1/60°; scale longitude by cos(lat) so the band is
    // roughly circular. Cheap prefilter — the containment test below is what
    // actually decides membership.
    const dLat = radiusNm / 60;
    const dLon = radiusNm / 60 / Math.max(0.1, Math.cos(lat * Math.PI / 180));
    const toLoad = new Set<string>();
    for (const entry of this.coverageIndex.values()) {
      if (!entry.bbox) continue;
      if (lat >= entry.bbox.min_lat - dLat && lat <= entry.bbox.max_lat + dLat &&
          lon >= entry.bbox.min_lon - dLon && lon <= entry.bbox.max_lon + dLon) {
        // §4a M5: touch every region within the band, whether or not it's
        // already loaded — see ensureRegionsLoaded.
        this.touchRegion(entry.filename);
        if (entry.state === 'not_loaded') toLoad.add(entry.filename);
      }
    }
    for (const filename of toLoad) {
      const t0 = Date.now();
      console.log(`[routeiq] Vessel position (${lat.toFixed(4)},${lon.toFixed(4)}) is inside not-yet-loaded database ${filename} — eager-loading`);
      try {
        await this.loadDatabaseGraph(filename);
        console.log(`[routeiq] Eager position load of ${filename} completed in ${Date.now() - t0}ms`);
      } catch (e) {
        console.warn(`[routeiq] Eager position load of ${filename} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** Dynamic mode only: if exactly one database is installed, load it at
   *  startup unconditionally — a single-region deployment has nothing to
   *  choose between, so it should be ready-at-boot even with dynamicLoading
   *  on, rather than presenting an empty graph until a route or position
   *  triggers the sole region. No-op in non-dynamic mode. */
  async eagerLoadIfSingle(): Promise<void> {
    if (!this.dynamicLoading) return;
    if (this.coverageIndex.size !== 1) return;
    const [only] = this.coverageIndex.values();
    if (!only || only.state === 'loaded') return;
    console.log(`[routeiq] Single installed database ${only.filename} — eager-loading at startup`);
    try {
      await this.loadDatabaseGraph(only.filename);
    } catch (e) {
      console.warn(`[routeiq] Single-database eager load failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Load exactly one locally-known database's nodes/edges/pois/navmesh
   * regions and merge them into the already-in-memory graph (dynamic mode
   * only — coverageIndex is empty in non-dynamic mode, so this always
   * throws "Unknown database" there, which is intentional: unload/reload of
   * a single file isn't a supported operation on the bulk-load path).
   * Idempotent — a no-op if already loaded — and concurrent callers for the
   * same filename share a single in-flight load rather than double-loading.
   */
  async loadDatabaseGraph(filename: string): Promise<void> {
    const entry = this.coverageIndex.get(filename);
    if (!entry) throw new Error(`Unknown database: ${filename}`);
    if (entry.state === 'loaded') return;

    const inflight = this.loadingPromises.get(filename);
    if (inflight) { await inflight; return; }

    const promise = this.loadDatabaseGraphInner(filename, entry);
    this.loadingPromises.set(filename, promise);
    try {
      await promise;
    } finally {
      this.loadingPromises.delete(filename);
    }
  }

  private async loadDatabaseGraphInner(filename: string, entry: DatabaseCoverageEntry): Promise<void> {
    entry.state = 'loading';
    try {
      const opened: {
        dbIndex: number; filename: string;
        flags: { hasCrossesLand: boolean; hasCrossesObstacle: boolean; hasNodeDepth: boolean; hasRegionId: boolean; hasEdgeKind: boolean };
      } = await this.sendMessage('openDb', { dbPath: entry.path });
      const dbIndex = opened.dbIndex;
      this.hasCrossesLand = this.hasCrossesLand || opened.flags.hasCrossesLand;
      this.hasCrossesObstacle = this.hasCrossesObstacle || opened.flags.hasCrossesObstacle;
      this.hasNodeDepth = this.hasNodeDepth || opened.flags.hasNodeDepth;
      this.hasRegionId = this.hasRegionId || opened.flags.hasRegionId;

      // The overlay's own added nodes/edges rows must be merged into memory
      // exactly once across the whole process lifetime, no matter how many
      // per-file loads happen afterward — merging them again on a later
      // load would duplicate them in edgesBySource.
      const includeOverlay = !this.overlayMergedOnce;

      const nodes: Array<{ id: number; lat: number; lon: number; node_depth: number; region_id?: number; db_index: number }> =
        await this.sendMessage('loadNodes', { dbIndexes: [dbIndex], includeOverlay });

      const nodeIdSet = this.nodesByDbIndex.get(dbIndex) ?? new Set<number>();
      for (const n of nodes) {
        // Only ids not already in `this.nodes` are genuinely new to the
        // in-memory grid — a shared-id/refcount collision (region-seam
        // coordinate hash collision, or this same node already loaded from
        // another database) must NOT be re-inserted, or the id would appear
        // twice in its grid cell and corrupt every grid-backed query (M6).
        const isNewNode = !this.nodes.has(n.id);
        this.nodes.set(n.id, { lat: n.lat, lon: n.lon, regionId: n.region_id ?? 0, nodeDepth: n.node_depth });
        if (isNewNode) this.gridInsertNode(n.id, n.lat, n.lon);
        if (n.db_index === dbIndex) {
          // Real per-file node (not an overlay row) — track provenance and
          // bump the refcount so a coordinate-hash collision with another
          // loaded database's node id (rare, but possible at region seams —
          // PHASE_4_DESIGN.md §4a.1) doesn't get deleted out from under the
          // other database when just one of the two is unloaded later.
          nodeIdSet.add(n.id);
          this.nodeDbCount.set(n.id, (this.nodeDbCount.get(n.id) ?? 0) + 1);
        }
        // Overlay-added nodes (db_index === -1) are never refcounted against
        // a specific file — only close()/reload() drops them.
      }
      this.nodesByDbIndex.set(dbIndex, nodeIdSet);

      // Overlay deletions apply regardless of includeOverlay (they're a
      // filter, not a merge, and cheap enough to just refetch every load).
      const deletedNodeIds: number[] = await this.sendMessage('getDeletedNodeIds');
      const deletedEdges: Array<{ source: number; target: number }> = await this.sendMessage('getDeletedEdgePairs');
      for (const nid of deletedNodeIds) {
        // Capture coords before deleting — needed to find the grid cell the
        // node was inserted into (a node's id encodes its coordinate, so the
        // cell it hashes to never changes across loads).
        const removedCoords = this.nodes.get(nid);
        if (this.nodes.delete(nid)) {
          nodeIdSet.delete(nid);
          if (removedCoords) this.gridRemoveNode(nid, removedCoords.lat, removedCoords.lon);
        }
      }
      const deletedNodeSet = new Set(deletedNodeIds);
      const deletedEdgeSet = new Set(deletedEdges.map(d => `${d.source}:${d.target}`));

      const edges: Array<EdgeRow & { db_index: number }> = await this.sendMessage('loadEdges', { dbIndexes: [dbIndex], includeOverlay });
      let edgeCount = 0;
      for (const edge of edges) {
        if (deletedNodeSet.has(edge.source) || deletedNodeSet.has(edge.target)) continue;
        if (deletedEdgeSet.has(`${edge.source}:${edge.target}`)) continue;
        // Same dangling-endpoint drop as loadGraph — coordinates always come
        // from `this.nodes`, never from the edge row.
        if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) continue;
        edge.dbIndex = edge.db_index;
        if (!this.edgesBySource.has(edge.source)) this.edgesBySource.set(edge.source, []);
        this.edgesBySource.get(edge.source)!.push(edge);
        edgeCount++;
      }

      // spatialGrid is maintained incrementally above (gridInsertNode on new
      // nodes, gridRemoveNode on overlay deletions) — no full rebuild needed
      // here (M6). buildSpatialIndex() is still used by the bulk loadGraph()
      // path below, where one full build after the whole load is simplest.

      const pois: Array<{ id: number; name: string; type_id: number; properties: string | null; lat: number; lon: number; db_index: number }> =
        await this.sendMessage('loadPois', { dbIndexes: [dbIndex] });
      for (const p of pois) this.pois.push({ ...p, dbIndex: p.db_index });

      const rawRegions: Array<{
        region_id: number; boundary_geometry: string; vertices: string;
        triangles: string; triangle_adjacency: string | null;
        boundary_node_ids: string; depth_ceiling_m: number; db_index: number;
      }> = await this.sendMessage('loadNavmeshRegions', { dbIndexes: [dbIndex] });
      const newRegions: NavmeshRegionWithDb[] = rawRegions.map(r => ({
        ...Navmesh.buildNavmeshRegion(r, (id) => this.nodes.get(id)),
        dbIndex,
      }));
      this.navmeshRegions.push(...newRegions);
      // Only precompute funnel/anchor edges for the regions this load just
      // added — regions from already-loaded databases were done on their
      // own load and must not be recomputed here (§4a task 2).
      if (newRegions.length > 0) this.precomputeFunnelEdges(newRegions);

      if (includeOverlay) this.overlayMergedOnce = true;

      entry.dbIndex = dbIndex;
      entry.state = 'loaded';
      // §4a M5: a freshly-loaded region is by definition the most recently
      // used one.
      this.touchRegion(filename);

      // This load just added to `this.pois` and `edgesBySource` (incl. its
      // own newly-precomputed synthetic funnel/anchor edges) — any
      // bbox-query cache built before this load is stale.
      this.invalidateBBoxCaches();

      console.log(`[routeiq] Loaded database ${filename} (dbIndex=${dbIndex}): ` +
        `${nodeIdSet.size} nodes, ${edgeCount} edges, ${pois.length} POIs, ${newRegions.length} navmesh regions`);
    } catch (err) {
      // Leave the coverage entry loadable again on failure rather than
      // stuck 'loading' forever.
      entry.state = 'not_loaded';
      throw err;
    }
  }

  /**
   * Remove exactly one database's contribution from the in-memory graph:
   * its edges (including synthetic funnel/anchor-shortcut edges, tagged
   * with this dbIndex by addFunnelShortcutEdge), its navmesh regions, its
   * POIs, and its nodes — except any node id another still-loaded database
   * also contributed (coordinate-hash collision at a region seam; tracked
   * via nodeDbCount's refcount). Refuses when this is the only loaded
   * database, or while a route calculation is in progress (see
   * beginRoute/endRoute) — evicting graph data out from under an
   * in-progress search is worse than a temporarily-stale eviction request.
   */
  async unloadDatabaseGraph(filename: string): Promise<{ nodesRemoved: number; edgesRemoved: number }> {
    const entry = this.coverageIndex.get(filename);
    if (!entry) throw new Error(`Unknown database: ${filename}`);
    if (entry.state !== 'loaded' || entry.dbIndex === null) {
      throw new Error(`Database ${filename} is not currently loaded`);
    }
    const loadedCount = Array.from(this.coverageIndex.values()).filter(e => e.state === 'loaded').length;
    if (loadedCount <= 1) {
      throw new Error('Cannot unload the only loaded database — routing would have no coverage left');
    }
    if (this.activeRouteCount > 0) {
      throw new Error('Cannot unload a database while a route calculation is in progress');
    }

    const dbIndex = entry.dbIndex;

    let edgesRemoved = 0;
    for (const [src, edges] of this.edgesBySource) {
      const filtered = edges.filter(e => e.dbIndex !== dbIndex);
      edgesRemoved += edges.length - filtered.length;
      if (filtered.length === 0) this.edgesBySource.delete(src);
      else if (filtered.length !== edges.length) this.edgesBySource.set(src, filtered);
    }

    const nodeIds = this.nodesByDbIndex.get(dbIndex) ?? new Set<number>();
    let nodesRemoved = 0;
    for (const nodeId of nodeIds) {
      const remaining = (this.nodeDbCount.get(nodeId) ?? 1) - 1;
      if (remaining <= 0) {
        this.nodeDbCount.delete(nodeId);
        // Capture coords before deleting — same reasoning as
        // loadDatabaseGraphInner's overlay-deletion handling above.
        const removedCoords = this.nodes.get(nodeId);
        this.nodes.delete(nodeId);
        if (removedCoords) this.gridRemoveNode(nodeId, removedCoords.lat, removedCoords.lon);
        nodesRemoved++;
      } else {
        this.nodeDbCount.set(nodeId, remaining);
      }
    }
    this.nodesByDbIndex.delete(dbIndex);

    // The by-dbIndex edge removal above only drops edges tagged with THIS
    // dbIndex — it deliberately keeps overlay (user-edit) edges, which are
    // tagged dbIndex === -1, or left `undefined` entirely for edges added
    // in-memory via addEdge (see addEdge's newEdge literal, which never sets
    // dbIndex). If such an overlay edge happens to reference a node that
    // just got deleted above (refcount hit 0 — e.g. a graph-editor edge the
    // user drew from a node in another region to a node in this now-evicted
    // one), it's left dangling in edgesBySource: its source or target no
    // longer resolves via this.nodes.get(), which a later A* relaxation or
    // buildRouteResult would hit as `undefined` and either crash or silently
    // produce a broken route. Sweep those out now that node removal is done.
    //
    // This only ever removes an edge whose source or target is gone — every
    // edge with both endpoints still loaded is left untouched — so it can
    // only catch dangling overlay/stray edges, never a live one. It's an
    // O(edges) pass, but unload is infrequent, so that's fine.
    //
    // Known, accepted limitation: the dropped overlay edge still exists as a
    // row in user-edits.sqlite. Because overlay rows are merged into memory
    // only once (see overlayMergedOnce), a later reload of this region will
    // NOT re-add this specific in-memory overlay edge until a full
    // close()/reload() re-merges everything from scratch. That's fine —
    // dropping an inactive cross-region overlay edge from memory beats
    // leaving a dangling reference, and the edit itself is preserved on
    // disk, just not re-merged automatically. Not attempting to solve that
    // re-merge gap here.
    for (const [src, edges] of this.edgesBySource) {
      if (!this.nodes.has(src)) { this.edgesBySource.delete(src); continue; }
      const kept = edges.filter(e => this.nodes.has(e.target));
      if (kept.length === 0) this.edgesBySource.delete(src);
      else if (kept.length !== edges.length) this.edgesBySource.set(src, kept);
    }

    this.navmeshRegions = this.navmeshRegions.filter(r => r.dbIndex !== dbIndex);
    this.pois = this.pois.filter(p => p.dbIndex !== dbIndex);

    await this.sendMessage('closeDb', { dbIndex });

    // spatialGrid is maintained incrementally above (gridRemoveNode for
    // exactly the nodes actually removed) — no full rebuild needed (M6).

    entry.state = 'not_loaded';
    entry.dbIndex = null;

    // This unload just filtered `edgesBySource` and `this.pois` — any
    // bbox-query cache built before it is stale (it would still reference
    // the just-removed database's rows).
    this.invalidateBBoxCaches();

    console.log(`[routeiq] Unloaded database ${filename} (dbIndex=${dbIndex}): removed ${nodesRemoved} nodes, ${edgesRemoved} edges`);
    return { nodesRemoved, edgesRemoved };
  }

  /**
   * §4a M5: bounded working set. No-op unless dynamic loading is on and
   * maxLoadedRegions > 0 (the constructor default, 0, is unlimited; the
   * plugin passes DEFAULT_CONFIG.maxLoadedRegions, which is a finite cap so
   * the heap can't grow without bound). No-op while a route is in flight (activeRouteCount >
   * 0) — never evict out from under an in-progress or about-to-run search;
   * endRoute() is the only caller, and only once activeRouteCount reaches 0.
   *
   * While more databases are 'loaded' than maxLoadedRegions allows, evicts
   * the least-recently-used one (smallest regionLastUsedAt; a region never
   * touched sorts as oldest) via unloadDatabaseGraph, which itself refuses
   * to drop the last loaded database or run while a route is active — both
   * cases are also checked here to avoid looping, and either one aborts the
   * whole enforcement pass rather than crashing a route.
   */
  private async enforceRegionCap(): Promise<void> {
    if (!this.dynamicLoading || this.maxLoadedRegions <= 0) return;
    if (this.activeRouteCount > 0) return;

    for (;;) {
      const loaded = Array.from(this.coverageIndex.values()).filter(e => e.state === 'loaded');
      if (loaded.length <= this.maxLoadedRegions || loaded.length <= 1) return;
      if (this.activeRouteCount > 0) return;

      let victim: DatabaseCoverageEntry | null = null;
      let victimScore = Infinity;
      for (const entry of loaded) {
        const score = this.regionLastUsedAt.get(entry.filename) ?? -Infinity;
        if (score < victimScore) {
          victimScore = score;
          victim = entry;
        }
      }
      if (!victim) return;

      try {
        await this.unloadDatabaseGraph(victim.filename);
        this.regionLastUsedAt.delete(victim.filename);
      } catch (e) {
        // Last-loaded-database guard or a route that started concurrently —
        // either way, stop enforcing rather than loop or throw out of a
        // fire-and-forget background pass.
        console.warn(`[routeiq] enforceRegionCap: stopping (${e instanceof Error ? e.message : e})`);
        return;
      }
    }
  }

  async getNodeById(id: number): Promise<{ lat: number; lon: number; regionId: number; nodeDepth: number } | null> {
    if (this.graphLoaded) {
      return this.nodes.get(id) || null;
    }
    return null;
  }

  getNodeSync(id: number): { lat: number; lon: number; regionId: number; nodeDepth: number } | null {
    if (!this.graphLoaded) {
      throw new Error('Graph must be loaded for synchronous node lookup');
    }
    return this.nodes.get(id) || null;
  }

  /** Read-only view of the loaded node map, for hot loops that resolve one
   *  node's coordinates per iteration (A*'s edge relaxation, which reads the
   *  target node of every edge it considers) — a single Map.get instead of a
   *  getNodeSync() call each time. The map is mutated in place by
   *  load/unload, never replaced, so a hoisted reference stays live for the
   *  caller's whole loop. Callers must treat it as read-only. */
  getNodeMap(): ReadonlyMap<number, { lat: number; lon: number; regionId: number; nodeDepth: number }> {
    return this.nodes;
  }

  async getOutgoingEdges(nodeId: number): Promise<Array<EdgeRow>> {
    if (this.graphLoaded) {
      return this.edgesBySource.get(nodeId) || [];
    }
    return [];
  }

  async getEdge(source: number, target: number): Promise<EdgeRow | null> {
    if (this.graphLoaded) {
      const edges = this.edgesBySource.get(source);
      if (edges) {
        return edges.find(e => e.target === target) || null;
      }
    }
    return null;
  }

  async getEdgesBySources(nodeIds: number[]): Promise<Map<number, Array<EdgeRow>>> {
    const result = new Map<number, Array<EdgeRow>>();
    if (!this.graphLoaded) return result;
    for (const id of nodeIds) {
      const edges = this.edgesBySource.get(id);
      if (edges) {
        result.set(id, edges);
      }
    }
    return result;
  }

  async findNearestNode(latitude: number, longitude: number, maxDistanceMeters: number = 50000): Promise<number | null> {
    if (!this.graphLoaded) return null;
    let bestId: number | null = null;
    let bestDist = maxDistanceMeters;
    const latRad = latitude * Math.PI / 180;
    const cosLat = Math.cos(latRad);
    const marginDeg = maxDistanceMeters / 111320;
    // cos(lat)-corrected longitude margin (see gridCandidateIds) — the same
    // superset the old full-scan prefilter below re-applies exactly.
    const marginLonDeg = marginDeg / cosLat;
    for (const id of this.gridCandidateIds(latitude, longitude, marginDeg, marginLonDeg)) {
      const c = this.nodes.get(id);
      if (!c) continue;
      if (Math.abs(c.lat - latitude) > marginDeg) continue;
      if (Math.abs(c.lon - longitude) > marginLonDeg) continue;
      const dLat = (c.lat - latitude) * Math.PI / 180;
      const dLon = (c.lon - longitude) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + cosLat * Math.cos(c.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      const d = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (d < bestDist) { bestDist = d; bestId = id; }
    }
    return bestId;
  }

  async findKNearestMainGraphNodes(latitude: number, longitude: number, k: number, maxDistMeters: number = 5000): Promise<Array<{ id: number; lat: number; lon: number; distance: number }>> {
    if (!this.graphLoaded) return [];
    const latRad = latitude * Math.PI / 180;
    const cosLat = Math.cos(latRad);
    const marginDeg = maxDistMeters / 111320;
    const marginLonDeg = marginDeg / cosLat;
    const candidates: Array<{ id: number; lat: number; lon: number; distance: number }> = [];
    for (const id of this.gridCandidateIds(latitude, longitude, marginDeg, marginLonDeg)) {
      const c = this.nodes.get(id);
      if (!c) continue;
      if (c.regionId === 0) continue;
      if (Math.abs(c.lat - latitude) > marginDeg) continue;
      if (Math.abs(c.lon - longitude) > marginLonDeg) continue;
      const d = this.haversineMeters(latitude, longitude, c.lat, c.lon);
      if (d <= maxDistMeters) candidates.push({ id, lat: c.lat, lon: c.lon, distance: d });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates.slice(0, k);
  }

  async findNearestNodeInSet(latitude: number, longitude: number, candidates: Set<number>, maxDistanceMeters: number = 5000): Promise<{ id: number; lat: number; lon: number; distance: number } | null> {
    if (candidates.size === 0 || !this.graphLoaded) return null;
    let best: { id: number; lat: number; lon: number; distance: number } | null = null;
    for (const id of candidates) {
      const c = this.nodes.get(id);
      if (!c) continue;
      const d = this.haversineMeters(latitude, longitude, c.lat, c.lon);
      if (d <= maxDistanceMeters && (!best || d < best.distance)) {
        best = { id, lat: c.lat, lon: c.lon, distance: d };
      }
    }
    return best;
  }

  async getNodesInRadius(latitude: number, longitude: number, radiusMeters: number): Promise<Array<{ id: number; lat: number; lon: number; distance: number }>> {
    const results: Array<{ id: number; lat: number; lon: number; distance: number }> = [];
    if (!this.graphLoaded) return results;
    const latRad = latitude * Math.PI / 180;
    const cosLat = Math.cos(latRad);
    const marginDeg = radiusMeters / 111320;
    const marginLonDeg = marginDeg / cosLat;
    for (const id of this.gridCandidateIds(latitude, longitude, marginDeg, marginLonDeg)) {
      const c = this.nodes.get(id);
      if (!c) continue;
      if (Math.abs(c.lat - latitude) > marginDeg) continue;
      if (Math.abs(c.lon - longitude) > marginLonDeg) continue;
      const dLat = (c.lat - latitude) * Math.PI / 180;
      const dLon = (c.lon - longitude) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + cosLat * Math.cos(c.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      const d = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (d <= radiusMeters) results.push({ id, lat: c.lat, lon: c.lon, distance: d });
    }
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  async findNearestEdge(
    latitude: number,
    longitude: number,
    maxDistMeters: number = 20000,
  ): Promise<EdgeSnapResult | null> {
    if (!this.graphLoaded) return null;

    const radiusDeg = maxDistMeters / 111320;
    const cellSize = 0.01;
    const cells = Math.ceil(radiusDeg / cellSize);
    const centerCol = Math.floor(longitude / cellSize);
    const centerRow = Math.floor(latitude / cellSize);

    const visitedEdges = new Set<string>();
    let best: EdgeSnapResult | null = null;
    let bestDist = maxDistMeters;

    for (let dr = -cells; dr <= cells; dr++) {
      for (let dc = -cells; dc <= cells; dc++) {
        const key = `${centerRow + dr}:${centerCol + dc}`;
        const nodeIds = this.spatialGrid.get(key);
        if (!nodeIds) continue;

        for (const nodeId of nodeIds) {
          const edges = this.edgesBySource.get(nodeId);
          if (!edges) continue;

          for (const edge of edges) {
            const edgeKey = `${edge.source}:${edge.target}`;
            if (visitedEdges.has(edgeKey)) continue;
            visitedEdges.add(edgeKey);

            const s = this.nodes.get(edge.source);
            const t = this.nodes.get(edge.target);
            if (!s || !t) continue;

            const { fraction, point, distance } = this.projectOnEdge(
              s.lon, s.lat, t.lon, t.lat, longitude, latitude,
            );

            if (distance < bestDist) {
              bestDist = distance;
              const distToSource = this.haversineMeters(latitude, longitude, s.lat, s.lon);
              const distToTarget = this.haversineMeters(latitude, longitude, t.lat, t.lon);
              const nearNode = distToSource <= distToTarget ? edge.source : edge.target;
              const farNode = nearNode === edge.source ? edge.target : edge.source;
              best = { source: edge.source, target: edge.target, fraction, point, distance, nearNode, farNode, edge };
            }
          }
        }
      }
    }

    return best;
  }

  public projectOnEdge(
    ax: number, ay: number,
    bx: number, by: number,
    px: number, py: number,
  ): { fraction: number; point: { lat: number; lon: number }; distance: number } {
    // Scale longitude differences by cos(midLat) so that 1° lon and 1° lat
    // have equal weight in the projection. Without this correction the result
    // is distorted above ~40° latitude (1° lon < 1° lat in real distance).
    const midLat = ((ay + by) / 2) * Math.PI / 180;
    const cosLat = Math.cos(midLat);

    const dx = (bx - ax) * cosLat;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    if (lenSq < 1e-12) {
      const d = this.haversineMeters(py, px, ay, ax);
      return { fraction: 0, point: { lat: ay, lon: ax }, distance: d };
    }

    const qx = (px - ax) * cosLat;
    const qy = py - ay;
    const t = Math.max(0, Math.min(1, (qx * dx + qy * dy) / lenSq));

    // Back-project to geographic coordinates
    const projLon = ax + t * (bx - ax);
    const projLat = ay + t * (by - ay);
    const dist = this.haversineMeters(py, px, projLat, projLon);

    return { fraction: t, point: { lat: projLat, lon: projLon }, distance: dist };
  }

  getReachableNodes(startNode: number): Set<number> {
    if (!this.graphLoaded) {
      throw new Error('Graph must be loaded before checking reachability');
    }
    const visited = new Set<number>();
    const queue: number[] = [startNode];
    visited.add(startNode);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const edges = this.edgesBySource.get(current);
      if (edges) {
        for (const edge of edges) {
          // TRAFFIC_ONE_WAY_REV (=2) means only target→source is legal;
          // do not follow it source→target or reachability is wrong.
          if (edge.traffic_mode === TRAFFIC_ONE_WAY_REV) continue;
          if (!visited.has(edge.target)) {
            visited.add(edge.target);
            queue.push(edge.target);
          }
        }
      }
    }
    return visited;
  }

  /** The navmesh region (if any) whose boundary_geometry contains this point. */
  findNavmeshRegionAt(lat: number, lon: number): Navmesh.NavmeshRegion | null {
    for (const region of this.navmeshRegions) {
      if (lat < region.bbox.minLat || lat > region.bbox.maxLat ||
          lon < region.bbox.minLon || lon > region.bbox.maxLon) continue;
      if (Navmesh.pointInPolygon(lat, lon, region.boundaryGeometry)) return region;
    }
    return null;
  }

  /** Read-only accessor, e.g. for graph-editor visualization. */
  getNavmeshRegions(): Navmesh.NavmeshRegion[] {
    return this.navmeshRegions;
  }

  funnelPathBetweenNodes(region: Navmesh.NavmeshRegion, nodeA: number, nodeB: number): Navmesh.FunnelResult | null {
    return Navmesh.funnelBetweenNodes(region, nodeA, nodeB);
  }

  funnelPathFromPoint(region: Navmesh.NavmeshRegion, lat: number, lon: number, targetNodeId: number): Navmesh.FunnelResult | null {
    return Navmesh.funnelFromPoint(region, lat, lon, targetNodeId);
  }

  funnelPathBetweenPoints(region: Navmesh.NavmeshRegion, latA: number, lonA: number, latB: number, lonB: number): Navmesh.FunnelResult | null {
    return Navmesh.funnelBetweenPoints(region, latA, lonA, latB, lonB);
  }

  /**
   * Look up a precomputed navmesh shortcut edge (ring-adjacency upgrade or
   * anchor shortcut — see `addAnchorShortcutEdges`) between two boundary
   * nodes of the same region, if one exists. Lets a caller compose a cheap,
   * non-live approximate cost to a non-anchor boundary node — live anchor
   * result + this precomputed hop — instead of a live `funnelPathFromPoint`
   * call per node (NEXT_PHASES.md's boundary-shortcut-sparsification fix).
   */
  getPrecomputedNavmeshShortcut(source: number, target: number): { distance: number; path_points?: Array<[number, number]> } | null {
    const edge = this.edgesBySource.get(source)?.find(
      e => e.target === target && e.edge_kind_id === EDGE_KIND_NAVMESH_BOUNDARY,
    );
    return edge ? { distance: edge.distance, path_points: edge.path_points } : null;
  }

  async searchPois(query: string, maxResults: number = 20): Promise<PoiResult[]> {
    const pattern = query.toLowerCase();
    // Sort before slicing so results are alphabetically consistent regardless
    // of the order rows were inserted into the database.
    return this.pois
      .filter(row => row.name.toLowerCase().includes(pattern))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, maxResults)
      .map(row => ({
        id: row.id,
        name: row.name,
        typeId: row.type_id,
        properties: row.properties ? JSON.parse(row.properties) : {},
        latitude: row.lat,
        longitude: row.lon,
      }));
  }

  async getOverlayStats(): Promise<{ nodes: number; edges: number; deletedNodes: number; deletedEdges: number }> {
    return this.sendMessage('getOverlayStats');
  }

  async getStats(): Promise<{ nodes: number; edges: number; pois: number }> {
    let edgeCount = 0;
    for (const edges of this.edgesBySource.values()) {
      edgeCount += edges.length;
    }
    return {
      nodes: this.nodes.size,
      edges: edgeCount,
      pois: this.pois.length,
    };
  }

  /** Number of distinct source nodes with at least one outgoing edge.
   *  Exposed for §4a dynamic-loading tests: a load/unload/reload cycle
   *  should return this to its pre-load value, catching any leaked
   *  synthetic funnel/anchor-shortcut edge (or leaked source-key entry)
   *  that unloadDatabaseGraph failed to remove. */
  getEdgesBySourceSize(): number {
    return this.edgesBySource.size;
  }

  async getNodesInBBox(
    minLat: number, minLon: number,
    maxLat: number, maxLon: number,
    limit: number = 5000,
  ): Promise<Array<{ id: number; lat: number; lon: number; min_depth: number; region_id: number }>> {
    const results: Array<{ id: number; lat: number; lon: number; min_depth: number; region_id: number }> = [];
    // Box query, not a radius query — no cos(lat) correction needed: iterate
    // every grid cell whose row/col range overlaps [minLat,maxLat] x
    // [minLon,maxLon] exactly (same Math.floor cell math buildSpatialIndex
    // uses), then apply the same exact box test the old full scan used.
    const cellSize = 0.01;
    const minRow = Math.floor(minLat / cellSize);
    const maxRow = Math.floor(maxLat / cellSize);
    const minCol = Math.floor(minLon / cellSize);
    const maxCol = Math.floor(maxLon / cellSize);
    outer:
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const ids = this.spatialGrid.get(`${row}:${col}`);
        if (!ids) continue;
        for (const id of ids) {
          const c = this.nodes.get(id);
          if (!c) continue;
          if (c.lat >= minLat && c.lat <= maxLat && c.lon >= minLon && c.lon <= maxLon) {
            results.push({
              id, lat: c.lat, lon: c.lon,
              min_depth: c.nodeDepth,
              region_id: c.regionId,
            });
            if (results.length >= limit) break outer;
          }
        }
      }
    }
    results.sort((a, b) => a.id - b.id);
    return results;
  }

  async getEdgesInBBox(
    minLat: number, minLon: number,
    maxLat: number, maxLon: number,
    limit: number = 5000,
  ): Promise<Array<{
    source: number; target: number;
    source_lat: number; source_lon: number;
    target_lat: number; target_lon: number;
    distance: number; min_depth: number; max_air_draft: number; min_width: number;
    edge_type_id: number; edge_kind_id: number; traffic_mode: number;
    cost_factor: number;
    /** Interior [lat,lon] points (source→target order, same as the internal
     *  EdgeRow.path_points and the pts array buildRouteResult walks — NOT
     *  GeoJSON [lon,lat] order) for edges whose real geometry is a curved
     *  funnel path rather than the source-target straight chord. Omitted
     *  entirely (not an empty array) when the edge has no such geometry, to
     *  keep the common-case payload the same size as before this field
     *  existed. Round 23b (see NEXT_PHASES.md §5.3). */
    path_points?: Array<[number, number]>;
  }>> {
    const results: Array<{
      source: number; target: number;
      source_lat: number; source_lon: number;
      target_lat: number; target_lon: number;
      distance: number; min_depth: number; max_air_draft: number; min_width: number;
      edge_type_id: number; edge_kind_id: number; traffic_mode: number;
      cost_factor: number;
      path_points?: Array<[number, number]>;
    }> = [];
    if (!this.edgeGrid) this.edgeGrid = this.buildEdgeGrid();

    // Box query, not a radius query — no cos(lat) correction needed: iterate
    // every grid cell whose row/col range overlaps [minLat,maxLat] x
    // [minLon,maxLon] exactly (same Math.floor cell math buildSpatialIndex
    // uses), then apply the same exact endpoint-in-bbox test the old full
    // scan used. Every qualifying edge has at least one endpoint whose cell
    // falls in this range (buildEdgeGrid registers both endpoints), so the
    // candidate set is a superset of the true answer — identical result to
    // the full scan once the exact test below is reapplied.
    const cellSize = 0.01;
    const minRow = Math.floor(minLat / cellSize);
    const maxRow = Math.floor(maxLat / cellSize);
    const minCol = Math.floor(minLon / cellSize);
    const maxCol = Math.floor(maxLon / cellSize);
    // An edge is registered under up to two cells (source + target), and
    // both could fall in the queried row/col range — dedup by (source,
    // target) so a qualifying edge is only ever emitted once, exactly as a
    // full scan over edgesBySource (which stores each directed edge once)
    // would.
    const visited = new Set<string>();
    outer:
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const bucket = this.edgeGrid.get(`${row}:${col}`);
        if (!bucket) continue;
        for (const e of bucket) {
          const edgeKey = `${e.source}:${e.target}`;
          if (visited.has(edgeKey)) continue;
          // Endpoint coordinates live only in the node map — this response
          // still exposes them (the webapp draws each edge from them), so
          // they're resolved here, at serialization time, rather than kept
          // on every EdgeRow. Both lookups always hit for a gridded edge
          // (buildEdgeGrid only buckets edges whose endpoints resolve).
          const s = this.nodes.get(e.source);
          const t = this.nodes.get(e.target);
          if (!s || !t) continue;
          if ((s.lat >= minLat && s.lat <= maxLat && s.lon >= minLon && s.lon <= maxLon) ||
              (t.lat >= minLat && t.lat <= maxLat && t.lon >= minLon && t.lon <= maxLon)) {
            visited.add(edgeKey);
            results.push({
              source: e.source, target: e.target,
              source_lat: s.lat, source_lon: s.lon,
              target_lat: t.lat, target_lon: t.lon,
              distance: e.distance, min_depth: e.min_depth,
              max_air_draft: e.max_air_draft, min_width: e.min_width,
              edge_type_id: e.edge_type_id, edge_kind_id: e.edge_kind_id ?? EDGE_KIND_CENTERLINE, traffic_mode: e.traffic_mode,
              cost_factor: e.cost_factor,
              ...(e.path_points && e.path_points.length > 0 ? { path_points: e.path_points } : {}),
            });
            if (results.length >= limit) break outer;
          }
        }
      }
    }
    return results;
  }

  async getPoisInBBox(
    minLat: number, minLon: number,
    maxLat: number, maxLon: number,
    limit: number = 2000,
  ): Promise<Array<{ id: number; name: string; typeId: number; properties: Record<string, unknown>; lat: number; lon: number }>> {
    const results: Array<{ id: number; name: string; typeId: number; properties: Record<string, unknown>; lat: number; lon: number }> = [];
    if (!this.poiGrid) this.poiGrid = this.buildPoiGrid();
    // Box query, not a radius query — no cos(lat) correction needed: iterate
    // every grid cell whose row/col range overlaps [minLat,maxLat] x
    // [minLon,maxLon] exactly (same Math.floor cell math buildSpatialIndex
    // uses), then apply the same exact box test the old full scan used.
    const cellSize = 0.01;
    const minRow = Math.floor(minLat / cellSize);
    const maxRow = Math.floor(maxLat / cellSize);
    const minCol = Math.floor(minLon / cellSize);
    const maxCol = Math.floor(maxLon / cellSize);
    outer:
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const bucket = this.poiGrid.get(`${row}:${col}`);
        if (!bucket) continue;
        for (const poi of bucket) {
          if (poi.lat >= minLat && poi.lat <= maxLat && poi.lon >= minLon && poi.lon <= maxLon) {
            results.push({
              id: poi.id, name: poi.name, typeId: poi.type_id,
              properties: poi.properties ? JSON.parse(poi.properties) : {},
              lat: poi.lat, lon: poi.lon,
            });
            if (results.length >= limit) break outer;
          }
        }
      }
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  async getNearestPoi(lat: number, lon: number, maxDistanceMeters: number = 250): Promise<{ id: number; name: string; typeId: number; properties: Record<string, unknown>; latitude: number; longitude: number; distance: number } | null> {
    if (!this.poiGrid) this.poiGrid = this.buildPoiGrid();
    let best: PoiRow | null = null;
    let bestDist = Infinity;
    // Gather candidates from every cell overlapping the cos(lat)-corrected
    // radius box — same superset technique gridCandidateIds uses for nodes —
    // then apply the same exact haversine + `d <= maxDistanceMeters` +
    // nearest selection the old full scan used.
    const latRad = lat * Math.PI / 180;
    const cosLat = Math.cos(latRad);
    const marginLat = maxDistanceMeters / 111320;
    const marginLon = marginLat / Math.max(1e-9, cosLat);
    const cellSize = 0.01;
    const minRow = Math.floor((lat - marginLat) / cellSize);
    const maxRow = Math.floor((lat + marginLat) / cellSize);
    const minCol = Math.floor((lon - marginLon) / cellSize);
    const maxCol = Math.floor((lon + marginLon) / cellSize);
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const bucket = this.poiGrid.get(`${row}:${col}`);
        if (!bucket) continue;
        for (const poi of bucket) {
          const d = this.haversineMeters(lat, lon, poi.lat, poi.lon);
          if (d < bestDist && d <= maxDistanceMeters) {
            bestDist = d;
            best = poi;
          }
        }
      }
    }
    if (!best) return null;
    return {
      id: best.id, name: best.name, typeId: best.type_id,
      properties: best.properties ? JSON.parse(best.properties) : {},
      latitude: best.lat, longitude: best.lon,
      distance: Math.round(bestDist),
    };
  }

  private haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private waterwaysGeoJson: any = null;
  private waterwaysGeojsonPath: string | null = null;

  async getWaterways(
    minLat: number, minLon: number,
    maxLat: number, maxLon: number,
  ): Promise<any[]> {
    if (!this.waterwaysGeojsonPath) {
      this.waterwaysGeojsonPath = join(this.dbDir, 'inland_waterways_lines.geojson');
    }

    if (!this.waterwaysGeoJson) {
      if (!existsSync(this.waterwaysGeojsonPath)) {
        this.waterwaysGeoJson = { type: 'FeatureCollection', features: [] };
      } else {
        const raw = readFileSync(this.waterwaysGeojsonPath, 'utf-8');
        try {
          this.waterwaysGeoJson = JSON.parse(raw);
        } catch {
          this.waterwaysGeoJson = { type: 'FeatureCollection', features: [] };
        }
      }
    }

    if (!this.waterwaysGeoJson.features) return [];

    const result: any[] = [];
    for (const f of this.waterwaysGeoJson.features) {
      if (featureIntersectsBBox(f, minLat, minLon, maxLat, maxLon)) {
        result.push(f);
      }
    }
    return result;
  }

  /** Null both bbox-query caches (poiGrid, edgeGrid) so the next
   *  getPoisInBBox/getNearestPoi/getEdgesInBBox call rebuilds them from
   *  scratch over the then-current `this.pois`/`edgesBySource`. Called at
   *  every site that mutates either of those: loadGraph (bulk),
   *  loadDatabaseGraphInner and unloadDatabaseGraph (dynamic per-file
   *  load/unload), addEdge, deleteEdge, deleteNode, addNode, and close().
   *  Over-invalidation (calling this when nothing actually changed) is
   *  cheap and safe — just an extra rebuild on the next query; a *missed*
   *  invalidation is the only real risk (a query would silently serve stale
   *  results), so mutation sites call this even where it may look
   *  redundant. */
  private invalidateBBoxCaches(): void {
    this.poiGrid = null;
    this.edgeGrid = null;
  }

  /** Bucket every row in `this.pois` into the same 0.01° grid cells
   *  buildSpatialIndex uses for nodes. Always built from scratch — see
   *  invalidateBBoxCaches — so it's trivially correct: a from-scratch
   *  iteration over `this.pois` cannot disagree with a from-scratch full
   *  scan over the same array. */
  private buildPoiGrid(): Map<string, PoiRow[]> {
    const grid = new Map<string, PoiRow[]>();
    const cellSize = 0.01;
    for (const row of this.pois) {
      const col = Math.floor(row.lon / cellSize);
      const gridRow = Math.floor(row.lat / cellSize);
      const key = `${gridRow}:${col}`;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(row);
    }
    return grid;
  }

  /** Bucket every edge in edgesBySource into the same 0.01° grid cells,
   *  under BOTH its source-endpoint cell and its target-endpoint cell (an
   *  edge whose two endpoints land in the same cell is simply pushed twice
   *  under the same key — harmless, getEdgesInBBox dedups via its own
   *  `visited` set). Registering both endpoints, not just one, is required
   *  for correctness: a long edge (macro/anchor-shortcut edges can span a
   *  whole region) or a one-way edge must still be found by a bbox query
   *  that only overlaps one of its two ends — exactly the semantics the old
   *  full scan's `(source in bbox) || (target in bbox)` test already
   *  encoded, just without an index to prune the search. Always built from
   *  scratch — see invalidateBBoxCaches. */
  private buildEdgeGrid(): Map<string, Array<EdgeRow>> {
    const grid = new Map<string, Array<EdgeRow>>();
    const cellSize = 0.01;
    const push = (key: string, edge: EdgeRow) => {
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(edge);
    };
    for (const edges of this.edgesBySource.values()) {
      for (const e of edges) {
        // Endpoint coordinates come from the node map (edges carry none).
        // An edge whose endpoints don't both resolve has no position to
        // bucket by, so it's left out of the grid rather than silently
        // mis-bucketed at (0,0) — getEdgesInBBox skips such an edge anyway.
        const s = this.nodes.get(e.source);
        const t = this.nodes.get(e.target);
        if (!s || !t) continue;
        const sourceKey = `${Math.floor(s.lat / cellSize)}:${Math.floor(s.lon / cellSize)}`;
        const targetKey = `${Math.floor(t.lat / cellSize)}:${Math.floor(t.lon / cellSize)}`;
        push(sourceKey, e);
        push(targetKey, e);
      }
    }
    return grid;
  }

  private buildSpatialIndex(): void {
    this.spatialGrid = new Map();
    const cellSize = 0.01;
    for (const [id, coords] of this.nodes) {
      const col = Math.floor(coords.lon / cellSize);
      const row = Math.floor(coords.lat / cellSize);
      const key = `${row}:${col}`;
      let ids = this.spatialGrid.get(key);
      if (!ids) {
        ids = [];
        this.spatialGrid.set(key, ids);
      }
      ids.push(id);
    }
  }

  /** Incremental counterpart to buildSpatialIndex(): insert a single node id
   *  into the grid cell its (lat, lon) hashes to, using the exact same
   *  cellSize/Math.floor math. Used by the incremental mutation sites
   *  (loadDatabaseGraphInner, addNode) instead of a full rebuild — see M6 in
   *  the spatial-index refactor notes. Caller must only pass ids not already
   *  present in the grid — inserting an id that's already present would
   *  duplicate it in its cell array, corrupting every grid-backed query
   *  (each id must appear at most once across the whole grid). */
  private gridInsertNode(id: number, lat: number, lon: number): void {
    const cellSize = 0.01;
    const col = Math.floor(lon / cellSize);
    const row = Math.floor(lat / cellSize);
    const key = `${row}:${col}`;
    let ids = this.spatialGrid.get(key);
    if (!ids) {
      ids = [];
      this.spatialGrid.set(key, ids);
    }
    ids.push(id);
  }

  /** Incremental counterpart to buildSpatialIndex(): remove a single node id
   *  from the grid cell its (lat, lon) hashes to, deleting the cell entry
   *  entirely once it's empty (matching what a from-scratch rebuild would
   *  produce — an empty array left behind would make gridCandidateIds do
   *  pointless work forever, and would change nothing else, but there's no
   *  reason to leave the litter). Used by the incremental mutation sites
   *  (loadDatabaseGraphInner's overlay-deletion handling, unloadDatabaseGraph,
   *  addNode's upsert-move case, deleteNode) instead of a full rebuild. */
  private gridRemoveNode(id: number, lat: number, lon: number): void {
    const cellSize = 0.01;
    const col = Math.floor(lon / cellSize);
    const row = Math.floor(lat / cellSize);
    const key = `${row}:${col}`;
    const ids = this.spatialGrid.get(key);
    if (!ids) return;
    const idx = ids.indexOf(id);
    if (idx === -1) return;
    ids.splice(idx, 1);
    if (ids.length === 0) this.spatialGrid.delete(key);
  }

  /** Gather every node id in every grid cell overlapping the axis-aligned
   *  box [latitude-marginLatDeg, latitude+marginLatDeg] x
   *  [longitude-marginLonDeg, longitude+marginLonDeg] — a SUPERSET of any
   *  node within marginLatDeg/marginLonDeg of (latitude, longitude), never a
   *  subset: the row/col bounds are found by flooring the box's own edges
   *  with the exact same math buildSpatialIndex uses to assign a node to a
   *  cell, so any node whose coordinate lies inside the box necessarily
   *  falls in a visited cell (possibly along with some that don't — callers
   *  re-apply the same exact distance/margin filter the former full-scan
   *  code used on top of this, so results are unaffected; this only prunes
   *  candidates that filter would have rejected anyway). Callers doing a
   *  radius query pass a cos(lat)-corrected marginLonDeg (see M4 in the
   *  refactor notes) since 1° of longitude covers less ground than 1° of
   *  latitude away from the equator — using a plain marginLatDeg for both
   *  axes would under-cover longitude and silently drop real candidates. */
  private gridCandidateIds(latitude: number, longitude: number, marginLatDeg: number, marginLonDeg: number): number[] {
    const cellSize = 0.01;
    const minRow = Math.floor((latitude - marginLatDeg) / cellSize);
    const maxRow = Math.floor((latitude + marginLatDeg) / cellSize);
    const minCol = Math.floor((longitude - marginLonDeg) / cellSize);
    const maxCol = Math.floor((longitude + marginLonDeg) / cellSize);
    const result: number[] = [];
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const ids = this.spatialGrid.get(`${row}:${col}`);
        if (ids) result.push(...ids);
      }
    }
    return result;
  }

  hasNodeWithinRadius(lat: number, lon: number, radiusMeters: number): boolean {
    if (!this.graphLoaded) return false;
    const cellSize = 0.01;
    const radiusDeg = radiusMeters / 111320;
    const cells = Math.ceil(radiusDeg / cellSize);
    const centerCol = Math.floor(lon / cellSize);
    const centerRow = Math.floor(lat / cellSize);

    for (let dr = -cells; dr <= cells; dr++) {
      for (let dc = -cells; dc <= cells; dc++) {
        const key = `${centerRow + dr}:${centerCol + dc}`;
        const ids = this.spatialGrid.get(key);
        if (!ids) continue;
        for (const id of ids) {
          const c = this.nodes.get(id)!;
          const d = this.haversineMeters(lat, lon, c.lat, c.lon);
          if (d <= radiusMeters) return true;
        }
      }
    }
    return false;
  }

  getEdgeSync(source: number, target: number): EdgeRow | null {
    if (!this.graphLoaded) return null;
    const edges = this.edgesBySource.get(source);
    if (!edges) return null;
    return edges.find(e => e.target === target) || null;
  }

  /**
   * Walk the original (unsmoothed) A* path between `fromNode` and `toNode`
   * and aggregate every underlying edge's attributes — used whenever
   * path-smoothing (compressCollinear's pure node-position collinearity
   * check, or the optional LOS string-pulling in smoothPath) leaves two
   * smoothed-path nodes with no *direct* edge between them.
   *
   * Also concatenates each underlying edge's own `path_points` (plus the
   * coordinate of every original-path node strictly between fromNode and
   * toNode) into a single ordered polyline, so a stretch that happens to
   * span one or more funnel-upgraded navmesh edges still renders its real
   * curved geometry instead of buildRouteResult falling back to a flat
   * chord (see NEXT_PHASES.md, "Round 11"/"Round 12"). Direction is not an
   * issue here: getEdgeSync(source, target) always returns that edge's own
   * path_points already oriented source→target (upgradeRingBoundaryEdges
   * and addFunnelShortcutEdge both store each direction's edge row with its
   * own correctly-oriented path_points, mirroring how they're consumed
   * directly in buildRouteResult), so no reversal is needed when walking
   * originalPath forward.
   */
  aggregateSegmentEdges(fromNode: number, toNode: number, originalPath: number[]): EdgeRow | null {
    if (!this.graphLoaded) return null;

    const startIdx = originalPath.indexOf(fromNode);
    const endIdx = originalPath.indexOf(toNode);
    if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return null;

    let totalDist = 0;
    let minDepth = Infinity;
    let maxAirDraft = -Infinity;
    let minWidth = Infinity;
    let weightedCostFactor = 0;
    let trafficMode = TRAFFIC_TWO_WAY;
    let edgeTypeId = EDGE_TYPE_COASTAL;
    let crossesLand = 0;
    let crossesObstacle = 0;
    const pathPoints: Array<[number, number]> = [];

    for (let i = startIdx; i < endIdx; i++) {
      const edge = this.getEdgeSync(originalPath[i], originalPath[i + 1]);
      if (edge) {
        totalDist += edge.distance;
        if (typeof edge.min_depth === 'number' && edge.min_depth >= 0) minDepth = Math.min(minDepth, edge.min_depth);
        if (typeof edge.max_air_draft === 'number' && edge.max_air_draft >= 0) maxAirDraft = Math.min(maxAirDraft, edge.max_air_draft);
        if (typeof edge.min_width === 'number' && edge.min_width >= 0) minWidth = Math.min(minWidth, edge.min_width);
        weightedCostFactor += edge.cost_factor * edge.distance;
        // Preserve the most restrictive traffic direction across sub-edges.
        // REV (2) beats FWD (1) beats TWO_WAY (0) — never collapse to two-way.
        if (edge.traffic_mode === TRAFFIC_ONE_WAY_REV) trafficMode = TRAFFIC_ONE_WAY_REV;
        else if (edge.traffic_mode === TRAFFIC_ONE_WAY_FWD && trafficMode !== TRAFFIC_ONE_WAY_REV) trafficMode = TRAFFIC_ONE_WAY_FWD;
        edgeTypeId = edge.edge_type_id;
        if (edge.crosses_land === 1) crossesLand = 1;
        if (edge.crosses_obstacle === 1) crossesObstacle = 1;

        if (edge.path_points && edge.path_points.length > 0) pathPoints.push(...edge.path_points);
        // The intermediate original-path node itself is a real vertex of the
        // aggregated polyline (not just curve interior) — include it, except
        // after the final edge, whose target *is* toNode (added separately
        // by buildRouteResult, same as the single-edge path_points case).
        if (i < endIdx - 1) {
          const midNode = this.nodes.get(originalPath[i + 1]);
          if (midNode) pathPoints.push([midNode.lat, midNode.lon]);
        }
      }
    }

    return {
      source: fromNode,
      target: toNode,
      distance: totalDist,
      min_depth: minDepth === Infinity ? -1 : minDepth,
      max_air_draft: maxAirDraft === -Infinity ? -1 : maxAirDraft,
      min_width: minWidth === Infinity ? -1 : minWidth,
      cost_factor: totalDist > 0 ? weightedCostFactor / totalDist : 1.2,
      distance_to_land: 0,
      edge_type_id: edgeTypeId,
      traffic_mode: trafficMode,
      crosses_land: crossesLand,
      crosses_obstacle: crossesObstacle,
      ...(pathPoints.length > 0 ? { path_points: pathPoints } : {}),
    };
  }

  async updateNode(dbIndex: number, nodeId: number, updates: { node_depth?: number }): Promise<void> {
    const cur = this.nodes.get(nodeId);
    if (!cur) throw new Error(`Node ${nodeId} not found`);
    const node_depth = updates.node_depth ?? cur.nodeDepth;
    await this.sendMessage('updateNode', { dbIndex, nodeId, lat: cur.lat, lon: cur.lon, node_depth });
    cur.nodeDepth = node_depth;
  }

  async updateEdge(dbIndex: number, source: number, target: number, updates: {
    distance?: number; min_depth?: number; max_air_draft?: number;
    min_width?: number; traffic_mode?: number; cost_factor?: number;
  }): Promise<void> {
    const edges = this.edgesBySource.get(source);
    if (!edges) throw new Error(`No edges from source ${source}`);
    const edge = edges.find(e => e.target === target);
    if (!edge) throw new Error(`Edge ${source}->${target} not found`);
    if (updates.distance !== undefined && (updates.distance < 0 || !updates.distance)) {
      const s = this.nodes.get(source);
      const t = this.nodes.get(target);
      if (s && t) {
        updates.distance = Math.round(this.haversineMeters(s.lat, s.lon, t.lat, t.lon));
      }
    }
    // Send full edge context so the overlay can store a complete row
    await this.sendMessage('updateEdge', {
      dbIndex, source, target,
      distance_to_land: edge.distance_to_land ?? 0,
      edge_type_id: edge.edge_type_id ?? 0,
      ...updates,
    });
    if (updates.distance !== undefined) edge.distance = updates.distance;
    if (updates.min_depth !== undefined) edge.min_depth = updates.min_depth;
    if (updates.max_air_draft !== undefined) edge.max_air_draft = updates.max_air_draft;
    if (updates.min_width !== undefined) edge.min_width = updates.min_width;
    if (updates.traffic_mode !== undefined) edge.traffic_mode = updates.traffic_mode;
    if (updates.cost_factor !== undefined) edge.cost_factor = updates.cost_factor;
  }

  async deleteNode(dbIndex: number, nodeId: number): Promise<void> {
    this.edgesBySource.delete(nodeId);
    for (const [src, edges] of this.edgesBySource) {
      const filtered = edges.filter(e => e.target !== nodeId);
      if (filtered.length !== edges.length) this.edgesBySource.set(src, filtered);
    }
    // Capture coords before deleting so the grid entry (which was otherwise
    // left stale here — a latent bug, since queries now rely on the grid
    // instead of a full scan) can be removed from the correct cell too.
    const existing = this.nodes.get(nodeId);
    this.nodes.delete(nodeId);
    if (existing) this.gridRemoveNode(nodeId, existing.lat, existing.lon);
    this.invalidateBBoxCaches();
    await this.sendMessage('deleteNode', { dbIndex, nodeId });
  }

  async deleteEdge(dbIndex: number, source: number, target: number): Promise<void> {
    const edges = this.edgesBySource.get(source);
    if (edges) {
      const idx = edges.findIndex(e => e.target === target);
      if (idx >= 0) edges.splice(idx, 1);
    }
    this.invalidateBBoxCaches();
    await this.sendMessage('deleteEdge', { dbIndex, source, target });
  }

  async addNode(dbIndex: number, node: { id: number; lat: number; lon: number; node_depth?: number }): Promise<void> {
    await this.sendMessage('insertNode', { dbIndex, ...node });
    // This is an upsert (see handleUpsertNode) — an existing node id can be
    // re-added at a different (lat, lon), which would move it to a
    // different grid cell. Remove the stale grid entry at its old cell
    // first (no-op if this id is genuinely new) before inserting fresh, or
    // the id would be left behind in the wrong cell as well as duplicated.
    const existing = this.nodes.get(node.id);
    if (existing) this.gridRemoveNode(node.id, existing.lat, existing.lon);
    this.nodes.set(node.id, {
      lat: node.lat, lon: node.lon, regionId: 0,
      nodeDepth: node.node_depth ?? -1,
    });
    this.gridInsertNode(node.id, node.lat, node.lon);
    // addNode doesn't itself touch edgesBySource/pois, but a moved node's
    // stale coordinates could otherwise linger in edgeGrid via other edges'
    // source/target — invalidate for safety (over-invalidation is cheap).
    this.invalidateBBoxCaches();
  }

  async addEdge(dbIndex: number, edge: {
    source: number; target: number; distance: number;
    min_depth?: number; max_air_draft?: number; min_width?: number;
    cost_factor?: number; distance_to_land?: number;
    edge_type_id?: number; traffic_mode?: number;
  }): Promise<void> {
    const s = this.nodes.get(edge.source);
    const t = this.nodes.get(edge.target);
    if (!s || !t) throw new Error('Source or target node not found');
    if (!edge.distance || edge.distance <= 0) {
      edge.distance = Math.round(this.haversineMeters(s.lat, s.lon, t.lat, t.lon));
    }
    await this.sendMessage('insertEdge', { dbIndex, ...edge });
    const newEdge: EdgeRow = {
      source: edge.source,
      target: edge.target,
      distance: edge.distance,
      min_depth: edge.min_depth ?? -1,
      max_air_draft: edge.max_air_draft ?? -1,
      min_width: edge.min_width ?? -1,
      cost_factor: edge.cost_factor ?? 1.2,
      distance_to_land: edge.distance_to_land ?? 0,
      edge_type_id: edge.edge_type_id ?? 0,
      traffic_mode: edge.traffic_mode ?? 0,
    };
    if (!this.edgesBySource.has(edge.source)) {
      this.edgesBySource.set(edge.source, []);
    }
    this.edgesBySource.get(edge.source)!.push(newEdge);
    this.invalidateBBoxCaches();
  }

  async clearOverlayDeletedEdges(): Promise<{ restored: number }> {
    return this.sendMessage('clearOverlayDeletedEdges');
  }

  async close(): Promise<void> {
    if (this.worker) {
      try {
        await Promise.race([
          this.sendMessage('close'),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
      } catch { /* worker may already be dead */ }
      this.worker.terminate();
      this.worker = null;
    }
    this.nodes.clear();
    this.edgesBySource.clear();
    this.pois = [];
    this.navmeshRegions = [];
    this.spatialGrid.clear();
    this.poiGrid = null;
    this.edgeGrid = null;
    this.waterwaysGeoJson = null;
    this.waterwaysGeojsonPath = null;
    this.landGeoJson = null;
    this.landGeojsonPath = null;
    this.landBBoxIndex = null;
    this.graphLoaded = false;
    this.coverageIndex.clear();
    this.bulkFileList = [];
    this.nodesByDbIndex.clear();
    this.nodeDbCount.clear();
    this.loadingPromises.clear();
    this.overlayMergedOnce = false;
    this.activeRouteCount = 0;
    this.regionLastUsedAt.clear();
    this.lruCounter = 0;
  }

  /**
   * Hot-reload: close existing connection, re-scan data directory, and reload graph.
   * Used after downloading a new database to replace the old one.
   */
  async reload(): Promise<void> {
    await this.close();
    await this.init();
    await this.loadGraph();
  }

  private landGeoJson: any = null;
  private landGeojsonPath: string | null = null;
  private landBBoxIndex: Float64Array | null = null;

  isLineCrossingLand(lat1: number, lon1: number, lat2: number, lon2: number, numSamples: number): boolean {
    if (!this.landGeojsonPath) {
      this.landGeojsonPath = join(this.dbDir, 'land_polygons.geojson');
    }
    if (!this.landGeoJson) {
      if (!existsSync(this.landGeojsonPath)) {
        this.landGeoJson = { type: 'FeatureCollection', features: [] };
      } else {
        try {
          this.landGeoJson = JSON.parse(readFileSync(this.landGeojsonPath, 'utf-8'));
        } catch {
          this.landGeoJson = { type: 'FeatureCollection', features: [] };
        }
      }
    }

    const features: any[] = this.landGeoJson.features ?? [];
    if (features.length === 0) {
      return false;
    }

    if (!this.landBBoxIndex) {
      this.landBBoxIndex = buildBBoxIndex(features);
    }

    for (let i = 1; i < numSamples; i++) {
      const t = i / numSamples;
      const lat = lat1 + (lat2 - lat1) * t;
      const lon = lon1 + (lon2 - lon1) * t;
      if (this.isPointInAnyPolygon(lat, lon, features, this.landBBoxIndex)) return true;
    }
    return false;
  }

  private isPointInAnyPolygon(lat: number, lon: number, features: any[], bboxIndex: Float64Array | null): boolean {
    const idx = bboxIndex;
    const STRIDE = 5;
    if (idx) {
      const n = idx.length / STRIDE;
      for (let i = 0; i < n; i++) {
        const base = i * STRIDE;
        if (lon < idx[base] || lon > idx[base + 2] ||
            lat < idx[base + 1] || lat > idx[base + 3]) continue;
        const fi = idx[base + 4];
        const geom = features[fi]?.geometry;
        if (!geom) continue;
        if (geom.type === 'Polygon') {
          if (this.raycastPolygon(lon, lat, geom.coordinates)) return true;
        } else if (geom.type === 'MultiPolygon') {
          for (const poly of geom.coordinates) {
            if (this.raycastPolygon(lon, lat, poly)) return true;
          }
        }
      }
      return false;
    }
    for (const f of features) {
      const geom = f.geometry;
      if (!geom) continue;
      if (geom.type === 'Polygon') {
        if (this.raycastPolygon(lon, lat, geom.coordinates)) return true;
      } else if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates) {
          if (this.raycastPolygon(lon, lat, poly)) return true;
        }
      }
    }
    return false;
  }

  private raycastPolygon(x: number, y: number, rings: number[][][]): boolean {
    if (!this.raycastRing(x, y, rings[0])) return false;
    for (let h = 1; h < rings.length; h++) {
      if (this.raycastRing(x, y, rings[h])) return false;
    }
    return true;
  }

  private raycastRing(x: number, y: number, ring: number[][]): boolean {
    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
}

function buildBBoxIndex(features: any[]): Float64Array {
  const STRIDE = 5;
  const buf = new Float64Array(features.length * STRIDE);
  let count = 0;
  for (let fi = 0; fi < features.length; fi++) {
    const geom = features[fi]?.geometry;
    if (!geom) continue;
    const type = geom.type;
    if (type !== 'Polygon' && type !== 'MultiPolygon') continue;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const polys: number[][][] = type === 'MultiPolygon' ? geom.coordinates.map((p: number[][][]) => p[0]) : [geom.coordinates[0]];
    for (const ring of polys) {
      for (const pt of ring) {
        if (pt[0] < minLon) minLon = pt[0];
        if (pt[0] > maxLon) maxLon = pt[0];
        if (pt[1] < minLat) minLat = pt[1];
        if (pt[1] > maxLat) maxLat = pt[1];
      }
    }
    const base = count * STRIDE;
    buf[base] = minLon; buf[base + 1] = minLat;
    buf[base + 2] = maxLon; buf[base + 3] = maxLat;
    buf[base + 4] = fi;
    count++;
  }
  return buf.subarray(0, count * STRIDE);
}

function featureIntersectsBBox(
  feature: any,
  minLat: number, minLon: number,
  maxLat: number, maxLon: number,
): boolean {
  const coords = feature.geometry?.coordinates;
  if (!coords) return false;

  let fMinLat = Infinity, fMaxLat = -Infinity;
  let fMinLon = Infinity, fMaxLon = -Infinity;

  const type = feature.geometry.type;
  if (type === 'LineString') {
    for (const pt of coords) {
      const lon = pt[0], lat = pt[1];
      if (lat < fMinLat) fMinLat = lat;
      if (lat > fMaxLat) fMaxLat = lat;
      if (lon < fMinLon) fMinLon = lon;
      if (lon > fMaxLon) fMaxLon = lon;
    }
  } else if (type === 'MultiLineString') {
    for (const line of coords) {
      for (const pt of line) {
        const lon = pt[0], lat = pt[1];
        if (lat < fMinLat) fMinLat = lat;
        if (lat > fMaxLat) fMaxLat = lat;
        if (lon < fMinLon) fMinLon = lon;
        if (lon > fMaxLon) fMaxLon = lon;
      }
    }
  } else {
    const rings = type === 'MultiPolygon' ? coords.flat() : coords;
    for (const ring of rings) {
      for (const pt of ring) {
        const lon = pt[0], lat = pt[1];
        if (lat < fMinLat) fMinLat = lat;
        if (lat > fMaxLat) fMaxLat = lat;
        if (lon < fMinLon) fMinLon = lon;
        if (lon > fMaxLon) fMaxLon = lon;
      }
    }
  }

  return fMinLon <= maxLon && fMaxLon >= minLon &&
         fMinLat <= maxLat && fMaxLat >= minLat;
}
