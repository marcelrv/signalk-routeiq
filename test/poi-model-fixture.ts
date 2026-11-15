/**
 * Test-fixture support for the routing database's POI model (spec §1.2 schema
 * version 4, §2.10 wholes and parts, §2.14 edge_pois).
 *
 * A fixture builds its own tables (the columns each test cares about); this
 * finishes it as a file of the current format: `schema_version` 4 and
 * `format_generation` 0 on the metadata row, `pois` with `parent_id` and
 * `info`, and an `edge_pois` table. routeiq reads no other format, so a
 * fixture that skips this is refused at open.
 */
import type { DatabaseSync } from 'node:sqlite';

export const POIS_DDL = `CREATE TABLE pois (
  id INTEGER PRIMARY KEY, type_id INTEGER NOT NULL, parent_id INTEGER,
  name TEXT, properties TEXT, info TEXT, lat REAL, lon REAL, region_id INTEGER DEFAULT 1
)`;
export const EDGE_POIS_DDL = `CREATE TABLE IF NOT EXISTS edge_pois (
  source INTEGER NOT NULL, target INTEGER NOT NULL, poi_id INTEGER NOT NULL,
  PRIMARY KEY (source, target, poi_id)
)`;

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(c => c.name);
}

/**
 * Finish a fixture as a current-format file. Idempotent. Rows in an existing
 * `pois` table keep their values; a table built without the model's columns
 * gets `parent_id` and `info` added.
 */
export function upgradeToPoiModel(
  db: DatabaseSync,
  opts: { schemaVersion?: number; formatGeneration?: number } = {},
): void {
  const meta = columns(db, 'metadata');
  if (!meta.includes('schema_version')) db.exec('ALTER TABLE metadata ADD COLUMN schema_version INTEGER');
  if (!meta.includes('format_generation')) db.exec('ALTER TABLE metadata ADD COLUMN format_generation INTEGER DEFAULT 0');
  db.prepare('UPDATE metadata SET schema_version = ?, format_generation = ?')
    .run(opts.schemaVersion ?? 4, opts.formatGeneration ?? 0);

  const pois = columns(db, 'pois');
  if (pois.length === 0) {
    db.exec(POIS_DDL);
  } else {
    if (!pois.includes('parent_id')) db.exec('ALTER TABLE pois ADD COLUMN parent_id INTEGER');
    if (!pois.includes('info')) db.exec('ALTER TABLE pois ADD COLUMN info TEXT');
  }
  db.exec(EDGE_POIS_DDL);
}
