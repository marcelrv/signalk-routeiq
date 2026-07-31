/**
 * The Signal K route resource RouteIQ writes from POST /push.
 *
 * The rule being pinned is the one that broke saving from the Freeboard panel:
 * Signal K's schema requires every `coordinatesMeta` entry to be `{name}` or
 * `{href}`, so an entry with neither — or with a name the host discards, which
 * an empty string is — fails validation for the whole route. The field is
 * optional, so the way to get this wrong is to emit it with holes in it.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { GpxExporter } from '../dist/gpx-export.js';

describe('toSignalKRoute coordinatesMeta', () => {
  const routeWithWaypoints = (n: number) => ({
    totalDistance: 12345,
    totalCost: 999,
    features: [],
    waypoints: Array.from({ length: n }, (_, i) => ({
      latitude: 51.5 + i * 0.01,
      longitude: 3.6 + i * 0.01,
    })),
  });

  /** The schema's rule, applied here so a regression fails locally. */
  const isValidMetaEntry = (m: Record<string, unknown>): boolean =>
    (typeof m.name === 'string' && m.name.length > 0) ||
    (typeof m.href === 'string' && m.href.length > 0);

  it('names every waypoint, so no entry is an empty object', () => {
    const r = GpxExporter.toSignalKRoute(routeWithWaypoints(53) as never, 'probe');
    const meta = r.feature.properties.coordinatesMeta;
    assert.ok(Array.isArray(meta), 'coordinatesMeta is present');
    assert.strictEqual(meta.length, 53);
    const bad = meta
      .map((m: Record<string, unknown>, i: number) => (isValidMetaEntry(m) ? -1 : i))
      .filter((i: number) => i >= 0);
    assert.deepStrictEqual(bad, [], `every entry satisfies {name} or {href}; bad indices: ${bad}`);
  });

  it('keeps one entry per coordinate', () => {
    for (const n of [2, 3, 71, 97]) {
      const r = GpxExporter.toSignalKRoute(routeWithWaypoints(n) as never, 'probe');
      assert.strictEqual(
        r.feature.properties.coordinatesMeta.length,
        r.feature.geometry.coordinates.length,
        `n=${n}: a length mismatch makes the host discard the whole array`,
      );
    }
  });

  it('numbers them from 1, matching what the plotter panel writes', () => {
    const r = GpxExporter.toSignalKRoute(routeWithWaypoints(4) as never, 'probe');
    assert.deepStrictEqual(
      r.feature.properties.coordinatesMeta.map((m: { name: string }) => m.name),
      ['WP1', 'WP2', 'WP3', 'WP4'],
    );
  });

  it('covers the legacy geometry path too', () => {
    // A result with no simplified waypoints falls back to the raw coordinates;
    // those have no names either, so they need the same treatment.
    const seg = { distance: 100, minDepth: 5, maxAirDraft: 99, costFactor: 1 };
    const legacy = {
      totalDistance: 500,
      totalCost: 1,
      features: [{
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [[3.6, 51.5], [3.61, 51.51], [3.62, 51.52]],
        },
        properties: { segments: [seg, seg] },
      }],
    };
    const r = GpxExporter.toSignalKRoute(legacy as never, 'probe');
    const meta = r.feature.properties.coordinatesMeta;
    assert.strictEqual(meta.length, r.feature.geometry.coordinates.length);
    assert.ok(meta.every(isValidMetaEntry), 'legacy path is named too');
  });
});
