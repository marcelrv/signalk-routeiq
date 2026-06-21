import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

interface NodeRow {
  id: number;
  lat: number;
  lon: number;
  node_depth: number;
  resolution: number;
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
  distance_to_land: number;
  edge_type_id: number;
  traffic_mode: number;
  crosses_land?: number;
  crosses_obstacle?: number;
}

interface PoiRow {
  id: number;
  name: string;
  type_id: number;
  properties: string | null;
  lat: number;
  lon: number;
}

interface DbHandle {
  db: DatabaseSync;
  path: string;
}

const handles: DbHandle[] = [];
const filenames: string[] = [];
let hasCrossesLand = false;
let hasCrossesObstacle = false;
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
        hasCrossesLand = false;
        hasCrossesObstacle = false;
        hasNodeDepth = false;
        hasRegionId = false;
        handles.length = 0;
        filenames.length = 0;
        for (const dbPath of dbPaths) {
          try {
            const db = new DatabaseSync(dbPath);
            const row = db.prepare('SELECT COUNT(*) as count FROM nodes').get() as unknown as { count: number } | undefined;
            if (!row) {
              console.warn(`[db-worker] Skipping ${dbPath}: nodes table not found`);
              db.close();
              continue;
            }
            const edgeCols = db.prepare("PRAGMA table_info('edges')").all() as Array<{ name: string }>;
            if (edgeCols.length === 0) {
              console.warn(`[db-worker] Skipping ${dbPath}: edges table not found`);
              db.close();
              continue;
            }
            // Merge schema flags across all valid databases
            hasCrossesLand = hasCrossesLand || edgeCols.some(c => c.name === 'crosses_land');
            hasCrossesObstacle = hasCrossesObstacle || edgeCols.some(c => c.name === 'crosses_obstacle');
            const nodeCols = db.prepare("PRAGMA table_info('nodes')").all() as Array<{ name: string }>;
            hasNodeDepth = hasNodeDepth || nodeCols.some(c => c.name === 'node_depth');
            hasRegionId = hasRegionId || nodeCols.some(c => c.name === 'region_id');
            const parts = dbPath.replace(/\\/g, '/').split('/');
            const filename = parts[parts.length - 1];
            handles.push({ db, path: dbPath });
            filenames.push(filename);
            console.log(`[db-worker] Loaded database: ${dbPath}`);
          } catch (err: any) {
            console.warn(`[db-worker] Skipping invalid database ${dbPath}: ${err.message ?? String(err)}`);
          }
        }
        const loadedFilenames = [...filenames];
        if (handles.length === 0) {
          parentPort!.postMessage({ id, type, error: 'No valid .sqlite routing databases found in the data directory' });
          break;
        }
        parentPort!.postMessage({ id, type, result: { hasCrossesLand, hasCrossesObstacle, hasNodeDepth, hasRegionId, filenames: loadedFilenames } });
        break;
      }
      case 'loadNodes': {
        const regionIdCol = hasRegionId ? 'region_id' : '0 AS region_id';
        const allNodes: NodeRow[] = [];
        for (const h of handles) {
          allNodes.push(...h.db.prepare(`SELECT id, lat, lon, node_depth, resolution, ${regionIdCol} FROM nodes`).all() as unknown as NodeRow[]);
        }
        parentPort!.postMessage({ id, type, result: allNodes });
        break;
      }
      case 'loadEdges': {
        const crossesCol = hasCrossesLand ? ', crosses_land' : '';
        const obstacleCol = hasCrossesObstacle ? ', crosses_obstacle' : '';
        let allEdges: EdgeRow[] = [];
        for (const h of handles) {
          const edges = h.db.prepare(
            `SELECT source, target, distance, min_depth, max_air_draft, min_width,
                    is_fairway, distance_to_land,
                    edge_type_id, traffic_mode${crossesCol}${obstacleCol}
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
        for (const h of handles) {
          try {
            // Some databases may not have a pois table
            const cols = h.db.prepare("PRAGMA table_info('pois')").all() as Array<{ name: string }>;
            if (cols.length === 0) continue;
            allPois.push(...h.db.prepare('SELECT id, name, type_id, properties, lat, lon FROM pois').all() as unknown as PoiRow[]);
          } catch {
            // Skip databases that don't have the pois table
            continue;
          }
        }
        parentPort!.postMessage({ id, type, result: allPois });
        break;
      }
      case 'getMetadata': {
        const results: Array<{
          id: number; country: string; name: string; description: string | null;
          lastUpdateDate: string; tags: string | null; boundingBox: string | null;
          boundaryGeometry: string | null; schemaVersion: number | null;
          contributor: string | null; url: string | null; filename: string;
        }> = [];
        for (const h of handles) {
          try {
            const metaCols = h.db.prepare("PRAGMA table_info('metadata')").all() as Array<{ name: string }>;
            const colNames = new Set(metaCols.map(c => c.name));
            const hasTags = colNames.has('tags');
            const hasBbox = colNames.has('bounding_box');
            const hasBoundary = colNames.has('boundary_geometry');
            const hasSchemaVer = colNames.has('schema_version');
            const hasContributor = colNames.has('contributor');
            const hasUrl = colNames.has('url');

            const sql = `SELECT id, country, name, description, last_update_date,
              ${hasTags ? 'tags' : 'NULL AS tags'},
              ${hasBbox ? 'bounding_box' : 'NULL AS bounding_box'},
              ${hasBoundary ? 'boundary_geometry' : 'NULL AS boundary_geometry'},
              ${hasSchemaVer ? 'schema_version' : 'NULL AS schema_version'},
              ${hasContributor ? 'contributor' : "'' AS contributor"},
              ${hasUrl ? 'url' : "'' AS url"}
              FROM metadata ORDER BY id`;
            const rows = h.db.prepare(sql).all() as Array<any>;
            const parts = h.path.replace(/\\/g, '/').split('/');
            const filename = parts[parts.length - 1];
            for (const r of rows) {
              results.push({
                id: r.id, country: r.country, name: r.name, description: r.description,
                lastUpdateDate: r.last_update_date,
                tags: r.tags ?? null,
                boundingBox: r.bounding_box ?? null,
                boundaryGeometry: r.boundary_geometry ?? null,
                schemaVersion: r.schema_version ?? null,
                contributor: r.contributor ?? null,
                url: r.url ?? null,
                filename,
              });
            }
            // If the DB has no metadata rows, still include a minimal entry so it shows in the installed list
            if (rows.length === 0) {
              results.push({
                id: 0, country: '', name: filename.replace('.sqlite', ''), description: null,
                lastUpdateDate: '', tags: null,
                boundingBox: null, boundaryGeometry: null,
                schemaVersion: null, contributor: null, url: null,
                filename,
              });
            }
          } catch {
            // metadata table might not exist in legacy DBs — include a minimal entry
            const parts = h.path.replace(/\\/g, '/').split('/');
            const filename = parts[parts.length - 1];
            results.push({
              id: 0, country: '', name: filename.replace('.sqlite', ''), description: null,
              lastUpdateDate: '', tags: null,
              boundingBox: null, boundaryGeometry: null,
              schemaVersion: null, contributor: null, url: null,
              filename,
            });
          }
        }
        parentPort!.postMessage({ id, type, result: results });
        break;
      }
      case 'updateNode': {
        const { dbIndex, nodeId, node_depth, resolution } = payload!;
        const h = handles[dbIndex];
        if (!h) throw new Error(`Database index ${dbIndex} not found`);
        const stmt = h.db.prepare('UPDATE nodes SET node_depth = ?, resolution = ? WHERE id = ?');
        stmt.run(node_depth, resolution, nodeId);
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case 'updateEdge': {
        const { dbIndex, source, target, distance, min_depth, max_air_draft, min_width, traffic_mode, is_fairway } = payload!;
        const h = handles[dbIndex];
        if (!h) throw new Error(`Database index ${dbIndex} not found`);
        const cols: string[] = [];
        const vals: any[] = [];
        if (distance !== undefined) { cols.push('distance = ?'); vals.push(distance); }
        if (min_depth !== undefined) { cols.push('min_depth = ?'); vals.push(min_depth); }
        if (max_air_draft !== undefined) { cols.push('max_air_draft = ?'); vals.push(max_air_draft); }
        if (min_width !== undefined) { cols.push('min_width = ?'); vals.push(min_width); }
        if (traffic_mode !== undefined) { cols.push('traffic_mode = ?'); vals.push(traffic_mode); }
        if (is_fairway !== undefined) { cols.push('is_fairway = ?'); vals.push(is_fairway); }
        if (cols.length === 0) throw new Error('No fields to update');
        vals.push(source, target);
        const stmt = h.db.prepare(`UPDATE edges SET ${cols.join(', ')} WHERE source = ? AND target = ?`);
        stmt.run(...vals);
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case 'deleteNode': {
        const { dbIndex, nodeId } = payload!;
        const h = handles[dbIndex];
        if (!h) throw new Error(`Database index ${dbIndex} not found`);
        h.db.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(nodeId, nodeId);
        h.db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case 'deleteEdge': {
        const { dbIndex, source, target } = payload!;
        const h = handles[dbIndex];
        if (!h) throw new Error(`Database index ${dbIndex} not found`);
        h.db.prepare('DELETE FROM edges WHERE source = ? AND target = ?').run(source, target);
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case 'insertNode': {
        const { dbIndex, id: nodeId, lat, lon, node_depth, resolution } = payload!;
        const h = handles[dbIndex];
        if (!h) throw new Error(`Database index ${dbIndex} not found`);
        h.db.prepare('INSERT INTO nodes (id, lat, lon, node_depth, resolution) VALUES (?, ?, ?, ?, ?)').run(nodeId, lat, lon, node_depth ?? -1, resolution ?? 0);
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case 'insertEdge': {
        const { dbIndex, source, target, distance, min_depth, max_air_draft, min_width, is_fairway, distance_to_land, edge_type_id, traffic_mode } = payload!;
        const h = handles[dbIndex];
        if (!h) throw new Error(`Database index ${dbIndex} not found`);
        h.db.prepare(
          `INSERT OR REPLACE INTO edges (source, target, distance, min_depth, max_air_draft, min_width, is_fairway, distance_to_land, edge_type_id, traffic_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(source, target, distance ?? 0, min_depth ?? -1, max_air_draft ?? -1, min_width ?? -1, is_fairway ?? 0, distance_to_land ?? 0, edge_type_id ?? 0, traffic_mode ?? 0);
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case 'close': {
        for (const h of handles) {
          try { h.db.close(); } catch { /* already closed */ }
        }
        handles.length = 0;
        filenames.length = 0;
        parentPort!.postMessage({ id, type, result: null });
        break;
      }
    }
  } catch (err: any) {
    parentPort!.postMessage({ id, type, error: err.message ?? String(err) });
  }
});
