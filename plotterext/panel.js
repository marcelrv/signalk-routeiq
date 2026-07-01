/**
 * Autoroute panel — Freeboard-SK plotter extension.
 *
 * The host chartplotter renders the chart and owns the route edit buffer;
 * this panel only supplies geometry. Flow: read the visible route's points
 * (first = start, last = destination, middle = via), ask the server-side
 * routing engine for a safe path, hand back the engine's simplified
 * `waypoints` with route.replace (staged, unsaved), and render the engine's
 * `itinerary` (major turns, legs, crossings). All simplification and leg
 * aggregation happens server-side — this file only renders.
 */
import { connectExtension } from './bus/extension.js';

const API = '/signalk/v1/api/router';
const POI_TYPES = ['harbour', 'lock', 'bridge', 'fairway', 'waterway'];
const CROSSING_COLORS = { lock: '#f59e0b', fixed: '#ef4444', opening: '#22c55e' };

const $ = (id) => document.getElementById(id);

let client = null;
let routes = [];               // visible set from route.list
let selectedId = null;
let busy = false;
let engineReady = false;
let cfg = { averageSpeedKnots: 6, defaultCoastDistance: 0.5 };
let units = { distance: 'naut-mile' };
// Per-route calculation session:
//   requestPoints — the user's original start/via/end (survives re-calcs)
//   generated     — the points we last wrote with route.replace
//   revertPoints  — the points before our first replace (for Revert)
const sessions = new Map();

init().catch((e) => {
  $('unsupported').style.display = 'block';
  $('unsupported').textContent = 'Failed to connect to the chartplotter: ' + (e?.message || e);
});

async function init() {
  client = await connectExtension();

  if (!client.hasCapability('routes')) {
    $('unsupported').style.display = 'block';
    return;
  }
  $('main').style.display = 'block';

  // Non-fatal extras: plugin config (avg speed, coast distance default),
  // display units, engine status, waypoint list.
  await Promise.allSettled([
    fetch(API + '/config').then((r) => r.json()).then((c) => { cfg = { ...cfg, ...c }; }),
    client.hasCapability('units')
      ? client.call('units.get').then((r) => { units = { ...units, ...r.units }; })
      : Promise.resolve(),
  ]);
  await checkEngine();
  loadWaypoints();

  await client.subscribe(['route.**'], onRouteEvent);
  await refreshRoutes();

  $('route-select').addEventListener('change', () => {
    selectedId = $('route-select').value || null;
    renderRouteState();
  });
  $('route-refresh').addEventListener('click', () => { checkEngine(); loadWaypoints(); refreshRoutes(); });
  $('btn-calc').addEventListener('click', () => run(calculate));
  $('btn-revert').addEventListener('click', () => run(revert));
  $('btn-save').addEventListener('click', () => run(save));
  $('btn-dest').addEventListener('click', () => run(routeToDestination));
  $('btn-wp').addEventListener('click', () => run(routeToWaypoint));
  $('wp-select').addEventListener('change', () => { $('btn-wp').disabled = !$('wp-select').value; });
  $('poi-go').addEventListener('click', () => run(searchPois));
  $('poi-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(searchPois); });
}

/* ---------- routing engine status ---------- */

async function checkEngine() {
  const el = $('engine-status');
  try {
    const st = await fetch(API + '/databases/status').then((r) => r.json());
    if (st.initError) {
      engineReady = false;
      el.className = 'status error';
      el.textContent = 'Routing engine error: ' + st.initError;
    } else if (!st.loaded) {
      engineReady = false;
      el.className = 'status';
      el.textContent = 'Routing database loading…';
    } else {
      engineReady = true;
      el.className = 'status ok';
      el.textContent = 'Routing engine ready (' + (st.filenames || []).join(', ') + ')';
    }
  } catch (e) {
    engineReady = false;
    el.className = 'status error';
    el.textContent = 'Autoroute plugin not reachable: ' + (e?.message || e);
  }
  renderRouteState();
}

/* ---------- visible route set ---------- */

async function onRouteEvent(name, params) {
  if (name === 'route.hidden' && params?.routeId) {
    sessions.delete(params.routeId);
  }
  if (name === 'route.saved' && params?.routeId === selectedId) {
    setStatus('route-status', 'Saved as “' + (params.name || 'route') + '”', 'ok');
  }
  await refreshRoutes(name === 'route.visible' ? params?.routeId : undefined);
}

async function refreshRoutes(autoSelectId) {
  try {
    const res = await client.call('route.list');
    routes = res.routes || [];
  } catch {
    routes = [];
  }
  const sel = $('route-select');
  sel.innerHTML = '';
  if (!routes.length) {
    sel.appendChild(new Option('— no route on the chart —', ''));
    selectedId = null;
  } else {
    for (const r of routes) {
      const label = (r.name || 'Unnamed route') +
        ' (' + r.pointCount + ' pts' + (r.dirty ? ', unsaved' : '') + ')';
      sel.appendChild(new Option(label, r.routeId));
    }
    if (autoSelectId && routes.some((r) => r.routeId === autoSelectId)) {
      selectedId = autoSelectId;
    } else if (!routes.some((r) => r.routeId === selectedId)) {
      selectedId = routes[routes.length - 1].routeId; // most recent
    }
    sel.value = selectedId;
  }
  renderRouteState();
}

function selectedRoute() {
  return routes.find((r) => r.routeId === selectedId) || null;
}

function renderRouteState() {
  const r = selectedRoute();
  const info = $('route-info');
  if (!r) {
    info.textContent = '';
  } else {
    info.innerHTML = '';
    info.append(r.pointCount + ' waypoints');
    const badge = document.createElement('span');
    badge.className = 'badge' + (r.dirty ? ' dirty' : '');
    badge.textContent = r.dirty ? 'unsaved changes' : (r.saved ? 'saved' : 'draft');
    info.appendChild(badge);
  }
  $('btn-calc').disabled = busy || !r || !engineReady;
  $('btn-revert').disabled = busy || !r || !sessions.get(selectedId)?.revertPoints;
  $('btn-save').disabled = busy || !r || !(r.dirty || !r.saved);
  $('btn-dest').disabled = busy || !engineReady;
  $('btn-wp').disabled = busy || !engineReady || !$('wp-select').value;
}

/* ---------- actions ---------- */

async function run(fn) {
  if (busy) return;
  busy = true;
  renderRouteState();
  try {
    await fn();
  } catch (e) {
    const reason = e?.data?.reason || e?.reason;
    if (reason === 'routes.saveCancelled') {
      setStatus('route-status', 'Save cancelled', '');
    } else {
      setStatus('route-status', e?.message || String(e), 'error');
    }
  } finally {
    busy = false;
    renderRouteState();
  }
}

function samePoints(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const EPS = 1e-7;
  return a.every((p, i) =>
    Math.abs(p.position[0] - b[i].position[0]) < EPS &&
    Math.abs(p.position[1] - b[i].position[1]) < EPS);
}

async function calculate() {
  const r = selectedRoute();
  if (!r) return;
  setStatus('route-status', 'Calculating route…', '');
  hideSummary();

  const routeId = r.routeId;
  const { points } = await client.call('route.get', { routeId });

  // Re-running on a route we generated: reuse the user's original
  // start/via/end instead of treating every generated waypoint as a via.
  const session = sessions.get(routeId);
  const requestPoints = (session && samePoints(points, session.generated))
    ? session.requestPoints
    : points;

  const toLatLon = (p) => ({ latitude: p.position[1], longitude: p.position[0] });
  // Coast distance, safety margins etc. come from the plugin settings —
  // the server applies its configured defaults when they are omitted here.
  const body = {
    start: toLatLon(requestPoints[0]),
    end: toLatLon(requestPoints[requestPoints.length - 1]),
    via: requestPoints.slice(1, -1).map(toLatLon),
  };

  const resp = await fetch(API + '/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await resp.json();
  if (!resp.ok) {
    throw new Error(result.error || ('Routing failed (' + resp.status + ')'));
  }

  // The engine returns simplified, navigable waypoints (bounded deviation
  // from the computed path). Fall back to raw geometry for older servers.
  const coords = (result.waypoints || []).map((w) => [w.longitude, w.latitude]);
  if (coords.length < 2) {
    for (const f of result.features || []) {
      for (const c of f.geometry?.coordinates || []) {
        const last = coords[coords.length - 1];
        if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
      }
    }
  }
  if (coords.length < 2) throw new Error('Routing engine returned no usable geometry');

  const newPoints = coords.map(([lon, lat]) => ({ position: [lon, lat] }));
  // Keep the user's start/end waypoint names on the reshaped route.
  const first = requestPoints[0], last = requestPoints[requestPoints.length - 1];
  if (first.name) newPoints[0].name = first.name;
  if (last.name) newPoints[newPoints.length - 1].name = last.name;

  sessions.set(routeId, {
    requestPoints,
    generated: newPoints,
    revertPoints: session?.revertPoints ?? points,
  });
  await client.call('route.replace', { routeId, points: newPoints });

  setStatus('route-status', 'Route updated on the chart — review and Save to keep it.', 'ok');
  renderSummary(result);
}

async function revert() {
  const session = sessions.get(selectedId);
  if (!session?.revertPoints) return;
  await client.call('route.replace', { routeId: selectedId, points: session.revertPoints });
  sessions.delete(selectedId);
  hideSummary();
  setStatus('route-status', 'Original waypoints restored (still unsaved).', '');
}

async function save() {
  const r = selectedRoute();
  if (!r) return;
  // dialog:true → the host prompts for name/description (its Route Details
  // dialog in Freeboard-SK) and persists through the user's session.
  await client.call('route.save', { routeId: r.routeId, dialog: true });
}

/* ---------- route creation ---------- */

async function createAndCalculate(name, destination, destName) {
  const pos = await vesselPosition();
  const { routeId } = await client.call('route.create', {
    name,
    points: [
      { position: [pos.longitude, pos.latitude], name: 'Start' },
      { position: [destination.longitude, destination.latitude], name: destName || 'Destination' },
    ],
  });
  selectedId = routeId;
  await refreshRoutes(routeId);
  await calculate();
}

async function routeToDestination() {
  const dest = await activeDestination();
  if (!dest) {
    setStatus('route-status', 'No active destination — set one first (e.g. “Navigate to here” on the chart).', 'error');
    return;
  }
  await createAndCalculate('Autoroute to destination', dest, 'Destination');
  // The route now covers the trip; drop the direct "Navigate to here" course
  // so the chart doesn't show both. (The host offers no context-menu hook for
  // extensions, so this is the closest to a one-step "auto-route to here".)
  const cleared = await clearActiveDestination();
  if (cleared) {
    setStatus('route-status',
      'Route created and active destination cleared — review and Save to keep it.', 'ok');
  }
}

async function clearActiveDestination() {
  try {
    const resp = await fetch('/signalk/v2/api/vessels/self/navigation/course', { method: 'DELETE' });
    return resp.ok;
  } catch {
    return false;
  }
}

async function activeDestination() {
  // v2 course API (what Freeboard's "Go to"/course activation writes)
  try {
    const course = await fetch('/signalk/v2/api/vessels/self/navigation/course').then((r) => r.ok ? r.json() : null);
    const p = course?.nextPoint?.position;
    if (typeof p?.latitude === 'number' && typeof p?.longitude === 'number') return p;
  } catch { /* fall through */ }
  // v1 fallback
  try {
    const p = await fetch('/signalk/v1/api/vessels/self/navigation/courseGreatCircle/nextPoint/position/value')
      .then((r) => r.ok ? r.json() : null);
    if (typeof p?.latitude === 'number' && typeof p?.longitude === 'number') return p;
  } catch { /* fall through */ }
  return null;
}

async function loadWaypoints() {
  try {
    const wps = await fetch('/signalk/v2/api/resources/waypoints').then((r) => r.ok ? r.json() : {});
    const sel = $('wp-select');
    const current = sel.value;
    sel.innerHTML = '';
    sel.appendChild(new Option('Waypoint…', ''));
    const entries = Object.entries(wps || {})
      .map(([id, wp]) => {
        const c = wp?.feature?.geometry?.coordinates;
        if (!Array.isArray(c)) return null;
        return { id, name: wp.name || wp?.feature?.properties?.name || 'Unnamed', lon: c[0], lat: c[1] };
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const w of entries) {
      const opt = new Option(w.name, w.id);
      opt.dataset.lat = w.lat;
      opt.dataset.lon = w.lon;
      sel.appendChild(opt);
    }
    sel.value = current && entries.some((w) => w.id === current) ? current : '';
    $('wp-row').style.display = entries.length ? '' : 'none';
  } catch {
    $('wp-row').style.display = 'none';
  }
}

async function routeToWaypoint() {
  const sel = $('wp-select');
  const opt = sel.selectedOptions[0];
  if (!opt?.value) return;
  const dest = { latitude: parseFloat(opt.dataset.lat), longitude: parseFloat(opt.dataset.lon) };
  await createAndCalculate('To ' + opt.textContent, dest, opt.textContent);
}

async function vesselPosition() {
  const resp = await fetch('/signalk/v1/api/vessels/self/navigation/position/value');
  if (!resp.ok) throw new Error('No vessel position available');
  const pos = await resp.json();
  if (typeof pos?.latitude !== 'number' || typeof pos?.longitude !== 'number') {
    throw new Error('No vessel position available');
  }
  return pos;
}

/* ---------- POI search ---------- */

async function searchPois() {
  const q = $('poi-query').value.trim();
  const list = $('poi-results');
  list.innerHTML = '';
  setStatus('poi-status', '', '');
  if (!q) return;
  const resp = await fetch(API + '/search?q=' + encodeURIComponent(q) + '&limit=15');
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Search failed');
  if (!data.results?.length) {
    setStatus('poi-status', 'No matches for “' + q + '”', '');
    return;
  }
  for (const poi of data.results) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = poi.name || 'Unnamed';
    name.title = (POI_TYPES[poi.typeId] || 'poi') + ' — ' + poi.name;
    li.appendChild(name);

    if (client.hasCapability('map')) {
      const show = document.createElement('button');
      show.textContent = 'Show';
      show.addEventListener('click', () =>
        run(() => client.call('map.center', { position: [poi.longitude, poi.latitude], zoom: 14 })));
      li.appendChild(show);
    }
    const routeTo = document.createElement('button');
    routeTo.textContent = 'Route';
    routeTo.addEventListener('click', () =>
      run(() => createAndCalculate('To ' + (poi.name || 'destination'),
        { latitude: poi.latitude, longitude: poi.longitude }, poi.name)));
    li.appendChild(routeTo);

    list.appendChild(li);
  }
}

/* ---------- result summary + itinerary ---------- */

function renderSummary(result) {
  const distM = result.totalDistance || 0;
  const speed = cfg.averageSpeedKnots > 0 ? cfg.averageSpeedKnots : 6;
  $('sum-line').textContent =
    fmtDistance(distM) + '  ·  ' + fmtDuration(distM) + '  @ ' + speed.toFixed(1) + ' kn';

  const warnings = $('warnings');
  warnings.innerHTML = '';
  for (const w of result.warnings || []) {
    // Same relevance filter as the webapp: connection notices and
    // zero-distance via adjustments are noise, not warnings.
    if (w.type === 'start_connecting' || w.type === 'end_connecting') continue;
    if (w.type === 'via_constrained' && !w.distanceMeters) continue;
    const li = document.createElement('li');
    li.textContent = '⚠ ' + w.message;
    warnings.appendChild(li);
  }

  renderItinerary(result.itinerary || []);
  $('summary').style.display = 'block';
}

function renderItinerary(itinerary) {
  const ol = $('itinerary');
  ol.innerHTML = '';
  let turnNo = 0;

  for (let i = 0; i < itinerary.length; i++) {
    const p = itinerary[i];
    const isLast = i === itinerary.length - 1;

    let label;
    if (p.kind === 'start') label = 'Start';
    else if (p.kind === 'end') label = 'Destination';
    else if (p.kind === 'via') label = 'Via ' + ((p.viaIndex ?? 0) + 1);
    else label = 'Turn ' + (++turnNo);

    const li = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'it-point';
    const dot = document.createElement('span');
    dot.className = 'it-dot';
    dot.textContent = p.kind === 'start' ? '▲' : p.kind === 'end' ? '■' : '●';
    const lab = document.createElement('span');
    lab.className = 'it-label';
    lab.textContent = label;
    head.append(dot, lab);

    if (typeof p.turn === 'number' && Math.abs(p.turn) >= 10) {
      const turn = document.createElement('span');
      turn.className = 'it-turn';
      turn.textContent = (p.turn > 0 ? '↱ stb ' : '↰ port ') + Math.abs(p.turn) + '°';
      head.appendChild(turn);
    }

    const meta = document.createElement('span');
    meta.className = 'it-meta';
    meta.textContent = fmtDistance(p.distanceFromStart) +
      (p.distanceFromStart > 0 ? ' · ' + fmtDuration(p.distanceFromStart) : '');
    head.appendChild(meta);
    li.appendChild(head);

    if (!isLast && p.leg) {
      const leg = document.createElement('div');
      leg.className = 'it-leg';

      const bits = [];
      if (typeof p.courseToNext === 'number') bits.push('→ ' + String(p.courseToNext).padStart(3, '0') + '°');
      bits.push(fmtDistance(p.leg.distance));
      if (typeof p.leg.minDepth === 'number') bits.push('depth ≥ ' + p.leg.minDepth.toFixed(1) + ' m');
      if (typeof p.leg.maxAirDraft === 'number') bits.push('air ≤ ' + p.leg.maxAirDraft.toFixed(1) + ' m');
      if (typeof p.leg.minWidth === 'number') bits.push('width ≥ ' + p.leg.minWidth.toFixed(0) + ' m');
      const stats = document.createElement('div');
      stats.innerHTML = bits.map((b) => '<span class="constraint">' + b + '</span>').join(' · ');
      leg.appendChild(stats);

      for (const c of p.leg.crossings || []) {
        const row = document.createElement('div');
        row.className = 'crossing';
        const cd = document.createElement('span');
        cd.className = 'dot';
        cd.style.background = c.type === 'lock' ? CROSSING_COLORS.lock
          : c.subtype === 'opening' ? CROSSING_COLORS.opening : CROSSING_COLORS.fixed;
        const cn = document.createElement('span');
        cn.className = 'cname';
        let info = '';
        if (c.type === 'bridge') {
          info = c.subtype === 'opening' ? ' (opening)'
            : typeof c.height === 'number' ? ' (' + c.height.toFixed(1) + ' m)' : ' (fixed)';
        } else {
          info = ' (lock)';
        }
        cn.textContent = (c.name || c.type) + info;
        cn.title = cn.textContent;
        const cdist = document.createElement('span');
        cdist.className = 'cdist';
        if (typeof c.distanceFromStart === 'number') {
          cdist.textContent = fmtDistance(c.distanceFromStart) + ' · ' + fmtDuration(c.distanceFromStart);
        }
        row.append(cd, cn, cdist);
        leg.appendChild(row);
      }
      li.appendChild(leg);
    }
    ol.appendChild(li);
  }
}

function hideSummary() {
  $('summary').style.display = 'none';
}

/* ---------- formatting ---------- */

function fmtDistance(meters) {
  if (units.distance === 'kilometer') {
    return meters >= 1000 ? (meters / 1000).toFixed(1) + ' km' : Math.round(meters) + ' m';
  }
  const nm = meters / 1852;
  return (nm >= 10 ? nm.toFixed(1) : nm.toFixed(2)) + ' NM';
}

/** Sailing time for a distance at the configured average speed, as h:mm. */
function fmtDuration(meters) {
  const speed = cfg.averageSpeedKnots > 0 ? cfg.averageSpeedKnots : 6;
  const totalMinutes = Math.round((meters / 1852 / speed) * 60);
  return Math.floor(totalMinutes / 60) + ':' + String(totalMinutes % 60).padStart(2, '0');
}

function setStatus(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
