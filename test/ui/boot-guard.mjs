/**
 * Boot-guard checks. Serves public/ statically (no SignalK backend needed) and
 * exercises the three ways startup can fail on an old or offline device:
 *
 *   1. a browser without AbortSignal.timeout   -> must still reach the retry loop
 *   2. an uncaught exception during startup     -> must surface on the overlay
 *   3. the unpkg.com map libraries unreachable  -> must name the failed URL
 *
 * Run (see README.md for the container invocation):
 *   node boot-guard.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.PUBLIC_DIR || '/public';
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const url = normalize(decodeURI(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  // Resolve to the real file before deriving the type: "/" has no extension,
  // and serving index.html as octet-stream makes Chromium download it instead
  // of rendering it (the navigation then fails with ERR_ABORTED).
  const path = url === '/' ? 'index.html' : url;
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
let failures = 0;

async function check(name, fn) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await fn(page);
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
  await ctx.close();
}

const overlayText = (page) => page.locator('#loading-overlay').innerText();

// 1. Old browser: no AbortSignal.timeout. Before the polyfill this threw
//    synchronously inside doConnect(), so the retry counter never appeared and
//    the overlay sat on "Initializing..." forever.
await check('no AbortSignal.timeout -> connect loop still runs', async (page) => {
  await page.addInitScript(() => {
    delete AbortSignal.timeout;
  });
  await page.goto(BASE);
  await page.waitForSelector('#loading-retry.visible', { timeout: 15000 });
  const text = await overlayText(page);
  if (!/Connecting\.\.\. \(\d+\)/.test(text)) {
    throw new Error(`expected a retry counter, overlay said: ${JSON.stringify(text)}`);
  }
});

// 2. An uncaught startup exception must land on the overlay, not just console.
await check('uncaught error -> shown on the overlay', async (page) => {
  await page.goto(BASE);
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('synthetic boot failure');
    }, 0);
  });
  await page.waitForSelector('#loading-error-detail:visible', { timeout: 5000 });
  const detail = await page.locator('#loading-error-detail').innerText();
  if (!detail.includes('synthetic boot failure')) {
    throw new Error(`message not surfaced: ${JSON.stringify(detail)}`);
  }
  if (!detail.includes('chrome://version')) {
    throw new Error('missing the browser-version hint');
  }
  if (!(await page.locator('#loading-dismiss').isVisible())) {
    throw new Error('no way out — dismiss button hidden');
  }
  await page.locator('#loading-dismiss').click();
  await page.waitForSelector('#loading-overlay', { state: 'hidden', timeout: 3000 });
});

// 3. Offline boat: every host except this server is unreachable. The map
//    libraries must be vendored, so the page has to come up regardless.
await check('fully offline -> map libraries still load', async (page) => {
  const blocked = [];
  await page.route('**', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    blocked.push(url);
    return route.abort();
  });
  await page.goto(BASE);
  await page.waitForSelector('#loading-retry.visible', { timeout: 15000 });

  const libs = await page.evaluate(() => ({
    leaflet: typeof window.L !== 'undefined',
    routing: !!(window.L && window.L.Routing),
    vectorgrid: !!(window.L && window.L.vectorGrid),
  }));
  for (const [name, ok] of Object.entries(libs)) {
    if (!ok) throw new Error(`${name} did not load offline (blocked: ${blocked.join(', ')})`);
  }
  // The globals existing is not enough — the app builds an L.Routing.control()
  // further down the same script, past the point where the connect timer is
  // registered, so a bundle that loads but misbehaves would still reach the
  // retry counter above. Any uncaught error lands on the overlay, so an empty
  // error box is the real proof the whole startup path ran.
  if (await page.locator('#loading-error-detail').isVisible()) {
    throw new Error(`startup error offline: ${await page.locator('#loading-error-detail').innerText()}`);
  }
  // Tiles are the one thing that legitimately needs the network.
  const nonTile = blocked.filter((u) => !/tile|openstreetmap|openseamap/i.test(u));
  if (nonTile.length) {
    throw new Error(`still reaching off-server for: ${nonTile.join(', ')}`);
  }
});

// 4. A vendored file missing from the install must be named, not swallowed.
await check('missing vendored file -> names it', async (page) => {
  await page.route('**/vendor/leaflet.js', (r) => r.abort());
  await page.goto(BASE);
  await page.waitForSelector('#loading-error-detail:visible', { timeout: 10000 });
  const detail = await page.locator('#loading-error-detail').innerText();
  if (!detail.includes('vendor/leaflet.js')) {
    throw new Error(`did not name the file: ${JSON.stringify(detail)}`);
  }
});

// 5. Static regression guard: no <script>/<link>/<img> may load from off-host.
//    Plain <a href> to openstreetmap.org and the like is fine — map attribution
//    has to link somewhere, and nothing is fetched until you tap it.
await check('no external assets referenced in index.html', async () => {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const bad = [];
  const re = /<(script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["'](?:https?:)?\/\/([^"'/]+)/gi;
  let m;
  while ((m = re.exec(html))) bad.push(`<${m[1].toLowerCase()}> ${m[2]}`);
  if (bad.length) throw new Error(`external asset(s): ${[...new Set(bad)].join(', ')}`);
});

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
