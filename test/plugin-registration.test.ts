import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { IRouter } from 'express';
import type { ServerAPI } from '@signalk/server-api';
import { pluginConstructor } from '../dist/index.js';

// Signal K registers the router of *every* installed plugin, enabled or not:
// doRegisterPlugin() calls registerWithRouter(router) and only afterwards does
// app.use('/plugins/<id>', router). A throw from registerWithRouter is
// swallowed by the server's own catch, so the mount never happens — and the
// router it drops is the one carrying the server's POST /plugins/<id>/config
// route. On a fresh install the plugin is present but still disabled, start()
// has never run, and dereferencing the not-yet-created ApiHandler here made the
// user's first config save answer 404 with nothing but a stack trace in the
// server log.
describe('plugin registration while still disabled', () => {
  /** Minimal express.Router stand-in that records the paths mounted on it. */
  function fakeRouter() {
    const mounted: string[] = [];
    const router = {
      get: () => router,
      use: (first: unknown) => {
        if (typeof first === 'string') mounted.push(first);
        return router;
      },
    };
    return { router: router as unknown as IRouter, mounted };
  }

  const app = {} as unknown as ServerAPI;

  it('mounts the API routes without start() having run', () => {
    const plugin = pluginConstructor(app);
    const { router, mounted } = fakeRouter();

    plugin.registerWithRouter(router);

    assert.ok(
      mounted.includes('/router'),
      `expected the API routes to be mounted at /router, got ${JSON.stringify(mounted)}`,
    );
  });

  it('mounts the Signal K API routes without start() having run', () => {
    const plugin = pluginConstructor(app);
    const { router, mounted } = fakeRouter();

    assert.strictEqual(plugin.signalKApiRoutes(router), router);
    assert.ok(
      mounted.includes('/router'),
      `expected the API routes to be mounted at /router, got ${JSON.stringify(mounted)}`,
    );
  });
});
