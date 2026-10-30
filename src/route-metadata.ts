/**
 * Route-description queries against the routing databases, run in the db
 * worker (which keeps the files open). Nothing here is loaded into the graph:
 * after a route is found the worker is asked about its few hundred node pairs
 * and reads edge sequences, water bodies and notices for those only.
 *
 * Format: SPEC-WAYS-AND-WATERWAYS.md in signalk-router-pipeline. Tables are
 * detected, never `schema_version`: a file without them simply has no names.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  DescribedNotice,
  DescribedSequence,
  DescribedWaterBody,
  DescribeWorkerResult,
} from "./route-description.js";

export interface DescribeFlags {
  /** edges.edge_sequence_id exists (the column is not in the load SELECT). */
  hasEdgeSequenceCol: boolean;
  hasEdgeSequences: boolean;
  hasWaterBodies: boolean;
  hasWaterBodyNames: boolean;
  /** notices + edge_notices */
  hasNotices: boolean;
}

/** What describing needs from an open worker handle. */
export interface DescribeSource {
  db: DatabaseSync;
  path?: string;
  flags: DescribeFlags;
  /** Set when this file's ids collide with another open file's; its pairs then
   *  read as undescribed (the file still routes). */
  describeError?: string;
}

export function detectDescribeFlags(
  db: DatabaseSync,
  edgeCols: Array<{ name: string }>,
): DescribeFlags {
  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
  return {
    hasEdgeSequenceCol: edgeCols.some((c) => c.name === "edge_sequence_id"),
    hasEdgeSequences: tables.has("edge_sequences"),
    hasWaterBodies: tables.has("water_bodies"),
    hasWaterBodyNames: tables.has("water_body_names"),
    hasNotices: tables.has("notices") && tables.has("edge_notices"),
  };
}

function nameOf(path: string | undefined): string {
  const parts = (path ?? "?").replace(/\\/g, "/").split("/");
  return parts[parts.length - 1];
}

function count(db: DatabaseSync, table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  ).c;
}

/**
 * Check a newly opened file's edge sequence and water body ids against the
 * other open files. The same id must mean the same thing (a sequence the same
 * end nodes, a water body the same name and kind); a coincidental hash
 * collision otherwise silently gives a route the wrong names. Returns an
 * error naming both files and the id, or null. Iterates the smaller table and
 * looks each id up by primary key in the other.
 */
export function findDescribeCollision(
  fresh: DescribeSource,
  others: Array<DescribeSource | null>,
): string | null {
  for (const other of others) {
    if (!other || other === fresh) continue;
    const a = nameOf(fresh.path);
    const b = nameOf(other.path);

    if (fresh.flags.hasEdgeSequences && other.flags.hasEdgeSequences) {
      const [small, big] =
        count(fresh.db, "edge_sequences") <= count(other.db, "edge_sequences")
          ? [fresh, other]
          : [other, fresh];
      const get = big.db.prepare(
        "SELECT node_a, node_b FROM edge_sequences WHERE id = ?",
      );
      for (const r of small.db
        .prepare("SELECT id, node_a, node_b FROM edge_sequences")
        .iterate() as Iterable<{
        id: number;
        node_a: number;
        node_b: number;
      }>) {
        const o = get.get(r.id) as
          | { node_a: number; node_b: number }
          | undefined;
        if (o && (o.node_a !== r.node_a || o.node_b !== r.node_b)) {
          return (
            `edge sequence id ${r.id} means different lines in ${a} and ${b} ` +
            `(end nodes ${r.node_a}-${r.node_b} vs ${o.node_a}-${o.node_b})`
          );
        }
      }
    }

    if (fresh.flags.hasWaterBodies && other.flags.hasWaterBodies) {
      const [small, big] =
        count(fresh.db, "water_bodies") <= count(other.db, "water_bodies")
          ? [fresh, other]
          : [other, fresh];
      const get = big.db.prepare(
        "SELECT name, kind_id FROM water_bodies WHERE id = ?",
      );
      for (const r of small.db
        .prepare("SELECT id, name, kind_id FROM water_bodies")
        .iterate() as Iterable<{
        id: number;
        name: string;
        kind_id: number | null;
      }>) {
        const o = get.get(r.id) as
          | { name: string; kind_id: number | null }
          | undefined;
        if (
          o &&
          (o.name !== r.name || (o.kind_id ?? null) !== (r.kind_id ?? null))
        ) {
          return (
            `water body id ${r.id} means different waters in ${a} and ${b} ` +
            `("${r.name}" kind ${r.kind_id ?? "none"} vs "${o.name}" kind ${o.kind_id ?? "none"})`
          );
        }
      }
    }
  }
  return null;
}

/** Order of preference among the names of one language. */
const NAME_KIND_ORDER =
  "CASE kind WHEN 'official' THEN 0 WHEN 'alternative' THEN 1 ELSE 2 END";

/** Languages to try for a name: the requested one, then its base ('de-CH' -> 'de'). */
export function languageChain(lang: string | undefined): string[] {
  if (typeof lang !== "string") return [];
  const l = lang.trim();
  if (l.length === 0 || l.length > 35 || !/^[A-Za-z0-9-]+$/.test(l)) return [];
  const base = l.split("-")[0];
  return base.toLowerCase() === l.toLowerCase() ? [l] : [l, base];
}

function lookupEnum(
  db: DatabaseSync,
  table: string,
): Map<number, { description: string; rank?: number }> {
  const out = new Map<number, { description: string; rank?: number }>();
  try {
    const hasRank = (
      db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
        name: string;
      }>
    ).some((c) => c.name === "rank");
    const rows = db
      .prepare(`SELECT id, description${hasRank ? ", rank" : ""} FROM ${table}`)
      .all() as Array<{ id: number; description: string; rank?: number }>;
    for (const r of rows)
      out.set(r.id, { description: r.description, rank: r.rank });
  } catch {
    // table absent: every id reads as unknown
  }
  return out;
}

// origin_enum ids that deserve a warning: an outside axis copied as is, and a
// community contribution. Ids rather than descriptions, as decided with Marcel.
const ORIGIN_IMPORTED = 2;
const ORIGIN_COMMUNITY = 5;

/**
 * Describe the route's node pairs. For each pair the edge's own file is tried
 * first (`dbIndex`), then any other open file that has the sequence column and
 * the row. Pairs in no sequence (overlay, manual and connector legs, navmesh
 * shortcuts, files without the tables) come back null.
 */
export function describePairs(
  handles: Array<DescribeSource | null>,
  pairs: Array<{ source: number; target: number; dbIndex?: number }>,
  lang?: string,
): DescribeWorkerResult {
  const usable = (h: DescribeSource | null | undefined): h is DescribeSource =>
    !!h && h.flags.hasEdgeSequenceCol && !h.describeError;

  const result: DescribeWorkerResult = {
    perPair: [],
    sequences: {},
    waterBodies: {},
    notices: {},
  };
  if (!handles.some(usable)) {
    result.perPair = pairs.map(() => null);
    return result;
  }

  const langs = languageChain(lang);
  // Per handle, prepared once per call and only when something needs them.
  const stmts = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  const cached = (h: DescribeSource, key: string, sql: string) => {
    const k = `${handles.indexOf(h)}:${key}`;
    let s = stmts.get(k);
    if (!s) {
      s = h.db.prepare(sql);
      stmts.set(k, s);
    }
    return s;
  };

  const enumCache = new Map<
    string,
    Map<number, { description: string; rank?: number }>
  >();
  const enumOf = (h: DescribeSource, table: string) => {
    const k = `${handles.indexOf(h)}:${table}`;
    let e = enumCache.get(k);
    if (!e) {
      e = lookupEnum(h.db, table);
      enumCache.set(k, e);
    }
    return e;
  };

  const resolveSequence = (h: DescribeSource, seqId: number): void => {
    const key = String(seqId);
    if (result.sequences[key]) return;
    let row:
      | {
          water_body_id: number | null;
          origin_id: number | null;
          depth_quality_id: number | null;
        }
      | undefined;
    if (h.flags.hasEdgeSequences) {
      row = cached(
        h,
        "seq",
        "SELECT water_body_id, origin_id, depth_quality_id FROM edge_sequences WHERE id = ?",
      ).get(seqId) as typeof row;
    }
    const origins = enumOf(h, "origin_enum");
    const originId = row?.origin_id ?? 0;
    const origin = origins.get(originId)?.description ?? "other";

    const qualities = enumOf(h, "depth_quality_enum");
    let chartedRank: number | undefined;
    for (const q of qualities.values()) {
      if (q.description === "charted") chartedRank = q.rank;
    }
    const q =
      row?.depth_quality_id !== null && row?.depth_quality_id !== undefined
        ? qualities.get(row.depth_quality_id)
        : undefined;
    // Rank, never id, decides whether the depth is as trusted as a charted
    // one. A level this file does not know reads as unknown.
    const depthQuality = q ? q.description : "unknown";
    const depthQualityWarn = q
      ? chartedRank === undefined || q.rank === undefined
        ? q.description !== "charted"
        : q.rank < chartedRank
      : true;

    result.sequences[key] = {
      waterBodyId: row?.water_body_id ?? null,
      origin,
      originWarn: originId === ORIGIN_IMPORTED || originId === ORIGIN_COMMUNITY,
      depthQuality,
      depthQualityWarn,
    } satisfies DescribedSequence;
    if (row?.water_body_id !== null && row?.water_body_id !== undefined) {
      resolveWaterBody(h, row.water_body_id);
    }
  };

  const resolveWaterBody = (h: DescribeSource, id: number): void => {
    const key = String(id);
    if (result.waterBodies[key] || !h.flags.hasWaterBodies) return;
    const wb = cached(
      h,
      "wb",
      "SELECT name, kind_id FROM water_bodies WHERE id = ?",
    ).get(id) as { name: string | null; kind_id: number | null } | undefined;
    if (!wb) return;
    let name: string | undefined;
    if (h.flags.hasWaterBodyNames) {
      for (const l of langs) {
        const r = cached(
          h,
          "wbn",
          `SELECT name FROM water_body_names
           WHERE water_body_id = ? AND lang = ? COLLATE NOCASE
             AND kind IN ('official', 'alternative', 'short')
           ORDER BY ${NAME_KIND_ORDER} LIMIT 1`,
        ).get(id, l) as { name: string } | undefined;
        if (r?.name) {
          name = r.name;
          break;
        }
      }
    }
    if (!name && wb.name) name = wb.name;
    const kinds = enumOf(h, "water_body_kind_enum");
    result.waterBodies[key] = {
      ...(name ? { name } : {}),
      kind:
        wb.kind_id !== null && kinds.has(wb.kind_id)
          ? kinds.get(wb.kind_id)!.description
          : "other",
    } satisfies DescribedWaterBody;
  };

  for (const p of pairs) {
    const candidates: DescribeSource[] = [];
    if (p.dbIndex !== undefined && usable(handles[p.dbIndex])) {
      candidates.push(handles[p.dbIndex]!);
    }
    if (p.dbIndex === undefined || p.dbIndex >= 0) {
      for (const h of handles)
        if (usable(h) && !candidates.includes(h)) candidates.push(h);
    }
    let info: { seq: number | null; notices?: number[] } | null = null;
    for (const h of candidates) {
      const row = cached(
        h,
        "edge",
        "SELECT edge_sequence_id FROM edges WHERE source = ? AND target = ?",
      ).get(p.source, p.target) as
        | { edge_sequence_id: number | null }
        | undefined;
      if (!row) continue;
      const seq = row.edge_sequence_id ?? null;
      if (seq !== null) resolveSequence(h, seq);
      let noticeIds: number[] | undefined;
      if (h.flags.hasNotices) {
        const rows = cached(
          h,
          "notice",
          `SELECT n.id, n.severity, n.text, n.name
           FROM edge_notices en JOIN notices n ON n.id = en.notice_id
           WHERE en.source = ? AND en.target = ? AND n.source_class = 'NAVLINE'`,
        ).all(p.source, p.target) as Array<{
          id: number;
          severity: number | null;
          text: string | null;
          name: string | null;
        }>;
        for (const n of rows) {
          (noticeIds ??= []).push(n.id);
          result.notices[String(n.id)] = {
            severity: n.severity ?? 1,
            text: n.text ?? "",
            name: n.name ?? null,
          } satisfies DescribedNotice;
        }
      }
      info = { seq, ...(noticeIds ? { notices: noticeIds } : {}) };
      break;
    }
    result.perPair.push(info);
  }
  return result;
}
