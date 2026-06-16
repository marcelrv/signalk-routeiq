import { RoutingDatabase } from '../dist/database.js';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

const dbDir = '/tmp/test_route'; // directory containing netherlands.sqlite
const db = new RoutingDatabase(dbDir);
await db.init();
await db.loadGraph();

const engine = new RoutingEngine(db, DEFAULT_CONFIG);
engine.setVesselDimensions({ draft: 2.0, beam: 5.0, airDraft: 19.5 });

try {
  const route = await engine.calculateRoute({
    start: { latitude: 51.613, longitude: 3.885 },
    end: { latitude: 51.609, longitude: 3.896 },
    minCoastDistance: 0,
  });

  console.log(`Route: ${route.features.length} segments, total=${route.totalDistance?.toFixed(0)}m`);
  
  // Print ALL coordinates in order
  const fullPath: number[][] = [];
  for (const f of route.features) {
    for (const c of f.geometry.coordinates) {
      const key = `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
      const existing = fullPath.some(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}` === key);
      if (!existing) fullPath.push([c[0], c[1]]);
    }
  }
  console.log(`Full path: ${fullPath.length} points`);
  for (const [lon, lat] of fullPath) {
    const mark = (lat >= 51.626 && lon >= 3.910) ? ' <-- OPENING' : '';
    console.log(`  (${lon.toFixed(5)}, ${lat.toFixed(5)})${mark}`);
  }

  // Check segments for air draft constraints
  let hasConstrained = false;
  for (let i = 0; i < route.features.length; i++) {
    const f = route.features[i];
    const ad = f.properties?.maxAirDraft;
    if (ad != null && ad < 19.5) {
      const c = f.geometry.coordinates;
      console.log(`  SEGMENT ${i}: (${c[0][0].toFixed(5)}, ${c[0][1].toFixed(5)}) -> (${c[1][0].toFixed(5)}, ${c[1][1].toFixed(5)}) air=${ad}`);
      hasConstrained = true;
    }
  }
  if (!hasConstrained) console.log('All segments have air draft >= 19.5');

  const throughOpening = fullPath.some(([lon, lat]) =>
    lat >= 51.626 && lat <= 51.628 && lon >= 3.910 && lon <= 3.912
  );
  console.log(`\nThrough opening: ${throughOpening}`);

  if (route.warnings?.length) {
    console.log('Warnings:');
    for (const w of route.warnings) console.log(`  ${w.type}: ${w.message}`);
  }
} catch (e: any) {
  console.log('ERROR:', e.message);
}

await db.close();
