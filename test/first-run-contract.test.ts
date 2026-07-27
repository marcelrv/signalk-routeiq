import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { IRouter, Router } from 'express';
import type { ServerAPI } from '@signalk/server-api';
import { pluginConstructor } from '../dist/index.js';

// First run: the plugin is installed and enabled but no routing database has
// been downloaded yet, so init fails with "No .sqlite files found ...". The web
// UI has to be able to discover that state and send the user to the Data
// Manager — it cannot do that through an endpoint that is gated on the routing
// engine being ready, because on a first run it never becomes ready.
//
// This is why the UI probes /databases/status rather than /stats. It used to
// probe /stats, which answers 503 here forever, so the UI sat on "Loading
// Routing Data / Waiting for server..." and never reached the code that offers
// the download manager. These tests pin the contract both ways round.
describe('first-run API contract with no databases installed', () => {
  const emptyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeiq-empty-'));
  after(() => fs.rmSync(emptyDataDir, { recursive: true, force: true }));

  function fakeApp() {
    return {
      use: () => undefined,
      registerResourceProvider: () => undefined,
      getSelfPath: () => undefined,
    } as unknown as ServerAPI;
  }

  /** Capture the ApiHandler's own express Router, mounted by the plugin at '/router'. */
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

  /** Drive one GET through the router, returning the status and parsed body. */
  function get(
    router: Router,
    url: string,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = {
        method: 'GET',
        url,
        path: url,
        originalUrl: '/router' + url,
        headers: {},
        query: {},
        body: {},
      };
      const res = {
        statusCode: 200,
        headersSent: false,
        header: () => res,
        setHeader: () => res,
        getHeader: () => undefined,
        sendStatus: (code: number) => {
          resolve({ status: code, body: undefined });
          return res;
        },
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        json: (body: unknown) => resolve({ status: res.statusCode, body }),
        send: (body: unknown) => resolve({ status: res.statusCode, body }),
        end: () => resolve({ status: res.statusCode, body: undefined }),
      };
      (
        router as unknown as (
          q: unknown,
          s: unknown,
          n: (err?: unknown) => void,
        ) => void
      )(req, res, (err?: unknown) =>
        reject(
          err instanceof Error
            ? err
            : new Error(`GET ${url} reached no handler: ${err ?? 'next()'}`),
        ),
      );
    });
  }

  /** Poll until the failed init has been reported, so the assertions are not racing it. */
  async function waitForInitError(router: Router, deadlineMs = 20000) {
    const deadline = Date.now() + deadlineMs;
    let last: { status: number; body: any } = { status: 0, body: undefined };
    while (Date.now() < deadline) {
      last = await get(router, '/databases/status');
      if (last.body && last.body.initError) return last;
      await new Promise((r) => setTimeout(r, 50));
    }
    return last;
  }

  it('reports the empty install over /databases/status with a 200, not a 503', async () => {
    const plugin = pluginConstructor(fakeApp());
    const router = captureApiRouter(plugin);
    plugin.start({ routingDataDir: emptyDataDir });

    try {
      const { status, body } = await waitForInitError(router);

      // A 503 here is what broke first run: the UI could not read the reason.
      assert.strictEqual(
        status,
        200,
        '/databases/status must answer 200 so the UI can read initError',
      );
      assert.match(
        body.initError,
        /no \.sqlite/i,
        'the reason must say no databases are installed, which is what the UI matches on to open the Data Manager',
      );
      assert.deepStrictEqual(body.filenames, []);
      assert.strictEqual(body.available, 0);
      assert.strictEqual(body.loaded, false);
    } finally {
      await plugin.stop();
    }
  });

  it('still answers 503 on /stats, which is why it cannot be the connectivity probe', async () => {
    const plugin = pluginConstructor(fakeApp());
    const router = captureApiRouter(plugin);
    plugin.start({ routingDataDir: emptyDataDir });

    try {
      // Assert the precondition rather than assuming it: waitForInitError()
      // returns whether or not the error arrived, so without this a startup that
      // merely stalled would also leave /stats at 503 and pass this test for the
      // wrong reason.
      const { body } = await waitForInitError(router);
      assert.match(
        (body && body.initError) || '',
        /no \.sqlite/i,
        'precondition: startup must have failed because no databases are installed',
      );

      const { status } = await get(router, '/stats');
      assert.strictEqual(
        status,
        503,
        '/stats is gated on a loaded graph; a UI that waits for it never gets past first run',
      );
    } finally {
      await plugin.stop();
    }
  });
});
