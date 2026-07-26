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
  /**
   * Minimal express.Router stand-in that records what gets mounted on it.
   * `mounted` holds explicit path mounts; `handlers` counts path-less
   * middleware such as express.static(), which is how a UI would sneak back in
   * without ever naming a path.
   */
  function fakeRouter() {
    const mounted: string[] = [];
    const gets: string[] = [];
    const handlers: number[] = [];
    const router = {
      get: (first: unknown) => {
        if (typeof first === 'string') gets.push(first);
        return router;
      },
      use: (first: unknown) => {
        if (typeof first === 'string') mounted.push(first);
        else handlers.push(1);
        return router;
      },
    };
    return { router: router as unknown as IRouter, mounted, gets, handlers };
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

  // The server gates all of /plugins behind admin auth, so a UI served from
  // this router is invisible to read-only users. It was also broken for
  // admins: the page derives its API base from its own URL, so when served
  // from /plugins/signalk-routeiq/ it requested
  // /plugins/signalk-routeiq/signalk/v1/api/router/... and got a 404, because
  // this router mounts the API at ./router instead. The webapp belongs at
  // /<package-name>/, published by the signalk-webapp keyword.
  it('serves no UI from the plugin router — only the API', () => {
    const plugin = pluginConstructor(app);
    const { router, mounted, gets, handlers } = fakeRouter();

    plugin.registerWithRouter(router);

    assert.deepStrictEqual(
      gets,
      [],
      `expected no GET route on the plugin router, got ${JSON.stringify(gets)}`,
    );
    assert.deepStrictEqual(
      handlers,
      [],
      'expected no path-less middleware (e.g. express.static) on the plugin router',
    );
    assert.deepStrictEqual(
      mounted,
      ['/router'],
      `expected only the API to be mounted, got ${JSON.stringify(mounted)}`,
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
