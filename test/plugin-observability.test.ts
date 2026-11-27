/**
 * What the plugin shows of the engine's observability work: the 422 body keeps
 * its `error` and `code` and gains `failure`, warnings carry `code` + `params`
 * in English whatever `lang` the client sends, and the console output of a
 * start-up and a few routes is what it was before the core took an injected
 * logger.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { format } from 'node:util';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { IRouter, Router } from 'express';
import type { ServerAPI } from '@signalk/server-api';
import { pluginConstructor } from '../dist-tsc/index.js';

const P = (latitude: number, longitude: number) => ({ latitude, longitude });
const VESSEL = { draft: 2, beam: 5, airDraft: 19.5 };

interface Reply {
  status: number;
  body?: any;
}

function call(router: Router, method: string, url: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve) => {
    const req = { method, url, path: url, originalUrl: '/router' + url, headers: {}, query: {}, body };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      header: () => res,
      setHeader: () => res,
      getHeader: () => undefined,
      sendStatus: (code: number) => {
        res.statusCode = code;
        resolve({ status: code });
        return res;
      },
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json: (b: unknown) => resolve({ status: res.statusCode, body: b }),
      send: (b: unknown) => resolve({ status: res.statusCode, body: b }),
      end: () => resolve({ status: res.statusCode }),
    };
    (router as any)(req, res, () => resolve({ status: -1 }));
  });
}

async function startPlugin(dataDir: string) {
  const app = { use() {}, registerResourceProvider() {}, getSelfPath() {}, debug() {} } as unknown as ServerAPI;
  const plugin = pluginConstructor(app);
  let router: Router | null = null;
  const outer = {
    get: () => outer,
    use: (first: unknown, second: unknown) => {
      if (first === '/router') router = second as Router;
      return outer;
    },
  };
  plugin.registerWithRouter(outer as unknown as IRouter);
  assert.ok(router, 'the plugin mounts its API at /router');
  plugin.start({ routingDataDir: dataDir });
  for (let i = 0; i < 300; i++) {
    if ((await call(router!, 'GET', '/stats')).status === 200) return { plugin, router: router as Router };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the plugin did not become ready');
}

describe('plugin: route failures and warnings', () => {
  let dir: string;
  let stop: () => Promise<void>;
  let router: Router;
  const quiet: Array<() => void> = [];

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeiq-plugin-obs-'));
    fs.copyFileSync(path.join('test', 'fixtures', 'zeelandbrug', 'netherlands.sqlite'), path.join(dir, 'netherlands.sqlite'));
    const log = console.log;
    console.log = () => undefined;
    quiet.push(() => (console.log = log));
    try {
      const started = await startPlugin(dir);
      router = started.router;
      stop = () => started.plugin.stop() as Promise<void>;
    } finally {
      quiet.pop()!();
    }
  });
  after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const route = (body: unknown) => {
    const log = console.log;
    console.log = () => undefined;
    return call(router, 'POST', '/route', body).finally(() => {
      console.log = log;
    });
  };

  it('keeps the 422 body (error + code) and adds failure', async () => {
    const r = await route({ start: P(50.0, 3.9), end: P(51.609, 3.896), ...VESSEL });
    assert.strictEqual(r.status, 422);
    assert.deepStrictEqual(r.body, {
      error: 'No routing nodes found near start point',
      code: 'ROUTE_NOT_FOUND',
      failure: { code: 'OUTSIDE_COVERAGE', params: { point: 'start' } },
    });
  });

  it('answers in English whatever lang the client sends', async () => {
    const r = await route({ start: P(50.0, 3.9), end: P(51.609, 3.896), ...VESSEL, lang: 'nl' });
    assert.strictEqual(r.body.error, 'No routing nodes found near start point');
    assert.strictEqual(r.body.failure.code, 'OUTSIDE_COVERAGE');
  });

  it('leaves a request that fails validation as it was: error only, no failure object', async () => {
    const r = await route({ start: P(51.613, 3.885) });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.body, { error: 'Missing required fields: start and end coordinates' });
  });

  it('puts code and params on warnings, with the English text it always had', async () => {
    const r = await route({ start: P(51.613, 3.885), end: P(51.609, 3.896), ...VESSEL, draft: 8, lang: 'nl' });
    assert.strictEqual(r.status, 200);
    const w = r.body.warnings.find((x: any) => x.code === 'ROUTE_CONSTRAINED');
    assert.ok(w, JSON.stringify(r.body.warnings));
    assert.strictEqual(w.type, 'via_constrained');
    assert.match(w.message, /^Route to destination: constrained for 1 leg\(s\) 0\.0Nm — /);
    assert.strictEqual(w.params.legs, 1);
    assert.strictEqual(typeof w.params.distance, 'number');
  });

  it('reports a dropped dimension with the "configured on the server" wording, as code VESSEL_DIMENSION_IGNORED_CONFIGURED', async () => {
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const r = await route({ start: P(51.613, 3.885), end: P(51.609, 3.896), ...VESSEL, draft: 'abc' });
      const w = r.body.warnings[0];
      assert.strictEqual(w.type, 'vessel_dimension_ignored');
      assert.strictEqual(w.code, 'VESSEL_DIMENSION_IGNORED_CONFIGURED');
      assert.deepStrictEqual(w.params, { dimension: 'draft', value: 'abc', max: 30 });
      assert.strictEqual(
        w.message,
        'Ignored the supplied draft (abc) — expected a number between 0 and 30 meters. Routed with the draft configured on the server instead; check the vessel dimensions in Signal K.',
      );
    } finally {
      console.warn = warn;
    }
  });
});

/** Each latitude/longitude the observability test sends, as a pattern for the
 *  value as written, and rounded or padded to 1..5 decimals. A match must not
 *  sit inside a longer number. */
const SENT_COORDINATES: RegExp[] = [51.613, 3.885, 51.609, 3.896].map((n) => {
  const forms = new Set<string>([String(n)]);
  for (let d = 1; d <= 5; d++) forms.add(n.toFixed(d));
  return new RegExp(`(?<![\\d.])(?:${[...forms].map((f) => f.replace('.', '\\.')).join('|')})(?!\\d)`);
});

const leaksCoordinate = (text: string): boolean => SENT_COORDINATES.some((re) => re.test(text.replace(/<DIR>\S*/g, '')));

describe('plugin: console output', () => {
  it('privacy check detects a coordinate passed as an object argument (negative control)', () => {
    const seen: string[] = [];
    const saved = console.log;
    console.log = (...args: unknown[]) => void seen.push(format(...args));
    try {
      console.log('position', { latitude: 51.613, longitude: 3.885 });
    } finally {
      console.log = saved;
    }
    assert.strictEqual(seen.length, 1);
    assert.ok(leaksCoordinate(seen[0]), `the check missed: ${seen[0]}`);
  });

  it('is what it was before the core had an injected logger', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeiq-plugin-log-'));
    fs.copyFileSync(path.join('test', 'fixtures', 'zeelandbrug', 'netherlands.sqlite'), path.join(dir, 'netherlands.sqlite'));
    const seen: Array<{ stream: 'log' | 'warn' | 'error'; text: string }> = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    for (const stream of ['log', 'warn', 'error'] as const) {
      console[stream] = (...args: unknown[]) => void seen.push({ stream, text: format(...args) });
    }
    try {
      const { plugin, router } = await startPlugin(dir);
      await call(router, 'POST', '/route', { start: P(51.613, 3.885), end: P(51.609, 3.896), ...VESSEL });
      await call(router, 'POST', '/route', { start: P(51.613, 3.885), end: P(51.609, 3.896), ...VESSEL, draft: 9 });
      await call(router, 'POST', '/route', { start: P(10, 10), end: P(51.609, 3.896), ...VESSEL });
      await plugin.stop();
      // The worker thread's last lines arrive as messages after the stop.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      Object.assign(console, saved);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lines = seen.map((s) => ({ stream: s.stream, text: s.text.replace(new RegExp(esc, 'g'), '<DIR>') }));
    // The lines the engine, the database and the db worker write; the plugin's
    // own lines are not under test here.
    const engine = lines
      .filter((l) => /^(\[db-worker\]|Route search|\[routeiq\] (Loaded database|Dynamic loading|Single installed|User-edits))/.test(l.text))
      .map((l) => `${l.stream}: ${l.text}`)
      .sort();
    assert.deepStrictEqual(engine, [
      'log: Route search found a penalized result (21m constraint-violating, cost 6819 vs distance 1254m) — retrying with expanded bounding box from 111km to 222km',
      'log: Route search kept a penalized result (21m constraint-violating, cost 6819 vs distance 1254m) — bounding box expansion stopped improving',
      'log: Route search penalized-result retry did not clear the penalty (final cost 6819, 21m constraint-violating)',
      'log: [db-worker] Opened database on demand: <DIR>/netherlands.sqlite (dbIndex=0)',
      'log: [db-worker] Overlay opened: <DIR>/user-edits.sqlite',
      'log: [routeiq] Dynamic loading enabled: peeked 1 database(s) in routing data directory: <DIR>, none loaded yet',
      'log: [routeiq] Loaded database netherlands.sqlite (dbIndex=0): 2775 nodes, 4826 edges, 8 POIs, 3 navmesh regions',
      'log: [routeiq] Single installed database netherlands.sqlite — eager-loading at startup',
      'log: [routeiq] User-edits overlay ready: <DIR>/user-edits.sqlite',
    ]);
    // Nothing the engine wrote went to the error stream, and no line has the
    // look of a coordinate.
    assert.ok(lines.every((l) => !/-?\d{1,3}\.\d{4,}/.test(l.text.replace(/<DIR>\S*/g, ''))), 'a coordinate-like number in the output');
    // The coordinates this test sends (three decimals), in the forms a log
    // line could print them.
    const leaks = leaksCoordinate;
    assert.ok(
      lines.every((l) => !leaks(l.text)),
      `a coordinate this test sent is in the output: ${lines.find((l) => leaks(l.text))?.text}`,
    );
    // Negative control: the check does see those coordinates.
    assert.ok(leaks('Route from 51.613, 3.885 to 51.609, 3.896'));
    assert.ok(leaks('start=[3.885,51.613]'));
    assert.ok(leaks('near 51.61 3.89 (rounded)'));
    assert.ok(leaks('lat 51.6130 lon 3.8850'));
    assert.ok(!leaks('took 13.8851 ms, version 1.3.88'));
  });
});
