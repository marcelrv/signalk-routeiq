import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PoiResult } from './types.js';

interface NodeRow {
  id: number;
  lat: number;
  lon: number;
  resolution?: number;
  node_type?: string;
}

export interface EdgeRow {
  source: number;
  target: number;
  distance: number;
  min_depth: number;
  max_air_draft: number;
  min_width: number;
  is_fairway: number;
  direction_penalty: number;
  distance_to_land: number;
  edge_type?: string;
  is_one_way?: number;
  traffic_dir?: number;
  crosses_land?: number; // 1 = edge crosses land (always 0 for post-pipeline graphs)
  // Target node coordinates (always populated by loading or queries)
  lat: number;
  lon: number;
  source_lat?: number;
  source_lon?: number;
}

interface PoiRow {
  id: number;
  name: string;
  type: string;
  lat: number;
  lon: number;
}

export interface EdgeSnapResult {
  source: number;
  target: number;
  fraction: number;       // 0-1 along edge from source→target
  point: { lat: number; lon: number };
  distance: number;        // perpendicular distance (meters)
  nearNode: number;        // nearer endpoint
  farNode: number;         // farther endpoint
  edge: EdgeRow;
}

export class RoutingDatabase {
  private db: DatabaseSync;
  private dbPath: string;
  private nodes: Map<number, { lat: number; lon: number }> = new Map();
  private edgesBySource: Map<number, Array<EdgeRow & { lat: number; lon: number }>> = new Map();
  private graphLoaded: boolean = false;
  private spatialGrid: Map<string, number[]> = new Map();
  // Flat bbox index for water polygons: [minLon, minLat, maxLon, maxLat, featureIndex]
  private waterBBoxIndex: Float64Array | null = null;
  private hasCrossesLand: boolean = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath, { open: true });
  }

  async init(): Promise<void> {
    try {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM nodes').get() as unknown as { count: number } | undefined;
      if (!row) {
        throw new Error('nodes table not found');
      }
      // Check for crosses_land column (added in schema v2 for land-crossing validation)
      const edgeCols = this.db.prepare("PRAGMA table_info('edges')").all() as Array<{ name: string }>;
      this.hasCrossesLand = edgeCols.some(c => c.name === 'crosses_land');
    } catch (error: any) {
      throw new Error(`Failed to connect to routing database: ${error.message}`);
    }
  }

  private crossesLandCol(): string {
    // Only include the column when it exists in the DB schema.
    // When absent (pre-schema-v2 databases), the field stays undefined in EdgeRow,
    // and isEdgeSafe() safely treats undefined === 1 as false (no false positives).
    return this.hasCrossesLand ? ', e.crosses_land' : '';
  }

  async loadGraph(): Promise<void> {
    const nodes = this.db.prepare('SELECT id, lat, lon FROM nodes').all() as unknown as NodeRow[];
    for (const n of nodes) {
      this.nodes.set(n.id, { lat: n.lat, lon: n.lon });
    }
    this.buildSpatialIndex();

    const edges = this.db.prepare(
      `SELECT e.*${this.crossesLandCol()},
              s.lat AS source_lat, s.lon AS source_lon,
              t.lat AS target_lat, t.lon AS target_lon
       FROM edges e
       JOIN nodes s ON e.source = s.id
       JOIN nodes t ON e.target = t.id`
    ).all() as unknown as Array<
      EdgeRow & {
        source_lat: number; source_lon: number;
        target_lat: number; target_lon: number;
      }
    >;

    for (const edge of edges) {
      edge.lat = edge.target_lat;
      edge.lon = edge.target_lon;
      if (!this.edgesBySource.has(edge.source)) {
        this.edgesBySource.set(edge.source, []);
      }
      this.edgesBySource.get(edge.source)!.push(edge);
    }

    this.graphLoaded = true;
  }

  async getNodeById(id: number): Promise<{ lat: number; lon: number } | null> {
    if (this.graphLoaded) {
      return this.nodes.get(id) || null;
    }
    const row = this.db.prepare('SELECT lat, lon FROM nodes WHERE id = ?').get(id) as unknown as NodeRow | undefined;
    return row || null;
  }

  /**
   * Synchronous node lookup — only valid when graph is loaded in memory.
   * Throws if graph is not loaded.
   */
  getNodeSync(id: number): { lat: number; lon: number } | null {
    if (!this.graphLoaded) {
      throw new Error('Graph must be loaded for synchronous node lookup');
    }
    return this.nodes.get(id) || null;
  }

  async getOutgoingEdges(nodeId: number): Promise<Array<EdgeRow & { lat: number; lon: number }>> {
    if (this.graphLoaded) {
      return this.edgesBySource.get(nodeId) || [];
    }
    return this.db.prepare(
      `SELECT e.*${this.crossesLandCol()}, n.lat, n.lon
       FROM edges e
       JOIN nodes n ON e.target = n.id
       WHERE e.source = ?`
    ).all(nodeId) as unknown as Array<EdgeRow & { lat: number; lon: number }>;
  }

  async getEdge(source: number, target: number): Promise<EdgeRow & { lat: number; lon: number } | null> {
    if (this.graphLoaded) {
      const edges = this.edgesBySource.get(source);
      if (edges) {
        const edge = edges.find(e => e.target === target);
        if (edge) return edge;
      }
    }
    const row = this.db.prepare(
      `SELECT e.*${this.crossesLandCol()}, n.lat, n.lon
       FROM edges e
       JOIN nodes n ON e.target = n.id
       WHERE e.source = ? AND e.target = ?`
    ).get(source, target) as unknown as (EdgeRow & { lat: number; lon: number }) | undefined;
    return row || null;
  }

  async getEdgesBySources(nodeIds: number[]): Promise<Map<number, Array<EdgeRow>>> {
    const result = new Map<number, Array<EdgeRow>>();
    if (nodeIds.length === 0) {
      return result;
    }
    const placeholders = nodeIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT e.*${this.crossesLandCol()} FROM edges AS e WHERE e.source IN (${placeholders})`
    ).all(...nodeIds) as unknown as EdgeRow[];
    for (const row of rows) {
      if (!result.has(row.source)) {
        result.set(row.source, []);
      }
      result.get(row.source)!.push(row);
    }
    return result;
  }

  async findNearestNode(latitude: number, longitude: number, maxDistanceMeters: number = 50000): Promise<number | null> {
    // Fast path: use the in-memory node map when the graph is loaded.
    // A single O(N) scan over the flat map is much faster than a SQLite
    // haversine sort on 100k+ rows with no index, and keeps the correct
    // "closest geometry" behaviour from the previous fix.
    if (this.graphLoaded) {
      let bestId: number | null = null;
      let bestDist = maxDistanceMeters;
      const latRad = latitude * Math.PI / 180;
      const cosLat = Math.cos(latRad);
      // Cheap equirectangular pre-filter: skip nodes outside a degree bounding box
      const marginDeg = maxDistanceMeters / 111320;
      for (const [id, c] of this.nodes) {
        if (Math.abs(c.lat - latitude) > marginDeg) continue;
        if (Math.abs(c.lon - longitude) > marginDeg / cosLat) continue;
        // Full haversine only for bbox candidates
        const dLat = (c.lat - latitude) * Math.PI / 180;
        const dLon = (c.lon - longitude) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + cosLat * Math.cos(c.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        const d = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (d < bestDist) { bestDist = d; bestId = id; }
      }
      return bestId;
    }

    // Slow path (graph not yet loaded): use SQLite with a bounding-box pre-filter
    // so the query uses lat/lon range scans instead of a full-table haversine sort.
    const marginDeg = maxDistanceMeters / 111320;
    const query = `
      SELECT id,
        (6371000 * acos(
          cos(radians(?)) * cos(radians(lat)) *
          cos(radians(lon) - radians(?)) +
          sin(radians(?)) * sin(radians(lat))
        )) as distance
      FROM nodes
      WHERE lat BETWEEN ? AND ?
        AND lon BETWEEN ? AND ?
      ORDER BY distance ASC
      LIMIT 1
    `;
    const row = this.db.prepare(query).get(
      latitude, longitude, latitude,
      latitude - marginDeg, latitude + marginDeg,
      longitude - marginDeg, longitude + marginDeg,
    ) as any | undefined;
    if (!row) return null;
    return row.distance <= maxDistanceMeters ? row.id : null;
  }

  async findNearestNodeInSet(latitude: number, longitude: number, candidates: Set<number>, maxDistanceMeters: number = 5000): Promise<{ id: number; lat: number; lon: number; distance: number } | null> {
    if (candidates.size === 0) return null;
    const placeholders = [...candidates].join(',');
    const query = `
      SELECT id, lat, lon,
        (6371000 * acos(
          cos(radians(?)) * cos(radians(lat)) *
          cos(radians(lon) - radians(?)) +
          sin(radians(?)) * sin(radians(lat))
        )) as distance
      FROM nodes
      WHERE id IN (${placeholders})
        AND distance <= ?
      ORDER BY distance ASC
      LIMIT 1
    `;
    const row = this.db.prepare(query).get(latitude, longitude, latitude, maxDistanceMeters) as any | undefined;
    return row ? { id: row.id, lat: row.lat, lon: row.lon, distance: row.distance } : null;
  }

  /**
   * Find the nearest graph edge to a point, with perpendicular projection.
   * Searches edges incident to nodes within ~2km via the spatial grid.
   * Returns null if no edge is found within maxDistMeters.
   */
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

    const visitedEdges = new Set<number>();
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
            const edgeKey = edge.source * 1000000 + edge.target;
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

  /**
   * Project a point onto a line segment in lat/lon space.
   * Uses Euclidean approximation (valid for short distances <2km).
   * Returns the projection fraction (0-1), projected point, and perpendicular distance in meters.
   */
  private projectOnEdge(
    ax: number, ay: number,
    bx: number, by: number,
    px: number, py: number,
  ): { fraction: number; point: { lat: number; lon: number }; distance: number } {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    if (lenSq < 1e-12) {
      const d = this.haversineDistance(py, px, ay, ax);
      return { fraction: 0, point: { lat: ay, lon: ax }, distance: d };
    }

    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const projLon = ax + t * dx;
    const projLat = ay + t * dy;
    const dist = this.haversineDistance(py, px, projLat, projLon);

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
          if (!visited.has(edge.target)) {
            visited.add(edge.target);
            queue.push(edge.target);
          }
        }
      }
    }
    return visited;
  }

  async searchPois(query: string, maxResults: number = 20): Promise<PoiResult[]> {
    const searchPattern = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT id, name, type, lat, lon
       FROM pois
       WHERE name LIKE ?
       ORDER BY name
       LIMIT ?`
    ).all(searchPattern, maxResults) as unknown as PoiRow[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      latitude: row.lat,
      longitude: row.lon,
    }));
  }

  async getStats(): Promise<{ nodes: number; edges: number; pois: number }> {
    const row = this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM nodes) as nodes,
        (SELECT COUNT(*) FROM edges) as edges,
        (SELECT COUNT(*) FROM pois) as pois`
    ).get() as unknown as { nodes: number; edges: number; pois: number } | undefined;
    return row || { nodes: 0, edges: 0, pois: 0 };
  }

  private hasNodeMetaColumns: boolean | null = null;

  private checkNodeMetaColumns(): boolean {
    if (this.hasNodeMetaColumns === null) {
      const cols = this.db.prepare("PRAGMA table_info('nodes')").all() as Array<{ name: string }>;
      this.hasNodeMetaColumns = cols.some(c => c.name === 'resolution') && cols.some(c => c.name === 'node_type');
    }
    return this.hasNodeMetaColumns;
  }

  async getNodesInBBox(
    minLat: number, minLon: number,
    maxLat: number, maxLon: number,
    limit: number = 5000,
  ): Promise<Array<{ id: number; lat: number; lon: number; resolution: number; node_type: string; min_depth: number }>> {
    const cols = this.checkNodeMetaColumns() ? 'n.id, n.lat, n.lon, n.resolution, n.node_type' : 'n.id, n.lat, n.lon';
    const rows = this.db.prepare(
      `SELECT ${cols},
              COALESCE((SELECT MIN(e.min_depth) FROM edges e WHERE e.source = n.id OR e.target = n.id), -1) AS min_depth
       FROM nodes n
       WHERE n.lat >= ? AND n.lat <= ? AND n.lon >= ? AND n.lon <= ?
       ORDER BY n.id
       LIMIT ?`
    ).all(minLat, maxLat, minLon, maxLon, limit) as unknown as (NodeRow & { min_depth: number })[];
    return rows.map((r: any) => ({
      id: r.id, lat: r.lat, lon: r.lon,
      resolution: r.resolution ?? 0,
      node_type: r.node_type ?? 'coastal',
      min_depth: r.min_depth ?? -1,
    }));
  }

  async getPoisInBBox(
    minLat: number, minLon: number,
    maxLat: number, maxLon: number,
    limit: number = 2000,
  ): Promise<Array<{ id: number; name: string; type: string; lat: number; lon: number }>> {
    const rows = this.db.prepare(
      `SELECT id, name, type, lat, lon
       FROM pois
       WHERE lat >= ? AND lat <= ? AND lon >= ? AND lon <= ?
       ORDER BY name
       LIMIT ?`
    ).all(minLat, maxLat, minLon, maxLon, limit) as unknown as PoiRow[];
    return rows.map(r => ({ id: r.id, name: r.name, type: r.type, lat: r.lat, lon: r.lon }));
  }

  private waterGeoJson: any = null;
  private waterGeojsonPath: string | null = null;

  /**
   * Return water polygon features (from coastal_water_polygons.geojson)
   * that intersect the given bounding box.
   */
  async getWaterPolygons(
    minLat: number, minLon: number,
    maxLat: number, maxLon: number,
  ): Promise<any[]> {
    // Derive GeoJSON path from SQLite path: same directory, different filename
    if (!this.waterGeojsonPath) {
      const dir = dirname(this.dbPath);
      this.waterGeojsonPath = join(dir, 'coastal_water_polygons.geojson');
    }

    // Load and cache the GeoJSON on first call
    if (!this.waterGeoJson) {
      if (!existsSync(this.waterGeojsonPath)) {
        this.waterGeoJson = { type: 'FeatureCollection', features: [] };
      } else {
        const raw = readFileSync(this.waterGeojsonPath, 'utf-8');
        try {
          this.waterGeoJson = JSON.parse(raw);
        } catch {
          this.waterGeoJson = { type: 'FeatureCollection', features: [] };
        }
      }
    }

    if (!this.waterGeoJson.features) return [];

    const result: any[] = [];
    for (const f of this.waterGeoJson.features) {
      if (featureIntersectsBBox(f, minLat, minLon, maxLat, maxLon)) {
        result.push(f);
      }
    }
    return result;
  }

  private waterwaysGeoJson: any = null;
  private waterwaysGeojsonPath: string | null = null;

  /**
   * Return waterway line features (from inland_waterways_lines.geojson)
   * that intersect the given bounding box.
   */
  async getWaterways(
    minLat: number, minLon: number,
    maxLat: number, maxLon: number,
  ): Promise<any[]> {
    if (!this.waterwaysGeojsonPath) {
      const dir = dirname(this.dbPath);
      this.waterwaysGeojsonPath = join(dir, 'inland_waterways_lines.geojson');
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

  aggregateSegmentEdges(fromNode: number, toNode: number, originalPath: number[]): (EdgeRow & { lat: number; lon: number }) | null {
    if (!this.graphLoaded) return null;

    const startIdx = originalPath.indexOf(fromNode);
    const endIdx = originalPath.indexOf(toNode);
    if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return null;

    let totalDist = 0;
    let minDepth = Infinity;
    let maxAirDraft = -Infinity;
    let minWidth = Infinity;
    let isFairway = false;
    let dirPenalty = 1;
    let crossesLand = 0;

    for (let i = startIdx; i < endIdx; i++) {
      const edge = this.getEdgeSync(originalPath[i], originalPath[i + 1]);
      if (edge) {
        totalDist += edge.distance;
        if (edge.min_depth >= 0) minDepth = Math.min(minDepth, edge.min_depth);
        if (edge.max_air_draft >= 0) maxAirDraft = Math.max(maxAirDraft, edge.max_air_draft);
        if (edge.min_width >= 0) minWidth = Math.min(minWidth, edge.min_width);
        if (edge.is_fairway) isFairway = true;
        dirPenalty = Math.min(dirPenalty, edge.direction_penalty);
        if (edge.crosses_land === 1) crossesLand = 1;
      }
    }

    return {
      source: fromNode,
      target: toNode,
      distance: totalDist,
      min_depth: minDepth === Infinity ? -1 : minDepth,
      max_air_draft: maxAirDraft === -Infinity ? -1 : maxAirDraft,
      min_width: minWidth === Infinity ? -1 : minWidth,
      is_fairway: isFairway ? 1 : 0,
      direction_penalty: dirPenalty,
      distance_to_land: 0,
      crosses_land: crossesLand,
      lat: this.nodes.get(toNode)?.lat || 0,
      lon: this.nodes.get(toNode)?.lon || 0,
    };
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }



   
  private landGeoJson: any = null;
  private landGeojsonPath: string | null = null;
  private landBBoxIndex: Float64Array | null = null;

  /**
   * Check whether any sampled points along a straight line fall inside a LAND polygon.
   */
  isLineCrossingLand(lat1: number, lon1: number, lat2: number, lon2: number, numSamples: number): boolean {
    if (!this.landGeojsonPath) {
      const dir = dirname(this.dbPath);
      this.landGeojsonPath = join(dir, 'land_polygons.geojson');
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
      return false; // If no land data, fail-open to rely on node-proximity
    }

    if (!this.landBBoxIndex) {
      // Re-use the bbox index builder for land features
      this.landBBoxIndex = buildBBoxIndex(features);
    }

    for (let i = 1; i < numSamples; i++) {
      const t = i / numSamples;
      const lat = lat1 + (lat2 - lat1) * t;
      const lon = lon1 + (lon2 - lon1) * t;
      // If ANY point hits a land polygon, the line crosses land!
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
    // Fallback if index isn't available
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

  /**
   * Ray-casting inside/outside test for a GeoJSON polygon ring array.
   * rings[0] = outer ring, rings[1..] = holes.
   */
  private raycastPolygon(x: number, y: number, rings: number[][][]): boolean {
    // Test outer ring
    if (!this.raycastRing(x, y, rings[0])) return false;
    // Subtract holes
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
} // end class RoutingDatabase

/**
 * Build a flat Float64Array bbox index over GeoJSON features for fast spatial rejection.
 * Layout per feature: [minLon, minLat, maxLon, maxLat, featureIndex] (5 values).
 * Only Polygon and MultiPolygon features are indexed.
 */
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

/**
 * Check whether a GeoJSON feature's bounding box overlaps a query bounding box.
 */
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
