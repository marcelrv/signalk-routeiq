import os
import math
import json
import sqlite3
import logging
import argparse
import multiprocessing as mp
from collections import defaultdict
from typing import Dict, Any, List, Tuple, Optional

import numpy as np
import pandas as pd
import geopandas as gpd
import networkx as nx
from shapely.geometry import Point, LineString, Polygon
from pyproj import Geod

def _s57_col(attrs, *candidates):
    """Case-insensitive lookup for an S-57 attribute in a row/dict."""
    if isinstance(attrs, dict):
        keys = attrs.keys()
    else:
        # pandas Series
        keys = attrs.index if hasattr(attrs, 'index') else attrs
    lower_map = {str(k).lower(): k for k in keys}
    for c in candidates:
        match = lower_map.get(c.lower())
        if match is not None:
            return attrs[match]
    return None

def _parse_catbrg(catbrg):
    """Normalize catbrg to a list of string category values."""
    if isinstance(catbrg, (list, tuple, np.ndarray)):
        return [str(v) for v in catbrg]
    if isinstance(catbrg, str):
        # Handle stringified numpy arrays like "['9' '7']"
        import re
        vals = re.findall(r"(\d+)", catbrg)
        if vals:
            return vals
        return [catbrg]
    return [str(catbrg)]

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Module-level globals & workers for multiprocessing fork-based sharing ---
_COARSE_SCAN_GDF = None

def _coarse_scan_init(gdf):
    global _COARSE_SCAN_GDF
    _COARSE_SCAN_GDF = gdf

def _coarse_scan_worker(columns_x, y_coords):
    """Multiprocessing worker: return list of (x, y) water points for given columns."""
    gdf = _COARSE_SCAN_GDF
    results = []
    for x in columns_x:
        for y in y_coords:
            pt = Point(x, y)
            candidates = list(gdf.sindex.intersection(pt.bounds))
            for idx in candidates:
                if gdf.iloc[idx].geometry.contains(pt):
                    results.append((x, y))
                    break
    return results

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
    """Process a chunk of edges. Returns dict {(u, v): {attr: value}}."""
    geod = _EDGE_ATTR_GEOD
    gdfs = _EDGE_ATTR_GDFS
    CRS_WGS84 = "EPSG:4326"
    CRS_METRIC = "EPSG:3857"
    land_metric = gdfs.get('land_metric', gpd.GeoDataFrame())
    depare_gdf = gdfs.get('depth_areas', gpd.GeoDataFrame())
    bridges_gdf = gdfs.get('bridges', gpd.GeoDataFrame())
    fairways_gdf = gdfs.get('fairways', gpd.GeoDataFrame())
    locks_gdf = gdfs.get('locks', gpd.GeoDataFrame())

    results = {}
    for u, v, u_lon, u_lat, v_lon, v_lat, edge_type, u_res, v_res in edge_chunk:
        attrs = {}
        _, _, distance = geod.inv(u_lon, u_lat, v_lon, v_lat)
        attrs['distance'] = round(distance, 2)

        edge_geom = LineString([(u_lon, u_lat), (v_lon, v_lat)])

        # Depth
        attrs['min_depth'] = 99.0
        if not depare_gdf.empty:
            depare_candidates = _candidates_by_bounds_static(depare_gdf, edge_geom)
            if not depare_candidates.empty:
                intersecting = depare_candidates[depare_candidates.intersects(edge_geom)]
                if not intersecting.empty:
                    if 'DRVAL1' in intersecting.columns:
                        positive = intersecting[intersecting['DRVAL1'] > 0]
                        if not positive.empty:
                            attrs['min_depth'] = float(positive['DRVAL1'].min())

        # Bridges
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
                        if catbrg is not None and pd.notnull(catbrg):
                            vals = _parse_catbrg(catbrg)
                            if any(v in ('3', '4', '5', '6', '7') for v in vals):
                                is_movable = True
                        if not is_movable:
                            vercop = _s57_col(row, 'vercop', 'VERCOP', 'VerCop')
                            if vercop is not None and pd.notnull(vercop):
                                is_movable = True

                        if is_movable:
                            clearance = 999.0
                        else:
                            verclr = _s57_col(row, 'verclr', 'VERCLR', 'VerClr')
                            if verclr is not None and pd.notnull(verclr):
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
        attrs['is_one_way'] = False
        attrs['traffic_dir'] = 1
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
                                attrs['is_one_way'] = True
                                attrs['traffic_dir'] = 1 if tv in (1, 3) else -1

        # Direction penalty
        attrs['direction_penalty'] = 1.0

        # Distance to land
        attrs['distance_to_land'] = 9999.0
        if not land_metric.empty:
            edge_geom_metric = gpd.GeoSeries([edge_geom], crs=CRS_WGS84).to_crs(CRS_METRIC).iloc[0]
            possible_matches = land_metric.sindex.nearest(edge_geom_metric)
            if len(possible_matches[1]) > 0:
                closest_idx = possible_matches[1][0]
                closest_geom = land_metric.iloc[closest_idx].geometry
                attrs['distance_to_land'] = round(edge_geom_metric.distance(closest_geom), 2)

        results[(u, v)] = attrs
    return results

class NauticalRoutingPipeline:
    def __init__(self, data_paths: Dict[str, str], db_path: str):
        """
        Initializes the pipeline for generating a nautical routing graph.
        
        :param data_paths: Dictionary mapping layer names to file paths (e.g., shapefiles/GeoJSONs).
        :param db_path: Path to the output SQLite database.
        """
        self.data_paths = data_paths
        self.db_path = db_path
        
        # Geodetic calculator for accurate WGS84 distance measurements (meters)
        self.geod = Geod(ellps="WGS84")
        
        # CRS Constants
        self.CRS_WGS84 = "EPSG:4326"
        self.CRS_METRIC = "EPSG:3857" # Web Mercator for fast 2D metric math
        
        self.gdfs = {}
        self.graph = nx.DiGraph()
        
    def run_pipeline(self):
        """Executes the end-to-end data pipeline."""
        self.parse_shapefiles()
        self.build_network()
        self._validate_edges_against_land()
        self._add_opening_bridge_edges()
        self.calculate_edge_attributes()
        # Override air draft for edges created through opening bridges
        for u, v, data in self.graph.edges(data=True):
            if data.get('is_opening_bridge_edge'):
                data['max_air_draft'] = 999.0
        self._compute_node_depths()
        self.export_to_sqlite()
        logger.info("Pipeline execution completed successfully.")

    def parse_shapefiles(self):
        """Loads vector map data into GeoDataFrames and standardizes their CRS."""
        logger.info("Parsing shapefiles and GeoJSONs...")
        for layer_name, path in self.data_paths.items():
            if os.path.exists(path):
                gdf = gpd.read_file(path)
                # Ensure everything is in standard WGS84 coordinates initially
                if gdf.crs != self.CRS_WGS84:
                    gdf = gdf.to_crs(self.CRS_WGS84)
                self.gdfs[layer_name] = gdf
                logger.info(f"Loaded '{layer_name}' with {len(gdf)} features.")
            else:
                logger.warning(f"File not found for '{layer_name}': {path}. Using empty fallback.")
                # Create empty fallback GDF with standard geometry if missing
                self.gdfs[layer_name] = gpd.GeoDataFrame(geometry=[], crs=self.CRS_WGS84)

        # Pre-calculate projected (metric) GeodataFrames for fast distance math (like distance_to_land)
        self.gdfs_metric = {
            name: gdf.to_crs(self.CRS_METRIC) for name, gdf in self.gdfs.items()
        }

    def build_network(self):
        """
        Generates the Directed Graph base topology.
        Combines Inland waterway centerlines and Coastal Navigation Meshes.
        """
        logger.info("Building base network topology...")
        self.node_id_counter = 1
        self.coords_to_node = {} # Mapping (lon, lat) -> node_id to prevent duplicates

        # 1. Generate Inland Waterway Network (from centerlines)
        if 'inland_waterways' in self.gdfs and not self.gdfs['inland_waterways'].empty:
            self._build_inland_network()

        # 2. Generate Coastal NavMesh (Grid-based fallback over open water polygons)
        if 'coastal_water' in self.gdfs and not self.gdfs['coastal_water'].empty:
            self._build_coastal_navmesh()

        logger.info(f"Network built with {self.graph.number_of_nodes()} nodes and {self.graph.number_of_edges()} edges.")

    def _get_or_create_node(self, lon: float, lat: float, node_type: str = 'coastal') -> int:
        """Helper to create nodes and avoid duplicates by snapping to 5 decimal places (~1 meter)."""
        coord = (round(lon, 5), round(lat, 5))
        if coord not in self.coords_to_node:
            node_id = self.node_id_counter
            self.graph.add_node(node_id, lon=coord[0], lat=coord[1], node_type=node_type)
            self.coords_to_node[coord] = node_id
            self.node_id_counter += 1
        elif node_type == 'inland':
            self.graph.nodes[self.coords_to_node[coord]]['node_type'] = 'inland'
        return self.coords_to_node[coord]

    def _build_inland_network(self):
        """Extracts nodes and edges from inland waterway LineStrings."""
        inland_gdf = self.gdfs['inland_waterways']
        total_features = len(inland_gdf)
        logger.info(f"  Processing {total_features} inland waterway features...")
        
        for fi, (_, row) in enumerate(inland_gdf.iterrows()):
            if (fi + 1) % max(1, total_features // 20) == 0:
                pct = (fi + 1) / total_features * 100
                logger.info(f"  Inland waterways: {fi + 1}/{total_features} ({pct:.0f}%), {self.graph.number_of_nodes()} nodes so far")
            geom = row.geometry
            if isinstance(geom, LineString):
                coords = list(geom.coords)
                for i in range(len(coords) - 1):
                    u_lon, u_lat = coords[i]
                    v_lon, v_lat = coords[i+1]
                    
                    u = self._get_or_create_node(u_lon, u_lat, node_type='inland')
                    v = self._get_or_create_node(v_lon, v_lat, node_type='inland')
                    
                    # Add parallel directional edges to support separated channels
                    # Traffic rules/penalties will be assigned in the attributes step
                    self.graph.add_edge(u, v, edge_type='inland')
                    self.graph.add_edge(v, u, edge_type='inland')

    def _build_coastal_navmesh(self):
        """Generates an adaptive-resolution coastal navmesh using grid scanning.
        
        Resolution varies from 0.005° (~500m) open sea to 0.001° (~100m)
        in narrow channels. Refinement is skipped in cells that contain 
        centreline features. Uses O(N) grid-based (two-level dict) 
        connectivity instead of octant nearest-neighbor search.
        """
        coastal_gdf = self.gdfs['coastal_water']
        if coastal_gdf.empty:
            logger.warning("No coastal water data. Skipping navmesh.")
            return
        
        # Repair geometries for spatial index lookups
        coastal_gdf = coastal_gdf.copy()
        coastal_gdf['geometry'] = coastal_gdf['geometry'].make_valid()
        coastal_gdf = coastal_gdf[coastal_gdf.geometry.notnull()]

        land_gdf = self.gdfs.get('land', gpd.GeoDataFrame())
        if not land_gdf.empty:
            land_gdf = land_gdf.copy()
            land_gdf['geometry'] = land_gdf['geometry'].make_valid()
            land_gdf = land_gdf[land_gdf.geometry.notnull()]

        inland_ww = self.gdfs.get('inland_waterways')

        bounds = coastal_gdf.total_bounds
        MAX_RES = 0.005      # coarsest (open sea, ~500m)
        MIN_RES = 0.001      # finest (narrow channels, ~100m) — keeps node count ~50k
        SEARCH_MARGIN = 0.01 # degrees for narrowness cache

        # --- Fast narrowness (distance to nearest land in degrees) ---
        narrowness_cache = {}
        def _narrowness(lon, lat):
            key = (round(lon, 5), round(lat, 5))
            if key in narrowness_cache:
                return narrowness_cache[key]
            if land_gdf.empty:
                val = 10.0
            else:
                pt = Point(lon, lat)
                candidates = list(land_gdf.sindex.intersection(
                    (lon - SEARCH_MARGIN, lat - SEARCH_MARGIN,
                     lon + SEARCH_MARGIN, lat + SEARCH_MARGIN)
                ))
                if not candidates:
                    val = 10.0
                else:
                    min_d = float('inf')
                    for idx in candidates:
                        d = pt.distance(land_gdf.iloc[idx].geometry)
                        if d < min_d:
                            min_d = d
                    val = min_d if min_d < 10.0 else 10.0
            narrowness_cache[key] = val
            return val

        # --- Fast centerline existence check ---
        def _has_centerline(bbox):
            if inland_ww is None or inland_ww.empty:
                return False
            return len(list(inland_ww.sindex.intersection(bbox))) > 0

        # ==============================================================
        # STEP 1: Coarse scan (multiprocessing with fork-based sharing)
        # ==============================================================
        logger.info("Scanning coarse grid (multiprocessing)...")

        x_coarse = np.arange(bounds[0], bounds[2], MAX_RES)
        y_coarse = np.arange(bounds[1], bounds[3], MAX_RES)
        if len(x_coarse) == 0 or len(y_coarse) == 0:
            logger.warning("No valid bounds for coastal navmesh.")
            return

        # Trigger lazy R-tree build before forking (COW share)
        _ = coastal_gdf.sindex

        num_workers = max(1, min(int(mp.cpu_count() * 0.8), len(x_coarse)))
        cols_per_worker = max(1, len(x_coarse) // num_workers)

        with mp.Pool(num_workers, initializer=_coarse_scan_init,
                     initargs=(coastal_gdf,)) as pool:
            tasks = []
            for w in range(num_workers):
                start = w * cols_per_worker
                end = start + cols_per_worker if w < num_workers - 1 else len(x_coarse)
                cols = x_coarse[start:end]
                tasks.append(pool.apply_async(_coarse_scan_worker,
                                              (cols, y_coarse)))
            coarse_positions = []
            for t in tasks:
                coarse_positions.extend(t.get())

        logger.info(f"Coarse scan: {len(coarse_positions)} water nodes at {MAX_RES}°")

        # ==============================================================
        # STEP 2: Refinement planning (narrowness + centreline handling)
        # ==============================================================
        logger.info("Planning refinement (narrowness)...")
        refinement_cells = []          # (x, y, local_res) for grid refinement
        centreline_positions = []      # (lon, lat) — coastal nodes on centreline
        seen_centreline_coords = set()  # dedup

        for idx, (x, y) in enumerate(coarse_positions):
            if (idx + 1) % 5000 == 0:
                logger.info(f"  Refinement planning: {idx + 1}/{len(coarse_positions)}")

            n = _narrowness(x, y)
            n_m = n * 111320

            if n_m < 200:
                local_res = MIN_RES          # 0.001° (~100m)
            elif n_m < 500:
                local_res = 0.002            # ~200m
            elif n_m < 2000:
                local_res = 0.003            # ~300m
            elif n_m < 5000:
                local_res = 0.004            # ~400m
            else:
                continue

            cell_bbox = (x - MAX_RES / 2, y - MAX_RES / 2,
                         x + MAX_RES / 2, y + MAX_RES / 2)
            if _has_centerline(cell_bbox):
                # Plant a coastal node at each centreline vertex in this cell
                # so even very narrow channels have a coastal connection point.
                cl_candidates = list(inland_ww.sindex.intersection(cell_bbox))
                for cl_idx in cl_candidates:
                    cl_geom = inland_ww.iloc[cl_idx].geometry
                    if not isinstance(cl_geom, LineString):
                        continue
                    for clon, clat in cl_geom.coords:
                        if (cell_bbox[0] - 1e-8 <= clon <= cell_bbox[2] + 1e-8
                                and cell_bbox[1] - 1e-8 <= clat <= cell_bbox[3] + 1e-8):
                            key = (round(clon, 5), round(clat, 5))
                            if key not in seen_centreline_coords:
                                seen_centreline_coords.add(key)
                                centreline_positions.append((clon, clat))
                continue  # skip grid refinement; centreline provides navigation

            refinement_cells.append((x, y, local_res))

        logger.info(f"Refinement planning: {len(refinement_cells)} cells need refinement, "
                    f"{len(centreline_positions)} centreline-anchored coastal positions")

        # ==============================================================
        # STEP 3: Batch spatial join for fine-grid candidate points
        # ==============================================================
        logger.info("Generating fine-grid candidate points...")
        fine_candidates = []
        for x, y, local_res in refinement_cells:
            half = MAX_RES / 2
            offsets = np.arange(-half + local_res / 2, half, local_res)
            for ox in offsets:
                for oy in offsets:
                    if abs(ox) < 1e-8 and abs(oy) < 1e-8:
                        continue
                    fine_candidates.append({'lon': x + ox, 'lat': y + oy,
                                            'res': local_res})

        logger.info(f"Generated {len(fine_candidates)} candidate points")

        refined_positions = []
        if fine_candidates:
            candidates_df = pd.DataFrame(fine_candidates)
            candidates_gdf = gpd.GeoDataFrame(
                candidates_df,
                geometry=gpd.points_from_xy(candidates_df['lon'],
                                             candidates_df['lat']),
                crs="EPSG:4326"
            )
            water_for_join = coastal_gdf[['geometry']].copy()
            water_for_join['water_idx'] = range(len(water_for_join))

            joined = gpd.sjoin(candidates_gdf, water_for_join,
                               predicate='within', how='inner')
            joined = joined.drop_duplicates(subset=['lon', 'lat'])

            refined_positions = list(zip(
                joined['lon'].values, joined['lat'].values, joined['res'].values
            ))

        logger.info(f"Batch spatial join: {len(refined_positions)} water "
                    f"points out of {len(fine_candidates)} candidates")

        # ==============================================================
        # STEP 4: Create graph nodes (grid + centreline-anchored)
        # ==============================================================
        logger.info("Creating graph nodes...")
        for cx, cy in coarse_positions:
            nid = self._get_or_create_node(cx, cy)
            self.graph.nodes[nid]['resolution'] = MAX_RES
            self.graph.nodes[nid]['node_type'] = 'coastal'

        for cx, cy, res in refined_positions:
            nid = self._get_or_create_node(cx, cy)
            self.graph.nodes[nid]['resolution'] = res
            self.graph.nodes[nid]['node_type'] = 'coastal'

        # Centreline-anchored coastal nodes (fallback for narrow channels)
        for clon, clat in centreline_positions:
            nid = self._get_or_create_node(clon, clat)
            # Don't overwrite if this coordinate already hosts an 'inland' node
            if self.graph.nodes[nid].get('node_type') != 'coastal':
                self.graph.nodes[nid]['resolution'] = MAX_RES
                self.graph.nodes[nid]['node_type'] = 'coastal'

        coastal_node_data = [
            (nid, data['lon'], data['lat'], data.get('resolution', MAX_RES))
            for nid, data in self.graph.nodes(data=True)
            if data.get('node_type') == 'coastal'
        ]
        logger.info(f"Created {len(coastal_node_data)} coastal navmesh nodes")

        # ==============================================================
        # STEP 5: O(N) grid-based connectivity (two-level dict)
        # ==============================================================
        logger.info("Building O(N) grid connectivity...")

        coarse_pos = {}  # (col, row) at MAX_RES → node_id
        fine_pos = {}    # (col, row) at MIN_RES → node_id

        for nid, lon, lat, res in coastal_node_data:
            fc = round(lon / MIN_RES)
            fr = round(lat / MIN_RES)
            fine_pos[(fc, fr)] = nid

            if res >= MAX_RES * 0.9:
                cc = round(lon / MAX_RES)
                cr = round(lat / MAX_RES)
                coarse_pos[(cc, cr)] = nid

        total_new_edges = 0

        # 5a. Coarse-to-coarse (8-way adjacency at MAX_RES)
        cc_edge_count = 0
        for (cc, cr), nid in coarse_pos.items():
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if dr == 0 and dc == 0:
                        continue
                    neighbor = coarse_pos.get((cc + dc, cr + dr))
                    if neighbor and neighbor > nid:
                        self.graph.add_edge(nid, neighbor, edge_type='coastal')
                        self.graph.add_edge(neighbor, nid, edge_type='coastal')
                        cc_edge_count += 2
        total_new_edges += cc_edge_count
        logger.info(f"  Coarse-to-coarse: {cc_edge_count} edges")

        # 5b. Fine-to-fine (8-way adjacency at MIN_RES)
        ff_edge_count = 0
        for (fc, fr), nid in fine_pos.items():
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if dr == 0 and dc == 0:
                        continue
                    neighbor = fine_pos.get((fc + dc, fr + dr))
                    if neighbor and neighbor > nid:
                        if not self.graph.has_edge(nid, neighbor):
                            self.graph.add_edge(nid, neighbor,
                                                edge_type='coastal')
                            self.graph.add_edge(neighbor, nid,
                                                edge_type='coastal')
                            ff_edge_count += 2
        total_new_edges += ff_edge_count
        logger.info(f"  Fine-to-fine: {ff_edge_count} edges")

        # 5c. Cross-resolution: fine → nearest coarse in 3×3 MAX_RES block
        coarse_node_ids = set(coarse_pos.values())  # O(1) lookup set
        cr_edge_count = 0
        for (fc, fr), nid in fine_pos.items():
            if nid in coarse_node_ids:
                continue  # already connected via coarse-coarse

            parent_cc = int(fc * MIN_RES / MAX_RES)
            parent_cr = int(fr * MIN_RES / MAX_RES)
            lon = self.graph.nodes[nid]['lon']
            lat = self.graph.nodes[nid]['lat']

            best_cnid = None
            best_dist = float('inf')
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    cnid = coarse_pos.get((parent_cc + dc, parent_cr + dr))
                    if cnid:
                        clon = self.graph.nodes[cnid]['lon']
                        clat = self.graph.nodes[cnid]['lat']
                        dx = (clon - lon) * 111320 * math.cos(
                            math.radians((lat + clat) / 2))
                        dy = (clat - lat) * 111320
                        d = math.sqrt(dx * dx + dy * dy)
                        if d < best_dist:
                            best_dist = d
                            best_cnid = cnid

            if best_cnid and not self.graph.has_edge(nid, best_cnid):
                self.graph.add_edge(nid, best_cnid, edge_type='coastal')
                self.graph.add_edge(best_cnid, nid, edge_type='coastal')
                cr_edge_count += 2
        total_new_edges += cr_edge_count
        logger.info(f"  Cross-resolution: {cr_edge_count} edges")

        # 5d. Inland-to-coastal via grid-based nearest-neighbour lookup
        # Use a search radius that covers at least one full coarse cell:
        # MAX_RES / MIN_RES = 5 cells → radius of 3 covers a 7×7 block (0.007°)
        inland_search_radius = max(2, round(MAX_RES / MIN_RES / 2))
        inland_nodes = [
            (nid, data['lon'], data['lat'])
            for nid, data in self.graph.nodes(data=True)
            if data.get('node_type') == 'inland'
        ]

        ic_edge_count = 0
        for nid, lon, lat in inland_nodes:
            fc = round(lon / MIN_RES)
            fr = round(lat / MIN_RES)
            best_cnid = None
            best_dist = float('inf')
            for dr in range(-inland_search_radius, inland_search_radius + 1):
                for dc in range(-inland_search_radius, inland_search_radius + 1):
                    # fine_pos keyed (col, row) = (fc, fr)
                    neighbor = fine_pos.get((fc + dc, fr + dr))
                    if neighbor is None:
                        continue
                    if self.graph.nodes[neighbor].get('node_type') != 'coastal':
                        continue
                    clon = self.graph.nodes[neighbor]['lon']
                    clat = self.graph.nodes[neighbor]['lat']
                    dx = (clon - lon) * 111320 * math.cos(
                        math.radians((lat + clat) / 2))
                    dy = (clat - lat) * 111320
                    d = math.sqrt(dx * dx + dy * dy)
                    if d < best_dist:
                        best_dist = d
                        best_cnid = neighbor
            if best_cnid and best_dist < 2000 and not self.graph.has_edge(nid, best_cnid):
                self.graph.add_edge(nid, best_cnid, edge_type='coastal')
                self.graph.add_edge(best_cnid, nid, edge_type='coastal')
                ic_edge_count += 2
        total_new_edges += ic_edge_count
        logger.info(f"  Inland-to-coastal: {ic_edge_count} edges")

        logger.info(f"Coastal navmesh complete: {self.graph.number_of_nodes()} nodes, "
                    f"{self.graph.number_of_edges()} edges ({total_new_edges} new)")

    def _validate_edges_against_land(self):
        """
        Remove coastal graph edges that cross land polygons.

        For each undirected coastal edge, validates:
        1. The midpoint lies within a coastal water polygon (batch spatial join)
        2. The edge segment does not cross any land polygon (R-tree filter + crosses test)

        This mirrors rx.autoroute's createSuperMesh() two-part validation:
        doesIntersect() + isPointInArea(midpoint).
        Only edges that pass BOTH checks are kept in the graph.
        """
        land_gdf = self.gdfs.get('land', gpd.GeoDataFrame())
        coastal_gdf = self.gdfs.get('coastal_water', gpd.GeoDataFrame())

        if coastal_gdf.empty:
            logger.info("No coastal water data — skipping land-crossing validation")
            return

        logger.info("Validating coastal edges against land polygons...")

        # Collect unique (undirected) coastal edges with their endpoint coords
        edge_endpoints = {}
        for u, v, data in self.graph.edges(data=True):
            if data.get('edge_type') != 'coastal':
                continue
            a, b = (u, v) if u < v else (v, u)
            if (a, b) not in edge_endpoints:
                edge_endpoints[(a, b)] = (
                    self.graph.nodes[u]['lon'],
                    self.graph.nodes[u]['lat'],
                    self.graph.nodes[v]['lon'],
                    self.graph.nodes[v]['lat'],
                )

        if not edge_endpoints:
            return

        logger.info(f"  Checking {len(edge_endpoints)} unique coastal edges")

        # Ensure R-trees are built before any spatial ops
        _ = coastal_gdf.sindex
        if not land_gdf.empty:
            _ = land_gdf.sindex

        edges_to_remove = set()

        # ---- Step 1: Midpoint water check (batch spatial join) ----
        edge_list = list(edge_endpoints.items())
        mp_data = []
        for (a, b), (u_lon, u_lat, v_lon, v_lat) in edge_list:
            mp_data.append({
                'edge_key': (a, b),
                'geometry': Point((u_lon + v_lon) * 0.5, (u_lat + v_lat) * 0.5),
            })

        mp_gdf = gpd.GeoDataFrame(mp_data, geometry='geometry', crs=self.CRS_WGS84)
        water_for_join = coastal_gdf[['geometry']].copy()
        # 'within' predicate: midpoint must be strictly inside water polygon
        water_join = gpd.sjoin(mp_gdf, water_for_join, predicate='within', how='inner')
        valid_midpoints = set(water_join['edge_key'].values)

        for key in edge_endpoints:
            if key not in valid_midpoints:
                edges_to_remove.add(key)

        logger.info(f"  Midpoint water check: {len(valid_midpoints)}/{len(edge_endpoints)} pass")

        # ---- Step 2: Land-crossing check for remaining edges ----
        if not land_gdf.empty:
            land_check_count = 0
            land_remove_count = 0
            for (a, b), (u_lon, u_lat, v_lon, v_lat) in edge_endpoints.items():
                if (a, b) in edges_to_remove:
                    continue
                land_check_count += 1

                line = LineString([(u_lon, u_lat), (v_lon, v_lat)])
                # R-tree filter: only test land polygons whose bbox overlaps the edge
                candidates = list(land_gdf.sindex.intersection(line.bounds))
                for idx in candidates:
                    land_geom = land_gdf.iloc[idx].geometry
                    # crosses = interior intersection (endpoint touches on boundary are OK)
                    if line.crosses(land_geom):
                        edges_to_remove.add((a, b))
                        land_remove_count += 1
                        break

            logger.info(f"  Land-crossing check: tested {land_check_count}, removed {land_remove_count}")

        # ---- Step 3: Remove invalid edges (both directions) ----
        removed_count = 0
        for a, b in edges_to_remove:
            if self.graph.has_edge(a, b):
                self.graph.remove_edge(a, b)
                removed_count += 1
            if self.graph.has_edge(b, a):
                self.graph.remove_edge(b, a)
                removed_count += 1

        # Also set a crosses_land attribute on surviving edges (=0) for DB export
        for u, v, data in self.graph.edges(data=True):
            if data.get('edge_type') == 'coastal':
                self.graph.edges[u, v]['crosses_land'] = 0

        logger.info(
            f"Land-crossing validation complete: removed {removed_count} directed edges "
            f"({len(edges_to_remove)} undirected), "
            f"{self.graph.number_of_edges()} edges remaining"
        )

    def _add_opening_bridge_edges(self):
        """
        Create coastal edges through opening/movable bridge polygons.

        For each opening bridge (CATBRG 3-7 or VERCOP present), this method:
        1. Identifies the nearest coastal node on the west and east sides
        2. Creates a new graph node at the bridge centroid
        3. Connects the bridge node to both side-nodes with max_air_draft=999

        This ensures A* can route through opening bridges even when the
        coarse grid's horizontal edges pass through fixed bridge sections.
        """
        bridges_gdf = self.gdfs.get('bridges', gpd.GeoDataFrame())
        if bridges_gdf.empty:
            logger.info("No bridge data — skipping opening bridge edge creation")
            return

        depare_gdf = self.gdfs.get('depth_areas', gpd.GeoDataFrame())
        logger.info("Adding opening bridge crossing edges...")
        added = 0

        for _, row in bridges_gdf.iterrows():
            # Check if bridge is opening/movable
            is_movable = False
            catbrg = _s57_col(row, 'catbrg', 'CATAQA', 'CatBrg')
            if catbrg is not None and pd.notnull(catbrg):
                vals = _parse_catbrg(catbrg)
                if any(v in ('3', '4', '5', '6', '7') for v in vals):
                    is_movable = True
            if not is_movable:
                vercop = _s57_col(row, 'vercop', 'VERCOP', 'VerCop')
                if vercop is not None and pd.notnull(vercop):
                    is_movable = True
            if not is_movable:
                continue

            bridge_geom = row.geometry
            centroid = bridge_geom.centroid
            bbox = bridge_geom.bounds
            minx, miny, maxx, maxy = bbox

            SEARCH_MARGIN = 0.01

            west_nodes = []
            east_nodes = []
            for nid, data in self.graph.nodes(data=True):
                if data.get('node_type') != 'coastal':
                    continue
                lon, lat = data['lon'], data['lat']
                if not (minx - SEARCH_MARGIN <= lon <= maxx + SEARCH_MARGIN and
                        miny - SEARCH_MARGIN <= lat <= maxy + SEARCH_MARGIN):
                    continue
                if lon < minx:
                    west_nodes.append((nid, lon, lat))
                elif lon > maxx:
                    east_nodes.append((nid, lon, lat))

            if not west_nodes or not east_nodes:
                continue

            # Sort by distance to bridge centroid
            c_lon, c_lat = centroid.x, centroid.y
            def _dist(lon, lat):
                dx = (lon - c_lon) * 111320 * math.cos(math.radians((lat + c_lat) / 2))
                dy = (lat - c_lat) * 111320
                return math.sqrt(dx * dx + dy * dy)

            west_nodes.sort(key=lambda x: _dist(x[1], x[2]))
            east_nodes.sort(key=lambda x: _dist(x[1], x[2]))

            wn, wl, wlt = west_nodes[0]
            en, el, elt = east_nodes[0]

            # Create bridge node at centroid
            b_id = self._get_or_create_node(c_lon, c_lat, node_type='coastal')
            self.graph.nodes[b_id]['resolution'] = 0.001
            self.graph.nodes[b_id]['node_type'] = 'coastal'

            # Compute depth at bridge node from DEPARE
            node_depth = -1
            if not depare_gdf.empty:
                pt = Point(c_lon, c_lat)
                candidates = list(depare_gdf.sindex.intersection(pt.bounds))
                for idx in candidates:
                    dr = depare_gdf.iloc[idx]
                    if dr.geometry.contains(pt):
                        if 'DRVAL1' in dr and pd.notnull(dr['DRVAL1']):
                            node_depth = float(dr['DRVAL1'])
                        else:
                            node_depth = 99.0
                        break
            self.graph.nodes[b_id]['node_depth'] = node_depth

            # Create edges with air draft override tag
            if not self.graph.has_edge(b_id, wn):
                self.graph.add_edge(b_id, wn, edge_type='coastal', crosses_land=0, is_opening_bridge_edge=True)
                self.graph.add_edge(wn, b_id, edge_type='coastal', crosses_land=0, is_opening_bridge_edge=True)
                added += 2
            if not self.graph.has_edge(b_id, en):
                self.graph.add_edge(b_id, en, edge_type='coastal', crosses_land=0, is_opening_bridge_edge=True)
                self.graph.add_edge(en, b_id, edge_type='coastal', crosses_land=0, is_opening_bridge_edge=True)
                added += 2

        logger.info(f"Added {added} opening bridge crossing edges")

    def _compute_node_depths(self):
        """
        Compute the depth at each node's exact point from DEPARE polygons.

        For every node in the graph, finds the DEPARE (depth area) polygon whose
        interior contains the node's point and stores its DRVAL1 (>0) as the
        node's `node_depth` attribute.  Nodes outside any DEPARE polygon (or in
        a polygon with DRVAL1 <= 0) get node_depth = -1 (unknown).

        Unlike computing depth from incident edges (which picks up the minimum
        depth along the *whole edge* — up to ~500 m long for coarse grid nodes),
        this gives the *exact* depth at the node's coordinate, which is what we
        need for colour-coded map display.
        """
        depare_gdf = self.gdfs.get('depth_areas', gpd.GeoDataFrame())
        if depare_gdf.empty:
            logger.info("No depth-area data — node_depth will be -1 for all nodes")
            for _, data in self.graph.nodes(data=True):
                data['node_depth'] = -1
            return

        logger.info("Computing node depths from DEPARE polygons...")
        _ = depare_gdf.sindex  # ensure R-tree built

        # CRITICAL FIX: Do not filter by DRVAL1 > 0. Keep all depth areas.
        positive = depare_gdf.copy()
        if positive.empty:
            logger.info("  No DEPARE polygons found — all nodes unknown")
            for _, data in self.graph.nodes(data=True):
                data['node_depth'] = -1
            return

        total = self.graph.number_of_nodes()
        found = 0
        for i, (nid, data) in enumerate(self.graph.nodes(data=True)):
            if (i + 1) % max(1, total // 20) == 0:
                logger.info(f"  Node depths: {i + 1}/{total} ({found} found so far)")

            pt = Point(data['lon'], data['lat'])
            candidates = list(positive.sindex.intersection(pt.bounds))
            if not candidates:
                data['node_depth'] = -1
                continue

            depth = -1
            for idx in candidates:
                row = positive.iloc[idx]
                if row.geometry.contains(pt):
                    # CRITICAL FIX: If DRVAL1 is NaN, assume general deep water (99.0)
                    if 'DRVAL1' in row and pd.notnull(row['DRVAL1']):
                        depth = float(row['DRVAL1'])
                    else:
                        depth = 99.0
                    found += 1
                    break
            data['node_depth'] = depth

        logger.info(f"Node depth computation complete: {found}/{total} nodes inside DEPARE polygons")

    def _candidates_by_bounds(self, gdf: gpd.GeoDataFrame, geom, margin: float = 0.0) -> gpd.GeoDataFrame:
        """Use spatial index to find candidate features intersecting the geometry's bounding box."""
        bounds = geom.bounds
        if margin:
            bounds = (bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin)
        candidates = list(gdf.sindex.intersection(bounds))
        if candidates:
            return gdf.iloc[candidates]
        return gpd.GeoDataFrame()

    def calculate_edge_attributes(self):
        """Calculates edge attributes using multiprocessing for all edges."""
        logger.info("Calculating advanced edge attributes (multiprocessing)...")

        total_edges = self.graph.number_of_edges()
        num_workers = max(1, min(int(mp.cpu_count() * 0.8), (total_edges + 999) // 1000))

        # Collect all edges into a flat list for chunking
        edge_tuples = []
        for u, v, data in self.graph.edges(data=True):
            u_node = self.graph.nodes[u]
            v_node = self.graph.nodes[v]
            edge_tuples.append((
                u, v,
                u_node['lon'], u_node['lat'],
                v_node['lon'], v_node['lat'],
                data.get('edge_type', 'coastal'),
                u_node.get('resolution', 0.005),
                v_node.get('resolution', 0.005),
            ))

        # Interleave chunks for balanced coarse-edge distribution
        chunks = [[] for _ in range(num_workers)]
        for i, et in enumerate(edge_tuples):
            chunks[i % num_workers].append(et)
        del edge_tuples  # free memory

        # Prepare GDF dict for workers (trigger lazy sindex before fork)
        worker_gdfs = {
            'land_metric': self.gdfs_metric.get('land', gpd.GeoDataFrame()),
            'depth_areas': self.gdfs.get('depth_areas', gpd.GeoDataFrame()),
            'bridges': self.gdfs.get('bridges', gpd.GeoDataFrame()),
            'fairways': self.gdfs.get('fairways', gpd.GeoDataFrame()),
            'locks': self.gdfs.get('locks', gpd.GeoDataFrame()),
        }
        for gdf in worker_gdfs.values():
            if not gdf.empty:
                _ = gdf.sindex  # build R-tree before fork

        logger.info(f"  Spawning {num_workers} workers for {total_edges} edges...")
        with mp.Pool(num_workers, initializer=_edge_attr_init,
                     initargs=(self.geod, worker_gdfs)) as pool:
            chunk_results = pool.map(_edge_attr_worker, chunks)

        # Merge results back into the graph
        merged = 0
        for results in chunk_results:
            for (u, v), attrs in results.items():
                for key, value in attrs.items():
                    self.graph.edges[u, v][key] = value
                merged += 1

        logger.info(f"  Edge attributes merged: {merged}/{total_edges}")

    def export_to_sqlite(self):
        """Exports the nodes, edges, and POIs to a highly compressed SQLite Database."""
        logger.info(f"Exporting data to SQLite database at '{self.db_path}'...")
        
        if os.path.exists(self.db_path):
            os.remove(self.db_path)
            
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            
            # Create Tables
            cursor.executescript("""
                CREATE TABLE nodes (
                    id INTEGER PRIMARY KEY,
                    lat REAL,
                    lon REAL,
                    resolution REAL DEFAULT 0.0,
                    node_type TEXT DEFAULT 'coastal',
                    node_depth REAL DEFAULT -1
                );
                
                CREATE TABLE edges (
                    source INTEGER,
                    target INTEGER,
                    distance REAL,
                    min_depth REAL,
                    max_air_draft REAL,
                    min_width REAL,
                    is_fairway INTEGER,
                    direction_penalty REAL,
                    distance_to_land REAL,
                    edge_type TEXT DEFAULT 'coastal',
                    is_one_way INTEGER DEFAULT 0,
                    traffic_dir INTEGER DEFAULT 1,
                    crosses_land INTEGER DEFAULT 0,
                    FOREIGN KEY(source) REFERENCES nodes(id),
                    FOREIGN KEY(target) REFERENCES nodes(id)
                );
                
                CREATE TABLE pois (
                    id INTEGER PRIMARY KEY,
                    name TEXT,
                    type TEXT,
                    properties TEXT,
                    lat REAL,
                    lon REAL
                );
                
                -- Create indices for fast routing queries
                CREATE INDEX idx_edges_source ON edges(source);
                CREATE INDEX idx_edges_target ON edges(target);
            """)
            
            # Insert Nodes
            nodes_data = [(n, data['lat'], data['lon'],
                           data.get('resolution', 0.0),
                           data.get('node_type', 'coastal'),
                           data.get('node_depth', -1))
                          for n, data in self.graph.nodes(data=True)]
            cursor.executemany("INSERT INTO nodes (id, lat, lon, resolution, node_type, node_depth) VALUES (?, ?, ?, ?, ?, ?)", nodes_data)
            
            # Insert Edges
            edges_data = [(
                u, v, 
                data.get('distance', 0.0), 
                data.get('min_depth', 99.0), 
                data.get('max_air_draft', 999.0),
                data.get('min_width', 999.0),
                int(data.get('is_fairway', False)),
                data.get('direction_penalty', 1.0),
                data.get('distance_to_land', 9999.0),
                data.get('edge_type', 'coastal'),
                int(data.get('is_one_way', False)),
                data.get('traffic_dir', 1),
                int(data.get('crosses_land', 0))
            ) for u, v, data in self.graph.edges(data=True)]
            cursor.executemany("""
                INSERT INTO edges 
                (source, target, distance, min_depth, max_air_draft, min_width, is_fairway, direction_penalty, distance_to_land, edge_type, is_one_way, traffic_dir, crosses_land)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, edges_data)
            
            # Insert POIs — harvest named locations from multiple layers
            def _poi_name(row) -> str:
                for col in ('OBJNAM', 'NOBJNM', 'name'):
                    val = row.get(col)
                    if val is not None and not (isinstance(val, float) and np.isnan(val)):
                        return str(val)
                return ''

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

            def _poi_properties(row, default_type) -> str:
                """Build JSON properties blob for a POI based on its type."""
                props = {}
                if default_type == 'bridge':
                    is_opening = False
                    catbrg = _s57_col(row, 'catbrg', 'CATAQA', 'CatBrg')
                    if catbrg is not None and pd.notnull(catbrg):
                        vals = _parse_catbrg(catbrg)
                        if any(v in ('3', '4', '5', '6', '7') for v in vals):
                            is_opening = True
                    # Fallback: VERCOP present means bridge opens
                    if not is_opening:
                        vercop = _s57_col(row, 'vercop', 'VERCOP', 'VerCop')
                        if vercop is not None and pd.notnull(vercop):
                            is_opening = True
                    if is_opening:
                        props['subtype'] = 'opening'
                    else:
                        props['subtype'] = 'fixed'
                        verclr = _s57_col(row, 'verclr', 'VERCLR', 'VerClr')
                        if verclr is not None and pd.notnull(verclr):
                            props['height'] = float(verclr)
                return json.dumps(props)

            poi_layers = [
                ('pois', 'harbour'),
                ('locks', 'lock'),
                ('bridges', 'bridge'),
                ('fairways', 'fairway'),
                ('inland_waterways', 'waterway'),
            ]
            poi_id_gen = iter(range(1, 10_000_000))
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
                    poi_data.append((next(poi_id_gen), name, default_type, _poi_properties(row, default_type), pt[0], pt[1]))
            if poi_data:
                cursor.executemany("INSERT INTO pois (id, name, type, properties, lat, lon) VALUES (?, ?, ?, ?, ?, ?)", poi_data)
                logger.info(f"Inserted {len(poi_data)} named POIs from {len(poi_layers)} layers")
            else:
                logger.warning("No named POIs found in any layer")
                
            conn.commit()
            
            # Vacuum the database to compress file size
            cursor.execute("VACUUM;")
        logger.info("Export completed and database vacuumed/compressed.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build routing graph SQLite database from GeoJSON layers.")
    parser.add_argument("--input-dir", default="./output_geojson",
                        help="Directory containing preprocessed GeoJSON files (default: ./output_geojson)")
    parser.add_argument("--output", default="./routing_graph.sqlite",
                        help="Output SQLite database path (default: ./routing_graph.sqlite)")
    args = parser.parse_args()

    data_sources = {
        'land': os.path.join(args.input_dir, 'land_polygons.geojson'),
        'coastal_water': os.path.join(args.input_dir, 'coastal_water_polygons.geojson'),
        'inland_waterways': os.path.join(args.input_dir, 'inland_waterways_lines.geojson'),
        'depth_areas': os.path.join(args.input_dir, 'depare_polygons.geojson'),
        'bridges': os.path.join(args.input_dir, 'bridges_polygons.geojson'),
        'locks': os.path.join(args.input_dir, 'locks_polygons.geojson'),
        'fairways': os.path.join(args.input_dir, 'fairways_polygons.geojson'),
        'pois': os.path.join(args.input_dir, 'pois_points.geojson')
    }

    pipeline = NauticalRoutingPipeline(data_paths=data_sources, db_path=args.output)
    pipeline.run_pipeline()

