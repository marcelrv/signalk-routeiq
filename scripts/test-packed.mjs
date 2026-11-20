// Packed-plugin test (`npm run test:packed`, after `npm run build`).
//
// The plugin is bundled with its workspace package routeiq-core inlined, and
// routeiq-core is never published. This proves the package that npm would
// ship works on its own: pack it, install the tarball into an empty directory
// (no workspace, no repo node_modules on the resolution path), then start the
// installed plugin against a copy of the Zeelandbrug fixture and route once.
// That start also proves dist/db-worker.js is found next to the bundled
// index.js at the installed location.
//
// Needs registry access (the tarball's own dependencies are installed) and
// `--experimental-sqlite` on Node 22 (set by the npm script).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'routeiq-packed-'));
const packDir = join(work, 'pack');
const installDir = join(work, 'install');
const dataDir = join(work, 'data');

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/** Minimal Signal K app: only what the start path touches. */
function fakeApp() {
  return {
    use: () => undefined,
    registerResourceProvider: () => undefined,
    getSelfPath: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  };
}

/** Capture the plugin's API router, which it mounts at '/router'. */
function captureRouter(plugin) {
  let captured = null;
  const outer = {
    get: () => outer,
    use: (first, second) => {
      if (first === '/router') captured = second;
      return outer;
    },
  };
  plugin.registerWithRouter(outer);
  assert.ok(captured, 'plugin did not mount its API router at /router');
  return captured;
}

/** Drive one request through the router without HTTP; resolves { status, body }. */
function call(router, method, url, body = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url, path: url, originalUrl: `/router${url}`, headers: {}, query: {}, body };
    const res = {
      statusCode: 200,
      headersSent: false,
      header: () => res,
      setHeader: () => res,
      getHeader: () => undefined,
      sendStatus: (code) => resolve({ status: code, body: undefined }),
      status(code) {
        res.statusCode = code;
        return res;
      },
      json: (b) => resolve({ status: res.statusCode, body: b }),
      send: (b) => resolve({ status: res.statusCode, body: b }),
      end: () => resolve({ status: res.statusCode, body: undefined }),
    };
    router(req, res, (err) =>
      reject(err instanceof Error ? err : new Error(`${method} ${url} reached no handler`)),
    );
  });
}

async function waitFor(fn, what, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

let plugin = null;
let failed = false;
try {
  console.log('1. npm pack');
  cpSync(join(repo, 'test/fixtures/zeelandbrug'), dataDir, { recursive: true });
  run('mkdir', ['-p', packDir, installDir], work);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDir], repo));
  const tarball = join(packDir, packed[0].filename);
  const files = packed[0].files.map((f) => f.path);
  assert.ok(files.includes('dist/index.js'), 'tarball lacks dist/index.js');
  assert.ok(files.includes('dist/db-worker.js'), 'tarball lacks dist/db-worker.js');
  assert.ok(
    !files.some((f) => f.startsWith('packages/') || f.includes('node_modules/routeiq-core')),
    'tarball contains packages/ or node_modules/routeiq-core',
  );
  console.log(`   ${packed[0].filename}: ${files.length} files`);

  console.log('2. install the tarball into an empty directory');
  run('npm', ['init', '-y'], installDir);
  run('npm', ['install', tarball, '--no-audit', '--no-fund'], installDir);
  const pluginRoot = join(installDir, 'node_modules', 'signalk-routeiq');
  const installed = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.ok(
      !(installed[field] && 'routeiq-core' in installed[field]),
      `installed package.json lists routeiq-core under ${field}`,
    );
  }
  assert.ok(!existsAt(join(installDir, 'node_modules', 'routeiq-core')), 'routeiq-core was installed');

  console.log('3. import and start the installed plugin');
  const mod = await import(pathToFileURL(join(pluginRoot, 'dist', 'index.js')).href);
  assert.equal(typeof mod.pluginConstructor, 'function', 'no named pluginConstructor export');
  assert.equal(mod.default, mod.pluginConstructor, 'default export is not pluginConstructor');
  plugin = mod.pluginConstructor(fakeApp());
  const router = captureRouter(plugin);
  plugin.start({ routingDataDir: dataDir });

  await waitFor(async () => (await call(router, 'GET', '/stats')).status === 200, 'plugin to become ready');
  console.log('   database loaded, plugin ready');

  console.log('4. route through the plugin API');
  const { status, body } = await call(router, 'POST', '/route', {
    start: { latitude: 51.613, longitude: 3.885 },
    end: { latitude: 51.609, longitude: 3.896 },
    minCoastDistance: 0,
  });
  assert.equal(status, 200, `POST /route answered ${status}: ${JSON.stringify(body)}`);
  assert.ok(body?.features?.length > 0, 'route has no features');
  assert.ok(body.totalDistance > 0, 'route has no distance');
  console.log(`   route: ${body.features.length} segments, ${Math.round(body.totalDistance)} m`);

  console.log('5. stop');
  await plugin.stop();
  plugin = null;
  console.log('OK');
} catch (err) {
  failed = true;
  console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
} finally {
  try {
    await plugin?.stop();
  } catch {
    /* already failing or stopped */
  }
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

function existsAt(p) {
  try {
    readFileSync(join(p, 'package.json'));
    return true;
  } catch {
    return false;
  }
}
