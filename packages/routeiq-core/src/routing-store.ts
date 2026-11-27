/**
 * What the routing database layer (`RoutingDatabase`) asks of persistence.
 *
 * The interfaces are shaped by the questions the layer asks (open this file,
 * load its nodes, describe these route edges), not by SQL, so a store can be
 * backed by something other than SQLite files: another reader, or an
 * in-memory graph in a test. `SqliteWorkerStore` (sqlite-worker-store.ts) is
 * the first implementation; it keeps SQLite I/O in a worker thread.
 *
 * Files are referred to by path; an open file is an opaque `dbIndex` handle
 * the store assigns on `openDb` and never reuses. Rows read from a file carry
 * the `db_index` of the file they came from (`OVERLAY_DB_INDEX` for a row of
 * the graph-editing overlay).
 *
 * This module has no runtime imports (only types), so a worker thread can take it without
 * dragging anything else across.
 */

import type { DescribeWorkerResult } from "./route-description.js";

/** Edge columns the graph editor can set, and therefore the ones a user-edits
 *  overlay row can claim in `edited_fields`. Everything else on such a row is
 *  a placeholder written for a value the edit never mentioned, which is why
 *  the distinction has to be recorded rather than inferred from the values.
 *
 *  Lives here because both sides of the worker boundary need the same list:
 *  the worker writes it when an edge is drawn, the database stamps the
 *  matching in-memory row. */
export const OVERLAY_EDITABLE_COLUMNS = [
  "cost_factor",
  "distance",
  "max_air_draft",
  "min_depth",
  "min_width",
  "traffic_mode",
];

/** `db_index` of a row that belongs to the overlay rather than to any region
 *  file. -1 is never a file handle, so it cannot match a per-file filter. */
export const OVERLAY_DB_INDEX = -1;

/** One region file the database is told about. */
export interface RegionFileEntry {
  /** Absolute path of the file. */
  path: string;
  /** False for a file that is listed but must never be loaded (it is peeked
   *  for its metadata only, so it can still be shown and switched on). */
  enabled: boolean;
}

/** Why a graph-editing call was refused. */
export type GraphEditErrorCode = "READ_ONLY" | "NO_OVERLAY";

/** Thrown (as a rejection) by every graph-editing method when the database is
 *  read-only (`READ_ONLY`) or has no overlay to write to (`NO_OVERLAY`). */
export class GraphEditError extends Error {
  readonly code: GraphEditErrorCode;
  constructor(code: GraphEditErrorCode, message?: string) {
    super(
      message ??
        (code === "READ_ONLY"
          ? "The routing database is read-only: graph edits are not available"
          : "No graph-edit overlay is available"),
    );
    this.name = "GraphEditError";
    this.code = code;
  }
}

/** Optional columns a file has; decides what the loaders can ask of it. */
export interface StoreSchemaFlags {
  hasCrossesLand: boolean;
  hasCrossesObstacle: boolean;
  hasNodeDepth: boolean;
  hasRegionId: boolean;
  hasEdgeKind: boolean;
}

/** A file's `metadata` row. */
export interface RegionMetadata {
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
}

/** Row counts of one file. */
export interface RegionStats {
  nodes: number;
  edges: number;
  pois: number;
}

export type BoundingBoxJson = {
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
};

/** What `peekMetadata` reads from one file without keeping it open. */
export interface PeekedFile {
  path: string;
  /** Basename of `path` (so a disabled file keeps its suffix here). */
  filename: string;
  coverage: {
    boundingBox: BoundingBoxJson | null;
    boundaryGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  };
  meta: RegionMetadata | null;
  flags: StoreSchemaFlags;
  stats: RegionStats | null;
  /** Set when the file is refused (unknown format generation, or built
   *  before the POI model). */
  formatError: string | null;
}

/** Result of opening every enabled file at once (`openAll`, bulk mode). */
export interface OpenAllResult {
  hasCrossesLand: boolean;
  hasCrossesObstacle: boolean;
  hasNodeDepth: boolean;
  hasRegionId: boolean;
  /** Basenames of the files opened, in the order their handles were made. */
  filenames: string[];
  /** Route-description problems keyed by filename. */
  descriptionErrors: Record<string, string>;
  /** Format refusals keyed by filename; those files were not opened. */
  formatErrors: Record<string, string>;
}

/** One file opened on demand. */
export interface OpenedFile {
  dbIndex: number;
  filename: string;
  flags: StoreSchemaFlags;
  descriptionError?: string | null;
  /** `metadata.last_update_date` of the file this handle was opened on, read
   *  from that same handle; null when it has none. */
  lastUpdateDate?: string | null;
}

/** A file the store refused to open (see `PeekedFile.formatError`). */
export interface RefusedFile {
  refused: string;
  filename: string;
}

/** Which open files a load covers. */
export interface LoadSelector {
  /** Handles to read; absent = every open file. */
  dbIndexes?: number[];
  /** Whether to add the overlay's own rows. With `dbIndexes` absent the
   *  overlay is always included; with it present only when this is true (the
   *  caller merges the overlay exactly once). Ignored by a store with no
   *  overlay. */
  includeOverlay?: boolean;
}

export interface StoreNodeRow {
  id: number;
  lat: number;
  lon: number;
  node_depth: number;
  region_id?: number;
  /** Whether node_depth is a real reading (possibly a charted drying
   *  height) rather than "no data". */
  node_depth_known?: boolean;
  db_index: number;
}

export interface StoreEdgeRow {
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
  min_depth_known?: boolean;
  /** Overlay rows only: JSON array of the columns the user set. */
  edited_fields?: string | null;
  db_index: number;
}

export interface StorePoiRow {
  id: number;
  name: string;
  type_id: number;
  properties: string | null;
  lat: number;
  lon: number;
  parent_id: number | null;
  db_index: number;
}

export interface StoreNavmeshRow {
  region_id: number;
  boundary_geometry: string;
  vertices: string;
  triangles: string;
  triangle_adjacency: string | null;
  boundary_node_ids: string;
  depth_ceiling_m: number;
  db_index: number;
}

/** A node pair of a found route, with the file its edge came from. */
export interface DescribePair {
  source: number;
  target: number;
  dbIndex?: number;
}

/** Which chambers/spans an edge passes, asked for one node pair. */
export interface RoutePoiQuery {
  lo: number;
  hi: number;
  /** Files known to hold the pair; null = unknown, ask every open file. */
  dbIndexes: number[] | null;
  /** The pair may be an in-memory edge: the file must really hold it. */
  verify?: boolean;
}

export interface RoutePoiAnswer {
  poiIds: number[];
  /** At least one file with edge links held the pair. */
  known: boolean;
}

/** Read access to routing data files. */
export interface RoutingStore {
  /** Open every file at once (bulk mode); `openDb` is the on-demand route. */
  openAll(paths: string[]): Promise<OpenAllResult>;
  /** Read each file's metadata, coverage, schema flags and counts through a
   *  short-lived handle; opens nothing for later. A file that cannot be read
   *  is left out of the answer. */
  peekMetadata(paths: string[]): Promise<PeekedFile[]>;
  /** Open one file for loading. A file refused for its format answers with a
   *  `RefusedFile` instead of failing. */
  openDb(path: string): Promise<OpenedFile | RefusedFile>;
  closeDb(dbIndex: number): Promise<void>;
  loadNodes(selector?: LoadSelector): Promise<StoreNodeRow[]>;
  loadEdges(selector?: LoadSelector): Promise<StoreEdgeRow[]>;
  loadPois(selector?: { dbIndexes?: number[] }): Promise<StorePoiRow[]>;
  loadNavmeshRegions(selector?: {
    dbIndexes?: number[];
  }): Promise<StoreNavmeshRow[]>;
  /** Metadata and counts of every open file. */
  getMetadata(): Promise<Array<RegionMetadata & { stats: RegionStats }>>;
  /** Route description (edge sequences, water bodies, notices) for a found
   *  route's node pairs. Reads those rows only. */
  describeRoute(
    pairs: DescribePair[],
    lang?: string,
  ): Promise<DescribeWorkerResult>;
  /** Display facts (`pois.info`) by POI id, keyed by id as a string. */
  poiInfo(ids: number[]): Promise<Record<string, Record<string, unknown>>>;
  /** The chambers and spans linked to edge pairs (`edge_pois`). */
  routePois(pairs: RoutePoiQuery[]): Promise<RoutePoiAnswer[]>;
  /** Release everything (files, worker). The store may be used again after;
   *  it starts afresh. */
  close(): Promise<void>;
}

export interface OverlayStats {
  nodes: number;
  edges: number;
  deletedNodes: number;
  deletedEdges: number;
}

export interface OverlayEdgeValues {
  distance?: number;
  min_depth?: number;
  max_air_draft?: number;
  min_width?: number;
  cost_factor?: number;
  distance_to_land?: number;
  edge_type_id?: number;
  traffic_mode?: number;
}

/** Persistent graph edits (nodes and edges added, changed or deleted by the
 *  user), kept apart from the read-only region files. */
export interface OverlayStore {
  /** Open (creating it if needed) the overlay stored at `path`. */
  openOverlay(path: string): Promise<void>;
  getDeletedNodeIds(): Promise<number[]>;
  getDeletedEdgePairs(): Promise<Array<{ source: number; target: number }>>;
  getOverlayStats(): Promise<OverlayStats>;
  updateNode(args: {
    dbIndex: number;
    nodeId: number;
    lat: number;
    lon: number;
    node_depth: number;
  }): Promise<void>;
  updateEdge(
    args: {
      dbIndex: number;
      source: number;
      target: number;
    } & OverlayEdgeValues,
  ): Promise<void>;
  deleteNode(args: { dbIndex: number; nodeId: number }): Promise<void>;
  deleteEdge(args: {
    dbIndex: number;
    source: number;
    target: number;
  }): Promise<void>;
  /** Forget the user's edge deletions; answers how many came back. */
  clearOverlayDeletedEdges(): Promise<{ restored: number }>;
  insertNode(args: {
    dbIndex: number;
    id: number;
    lat: number;
    lon: number;
    node_depth?: number;
  }): Promise<void>;
  insertEdge(
    args: {
      dbIndex: number;
      source: number;
      target: number;
      distance: number;
    } & OverlayEdgeValues,
  ): Promise<void>;
}
