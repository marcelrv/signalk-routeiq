import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { PoiResult } from './types.js';
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
  lat: number;
  lon: number;
  source_lat?: number;
  source_lon?: number;
  /** Intermediate [lat,lon] points of a funnel-computed navmesh path along this
   *  edge (set only when this edge_kind_id=1 edge was upgraded from a straight
   *  fallback chord to a real taut path by precomputeFunnelEdges). */
  path_points?: Array<[number, number]>;
}

interface PoiRow {
  id: number;
  name: string;
  type_id: number;
  properties: string | null;
  lat: number;
  lon: number;
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
  private edgesBySource: Map<number, Array<EdgeRow & { lat: number; lon: number }>> = new Map();
  private pois: PoiRow[] = [];
  private navmeshRegions: Navmesh.NavmeshRegion[] = [];
  private spatialGrid: Map<string, number[]> = new Map();
  private hasCrossesLand: boolean = false;
  private hasCrossesObstacle: boolean = false;
  private hasNodeDepth: boolean = false;
  private hasRegionId: boolean = false;
  private metadataCache: Array<{
    id: number; country: string; name: string; description: string | null;
    lastUpdateDate: string; tags: string | null; boundingBox: string | null;
    boundaryGeometry: string | null; schemaVersion: number | null;
    contributor: string | null; url: string | null; filename: string;
  }> = [];

  /** Basenames of .sqlite files successfully loaded */
  private loadedDbFilenames: string[] = [];

  /** Cached database list for graph editor (populated during init) */
  private cachedDatabaseList: Array<{ index: number; filename: string; path: string }> = [];

  /** True once loadGraph() completes successfully */
  private graphLoaded: boolean = false;

  constructor(dbDir: string) {
    this.dbDir = dbDir;
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
    const schema = await this.sendMessage('init', { dbPaths });
    this.hasCrossesLand = schema.hasCrossesLand;
    this.hasCrossesObstacle = schema.hasCrossesObstacle;
    this.hasNodeDepth = schema.hasNodeDepth;
    this.hasRegionId = schema.hasRegionId;
    this.loadedDbFilenames = schema.filenames || [];
    this.cachedDatabaseList = dbPaths.map((p, i) => ({
      index: i,
      filename: this.loadedDbFilenames[i] || p.split('/').pop() || '',
      path: p,
    }));

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
  }>> {
    return this.sendMessage('getMetadata');
  }

  async getDatabaseInfo(): Promise<Array<{
    id: number; country: string; name: string; description: string | null;
    lastUpdateDate: string; tags: string[]; boundingBox: { min_lat: number; min_lon: number; max_lat: number; max_lon: number } | null;
    boundaryGeometry: any | null; schemaVersion: number | null;
    contributor: string | null; url: string | null; filename: string;
    stats: { nodes: number; edges: number; pois: number };
  }>> {
    const meta = this.metadataCache.length > 0 ? this.metadataCache : await this.getMetadata();
    const stats = await this.getStats();
    return meta.map(m => ({
      ...m,
      tags: m.tags ? JSON.parse(m.tags) : [],
      boundingBox: m.boundingBox ? JSON.parse(m.boundingBox) : null,
      boundaryGeometry: m.boundaryGeometry ? JSON.parse(m.boundaryGeometry) : null,
      stats: { nodes: stats.nodes, edges: stats.edges, pois: stats.pois },
    }));
  }

  /** Return loading status info */
  getLoadingStatus(): { loaded: boolean; filenames: string[] } {
    return {
      loaded: this.graphLoaded,
      filenames: this.loadedDbFilenames,
    };
  }

  /**
   * Re-scan the data directory for .sqlite files and refresh metadata cache.
   * Used after downloading a new database to show it in the installed list without restart.
   */
  async reloadMetadata(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.dbDir).filter(f => f.endsWith('.sqlite') && f !== 'user-edits.sqlite');
    } catch {
      this.metadataCache = [];
      return;
    }
    if (files.length === 0) {
      this.metadataCache = [];
      return;
    }

    const dbPaths = files.map(f => join(this.dbDir, f));
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'db-worker.js');
    const worker = new Worker(workerPath);

    try {
      const result = await new Promise<any[]>((resolve, reject) => {
        const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
        let msgId = 0;
        worker.on('message', (msg: { id: number; type: string; result?: any; error?: string }) => {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        });
        worker.on('error', reject);

        const send = (type: string, payload?: any) => new Promise<any>((res, rej) => {
          const id = ++msgId;
          pending.set(id, { resolve: res, reject: rej });
          worker.postMessage({ id, type, payload });
        });

        (async () => {
          await send('init', { dbPaths });
          const meta = await send('getMetadata');
          send('close').catch(() => {});
          setTimeout(() => worker.terminate(), 100);
          resolve(meta);
        })().catch(reject);
      });

      this.metadataCache = result;
    } catch {
      this.metadataCache = [];
      worker.terminate();
    }
  }

  private crossesLandCol(): string {
    return this.hasCrossesLand ? ', e.crosses_land' : '';
  }

  async loadGraph(): Promise<void> {
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
      const s = this.nodes.get(edge.source);
      const t = this.nodes.get(edge.target);
      if (!s || !t) continue;
      edge.lat = t.lat;
      edge.lon = t.lon;
      (edge as any).source_lat = s.lat;
      (edge as any).source_lon = s.lon;
      if (!this.edgesBySource.has(edge.source)) {
        this.edgesBySource.set(edge.source, []);
      }
      this.edgesBySource.get(edge.source)!.push(edge as any);
    }

    this.buildSpatialIndex();

    const allPois: Array<{ id: number; name: string; type_id: number; properties: string | null; lat: number; lon: number }> = await this.sendMessage('loadPois');
    this.pois.push(...allPois);

    // Cache metadata
    this.metadataCache = await this.getMetadata();

    const rawRegions: Array<{
      region_id: number; boundary_geometry: string; vertices: string;
      triangles: string; triangle_adjacency: string | null;
      boundary_node_ids: string; depth_ceiling_m: number;
    }> = await this.sendMessage('loadNavmeshRegions');
    this.navmeshRegions = rawRegions.map(r => Navmesh.buildNavmeshRegion(r, (id) => this.nodes.get(id)));
    this.precomputeFunnelEdges();

    this.graphLoaded = true;
  }

  /**
   * Upgrade Phase 1's straight-line edge_kind_id=1 fallback edges between a
   * region's boundary nodes to the real funnel-computed taut path (spec §6's
   * "prefer the funnel-computed path over the fallback edges" runtime
   * strategy), and add genuine interior shortcuts between the region's
   * anchors (see NEXT_PHASES.md's "Boundary Shortcut Sparsification" fix) —
   * done once here, at graph-load time, so astarSearch's per-edge relaxation
   * loop never has to know navmesh regions exist at all.
   */
  private precomputeFunnelEdges(): void {
    let emptyCount = 0;
    this.navmeshRegions.forEach((region, index) => {
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
      console.warn(`[routeiq] ${emptyCount}/${this.navmeshRegions.length} navmesh regions have empty ` +
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
  private addAnchorShortcutEdges(region: Navmesh.NavmeshRegion): void {
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
  private addFunnelShortcutEdge(region: Navmesh.NavmeshRegion, nodeA: number, nodeB: number): void {
    if (nodeA === nodeB) return;
    const alreadyDirectEdge = this.edgesBySource.get(nodeA)?.some(
      e => e.target === nodeB && e.edge_kind_id === EDGE_KIND_NAVMESH_BOUNDARY,
    );
    if (alreadyDirectEdge) return;

    const result = Navmesh.funnelBetweenNodes(region, nodeA, nodeB);
    if (!result) return;

    const a = this.nodes.get(nodeA);
    const b = this.nodes.get(nodeB);
    if (!a || !b) return;

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
    };

    if (!this.edgesBySource.has(nodeA)) this.edgesBySource.set(nodeA, []);
    this.edgesBySource.get(nodeA)!.push({
      ...shared, source: nodeA, target: nodeB,
      lat: b.lat, lon: b.lon, source_lat: a.lat, source_lon: a.lon,
      path_points: forwardPath,
    });

    if (!this.edgesBySource.has(nodeB)) this.edgesBySource.set(nodeB, []);
    this.edgesBySource.get(nodeB)!.push({
      ...shared, source: nodeB, target: nodeA,
      lat: a.lat, lon: a.lon, source_lat: b.lat, source_lon: b.lon,
      path_points: reversePath,
    });
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

  async getOutgoingEdges(nodeId: number): Promise<Array<EdgeRow & { lat: number; lon: number }>> {
    if (this.graphLoaded) {
      return this.edgesBySource.get(nodeId) || [];
    }
    return [];
  }

  async getEdge(source: number, target: number): Promise<EdgeRow & { lat: number; lon: number } | null> {
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
    for (const [id, c] of this.nodes) {
      if (Math.abs(c.lat - latitude) > marginDeg) continue;
      if (Math.abs(c.lon - longitude) > marginDeg / cosLat) continue;
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
    const candidates: Array<{ id: number; lat: number; lon: number; distance: number }> = [];
    for (const [id, c] of this.nodes) {
      if (c.regionId === 0) continue;
      if (Math.abs(c.lat - latitude) > marginDeg) continue;
      if (Math.abs(c.lon - longitude) > marginDeg / cosLat) continue;
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
    for (const [id, c] of this.nodes) {
      if (Math.abs(c.lat - latitude) > marginDeg) continue;
      if (Math.abs(c.lon - longitude) > marginDeg / cosLat) continue;
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
              const distToSource = this.haversineDistance(latitude, longitude, s.lat, s.lon);
              const distToTarget = this.haversineDistance(latitude, longitude, t.lat, t.lon);
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

  async getNodesInBBox(
    minLat: number, minLon: number,
    maxLat: number, maxLon: number,
    limit: number = 5000,
  ): Promise<Array<{ id: number; lat: number; lon: number; min_depth: number; region_id: number }>> {
    const results: Array<{ id: number; lat: number; lon: number; min_depth: number; region_id: number }> = [];
    for (const [id, c] of this.nodes) {
      if (c.lat >= minLat && c.lat <= maxLat && c.lon >= minLon && c.lon <= maxLon) {
        results.push({
          id, lat: c.lat, lon: c.lon,
          min_depth: c.nodeDepth,
          region_id: c.regionId,
        });
        if (results.length >= limit) break;
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
  }>> {
    const results: Array<{
      source: number; target: number;
      source_lat: number; source_lon: number;
      target_lat: number; target_lon: number;
      distance: number; min_depth: number; max_air_draft: number; min_width: number;
      edge_type_id: number; edge_kind_id: number; traffic_mode: number;
      cost_factor: number;
    }> = [];
    for (const [, edges] of this.edgesBySource) {
      for (const e of edges) {
        const slat = e.source_lat ?? 0;
        const slon = e.source_lon ?? 0;
        if ((slat >= minLat && slat <= maxLat && slon >= minLon && slon <= maxLon) ||
            (e.lat >= minLat && e.lat <= maxLat && e.lon >= minLon && e.lon <= maxLon)) {
          results.push({
            source: e.source, target: e.target,
            source_lat: slat, source_lon: slon,
            target_lat: e.lat, target_lon: e.lon,
            distance: e.distance, min_depth: e.min_depth,
            max_air_draft: e.max_air_draft, min_width: e.min_width,
            edge_type_id: e.edge_type_id, edge_kind_id: e.edge_kind_id ?? EDGE_KIND_CENTERLINE, traffic_mode: e.traffic_mode,
            cost_factor: e.cost_factor,
          });
          if (results.length >= limit) break;
        }
      }
      if (results.length >= limit) break;
    }
    return results;
  }

  async getPoisInBBox(
    minLat: number, minLon: number,
    maxLat: number, maxLon: number,
    limit: number = 2000,
  ): Promise<Array<{ id: number; name: string; typeId: number; properties: Record<string, unknown>; lat: number; lon: number }>> {
    const results: Array<{ id: number; name: string; typeId: number; properties: Record<string, unknown>; lat: number; lon: number }> = [];
    for (const row of this.pois) {
      if (row.lat >= minLat && row.lat <= maxLat && row.lon >= minLon && row.lon <= maxLon) {
        results.push({
          id: row.id, name: row.name, typeId: row.type_id,
          properties: row.properties ? JSON.parse(row.properties) : {},
          lat: row.lat, lon: row.lon,
        });
        if (results.length >= limit) break;
      }
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  async getNearestPoi(lat: number, lon: number, maxDistanceMeters: number = 250): Promise<{ id: number; name: string; typeId: number; properties: Record<string, unknown>; latitude: number; longitude: number; distance: number } | null> {
    let best: PoiRow | null = null;
    let bestDist = Infinity;
    for (const row of this.pois) {
      const d = this.haversineMeters(lat, lon, row.lat, row.lon);
      if (d < bestDist && d <= maxDistanceMeters) {
        bestDist = d;
        best = row;
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

  private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
          const d = this.haversineDistance(lat, lon, c.lat, c.lon);
          if (d <= radiusMeters) return true;
        }
      }
    }
    return false;
  }

  getEdgeSync(source: number, target: number): (EdgeRow & { lat: number; lon: number }) | null {
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
  aggregateSegmentEdges(fromNode: number, toNode: number, originalPath: number[]): (EdgeRow & { lat: number; lon: number }) | null {
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

    const toNodeCoords = this.nodes.get(toNode);
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
      lat: toNodeCoords?.lat || 0,
      lon: toNodeCoords?.lon || 0,
      ...(pathPoints.length > 0 ? { path_points: pathPoints } : {}),
    };
  }

  async getDatabaseList(): Promise<Array<{ index: number; filename: string; path: string }>> {
    return this.cachedDatabaseList;
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
        updates.distance = Math.round(this.haversineDistance(s.lat, s.lon, t.lat, t.lon));
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
    this.nodes.delete(nodeId);
    await this.sendMessage('deleteNode', { dbIndex, nodeId });
  }

  async deleteEdge(dbIndex: number, source: number, target: number): Promise<void> {
    const edges = this.edgesBySource.get(source);
    if (edges) {
      const idx = edges.findIndex(e => e.target === target);
      if (idx >= 0) edges.splice(idx, 1);
    }
    await this.sendMessage('deleteEdge', { dbIndex, source, target });
  }

  async addNode(dbIndex: number, node: { id: number; lat: number; lon: number; node_depth?: number }): Promise<void> {
    await this.sendMessage('insertNode', { dbIndex, ...node });
    this.nodes.set(node.id, {
      lat: node.lat, lon: node.lon, regionId: 0,
      nodeDepth: node.node_depth ?? -1,
    });
    this.spatialGrid.clear();
    this.buildSpatialIndex();
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
      edge.distance = Math.round(this.haversineDistance(s.lat, s.lon, t.lat, t.lon));
    }
    await this.sendMessage('insertEdge', { dbIndex, ...edge });
    const newEdge: EdgeRow & { lat: number; lon: number } = {
      source: edge.source,
      target: edge.target,
      source_lat: s.lat,
      source_lon: s.lon,
      distance: edge.distance,
      min_depth: edge.min_depth ?? -1,
      max_air_draft: edge.max_air_draft ?? -1,
      min_width: edge.min_width ?? -1,
      cost_factor: edge.cost_factor ?? 1.2,
      distance_to_land: edge.distance_to_land ?? 0,
      edge_type_id: edge.edge_type_id ?? 0,
      traffic_mode: edge.traffic_mode ?? 0,
      lat: t.lat,
      lon: t.lon,
    };
    if (!this.edgesBySource.has(edge.source)) {
      this.edgesBySource.set(edge.source, []);
    }
    this.edgesBySource.get(edge.source)!.push(newEdge);
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
    this.waterwaysGeoJson = null;
    this.waterwaysGeojsonPath = null;
    this.landGeoJson = null;
    this.landGeojsonPath = null;
    this.landBBoxIndex = null;
    this.graphLoaded = false;
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
