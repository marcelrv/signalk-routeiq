import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { Router } from 'express';
import { ServerAPI } from '@signalk/server-api';
import { ApiHandler } from '../dist/api.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

// The autoload/disabled switch and its interaction with delete. A database is
// addressed by its plain .sqlite name in *both* states, so every filesystem
// path in the API has to consider the .disabled form too — the delete handler
// originally did not, and answered 404 for anything switched off.
describe('installed-database autoload/disabled API', () => {
  function makeHandler(dataDir: string): Router {
    const app = {
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      getSelfPath: () => undefined,
    } as unknown as ServerAPI;
    const handler = new ApiHandler(
      { ...DEFAULT_CONFIG, routingDataDir: dataDir },
      app,
    );
    // No RoutingDatabase: these endpoints are filesystem-level, and leaving
    // `db` unset also proves they don't depend on a loaded engine.
    return handler.getRouter();
  }

  /** Drive one authenticated POST through the router. */
  function post(
    router: Router,
    url: string,
    body: unknown,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = {
        method: 'POST',
        url,
        path: url,
        originalUrl: '/router' + url,
        headers: {},
        query: {},
        body,
        skIsAuthenticated: true,
        skPrincipal: { identifier: 'test', permissions: 'admin' },
      };
      const res = {
        statusCode: 200,
        headersSent: false,
        header: () => res,
        setHeader: () => res,
        getHeader: () => undefined,
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        json: (b: unknown) => resolve({ status: res.statusCode, body: b }),
        send: (b: unknown) => resolve({ status: res.statusCode, body: b }),
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
            : new Error(`POST ${url} reached no handler: ${err ?? 'next()'}`),
        ),
      );
    });
  }

  function tempDir(tag: string): string {
    const dir = path.resolve(`./test/fixtures/switch-api-${tag}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('deletes a disabled database (regression: 404 while the file sat on disk)', async () => {
    const dir = tempDir('delete-disabled');
    const disabled = path.join(dir, 'region.sqlite.disabled');
    fs.writeFileSync(disabled, 'not a real database, never opened');
    try {
      const res = await post(makeHandler(dir), '/databases/delete', {
        filename: 'region.sqlite',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      assert.equal(fs.existsSync(disabled), false, 'file must be gone from disk');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes an enabled database, and still 404s when neither form exists', async () => {
    const dir = tempDir('delete-enabled');
    const active = path.join(dir, 'region.sqlite');
    fs.writeFileSync(active, 'not a real database, never opened');
    try {
      const router = makeHandler(dir);
      const ok = await post(router, '/databases/delete', {
        filename: 'region.sqlite',
      });
      assert.equal(ok.status, 200);
      assert.equal(fs.existsSync(active), false);

      const missing = await post(router, '/databases/delete', {
        filename: 'region.sqlite',
      });
      assert.equal(missing.status, 404);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes both forms when a download has left a disabled twin behind', async () => {
    const dir = tempDir('delete-both');
    const active = path.join(dir, 'region.sqlite');
    const disabled = active + '.disabled';
    fs.writeFileSync(active, 'a');
    fs.writeFileSync(disabled, 'b');
    try {
      const res = await post(makeHandler(dir), '/databases/delete', {
        filename: 'region.sqlite',
      });
      assert.equal(res.status, 200);
      assert.equal(fs.existsSync(active), false);
      assert.equal(fs.existsSync(disabled), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('switches a database off and back on by renaming it', async () => {
    const dir = tempDir('switch');
    const active = path.join(dir, 'region.sqlite');
    const disabled = active + '.disabled';
    fs.writeFileSync(active, 'not a real database, never opened');
    try {
      const router = makeHandler(dir);

      const off = await post(router, '/databases/enabled', {
        filename: 'region.sqlite',
        enabled: false,
      });
      assert.equal(off.status, 200, JSON.stringify(off.body));
      assert.equal(fs.existsSync(active), false);
      assert.equal(fs.existsSync(disabled), true);

      const on = await post(router, '/databases/enabled', {
        filename: 'region.sqlite',
        enabled: true,
      });
      assert.equal(on.status, 200);
      assert.equal(fs.existsSync(active), true);
      assert.equal(fs.existsSync(disabled), false);

      // Already in the requested state — a no-op, not an error.
      const again = await post(router, '/databases/enabled', {
        filename: 'region.sqlite',
        enabled: true,
      });
      assert.equal(again.status, 200);
      assert.equal(again.body.unchanged, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to switch when both forms exist, and guards the filename', async () => {
    const dir = tempDir('guards');
    fs.writeFileSync(path.join(dir, 'region.sqlite'), 'a');
    fs.writeFileSync(path.join(dir, 'region.sqlite.disabled'), 'b');
    try {
      const router = makeHandler(dir);
      const clash = await post(router, '/databases/enabled', {
        filename: 'region.sqlite',
        enabled: false,
      });
      assert.equal(clash.status, 409);
      assert.match(clash.body.error, /Both/);

      const traversal = await post(router, '/databases/enabled', {
        filename: '../escape.sqlite',
        enabled: false,
      });
      assert.equal(traversal.status, 400);

      const missing = await post(router, '/databases/enabled', {
        filename: 'nope.sqlite',
        enabled: true,
      });
      assert.equal(missing.status, 404);

      const noFlag = await post(router, '/databases/enabled', {
        filename: 'region.sqlite',
      });
      assert.equal(noFlag.status, 400);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
