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
}

interface PoiRow {
  id: number;
  name: string;
  type: string;
  lat: number;
  lon: number;
}

export class RoutingDatabase {
  private db: DatabaseSync;
  private dbPath: string;
  private nodes: Map<number, { lat: number; lon: number }> = new Map();
  private edgesBySource: Map<number, Array<EdgeRow & { lat: number; lon: number }>> = new Map();
  private graphLoaded: boolean = false;
  private spatialGrid: Map<string, number[]> = new Map();

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
    } catch (error: any) {
      throw new Error(`Failed to connect to routing database: ${error.message}`);
    }
  }

  async loadGraph(): Promise<void> {
    const nodes = this.db.prepare('SELECT id, lat, lon FROM nodes').all() as unknown as NodeRow[];
    for (const n of nodes) {
      this.nodes.set(n.id, { lat: n.lat, lon: n.lon });
    }
    this.buildSpatialIndex();

    const edges = this.db.prepare(
      `SELECT e.*, n.lat, n.lon
       FROM edges e
       JOIN nodes n ON e.target = n.id`
    ).all() as unknown as Array<EdgeRow & { lat: number; lon: number }>;

    for (const edge of edges) {
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

  async getOutgoingEdges(nodeId: number): Promise<Array<EdgeRow & { lat: number; lon: number }>> {
    if (this.graphLoaded) {
      return this.edgesBySource.get(nodeId) || [];
    }
    return this.db.prepare(
      `SELECT e.*, n.lat, n.lon
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
      `SELECT e.*, n.lat, n.lon
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
      `SELECT * FROM edges WHERE source IN (${placeholders})`
    ).all(...nodeIds) as unknown as EdgeRow[];
    for (const row of rows) {
      if (!result.has(row.source)) {
        result.set(row.source, []);
      }
      result.get(row.source)!.push(row);
    }
    return result;
  }

  async findNearestNode(latitude: number, longitude: number, maxDistanceMeters: number = 5000): Promise<number | null> {
    const query = `
      WITH candidates AS (
        SELECT id, lat, lon, distance FROM (
          SELECT id, lat, lon,
            (6371000 * acos(
              cos(radians(?)) * cos(radians(lat)) *
              cos(radians(lon) - radians(?)) +
              sin(radians(?)) * sin(radians(lat))
            )) as distance
          FROM nodes
        )
        WHERE distance <= ?
        ORDER BY distance ASC
        LIMIT 50
      )
      SELECT c.id,
        (SELECT COUNT(*) FROM edges WHERE source = c.id) as out_degree
      FROM candidates c
      ORDER BY out_degree DESC, c.distance ASC
      LIMIT 1
    `;
    const row = this.db.prepare(query).get(latitude, longitude, latitude, maxDistanceMeters) as any | undefined;
    return row ? row.id : null;
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

    for (let i = startIdx; i < endIdx; i++) {
      const edge = this.getEdgeSync(originalPath[i], originalPath[i + 1]);
      if (edge) {
        totalDist += edge.distance;
        if (edge.min_depth >= 0) minDepth = Math.min(minDepth, edge.min_depth);
        if (edge.max_air_draft >= 0) maxAirDraft = Math.max(maxAirDraft, edge.max_air_draft);
        if (edge.min_width >= 0) minWidth = Math.min(minWidth, edge.min_width);
        if (edge.is_fairway) isFairway = true;
        dirPenalty = Math.min(dirPenalty, edge.direction_penalty);
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
      lat: this.nodes.get(toNode)?.lat || 0,
      lon: this.nodes.get(toNode)?.lon || 0,
    };
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
