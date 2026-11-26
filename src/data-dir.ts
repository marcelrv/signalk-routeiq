/**
 * The plugin's routing data directory: which files in it are routing
 * databases, how a database is switched off, and where its auxiliary files
 * live. `RoutingDatabase` knows none of this; it is handed an explicit file
 * list, and this module produces it.
 *
 * Layout of the directory:
 *   <name>.sqlite             a region database, in use
 *   <name>.sqlite.disabled    a region database the user switched off
 *   user-edits.sqlite         the graph editor's overlay (never a region)
 *   inland_waterways_lines.geojson, land_polygons.geojson   optional map data
 */

import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import {
  RoutingDatabase,
  type RegionFileEntry,
  type RoutingDatabaseOptions,
} from "routeiq-core";

/** Suffix marking an installed database the user has switched off. The file
 *  stays on disk and stays listed by the Data Manager, but nothing ever loads
 *  it into the graph. Renaming (rather than a config list) keeps the state
 *  self-evident on disk and matches the convention that predates the UI
 *  switch — data/ already carried hand-renamed *.sqlite.disabled files. */
export const DISABLED_SUFFIX = ".disabled";

/** True for `<name>.sqlite.disabled`. */
export function isDisabledFile(filename: string): boolean {
  return filename.endsWith(".sqlite" + DISABLED_SUFFIX);
}

/** The plain `<name>.sqlite` identity of a file in either state. Every
 *  coverage key, API filename, and catalog match uses this form, so toggling a
 *  database never changes how it is referred to. */
export function baseFilename(filename: string): string {
  return isDisabledFile(filename)
    ? filename.slice(0, -DISABLED_SUFFIX.length)
    : filename;
}

/** The graph editor's overlay store. */
export const USER_EDITS_FILENAME = "user-edits.sqlite";
export const WATERWAYS_FILENAME = "inland_waterways_lines.geojson";
export const LAND_POLYGONS_FILENAME = "land_polygons.geojson";

/** Whether a directory entry is a routing database, in either state;
 *  user-edits.sqlite is the overlay store, never a routing region. */
export function isRoutingDatabaseFile(filename: string): boolean {
  return (
    (filename.endsWith(".sqlite") || isDisabledFile(filename)) &&
    baseFilename(filename) !== USER_EDITS_FILENAME
  );
}

/** List the routing databases in `dir` (made absolute), each marked enabled
 *  or not. When both `x.sqlite` and `x.sqlite.disabled` exist only the active
 *  `x.sqlite` is listed, which is what routes. Directories named `*.sqlite`
 *  are skipped; symlinks to files are kept. Throws when the directory cannot
 *  be read. */
export function scanRoutingDataDir(dir: string): RegionFileEntry[] {
  const root = resolve(dir);
  let dirents: Dirent[];
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch (err: any) {
    throw new Error(
      `Cannot read routing data directory "${dir}": ${err.message}`,
    );
  }
  const names = dirents
    .filter((d) => isRoutingDatabaseFile(d.name) && !isDirectory(root, d))
    .map((d) => d.name);
  const active = new Set(names.filter((f) => !isDisabledFile(f)));
  return names
    .filter((f) => !isDisabledFile(f) || !active.has(baseFilename(f)))
    .map((f) => ({ path: join(root, f), enabled: !isDisabledFile(f) }));
}

/** A real directory, looking through symlinks. */
function isDirectory(root: string, d: Dirent): boolean {
  if (d.isDirectory()) return true;
  if (!d.isSymbolicLink()) return false;
  try {
    return statSync(join(root, d.name)).isDirectory();
  } catch {
    return false; // a dangling link is left for the open to report
  }
}

export interface DirectoryDatabaseSettings {
  /** Default `bulk` when `dynamicLoading` is false, else `dynamic`. */
  policy?: RoutingDatabaseOptions["policy"];
  dynamicLoading?: boolean;
  maxLoadedRegions?: number;
  maxLoadedRegionEdges?: number;
  readOnly?: boolean;
}

/** `RoutingDatabase` options for a routing data directory, scanned afresh at
 *  every `init` and `reloadMetadata`. */
export function directoryDatabaseOptions(
  dir: string,
  settings: DirectoryDatabaseSettings = {},
): RoutingDatabaseOptions {
  const policy =
    settings.policy ?? (settings.dynamicLoading ? "dynamic" : "bulk");
  return {
    files: () => scanRoutingDataDir(dir),
    fileSource: `routing data directory: ${dir}`,
    policy,
    maxLoadedRegions: settings.maxLoadedRegions ?? 0,
    maxLoadedRegionEdges: settings.maxLoadedRegionEdges ?? 0,
    readOnly: settings.readOnly,
    overlayPath: join(dir, USER_EDITS_FILENAME),
    waterwaysPath: join(dir, WATERWAYS_FILENAME),
    landPolygonsPath: join(dir, LAND_POLYGONS_FILENAME),
  };
}

/** A `RoutingDatabase` over a routing data directory, with the plugin's
 *  layout (disabled files, user-edits overlay, auxiliary GeoJSON). */
export function createDirectoryDatabase(
  dir: string,
  dynamicLoading: boolean = false,
  maxLoadedRegions: number = 0,
  maxLoadedRegionEdges: number = 0,
): RoutingDatabase {
  return new RoutingDatabase(
    directoryDatabaseOptions(dir, {
      dynamicLoading,
      maxLoadedRegions,
      maxLoadedRegionEdges,
    }),
  );
}
