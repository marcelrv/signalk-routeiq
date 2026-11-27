/**
 * The engine holds no vessel state, so the plugin fills each request with the
 * vessel dimensions (Signal K stream values, or PUT /vessel), the configured
 * speed and the configured margins before the engine sees it. What is pinned
 * here is that filling and its precedence: a value in the request wins over the
 * plugin's, which wins over the engine's own defaults. The engine is stubbed:
 * what is under test is the handler around it.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { Router } from 'express';
import type { ServerAPI } from '@signalk/server-api';
import { ApiHandler } from '../dist-tsc/api.js';
import { toEngineOptions } from '../dist-tsc/engine-options.js';
import { DEFAULT_CONFIG } from '../dist-tsc/types.js';
import type { PluginConfig, RoutingRequest } from '../dist-tsc/types.js';
import { VesselState, fillRequest } from '../dist-tsc/vessel-state.js';

const START = { latitude: 52, longitude: 4 };
const END = { latitude: 53, longitude: 5 };

function stubEngine() {
  const requests: RoutingRequest[] = [];
  return {
    requests,
    tidesClient: {},
    currentsClient: null,
    async calculateRoute(request: RoutingRequest) {
      requests.push(request);
      return { type: 'FeatureCollection', features: [] };
    },
    async *streamDepartures(request: RoutingRequest) {
      requests.push(request);
      yield { index: 0, departureTime: '2026-01-01T00:00:00.000Z', totalSeconds: 1 };
    },
    async scanDepartures(request: RoutingRequest) {
      requests.push(request);
      return [];
    },
  };
}

function makeHandler(engine: unknown, config: Partial<PluginConfig> = {}) {
  const app = {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    getSelfPath: () => undefined,
  } as unknown as ServerAPI;
  const handler = new ApiHandler({ ...DEFAULT_CONFIG, ...config }, app);
  handler.setComponents({} as never, engine as never);
  return handler;
}

function call(
  router: Router,
  method: string,
  url: string,
  body?: unknown,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      path: url,
      originalUrl: '/router' + url,
      headers: {},
      query: {},
      body,
      on: () => req,
      ...extra,
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      header: () => res,
      setHeader: () => res,
      getHeader: () => undefined,
      on: () => res,
      off: () => res,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json: (json: unknown) => resolve({ status: res.statusCode, json }),
      send: (json: unknown) => resolve({ status: res.statusCode, json }),
      end: () => resolve({ status: res.statusCode, json: undefined }),
    };
    (router as unknown as (q: unknown, s: unknown, n: (e?: unknown) => void) => void)(req, res, (e) =>
      reject(e instanceof Error ? e : new Error('no handler reached')),
    );
  });
}

describe('plugin fills the request the engine receives', () => {
  it('fills vessel dimensions, speed and margins from the plugin state and config', async () => {
    const engine = stubEngine();
    const handler = makeHandler(engine, { averageSpeedKnots: 6.5, safetyMarginDraft: 0.4 });
    // What the Signal K subscription code does with values from the stream.
    handler.vessel.update({ draft: 1.8, beam: 3.2, airDraft: 14 });

    const res = await call(handler.getRouter(), 'POST', '/route', { start: START, end: END });
    assert.strictEqual(res.status, 200);
    const r = engine.requests[0];
    assert.strictEqual(r.draft, 1.8);
    assert.strictEqual(r.beam, 3.2);
    assert.strictEqual(r.airDraft, 14);
    assert.strictEqual(r.speedKnots, 6.5);
    assert.strictEqual(r.safetyMarginDraft, 0.4);
    assert.strictEqual(r.safetyMarginBeam, DEFAULT_CONFIG.safetyMarginBeam);
    assert.strictEqual(r.safetyMarginAirDraft, DEFAULT_CONFIG.safetyMarginAirDraft);
  });

  it('a value in the request wins over the stream value and the config', async () => {
    const engine = stubEngine();
    const handler = makeHandler(engine, { averageSpeedKnots: 6.5 });
    handler.vessel.update({ draft: 1.8, beam: 3.2, airDraft: 14 });

    await call(handler.getRouter(), 'POST', '/route', {
      start: START,
      end: END,
      draft: 2.6,
      speedKnots: 8,
      safetyMarginBeam: 0.5,
    });
    const r = engine.requests[0];
    assert.strictEqual(r.draft, 2.6);
    assert.strictEqual(r.beam, 3.2, 'what the request left out still comes from the plugin');
    assert.strictEqual(r.speedKnots, 8);
    assert.strictEqual(r.safetyMarginBeam, 0.5);
  });

  it('before the stream provides anything, the engine-default vessel is sent', async () => {
    const engine = stubEngine();
    const handler = makeHandler(engine);
    await call(handler.getRouter(), 'POST', '/route', { start: START, end: END });
    const r = engine.requests[0];
    assert.deepStrictEqual([r.draft, r.beam, r.airDraft], [0, 4, 0]);
    assert.deepStrictEqual(
      [r.draft, r.beam, r.airDraft],
      [
        toEngineOptions(DEFAULT_CONFIG).defaultVessel.draft,
        toEngineOptions(DEFAULT_CONFIG).defaultVessel.beam,
        toEngineOptions(DEFAULT_CONFIG).defaultVessel.airDraft,
      ],
    );
  });

  it('a later stream update changes the next request, not the earlier one', async () => {
    const engine = stubEngine();
    const handler = makeHandler(engine);
    handler.vessel.update({ draft: 1.5 });
    await call(handler.getRouter(), 'POST', '/route', { start: START, end: END });
    handler.vessel.update({ draft: 2.2 });
    await call(handler.getRouter(), 'POST', '/route', { start: START, end: END });
    assert.deepStrictEqual(engine.requests.map((r) => r.draft), [1.5, 2.2]);
  });

  it('PUT /vessel changes the defaults used by later requests', async () => {
    const engine = stubEngine();
    const handler = makeHandler(engine);
    const router = handler.getRouter();

    const put = await call(router, 'PUT', '/vessel', { draft: 2.1, airDraft: 12 }, { skIsAuthenticated: true });
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual(put.json.vessel, { draft: 2.1, beam: 4, airDraft: 12 });

    const got = await call(router, 'GET', '/vessel');
    assert.strictEqual(got.json.draft, 2.1);
    assert.strictEqual(got.json.airDraft, 12);
    assert.strictEqual(got.json.effectiveDraft, 2.4); // 2.1 + 0.3 margin

    await call(router, 'POST', '/route', { start: START, end: END });
    const r = engine.requests[0];
    assert.deepStrictEqual([r.draft, r.beam, r.airDraft], [2.1, 4, 12]);
  });

  it('PUT /vessel still needs a login', async () => {
    const handler = makeHandler(stubEngine());
    const put = await call(handler.getRouter(), 'PUT', '/vessel', { draft: 2.1 });
    assert.strictEqual(put.status, 401);
    assert.strictEqual(handler.vessel.get().draft, 0);
  });

  it('the departure scan is filled the same way', async () => {
    const engine = stubEngine();
    const handler = makeHandler(engine, { averageSpeedKnots: 7 });
    handler.vessel.update({ draft: 1.9, beam: 3, airDraft: 11 });
    await call(
      handler.getRouter(),
      'POST',
      '/route/departures',
      { start: START, end: END, draft: 2.4 },
      { headers: { accept: 'application/json' } },
    );
    const r = engine.requests[0];
    assert.deepStrictEqual([r.draft, r.beam, r.airDraft, r.speedKnots], [2.4, 3, 11, 7]);
  });

  it('a dropped dimension is filled from the plugin, with the warning text unchanged', async () => {
    const engine = stubEngine();
    const handler = makeHandler(engine);
    handler.vessel.update({ draft: 1.8 });
    const res = await call(handler.getRouter(), 'POST', '/route', {
      start: START,
      end: END,
      draft: 'deep',
    });
    assert.strictEqual(engine.requests[0].draft, 1.8);
    assert.match(
      res.json.warnings[0].message,
      /Routed with the draft configured on the server instead; check the vessel dimensions in Signal K\.$/,
    );
  });

  it('rejects clearly invalid input with 400 before the engine is reached', async () => {
    const engine = stubEngine();
    const handler = makeHandler(engine);
    const router = handler.getRouter();
    for (const body of [
      { start: { latitude: 95, longitude: 4 }, end: END },
      { start: START, end: END, departureTime: 'tomorrow-ish' },
      { start: START, end: END, speedKnots: -3 },
      { start: START, end: END, useTides: 'yes' },
    ]) {
      const res = await call(router, 'POST', '/route', body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.strictEqual(engine.requests.length, 0);
  });
});

describe('fillRequest', () => {
  it('does not change the request it is given', () => {
    const request: RoutingRequest = { start: START, end: END };
    const filled = fillRequest(request, new VesselState(), DEFAULT_CONFIG);
    assert.deepStrictEqual(request, { start: START, end: END });
    assert.strictEqual(filled.draft, 0);
  });
});
