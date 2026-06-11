import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

interface NodeRow {
  id: number;
  lat: number;
  lon: number;
  region_id?: number;
}

interface EdgeRow {
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
  crosses_land?: number;
}

interface PoiRow {
  id: number;
  name: string;
  type: string;
  properties: string | null;
  lat: number;
  lon: number;
}

const dbs: DatabaseSync[] = [];
let hasCrossesLand = false;
let hasNodeDepth = false;
let hasRegionId = false;

if (!parentPort) {
  throw new Error('db-worker must be run as a worker thread');
}

parentPort.on('message', (msg: { id: number; type: string; payload?: any }) => {
  const { id, type, payload } = msg;
  try {
    switch (type) {
      case 'init': {
        const { dbPaths } = payload!;
        for (const dbPath of dbPaths) {
          dbs.push(new DatabaseSync(dbPath, { open: true }));
        }
        const db = dbs[0];
        const row = db.prepare('SELECT COUNT(*) as count FROM nodes').get() as unknown as { count: number } | undefined;
        if (!row) throw new Error('nodes table not found');
        const edgeCols = db.prepare("PRAGMA table_info('edges')").all() as Array<{ name: string }>;
        hasCrossesLand = edgeCols.some(c => c.name === 'crosses_land');
        const nodeCols = db.prepare("PRAGMA table_info('nodes')").all() as Array<{ name: string }>;
        hasNodeDepth = nodeCols.some(c => c.name === 'node_depth');
        hasRegionId = nodeCols.some(c => c.name === 'region_id');
        parentPort!.postMessage({ id, type, result: { hasCrossesLand, hasNodeDepth, hasRegionId } });
        break;
      }
      case 'loadNodes': {
        const regionIdCol = hasRegionId ? 'region_id' : '0 AS region_id';
        const allNodes: NodeRow[] = [];
        for (const db of dbs) {
          allNodes.push(...db.prepare(`SELECT id, lat, lon, ${regionIdCol} FROM nodes`).all() as unknown as NodeRow[]);
        }
        parentPort!.postMessage({ id, type, result: allNodes });
        break;
      }
      case 'loadEdges': {
        const crossesCol = hasCrossesLand ? ', crosses_land' : '';
        let allEdges: EdgeRow[] = [];
        for (const db of dbs) {
          const edges = db.prepare(
            `SELECT source, target, distance, min_depth, max_air_draft, min_width,
                    is_fairway, direction_penalty, distance_to_land,
                    edge_type, is_one_way, traffic_dir${crossesCol}
             FROM edges`
          ).all() as unknown as EdgeRow[];
          allEdges = allEdges.concat(edges);
        }
        const CHUNK = 50000;
        for (let i = 0; i < allEdges.length; i += CHUNK) {
          const chunk = allEdges.slice(i, i + CHUNK);
          parentPort!.postMessage({ id, type, result: chunk, chunk: true, chunkIndex: i / CHUNK, totalChunks: Math.ceil(allEdges.length / CHUNK) });
        }
        parentPort!.postMessage({ id, type, result: null, chunk: false });
        break;
      }
      case 'loadPois': {
        const allPois: PoiRow[] = [];
        for (const db of dbs) {
          allPois.push(...db.prepare('SELECT id, name, type, properties, lat, lon FROM pois').all() as unknown as PoiRow[]);
        }
        parentPort!.postMessage({ id, type, result: allPois });
        break;
      }
      case 'getMetadata': {
        const results: Array<{ id: number; country: string; name: string; description: string | null; lastUpdateDate: string }> = [];
        for (const db of dbs) {
          try {
            const rows = db.prepare('SELECT id, country, name, description, last_update_date FROM metadata ORDER BY id').all() as Array<{
              id: number; country: string; name: string; description: string | null; last_update_date: string;
            }>;
            for (const r of rows) {
              results.push({ id: r.id, country: r.country, name: r.name, description: r.description, lastUpdateDate: r.last_update_date });
            }
          } catch {
            // metadata table might not exist in legacy DBs
          }
        }
        parentPort!.postMessage({ id, type, result: results });
        break;
      }
      case 'close': {
        for (const db of dbs) {
          try { db.close(); } catch { /* already closed */ }
        }
        dbs.length = 0;
        parentPort!.postMessage({ id, type, result: null });
        break;
      }
    }
  } catch (err: any) {
    parentPort!.postMessage({ id, type, error: err.message ?? String(err) });
  }
});
