import assert from 'node:assert';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { IRouter, Router } from 'express';
import type { ServerAPI } from '@signalk/server-api';
import { pluginConstructor } from '../dist/index.js';

// Signal K calls stop() and then start() on every config save, and it does not
// reliably await stop() — the server-api docs only ask the plugin to *return* a
// promise. The API also fires hot reloads straight from Express handlers after a
// database download or delete. All three transitions rebuild the same
// module-level database/engine, so without serialization they interleave across
// their awaits: the teardown resuming after `await database.close()` would null
// out the components the *new* start() had just published, leaving the plugin
// permanently unready — /stats answering 503 right after a successful config
// save — and leaking one db-worker thread per superseded transition.
describe('plugin lifecycle serialization', () => {
  const dataDir = path.resolve('test/fixtures/zeelandbrug');

  /**
   * Signal K server stand-in. `use`/`registerResourceProvider` are the only
   * members the start path actually touches; the routing engine reads vessel
   * data through getSelfPath, which may legitimately return nothing.
   */
  function fakeApp() {
    return {
      use: () => undefined,
      registerResourceProvider: () => undefined,
      getSelfPath: () => undefined,
    } as unknown as ServerAPI;
  }

  /**
   * Capture the ApiHandler's own express Router, which the plugin mounts at
   * '/router'. Driving a request through it is the only outside view of whether
   * the plugin has published a live database and engine.
   */
  function captureApiRouter(plugin: {
    registerWithRouter(router: IRouter): void;
  }): Router {
    let captured: Router | null = null;
    const outer = {
      get: () => outer,
      use: (first: unknown, second: unknown) => {
        if (first === '/router') captured = second as Router;
        return outer;
      },
    };
    plugin.registerWithRouter(outer as unknown as IRouter);
    assert.ok(captured, 'expected the plugin to mount its API at /router');
    return captured;
  }

  /** GET /stats through the captured router; 503 until components are live. */
  function statsStatus(router: Router): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = {
        method: 'GET',
        url: '/stats',
        path: '/stats',
        originalUrl: '/router/stats',
        headers: {},
        query: {},
        body: {},
      };
      const res = {
        statusCode: 200,
        headersSent: false,
        // express Response members the API's own middleware reaches for
        header: () => res,
        setHeader: () => res,
        getHeader: () => undefined,
        sendStatus: (code: number) => {
          res.statusCode = code;
          resolve(code);
          return res;
        },
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        json: () => resolve(res.statusCode),
        send: () => resolve(res.statusCode),
        end: () => resolve(res.statusCode),
      };
      (
        router as unknown as (
          q: unknown,
          s: unknown,
          n: (err?: unknown) => void,
        ) => void
      )(req, res, (err?: unknown) => {
        // Reaching here means no handler answered — a broken fake, not a 503
        reject(
          err instanceof Error
            ? err
            : new Error(`GET /stats reached no handler: ${err ?? 'next()'}`),
        );
      });
    });
  }

  /** Live db-worker threads; a superseded transition that leaks one shows here. */
  function workerCount(): number {
    return process
      .getActiveResourcesInfo()
      .filter((r) => r === 'Worker' || r === 'Thread').length;
  }

  /**
   * Sample readiness until it holds the same value for `stable` consecutive
   * polls, so a transient "ready" that a late teardown then undoes cannot pass.
   */
  async function settledStatus(router: Router, deadlineMs = 20000) {
    const stable = 5;
    const deadline = Date.now() + deadlineMs;
    let last = -1;
    let repeats = 0;
    while (Date.now() < deadline) {
      const status = await statsStatus(router);
      repeats = status === last ? repeats + 1 : 0;
      last = status;
      if (repeats >= stable) return status;
      await new Promise((r) => setTimeout(r, 50));
    }
    return last;
  }

  it('ends a stop/start config save with live components, not a wiped plugin', async () => {
    const plugin = pluginConstructor(fakeApp());
    const router = captureApiRouter(plugin);
    const options = { routingDataDir: dataDir };

    // Exactly what the server does on a config save, including not awaiting
    // stop() before calling start() again.
    plugin.start(options);
    const stopped = plugin.stop();
    plugin.start(options);
    await stopped;

    assert.strictEqual(
      await settledStatus(router),
      200,
      'plugin must be ready after the final start(); a teardown resuming late had wiped the components it published',
    );

    await plugin.stop();
    assert.strictEqual(
      await settledStatus(router),
      503,
      'plugin must report unready once stopped',
    );
  });

  it('leaves no db-worker behind when a start is superseded', async () => {
    const plugin = pluginConstructor(fakeApp());
    const router = captureApiRouter(plugin);
    const options = { routingDataDir: dataDir };
    const before = workerCount();

    // Three initializations racing: only the last may end up owning a worker.
    plugin.start(options);
    plugin.start(options);
    plugin.start(options);
    assert.strictEqual(await settledStatus(router), 200);

    assert.ok(
      workerCount() <= before + 1,
      `expected at most one live db-worker, saw ${workerCount() - before} extra`,
    );

    // stop() must resolve only once teardown is complete, so no worker outlives it
    await plugin.stop();
    assert.strictEqual(
      workerCount(),
      before,
      'stop() must close every database it opened',
    );
  });
});
