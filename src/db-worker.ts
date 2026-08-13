import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { OVERLAY_EDITABLE_COLUMNS } from "./types.js";

interface NodeRow {
  id: number;
  lat: number;
  lon: number;
  node_depth: number;
  region_id?: number;
  /** Whether node_depth is a real reading (possibly negative -- a charted
   *  drying height) rather than "no data". See isDepthKnown below. */
  node_depth_known?: boolean;
}

interface EdgeRow {
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
  edge_kind_id: number;
  crosses_land?: number;
  crosses_obstacle?: number;
  /** Whether min_depth is a real reading (possibly negative -- a charted
   *  drying height) rather than "no data". See isDepthKnown below. */
  min_depth_known?: boolean;
}

interface NavmeshRegionRow {
  region_id: number;
  boundary_geometry: string;
  vertices: string;
  triangles: string;
  triangle_adjacency: string | null;
  boundary_node_ids: string;
  depth_ceiling_m: number;
}

interface PoiRow {
  id: number;
  name: string;
  type_id: number;
  properties: string | null;
  lat: number;
  lon: number;
}

interface SchemaFlags {
  hasCrossesLand: boolean;
  hasCrossesObstacle: boolean;
  hasNodeDepth: boolean;
  hasRegionId: boolean;
  hasEdgeKind: boolean;
  hasLockId: boolean;
}

interface DbHandle {
  db: DatabaseSync;
  path: string;
  /**
   * This file's own columns. The globals below OR-merge across every file
   * loaded, which is the right answer for "can any route report a lock" but
   * the wrong one for building a SELECT: a directory can hold databases from
   * different pipeline generations, and naming `lock_id` in a query against
   * one that predates the column fails the whole load.
   */
  flags: SchemaFlags;
  /** This file's `metadata.schema_version`, read once at open time (null if
   *  the file predates that column, or has no metadata row at all). Decides
   *  how min_depth/node_depth negatives are interpreted -- see
   *  DEPTH_SENTINEL_SCHEMA_VERSION below. */
  depthSchemaVersion: number | null;
}

// A distinct "unknown depth" sentinel (ROUTEIQ_NEXT_PHASES.md, "Negative
// charted depths are read as unknown"), and the metadata.schema_version a
// file must carry for -999/other-negative to mean that instead of the
// legacy "any negative is unknown" convention. Must match the pipeline's
// UNKNOWN_DEPTH / DEPTH_SENTINEL_SCHEMA_VERSION (nautical_routing_pipeline.py).
const UNKNOWN_DEPTH = -999;
const DEPTH_SENTINEL_SCHEMA_VERSION = 2;

/** Whether a raw min_depth/node_depth value represents a real (possibly
 *  negative, e.g. a charted drying height) reading rather than "no data".
 *  Computed once per row here, in the one place that knows which file --
 *  and therefore which schema convention -- the row came from, so every
 *  downstream consumer on the main thread can trust a plain boolean instead
 *  of re-deriving schema-version logic at each depth check. Files at or
 *  above DEPTH_SENTINEL_SCHEMA_VERSION use the distinct -999 sentinel and
 *  leave real negatives alone; older files (schemaVersion null or < 2) keep
 *  the legacy convention where any negative means unknown -- do not
 *  reinterpret those, some regions are 30-70% UNKNOWN_DEPTH by design. */
function isDepthKnown(value: number, schemaVersion: number | null): boolean {
  if (
    schemaVersion !== null &&
    schemaVersion >= DEPTH_SENTINEL_SCHEMA_VERSION
  ) {
    return value !== UNKNOWN_DEPTH;
  }
  return value >= 0;
}

// `handles` is tombstoned, not spliced, on a per-file close (closeDb): a
// closed slot becomes `null` in place rather than being removed, so every
// dbIndex handed out by `init`/`openDb` stays valid (and stable) for the
// rest of the worker's lifetime — the main thread's provenance bookkeeping
// (edgesBySource entries, navmesh regions, etc. tagged with a dbIndex) would
// otherwise silently point at the wrong handle after any close. Every loop
// below that walks `handles` must skip `null` slots.
const handles: (DbHandle | null)[] = [];
const filenames: string[] = [];
/** Sentinel dbIndex used to tag rows that came from the user-edits overlay
 *  rather than any real per-file handle — never matches a real dbIndex, so
 *  overlay rows are never touched by a per-file unload. */
const OVERLAY_DB_INDEX = -1;
let hasCrossesLand = false;
let hasCrossesObstacle = false;
let hasNodeDepth = false;
let hasRegionId = false;
let hasEdgeKind = false;
let hasLockId = false;
let overlayHandle: DbHandle | null = null;

if (!parentPort) {
  throw new Error("db-worker must be run as a worker thread");
}

function detectSchemaFlags(db: DatabaseSync): SchemaFlags & {
  edgeCols: Array<{ name: string }>;
  nodeCols: Array<{ name: string }>;
} {
  const edgeCols = db.prepare("PRAGMA table_info('edges')").all() as Array<{
    name: string;
  }>;
  const nodeCols = db.prepare("PRAGMA table_info('nodes')").all() as Array<{
    name: string;
  }>;
  return {
    hasCrossesLand: edgeCols.some((c) => c.name === "crosses_land"),
    hasCrossesObstacle: edgeCols.some((c) => c.name === "crosses_obstacle"),
    hasEdgeKind: edgeCols.some((c) => c.name === "edge_kind_id"),
    // Pipeline-built databases say which lock an edge passes through; the
    // nv-chart conversion has no such column. Detected rather than assumed, the
    // same way the others here are.
    hasLockId: edgeCols.some((c) => c.name === "lock_id"),
    hasNodeDepth: nodeCols.some((c) => c.name === "node_depth"),
    hasRegionId: nodeCols.some((c) => c.name === "region_id"),
    edgeCols,
    nodeCols,
  };
}

function filenameOf(dbPath: string): string {
  const parts = dbPath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1];
}

/** Read a single database's metadata row in the same tolerant shape
 *  `getMetadata` uses (missing columns/table degrade to nulls rather than
 *  throwing) — shared by `peekMetadata` (short-lived handle) and
 *  `getMetadata` (long-lived handles). */
function readMetadataRow(
  db: DatabaseSync,
  filename: string,
): {
  id: number;
  country: string;
  name: string;
  description: string | null;
  lastUpdateDate: string;
  tags: string | null;
  boundingBox: string | null;
  boundaryGeometry: string | null;
  schemaVersion: number | null;
  contributor: string | null;
  url: string | null;
  filename: string;
} | null {
  try {
    const metaCols = db
      .prepare("PRAGMA table_info('metadata')")
      .all() as Array<{ name: string }>;
    if (metaCols.length === 0) return null;
    const colNames = new Set(metaCols.map((c) => c.name));
    const sql = `SELECT id, country, name, description, last_update_date,
      ${colNames.has("tags") ? "tags" : "NULL AS tags"},
      ${colNames.has("bounding_box") ? "bounding_box" : "NULL AS bounding_box"},
      ${colNames.has("boundary_geometry") ? "boundary_geometry" : "NULL AS boundary_geometry"},
      ${colNames.has("schema_version") ? "schema_version" : "NULL AS schema_version"},
      ${colNames.has("contributor") ? "contributor" : "'' AS contributor"},
      ${colNames.has("url") ? "url" : "'' AS url"}
      FROM metadata LIMIT 1`;
    const r = db.prepare(sql).get() as any;
    if (!r) return null;
    return {
      id: r.id,
      country: r.country,
      name: r.name,
      description: r.description,
      lastUpdateDate: r.last_update_date,
      tags: r.tags ?? null,
      boundingBox: r.bounding_box ?? null,
      boundaryGeometry: r.boundary_geometry ?? null,
      schemaVersion: r.schema_version ?? null,
      contributor: r.contributor ?? null,
      url: r.url ?? null,
      filename,
    };
  } catch {
    return null;
  }
}

/** Per-file node/edge/POI counts for a single open handle — each handle is
 *  its own sqlite connection to one installed .sqlite, so this is a true
 *  per-database count, unlike the in-memory graph totals (which are the
 *  union of whatever databases happen to be currently loaded). */
function readStatsRow(db: DatabaseSync): {
  nodes: number;
  edges: number;
  pois: number;
} {
  const nodes =
    (
      db.prepare("SELECT COUNT(*) as c FROM nodes").get() as
        | { c: number }
        | undefined
    )?.c ?? 0;
  const edges =
    (
      db.prepare("SELECT COUNT(*) as c FROM edges").get() as
        | { c: number }
        | undefined
    )?.c ?? 0;
  let pois = 0;
  try {
    const cols = db.prepare("PRAGMA table_info('pois')").all() as Array<{
      name: string;
    }>;
    if (cols.length > 0) {
      pois =
        (
          db.prepare("SELECT COUNT(*) as c FROM pois").get() as
            | { c: number }
            | undefined
        )?.c ?? 0;
    }
  } catch {
    // no pois table
  }
  return { nodes, edges, pois };
}

parentPort.on("message", (msg: { id: number; type: string; payload?: any }) => {
  const { id, type, payload } = msg;
  try {
    switch (type) {
      case "init": {
        const { dbPaths } = payload!;
        hasCrossesLand = false;
        hasCrossesObstacle = false;
        hasNodeDepth = false;
        hasRegionId = false;
        hasEdgeKind = false;
        hasLockId = false;
        handles.length = 0;
        filenames.length = 0;
        for (const dbPath of dbPaths) {
          try {
            const db = new DatabaseSync(dbPath);
            const row = db
              .prepare("SELECT COUNT(*) as count FROM nodes")
              .get() as unknown as { count: number } | undefined;
            if (!row) {
              console.warn(
                `[db-worker] Skipping ${dbPath}: nodes table not found`,
              );
              db.close();
              continue;
            }
            const flags = detectSchemaFlags(db);
            if (flags.edgeCols.length === 0) {
              console.warn(
                `[db-worker] Skipping ${dbPath}: edges table not found`,
              );
              db.close();
              continue;
            }
            // Merge schema flags across all valid databases
            hasCrossesLand = hasCrossesLand || flags.hasCrossesLand;
            hasCrossesObstacle = hasCrossesObstacle || flags.hasCrossesObstacle;
            hasEdgeKind = hasEdgeKind || flags.hasEdgeKind;
            hasLockId = hasLockId || flags.hasLockId;
            hasNodeDepth = hasNodeDepth || flags.hasNodeDepth;
            hasRegionId = hasRegionId || flags.hasRegionId;
            const filename = filenameOf(dbPath);
            const depthSchemaVersion =
              readMetadataRow(db, filename)?.schemaVersion ?? null;
            handles.push({ db, path: dbPath, flags, depthSchemaVersion });
            filenames.push(filename);
            console.log(`[db-worker] Loaded database: ${dbPath}`);
          } catch (err: any) {
            console.warn(
              `[db-worker] Skipping invalid database ${dbPath}: ${err.message ?? String(err)}`,
            );
          }
        }
        const loadedFilenames = [...filenames];
        if (handles.length === 0) {
          parentPort!.postMessage({
            id,
            type,
            error:
              "No valid .sqlite routing databases found in the data directory",
          });
          break;
        }
        parentPort!.postMessage({
          id,
          type,
          result: {
            hasCrossesLand,
            hasCrossesObstacle,
            hasNodeDepth,
            hasRegionId,
            filenames: loadedFilenames,
          },
        });
        break;
      }
      case "peekMetadata": {
        // Open each file just long enough to read its metadata row and
        // schema-capability flags, then close it — a coverage index must
        // never hold N file handles open just to know N bounding boxes.
        const { dbPaths } = payload!;
        const results: Array<{
          path: string;
          filename: string;
          coverage: { boundingBox: any; boundaryGeometry: any };
          meta: ReturnType<typeof readMetadataRow>;
          flags: SchemaFlags;
          stats: ReturnType<typeof readStatsRow>;
        }> = [];
        for (const dbPath of dbPaths) {
          let db: DatabaseSync | null = null;
          try {
            db = new DatabaseSync(dbPath);
            const row = db
              .prepare("SELECT COUNT(*) as count FROM nodes")
              .get() as unknown as { count: number } | undefined;
            if (!row) {
              console.warn(
                `[db-worker] peekMetadata: skipping ${dbPath}: nodes table not found`,
              );
              continue;
            }
            const { edgeCols, nodeCols, ...flags } = detectSchemaFlags(db);
            if (edgeCols.length === 0) {
              console.warn(
                `[db-worker] peekMetadata: skipping ${dbPath}: edges table not found`,
              );
              continue;
            }
            void nodeCols;
            const filename = filenameOf(dbPath);
            const meta = readMetadataRow(db, filename);
            // Cheap while the handle's already open for this peek -- lets
            // an installed-but-not-yet-loaded database report the same
            // node/edge/POI counts a loaded one gets from getMetadata's
            // readStatsRow, instead of leaving them blank until it loads.
            const stats = readStatsRow(db);
            results.push({
              path: dbPath,
              filename,
              coverage: {
                boundingBox: meta?.boundingBox
                  ? JSON.parse(meta.boundingBox)
                  : null,
                boundaryGeometry: meta?.boundaryGeometry
                  ? JSON.parse(meta.boundaryGeometry)
                  : null,
              },
              meta,
              flags,
              stats,
            });
          } catch (err: any) {
            console.warn(
              `[db-worker] peekMetadata: skipping invalid database ${dbPath}: ${err.message ?? String(err)}`,
            );
          } finally {
            if (db) {
              try {
                db.close();
              } catch {
                /* already closed */
              }
            }
          }
        }
        parentPort!.postMessage({ id, type, result: results });
        break;
      }
      case "openDb": {
        // Open exactly one handle (dynamic per-file load) and append it to
        // `handles` — always appended, never inserted into a tombstoned
        // slot, so a dbIndex is assigned once and never reused for the life
        // of the worker.
        const { dbPath } = payload!;
        const db = new DatabaseSync(dbPath);
        const row = db
          .prepare("SELECT COUNT(*) as count FROM nodes")
          .get() as unknown as { count: number } | undefined;
        if (!row) {
          db.close();
          throw new Error(`Invalid database (no nodes table): ${dbPath}`);
        }
        const { edgeCols, nodeCols, ...flags } = detectSchemaFlags(db);
        void nodeCols;
        if (edgeCols.length === 0) {
          db.close();
          throw new Error(`Invalid database (no edges table): ${dbPath}`);
        }
        // Sticky OR-merge, same convention as bulk `init` — a flag once true
        // (e.g. some loaded file has crosses_land) stays true for the life of
        // the worker even if that specific file is later closed. This says
        // what the loaded set can offer, and nothing more: the SQL in
        // loadNodes/loadEdges is built from each handle's own flags, because
        // a routing-data directory really does mix pipeline generations (a
        // database downloaded before `lock_id` existed alongside one built
        // after).
        hasCrossesLand = hasCrossesLand || flags.hasCrossesLand;
        hasCrossesObstacle = hasCrossesObstacle || flags.hasCrossesObstacle;
        hasEdgeKind = hasEdgeKind || flags.hasEdgeKind;
        hasLockId = hasLockId || flags.hasLockId;
        hasNodeDepth = hasNodeDepth || flags.hasNodeDepth;
        hasRegionId = hasRegionId || flags.hasRegionId;

        const filename = filenameOf(dbPath);
        const dbIndex = handles.length;
        const depthSchemaVersion =
          readMetadataRow(db, filename)?.schemaVersion ?? null;
        handles.push({ db, path: dbPath, flags, depthSchemaVersion });
        filenames.push(filename);
        console.log(
          `[db-worker] Opened database on demand: ${dbPath} (dbIndex=${dbIndex})`,
        );
        parentPort!.postMessage({
          id,
          type,
          result: { dbIndex, filename, flags },
        });
        break;
      }
      case "closeDb": {
        const { dbIndex } = payload!;
        const h = handles[dbIndex];
        if (h) {
          try {
            h.db.close();
          } catch {
            /* already closed */
          }
          handles[dbIndex] = null;
          console.log(
            `[db-worker] Closed database dbIndex=${dbIndex} (${h.path})`,
          );
        }
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case "openOverlay": {
        const { overlayPath } = payload!;
        try {
          const db = new DatabaseSync(overlayPath, { open: true });
          db.prepare(
            `CREATE TABLE IF NOT EXISTS nodes (
            id INTEGER PRIMARY KEY, lat REAL, lon REAL,
            node_depth REAL DEFAULT -1
          )`,
          ).run();
          db.prepare(
            `CREATE TABLE IF NOT EXISTS edges (
            source INTEGER, target INTEGER,
            distance REAL DEFAULT 0, min_depth REAL DEFAULT -1,
            max_air_draft REAL DEFAULT -1, min_width REAL DEFAULT -1,
            cost_factor REAL DEFAULT 1.2, distance_to_land REAL DEFAULT 0,
            edge_type_id INTEGER DEFAULT 0, traffic_mode INTEGER DEFAULT 0,
            edited_fields TEXT,
            PRIMARY KEY (source, target)
          )`,
          ).run();
          db.prepare(
            "CREATE TABLE IF NOT EXISTS deleted_nodes (node_id INTEGER PRIMARY KEY)",
          ).run();
          db.prepare(
            "CREATE TABLE IF NOT EXISTS deleted_edges (source INTEGER, target INTEGER, PRIMARY KEY (source, target))",
          ).run();
          // Migrate overlay from old is_fairway schema to cost_factor
          const edgeCols = db
            .prepare("PRAGMA table_info('edges')")
            .all() as Array<{ name: string }>;
          const colNames = edgeCols.map((c) => c.name);
          if (
            colNames.includes("is_fairway") &&
            !colNames.includes("cost_factor")
          ) {
            db.prepare(
              "ALTER TABLE edges ADD COLUMN cost_factor REAL DEFAULT 1.2",
            ).run();
            db.prepare(
              "UPDATE edges SET cost_factor = CASE WHEN is_fairway = 1 THEN 0.8 ELSE 1.2 END",
            ).run();
            console.log(
              "[db-worker] Migrated overlay edges: is_fairway → cost_factor",
            );
          }
          // Which columns of an overlay row the user actually set. Without it
          // a row cannot say whether `distance = 0` is a measurement or the
          // placeholder updateEdge writes for a column the edit never
          // mentioned — which is why an edit could not simply outrank the
          // region file's own row. Rows written before this column existed
          // stay NULL and keep the old conservative merge; there is no way to
          // recover after the fact which of their columns were meant.
          if (!colNames.includes("edited_fields")) {
            db.prepare("ALTER TABLE edges ADD COLUMN edited_fields TEXT").run();
            console.log("[db-worker] Migrated overlay edges: + edited_fields");
          }
          // Backfill reverse edges for bidirectional (traffic_mode=0) overlay edges that are missing their reverse.
          // Skip any reverse that the user explicitly deleted.
          const fwdEdges = db
            .prepare(
              "SELECT source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edited_fields FROM edges WHERE traffic_mode = 0",
            )
            .all() as Array<{
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
            edited_fields: string | null;
          }>;
          // The reverse carries the same edited_fields: an edit to a
          // two-way edge is an edit to the waterway, not to one direction of
          // travel, and a reverse that forgot which columns were meant would
          // fall back to the conservative merge and disagree with its twin.
          const insertRev = db.prepare(
            "INSERT OR IGNORE INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edited_fields) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          );
          // Prepared once: node:sqlite compiles a fresh statement per
          // prepare() call, so leaving these in the loop recompiles both on
          // every edge.
          const selectReverse = db.prepare(
            "SELECT 1 FROM edges WHERE source=? AND target=?",
          );
          const selectDeleted = db.prepare(
            "SELECT 1 FROM deleted_edges WHERE source=? AND target=?",
          );
          let backfilled = 0;
          for (const e of fwdEdges) {
            const rev = selectReverse.get(e.target, e.source);
            if (rev) continue;
            const wasDeleted = selectDeleted.get(e.target, e.source);
            if (wasDeleted) continue;
            insertRev.run(
              e.target,
              e.source,
              e.distance,
              e.min_depth,
              e.max_air_draft,
              e.min_width,
              e.cost_factor,
              e.distance_to_land,
              e.edge_type_id,
              e.traffic_mode,
              e.edited_fields,
            );
            backfilled++;
          }
          if (backfilled > 0)
            console.log(
              `[db-worker] Backfilled ${backfilled} missing reverse edges in overlay`,
            );
          // The overlay is created by this plugin, so its schema is known —
          // detected anyway rather than asserted, since an overlay written by
          // an older version outlives the upgrade that changed the schema.
          overlayHandle = {
            db,
            path: overlayPath,
            flags: detectSchemaFlags(db),
            // User-entered edits, not pipeline output -- always legacy
            // semantics (isDepthKnown's null branch: negative = unknown).
            depthSchemaVersion: null,
          };
          console.log(`[db-worker] Overlay opened: ${overlayPath}`);
          parentPort!.postMessage({ id, type, result: { success: true } });
        } catch (err: any) {
          parentPort!.postMessage({
            id,
            type,
            error: err.message ?? String(err),
          });
        }
        break;
      }
      case "getDeletedNodeIds": {
        if (!overlayHandle) {
          parentPort!.postMessage({ id, type, result: [] });
          break;
        }
        const rows = overlayHandle.db
          .prepare("SELECT node_id FROM deleted_nodes")
          .all() as { node_id: number }[];
        parentPort!.postMessage({
          id,
          type,
          result: rows.map((r) => r.node_id),
        });
        break;
      }
      case "getDeletedEdgePairs": {
        if (!overlayHandle) {
          parentPort!.postMessage({ id, type, result: [] });
          break;
        }
        const rows = overlayHandle.db
          .prepare("SELECT source, target FROM deleted_edges")
          .all() as { source: number; target: number }[];
        parentPort!.postMessage({ id, type, result: rows });
        break;
      }
      case "getOverlayStats": {
        if (!overlayHandle) {
          parentPort!.postMessage({
            id,
            type,
            result: { nodes: 0, edges: 0, deletedNodes: 0, deletedEdges: 0 },
          });
          break;
        }
        const oNodes = (
          overlayHandle.db.prepare("SELECT COUNT(*) as c FROM nodes").get() as {
            c: number;
          }
        ).c;
        const oEdges = (
          overlayHandle.db.prepare("SELECT COUNT(*) as c FROM edges").get() as {
            c: number;
          }
        ).c;
        const oDelNodes = (
          overlayHandle.db
            .prepare("SELECT COUNT(*) as c FROM deleted_nodes")
            .get() as { c: number }
        ).c;
        const oDelEdges = (
          overlayHandle.db
            .prepare("SELECT COUNT(*) as c FROM deleted_edges")
            .get() as { c: number }
        ).c;
        parentPort!.postMessage({
          id,
          type,
          result: {
            nodes: oNodes,
            edges: oEdges,
            deletedNodes: oDelNodes,
            deletedEdges: oDelEdges,
          },
        });
        break;
      }
      case "loadNodes": {
        // No payload (or no dbIndexes) = every open handle + overlay, the
        // original "all handles, once" behavior non-dynamic mode still
        // relies on byte-for-byte. With dbIndexes set, only those handles,
        // and overlay rows only when includeOverlay is explicitly true (the
        // caller is responsible for merging the overlay exactly once).
        const { dbIndexes, includeOverlay } = (payload ?? {}) as {
          dbIndexes?: number[];
          includeOverlay?: boolean;
        };
        const wantOverlay =
          dbIndexes === undefined ? true : includeOverlay === true;
        const targets: Array<{ h: DbHandle; i: number }> =
          dbIndexes === undefined
            ? handles.reduce<Array<{ h: DbHandle; i: number }>>((acc, h, i) => {
                if (h) acc.push({ h, i });
                return acc;
              }, [])
            : dbIndexes.reduce<Array<{ h: DbHandle; i: number }>>((acc, i) => {
                const h = handles[i];
                if (h) acc.push({ h, i });
                return acc;
              }, []);

        const allNodes: Array<NodeRow & { db_index: number }> = [];
        for (const { h, i } of targets) {
          const regionIdCol = h.flags.hasRegionId
            ? "region_id"
            : "0 AS region_id";
          const rows = h.db
            .prepare(
              `SELECT id, lat, lon, node_depth, ${regionIdCol} FROM nodes`,
            )
            .all() as unknown as NodeRow[];
          for (const r of rows)
            allNodes.push({
              ...r,
              db_index: i,
              node_depth_known: isDepthKnown(
                r.node_depth,
                h.depthSchemaVersion,
              ),
            });
        }
        // Merge in overlay-added nodes (region_id = 0). User-entered, not
        // pipeline output -- always the legacy convention (negative = unknown).
        if (wantOverlay && overlayHandle) {
          const overlayNodes = overlayHandle.db
            .prepare("SELECT id, lat, lon, node_depth FROM nodes")
            .all() as unknown as Array<{
            id: number;
            lat: number;
            lon: number;
            node_depth: number;
          }>;
          for (const n of overlayNodes) {
            allNodes.push({
              ...n,
              region_id: 0,
              db_index: OVERLAY_DB_INDEX,
              node_depth_known: isDepthKnown(n.node_depth, null),
            });
          }
        }
        parentPort!.postMessage({ id, type, result: allNodes });
        break;
      }
      case "loadEdges": {
        const { dbIndexes, includeOverlay } = (payload ?? {}) as {
          dbIndexes?: number[];
          includeOverlay?: boolean;
        };
        const wantOverlay =
          dbIndexes === undefined ? true : includeOverlay === true;
        const targets: Array<{ h: DbHandle; i: number }> =
          dbIndexes === undefined
            ? handles.reduce<Array<{ h: DbHandle; i: number }>>((acc, h, i) => {
                if (h) acc.push({ h, i });
                return acc;
              }, [])
            : dbIndexes.reduce<Array<{ h: DbHandle; i: number }>>((acc, i) => {
                const h = handles[i];
                if (h) acc.push({ h, i });
                return acc;
              }, []);

        let allEdges: Array<EdgeRow & { db_index: number }> = [];
        for (const { h, i } of targets) {
          // Per file: an older database that lacks a column still loads, with
          // the column substituted, instead of failing the query for everyone.
          const crossesCol = h.flags.hasCrossesLand ? ", crosses_land" : "";
          const obstacleCol = h.flags.hasCrossesObstacle
            ? ", crosses_obstacle"
            : "";
          const edgeKindCol = h.flags.hasEdgeKind
            ? ", edge_kind_id"
            : ", 0 AS edge_kind_id";
          const lockCol = h.flags.hasLockId ? ", lock_id" : ", NULL AS lock_id";
          const edges = h.db
            .prepare(
              `SELECT source, target, distance, min_depth, max_air_draft, min_width,
                    cost_factor, distance_to_land,
                    edge_type_id, traffic_mode${crossesCol}${obstacleCol}${edgeKindCol}${lockCol}
             FROM edges`,
            )
            .all() as unknown as EdgeRow[];
          allEdges = allEdges.concat(
            edges.map((e) => ({
              ...e,
              db_index: i,
              min_depth_known: isDepthKnown(e.min_depth, h.depthSchemaVersion),
            })),
          );
        }
        // Merge in overlay-added edges. User-entered, not pipeline output --
        // always the legacy convention (negative = unknown).
        if (wantOverlay && overlayHandle) {
          const overlayEdges = overlayHandle.db
            .prepare(
              `SELECT source, target, distance, min_depth, max_air_draft, min_width,
                    cost_factor, distance_to_land, edge_type_id, traffic_mode,
                    0 AS edge_kind_id, NULL AS lock_id, edited_fields
             FROM edges`,
            )
            .all() as unknown as EdgeRow[];
          allEdges = allEdges.concat(
            overlayEdges.map((e) => ({
              ...e,
              db_index: OVERLAY_DB_INDEX,
              min_depth_known: isDepthKnown(e.min_depth, null),
            })),
          );
        }
        const CHUNK = 50000;
        for (let i = 0; i < allEdges.length; i += CHUNK) {
          const chunk = allEdges.slice(i, i + CHUNK);
          parentPort!.postMessage({
            id,
            type,
            result: chunk,
            chunk: true,
            chunkIndex: i / CHUNK,
            totalChunks: Math.ceil(allEdges.length / CHUNK),
          });
        }
        parentPort!.postMessage({ id, type, result: null, chunk: false });
        break;
      }
      case "loadPois": {
        const { dbIndexes } = (payload ?? {}) as { dbIndexes?: number[] };
        const targets: Array<{ h: DbHandle; i: number }> =
          dbIndexes === undefined
            ? handles.reduce<Array<{ h: DbHandle; i: number }>>((acc, h, i) => {
                if (h) acc.push({ h, i });
                return acc;
              }, [])
            : dbIndexes.reduce<Array<{ h: DbHandle; i: number }>>((acc, i) => {
                const h = handles[i];
                if (h) acc.push({ h, i });
                return acc;
              }, []);
        const allPois: Array<PoiRow & { db_index: number }> = [];
        for (const { h, i } of targets) {
          try {
            // Some databases may not have a pois table
            const cols = h.db
              .prepare("PRAGMA table_info('pois')")
              .all() as Array<{ name: string }>;
            if (cols.length === 0) continue;
            const rows = h.db
              .prepare(
                "SELECT id, name, type_id, properties, lat, lon FROM pois",
              )
              .all() as unknown as PoiRow[];
            for (const r of rows) allPois.push({ ...r, db_index: i });
          } catch {
            // Skip databases that don't have the pois table
            continue;
          }
        }
        parentPort!.postMessage({ id, type, result: allPois });
        break;
      }
      case "loadNavmeshRegions": {
        const { dbIndexes } = (payload ?? {}) as { dbIndexes?: number[] };
        const targets: Array<{ h: DbHandle; i: number }> =
          dbIndexes === undefined
            ? handles.reduce<Array<{ h: DbHandle; i: number }>>((acc, h, i) => {
                if (h) acc.push({ h, i });
                return acc;
              }, [])
            : dbIndexes.reduce<Array<{ h: DbHandle; i: number }>>((acc, i) => {
                const h = handles[i];
                if (h) acc.push({ h, i });
                return acc;
              }, []);
        const allRegions: Array<NavmeshRegionRow & { db_index: number }> = [];
        for (const { h, i } of targets) {
          try {
            const cols = h.db
              .prepare("PRAGMA table_info('navmesh_regions')")
              .all() as Array<{ name: string }>;
            if (cols.length === 0) continue; // Phase-0-only DB — no navmesh_regions table, skip gracefully
            const colNames = new Set(cols.map((c) => c.name));
            const adjacencyCol = colNames.has("triangle_adjacency")
              ? "triangle_adjacency"
              : "NULL AS triangle_adjacency";
            const sql = `SELECT region_id, boundary_geometry, vertices, triangles,
                                ${adjacencyCol}, boundary_node_ids, depth_ceiling_m
                         FROM navmesh_regions`;
            const rows = h.db
              .prepare(sql)
              .all() as unknown as NavmeshRegionRow[];
            for (const r of rows) allRegions.push({ ...r, db_index: i });
          } catch {
            // Skip databases with a malformed/legacy navmesh_regions table
            continue;
          }
        }
        parentPort!.postMessage({ id, type, result: allRegions });
        break;
      }
      case "getMetadata": {
        const results: Array<{
          id: number;
          country: string;
          name: string;
          description: string | null;
          lastUpdateDate: string;
          tags: string | null;
          boundingBox: string | null;
          boundaryGeometry: string | null;
          schemaVersion: number | null;
          contributor: string | null;
          url: string | null;
          filename: string;
          stats: { nodes: number; edges: number; pois: number };
        }> = [];
        for (const h of handles) {
          if (!h) continue;
          const filename = filenameOf(h.path);
          const row = readMetadataRow(h.db, filename);
          const stats = readStatsRow(h.db);
          if (row) {
            results.push({ ...row, stats });
          } else {
            // No metadata table/row — still include a minimal entry so it
            // shows in the installed list (metadata table might not exist
            // in legacy DBs).
            results.push({
              id: 0,
              country: "",
              name: filename.replace(".sqlite", ""),
              description: null,
              lastUpdateDate: "",
              tags: null,
              boundingBox: null,
              boundaryGeometry: null,
              schemaVersion: null,
              contributor: null,
              url: null,
              filename,
              stats,
            });
          }
        }
        parentPort!.postMessage({ id, type, result: results });
        break;
      }
      case "updateNode": {
        if (!overlayHandle) throw new Error("Overlay not open");
        const { nodeId, node_depth } = payload!;
        // Ensure node exists in overlay (copy from region DB if needed)
        overlayHandle.db
          .prepare(
            "INSERT OR IGNORE INTO nodes (id, lat, lon, node_depth) VALUES (?, ?, ?, ?)",
          )
          .run(nodeId, payload!.lat ?? 0, payload!.lon ?? 0, -1);
        overlayHandle.db
          .prepare("UPDATE nodes SET node_depth = ? WHERE id = ?")
          .run(node_depth ?? -1, nodeId);
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case "updateEdge": {
        if (!overlayHandle) throw new Error("Overlay not open");
        const {
          source,
          target,
          distance,
          min_depth,
          max_air_draft,
          min_width,
          traffic_mode,
          cost_factor,
          distance_to_land,
          edge_type_id,
        } = payload!;
        // First ensure the edge exists in the overlay (copy defaults)
        overlayHandle.db
          .prepare(
            `INSERT OR IGNORE INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            source,
            target,
            distance ?? 0,
            min_depth ?? -1,
            max_air_draft ?? -1,
            min_width ?? -1,
            cost_factor ?? 1.2,
            distance_to_land ?? 0,
            edge_type_id ?? 0,
            traffic_mode ?? 0,
          );
        // Then UPDATE only the fields that were actually provided, and record
        // which those are. Everything else in the row is a placeholder from
        // the INSERT above, indistinguishable by value from a real reading —
        // `cost_factor = 1.2` and `traffic_mode = 0` especially — so the
        // loader has no way to tell an edit from a default without being told.
        const cols: string[] = [];
        const vals: any[] = [];
        const edited: string[] = [];
        if (distance !== undefined) {
          cols.push("distance = ?");
          vals.push(distance);
          edited.push("distance");
        }
        if (min_depth !== undefined) {
          cols.push("min_depth = ?");
          vals.push(min_depth);
          edited.push("min_depth");
        }
        if (max_air_draft !== undefined) {
          cols.push("max_air_draft = ?");
          vals.push(max_air_draft);
          edited.push("max_air_draft");
        }
        if (min_width !== undefined) {
          cols.push("min_width = ?");
          vals.push(min_width);
          edited.push("min_width");
        }
        if (traffic_mode !== undefined) {
          cols.push("traffic_mode = ?");
          vals.push(traffic_mode);
          edited.push("traffic_mode");
        }
        if (cost_factor !== undefined) {
          cols.push("cost_factor = ?");
          vals.push(cost_factor);
          edited.push("cost_factor");
        }
        if (cols.length > 0) {
          vals.push(source, target);
          overlayHandle.db
            .prepare(
              `UPDATE edges SET ${cols.join(", ")} WHERE source = ? AND target = ?`,
            )
            .run(...vals);

          // Union with whatever earlier edits set, so editing the depth today
          // and the width tomorrow leaves both marked rather than the second
          // edit disowning the first.
          const prior = overlayHandle.db
            .prepare(
              "SELECT edited_fields FROM edges WHERE source = ? AND target = ?",
            )
            .get(source, target) as
            | { edited_fields: string | null }
            | undefined;
          const merged = new Set<string>(edited);
          if (prior?.edited_fields) {
            try {
              for (const f of JSON.parse(prior.edited_fields) as string[])
                merged.add(f);
            } catch {
              // Unparseable marker: treat as unmarked rather than losing this
              // edit's own fields — worst case the row falls back to the
              // conservative merge for the columns we cannot account for.
            }
          }
          overlayHandle.db
            .prepare(
              "UPDATE edges SET edited_fields = ? WHERE source = ? AND target = ?",
            )
            .run(JSON.stringify([...merged].sort()), source, target);
        }
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case "deleteNode": {
        if (!overlayHandle) throw new Error("Overlay not open");
        const { nodeId } = payload!;
        overlayHandle.db
          .prepare("INSERT OR IGNORE INTO deleted_nodes (node_id) VALUES (?)")
          .run(nodeId);
        overlayHandle.db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
        overlayHandle.db
          .prepare("DELETE FROM edges WHERE source = ? OR target = ?")
          .run(nodeId, nodeId);
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case "deleteEdge": {
        if (!overlayHandle) throw new Error("Overlay not open");
        const { source: delSource, target: delTarget } = payload!;
        overlayHandle.db
          .prepare(
            "INSERT OR IGNORE INTO deleted_edges (source, target) VALUES (?, ?)",
          )
          .run(delSource, delTarget);
        overlayHandle.db
          .prepare("DELETE FROM edges WHERE source = ? AND target = ?")
          .run(delSource, delTarget);
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case "clearOverlayDeletedEdges": {
        if (!overlayHandle) throw new Error("Overlay not open");
        // Remove only overlay-to-overlay and overlay-to-main deleted_edges entries (not main-to-main deletions).
        // This restores edges the user drew but accidentally deleted.
        const overlayNodeIds = (
          overlayHandle.db.prepare("SELECT id FROM nodes").all() as {
            id: number;
          }[]
        ).map((r) => r.id);
        const nodeSet = new Set(overlayNodeIds);
        const delRows = overlayHandle.db
          .prepare("SELECT source, target FROM deleted_edges")
          .all() as { source: number; target: number }[];
        let restored = 0;
        for (const { source, target } of delRows) {
          // Keep main-to-main deletions; remove anything touching overlay nodes
          if (nodeSet.has(source) || nodeSet.has(target)) {
            overlayHandle.db
              .prepare("DELETE FROM deleted_edges WHERE source=? AND target=?")
              .run(source, target);
            restored++;
          }
        }
        parentPort!.postMessage({ id, type, result: { restored } });
        break;
      }
      case "insertNode": {
        if (!overlayHandle) throw new Error("Overlay not open");
        const { id: nodeId, lat, lon, node_depth } = payload!;
        overlayHandle.db
          .prepare(
            "INSERT OR REPLACE INTO nodes (id, lat, lon, node_depth) VALUES (?, ?, ?, ?)",
          )
          .run(nodeId, lat, lon, node_depth ?? -1);
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case "insertEdge": {
        if (!overlayHandle) throw new Error("Overlay not open");
        const {
          source: insSource,
          target: insTarget,
          distance: insDist,
          min_depth: insMd,
          max_air_draft: insAd,
          min_width: insMw,
          cost_factor: insCf,
          distance_to_land: insDtl,
          edge_type_id: insEt,
          traffic_mode: insTm,
        } = payload!;
        // A drawn edge is authored outright, not a correction to a file's row,
        // so every column is the user's — marked as such in case a region
        // file later turns out to describe the same pair (a re-download, or a
        // neighbouring region overlapping this water), which must not then
        // override what was drawn here.
        overlayHandle.db
          .prepare(
            `INSERT OR REPLACE INTO edges (source, target, distance, min_depth, max_air_draft, min_width, cost_factor, distance_to_land, edge_type_id, traffic_mode, edited_fields)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            insSource,
            insTarget,
            insDist ?? 0,
            insMd ?? -1,
            insAd ?? -1,
            insMw ?? -1,
            insCf ?? 1.2,
            insDtl ?? 0,
            insEt ?? 0,
            insTm ?? 0,
            JSON.stringify(OVERLAY_EDITABLE_COLUMNS),
          );
        parentPort!.postMessage({ id, type, result: { success: true } });
        break;
      }
      case "close": {
        for (const h of handles) {
          if (!h) continue;
          try {
            h.db.close();
          } catch {
            /* already closed */
          }
        }
        handles.length = 0;
        filenames.length = 0;
        if (overlayHandle) {
          try {
            overlayHandle.db.close();
          } catch {
            /* already closed */
          }
          overlayHandle = null;
        }
        parentPort!.postMessage({ id, type, result: null });
        break;
      }
    }
  } catch (err: any) {
    parentPort!.postMessage({ id, type, error: err.message ?? String(err) });
  }
});
