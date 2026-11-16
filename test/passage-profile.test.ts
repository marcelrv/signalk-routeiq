/**
 * The passage profile saved with a route (issue #50): the calculated times
 * travel with the Signal K route resource, tied to the geometry they were
 * calculated for, so a reader can trust them or see they are stale.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { Router } from 'express';
import { ServerAPI } from '@signalk/server-api';
import { GpxExporter } from '../dist/gpx-export.js';
import { ApiHandler } from '../dist/api.js';
import { DEFAULT_CONFIG } from '../dist/types.js';
import {
  buildPassageProfile,
  canonicalGeometry,
  geometryHash,
} from '../dist/passage-profile.js';

const waypoints = [
  { latitude: 52.0, longitude: 5.0 },
  { latitude: 52.01, longitude: 5.02 },
  { latitude: 52.02, longitude: 5.05 },
];
const coordsOf = (w: typeof waypoints) => w.map((p) => [p.longitude, p.latitude]);

/** A calculated route with one lock wait, as finalizeRoute leaves it. */
function calculated(extra: Record<string, unknown> = {}): any {
  return {
    type: 'FeatureCollection',
    features: [],
    totalDistance: 41114,
    totalCost: 1,
    totalSeconds: 20520,
    totalWaitSeconds: 7200,
    calculatedAt: '2026-11-15T10:00:00.000Z',
    timingAssumptions: { averageSpeedKnots: 6, lockWaitMinutes: 60, bridgeWaitMinutes: 30 },
    waypoints,
    crossings: [
      { type: 'lock', name: 'Sluis A', structure: '7', distanceFromStart: 8123, waitSeconds: 3600, position: waypoints[1] },
      { type: 'bridge', name: 'Brug B', structure: '9', distanceFromStart: 9000, waitSeconds: 3600, position: waypoints[1] },
      { type: 'bridge', name: 'Vaste brug', structure: '10', distanceFromStart: 9500, position: waypoints[1] },
    ],
    warnings: [{ type: 'start_connecting', message: 'Start connected 40 m' }],
    itinerary: [
      {
        coordIndex: 0,
        leg: {
          warnings: [{
            type: 'shallow', level: 'danger', message: 'Shallow',
            minDepth: 1, requiredDepth: 2,
            at: [{ coordIndex: 0, toCoordIndex: 1, distanceFromStart: 500, distance: 100, bounds: [0, 0, 0, 0] }],
          }],
        },
      },
    ],
    ...extra,
  };
}

describe('passage profile', () => {
  it('saves the total with the waiting part inside it', () => {
    const r = GpxExporter.toSignalKRoute(calculated(), 'probe');
    const p = r.feature.properties.passageProfile;
    assert.ok(p, 'profile present');
    assert.strictEqual(p.version, 1);
    assert.strictEqual(p.provider.name, 'signalk-routeiq');
    assert.match(p.provider.version, /^\d+\.\d+\.\d+/);
    assert.deepStrictEqual(p.duration, {
      total: 20520, moving: 13320, waiting: 7200, waitingIncludedInTotal: true,
    });
    assert.strictEqual(p.distance, 41114);
    assert.strictEqual(p.calculatedAt, '2026-11-15T10:00:00.000Z');
  });

  it('hashes exactly the coordinates it saves', () => {
    const r = GpxExporter.toSignalKRoute(calculated(), 'probe');
    const p = r.feature.properties.passageProfile;
    assert.strictEqual(p.geometry.hash, geometryHash(r.feature.geometry.coordinates));
    assert.strictEqual(p.geometry.pointCount, r.feature.geometry.coordinates.length);
    assert.match(p.geometry.hash, /^sha256:[0-9a-f]{64}$/);
  });

  it('leaves an undated plan undated', () => {
    const p = buildPassageProfile(calculated(), coordsOf(waypoints))!;
    assert.strictEqual(p.departure, null);
    assert.strictEqual(p.arrival, null);
    const dated = buildPassageProfile(
      calculated({
        departureTime: '2026-11-15T08:00:00.000Z',
        arrivalTime: '2026-11-15T13:42:00.000Z',
        tide: { enabled: true, estimated: true, source: 'stations', stations: [] },
      }),
      coordsOf(waypoints),
    )!;
    assert.strictEqual(dated.departure, '2026-11-15T08:00:00.000Z');
    assert.strictEqual(dated.arrival, '2026-11-15T13:42:00.000Z');
    assert.deepStrictEqual(dated.assumptions.tide, { enabled: true, estimated: true, source: 'stations' });
  });

  it('states its assumptions in SI units', () => {
    const p = buildPassageProfile(calculated(), coordsOf(waypoints))!;
    assert.strictEqual(p.assumptions.speedThroughWater, 3.087); // 6 kn
    assert.strictEqual(p.assumptions.lockWait, 3600);
    assert.strictEqual(p.assumptions.bridgeWait, 1800);
    assert.deepStrictEqual(p.assumptions.tide, { enabled: false });
  });

  it('lists only the structures that charged a wait, and the warnings', () => {
    const p = buildPassageProfile(calculated(), coordsOf(waypoints))!;
    assert.deepStrictEqual(p.waits.map((w) => w.name), ['Sluis A', 'Brug B']);
    assert.strictEqual(p.waits.reduce((t, w) => t + w.seconds, 0), p.duration.waiting);
    assert.deepStrictEqual(
      p.warnings.map((w) => [w.type, w.level, w.distanceFromStart]),
      [['start_connecting', undefined, undefined], ['shallow', 'danger', 500]],
    );
  });

  it('is left out when the route carries no time', () => {
    const r = GpxExporter.toSignalKRoute(calculated({ totalSeconds: undefined }), 'probe');
    assert.ok(!('passageProfile' in r.feature.properties));
  });

  it('hash ignores float noise and altitude, but not a moved point', () => {
    const base = coordsOf(waypoints);
    const noisy = base.map(([lon, lat]) => [lon + 1e-9, lat - 1e-9, 3]);
    assert.strictEqual(geometryHash(noisy), geometryHash(base));
    const moved = base.map((c, i) => (i === 1 ? [c[0] + 0.0001, c[1]] : c));
    assert.notStrictEqual(geometryHash(moved), geometryHash(base));
    // The documented canonical form, so other implementations can match it.
    assert.strictEqual(canonicalGeometry([[5, 52], [-0.000001, 52.012346]]), '500000,5200000;0,5201235');
  });
});

describe('POST /route/profile', () => {
  function setup(stored: any) {
    const writes: Array<{ id: string; value: any }> = [];
    const app = {
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      getSelfPath: () => undefined,
      resourcesApi: {
        getResource: async (type: string, id: string) => {
          assert.strictEqual(type, 'routes');
          if (!stored || id !== 'r1') throw new Error('not found');
          return structuredClone(stored);
        },
        setResource: async (_type: string, id: string, value: unknown) => {
          writes.push({ id, value });
        },
      },
    } as unknown as ServerAPI;
    const router = new ApiHandler({ ...DEFAULT_CONFIG }, app).getRouter();
    return { router, writes };
  }

  const writer = { skIsAuthenticated: true, skPrincipal: { permissions: 'readwrite' } };

  function post(
    router: Router,
    body: unknown,
    auth: object = writer,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url = '/route/profile';
      const res: any = {
        statusCode: 200,
        headersSent: false,
        header: () => res,
        setHeader: () => res,
        getHeader: () => undefined,
        status(code: number) { res.statusCode = code; return res; },
        json: (b: unknown) => resolve({ status: res.statusCode, body: b }),
        send: (b: unknown) => resolve({ status: res.statusCode, body: b }),
        end: () => resolve({ status: res.statusCode, body: undefined }),
      };
      (router as any)(
        { method: 'POST', url, path: url, originalUrl: '/router' + url, headers: {}, query: {}, body, ...auth },
        res,
        (err?: unknown) => reject(err instanceof Error ? err : new Error('no handler')),
      );
    });
  }

  const storedRoute = (coordinates: number[][]) => ({
    name: 'Saved by host',
    description: 'kept',
    $source: 'resources-provider',
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: { coordinatesMeta: coordinates.map((_, i) => ({ name: `WP${i + 1}` })) },
    },
  });

  it('attaches the profile when the stored geometry is the calculated one', async () => {
    const { router, writes } = setup(storedRoute(coordsOf(waypoints)));
    const res = await post(router, { href: 'r1', route: calculated() });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(writes.length, 1);
    const v = writes[0].value;
    assert.strictEqual(v.name, 'Saved by host');
    assert.ok(!('$source' in v), 'server-added fields are not written back');
    assert.strictEqual(v.feature.properties.coordinatesMeta.length, 3, 'other properties kept');
    assert.strictEqual(v.feature.properties.passageProfile.duration.waiting, 7200);
  });

  it('accepts a resource path as href', async () => {
    const { router, writes } = setup(storedRoute(coordsOf(waypoints)));
    const res = await post(router, { href: '/resources/routes/r1', route: calculated() });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(writes[0].id, 'r1');
  });

  it('refuses, and writes nothing, when the route was edited after calculating', async () => {
    const edited = coordsOf(waypoints).map((c, i) => (i === 1 ? [c[0] + 0.001, c[1]] : c));
    const { router, writes } = setup(storedRoute(edited));
    const res = await post(router, { href: 'r1', route: calculated() });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(writes.length, 0);
  });

  it('answers 404 for an unknown route and 400 for a bad href', async () => {
    const { router, writes } = setup(storedRoute(coordsOf(waypoints)));
    const missing = await post(router, { href: 'nope', route: calculated() });
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body.reason, 'routeNotFound', 'told apart from a missing endpoint');
    assert.strictEqual((await post(router, { href: '../x/y', route: calculated() })).status, 400);
    assert.strictEqual(writes.length, 0);
  });

  it('needs a logged-in user with write access', async () => {
    const { router, writes } = setup(storedRoute(coordsOf(waypoints)));
    const body = { href: 'r1', route: calculated() };
    assert.strictEqual((await post(router, body, {})).status, 401);
    assert.strictEqual(
      (await post(router, body, { skIsAuthenticated: true, skPrincipal: { permissions: 'readonly' } })).status,
      403,
    );
    assert.strictEqual(
      (await post(router, body, { skIsAuthenticated: true, skPrincipal: { permissions: 'admin' } })).status,
      200,
    );
    assert.strictEqual(writes.length, 1);
  });
});

describe('passage profile in GPX', () => {
  it('writes the times as extensions before the first route point', () => {
    const gpx = GpxExporter.toGpx(calculated(), 'probe');
    const ext = gpx.indexOf('<extensions>');
    assert.ok(ext > gpx.indexOf('</desc>'), 'extensions follow <desc>');
    assert.ok(ext < gpx.indexOf('<rtept'), 'GPX 1.1 order: extensions before rtept');
    assert.match(gpx, /<ar:passageProfile version="1" provider="signalk-routeiq" providerVersion="\d[^"]*" calculatedAt="2026-11-15T10:00:00.000Z">/);
    assert.match(gpx, /<ar:duration total="20520" moving="13320" waiting="7200" waitingIncludedInTotal="true"\/>/);
    assert.match(gpx, /<ar:assumptions speedThroughWater="3.087" lockWait="3600" bridgeWait="1800" tide="false"\/>/);
    assert.ok(!gpx.includes('<ar:departure>'), 'an undated plan has no departure');
  });

  it('lists each wait with where it is, and the warnings', () => {
    const gpx = GpxExporter.toGpx(calculated(), 'probe');
    const waits = gpx.match(/<ar:wait [^>]*\/>/g) ?? [];
    assert.strictEqual(waits.length, 2);
    assert.match(waits[0], /type="lock" name="Sluis A" structure="7" distanceFromStart="8123" seconds="3600" lat="52.010000" lon="5.020000"/);
    assert.match(gpx, /<ar:warning type="shallow" level="danger" distanceFromStart="500">Shallow<\/ar:warning>/);
  });

  it('says the duration in the description, for plotters that skip extensions', () => {
    const gpx = GpxExporter.toGpx(calculated(), 'probe');
    assert.match(gpx, /<desc>[^<]*, Duration: 5h42m \(2h00m waiting\)<\/desc>/);
  });

  it('escapes names, and leaves everything out when there is no time', () => {
    const r = calculated();
    r.crossings[0].name = 'Sluis "A" & <B>';
    assert.match(GpxExporter.toGpx(r, 'probe'), /name="Sluis &quot;A&quot; &amp; &lt;B&gt;"/);
    const none = GpxExporter.toGpx(calculated({ totalSeconds: undefined }), 'probe');
    assert.ok(!none.includes('<extensions>') && !none.includes('Duration:'));
  });

  it('carries departure and arrival for a dated plan', () => {
    const gpx = GpxExporter.toGpx(
      calculated({ departureTime: '2026-11-15T08:00:00.000Z', arrivalTime: '2026-11-15T13:42:00.000Z' }),
      'probe',
    );
    assert.match(gpx, /<ar:departure>2026-11-15T08:00:00.000Z<\/ar:departure>\s*<ar:arrival>2026-11-15T13:42:00.000Z<\/ar:arrival>/);
  });
});
