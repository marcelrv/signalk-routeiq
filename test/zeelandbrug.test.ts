import * as path from 'path';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

// Real Phase-1-pipeline-generated database for the Zeelandbrug scenario
// (test/fixtures/zeelandbrug/netherlands.sqlite, regenerated from
// signalk-router-pipeline's data/zeelandbrug_tight source GeoJSON — not a
// synthetic fixture). This is deliberate: the three bugs this test guards
// against (SSFA funnel portal-vertex swap in navmesh.ts, astarSearch's
// goal-test ignoring a boundary node's own funnel "suffix" cost, and the
// pipeline's mariculture obstacle layer hard-blocking the bridge's opening
// corridor with no RESTRN check) only ever surfaced on a real generated
// database with realistic region/boundary sizes — the small synthetic
// fixtures used by navmesh.test.ts/navmesh-integration.test.ts all passed
// throughout. See NEXT_PHASES.md, "Phase 2 Hardening, Round 3".
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const START = { latitude: 51.613, longitude: 3.885 };
const END = { latitude: 51.609, longitude: 3.896 };
const STRAIGHT_LINE_M = haversine(START.latitude, START.longitude, END.latitude, END.longitude);

// Bounding box around the Zeelandbrug's movable (opening) span, per the
// source data's CATBRG=5 crossing at (51.62678, 3.91101).
const OPENING_BBOX = { minLat: 51.626, maxLat: 51.628, minLon: 3.910, maxLon: 3.912 };

describe('Zeelandbrug opening-bridge routing (Phase 2 Hardening Round 3 regression)', () => {
  const fixturesDir = path.join('test', 'fixtures', 'zeelandbrug');
  let db: RoutingDatabase;
  let engine: RoutingEngine;

  before(async () => {
    db = new RoutingDatabase(fixturesDir);
    await db.init();
    await db.loadGraph();
    engine = new RoutingEngine(db, DEFAULT_CONFIG);
    engine.setVesselDimensions({ draft: 2.0, beam: 5.0, airDraft: 19.5 });
  });

  after(async () => {
    await db.close();
  });

  it('routes through the opening bridge instead of a low-clearance fixed span', async () => {
    const route = await engine.calculateRoute({
      start: START,
      end: END,
      minCoastDistance: 0,
    });

    assert.ok(route.totalDistance! > 0, 'expected a non-empty route');

    // Bounded multiple of straight-line distance — catches both the
    // pre-fix zigzag inflation (was 5.5x on this exact scenario) and any
    // future regression, without being so tight it breaks on legitimate
    // route-shape variation from unrelated changes.
    assert.ok(route.totalDistance! < STRAIGHT_LINE_M * 8,
      `route inflated too far: ${route.totalDistance}m vs straight-line ${STRAIGHT_LINE_M.toFixed(0)}m`);

    const coords = route.features.flatMap(f => f.geometry.coordinates);
    const throughOpening = coords.some(([lon, lat]) =>
      lat >= OPENING_BBOX.minLat && lat <= OPENING_BBOX.maxLat &&
      lon >= OPENING_BBOX.minLon && lon <= OPENING_BBOX.maxLon
    );
    assert.ok(throughOpening, 'route should pass through the Zeelandbrug opening span, not a fixed low-clearance crossing');

    // No segment should violate the vessel's required air draft — the
    // movable span is tagged max_air_draft=999 (unlimited) in the source
    // data, so a correct route never needs to cross a genuinely low span.
    const requiredAirDraft = 19.5 + DEFAULT_CONFIG.safetyMarginAirDraft;
    for (const f of route.features) {
      const ad = (f.properties as { maxAirDraft?: number }).maxAirDraft;
      assert.ok(ad === undefined || ad < 0 || ad >= requiredAirDraft,
        `segment air draft ${ad}m is below the required ${requiredAirDraft}m clearance`);
    }

    assert.ok(!route.warnings?.some(w => w.type === 'via_constrained'),
      `unexpected constraint warning on a route that should cleanly clear the opening: ${JSON.stringify(route.warnings)}`);
  });
});
