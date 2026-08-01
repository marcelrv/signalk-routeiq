/**
 * The departure scan streams its results, so the contract worth pinning is the
 * wire format rather than the routing: a client renders the window from the
 * `meta` line before any result exists, places each `departure` by its index
 * because they do not arrive in clock order, and stops when told. The routing
 * engine is stubbed — what is under test is the handler around it.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { Router } from 'express';
import type { ServerAPI } from '@signalk/server-api';
import { ApiHandler } from '../dist/api.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

describe('POST /route/departures streaming', () => {
  const STEPS = 25; // 24 h at 60 min, ends included

  /** A routing engine that answers instantly and records what it was asked. */
  function stubEngine(opts: { failAt?: number } = {}) {
    const visited: number[] = [];
    return {
      visited,
      tidesClient: {},
      departureScanTime: (
        _req: unknown,
        index: number,
        stepMinutes: number,
      ): string => new Date(index * stepMinutes * 60_000).toISOString(),
      async *streamDepartures(
        _req: unknown,
        hours: number,
        step: number,
        signal?: { aborted: boolean },
      ) {
        const { RoutingEngine } = await import('../dist/routing.js');
        const steps = RoutingEngine.departureScanSteps(hours, step);
        for (const i of RoutingEngine.departureScanOrder(steps)) {
          if (signal?.aborted) return;
          visited.push(i);
          if (opts.failAt === i) throw new Error('engine blew up');
          yield {
            index: i,
            departureTime: new Date(i * step * 60_000).toISOString(),
            totalSeconds: 3600 + i,
          };
        }
      },
      async scanDepartures(_req: unknown, hours: number, step: number) {
        const out = [];
        for await (const d of this.streamDepartures(_req, hours, step)) {
          out.push(d);
        }
        return out.sort((a, b) => a.index - b.index);
      },
    };
  }

  function makeHandler(engine: unknown): Router {
    const app = {
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      getSelfPath: () => undefined,
    } as unknown as ServerAPI;
    const handler = new ApiHandler({ ...DEFAULT_CONFIG }, app);
    handler.setComponents({} as never, engine as never);
    return handler.getRouter();
  }

  /** POST the scan and collect whatever the handler writes. */
  function scan(
    router: Router,
    accept: string,
    hooks: { onWrite?: (obj: any, close: () => void) => void } = {},
  ): Promise<{ status: number; contentType: string; lines: any[]; json?: any }> {
    return new Promise((resolve, reject) => {
      const lines: any[] = [];
      const headers: Record<string, string> = {};
      let closeHandler: (() => void) | null = null;
      const finish = (json?: unknown) =>
        resolve({
          status: res.statusCode,
          contentType: headers['Content-Type'] || '',
          lines,
          json,
        });
      const close = () => closeHandler?.();
      const req = {
        method: 'POST',
        url: '/route/departures',
        path: '/route/departures',
        originalUrl: '/router/route/departures',
        headers: { accept },
        query: {},
        body: {
          start: { latitude: 52, longitude: 4 },
          end: { latitude: 53, longitude: 5 },
          scanHours: 24,
          stepMinutes: 60,
        },
        on: () => req,
      };
      const res = {
        statusCode: 200,
        headersSent: false,
        header: () => res,
        setHeader: (k: string, v: string) => {
          headers[k] = v;
          return res;
        },
        getHeader: (k: string) => headers[k],
        on: (event: string, fn: () => void) => {
          if (event === 'close') closeHandler = fn;
          return res;
        },
        off: () => res,
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        write: (chunk: string) => {
          const obj = JSON.parse(chunk.trim());
          lines.push(obj);
          hooks.onWrite?.(obj, close);
          return true;
        },
        json: (body: unknown) => finish(body),
        send: (body: unknown) => finish(body),
        end: () => finish(),
      };
      (
        router as unknown as (
          q: unknown,
          s: unknown,
          n: (err?: unknown) => void,
        ) => void
      )(req, res, (err?: unknown) =>
        reject(err instanceof Error ? err : new Error('no handler reached')),
      );
    });
  }

  it('streams NDJSON when the client asks for it', async () => {
    const engine = stubEngine();
    const out = await scan(makeHandler(engine), 'application/x-ndjson');

    assert.match(out.contentType, /application\/x-ndjson/);
    const meta = out.lines[0];
    assert.strictEqual(meta.type, 'meta');
    assert.strictEqual(meta.steps, STEPS);
    assert.strictEqual(
      meta.departureTimes.length,
      STEPS,
      'every step is named up front, so the window can be drawn before any result exists',
    );
    const departures = out.lines.filter((l) => l.type === 'departure');
    assert.strictEqual(departures.length, STEPS);
    assert.strictEqual(out.lines[out.lines.length - 1].type, 'done');
  });

  it('carries an index on every result, because they are not in clock order', async () => {
    const engine = stubEngine();
    const out = await scan(makeHandler(engine), 'application/x-ndjson');
    const indices = out.lines
      .filter((l) => l.type === 'departure')
      .map((l) => l.index);

    assert.deepStrictEqual(
      [...indices].sort((a, b) => a - b),
      Array.from({ length: STEPS }, (_, i) => i),
      'every step arrives exactly once',
    );
    assert.notDeepStrictEqual(
      indices,
      Array.from({ length: STEPS }, (_, i) => i),
      'and not in clock order — coarse-to-fine is the point',
    );
    assert.strictEqual(indices[0], 0);
    assert.strictEqual(indices[1], STEPS - 1, 'both ends first');
  });

  it('stops calculating when the client goes away', async () => {
    const engine = stubEngine();
    const out = await scan(
      makeHandler(engine),
      'application/x-ndjson',
      // Hang up after the third departure, as closing the planner would.
      {
        onWrite: (obj, close) => {
          if (obj.type === 'departure' && engine.visited.length === 3) close();
        },
      },
    );

    assert.ok(
      engine.visited.length < STEPS,
      `scan stopped early (visited ${engine.visited.length} of ${STEPS})`,
    );
    assert.ok(
      out.lines.filter((l) => l.type === 'departure').length < STEPS,
      'and stopped writing',
    );
  });

  it('reports a mid-stream failure as a line, not a status code', async () => {
    // The status is committed with the first byte, so a later failure cannot be
    // a 4xx — the results already delivered stay good.
    const out = await scan(
      makeHandler(stubEngine({ failAt: 12 })),
      'application/x-ndjson',
    );
    assert.strictEqual(out.status, 200);
    const err = out.lines.find((l) => l.type === 'error');
    assert.ok(err, 'an error line was written');
    assert.match(err.error, /blew up/);
  });

  it('still answers with one JSON document when NDJSON is not requested', async () => {
    const out = await scan(makeHandler(stubEngine()), 'application/json');
    assert.strictEqual(out.lines.length, 0, 'nothing streamed');
    assert.strictEqual(out.json.departures.length, STEPS);
    assert.deepStrictEqual(
      out.json.departures.map((d: { index: number }) => d.index),
      Array.from({ length: STEPS }, (_, i) => i),
      'the batch response stays chronological',
    );
  });
});
