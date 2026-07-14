/**
 * E2E UI validation for the SignalK RouteIQ frontend overhaul.
 * Runs against the live SignalK server (real routing data, Zeeland NL).
 *
 * Covers:
 *  1. page load + loading overlay dismissal
 *  2. settings panel: tabs (Routing / View), switch toggles
 *  3. left-click waypoint placement + auto-routing
 *  4. click-on-route via insertion
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

// Click the map at a lat/lng by converting through Leaflet. The map may have
// auto-fitted to a route since the last action, so re-center on the target
// first to guarantee it is on-screen.
async function clickMapAt(page, lat, lng, button = 'left') {
  await page.evaluate(([la, ln]) => {
    window.__marine.map.setView([la, ln], window.__marine.map.getZoom(), { animate: false });
  }, [lat, lng]);
  await page.waitForTimeout(150);
  const pt = await page.evaluate(([la, ln]) => {
    const p = window.__marine.map.latLngToContainerPoint([la, ln]);
    const r = window.__marine.map.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [lat, lng]);
  await page.mouse.click(pt.x, pt.y, { button });
  return pt;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => { failures++; console.log('  ✗ PAGE ERROR:', e.message); });

console.log('== 1. Load page ==');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
check('map + script booted', await waitState(page, () => window.__marine && window.__marine.map, 15000, 'window.__marine'));
check('loading overlay dismissed', await waitState(page, () => {
  const ov = document.getElementById('loading-overlay');
  return ov && (ov.classList.contains('hidden') || ov.style.display === 'none');
}, 40000, 'loading overlay hidden'));
// Let the vessel-position auto-start (if any) land, then start clean
await page.waitForTimeout(3500);
await page.evaluate(() => {
  window.__marine.map.setView([51.6615, 4.15], 13);
  // Expand the route pane so its toolbar (clear/undo/manual) is visible —
  // it starts collapsed until the first route is rendered.
  const pane = document.getElementById('route-pane');
  if (pane.classList.contains('collapsed')) document.getElementById('route-pane-tab').click();
});
await page.screenshot({ path: `${SHOTS}/01-desktop-initial.png` });

console.log('== 2. Settings panel: tabs + switches ==');
await page.click('#settings-pane-tab');
check('settings panel opens', await page.evaluate(() => !document.getElementById('settings-panel').classList.contains('collapsed')));
check('routing tab visible by default', await page.evaluate(() =>
  document.getElementById('settings-tab-routing').style.display !== 'none' &&
  document.getElementById('settings-tab-view').style.display === 'none'));
check('backend URL field in routing tab', await page.isVisible('#settings-tab-routing #api-url'));
await page.click('#settings-panel .panel-tab[data-tab="view"]');
check('view tab shows switches', await page.evaluate(() =>
  document.getElementById('settings-tab-view').style.display !== 'none'));
check('graph toggle is styled switch', await page.evaluate(() => {
  const cb = document.getElementById('graph-cb');
  return cb.closest('.switch-row') !== null;
}));
// toggle one switch on/off to prove interactivity
await page.click('#settings-tab-view .switch-row:first-child');
check('switch toggles on', await page.evaluate(() => document.getElementById('graph-cb').checked));
await page.click('#settings-tab-view .switch-row:first-child');
await page.screenshot({ path: `${SHOTS}/02-settings-view-tab.png` });
await page.click('#settings-pane-tab'); // collapse again

console.log('== 3. Waypoints by left click + auto route ==');
// Clear anything (e.g. vessel auto-start) first — exercises the confirm dialog
const hadRoute = await page.evaluate(() => !!(window.__marine.state.startLatLng || window.__marine.state.destLatLng));
if (hadRoute) {
  await page.click('#clear-btn');
  check('confirm dialog appears', await page.isVisible('#confirm-modal .confirm-box'));
  await page.click('#confirm-modal .confirm-yes');
  check('route cleared after confirm', await page.evaluate(() =>
    !window.__marine.state.startLatLng && !window.__marine.state.destLatLng));
}
await clickMapAt(page, 51.6612, 4.1349);
check('first click sets start', await page.evaluate(() => {
  const s = window.__marine.state;
  return !!s.startLatLng && !s.destLatLng;
}));
await clickMapAt(page, 51.6615, 4.1670);
check('second click sets destination', await page.evaluate(() => !!window.__marine.state.destLatLng));
check('route calculated', await waitState(page, () =>
  window.__marine.state.lastGeoJson && window.__marine.state.routeSegments.length > 0, 30000, 'route result'));
const autoSegs = await page.evaluate(() => window.__marine.state.routeSegments.length);
check('route polylines rendered', autoSegs > 0, `segments=${autoSegs}`);
check('no manual segments in auto route', await page.evaluate(() =>
  window.__marine.state.routeSegments.every(s => !s.isManual)));
await page.screenshot({ path: `${SHOTS}/03-auto-route.png` });

console.log('== 4. Click on route inserts via ==');
// pick a point midway along the drawn route and click exactly on it
const mid = await page.evaluate(() => {
  const segs = window.__marine.state.routeSegments;
  const seg = segs[Math.floor(segs.length / 2)];
  const lls = seg.polyline.getLatLngs();
  const ll = lls[Math.floor(lls.length / 2)];
  return { lat: ll.lat, lng: ll.lng };
});
await clickMapAt(page, mid.lat, mid.lng);
check('via inserted by clicking route', await waitState(page, () =>
  window.__marine.state.viaPoints.length === 1, 10000, 'via added'));
await waitState(page, () => window.__marine.state.routeSegments.length > 0, 30000, 'route recalc');

console.log('== 5. Undo / redo ==');
check('undo button enabled', await page.evaluate(() => !document.getElementById('undo-btn').disabled));
await page.keyboard.press('Control+z');
check('Ctrl+Z removes via', await waitState(page, () =>
  window.__marine.state.viaPoints.length === 0 && !!window.__marine.state.destLatLng, 10000, 'undo'));
await page.keyboard.press('Control+y');
check('Ctrl+Y restores via', await waitState(page, () =>
  window.__marine.state.viaPoints.length === 1, 10000, 'redo'));
await page.click('#undo-btn');
check('undo button removes via again', await waitState(page, () =>
  window.__marine.state.viaPoints.length === 0, 10000, 'undo btn'));

console.log('== 6. Context menu ==');
await clickMapAt(page, 51.6700, 4.1500, 'right');
check('context menu opens on right-click', await page.isVisible('#map-context-menu.visible'));
const items = await page.evaluate(() =>
  [...document.querySelectorAll('#map-context-menu .ctx-item')].map(el => el.textContent.trim()));
check('menu has set start/dest + via + manual + clear', items.some(t => /Set start/i.test(t)) &&
  items.some(t => /Set destination/i.test(t)) && items.some(t => /Add via/i.test(t)) &&
  items.some(t => /manual point/i.test(t)) && items.some(t => /Clear route/i.test(t)), JSON.stringify(items));
await page.keyboard.press('Escape');
check('Escape closes context menu', !(await page.isVisible('#map-context-menu.visible')));
// use menu to move the destination
await clickMapAt(page, 51.6660, 4.1690, 'right');
await page.click('#map-context-menu .ctx-item:has-text("Set destination here")');
check('context menu sets destination', await waitState(page, () => {
  const d = window.__marine.state.destLatLng;
  return d && Math.abs(d.lat - 51.666) < 0.001;
}, 10000, 'dest moved'));
await waitState(page, () => window.__marine.state.routeSegments.length > 0, 30000, 'route recalc after dest move');

console.log('== 7. Manual draw mode ==');
await page.click('#manual-btn');
check('manual button gets active state', await page.evaluate(() =>
  document.getElementById('manual-btn').classList.contains('active')));
check('manual banner shown', await page.isVisible('#manual-banner.visible'));
await clickMapAt(page, 51.6760, 4.1760); // adds a manual via
check('click adds manual via', await waitState(page, () => {
  const s = window.__marine.state;
  return s.viaPoints.length === 1 && s.viaModes[0] === 'manual';
}, 10000, 'manual via'));
check('route with manual leg calculated', await waitState(page, () => {
  const g = window.__marine.state.lastGeoJson;
  return g && g.features && g.features.some(f => f.properties && f.properties.mode === 'manual');
}, 30000, 'manual feature in result'));
check('manual segment drawn dashed orange', await page.evaluate(() => {
  const seg = window.__marine.state.routeSegments.find(s => s.isManual);
  return !!seg && seg.originalStyle.color === '#f97316' && !!seg.originalStyle.dashArray;
}));
check('auto segments still solid blue', await page.evaluate(() =>
  window.__marine.state.routeSegments.some(s => !s.isManual && s.originalStyle.color === '#3b8fd4')));
await page.click('#manual-btn'); // off again
check('manual mode toggles off', await page.evaluate(() =>
  !document.getElementById('manual-btn').classList.contains('active')));
await page.screenshot({ path: `${SHOTS}/04-manual-route.png` });

console.log('== 8. Clear route: cancel + confirm ==');
await page.click('#clear-btn');
check('confirm dialog shows', await page.isVisible('#confirm-modal.visible'));
await page.click('#confirm-modal .confirm-no');
check('cancel keeps the route', await page.evaluate(() => !!window.__marine.state.startLatLng));
await page.click('#clear-btn');
await page.click('#confirm-modal .confirm-yes');
check('confirm clears the route', await page.evaluate(() =>
  !window.__marine.state.startLatLng && !window.__marine.state.destLatLng &&
  window.__marine.state.viaPoints.length === 0));
await page.keyboard.press('Control+z');
check('clear is undoable', await waitState(page, () =>
  !!window.__marine.state.startLatLng && !!window.__marine.state.destLatLng, 15000, 'undo clear'));

console.log('== 9. Mobile viewport ==');
const mob = await browser.newPage({ viewport: { width: 420, height: 800 }, hasTouch: true });
mob.on('pageerror', (e) => { failures++; console.log('  ✗ MOBILE PAGE ERROR:', e.message); });
await mob.goto(BASE, { waitUntil: 'domcontentloaded' });
await waitState(mob, () => window.__marine && window.__marine.map, 15000, 'mobile boot');
await waitState(mob, () => {
  const ov = document.getElementById('loading-overlay');
  return ov && (ov.classList.contains('hidden') || ov.style.display === 'none');
}, 40000, 'mobile overlay');
await mob.waitForTimeout(2500);
await mob.evaluate(() => window.__marine.map.setView([51.6615, 4.15], 13));
// open the route pane (tab button) and check it's a bottom sheet
await mob.click('#route-pane-tab');
await mob.waitForTimeout(450); // let the open transition finish
const paneBox = await mob.evaluate(() => {
  const r = document.getElementById('route-pane').getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
});
check('route pane is a full-width bottom sheet on mobile',
  paneBox.width >= paneBox.vw - 2 && Math.abs(paneBox.bottom - paneBox.vh) < 2, JSON.stringify(paneBox));
// tap target sizes
const tapOk = await mob.evaluate(() => {
  return [...document.querySelectorAll('.route-toolbar .toolbar-btn')].every(b => {
    const r = b.getBoundingClientRect();
    return r.height >= 44 && r.width >= 40;
  });
});
check('toolbar buttons are >=44px tall on mobile', tapOk);
await mob.click('#route-pane-tab'); // close sheet
// settings slide-over
await mob.click('#settings-pane-tab');
const setBox = await mob.evaluate(() => {
  const r = document.getElementById('settings-panel').getBoundingClientRect();
  return { top: r.top, right: r.right, height: r.height, vw: window.innerWidth, vh: window.innerHeight };
});
check('settings is a full-height slide-over on mobile',
  Math.abs(setBox.right - setBox.vw) < 2 && setBox.height >= setBox.vh - 2, JSON.stringify(setBox));
const switchOk = await mob.evaluate(() => {
  document.querySelector('#settings-panel .panel-tab[data-tab="view"]').click();
  return [...document.querySelectorAll('.switch-row')].every(r => r.getBoundingClientRect().height >= 44);
});
check('switch rows are >=44px tall on mobile (coarse pointer)', switchOk);
await mob.screenshot({ path: `${SHOTS}/05-mobile-settings.png` });
await mob.click('#settings-pane-tab');
await mob.screenshot({ path: `${SHOTS}/06-mobile-map.png` });

console.log(`\n== RESULT: ${passes} passed, ${failures} failed ==`);
await browser.close();
process.exit(failures > 0 ? 1 : 0);
