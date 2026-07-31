/**
 * Screenshot driver for RouteIQ docs / App Store listing.
 *
 * Drives the real UI against a running Signal K server with Playwright and
 * writes PNGs to OUT_DIR. Re-runnable: every shot re-derives its state from
 * the server, so there is no ordering dependency between shots except where
 * one is documented below.
 *
 * Usage (via scripts/screenshots.sh, which supplies the browser):
 *   ./scripts/screenshots.sh                    # all shots
 *   ./scripts/screenshots.sh webapp-route       # one or more by name
 *   ./scripts/screenshots.sh --list
 *
 * Environment:
 *   SK_URL       Signal K base URL            (default http://localhost:3000)
 *   SK_USERNAME  admin user  — required, the plugin API is behind auth
 *   SK_PASSWORD  admin password
 *   OUT_DIR      output directory             (default ./img)
 *   VIEWPORT     WxH                          (default 1600x1000)
 *   HEADED       set to 1 to watch the run
 */

import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const SK_URL = (process.env.SK_URL || 'http://localhost:3000').replace(/\/$/, '');
const SK_USERNAME = process.env.SK_USERNAME || '';
const SK_PASSWORD = process.env.SK_PASSWORD || '';
const OUT_DIR = process.env.OUT_DIR || 'img';
const [VW, VH] = (process.env.VIEWPORT || '1600x1000').split('x').map(Number);
// App Store screenshots must be JPEG, at most 1280x800, at most 500 KB. The
// 1600x1000 viewport shares 1280x800's 1.6 aspect, so width alone fixes both
// dimensions. Captured at 2x and supersampled down, which keeps chart labels
// and itinerary text legible at this size.
const OUT_WIDTH = Number(process.env.OUT_WIDTH || 1280);
const OUT_QUALITY = Number(process.env.OUT_QUALITY || 82);
const MAX_BYTES = 500 * 1024;

const ROUTEIQ_APP = `${SK_URL}/signalk-routeiq/`;
const FREEBOARD_APP = `${SK_URL}/@signalk/freeboard-sk/`;
const API = `${SK_URL}/plugins/signalk-routeiq/router`;

// Route used for the Zeeland shots. Both are POIs the offline search index
// knows, so we can drive the search box instead of synthesising map clicks at
// hardcoded pixel positions. Spell them exactly as the index does — it has
// "Oude Tonge", not "Oude-Tonge", and a hyphen returns zero results.
const ROUTE = { start: 'Oude Tonge', dest: 'Zierikzee' };

// Tide shot: a Westerschelde passage long enough for the tidal model to bite.
// The reference image used Krammersluis → Oostende, but the POI index is
// IENC-derived and Dutch-only — Oostende, Zeebrugge and Nieuwpoort all return
// zero hits — so this ends at Vlissingen, in the same tidal waters.
const TIDE_ROUTE = { fromLat: 51.66137945, fromLon: 4.15217585, dest: 'Vlissingen' };

// Plugin-panel shot: same Krammersluizen origin, routed to the Oosterschelde
// barrier lock at Roompot — the offline POI index has no marina named exactly
// "Roompot Marina", but this is the nearest named approach to it.
const PLUGIN_ROUTE = { dest: 'Roompotsluis' };

// ── helpers ──────────────────────────────────────────────────────────

const log = (...a) => console.log('[shots]', ...a);

/**
 * Log in and return the cookies, so both the page and our own API calls are
 * authenticated. Signal K sets a JWT cookie and also returns the raw token.
 */
async function login(request) {
  if (!SK_USERNAME || !SK_PASSWORD) {
    throw new Error(
      'SK_USERNAME / SK_PASSWORD are required — the Signal K server has security ' +
      'enabled, and /plugins/signalk-routeiq/* answers 401 without a login.',
    );
  }
  const res = await request.post(`${SK_URL}/signalk/v1/auth/login`, {
    data: { username: SK_USERNAME, password: SK_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(`login failed (${res.status()}): ${await res.text()}`);
  }
  log('authenticated as', SK_USERNAME);
  return (await res.json()).token;
}

/** Wait out the RouteIQ boot overlay (database load) before shooting. */
async function appReady(page, timeout = 90_000) {
  await page.waitForSelector('#map', { timeout });
  await page
    .waitForSelector('#loading-overlay', { state: 'hidden', timeout })
    .catch(() => log('warning: loading overlay still visible, continuing'));
  // Leaflet tile settle — no event for "all tiles painted", so a short beat.
  await page.waitForTimeout(2500);
}

/**
 * Clear any route left over from a previous run (the app restores its last
 * route from local storage), so each shot starts from the same state.
 */
async function resetRoute(page) {
  // #clear-btn lives in the route pane, which starts collapsed when there is
  // no complete route — so open the pane first or the click silently misses.
  // Clearing matters beyond tidiness: it resets state.waypointNext to 'start',
  // without which the two search picks land in swapped slots.
  if (!(await page.isVisible('#clear-btn').catch(() => false))) {
    await page.click('#route-pane-tab').catch(() => {});
    await page.waitForTimeout(600);
  }
  await page.click('#clear-btn', { force: true }).catch(() => {});
  // Clearing a non-empty route raises a confirm dialog whose backdrop swallows
  // every later click until it is answered.
  const yes = page.locator('#confirm-modal .confirm-yes');
  if (await yes.isVisible().catch(() => false)) await yes.click();
  await page.waitForTimeout(800);
}

/** Open the hamburger menu, which holds Manage Routing Data and the settings tabs. */
async function openMenu(page) {
  const expanded = await page
    .getAttribute('#settings-hamburger-btn', 'aria-expanded')
    .catch(() => null);
  if (expanded !== 'true') await page.click('#settings-hamburger-btn');
  await page.waitForSelector('#settings-hamburger-menu', { state: 'visible', timeout: 15_000 });
}

/**
 * Set one route endpoint via the offline POI search. The first selection
 * becomes the start, the second the destination (state.waypointNext flips on
 * each pick), so call this exactly twice in order.
 */
async function pickViaSearch(page, query) {
  if (!(await page.isVisible('#search-input').catch(() => false))) {
    await page.click('#search-icon').catch(() => {});
  }
  await page.fill('#search-input', '');
  await page.type('#search-input', query, { delay: 40 });
  await page.waitForSelector('#search-results .search-result-item', { timeout: 20_000 });
  await page.click('#search-results .search-result-item >> nth=0');
  log('picked', query);
  await page.waitForTimeout(1200);
}

/** Plan Oude Tonge → Zierikzee and wait for the route pane to fill in. */
async function planZeelandRoute(page, attempt = 0) {
  await pickViaSearch(page, ROUTE.start);
  await pickViaSearch(page, ROUTE.dest);
  await page.waitForSelector('#route-summary', { state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(2500);

  // If the app happened to be mid-cycle (waypointNext === 'dest') the picks
  // land swapped and the route runs backwards. Detect it from the pane and
  // redo once rather than shipping a reversed screenshot.
  const startText = ((await page.textContent('#start-info')) || '').toLowerCase();
  if (!startText.includes(ROUTE.start.toLowerCase()) && attempt === 0) {
    log(`start is "${startText.trim()}", expected ${ROUTE.start} — redoing`);
    await resetRoute(page);
    return planZeelandRoute(page, 1);
  }
}

async function shoot(page, name) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.jpg`);
  const raw = await page.screenshot();

  // Step the quality down if the first encode overshoots the 500 KB cap, so a
  // busy chart can't quietly ship an oversized asset.
  let out;
  let quality = OUT_QUALITY;
  for (;;) {
    out = await sharp(raw)
      .resize({ width: OUT_WIDTH, withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= MAX_BYTES || quality <= 55) break;
    quality -= 7;
  }

  await fs.writeFile(file, out);
  const { width, height } = await sharp(out).metadata();
  const kb = Math.round(out.length / 1024);
  log(`wrote ${file} (${width}x${height}, q${quality}, ${kb} KB)${kb > 500 ? ' OVER 500 KB' : ''}`);
}

/** POST to the RouteIQ API with the logged-in context. */
async function api(request, route, data) {
  const res = await request.post(`${API}${route}`, { data });
  const body = await res.text();
  if (!res.ok()) log(`warning: POST ${route} → ${res.status()} ${body}`);
  return { ok: res.ok(), body };
}

/** Installed databases, as reported by the plugin. */
async function listDatabases(request) {
  const res = await request.get(`${API}/databases`);
  if (!res.ok()) throw new Error(`GET /databases → ${res.status()}`);
  return await res.json();
}

/** Find an installed database whose filename/name contains `needle`. */
function matchDb(dbs, needle) {
  const list = Array.isArray(dbs) ? dbs : (dbs.databases ?? dbs.installed ?? []);
  const hit = list.find((d) =>
    `${d.filename ?? ''} ${d.name ?? ''}`.toLowerCase().includes(needle),
  );
  return hit?.filename ?? null;
}

/**
 * Freeboard opens at world zoom with the vessel at 0°/0° when the server has
 * no GPS source. Publish a position delta so the chart, and the panel's
 * "route from vessel" actions, have somewhere real to work from.
 */
async function setVesselPosition(page, latitude, longitude) {
  await page.evaluate(
    ({ latitude, longitude }) =>
      new Promise((resolve) => {
        const url = location.origin.replace(/^http/, 'ws') + '/signalk/v1/stream?subscribe=none';
        const ws = new WebSocket(url);
        const done = () => { try { ws.close(); } catch { /* already closed */ } resolve(); };
        ws.onopen = () => {
          ws.send(JSON.stringify({
            updates: [{
              $source: 'routeiq-screenshots',
              values: [{ path: 'navigation.position', value: { latitude, longitude } }],
            }],
          }));
          setTimeout(done, 1200);
        };
        ws.onerror = done;
        setTimeout(done, 5000);
      }),
    { latitude, longitude },
  );
  log(`published position ${latitude}, ${longitude}`);
}

/** Open the RouteIQ panel inside Freeboard-SK and return its iframe handle. */
async function openRouteIqInFreeboard(page) {
  await page.goto(FREEBOARD_APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000); // Freeboard boot + chart load

  // The plugin registers a plotterExtensions button (id 'open-routeiq', slot
  // 'mapToolbar', icon 'alt_route'). Freeboard renders it as a Material
  // icon-font button with no title or aria-label, so the icon ligature *is*
  // the button's text — match on that rather than on "RouteIQ".
  const button = page.locator('button', { hasText: /^alt_route$/ }).first();
  await button.click({ timeout: 30_000 });
  await page.waitForTimeout(3000);

  // Panel is served at /plotterext/signalk-routeiq/panel.html.
  const frame = page.frameLocator('iframe[src*="panel.html"]');
  await frame.locator('#main').waitFor({ timeout: 90_000 });
  await page.waitForTimeout(4000);
  return frame;
}

// ── shots ────────────────────────────────────────────────────────────

const SHOTS = {
  /** 1. Standalone webapp with a planned route through Zeeland. */
  'webapp-route': async ({ page }) => {
    await page.goto(ROUTEIQ_APP, { waitUntil: 'domcontentloaded' });
    await appReady(page);
    await resetRoute(page);
    await planZeelandRoute(page);
    await shoot(page, 'webapp-route');
  },

  /**
   * 2. Departure planner mid-scan, which is the frame worth showing: every hour
   * of the window is already listed, and the handful that have been calculated
   * are spread across the whole day rather than bunched at the start — that is
   * the coarse-to-fine order, and the reason the answer is legible long before
   * the scan ends. Caught deliberately in flight, so the placeholder rows, the
   * progress count and the Cancel button are all in shot.
   */
  'webapp-departures': async ({ page, request }) => {
    await page.goto(ROUTEIQ_APP, { waitUntil: 'domcontentloaded' });
    await appReady(page);
    await resetRoute(page);

    // Take the endpoints off the app's own route request rather than reaching
    // into its internals — page.evaluate cannot see the script's top-level
    // bindings, and the pane only shows place names.
    let planned = null;
    const grabPayload = (r) => {
      if (r.method() !== 'POST' || !/\/route$/.test(new URL(r.url()).pathname)) return;
      try { planned = JSON.parse(r.postData() || 'null'); } catch { /* not ours */ }
    };
    page.on('request', grabPayload);
    try {
      await planZeelandRoute(page);
    } finally {
      page.off('request', grabPayload);
    }
    if (!planned?.start || !planned?.end) throw new Error('could not read the planned route endpoints');

    // The planner lives behind the tide toggle, which is off unless the plugin
    // is configured to consider tides by default.
    if (!(await page.isChecked('#tide-cb'))) {
      await page.click('#tide-cb');
      await page.waitForSelector('#route-summary', { state: 'visible', timeout: 60_000 });
      await page.waitForTimeout(1500);
    }
    // Aim the window rather than taking whatever the clock happens to say. Tide
    // is a ~12.4 h cycle sampled here at 6 h, so what the first few results show
    // depends entirely on the phase the window opens at: measured on this route,
    // a good start reveals the full 35-minute spread within five results and a
    // bad one reveals six minutes of it. The phase drifts ~50 min a day, so a
    // hardcoded clock time would only be right on the day it was chosen.
    //
    // Start at the *slowest* departure of the next 24 h, which is the honest
    // version of what the planner is for: the first row is what leaving now
    // costs, and a departure most of an hour quicker turns up a few rows down.
    const probe = await request.post(`${API}/route/departures`, {
      data: {
        start: planned.start, end: planned.end,
        useTides: true, scanHours: 24, stepMinutes: 60,
      },
    });
    if (!probe.ok()) throw new Error(`departure probe failed (${probe.status()})`);
    const scored = (await probe.json()).departures.filter((d) => typeof d.totalSeconds === 'number');
    if (scored.length < 2) throw new Error('departure probe returned nothing to rank');
    const slowest = scored.reduce((a, b) => (b.totalSeconds > a.totalSeconds ? b : a));
    const fastest = scored.reduce((a, b) => (b.totalSeconds < a.totalSeconds ? b : a));
    log(`probe: ${(slowest.totalSeconds / 3600).toFixed(2)} h worst vs ` +
        `${(fastest.totalSeconds / 3600).toFixed(2)} h best — ` +
        `${Math.round((slowest.totalSeconds - fastest.totalSeconds) / 60)} min apart`);

    // Typed through the real input so it registers as a chosen departure; set
    // straight onto .value it would be treated as untouched and reset to now.
    // The string has to be in the browser's own timezone, so build it there.
    await page.fill('#departure-time', await page.evaluate((iso) => {
      const d = new Date(iso);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }, slowest.departureTime));
    await page.waitForTimeout(1200); // the edit triggers a reroute

    await page.waitForSelector('#best-departure-btn', { state: 'visible', timeout: 20_000 });
    await page.click('#best-departure-btn');
    await page.waitForSelector('#departure-modal', { state: 'visible', timeout: 20_000 });

    // Poll rather than sleep: a step is well under a second, so a fixed wait
    // either catches an empty list or a finished one depending on the machine.
    const target = 5;
    let caught = null;
    for (let i = 0; i < 400; i++) {
      const s = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#dep-list > div')];
        return {
          rows: rows.length,
          filled: rows.filter((d) => !d.textContent.includes('·')).length,
          running: document.getElementById('dep-cancel')?.style.display !== 'none',
        };
      });
      if (s.rows && s.filled >= target && s.filled < s.rows) { caught = s; break; }
      if (s.rows && !s.running) { caught = s; break; } // finished before we looked
      await page.waitForTimeout(40);
    }
    if (!caught || caught.filled >= caught.rows) {
      log(`warning: scan finished before ${target}/25 could be caught — shot shows a completed window`);
    } else {
      log(`caught the scan at ${caught.filled}/${caught.rows}`);
    }
    await shoot(page, 'webapp-departures');
  },

  /** 3. Download manager, Installed tab (the map view of what is on disk). */
  'download-manager': async ({ page }) => {
    await page.goto(ROUTEIQ_APP, { waitUntil: 'domcontentloaded' });
    await appReady(page);
    await openMenu(page); // Manage Routing Data lives in the hamburger menu
    await page.click('#manage-data-btn');
    await page.waitForSelector('#data-manager-modal', { state: 'visible', timeout: 30_000 });
    // #dm-tab-installed is the pane, not the control — click the tab button.
    await page.click('.dm-tab[data-tab="installed"]');
    await page
      .waitForSelector('#dm-installed-loading', { state: 'hidden', timeout: 60_000 })
      .catch(() => {});
    await page.waitForSelector('#dm-installed-list', { state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(3500); // #dm-minimap tiles (shared by both tabs)
    // Deliberately left unscrolled. The installed list is in server order, so
    // the loaded Zeeland entry sits below the fold — but scrolling it into
    // view pushes #dm-minimap off the top entirely, and the coverage map is
    // the point of this shot. The map already shows which region is installed:
    // Zeeland is outlined in green.
    await shoot(page, 'download-manager');
  },

  /** 4. Freeboard-SK with the RouteIQ plotter-extension panel open. */
  'freeboard-plugin': async ({ page }) => {
    // Freeboard opens at world zoom (0°/0°) when the server has no GPS source
    // — give it a real origin near the Oosterschelde barrier before opening
    // the panel.
    await page.goto(FREEBOARD_APP, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await setVesselPosition(page, TIDE_ROUTE.fromLat, TIDE_ROUTE.fromLon);

    const frame = await openRouteIqInFreeboard(page);

    // 'zoom_in_map' is a sticky Freeboard toggle that Signal K persists per
    // user, not a fit-to-route button, and while it is on it keeps overriding
    // map.center — leaving the chart at world zoom. Clear it first if set.
    const fitToggle = page.locator('button', { hasText: /^zoom_in_map$/ }).first();
    // count() first: evaluate() against a missing element waits out the whole
    // default timeout before the catch below can turn it into "not set".
    const fitToggleOn = (await fitToggle.count()) > 0
      && await fitToggle.evaluate((el) => el.classList.contains('mat-primary')
        || el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor.includes('59, 130'))
        .catch(() => false);
    if (fitToggleOn) {
      await fitToggle.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Route from the vessel to the Roompotsluis approach — a real leg gives a
    // more representative shot than a bare POI, and framing the whole leg
    // (rather than "Show"'s street-level zoom 14) is the point of this shot.
    await frame.locator('#poi-query').fill(PLUGIN_ROUTE.dest);
    await frame.locator('#poi-go').click();
    await frame.locator('#poi-results li').first().waitFor({ timeout: 30_000 });
    await frame.locator('#poi-results li').first()
      .getByRole('button', { name: 'Route' }).click();
    // Not swallowed: a route that never completes has to fail the shot (the
    // runner logs it and captures <name>.FAILED) instead of quietly
    // photographing an empty panel and passing.
    await frame.locator('#summary').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2500);

    await frame.locator('#poi-query').fill(PLUGIN_ROUTE.dest);
    await frame.locator('#poi-go').click();
    await frame.locator('#poi-results li').first().waitFor({ timeout: 30_000 });
    await frame.locator('#poi-results li').first()
      .getByRole('button', { name: 'Show' }).click().catch(() => {});
    await page.waitForTimeout(2000);
    for (let i = 0; i < 3; i++) {
      await page.locator('button', { hasText: /^remove$/ }).first().click().catch(() => {});
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(3000);

    await shoot(page, 'freeboard-plugin');
  },

  /**
   * 5. Freeboard-SK with tide-aware planning.
   *
   * Needs the Europe database loaded and the Zeeland one unloaded, so the
   * route spans enough water for the tidal model to matter. Both are done
   * over the API first; this shot therefore changes server state and leaves
   * Europe loaded when it finishes.
   */
  'freeboard-tides': async ({ page, request }) => {
    // Load whichever installed region covers the Dutch delta. Deliberately not
    // europe.sqlite: the Routing Data Manager renders a region's description
    // and tags verbatim, and that region carries upstream provenance text that
    // must not end up in the published App Store listing. Keep these shots on
    // a region whose metadata is safe to show.
    const dbs = await listDatabases(request);
    const region = matchDb(dbs, 'zeeland');
    if (region) await api(request, '/databases/load', { filename: region });
    else log('warning: no Zeeland database installed — the route may not resolve');

    // Park the vessel at the Krammersluizen so "route from vessel to…" has a
    // real origin; the dev server has no GPS source and reports 0°/0°.
    await page.goto(FREEBOARD_APP, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await setVesselPosition(page, TIDE_ROUTE.fromLat, TIDE_ROUTE.fromLon);

    const frame = await openRouteIqInFreeboard(page);

    // Tide planning on before routing, so the calculation is tide-aware.
    const tide = frame.locator('#tide-cb');
    if (!(await tide.isChecked().catch(() => false))) {
      await tide.check({ timeout: 15_000 }).catch(() => log('warning: could not tick #tide-cb'));
    }
    await page.waitForTimeout(1500);

    // Route from the vessel down the Oosterschelde/Westerschelde.
    await frame.locator('#poi-query').fill(TIDE_ROUTE.dest);
    await frame.locator('#poi-go').click();
    await frame.locator('#poi-results li').first().waitFor({ timeout: 30_000 });
    await frame.locator('#poi-results li').first().getByRole('button', { name: 'Route' }).click();
    // Neither wait is swallowed: this shot exists to show a completed tidal
    // route and its departure scan, so if either never arrives the shot is
    // wrong and must fail rather than pass with an empty panel.
    await frame.locator('#summary').waitFor({ timeout: 120_000 });
    await page.waitForTimeout(4000);

    // The departure scan is the colour-coded ETA list in the panel.
    await frame.locator('#btn-departures').click();
    await frame.locator('#dep-list').waitFor({ timeout: 120_000 });
    await page.waitForTimeout(5000);

    // Frame the chart via the panel's map.center ("Show" centres at zoom 14,
    // too tight for a 70 km passage, so back out four steps).
    //
    // 'zoom_in_map' is a sticky Freeboard toggle that Signal K persists per
    // user, not a fit-to-route button, and while it is on it keeps overriding
    // map.center — leaving the chart at world zoom. Clear it first if set,
    // otherwise this whole block silently does nothing.
    const fitToggle = page.locator('button', { hasText: /^zoom_in_map$/ }).first();
    // count() first: evaluate() against a missing element waits out the whole
    // default timeout before the catch below can turn it into "not set".
    const fitToggleOn = (await fitToggle.count()) > 0
      && await fitToggle.evaluate((el) => el.classList.contains('mat-primary')
        || el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor.includes('59, 130'))
        .catch(() => false);
    if (fitToggleOn) {
      await fitToggle.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    await frame.locator('#poi-query').fill(TIDE_ROUTE.dest);
    await frame.locator('#poi-go').click();
    await frame.locator('#poi-results li').first().waitFor({ timeout: 30_000 });
    await frame.locator('#poi-results li').first()
      .getByRole('button', { name: 'Show' }).click().catch(() => {});
    await page.waitForTimeout(2500);
    for (let i = 0; i < 4; i++) {
      await page.locator('button', { hasText: /^remove$/ }).first().click().catch(() => {});
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(5000); // chart tiles
    // Searching scrolls the panel down to the POI results; scroll back so the
    // tide toggle and the departure scan are what the shot actually shows.
    await frame.locator('#main').evaluate((el) => {
      el.scrollTop = 0;
      el.ownerDocument.defaultView.scrollTo(0, 0);
      el.ownerDocument.documentElement.scrollTop = 0;
    }).catch(() => {});
    await page.waitForTimeout(1500);
    await shoot(page, 'freeboard-tides');
  },
};

// ── main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--list')) {
  console.log(Object.keys(SHOTS).join('\n'));
  process.exit(0);
}
const wanted = args.length ? args : Object.keys(SHOTS);
const unknown = wanted.filter((n) => !SHOTS[n]);
if (unknown.length) {
  console.error(`unknown shot(s): ${unknown.join(', ')}\nknown: ${Object.keys(SHOTS).join(', ')}`);
  process.exit(2);
}

const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 2, // crisp on HiDPI / GitHub
  ignoreHTTPSErrors: true,
});

let failures = 0;
try {
  await login(context.request);
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && log('page error:', m.text()));

  for (const name of wanted) {
    log(`── ${name}`);
    try {
      await SHOTS[name]({ page, context, request: context.request });
    } catch (err) {
      failures++;
      console.error(`[shots] FAILED ${name}: ${err.message}`);
      await shoot(page, `${name}.FAILED`).catch(() => {});
    }
  }
} finally {
  await context.close();
  await browser.close();
}

log(failures ? `done with ${failures} failure(s)` : 'done');
process.exit(failures ? 1 : 0);
