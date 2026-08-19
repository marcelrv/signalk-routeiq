/**
 * E2E UI validation for the SignalK RouteIQ frontend overhaul.
 * Runs against the live SignalK server (real routing data, Zeeland NL).
 *
 * Covers:
 *  1. page load + loading overlay dismissal
 *  2. settings panel: hamburger menu tabs (Routing / Advanced / View), switches
 *  3. left-click waypoint placement + auto-routing
 *  4. drag-on-route via insertion
 *  5. undo / redo (buttons + Ctrl+Z/Y)
 *  6. right-click context menu (set start/dest, escape/close)
 *  7. manual draw mode: toggle, manual leg request, dashed orange rendering
 *  8. clear-route confirmation dialog (cancel + confirm paths)
 *  9. mobile viewport: bottom-sheet layout + tap target sizes
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000/signalk-routeiq/';
const SHOTS = '/shots';

let failures = 0;
let passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

async function waitState(page, fn, timeout = 25000, label = 'state condition') {
  try {
    await page.waitForFunction(fn, null, { timeout });
    return true;
  } catch {
    console.log(`  (timeout waiting for: ${label})`);
    return false;
  }
}

// Open the settings panel on a given tab. The panel used to have its own edge
// tab (#settings-pane-tab); it is now reached through the hamburger menu, which
// both selects the tab and opens the panel.
async function openSettings(p, tab) {
  // With the panel already open the hamburger acts as a close button rather
  // than reopening the menu, so switching tabs takes a second click.
  await p.click('#settings-hamburger-btn');
  if (!(await p.isVisible('#settings-hamburger-menu.visible'))) {
    await p.click('#settings-hamburger-btn');
  }
  await p.click(`#settings-hamburger-menu .hamburger-item[data-tab="${tab}"]`);
}

async function closeSettings(p) {
  await p.click('#settings-close-btn');
}

// Click the map at a lat/lng by converting through Leaflet. The map may have
// auto-fitted to a route since the last action, so re-center on the target
// first to guarantee it is on-screen.
async function clickMapAt(page, lat, lng, button = 'left') {
  await page.evaluate(([la, ln]) => {
    globalThis.__marine.map.setView([la, ln], globalThis.__marine.map.getZoom(), { animate: false });
  }, [lat, lng]);
  await page.waitForTimeout(150);
  const pt = await page.evaluate(([la, ln]) => {
    const p = globalThis.__marine.map.latLngToContainerPoint([la, ln]);
    const r = globalThis.__marine.map.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [lat, lng]);
  await page.mouse.click(pt.x, pt.y, { button });
  return pt;
}

// Drag the route line to insert a via. A plain click on the route does nothing
// by design — onSegmentDragUp only inserts when the pointer actually moved
// (>5px), and suppressRouteClick stops the older click-to-add-via handler from
// firing, so dragging is the only left-button gesture that adds a via.
async function dragRouteAt(p, lat, lng, dLat = 0.004, dLng = 0) {
  await p.evaluate(([la, ln]) => {
    globalThis.__marine.map.setView([la, ln], globalThis.__marine.map.getZoom(), { animate: false });
  }, [lat, lng]);
  await p.waitForTimeout(150);
  const pts = await p.evaluate(([la, ln, dla, dln]) => {
    const m = globalThis.__marine.map;
    const r = m.getContainer().getBoundingClientRect();
    const a = m.latLngToContainerPoint([la, ln]);
    const b = m.latLngToContainerPoint([la + dla, ln + dln]);
    return { from: { x: r.left + a.x, y: r.top + a.y }, to: { x: r.left + b.x, y: r.top + b.y } };
  }, [lat, lng, dLat, dLng]);
  await p.mouse.move(pts.from.x, pts.from.y);
  await p.mouse.down();
  await p.mouse.move(pts.to.x, pts.to.y, { steps: 12 });
  await p.mouse.up();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => { failures++; console.log('  ✗ PAGE ERROR:', e.message); });

console.log('== 1. Load page ==');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
check('map + script booted', await waitState(page, () => globalThis.__marine && globalThis.__marine.map, 15000, 'window.__marine'));
check('loading overlay dismissed', await waitState(page, () => {
  const ov = globalThis.document.getElementById('loading-overlay');
  return ov && (ov.classList.contains('hidden') || ov.style.display === 'none');
}, 40000, 'loading overlay hidden'));
// Let the vessel-position auto-start (if any) land, then start clean
await page.waitForTimeout(3500);
await page.evaluate(() => {
  globalThis.__marine.map.setView([51.6615, 4.15], 13);
  // Expand the route pane so its toolbar (clear/undo/manual) is visible —
  // it starts collapsed until the first route is rendered.
  const pane = globalThis.document.getElementById('route-pane');
  if (pane.classList.contains('collapsed')) globalThis.document.getElementById('route-pane-tab').click();
});
await page.screenshot({ path: `${SHOTS}/01-desktop-initial.png` });

console.log('== 2. Settings panel: tabs + switches ==');
await page.click('#settings-hamburger-btn');
check('hamburger opens the menu', await page.isVisible('#settings-hamburger-menu.visible'));
await page.click('#settings-hamburger-menu .hamburger-item[data-tab="routing"]');
check('settings panel opens', await page.evaluate(() => !globalThis.document.getElementById('settings-panel').classList.contains('collapsed')));
check('menu closes once a tab is chosen', !(await page.isVisible('#settings-hamburger-menu.visible')));
check('routing tab shown, others hidden', await page.evaluate(() =>
  globalThis.document.getElementById('settings-tab-routing').style.display !== 'none' &&
  globalThis.document.getElementById('settings-tab-view').style.display === 'none'));
// The backend URL is not a routing parameter, so it lives under Advanced.
await openSettings(page, 'advanced');
check('backend URL field in advanced tab', await page.isVisible('#settings-tab-advanced #api-url'));
await openSettings(page, 'view');
check('view tab shows switches', await page.evaluate(() =>
  globalThis.document.getElementById('settings-tab-view').style.display !== 'none'));
check('graph toggle is styled switch', await page.evaluate(() => {
  const cb = globalThis.document.getElementById('graph-cb');
  return cb.closest('.switch-row') !== null;
}));
// toggle one switch on/off to prove interactivity
await page.click('#settings-tab-view .switch-row:first-child');
check('switch toggles on', await page.evaluate(() => globalThis.document.getElementById('graph-cb').checked));
await page.click('#settings-tab-view .switch-row:first-child');
await page.screenshot({ path: `${SHOTS}/02-settings-view-tab.png` });
await closeSettings(page);
check('close button collapses the panel', await page.evaluate(() =>
  globalThis.document.getElementById('settings-panel').classList.contains('collapsed')));

console.log('== 3. Waypoints by left click + auto route ==');
// Clear anything (e.g. vessel auto-start) first — exercises the confirm dialog
const hadRoute = await page.evaluate(() => !!(globalThis.__marine.state.startLatLng || globalThis.__marine.state.destLatLng));
if (hadRoute) {
  await page.click('#clear-btn');
  check('confirm dialog appears', await page.isVisible('#confirm-modal .confirm-box'));
  await page.click('#confirm-modal .confirm-yes');
  check('route cleared after confirm', await page.evaluate(() =>
    !globalThis.__marine.state.startLatLng && !globalThis.__marine.state.destLatLng));
}
await clickMapAt(page, 51.6612, 4.1349);
check('first click sets start', await page.evaluate(() => {
  const s = globalThis.__marine.state;
  return !!s.startLatLng && !s.destLatLng;
}));
await clickMapAt(page, 51.6615, 4.1670);
check('second click sets destination', await page.evaluate(() => !!globalThis.__marine.state.destLatLng));
check('route calculated', await waitState(page, () =>
  globalThis.__marine.state.lastGeoJson && globalThis.__marine.state.routeSegments.length > 0, 30000, 'route result'));
const autoSegs = await page.evaluate(() => globalThis.__marine.state.routeSegments.length);
check('route polylines rendered', autoSegs > 0, `segments=${autoSegs}`);
check('no manual segments in auto route', await page.evaluate(() =>
  globalThis.__marine.state.routeSegments.every(s => !s.isManual)));
await page.screenshot({ path: `${SHOTS}/03-auto-route.png` });

console.log('== 4. Drag on route inserts via ==');
// pick a point midway along the drawn route and drag it aside
const mid = await page.evaluate(() => {
  const segs = globalThis.__marine.state.routeSegments;
  const seg = segs[Math.floor(segs.length / 2)];
  const lls = seg.polyline.getLatLngs();
  const ll = lls[Math.floor(lls.length / 2)];
  return { lat: ll.lat, lng: ll.lng };
});
await clickMapAt(page, mid.lat, mid.lng);
check('clicking the route alone adds nothing', await page.evaluate(() =>
  globalThis.__marine.state.viaPoints.length === 0));
await dragRouteAt(page, mid.lat, mid.lng);
check('via inserted by dragging route', await waitState(page, () =>
  globalThis.__marine.state.viaPoints.length === 1, 10000, 'via added'));
await waitState(page, () => globalThis.__marine.state.routeSegments.length > 0, 30000, 'route recalc');

console.log('== 5. Undo / redo ==');
check('undo button enabled', await page.evaluate(() => !globalThis.document.getElementById('undo-btn').disabled));
await page.keyboard.press('Control+z');
check('Ctrl+Z removes via', await waitState(page, () =>
  globalThis.__marine.state.viaPoints.length === 0 && !!globalThis.__marine.state.destLatLng, 10000, 'undo'));
await page.keyboard.press('Control+y');
check('Ctrl+Y restores via', await waitState(page, () =>
  globalThis.__marine.state.viaPoints.length === 1, 10000, 'redo'));
await page.click('#undo-btn');
check('undo button removes via again', await waitState(page, () =>
  globalThis.__marine.state.viaPoints.length === 0, 10000, 'undo btn'));

console.log('== 6. Context menu ==');
await clickMapAt(page, 51.6700, 4.1500, 'right');
check('context menu opens on right-click', await page.isVisible('#map-context-menu.visible'));
const items = await page.evaluate(() =>
  [...globalThis.document.querySelectorAll('#map-context-menu .ctx-item')].map(el => el.textContent.trim()));
check('menu has set start/dest + via + manual + clear', items.some(t => /Set start/i.test(t)) &&
  items.some(t => /Set destination/i.test(t)) && items.some(t => /Add via/i.test(t)) &&
  items.some(t => /manual point/i.test(t)) && items.some(t => /Clear route/i.test(t)), JSON.stringify(items));
await page.keyboard.press('Escape');
check('Escape closes context menu', !(await page.isVisible('#map-context-menu.visible')));
// use menu to move the destination
await clickMapAt(page, 51.6660, 4.1690, 'right');
await page.click('#map-context-menu .ctx-item:has-text("Set destination here")');
check('context menu sets destination', await waitState(page, () => {
  const d = globalThis.__marine.state.destLatLng;
  return d && Math.abs(d.lat - 51.666) < 0.001;
}, 10000, 'dest moved'));
await waitState(page, () => globalThis.__marine.state.routeSegments.length > 0, 30000, 'route recalc after dest move');

console.log('== 7. Manual draw mode ==');
await page.click('#manual-btn');
check('manual button gets active state', await page.evaluate(() =>
  globalThis.document.getElementById('manual-btn').classList.contains('active')));
check('manual banner shown', await page.isVisible('#manual-banner.visible'));
await clickMapAt(page, 51.6760, 4.1760); // adds a manual via
check('click adds manual via', await waitState(page, () => {
  const s = globalThis.__marine.state;
  return s.viaPoints.length === 1 && s.viaModes[0] === 'manual';
}, 10000, 'manual via'));
check('route with manual leg calculated', await waitState(page, () => {
  const g = globalThis.__marine.state.lastGeoJson;
  return g && g.features && g.features.some(f => f.properties && f.properties.mode === 'manual');
}, 30000, 'manual feature in result'));
// Manual legs are dashed magenta (#d946ef); orange is the warning colour.
check('manual segment drawn dashed magenta', await page.evaluate(() => {
  const seg = globalThis.__marine.state.routeSegments.find(s => s.isManual);
  return !!seg && seg.originalStyle.color === '#d946ef' && !!seg.originalStyle.dashArray;
}));
check('auto segments still solid blue', await page.evaluate(() =>
  globalThis.__marine.state.routeSegments.some(s => !s.isManual && s.originalStyle.color === '#3b8fd4')));
await page.click('#manual-btn'); // off again
check('manual mode toggles off', await page.evaluate(() =>
  !globalThis.document.getElementById('manual-btn').classList.contains('active')));
await page.screenshot({ path: `${SHOTS}/04-manual-route.png` });

console.log('== 8. Clear route: cancel + confirm ==');
await page.click('#clear-btn');
check('confirm dialog shows', await page.isVisible('#confirm-modal.visible'));
await page.click('#confirm-modal .confirm-no');
check('cancel keeps the route', await page.evaluate(() => !!globalThis.__marine.state.startLatLng));
await page.click('#clear-btn');
await page.click('#confirm-modal .confirm-yes');
check('confirm clears the route', await page.evaluate(() =>
  !globalThis.__marine.state.startLatLng && !globalThis.__marine.state.destLatLng &&
  globalThis.__marine.state.viaPoints.length === 0));
await page.keyboard.press('Control+z');
check('clear is undoable', await waitState(page, () =>
  !!globalThis.__marine.state.startLatLng && !!globalThis.__marine.state.destLatLng, 15000, 'undo clear'));

console.log('== 8b. POI marker click: one popup, not two overlapping dialogs ==');
// Fresh page, like the mobile section below — eight sections of panning,
// waypoints and mode switches leave poiLayer holding markers accumulated
// (and possibly stale-positioned) across every viewport visited so far,
// which made "the first marker found" an unreliable, occasionally-wrong
// target on the shared page. A clean load removes that variable entirely.
const poiPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
poiPage.on('pageerror', (e) => { failures++; console.log('  ✗ POI PAGE ERROR:', e.message); });
await poiPage.goto(BASE, { waitUntil: 'domcontentloaded' });
await waitState(poiPage, () => globalThis.__marine && globalThis.__marine.map, 15000, 'poi page boot');
// POIs are off by default and only fetched for the current viewport.
await openSettings(poiPage, 'view');
if (!(await poiPage.evaluate(() => globalThis.document.getElementById('poi-cb').checked))) {
  await poiPage.click('#poi-cb');
}
await closeSettings(poiPage);
await poiPage.evaluate(() => globalThis.__marine.map.setView([51.4826, 3.8894], 13, { animate: false }));
const poiFound = await waitState(poiPage, () => {
  const layer = globalThis.__marine.poiLayer;
  if (!layer) return false;
  let n = 0;
  layer.eachLayer(() => n++);
  return n > 0;
}, 20000, 'a POI marker rendered');
check('at least one POI marker rendered', poiFound);
if (poiFound) {
  const poi = await poiPage.evaluate(() => {
    let ll = null, name = null;
    globalThis.__marine.poiLayer.eachLayer((m) => {
      if (!ll) { ll = m.getLatLng(); name = m.getTooltip() ? m.getTooltip().getContent() : ''; }
    });
    return { lat: ll.lat, lng: ll.lng, name };
  });
  await poiPage.evaluate(([la, ln]) => {
    globalThis.__marine.map.setView([la, ln], 16, { animate: false });
  }, [poi.lat, poi.lng]);
  // moveend debounces fetchPois() by 400ms (app.js) — this setView is
  // itself a move, so wait past that debounce before interacting. A real
  // user waits for the map to settle before clicking anyway; without this,
  // the debounced refetch can land mid-interaction, rebuild poiLayer, and
  // pop a tooltip on the freshly-created marker instance after this click
  // already closed the old one's — a real but separate race from the one
  // this section exists to catch, and not worth chasing here.
  await poiPage.waitForTimeout(500);
  const pt = await poiPage.evaluate(([la, ln]) => {
    const p = globalThis.__marine.map.latLngToContainerPoint([la, ln]);
    const r = globalThis.__marine.map.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [poi.lat, poi.lng]);
  // Hover first, like a real cursor arriving at the marker, then click
  // without moving away — the bound tooltip only hides on mouseout, so this
  // is the shape that reproduces it staying open under the popup. Matched
  // by this POI's own tooltip text, not just any .leaflet-tooltip on the
  // page, in case another one is bound nearby.
  const tooltipVisible = (name) =>
    [...globalThis.document.querySelectorAll('.leaflet-tooltip')]
      .some((el) => el.offsetParent !== null && el.textContent.includes(name));
  await poiPage.mouse.move(pt.x, pt.y);
  // Confirmed rather than assumed: without this, a hover that silently
  // fails to reproduce (wrong pixel, marker not yet interactive) would
  // still pass the "tooltip is gone" check below trivially — there'd be
  // nothing to have lingered in the first place.
  check('this POI\'s hover tooltip opened before the click', await poiPage
    .waitForFunction(tooltipVisible, poi.name, { timeout: 5000 })
    .then(() => true)
    .catch(() => false));
  const before = await poiPage.evaluate(() => JSON.stringify({
    start: globalThis.__marine.state.startLatLng, dest: globalThis.__marine.state.destLatLng,
    via: globalThis.__marine.state.viaPoints.length,
  }));
  await poiPage.mouse.click(pt.x, pt.y);
  await poiPage.waitForSelector('.poi-popup', { timeout: 5000 }).catch(() => {});
  // Exactly one, not just "at least one" — two POI popups stacked would be
  // the very bug this section exists to catch, just from a different cause
  // than the one already fixed.
  const popupCount = await poiPage.evaluate(() => globalThis.document.querySelectorAll('.poi-popup').length);
  check('exactly one POI popup (Route from/Route to) opened', popupCount === 1, `count=${popupCount}`);
  // Poll rather than a fixed sleep-then-snapshot: closeTooltip() triggers
  // Leaflet's own opacity-fade CSS transition, so the tooltip element can
  // still be present (mid-fade, offsetParent !== null) for a beat after the
  // click — a single timed check can catch that transient and misreport it
  // as lingering. What actually matters is that it settles closed and stays
  // that way, which this confirms by requiring it gone and re-checking
  // after a further pause rather than trusting one sample. waitState can't
  // be reused here — its evaluated function runs in the browser with no way
  // to pass poi.name in, so this calls page.waitForFunction directly.
  const tooltipGone = (name) =>
    ![...globalThis.document.querySelectorAll('.leaflet-tooltip')]
      .some((el) => el.offsetParent !== null && el.textContent.includes(name));
  const closedOnce = await poiPage
    .waitForFunction(tooltipGone, poi.name, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  await poiPage.waitForTimeout(300);
  const staysClosed = await poiPage.evaluate(tooltipGone, poi.name);
  check('this POI\'s hover tooltip does not linger under its own popup',
    closedOnce && staysClosed, `name=${JSON.stringify(poi.name)}`);
  const after = await poiPage.evaluate(() => JSON.stringify({
    start: globalThis.__marine.state.startLatLng, dest: globalThis.__marine.state.destLatLng,
    via: globalThis.__marine.state.viaPoints.length,
  }));
  check('click did not also place/change a waypoint via the map\'s own click handler',
    before === after, `before=${before} after=${after}`);
  await poiPage.screenshot({ path: `${SHOTS}/07-poi-popup.png` });
  await poiPage.keyboard.press('Escape');
}
await poiPage.close();

console.log('== 9. Mobile viewport ==');
const mob = await browser.newPage({ viewport: { width: 420, height: 800 }, hasTouch: true });
mob.on('pageerror', (e) => { failures++; console.log('  ✗ MOBILE PAGE ERROR:', e.message); });
await mob.goto(BASE, { waitUntil: 'domcontentloaded' });
await waitState(mob, () => globalThis.__marine && globalThis.__marine.map, 15000, 'mobile boot');
await waitState(mob, () => {
  const ov = globalThis.document.getElementById('loading-overlay');
  return ov && (ov.classList.contains('hidden') || ov.style.display === 'none');
}, 40000, 'mobile overlay');
await mob.waitForTimeout(2500);
await mob.evaluate(() => globalThis.__marine.map.setView([51.6615, 4.15], 13));
// open the route pane (tab button) and check it's a bottom sheet
await mob.click('#route-pane-tab');
await mob.waitForTimeout(450); // let the open transition finish
const paneBox = await mob.evaluate(() => {
  const r = globalThis.document.getElementById('route-pane').getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, bottom: r.bottom, vw: globalThis.innerWidth, vh: globalThis.innerHeight };
});
check('route pane is a full-width bottom sheet on mobile',
  paneBox.width >= paneBox.vw - 2 && Math.abs(paneBox.bottom - paneBox.vh) < 2, JSON.stringify(paneBox));
// tap target sizes
const tapOk = await mob.evaluate(() => {
  return [...globalThis.document.querySelectorAll('.route-toolbar .toolbar-btn')].every(b => {
    const r = b.getBoundingClientRect();
    return r.height >= 44 && r.width >= 40;
  });
});
check('toolbar buttons are >=44px tall on mobile', tapOk);
await mob.click('#route-pane-tab'); // close sheet
// settings slide-over
await openSettings(mob, 'routing');
const setBox = await mob.evaluate(() => {
  const r = globalThis.document.getElementById('settings-panel').getBoundingClientRect();
  return { top: r.top, right: r.right, height: r.height, vw: globalThis.innerWidth, vh: globalThis.innerHeight };
});
check('settings is a full-height slide-over on mobile',
  Math.abs(setBox.right - setBox.vw) < 2 && setBox.height >= setBox.vh - 2, JSON.stringify(setBox));
// Measure each tab while it is actually on screen. A .switch-row in a
// display:none tab has height 0, so querying the whole document at once tests
// nothing useful — the Charts tab holds one row per installed chart and those
// are exactly the rows a tap has to hit.
async function switchRowsAtLeast44(p, tab) {
  await openSettings(p, tab);
  await p.waitForTimeout(250);
  return p.evaluate((t) => {
    const rows = [...globalThis.document.querySelectorAll('#settings-tab-' + t + ' .switch-row')];
    const short = rows.filter((r) => r.getBoundingClientRect().height < 44);
    return {
      count: rows.length,
      short: short.length,
      worst: short.length ? Math.min(...short.map((r) => +r.getBoundingClientRect().height.toFixed(1))) : null,
    };
  }, tab);
}

const viewRows = await switchRowsAtLeast44(mob, 'view');
check('View switch rows are >=44px tall on mobile (coarse pointer)',
  viewRows.count > 0 && viewRows.short === 0, JSON.stringify(viewRows));
// Chart rows come from whatever the server has installed, so an empty list is
// legitimate here — but any row that does exist still has to be tappable.
const chartRows = await switchRowsAtLeast44(mob, 'charts');
check('Chart switch rows are >=44px tall on mobile (coarse pointer)',
  chartRows.short === 0, JSON.stringify(chartRows));
await openSettings(mob, 'view');
await mob.screenshot({ path: `${SHOTS}/05-mobile-settings.png` });
// Not #settings-close-btn: on a narrow viewport the fixed hamburger sits on
// top of the panel header and swallows the tap (see notes in README). The
// hamburger itself collapses an open panel, which is the reachable way out.
await mob.click('#settings-hamburger-btn');
await mob.screenshot({ path: `${SHOTS}/06-mobile-map.png` });

console.log(`\n== RESULT: ${passes} passed, ${failures} failed ==`);
await browser.close();
process.exit(failures > 0 ? 1 : 0);
