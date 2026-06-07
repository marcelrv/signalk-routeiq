import os
import sqlite3
import logging
import argparse
from typing import Dict, Any, List

import numpy as np
import pandas as pd
import geopandas as gpd
import networkx as nx
from shapely.geometry import Point, LineString, Polygon
from pyproj import Geod

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

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
        self.calculate_edge_attributes()
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

    def _get_or_create_node(self, lon: float, lat: float) -> int:
        """Helper to create nodes and avoid duplicates by snapping to 5 decimal places (~1 meter)."""
        coord = (round(lon, 5), round(lat, 5))
        if coord not in self.coords_to_node:
            node_id = self.node_id_counter
            self.graph.add_node(node_id, lon=coord[0], lat=coord[1])
            self.coords_to_node[coord] = node_id
            self.node_id_counter += 1
        return self.coords_to_node[coord]

    def _build_inland_network(self):
        """Extracts nodes and edges from inland waterway LineStrings."""
        inland_gdf = self.gdfs['inland_waterways']
        
        for _, row in inland_gdf.iterrows():
            geom = row.geometry
            if isinstance(geom, LineString):
                coords = list(geom.coords)
                for i in range(len(coords) - 1):
                    u_lon, u_lat = coords[i]
                    v_lon, v_lat = coords[i+1]
                    
                    u = self._get_or_create_node(u_lon, u_lat)
                    v = self._get_or_create_node(v_lon, v_lat)
                    
                    # Add parallel directional edges to support separated channels
                    # Traffic rules/penalties will be assigned in the attributes step
                    self.graph.add_edge(u, v, edge_type='inland')
                    self.graph.add_edge(v, u, edge_type='inland')

    def _build_coastal_navmesh(self):
        """Generates a grid across open water polygons."""
        coastal_gdf = self.gdfs['coastal_water']
        bounds = coastal_gdf.total_bounds # [minx, miny, maxx, maxy]
        
        # Grid resolution (e.g., 0.01 degrees ~ 1km depending on latitude)
        grid_res = 0.01 
        x_coords = np.arange(bounds[0], bounds[2], grid_res)
        y_coords = np.arange(bounds[1], bounds[3], grid_res)
        
        # Filter grid points to ensure they are inside coastal water polygons (and not on land)
        # Repair any invalid geometries that would cause GEOS topology exceptions
        coastal_gdf = coastal_gdf.copy()
        coastal_gdf['geometry'] = coastal_gdf['geometry'].make_valid()
        coastal_gdf = coastal_gdf[coastal_gdf.geometry.notnull()]
        water_union = coastal_gdf.union_all()
        
        total_cells = len(x_coords) * len(y_coords)
        logger.info(f"Scanning {total_cells} grid cells over coastal water...")
        grid_nodes = []
        for xi, x in enumerate(x_coords):
            for yi, y in enumerate(y_coords):
                pt = Point(x, y)
                if pt.within(water_union):
                    node_id = self._get_or_create_node(x, y)
                    grid_nodes.append((node_id, x, y))
            if (xi + 1) % 10 == 0:
                pct = (xi + 1) / len(x_coords) * 100
                logger.info(f"  Grid progress: {xi + 1}/{len(x_coords)} columns ({pct:.0f}%), {len(grid_nodes)} water nodes found")
        logger.info(f"Found {len(grid_nodes)} water nodes in grid")
                    
        # Connect adjacent nodes (8-way connectivity) to form the NavMesh
        logger.info(f"Connecting {len(grid_nodes)} grid nodes with 8-way adjacency...")
        for i, (node_id, x, y) in enumerate(grid_nodes):
            if (i + 1) % 500 == 0:
                logger.info(f"  Edge connection progress: {i + 1}/{len(grid_nodes)} nodes connected")
            # Find neighbors in the bounding box around the point
            neighbors = [
                self.coords_to_node.get((round(nx, 5), round(ny, 5))) 
                for nx in [x-grid_res, x, x+grid_res] 
                for ny in [y-grid_res, y, y+grid_res]
            ]
            for neighbor_id in filter(None, neighbors):
                if node_id != neighbor_id:
                    self.graph.add_edge(node_id, neighbor_id, edge_type='coastal')

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
        """Calculates distance, depths, clearances, and penalties for all directed edges."""
        logger.info("Calculating advanced edge attributes...")
        
        land_metric = self.gdfs_metric.get('land', gpd.GeoDataFrame())
        depare_gdf = self.gdfs.get('depth_areas', gpd.GeoDataFrame())
        bridges_gdf = self.gdfs.get('bridges', gpd.GeoDataFrame())
        fairways_gdf = self.gdfs.get('fairways', gpd.GeoDataFrame())
        locks_gdf = self.gdfs.get('locks', gpd.GeoDataFrame())

        total_edges = self.graph.number_of_edges()
        for ei, (u, v, data) in enumerate(self.graph.edges(data=True)):
            if (ei + 1) % 5000 == 0:
                logger.info(f"  Edge attributes: {ei + 1}/{total_edges} processed")
            u_node = self.graph.nodes[u]
            v_node = self.graph.nodes[v]
            
            # Create Edge Geometry
            edge_geom = LineString([(u_node['lon'], u_node['lat']), (v_node['lon'], v_node['lat'])])
            
            # 1. Distance (meters via WGS84 Geodetic Math)
            _, _, distance = self.geod.inv(u_node['lon'], u_node['lat'], v_node['lon'], v_node['lat'])
            data['distance'] = round(distance, 2)
            
            # 2. Min Depth (DEPARE overlap) — use spatial index for speed
            data['min_depth'] = 99.0
            if not depare_gdf.empty:
                depare_candidates = self._candidates_by_bounds(depare_gdf, edge_geom)
                if not depare_candidates.empty:
                    intersecting = depare_candidates[depare_candidates.intersects(edge_geom)]
                    if not intersecting.empty and 'DRVAL1' in intersecting.columns:
                        data['min_depth'] = float(intersecting['DRVAL1'].min())
            
            # 3. Max Air Draft (Bridges)
            data['max_air_draft'] = 999.0
            if not bridges_gdf.empty:
                bridge_candidates = self._candidates_by_bounds(bridges_gdf, edge_geom)
                if not bridge_candidates.empty:
                    intersecting = bridge_candidates[bridge_candidates.intersects(edge_geom)]
                    if not intersecting.empty and 'VERCLR' in intersecting.columns:
                        data['max_air_draft'] = float(intersecting['VERCLR'].min())
                    
            # 4. Min Width (Locks)
            data['min_width'] = 999.0
            if not locks_gdf.empty:
                lock_candidates = self._candidates_by_bounds(locks_gdf, edge_geom)
                if not lock_candidates.empty:
                    intersecting = lock_candidates[lock_candidates.intersects(edge_geom)]
                    if not intersecting.empty and 'HORCLR' in intersecting.columns:
                        data['min_width'] = float(intersecting['HORCLR'].min())
                    
            # 5. Fairway Status — use spatial index
            data['is_fairway'] = False
            if not fairways_gdf.empty:
                fw_candidates = self._candidates_by_bounds(fairways_gdf, edge_geom)
                if not fw_candidates.empty:
                    data['is_fairway'] = fw_candidates.intersects(edge_geom).any()

            # 6. Direction Penalty (Asymmetric Traffic Modeling)
            data['direction_penalty'] = 1.0
            if data['is_fairway'] and data.get('edge_type') == 'inland':
                if u > v:
                    data['direction_penalty'] = 5.0
            
            # 7. Distance to Land
            data['distance_to_land'] = 9999.0
            if not land_metric.empty:
                edge_geom_metric = gpd.GeoSeries([edge_geom], crs=self.CRS_WGS84).to_crs(self.CRS_METRIC).iloc[0]
                possible_matches = land_metric.sindex.nearest(edge_geom_metric)
                if len(possible_matches[1]) > 0:
                    closest_idx = possible_matches[1][0]
                    closest_geom = land_metric.iloc[closest_idx].geometry
                    data['distance_to_land'] = round(edge_geom_metric.distance(closest_geom), 2)

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
                    lon REAL
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
                    FOREIGN KEY(source) REFERENCES nodes(id),
                    FOREIGN KEY(target) REFERENCES nodes(id)
                );
                
                CREATE TABLE pois (
                    id INTEGER PRIMARY KEY,
                    name TEXT,
                    type TEXT,
                    lat REAL,
                    lon REAL
                );
                
                -- Create indices for fast routing queries
                CREATE INDEX idx_edges_source ON edges(source);
                CREATE INDEX idx_edges_target ON edges(target);
            """)
            
            # Insert Nodes
            nodes_data = [(n, data['lat'], data['lon']) for n, data in self.graph.nodes(data=True)]
            cursor.executemany("INSERT INTO nodes (id, lat, lon) VALUES (?, ?, ?)", nodes_data)
            
            # Insert Edges
            edges_data = [(
                u, v, 
                data.get('distance', 0.0), 
                data.get('min_depth', 99.0), 
                data.get('max_air_draft', 999.0),
                data.get('min_width', 999.0),
                int(data.get('is_fairway', False)),
                data.get('direction_penalty', 1.0),
                data.get('distance_to_land', 9999.0)
            ) for u, v, data in self.graph.edges(data=True)]
            cursor.executemany("""
                INSERT INTO edges 
                (source, target, distance, min_depth, max_air_draft, min_width, is_fairway, direction_penalty, distance_to_land)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, edges_data)
            
            # Insert POIs (Ports, Marinas, Anchorages)
            poi_gdf = self.gdfs.get('pois', gpd.GeoDataFrame())
            if not poi_gdf.empty:
                poi_data = []
                for idx, row in poi_gdf.iterrows():
                    geom = row.geometry
                    # Assumes point geometry
                    if isinstance(geom, Point):
                        poi_data.append((
                            idx, 
                            row.get('name', 'Unknown'), 
                            row.get('type', 'General'), 
                            geom.y, 
                            geom.x
                        ))
                cursor.executemany("INSERT INTO pois (id, name, type, lat, lon) VALUES (?, ?, ?, ?, ?)", poi_data)
                
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

