import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildPassageProfile,
  GpxExporter,
  type ProviderInfo,
  type RouteResult,
} from '../dist/index.js';

const waypoints = [
  { latitude: 52.0, longitude: 5.0 },
  { latitude: 52.02, longitude: 5.05 },
];

const route = {
  type: 'FeatureCollection',
  features: [],
  totalDistance: 4000,
  totalCost: 1,
  totalSeconds: 1800,
  totalWaitSeconds: 0,
  calculatedAt: '2026-11-15T10:00:00.000Z',
  timingAssumptions: { averageSpeedKnots: 6, lockWaitMinutes: 60, bridgeWaitMinutes: 30 },
  waypoints,
} as unknown as RouteResult;

const coords = waypoints.map((w) => [w.longitude, w.latitude]);

const provider: ProviderInfo = {
  name: 'probe-provider',
  version: '9.9.9-test',
  displayName: 'Probe Planner',
};

describe('provider info is a parameter', () => {
  it('the passage profile carries the name and version passed in', () => {
    const p = buildPassageProfile(route, coords, provider)!;
    assert.deepStrictEqual(p.provider, { name: 'probe-provider', version: '9.9.9-test' });
  });

  it('the Signal K route carries them in its profile and description', () => {
    const r = GpxExporter.toSignalKRoute(route, 'probe', provider, 'id-1');
    assert.deepStrictEqual(r.feature.properties.passageProfile.provider, {
      name: 'probe-provider',
      version: '9.9.9-test',
    });
    assert.match(r.description, /^Route calculated by Probe Planner - /);
  });

  it('the GPX carries them as creator, description and extension attributes', () => {
    const gpx = GpxExporter.toGpx(route, 'probe', provider);
    assert.match(gpx, /creator="probe-provider"/);
    assert.match(gpx, /<desc>Route calculated by Probe Planner - /);
    assert.match(gpx, /provider="probe-provider" providerVersion="9\.9\.9-test"/);
    assert.ok(gpx.includes('xmlns:ar="http://signalk.org/routeiq"'));
  });

  it('displayName falls back to name', () => {
    const gpx = GpxExporter.toGpx(route, 'probe', { name: 'plain', version: '1.0.0' });
    assert.match(gpx, /<desc>Route calculated by plain - /);
  });
});
