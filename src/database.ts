/**
 * SQLite database module for routing graph operations
 * Handles all interactions with the routing_graph.sqlite database
 */

import sqlite3 from 'sqlite3';
import { PoiResult } from './types.js';

// Typed database row interfaces
interface NodeRow {
  id: number;
  lat: number;
  lon: number;
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
}

interface PoiRow {
  id: number;
  name: string;
  type: string;
  lat: number;
  lon: number;
}

export class RoutingDatabase {
  private db: sqlite3.Database;
  private dbPath: string;
  private nodes: Map<number, { lat: number; lon: number }> = new Map();
  private edgesBySource: Map<number, Array<EdgeRow & { lat: number; lon: number }>> = new Map();
  private graphLoaded: boolean = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new sqlite3.Database(dbPath);
  }

  /**
   * Initialize database connection and verify schema
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM nodes', (err) => {
        if (err) {
          reject(new Error(`Failed to connect to routing database: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Load entire graph (nodes + edges) into memory for fast pathfinding
   */
  async loadGraph(): Promise<void> {
    // Load all nodes
    const nodes = await new Promise<NodeRow[]>((resolve, reject) => {
      this.db.all<NodeRow>('SELECT id, lat, lon FROM nodes', (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    for (const n of nodes) {
      this.nodes.set(n.id, { lat: n.lat, lon: n.lon });
    }

    // Load all edges joined with target node coords
    const edges = await new Promise<Array<EdgeRow & { lat: number; lon: number }>>((resolve, reject) => {
      this.db.all<EdgeRow & { lat: number; lon: number }>(
        `SELECT e.source, e.target, e.distance, e.min_depth, e.max_air_draft,
                e.min_width, e.is_fairway, e.direction_penalty, e.distance_to_land,
                n.lat, n.lon
         FROM edges e
         JOIN nodes n ON e.target = n.id`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
    for (const edge of edges) {
      if (!this.edgesBySource.has(edge.source)) {
        this.edgesBySource.set(edge.source, []);
      }
      this.edgesBySource.get(edge.source)!.push(edge);
    }

    this.graphLoaded = true;
  }

  /**
   * Get node coordinates by ID (serves from memory when graph is loaded)
   */
  async getNodeById(id: number): Promise<{ lat: number; lon: number } | null> {
    if (this.graphLoaded) {
      return this.nodes.get(id) || null;
    }
    return new Promise((resolve, reject) => {
      this.db.get<NodeRow>('SELECT lat, lon FROM nodes WHERE id = ?', [id], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row || null);
        }
      });
    });
  }

  /**
   * Get all outgoing edges from a node (serves from memory when graph is loaded)
   */
  async getOutgoingEdges(nodeId: number): Promise<Array<EdgeRow & { lat: number; lon: number }>> {
    if (this.graphLoaded) {
      return this.edgesBySource.get(nodeId) || [];
    }
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT e.*, n.lat, n.lon 
         FROM edges e 
         JOIN nodes n ON e.target = n.id 
         WHERE e.source = ?`,
        [nodeId],
        (err, rows: Array<EdgeRow & { lat: number; lon: number }> | undefined) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  }

  /**
   * Get a specific edge by source + target (from memory, falls back to SQL)
   */
  async getEdge(source: number, target: number): Promise<EdgeRow & { lat: number; lon: number } | null> {
    if (this.graphLoaded) {
      const edges = this.edgesBySource.get(source);
      if (edges) {
        const edge = edges.find(e => e.target === target);
        if (edge) return edge;
      }
    }
    // Fall back to SQL query
    return new Promise((resolve, reject) => {
      this.db.get<EdgeRow & { lat: number; lon: number }>(
        `SELECT e.*, n.lat, n.lon 
         FROM edges e 
         JOIN nodes n ON e.target = n.id 
         WHERE e.source = ? AND e.target = ?`,
        [source, target],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        }
      );
    });
  }

  /**
   * Get all edges from multiple source nodes (batch query)
   */
  async getEdgesBySources(nodeIds: number[]): Promise<Map<number, Array<EdgeRow>>> {
    const result = new Map<number, Array<EdgeRow>>();
    
    if (nodeIds.length === 0) {
      return result;
    }

    const placeholders = nodeIds.map(() => '?').join(', ');
    
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM edges WHERE source IN (${placeholders})`,
        nodeIds,
        (err, rows: EdgeRow[] | undefined) => {
          if (err) {
            reject(err);
          } else {
            (rows || []).forEach(row => {
              if (!result.has(row.source)) {
                result.set(row.source, []);
              }
              result.get(row.source)!.push(row);
            });
            resolve(result);
          }
        }
      );
    });
  }

  /**
   * Find nearest node ID to a given coordinate.
   * Prefers well-connected nodes (higher out-degree) to avoid picking
   * isolated nodes in tiny disconnected graph components.
   */
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

    return new Promise((resolve, reject) => {
      this.db.get<NodeRow & { distance: number; out_degree: number }>(query, [latitude, longitude, latitude, maxDistanceMeters], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.id : null);
        }
      });
    });
  }

  /**
   * Find the nearest node to a coordinate that is present in a given set of candidate IDs.
   */
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
    return new Promise((resolve, reject) => {
      this.db.get(query, [latitude, longitude, latitude, maxDistanceMeters], (err, row: any) => {
        if (err) reject(err);
        else resolve(row ? { id: row.id, lat: row.lat, lon: row.lon, distance: row.distance } : null);
      });
    });
  }

  /**
   * Get all node IDs reachable from a given start node via outgoing edges (BFS).
   * Uses the in-memory edge map when graph is loaded.
   */
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

  /**
   * Search POIs by name (fuzzy text search)
   */
  async searchPois(query: string, maxResults: number = 20): Promise<PoiResult[]> {
    const searchPattern = `%${query}%`;
    
    return new Promise((resolve, reject) => {
      this.db.all<PoiRow>(
        `SELECT id, name, type, lat, lon 
         FROM pois 
         WHERE name LIKE ? 
         ORDER BY name 
         LIMIT ?`,
        [searchPattern, maxResults],
        (err, rows: PoiRow[] | undefined) => {
          if (err) {
            reject(err);
          } else {
            resolve((rows || []).map(row => ({
              id: row.id,
              name: row.name,
              type: row.type,
              latitude: row.lat,
              longitude: row.lon,
            })));
          }
        }
      );
    });
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<{ nodes: number; edges: number; pois: number }> {
    return new Promise((resolve, reject) => {
      this.db.get<{ nodes: number; edges: number; pois: number }>(
        `SELECT 
          (SELECT COUNT(*) FROM nodes) as nodes,
          (SELECT COUNT(*) FROM edges) as edges,
          (SELECT COUNT(*) FROM pois) as pois`,
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row || { nodes: 0, edges: 0, pois: 0 });
          }
        }
      );
    });
  }

  /**
   * Close database connection
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
