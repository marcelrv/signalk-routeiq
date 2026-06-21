import os
import math
import json
import sqlite3
import hashlib
import logging
import argparse
import multiprocessing as mp
from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, Any, List, Tuple, Optional

import numpy as np
import pandas as pd
import geopandas as gpd
import networkx as nx
import shapely
from shapely.geometry import Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon
from shapely.ops import triangulate
from pyproj import Geod

def _is_valid(val):
    if val is None:
        return False
    if isinstance(val, np.ndarray):
        return val.size > 0
    try:
        return not pd.isna(val)
    except (ValueError, TypeError):
        return True

def _s57_col(attrs, *candidates):
    if isinstance(attrs, dict):
        keys = attrs.keys()
    else:
        keys = attrs.index if hasattr(attrs, 'index') else attrs
    lower_map = {str(k).lower(): k for k in keys}
    for c in candidates:
        match = lower_map.get(c.lower())
        if match is not None:
            return attrs[match]
    return None

def _parse_catbrg(catbrg):
    if isinstance(catbrg, (list, tuple, np.ndarray)):
        return [str(v) for v in catbrg]
    if isinstance(catbrg, str):
        import re
        vals = re.findall(r"(\d+)", catbrg)
        if vals:
            return vals
        return [catbrg]
    return [str(catbrg)]

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Module-level workers for edge attribute multiprocessing ---
_EDGE_ATTR_GEOD = None
_EDGE_ATTR_GDFS = {}

def _edge_attr_init(geod, gdfs):
    global _EDGE_ATTR_GEOD, _EDGE_ATTR_GDFS
    _EDGE_ATTR_GEOD = geod
    _EDGE_ATTR_GDFS = gdfs

def _candidates_by_bounds_static(gdf, geom, margin=0.0):
    bounds = geom.bounds
    if margin:
        bounds = (bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin)
    candidates = list(gdf.sindex.intersection(bounds))
    if candidates:
        return gdf.iloc[candidates]
    return gpd.GeoDataFrame()

def _edge_attr_worker(edge_chunk):
    geod = _EDGE_ATTR_GEOD
    gdfs = _EDGE_ATTR_GDFS
    CRS_WGS84 = "EPSG:4326"
    CRS_METRIC = "EPSG:3857"
    land_metric = gdfs.get('land_metric', gpd.GeoDataFrame())
    depare_gdf = gdfs.get('depth_areas', gpd.GeoDataFrame())
    bridges_gdf = gdfs.get('bridges', gpd.GeoDataFrame())
    fairways_gdf = gdfs.get('fairways', gpd.GeoDataFrame())
    locks_gdf = gdfs.get('locks', gpd.GeoDataFrame())
    obstacles_gdf = gdfs.get('obstacles', gpd.GeoDataFrame())

    results = {}
    for u, v, u_lon, u_lat, v_lon, v_lat, edge_type, u_res, v_res in edge_chunk:
        attrs = {}
        _, _, distance = geod.inv(u_lon, u_lat, v_lon, v_lat)
        attrs['distance'] = round(distance, 2)
        edge_geom = LineString([(u_lon, u_lat), (v_lon, v_lat)])

        # Depth — Fast Precision (5-point sample)
        attrs['min_depth'] = 99.0
        attrs['drval1'] = None
        if not depare_gdf.empty and 'DRVAL1' in depare_gdf.columns:
            candidates = _candidates_by_bounds_static(depare_gdf, edge_geom)
            if not candidates.empty:
                vals = candidates['DRVAL1'].dropna()
                if not vals.empty:
                    if float(vals.min()) >= 5.0:
                        min_val = float(vals.min())
                        attrs['min_depth'] = min_val
                        attrs['drval1'] = min_val
                    else:
                        sampled = []
                        for i in range(5):
                            f = i / 4.0
                            pt = Point(u_lon + f*(v_lon-u_lon), u_lat + f*(v_lat-u_lat))
                            found = None
                            for _, row in candidates.iterrows():
                                geom = row.geometry
                                if geom is not None and geom.contains(pt):
                                    found = row['DRVAL1']
                                    break
                            sampled.append(float(found) if pd.notna(found) else 99.0)
                        min_val = min(sampled)
                        attrs['min_depth'] = max(0.0, float(min_val))
                        attrs['drval1'] = min_val if min_val < 99.0 else None

        # Bridges - Determine Air Draft limit
        attrs['max_air_draft'] = 999.0
        if not bridges_gdf.empty:
            bridge_candidates = _candidates_by_bounds_static(bridges_gdf, edge_geom)
            if not bridge_candidates.empty:
                intersecting = bridge_candidates[bridge_candidates.intersects(edge_geom)]
                if not intersecting.empty:
                    min_clearance = 999.0
                    for _, row in intersecting.iterrows():
                        is_movable = False
                        catbrg = _s57_col(row, 'catbrg', 'CATAQA', 'CatBrg')
                        if _is_valid(catbrg):
                            vals = _parse_catbrg(catbrg)
                            if any(v in ('3', '4', '5', '6', '7') for v in vals):
                                is_movable = True
                        if not is_movable:
                            vercop = _s57_col(row, 'vercop', 'VERCOP', 'VerCop')
                            if _is_valid(vercop):
                                is_movable = True

                        if is_movable:
                            clearance = 999.0
                        else:
                            verclr = _s57_col(row, 'verclr', 'VERCLR', 'VerClr')
                            if _is_valid(verclr):
                                clearance = float(verclr)
                            else:
                                clearance = 999.0
                        if clearance < min_clearance:
                            min_clearance = clearance
                    attrs['max_air_draft'] = min_clearance

        # Locks
        attrs['min_width'] = 999.0
        if not locks_gdf.empty:
            lock_candidates = _candidates_by_bounds_static(locks_gdf, edge_geom)
            if not lock_candidates.empty:
                intersecting = lock_candidates[lock_candidates.intersects(edge_geom)]
                if not intersecting.empty and 'HORCLR' in intersecting.columns:
                    attrs['min_width'] = float(intersecting['HORCLR'].min())

        # Fairway + one-way (TRAFIC)
        attrs['is_fairway'] = False
        attrs['traffic_mode'] = 0
        if not fairways_gdf.empty:
            fw_candidates = _candidates_by_bounds_static(fairways_gdf, edge_geom)
            if not fw_candidates.empty:
                intersecting = fw_candidates[fw_candidates.intersects(edge_geom)]
                if not intersecting.empty:
                    attrs['is_fairway'] = True
                    if 'TRAFIC' in intersecting.columns:
                        trafic_vals = intersecting['TRAFIC'].dropna().unique()
                        if len(trafic_vals) == 1:
                            tv = int(trafic_vals[0])
                            if abs(tv) in (1, 3):
                                attrs['traffic_mode'] = 1 if tv in (1, 3) else 2

        # Distance to land
        attrs['distance_to_land'] = 9999.0
        if not land_metric.empty:
            edge_geom_metric = gpd.GeoSeries([edge_geom], crs=CRS_WGS84).to_crs(CRS_METRIC).iloc[0]
            possible_matches = land_metric.sindex.nearest(edge_geom_metric)
            if len(possible_matches[1]) > 0:
                closest_idx = possible_matches[1][0]
                closest_geom = land_metric.iloc[closest_idx].geometry
                attrs['distance_to_land'] = round(edge_geom_metric.distance(closest_geom), 2)

        # Obstacle crossing check
        attrs['crosses_obstacle'] = 0
        if not obstacles_gdf.empty:
            obs_candidates = _candidates_by_bounds_static(obstacles_gdf, edge_geom)
            if not obs_candidates.empty:
                intersecting = obs_candidates[obs_candidates.intersects(edge_geom)]
                if not intersecting.empty:
                    attrs['crosses_obstacle'] = 1

        results[(u, v)] = attrs
    return results

COORD_SPACE = 36000000
OBSTACLE_BUFFER_METERS = 5
EDGE_TYPE_COASTAL = 0
EDGE_TYPE_INLAND = 1
POI_TYPE_HARBOUR = 0
POI_TYPE_LOCK = 1
POI_TYPE_BRIDGE = 2
POI_TYPE_FAIRWAY = 3
POI_TYPE_WATERWAY = 4
TRAFFIC_TWO_WAY = 0
TRAFFIC_ONE_WAY_FWD = 1
TRAFFIC_ONE_WAY_REV = 2

def _s57_get_val(attrs, *candidates):
    val = _s57_col(attrs, *candidates)
    if val is None:
        return None
    if isinstance(val, (list, tuple, np.ndarray)):
        return val[0] if len(val) > 0 else None
    return val

def _is_entry_prohibited(row):
    restrn = _s57_col(row, 'restrn')
    if restrn is not None and pd.notnull(restrn):
        vals = restrn if isinstance(restrn, (list, tuple, np.ndarray)) else [restrn]
        for v in vals:
            try:
                if int(v) == 1:
                    return True
            except (ValueError, TypeError):
                pass
    for col in ('OBJNAM', 'NOBJNM', 'INFORM'):
        val = _s57_col(row, col)
        if val is not None and isinstance(val, str):
            lower = val.lower()
            if any(phrase in lower for phrase in ('entry prohibited', 'toegang verboden', 'passage prohibited')):
                return True
    return False

class NauticalRoutingPipeline:
    def __init__(self, data_paths: Dict[str, str], db_path: str,
                 country: str = "", region_name: str = "", description: str = "",
                 tags: Optional[str] = None, contributor: str = "", url: str = ""):
        self.data_paths = data_paths
        self.db_path = db_path
        self.country = country
        self.region_name = region_name or country
        self.description = description
        self.tags = tags or "[]"
        self.contributor = contributor
        self.url = url
        self.geod = Geod(ellps="WGS84")
        self.CRS_WGS84 = "EPSG:4326"
        self.CRS_METRIC = "EPSG:3857"
        self.gdfs = {}
        self.graph = nx.DiGraph()
        
    def run_pipeline(self):
        self.parse_shapefiles()
        self.build_network()
        self._add_opening_bridge_edges()
        self._validate_edges_against_land()
        self.calculate_edge_attributes()
        for u, v, data in self.graph.edges(data=True):
            if data.get("is_opening_bridge_edge"):
                data["max_air_draft"] = 999.0
        self._compute_node_depths()
        self.export_to_sqlite()
        logger.info("Pipeline execution completed successfully.")

    def parse_shapefiles(self):
        logger.info("Parsing shapefiles and GeoJSONs...")
        for layer_name, path in self.data_paths.items():
            if os.path.exists(path):
                gdf = gpd.read_file(path)
                if gdf.crs != self.CRS_WGS84:
                    gdf = gdf.to_crs(self.CRS_WGS84)
                self.gdfs[layer_name] = gdf
                logger.info(f"Loaded '{layer_name}' with {len(gdf)} features.")
            else:
                logger.warning(f"File not found for '{layer_name}': {path}. Using empty fallback.")
                self.gdfs[layer_name] = gpd.GeoDataFrame(geometry=[], crs=self.CRS_WGS84)
        self.gdfs_metric = {
            name: gdf.to_crs(self.CRS_METRIC) for name, gdf in self.gdfs.items()
        }
        self._build_obstacle_layer()

    def _build_obstacle_layer(self):
        logger.info("Building obstacle layer from restricted areas, hulks, obstructions...")
        obstacle_parts = []
        resare = self.gdfs.get("restricted_areas", gpd.GeoDataFrame())
        if not resare.empty:
            ep_mask = resare.apply(_is_entry_prohibited, axis=1)
            entry_prohibited = resare[ep_mask].copy()
            if not entry_prohibited.empty:
                entry_prohibited["_layer"] = "restricted_areas"
                obstacle_parts.append(entry_prohibited)

        hulks = self.gdfs.get("hulks", gpd.GeoDataFrame())
        if not hulks.empty:
            hulks = hulks.copy()
            hulks["_layer"] = "hulks"
            obstacle_parts.append(hulks)

        marcult = self.gdfs.get("mariculture", gpd.GeoDataFrame())
        if not marcult.empty:
            marcult = marcult.copy()
            marcult["_layer"] = "mariculture"
            obstacle_parts.append(marcult)

        obstrn = self.gdfs.get("obstructions", gpd.GeoDataFrame())
        if not obstrn.empty:
            buf_metric = obstrn.to_crs(self.CRS_METRIC)
            buf_metric["geometry"] = buf_metric.geometry.buffer(OBSTACLE_BUFFER_METERS)
            buf_wgs84 = buf_metric.to_crs(self.CRS_WGS84)
            buf_wgs84["_layer"] = "obstructions"
            obstacle_parts.append(buf_wgs84)

        if not obstacle_parts:
            self.gdfs["obstacles"] = gpd.GeoDataFrame(geometry=[], crs=self.CRS_WGS84)
            self.gdfs_metric["obstacles"] = gpd.GeoDataFrame(geometry=[], crs=self.CRS_METRIC)
            return

        merged = gpd.pd.concat(obstacle_parts, ignore_index=True)
        merged["geometry"] = merged["geometry"].make_valid()
        merged = merged[merged.geometry.notnull()]
        if not merged.empty:
            merged = merged[merged.geometry.is_valid]
        logger.info(f"  Combined obstacle layer: {len(merged)} features")
        self.gdfs["obstacles"] = merged
        self.gdfs_metric["obstacles"] = merged.to_crs(self.CRS_METRIC)

    def build_network(self):
        logger.info("Building base network topology...")
        self.coords_to_node = {}
        if "inland_waterways" in self.gdfs and not self.gdfs["inland_waterways"].empty:
            self._build_inland_network()
        if "coastal_water" in self.gdfs and not self.gdfs["coastal_water"].empty:
            self._build_coastal_navmesh()
        logger.info(f"Network built with {self.graph.number_of_nodes()} nodes and {self.graph.number_of_edges()} edges.")

    @staticmethod
    def _coord_to_id(lon: float, lat: float, node_type: str = "coastal") -> int:
        lat_int = int((round(lat, 5) + 90.0) * 100000)
        lon_int = int((round(lon, 5) + 180.0) * 100000)
        type_int = 1 if node_type == "inland" else 0
        return (type_int * 648000000000000) + (lat_int * COORD_SPACE) + lon_int

    @staticmethod
    def _generate_poi_id(poi_type: str, lat: float, lon: float) -> int:
        unique_str = f"{poi_type}_{round(lat, 5)}_{round(lon, 5)}"
        return int(hashlib.md5(unique_str.encode("utf-8")).hexdigest()[:13], 16)

    def _get_or_create_node(self, lon: float, lat: float, node_type: str = "coastal") -> int:
        coord = (round(lon, 5), round(lat, 5))
        if coord in self.coords_to_node:
            existing_id = self.coords_to_node[coord]
            if existing_id not in self.graph:
                del self.coords_to_node[coord]
                node_id = self._coord_to_id(lon, lat, node_type)
                self.graph.add_node(node_id, lon=coord[0], lat=coord[1], node_type=node_type)
                self.coords_to_node[coord] = node_id
                return node_id
            return existing_id
        node_id = self._coord_to_id(lon, lat, node_type)
        self.graph.add_node(node_id, lon=coord[0], lat=coord[1], node_type=node_type)
        self.coords_to_node[coord] = node_id
        return node_id

    def _build_inland_network(self):
        inland_gdf = self.gdfs["inland_waterways"]
        for fi, (_, row) in enumerate(inland_gdf.iterrows()):
            geom = row.geometry
            if isinstance(geom, LineString):
                coords = list(geom.coords)
                for i in range(len(coords) - 1):
                    u_lon, u_lat = coords[i]
                    v_lon, v_lat = coords[i+1]
                    u = self._get_or_create_node(u_lon, u_lat, node_type="inland")
                    v = self._get_or_create_node(v_lon, v_lat, node_type="inland")
                    self.graph.add_edge(u, v, edge_type="inland")
                    self.graph.add_edge(v, u, edge_type="inland")

    def _build_coastal_navmesh(self):
        coastal_gdf = self.gdfs.get("coastal_water")
        if coastal_gdf is None or coastal_gdf.empty:
            logger.warning("No coastal water data. Skipping navmesh.")
            return
            
        bounds = coastal_gdf.total_bounds
        BIN_SIZE = 0.0005 
        binned_points = {}
        
        def add_point(lon, lat, priority):
            bx, by = int(lon / BIN_SIZE), int(lat / BIN_SIZE)
            if (bx, by) not in binned_points or priority > binned_points[(bx, by)][2]:
                binned_points[(bx, by)] = (lon, lat, priority)

        logger.info("Step 1: Injecting Fairways, Contours & Basins...")
        
        # Prio 3: Inland Centerlines & Fairways
        hw_gdfs = []
        if not self.gdfs.get("fairways", gpd.GeoDataFrame()).empty: hw_gdfs.append(self.gdfs["fairways"])
        if not self.gdfs.get("inland_waterways", gpd.GeoDataFrame()).empty: hw_gdfs.append(self.gdfs["inland_waterways"])
            
        if hw_gdfs:
            hw_gdf = pd.concat(hw_gdfs, ignore_index=True)
            for geom in hw_gdf.geometry:
                if geom is None: continue
                lines = []
                if isinstance(geom, (Polygon, MultiPolygon)):
                    boundary = geom.boundary
                    lines = boundary.geoms if isinstance(boundary, MultiLineString) else [boundary]
                elif isinstance(geom, (LineString, MultiLineString)):
                    lines = geom.geoms if isinstance(geom, MultiLineString) else [geom]
                for line in lines:
                    simple_line = line.simplify(0.001)
                    for pt in simple_line.coords: add_point(pt[0], pt[1], 3)

        # Prio 2: Centroids of all water areas 
        for geom in coastal_gdf.geometry:
            if geom is not None and isinstance(geom, (Polygon, MultiPolygon)):
                rep = geom.representative_point()
                add_point(rep.x, rep.y, 2)
                
        # Prio 1: Depth Contours
        depare_gdf = self.gdfs.get("depth_areas", gpd.GeoDataFrame())
        if not depare_gdf.empty and "DRVAL1" in depare_gdf.columns:
            deep_areas = depare_gdf[depare_gdf["DRVAL1"] >= 0.5]
            for geom in deep_areas.geometry:
                if geom is None: continue
                lines = []
                if isinstance(geom, (Polygon, MultiPolygon)):
                    boundary = geom.boundary
                    lines = boundary.geoms if isinstance(boundary, MultiLineString) else [boundary]
                elif isinstance(geom, (LineString, MultiLineString)):
                    lines = geom.geoms if isinstance(geom, MultiLineString) else [geom]
                for line in lines:
                    simple_line = line.simplify(0.001)
                    for pt in simple_line.coords: add_point(pt[0], pt[1], 1)

        # Prio 0: Vectorized Coarse Grid
        MAX_RES = 0.005  
        xs = np.arange(bounds[0], bounds[2], MAX_RES)
        ys = np.arange(bounds[1], bounds[3], MAX_RES)
        xx, yy = np.meshgrid(xs, ys)
        grid_pts = gpd.GeoSeries(gpd.points_from_xy(xx.flatten(), yy.flatten()), crs=self.CRS_WGS84)
        
        coastal_geom = coastal_gdf.geometry
        in_water_mask = grid_pts.sindex.query(coastal_geom, predicate="contains")
        valid_pt_indices = np.unique(in_water_mask[1]) if in_water_mask.size > 0 else np.array([])
        for pt in grid_pts.iloc[valid_pt_indices]:
            add_point(pt.x, pt.y, 0)

        # Gap Filler
        invalid_pt_indices = np.setdiff1d(np.arange(len(grid_pts)), valid_pt_indices)
        invalid_points = grid_pts.iloc[invalid_pt_indices]
        
        offset = MAX_RES / 3.0  
        shifts = [(offset, 0), (-offset, 0), (0, offset), (0, -offset),
                  (offset, offset), (-offset, -offset), (offset, -offset), (-offset, offset)]
        for dx, dy in shifts:
            shifted_pts = gpd.GeoSeries(gpd.points_from_xy(invalid_points.x + dx, invalid_points.y + dy), crs=self.CRS_WGS84)
            mask = shifted_pts.sindex.query(coastal_geom, predicate="contains")
            if mask.size > 0:
                valid_shifted_indices = np.unique(mask[1])
                for pt in shifted_pts.iloc[valid_shifted_indices]: add_point(pt.x, pt.y, 0)
                        
        points = [(x, y) for x, y, _ in binned_points.values()]
        logger.info(f"Step 2: Total NavMesh Points: {len(points)}")
        
        if len(points) < 3: return

        logger.info("Step 3: Delaunay Triangulation...")
        try:
            import scipy.spatial
            pts_array = np.array(points)
            tri = scipy.spatial.Delaunay(pts_array)
            simplices = tri.simplices
            edges = np.vstack((
                simplices[:, [0, 1]],
                simplices[:, [1, 2]],
                simplices[:, [2, 0]]
            ))
            edges.sort(axis=1)
            unique_edges = np.unique(edges, axis=0)
            
            MAX_EDGE_LEN = 0.015  # ~1.5km
            pt_to_id = {}
            for pt in points:
                u = self._get_or_create_node(pt[0], pt[1], "coastal")
                self.graph.nodes[u]["resolution"] = 0.005
                pt_to_id[(pt[0], pt[1])] = u

            added_edges = 0
            # Pure Delaunay without Gabriel Pruning creates beautiful natural diagonals.
            for idx1, idx2 in unique_edges:
                p1 = pts_array[idx1]
                p2 = pts_array[idx2]
                dist_deg = math.hypot(p1[0]-p2[0], p1[1]-p2[1])
                
                if dist_deg <= MAX_EDGE_LEN:
                    u = pt_to_id[(p1[0], p1[1])]
                    v = pt_to_id[(p2[0], p2[1])]
                    if not self.graph.has_edge(u, v):
                        self.graph.add_edge(u, v, edge_type="coastal")
                        self.graph.add_edge(v, u, edge_type="coastal")
                        added_edges += 2
                            
        except ImportError:
            logger.warning("  SciPy not found! Falling back to Shapely.")
            
        logger.info(f"Coastal navmesh complete: {self.graph.number_of_nodes()} nodes, {added_edges} new edges.")


    def _add_opening_bridge_edges(self):
        """Creates accurate nodes exactly at the bridge opening span using centerline intersection."""
        bridges_gdf = self.gdfs.get("bridges", gpd.GeoDataFrame())
        if bridges_gdf.empty:
            return

        logger.info("Adding opening bridge crossing edges (Fairway Intersections)...")
        added = 0

        # Combine Inland Waterways and Fairways to find the true navigable opening
        fw_gdfs = []
        if not self.gdfs.get("fairways", gpd.GeoDataFrame()).empty: fw_gdfs.append(self.gdfs["fairways"])
        if not self.gdfs.get("inland_waterways", gpd.GeoDataFrame()).empty: fw_gdfs.append(self.gdfs["inland_waterways"])
        hw_gdf = pd.concat(fw_gdfs, ignore_index=True) if fw_gdfs else gpd.GeoDataFrame()

        for _, row in bridges_gdf.iterrows():
            is_movable = False
            catbrg = _s57_col(row, "catbrg", "CATAQA", "CatBrg")
            if _is_valid(catbrg):
                vals = _parse_catbrg(catbrg)
                if any(v in ("3", "4", "5", "6", "7") for v in vals): is_movable = True
            if not is_movable:
                vercop = _s57_col(row, "vercop", "VERCOP", "VerCop")
                if _is_valid(vercop): is_movable = True
            if not is_movable:
                continue

            bridge_geom = row.geometry
            opening_pts = []

            # Determine exact opening location by intersecting bridge polygon with fairways
            if not hw_gdf.empty:
                intersecting = hw_gdf[hw_gdf.intersects(bridge_geom)]
                for _, hw_row in intersecting.iterrows():
                    intersection = bridge_geom.intersection(hw_row.geometry)
                    if isinstance(intersection, Point):
                        opening_pts.append(intersection)
                    elif isinstance(intersection, (MultiPoint, LineString, MultiLineString)):
                        opening_pts.append(intersection.centroid)

            # Fallback to bridge centroid if no fairway exists
            if not opening_pts:
                opening_pts.append(bridge_geom.centroid)

            for pt in opening_pts:
                c_lon, c_lat = pt.x, pt.y
                b_id = self._get_or_create_node(c_lon, c_lat, node_type="coastal")
                self.graph.nodes[b_id]["resolution"] = 0.001
                self.graph.nodes[b_id]["node_depth"] = 99.0

                # Connect opening to the 4 nearest surrounding nodes via Quadrant Ray-Casting
                SEARCH_MARGIN = 0.015
                candidates = []
                for nid, data in self.graph.nodes(data=True):
                    if nid == b_id: continue
                    lon, lat = data["lon"], data["lat"]
                    if (c_lon - SEARCH_MARGIN <= lon <= c_lon + SEARCH_MARGIN and
                        c_lat - SEARCH_MARGIN <= lat <= c_lat + SEARCH_MARGIN):
                        dx = (lon - c_lon) * 111320 * math.cos(math.radians((lat + c_lat) / 2))
                        dy = (lat - c_lat) * 111320
                        candidates.append((math.sqrt(dx*dx + dy*dy), lon, lat, nid))
                
                quadrants = {"NE": [], "NW": [], "SE": [], "SW": []}
                for d, lon, lat, nid in candidates:
                    if lon >= c_lon and lat >= c_lat: quadrants["NE"].append((d, nid))
                    elif lon < c_lon and lat >= c_lat: quadrants["NW"].append((d, nid))
                    elif lon >= c_lon and lat < c_lat: quadrants["SE"].append((d, nid))
                    else: quadrants["SW"].append((d, nid))
                    
                for q, nodes in quadrants.items():
                    if nodes:
                        nodes.sort()
                        best_nid = nodes[0][1]
                        if not self.graph.has_edge(b_id, best_nid):
                            self.graph.add_edge(b_id, best_nid, edge_type="coastal", crosses_land=0, is_opening_bridge_edge=True)
                            self.graph.add_edge(best_nid, b_id, edge_type="coastal", crosses_land=0, is_opening_bridge_edge=True)
                            added += 2

        logger.info(f"Added {added} precise bridge opening edges.")

    def _validate_edges_against_land(self):
        """Vectorized High-Performance Land Validation."""
        land_gdf = self.gdfs.get("land", gpd.GeoDataFrame())
        coastal_gdf = self.gdfs.get("coastal_water", gpd.GeoDataFrame())

        if coastal_gdf.empty:
            return

        logger.info("Validating coastal edges against land polygons (Vectorized)...")

        # 1. Collect coastal edges
        edge_data = []
        for u, v, data in self.graph.edges(data=True):
            if data.get("edge_type") == "coastal":
                # Ensure we only process unique undirected edges
                if u < v:
                    u_lon, u_lat = self.graph.nodes[u]["lon"], self.graph.nodes[u]["lat"]
                    v_lon, v_lat = self.graph.nodes[v]["lon"], self.graph.nodes[v]["lat"]
                    edge_data.append({"u": u, "v": v, "geometry": LineString([(u_lon, u_lat), (v_lon, v_lat)])})

        if not edge_data:
            return

        edges_gdf = gpd.GeoDataFrame(edge_data, crs=self.CRS_WGS84)
        logger.info(f"  Checking {len(edges_gdf)} unique coastal edges via Spatial Join")

        # 2. Vectorized Midpoint Water Check
        edges_gdf["midpoint"] = edges_gdf.geometry.centroid
        midpoints_gdf = edges_gdf.set_geometry("midpoint")
        valid_mids = gpd.sjoin(midpoints_gdf, coastal_gdf[["geometry"]], predicate="within", how="inner")
        
        valid_u_v = set(zip(valid_mids["u"], valid_mids["v"]))
        edges_to_remove = [(row["u"], row["v"]) for _, row in edges_gdf.iterrows() if (row["u"], row["v"]) not in valid_u_v]

        logger.info(f"  Midpoint water check: {len(valid_u_v)}/{len(edges_gdf)} passed")

        # 3. Vectorized Land-Crossing Check (Only test edges that passed midpoint check)
        if not land_gdf.empty:
            remaining_edges = edges_gdf[edges_gdf.apply(lambda r: (r["u"], r["v"]) in valid_u_v, axis=1)].set_geometry("geometry")
            land_intersections = gpd.sjoin(remaining_edges, land_gdf[["geometry"]], predicate="crosses", how="inner")
            crossed_u_v = set(zip(land_intersections["u"], land_intersections["v"]))
            
            edges_to_remove.extend(crossed_u_v)
            logger.info(f"  Land-crossing check: removed an additional {len(crossed_u_v)} edges")

        # 4. Strip them from the graph
        removed_count = 0
        for u, v in edges_to_remove:
            if self.graph.has_edge(u, v): 
                self.graph.remove_edge(u, v)
                removed_count += 1
            if self.graph.has_edge(v, u): 
                self.graph.remove_edge(v, u)
                removed_count += 1

        for u, v, data in self.graph.edges(data=True):
            if data.get("edge_type") == "coastal":
                self.graph.edges[u, v]["crosses_land"] = 0

        logger.info(f"Land-crossing validation complete: removed {removed_count} directed edges. Validation took only seconds.")

    def _compute_node_depths(self):
        depare_gdf = self.gdfs.get("depth_areas", gpd.GeoDataFrame())
        if depare_gdf.empty:
            for _, data in self.graph.nodes(data=True): data["node_depth"] = -1
            return

        logger.info("Computing node depths from DEPARE polygons...")
        positive = depare_gdf.copy()
        
        total = self.graph.number_of_nodes()
        found = 0
        for i, (nid, data) in enumerate(self.graph.nodes(data=True)):
            if (i + 1) % max(1, total // 10) == 0:
                logger.info(f"  Node depths: {i + 1}/{total} ({found} found)")

            pt = Point(data["lon"], data["lat"])
            candidates = list(positive.sindex.intersection(pt.bounds))
            depth = -1
            for idx in candidates:
                row = positive.iloc[idx]
                if row.geometry.contains(pt):
                    if "DRVAL1" in row and pd.notnull(row["DRVAL1"]):
                        depth = max(0.0, float(row["DRVAL1"]))
                    else:
                        depth = 99.0
                    found += 1
                    break
            data["node_depth"] = depth

    def calculate_edge_attributes(self):
        logger.info("Calculating advanced edge attributes (multiprocessing)...")
        total_edges = self.graph.number_of_edges()
        
        num_workers = max(1, min(int(mp.cpu_count() * 0.8), 4))

        def edge_generator():
            for u, v, data in self.graph.edges(data=True):
                u_node = self.graph.nodes[u]
                v_node = self.graph.nodes[v]
                yield (
                    u, v,
                    u_node["lon"], u_node["lat"],
                    v_node["lon"], v_node["lat"],
                    data.get("edge_type", "coastal"),
                    u_node.get("resolution", 0.005),
                    v_node.get("resolution", 0.005),
                )

        def chunked_iterable(iterable, size):
            import itertools
            it = iter(iterable)
            while True:
                chunk = tuple(itertools.islice(it, size))
                if not chunk: break
                yield chunk

        fw_gdfs = []
        if not self.gdfs.get("fairways", gpd.GeoDataFrame()).empty: fw_gdfs.append(self.gdfs["fairways"])
        if not self.gdfs.get("inland_waterways", gpd.GeoDataFrame()).empty: fw_gdfs.append(self.gdfs["inland_waterways"])
        highways_gdf = pd.concat(fw_gdfs, ignore_index=True) if fw_gdfs else gpd.GeoDataFrame(geometry=[])

        worker_gdfs = {
            "land_metric": self.gdfs_metric.get("land", gpd.GeoDataFrame()),
            "depth_areas": self.gdfs.get("depth_areas", gpd.GeoDataFrame()),
            "bridges": self.gdfs.get("bridges", gpd.GeoDataFrame()),
            "fairways": highways_gdf,
            "locks": self.gdfs.get("locks", gpd.GeoDataFrame()),
            "obstacles": self.gdfs.get("obstacles", gpd.GeoDataFrame()),
        }
        for gdf in worker_gdfs.values():
            if not gdf.empty:
                _ = gdf.sindex  

        logger.info(f"  Spawning {num_workers} workers for {total_edges} edges...")
        merged = 0
        CHUNK_SIZE = 25000 

        with mp.Pool(num_workers, initializer=_edge_attr_init, initargs=(self.geod, worker_gdfs)) as pool:
            result_iterator = pool.imap_unordered(
                _edge_attr_worker, 
                chunked_iterable(edge_generator(), CHUNK_SIZE)
            )
            for results in result_iterator:
                for (u, v), attrs in results.items():
                    for key, value in attrs.items():
                        self.graph.edges[u, v][key] = value
                    merged += 1
                if merged % 250000 == 0 or merged == total_edges:
                    logger.info(f"  Edge attributes merged: {merged}/{total_edges} ({(merged/total_edges)*100:.1f}%)")

    def _compute_boundary_geometry(self) -> Tuple[str, str]:
        nodes = [(data["lon"], data["lat"]) for _, data in self.graph.nodes(data=True)]
        if not nodes:
            empty = json.dumps({"type": "Polygon", "coordinates": [[[0, 0], [0, 0], [0, 0], [0, 0]]]})
            return (json.dumps({"min_lat": 0, "min_lon": 0, "max_lat": 0, "max_lon": 0}), empty)

        lons, lats = zip(*nodes)
        bbox = json.dumps({
            "min_lat": min(lats), "min_lon": min(lons),
            "max_lat": max(lats), "max_lon": max(lons)
        })

        if len(nodes) < 3:
            poly = Polygon([(min(lons), min(lats)), (min(lons), max(lats)),
                            (max(lons), max(lats)), (max(lons), min(lats)),
                            (min(lons), min(lats))])
        else:
            points = [Point(lon, lat) for lon, lat in nodes]
            hull = MultiPoint(points).convex_hull
            if isinstance(hull, (Point, LineString)):
                poly = Polygon([(min(lons), min(lats)), (min(lons), max(lats)),
                                (max(lons), max(lats)), (max(lons), min(lats)),
                                (min(lons), min(lats))])
            else:
                poly = hull

        geom_json = json.dumps(poly.__geo_interface__)
        return (bbox, geom_json)

    def export_to_sqlite(self):
        logger.info(f"Exporting data to SQLite database at '{self.db_path}'...")
        
        if os.path.exists(self.db_path):
            os.remove(self.db_path)
            
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            
            cursor.executescript("""
                CREATE TABLE metadata (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    country TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT,
                    last_update_date TEXT NOT NULL,
                    tags TEXT DEFAULT '[]',
                    bounding_box TEXT,
                    boundary_geometry TEXT,
                    schema_version INTEGER DEFAULT 3,
                    contributor TEXT DEFAULT '',
                    url TEXT DEFAULT ''
                );
                
                CREATE TABLE edge_type_enum (
                    id INTEGER PRIMARY KEY,
                    description TEXT NOT NULL
                );
                INSERT INTO edge_type_enum VALUES (0, 'coastal'), (1, 'inland');
                
                CREATE TABLE poi_type_enum (
                    id INTEGER PRIMARY KEY,
                    description TEXT NOT NULL
                );
                INSERT INTO poi_type_enum VALUES
                    (0, 'harbour'), (1, 'lock'), (2, 'bridge'), (3, 'fairway'), (4, 'waterway');
                
                CREATE TABLE nodes (
                    id INTEGER PRIMARY KEY,
                    lat REAL,
                    lon REAL,
                    resolution REAL DEFAULT 0.0,
                    node_depth REAL DEFAULT -1,
                    region_id INTEGER REFERENCES metadata(id) ON DELETE CASCADE
                );
                
                CREATE TABLE edges (
                    source INTEGER,
                    target INTEGER,
                    distance REAL,
                    min_depth REAL,
                    drval1 REAL,
                    max_air_draft REAL,
                    min_width REAL,
                    is_fairway INTEGER DEFAULT 0,
                    distance_to_land REAL DEFAULT 9999.0,
                    edge_type_id INTEGER DEFAULT 0 REFERENCES edge_type_enum(id),
                    traffic_mode INTEGER DEFAULT 0,
                    crosses_land INTEGER DEFAULT 0,
                    crosses_obstacle INTEGER DEFAULT 0,
                    FOREIGN KEY(source) REFERENCES nodes(id),
                    FOREIGN KEY(target) REFERENCES nodes(id)
                );
                
                CREATE TABLE pois (
                    id INTEGER PRIMARY KEY,
                    name TEXT,
                    type_id INTEGER REFERENCES poi_type_enum(id),
                    properties TEXT,
                    lat REAL,
                    lon REAL
                );
                
                CREATE INDEX idx_edges_source ON edges(source);
                CREATE INDEX idx_edges_target ON edges(target);
                CREATE INDEX idx_nodes_lat_lon ON nodes(lat, lon);
            """)
            
            now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            bbox_json, boundary_json = self._compute_boundary_geometry()
            cursor.execute(
                """INSERT INTO metadata
                   (country, name, description, last_update_date, tags, bounding_box, boundary_geometry, schema_version, contributor, url)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                 (self.country, self.region_name, self.description, now_utc,
                 self.tags, bbox_json, boundary_json, 3,
                 self.contributor, self.url)
            )
            region_id = cursor.lastrowid
            
            nodes_data = [(n, data["lat"], data["lon"],
                           data.get("resolution", 0.0),
                           data.get("node_depth", -1),
                           region_id)
                          for n, data in self.graph.nodes(data=True)]
            cursor.executemany("INSERT INTO nodes (id, lat, lon, resolution, node_depth, region_id) VALUES (?, ?, ?, ?, ?, ?)", nodes_data)
            
            edges_data = [(
                u, v,
                data.get("distance", 0.0),
                data.get("min_depth", 99.0),
                data.get("drval1"),  
                data.get("max_air_draft", 999.0),
                data.get("min_width", 999.0),
                int(data.get("is_fairway", False)),
                data.get("distance_to_land", 9999.0),
                EDGE_TYPE_COASTAL if data.get("edge_type", "coastal") == "coastal" else EDGE_TYPE_INLAND,
                data.get("traffic_mode", TRAFFIC_TWO_WAY),
                int(data.get("crosses_land", 0)),
                int(data.get("crosses_obstacle", 0))
            ) for u, v, data in self.graph.edges(data=True)]
            cursor.executemany("""
                INSERT INTO edges
                (source, target, distance, min_depth, drval1, max_air_draft, min_width, is_fairway, distance_to_land, edge_type_id, traffic_mode, crosses_land, crosses_obstacle)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, edges_data)
            
            def _poi_name(row) -> str:
                for col in ("OBJNAM", "NOBJNM", "name"):
                    val = row.get(col)
                    if val is not None and not (isinstance(val, float) and np.isnan(val)):
                        return str(val)
                return ""

            def _poi_point(geom):
                if isinstance(geom, Point):
                    return (geom.y, geom.x)
                elif isinstance(geom, Polygon):
                    c = geom.centroid
                    return (c.y, c.x)
                elif isinstance(geom, LineString):
                    c = geom.interpolate(0.5, normalized=True)
                    return (c.y, c.x)
                return None

            POI_TYPE_MAP = {
                "harbour": POI_TYPE_HARBOUR,
                "lock": POI_TYPE_LOCK,
                "bridge": POI_TYPE_BRIDGE,
                "fairway": POI_TYPE_FAIRWAY,
                "waterway": POI_TYPE_WATERWAY,
            }

            def _poi_properties(row, default_type) -> str:
                props = {}
                if default_type == "bridge":
                    is_opening = False
                    catbrg = _s57_col(row, "catbrg", "CATAQA", "CatBrg")
                    if catbrg is not None and pd.notnull(catbrg):
                        vals = _parse_catbrg(catbrg)
                        if any(v in ("3", "4", "5", "6", "7") for v in vals):
                            is_opening = True
                    if not is_opening:
                        vercop = _s57_col(row, "vercop", "VERCOP", "VerCop")
                        if vercop is not None and pd.notnull(vercop):
                            is_opening = True
                    if is_opening:
                        props["subtype"] = "opening"
                    else:
                        props["subtype"] = "fixed"
                        verclr = _s57_col(row, "verclr", "VERCLR", "VerClr")
                        if verclr is not None and pd.notnull(verclr):
                            props["height"] = float(verclr)
                return json.dumps(props)

            poi_layers = [
                ("pois", "harbour"),
                ("locks", "lock"),
                ("bridges", "bridge"),
                ("fairways", "fairway"),
                ("inland_waterways", "waterway"),
            ]
            poi_data = []
            for layer_key, default_type in poi_layers:
                gdf = self.gdfs.get(layer_key, gpd.GeoDataFrame())
                if gdf.empty:
                    continue
                for _, row in gdf.iterrows():
                    name = _poi_name(row)
                    if not name:
                        continue
                    pt = _poi_point(row.geometry)
                    if pt is None:
                        continue
                    pid = self._generate_poi_id(default_type, pt[0], pt[1])
                    type_id = POI_TYPE_MAP.get(default_type, POI_TYPE_HARBOUR)
                    poi_data.append((pid, name, type_id, _poi_properties(row, default_type), pt[0], pt[1]))
            if poi_data:
                cursor.executemany("INSERT OR IGNORE INTO pois (id, name, type_id, properties, lat, lon) VALUES (?, ?, ?, ?, ?, ?)", poi_data)
                logger.info(f"Inserted {len(poi_data)} named POIs from {len(poi_layers)} layers")
            else:
                logger.warning("No named POIs found in any layer")
                
            conn.commit()
            cursor.execute("VACUUM;")
        logger.info("Export completed and database vacuumed/compressed.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build routing graph SQLite database from GeoJSON layers.")
    parser.add_argument("--input-dir", default="./output_geojson",
                        help="Directory containing preprocessed GeoJSON files (default: ./output_geojson)")
    parser.add_argument("--output", default="./routing_graph.sqlite",
                        help="Output SQLite database path (default: ./output_geojson)")
    parser.add_argument("--country", default="",
                        help="ISO country code for this region (e.g., NL, BE)")
    parser.add_argument("--name", default="",
                        help="Human-readable region name (e.g., Netherlands)")
    parser.add_argument("--description", default="",
                        help="Optional description of the data coverage")
    parser.add_argument("--tags", default="[]",
                        help='JSON array of tags, e.g. \'["official","rws","enc"]\'')
    parser.add_argument("--contributor", default="",
                        help="GitHub username or organization that contributed this data")
    parser.add_argument("--url", default="",
                        help="Source URL for the original data")
    args = parser.parse_args()

    data_sources = {
        "land": os.path.join(args.input_dir, "land_polygons.geojson"),
        "coastal_water": os.path.join(args.input_dir, "coastal_water_polygons.geojson"),
        "inland_waterways": os.path.join(args.input_dir, "inland_waterways_lines.geojson"),
        "depth_areas": os.path.join(args.input_dir, "depare_polygons.geojson"),
        "bridges": os.path.join(args.input_dir, "bridges_polygons.geojson"),
        "locks": os.path.join(args.input_dir, "locks_polygons.geojson"),
        "fairways": os.path.join(args.input_dir, "fairways_polygons.geojson"),
        "pois": os.path.join(args.input_dir, "pois_points.geojson"),
        "restricted_areas": os.path.join(args.input_dir, "restricted_areas_polygons.geojson"),
        "obstacles": os.path.join(args.input_dir, "obstructions_points.geojson"),
        "hulks": os.path.join(args.input_dir, "hulks_polygons.geojson"),
        "mariculture": os.path.join(args.input_dir, "mariculture_polygons.geojson"),
        "caution_areas": os.path.join(args.input_dir, "caution_areas_polygons.geojson")
    }

    pipeline = NauticalRoutingPipeline(data_paths=data_sources, db_path=args.output,
                                       country=args.country, region_name=args.name,
                                       description=args.description,
                                       tags=args.tags, contributor=args.contributor,
                                       url=args.url)
    pipeline.run_pipeline()
