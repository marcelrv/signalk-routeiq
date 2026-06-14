import os
import glob
import logging
import warnings
import argparse
import geopandas as gpd
import pandas as pd

# Suppress fiona warnings about missing layers in specific .000 files
warnings.filterwarnings("ignore", category=RuntimeWarning)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class ENCToGeoJSONPreprocessor:
    def __init__(self, enc_directory: str, output_directory: str):
        self.enc_directory = enc_directory
        self.output_directory = output_directory
        
        # Configure GDAL to properly build S-57 polygons from geometries
        os.environ["OGR_S57_OPTIONS"] = "RETURN_PRIMITIVES=OFF,RETURN_LINKAGES=OFF,LNAM_REFS=ON"
        
        # Mapping S-57 Object Classes to our Pipeline Files
        self.layer_mapping = {
            'LNDARE': 'land_polygons.geojson',
            'DEPARE': 'depare_polygons.geojson',
            'BRIDGE': 'bridges_polygons.geojson',
            'LOKBSN': 'locks_polygons.geojson',
            'FAIRWY': 'fairways_polygons.geojson',
            'HRBFAC': 'pois_points.geojson',
            # We will merge RECTRC, NAVLNE and WTWAXS (IENC Waterway Axis) together
            # for inland waterways centerlines
            'RECTRC': 'inland_waterways_lines.geojson',
            'NAVLNE': 'inland_waterways_lines.geojson',
            'WTWAXS': 'inland_waterways_lines.geojson',
            # S-57 layers for navigational hazards and restricted areas (no-go zones)
            'RESARE': 'restricted_areas_polygons.geojson',
            'OBSTRN': 'obstructions_points.geojson',
            'HULKES': 'hulks_polygons.geojson',
            'MARCUL': 'mariculture_polygons.geojson',
            'CTNARE': 'caution_areas_polygons.geojson'
        }

        # Dictionary to store lists of GeoDataFrames for each output file
        self.extracted_data = {filename: [] for filename in set(self.layer_mapping.values())}

    def process_all(self):
        """Finds all .000 files and extracts the necessary layers."""
        if not os.path.exists(self.output_directory):
            os.makedirs(self.output_directory)

        # Recursively find all S-57 base cell files
        enc_files = glob.glob(os.path.join(self.enc_directory, '**', '*.000'), recursive=True)
        logger.info(f"Found {len(enc_files)} ENC (.000) files. Starting extraction...")

        for i, file_path in enumerate(enc_files, 1):
            logger.info(f"Processing [{i}/{len(enc_files)}]: {os.path.basename(file_path)}")
            self._extract_layers_from_file(file_path)

        self._merge_and_export()

    def _extract_layers_from_file(self, file_path: str):
        """Extracts configured S-57 layers from a single ENC file."""
        for s57_layer, output_filename in self.layer_mapping.items():
            try:
                # Read the specific layer from the S-57 file
                gdf = gpd.read_file(file_path, layer=s57_layer)
                
                if not gdf.empty:
                    # Standardize to WGS84
                    if gdf.crs and gdf.crs != "EPSG:4326":
                        gdf = gdf.to_crs("EPSG:4326")
                        
                    self.extracted_data[output_filename].append(gdf)
            except Exception as e:
                # Fiona raises an exception if the layer doesn't exist in this specific chart
                # This is normal, as not all charts have bridges, locks, etc.
                pass

    def _merge_and_export(self):
        """Merges all extracted bits and saves them as GeoJSON."""
        logger.info("Merging extracted geometries and exporting to GeoJSON...")
        
        for output_filename, gdf_list in self.extracted_data.items():
            output_path = os.path.join(self.output_directory, output_filename)
            
            if not gdf_list:
                logger.warning(f"No data found for {output_filename}. Skipping.")
                continue
                
            # Merge all individual chart pieces into one massive GeoDataFrame
            merged_gdf = pd.concat(gdf_list, ignore_index=True)
            
            # Clean up: Drop completely empty/null geometries
            merged_gdf = merged_gdf[merged_gdf.geometry.notnull()]
            
            # Note for coastal_water: We copy DEPARE (Depth Areas) to act as coastal_water_polygons 
            # so the routing script can generate a navmesh over navigable water.
            if output_filename == 'depare_polygons.geojson':
                coastal_gdfs = [merged_gdf]
                locks_key = 'locks_polygons.geojson'
                if locks_key in self.extracted_data and self.extracted_data[locks_key]:
                    coastal_gdfs.append(pd.concat(self.extracted_data[locks_key], ignore_index=True))
                    logger.info(f"Merged {len(self.extracted_data[locks_key])} LOKBSN lock basin groups into coastal water")
                coastal_merged = pd.concat(coastal_gdfs, ignore_index=True)
                coastal_merged = coastal_merged[coastal_merged.geometry.notnull()]
                coastal_path = os.path.join(self.output_directory, 'coastal_water_polygons.geojson')
                coastal_merged.to_file(coastal_path, driver='GeoJSON')
                logger.info(f"Saved {coastal_path} (DEPARE + LOKBSN)")

            # Save the file
            try:
                merged_gdf.to_file(output_path, driver='GeoJSON')
                logger.info(f"Saved {output_path} with {len(merged_gdf)} features.")
            except Exception as e:
                logger.error(f"Failed to save {output_filename}: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract S-57 ENC layers into GeoJSON files.")
    parser.add_argument("--input", default="./data",
                        help="Root directory containing ENC .000 files in subdirectories (default: ./data)")
    parser.add_argument("--output", default="./output_geojson",
                        help="Output directory for extracted GeoJSON files (default: ./output_geojson)")
    args = parser.parse_args()

    preprocessor = ENCToGeoJSONPreprocessor(
        enc_directory=args.input,
        output_directory=args.output
    )

    preprocessor.process_all()
    logger.info("Preprocessing complete. You can now run the routing pipeline.")

