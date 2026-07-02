#!/usr/bin/env python3
"""
Add named POIs from nautical-routing-pipeline GeoJSON layers to an EXISTING
autoroute SQLite database

The script is deliberately standalone so it can be re-run against any database
that follows the autoroute schema (nodes/edges/pois tables).

POI extraction mirrors nautical_routing_pipeline.py exactly (same layers, same
name/point selection, same deterministic MD5 ids, same bridge subtype/height
properties) so POIs stay stable and deduplicate across databases.

Graph connection ("smart connecting"):
  - Every POI is matched to its nearest graph node via a KD-tree on 3D
    unit-sphere coordinates. Node id and distance are stored in the POI's
    properties JSON as `node_id` / `node_dist_m` (within --connect-radius).
  - The routing engine only reports bridge/lock crossings when the POI lies
    within 150 m of a route vertex (detectCrossings in src/routing.ts). POIs of
    the types in --snap-types that sit farther than --snap-if-beyond from their
    nearest node are therefore MOVED onto that node; the original position is
    kept in properties as `orig_lat` / `orig_lon`.
  - POIs with no node within --connect-radius are inserted unconnected unless
    their type is listed in --skip-unconnected-types.

Usage:
  python3 add_pois_to_db.py --db ../data/europe.sqlite --input-dir ../output_geojson
  python3 add_pois_to_db.py --db my.sqlite --layer harbour=custom_pois.geojson --replace
"""

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time

import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import shape, Point, Polygon, LineString, MultiPolygon, MultiLineString

# ── POI type ids (must match poi_type_enum) ──────────────────────────
POI_TYPES = {
    "harbour": 0,
    "lock": 1,
    "bridge": 2,
    "fairway": 3,
    "waterway": 4,
}

# Default pipeline output filenames per POI type
DEFAULT_LAYER_FILES = {
    "harbour": "pois_points.geojson",
    "lock": "locks_polygons.geojson",
    "bridge": "bridges_polygons.geojson",
    "fairway": "fairways_polygons.geojson",
    "waterway": "inland_waterways_lines.geojson",
}

EARTH_RADIUS_M = 6371008.8


# ── Helpers replicated from nautical_routing_pipeline.py ─────────────
def s57_col(props: dict, *candidates):
    lower_map = {str(k).lower(): k for k in props.keys()}
    for c in candidates:
        match = lower_map.get(c.lower())
        if match is not None:
            return props[match]
    return None


def parse_catbrg(catbrg):
    if isinstance(catbrg, (list, tuple)):
        return [str(v) for v in catbrg]
    if isinstance(catbrg, str):
        vals = re.findall(r"(\d+)", catbrg)
        return vals if vals else [catbrg]
    return [str(catbrg)]


def poi_id(poi_type: str, lat: float, lon: float) -> int:
    unique_str = f"{poi_type}_{round(lat, 5)}_{round(lon, 5)}"
    return int(hashlib.md5(unique_str.encode("utf-8")).hexdigest()[:13], 16)


def poi_name(props: dict) -> str:
    for col in ("OBJNAM", "NOBJNM", "name"):
        val = s57_col(props, col)
        if val is not None and val == val and str(val).strip():  # val==val filters NaN
            return str(val)
    return ""


def poi_point(geom):
    """Representative (lat, lon) for a POI geometry."""
    if isinstance(geom, Point):
        return (geom.y, geom.x)
    if isinstance(geom, Polygon):
        c = geom.centroid
        return (c.y, c.x)
    if isinstance(geom, LineString):
        c = geom.interpolate(0.5, normalized=True)
        return (c.y, c.x)
    if isinstance(geom, MultiPolygon):
        largest = max(geom.geoms, key=lambda g: g.area)
        c = largest.centroid
        return (c.y, c.x)
    if isinstance(geom, MultiLineString):
        longest = max(geom.geoms, key=lambda g: g.length)
        c = longest.interpolate(0.5, normalized=True)
        return (c.y, c.x)
    return None


def poi_properties(props: dict, poi_type: str) -> dict:
    out = {}
    if poi_type == "bridge":
        is_opening = False
        catbrg = s57_col(props, "catbrg", "CATAQA", "CatBrg")
        if catbrg is not None:
            vals = parse_catbrg(catbrg)
            if any(v in ("3", "4", "5", "6", "7") for v in vals):
                is_opening = True
        if not is_opening:
            vercop = s57_col(props, "vercop", "VERCOP", "VerCop")
            if vercop is not None:
                is_opening = True
        if is_opening:
            out["subtype"] = "opening"
        else:
            out["subtype"] = "fixed"
            verclr = s57_col(props, "verclr", "VERCLR", "VerClr")
            if verclr is not None:
                try:
                    out["height"] = float(verclr)
                except (TypeError, ValueError):
                    pass
    return out


# ── Spatial index on graph nodes ─────────────────────────────────────
def latlon_to_xyz(lat, lon):
    """WGS84 → 3D cartesian (meters). Chord distance ≈ great-circle for short ranges."""
    lat_r = np.radians(np.asarray(lat, dtype=np.float64))
    lon_r = np.radians(np.asarray(lon, dtype=np.float64))
    cos_lat = np.cos(lat_r)
    return np.column_stack((
        EARTH_RADIUS_M * cos_lat * np.cos(lon_r),
        EARTH_RADIUS_M * cos_lat * np.sin(lon_r),
        EARTH_RADIUS_M * np.sin(lat_r),
    ))


class NodeIndex:
    def __init__(self, conn):
        t0 = time.time()
        rows = conn.execute("SELECT id, lat, lon FROM nodes").fetchall()
        if not rows:
            raise SystemExit("Database has no graph nodes — nothing to connect POIs to.")
        self.ids = np.array([r[0] for r in rows], dtype=np.int64)
        lats = np.array([r[1] for r in rows])
        lons = np.array([r[2] for r in rows])
        self.coords = np.column_stack((lats, lons))
        self.tree = cKDTree(latlon_to_xyz(lats, lons))
        print(f"Node index: {len(rows)} nodes in {time.time()-t0:.1f}s")

    def nearest(self, lat, lon, max_dist_m):
        """Return (node_id, node_lat, node_lon, distance_m) or None."""
        # chord length corresponding to the great-circle max distance
        chord = 2 * EARTH_RADIUS_M * math.sin(min(max_dist_m / EARTH_RADIUS_M, math.pi) / 2)
        dist, idx = self.tree.query(latlon_to_xyz(lat, lon)[0], distance_upper_bound=chord)
        if math.isinf(dist):
            return None
        gc_dist = 2 * EARTH_RADIUS_M * math.asin(min(dist / (2 * EARTH_RADIUS_M), 1.0))
        n_lat, n_lon = self.coords[idx]
        return (int(self.ids[idx]), float(n_lat), float(n_lon), gc_dist)


# ── Extraction ───────────────────────────────────────────────────────
def load_layer_pois(path: str, poi_type: str):
    """Yield (id, name, type_id, properties_dict, lat, lon) from one GeoJSON file."""
    with open(path) as f:
        fc = json.load(f)
    for feature in fc.get("features", []):
        props = feature.get("properties") or {}
        name = poi_name(props)
        if not name:
            continue
        geom_json = feature.get("geometry")
        if not geom_json:
            continue
        pt = poi_point(shape(geom_json))
        if pt is None:
            continue
        lat, lon = pt
        yield (
            poi_id(poi_type, lat, lon),
            name,
            POI_TYPES[poi_type],
            poi_properties(props, poi_type),
            lat,
            lon,
        )


# ── Database ─────────────────────────────────────────────────────────
POI_SCHEMA = """
CREATE TABLE IF NOT EXISTS poi_type_enum (
    id INTEGER PRIMARY KEY,
    description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pois (
    id INTEGER PRIMARY KEY,
    name TEXT,
    type_id INTEGER REFERENCES poi_type_enum(id),
    properties TEXT,
    lat REAL,
    lon REAL
);
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1],
                                 formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--db", required=True, help="Existing autoroute SQLite database")
    ap.add_argument("--input-dir", default="./output_geojson",
                    help="Directory with pipeline GeoJSON layers")
    ap.add_argument("--layer", action="append", default=[], metavar="TYPE=PATH",
                    help="Override/add a layer, e.g. bridge=/path/to/bridges.geojson. "
                         f"Types: {', '.join(POI_TYPES)}. Repeatable.")
    ap.add_argument("--types", default="harbour,lock,bridge,fairway,waterway",
                    help="Comma-separated POI types to import")
    ap.add_argument("--connect-radius", type=float, default=500.0,
                    help="Max distance (m) to associate a POI with a graph node")
    ap.add_argument("--snap-types", default="bridge,lock",
                    help="POI types snapped onto their nearest node when too far "
                         "for the router's 150 m crossing detection")
    ap.add_argument("--snap-if-beyond", type=float, default=120.0,
                    help="Snap a snap-type POI onto its node only if farther than this (m)")
    ap.add_argument("--skip-unconnected-types", default="",
                    help="Comma-separated types to DROP when no node is within connect-radius")
    ap.add_argument("--replace", action="store_true",
                    help="Update existing POI rows (default: keep existing, INSERT OR IGNORE)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what would be inserted without writing")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        raise SystemExit(f"Database not found: {args.db}")

    wanted = [t.strip() for t in args.types.split(",") if t.strip()]
    snap_types = {t.strip() for t in args.snap_types.split(",") if t.strip()}
    skip_unconnected = {t.strip() for t in args.skip_unconnected_types.split(",") if t.strip()}
    for t in list(wanted) + list(snap_types) + list(skip_unconnected):
        if t not in POI_TYPES:
            raise SystemExit(f"Unknown POI type: {t!r} (choose from {', '.join(POI_TYPES)})")

    # Resolve layer files: defaults from --input-dir, overridden by --layer
    layer_files = {t: os.path.join(args.input_dir, DEFAULT_LAYER_FILES[t]) for t in wanted}
    for spec in args.layer:
        if "=" not in spec:
            raise SystemExit(f"--layer expects TYPE=PATH, got {spec!r}")
        t, path = spec.split("=", 1)
        if t not in POI_TYPES:
            raise SystemExit(f"Unknown POI type in --layer: {t!r}")
        layer_files[t] = path
        if t not in wanted:
            wanted.append(t)

    conn = sqlite3.connect(args.db)
    conn.executescript(POI_SCHEMA)
    conn.executemany("INSERT OR IGNORE INTO poi_type_enum VALUES (?,?)",
                     [(v, k) for k, v in POI_TYPES.items()])

    index = NodeIndex(conn)

    insert_sql = ("INSERT OR REPLACE" if args.replace else "INSERT OR IGNORE") + \
        " INTO pois (id, name, type_id, properties, lat, lon) VALUES (?,?,?,?,?,?)"

    totals = {"read": 0, "connected": 0, "snapped": 0, "unconnected": 0,
              "skipped_unconnected": 0, "inserted": 0}

    for poi_type in wanted:
        path = layer_files[poi_type]
        if not os.path.exists(path):
            print(f"[{poi_type}] layer file missing, skipping: {path}")
            continue

        batch = []
        stats = {"read": 0, "connected": 0, "snapped": 0, "unconnected": 0, "skipped": 0}
        for pid, name, type_id, props, lat, lon in load_layer_pois(path, poi_type):
            stats["read"] += 1
            near = index.nearest(lat, lon, args.connect_radius)
            if near is None:
                if poi_type in skip_unconnected:
                    stats["skipped"] += 1
                    continue
                stats["unconnected"] += 1
            else:
                node_id, n_lat, n_lon, dist = near
                props["node_id"] = node_id
                props["node_dist_m"] = round(dist, 1)
                stats["connected"] += 1
                if poi_type in snap_types and dist > args.snap_if_beyond:
                    props["orig_lat"] = round(lat, 6)
                    props["orig_lon"] = round(lon, 6)
                    lat, lon = n_lat, n_lon
                    stats["snapped"] += 1
            batch.append((pid, name, type_id, json.dumps(props), lat, lon))

        if not args.dry_run and batch:
            before = conn.total_changes
            conn.executemany(insert_sql, batch)
            inserted = conn.total_changes - before
        else:
            inserted = len(batch)
        totals["inserted"] += inserted

        print(f"[{poi_type}] read={stats['read']} connected={stats['connected']} "
              f"snapped={stats['snapped']} unconnected={stats['unconnected']} "
              f"skipped={stats['skipped']} written={inserted}"
              + (" (dry-run)" if args.dry_run else ""))
        for k in ("read", "connected", "snapped", "unconnected"):
            totals[k] += stats[k]
        totals["skipped_unconnected"] += stats["skipped"]

    if args.dry_run:
        conn.rollback()
        print(f"\nDry run: {totals['read']} POIs read, would write {totals['inserted']}")
    else:
        conn.commit()
        count = conn.execute("SELECT COUNT(*) FROM pois").fetchone()[0]
        print(f"\nDone: {totals['inserted']} rows written "
              f"({totals['snapped']} snapped to nodes, "
              f"{totals['unconnected']} left unconnected). "
              f"Database now holds {count} POIs.")
    conn.close()


if __name__ == "__main__":
    main()
