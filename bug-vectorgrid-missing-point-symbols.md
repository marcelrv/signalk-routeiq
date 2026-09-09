# Bug: Leaflet.VectorGrid drops some point symbols at tight zoom over dense clusters

## Problem

On an S-57 vector chart layer (`public/app.js`, `s57LayerStyle`'s
`BOYLAT`/`BCNLAT`-family case), some buoy/beacon point features simply never
render — no icon, no fallback circle, nothing — when zoomed in tight (roughly
z14–z16) over an area with many closely-spaced navaid points. The same layer,
same code, same data source renders correctly and reliably at normal routing
zoom (z13 and below, confirmed across two widely separated test areas —
Biscayne Bay FL and the Potomac River MD).

This is **not new** — it predates the S-57 label/navaid-icon work merged in
PR #45. It was found while validating that work, chased down a wrong path for
a while (see "Dead end" below), and is being written up here rather than
fixed, since it's orthogonal to what #45 shipped and deserves its own
focused session.

**Severity**: low for now — routing-level zoom is unaffected. It only shows
up if a user zooms in tight on a dense aids-to-navigation cluster (e.g.
inspecting a narrow channel entrance buoy-by-buoy).

## Reproduction

Environment: this repo's dev `signalk-server` (docker, port 3000), plugin
webapp at `/signalk-routeiq/`. Enable **only** the `testSet` chart (a NOAA
S-57 vector chart covering the US Mid-Atlantic/Florida area, roughly
`-82.9..-69.1` lon / `22.9..41.7` lat — see `data/US/us-caribbean`), disable
`OpenStreetMap`/`OpenSeaMap seamarks` so the S-57 rendering is isolated.

Known-bad spot: **lat 38.238, lon -76.745** (double-check this — see the
coordinate-typo note below), zoom **16**. This is St. Patrick Creek, a small
side channel off the Potomac near Coltons Point, MD. At that view:

- `St. Patrick Creek Buoy 10` and `St. Patrick Creek Buoy 9` render (a marker
  shows up next to the label).
- `St. Patrick Creek Buoy 7`, `6`, `5`, `4`, `3` do not — the OBJNAM label
  text appears (confirming the feature was decoded and the label layer from
  #45 works fine independently), but there is no point marker of any kind.

Known-good comparison: the same `testSet` chart at **lat 38.26966, lon
-76.70813, zoom 13** (the wide Coltons Point view used throughout #45's
verification) renders every buoy/beacon in view correctly, with proper
shapes once #45's icon work is in place, or as plain circles on the
pre-#45 code.

A `Playwright` + Chromium (headless, via the
`mcr.microsoft.com/playwright:v1.59.1-noble` docker image) driver script
against `window.__marine.map` (exposed by `public/app.js` for exactly this
kind of debugging) is the fastest way to reproduce and screenshot this — see
"Suggested next steps" for the harness pattern used during this
investigation (not preserved as a script; recreate from scratch, and pin
down exact coordinates carefully — see below).

**Known noise in past testing**: while investigating this, two nearly
identical coordinates were used across different throwaway scripts —
`-76.745` and `-76.755` — without originally noticing they were different
places (~870m apart at this latitude). Some of the apparent inconsistency in
early testing (buoys 9/10 "sometimes" rendering) likely traces back to this,
not to genuine flakiness. **Re-establish the exact failing coordinates
carefully before trusting any specific lat/lon in this doc.** What's solid is
the *pattern*: a tight zoom over a dense cluster of navaids has some points
silently fail to render, deterministically, for a given code+view state.

## What's been ruled out

Investigated in this order, each with direct verification against the
running server (not guesswork):

1. **Not a data problem.** Independently fetched and decoded the exact same
   MVT tiles (using `window.VectorTile`/`window.Pbf` — see the "Leaflet's own
   library leaks these onto `window`" trick used by #45's label layer) for
   both the working and failing buoys. Every failing buoy's feature decodes
   with complete, unremarkable properties (`CATLAM`, `COLOUR`, `OBJNAM`,
   `BOYSHP`, etc. all present and sane) — nothing distinguishes a failing
   buoy's raw data from a working one's.

2. **Not specific to #45's icon-based rendering.** Reproduced with the
   *original* plain-circle style (`pointStyle(buoyFill(p), 6)` — fully
   synchronous, no image loading, no `L.icon` involved at all). Same buoys,
   same failure. This alone rules out any theory involving async image
   decode races.

3. **Not introduced by #45's other changes either.** `git stash`ed all of
   #45's changes back to the pristine pre-PR `app.js` (no label layer, no
   icon shapes — just the original `pointStyle` circle) and reproduced the
   identical missing-buoy pattern at the same spot. **This confirms the bug
   is pre-existing in this app's Leaflet.VectorGrid integration**, unrelated
   to anything shipped in #45.

4. **Not a draw-order / z-index issue between S-57 layers.** Compared
   `Object.keys(tile.layers)` (the MVT tile's internal layer ordering, which
   is what `leaflet.vectorgrid`'s `createTile` iterates when drawing —
   see `public/vendor/leaflet.vectorgrid.min.js`, the `for (var o in
   i.layers)` loop) between a working tile and the two adjacent failing
   tiles. `BOYLAT` is alphabetically first in all three — identical
   ordering — so a later-drawn area fill (`DEPARE`, `LNDARE`, etc.) painting
   over the buoy point is not the mechanism.

5. **Not dependent on zoom-animation style.** Reproduced identically with
   `map.setView(..., {animate:false})` (instant jump) and with a realistic
   gradual step-by-step zoom-in (z13→14→15→16, each with a multi-second
   settle, mimicking real user interaction). Same result either way, so this
   isn't an artifact of an aggressive instant-jump test harness.

## Dead end: the `_updateIcon` / `_redraw` theory

Worth recording so it isn't re-investigated from scratch. Before ruling out
async image loading (#2 above), the working theory was: `L.Canvas.Tile`'s
vendored `_updateIcon` (in `leaflet.vectorgrid.min.js`) draws an icon via
`drawImage` only once the icon's `<img>` reports `.complete`; if not yet
complete, it registers a one-shot `'load'` listener that calls `drawImage`
directly — with **no retry, and nothing re-validating that draw against a
later canvas clear.**

A patch was written to route the "pending" case through the renderer's own
`_redraw()` instead (the real, coordinated repaint path every other feature
type uses). **This made things categorically worse** — it wiped previously-
working tiles blank, including buoys that had rendered fine before. Root
cause of *that*: in this vendored build, `L.Canvas.prototype._addPath` is
just `this._requestRedraw(t)`, and `_requestRedraw` is gated behind
`this._map` being truthy:

```js
_requestRedraw:function(t){this._map&&(this._extendRedrawBounds(t),this._redrawRequest=this._redrawRequest||x(this._redraw,this))}
```

But `L.Canvas.Tile`'s `_map` isn't set until `createTile`'s promise callback
calls `n.addTo(this._map)` — **after** every `_addPath(d)` call for that
tile's initial synchronous render has already happened. So for these
per-tile canvases, `_addPath` is effectively a no-op under normal operation:
nothing ever populates the `_layers`/`_drawFirst` linked list that
`_redraw()`'s `_draw()` loop walks. Calling `_redraw()` from the patched
`_updateIcon` therefore did `_clear()` (blanking the whole tile canvas,
since `_redrawBounds` is unset) and then `_draw()` over an **empty** list —
drawing nothing back. The patch was fully reverted; see git history around
PR #45 for the exact diff if useful as a reference for how *not* to fix
this.

This also means the original "async image race" framing was likely wrong
end-to-end, not just the fix for it — see #2 above: plain synchronous
circles fail the same way, and circles never touch `_updateIcon` at all.

## What's confirmed, restated

- Deterministic for a given code+view state — not flaky. Repeated identical
  runs produced byte-identical screenshots.
- Reproduces on both old (plain circle) and new (icon) point styles.
- Reproduces on both the pristine pre-#45 code and current `main`.
- Confined (as tested) to tight zoom (~z14–16) over a dense point cluster.
  Wide/routing zoom (z13 and under) has been reliable across two separate
  geographic areas and many buoys/beacons/lights.
- The *label* layer (#45, independent MVT decode) correctly retrieves and
  decodes every one of these "missing" features — the gap is specifically
  in `leaflet.vectorgrid`'s own point-symbol draw path, not in data
  availability.

## Suggested next steps

Roughly in order of how cheap they are to check:

1. **Pin down exact coordinates first.** Re-establish precisely which
   tile(s)/buoy(s) fail, independent of the `-76.745`/`-76.755` confusion
   above. Fetch the tile directly (`/signalk/v1/api/resources/charts/testSet/{z}/{x}/{y}`)
   and cross-reference `window.__marine.map.project(latlng, z).divideBy(256).floor()`
   to know exactly which tile x/y you're looking at, rather than eyeballing
   a screenshot.

2. **Count point features per tile** and see if failure correlates with
   count — e.g. does a tile with N+ `BOYLAT`/`BCNLAT`/etc. features
   silently drop some past a threshold? This is untested and is the most
   promising lead: the failing cluster is visibly denser than the working
   one.

3. **Check whether the missing buoys ever appear if you zoom in further**
   (z18+). If they do, that points at a clipping/threshold issue rather
   than "never drawn." If they never appear at any zoom, that rules out
   viewport/clip-region theories.

4. **Inspect the actual `<canvas>` element directly** (real Chrome devtools,
   not headless Playwright — pause and use the Canvas/Layers inspector, or
   just `getImageData` at the buoy's computed pixel position) to see whether
   a draw call happened at all for a failing buoy. This distinguishes three
   very different bugs: (a) the style function never gets invoked for that
   feature, (b) it's invoked and draws, but to the wrong pixel position, or
   (c) it draws correctly but something (clip region, canvas size, a stale
   context) hides it.

5. **Check for a tile-Y-coordinate-specific pattern.** In one test session,
   the working tile was `16/18796/25224` and the two failing tiles were
   `16/18796/25225` and `16/18797/25225` — both adjacent, both one row
   "south" in tile-Y. That's a thin sample (n=1 boundary), but worth
   checking deliberately: does `leaflet.vectorgrid`'s *own* internal tile
   addressing (separate code path from this app's label-layer fetcher,
   which is known-correct) ever compute an off-by-one row, e.g. an XYZ vs.
   TMS row-order mismatch, at these zoom levels specifically?

6. **Try `L.svg` instead of `L.canvas.tile` as the renderer factory** (if
   `leaflet.vectorgrid` supports it — check `opts.rendererFactory` in
   `makeChartLayer`, currently hardcoded to `L.canvas.tile`) as a diagnostic
   only. If SVG rendering doesn't reproduce the bug, that strongly implicates
   something canvas-2D-context-specific (rounding, a stray `clip()`/`save()`/
   `restore()` imbalance, devicePixelRatio scaling at high zoom, etc.) rather
   than a geometry/coordinate bug shared by both renderers.

7. **Cross-browser check.** All testing so far used headless Chromium via
   Playwright. Worth checking Firefox and a real (non-headless) Chrome to
   rule out a headless-Chromium-specific canvas quirk, however unlikely.

## Where to look in code

- `public/app.js`: `s57LayerStyle`'s `BOYLAT`/`BCNCAR`/.../`LIGHTS` case
  (search `s57NavaidShape`), and `makeChartLayer`'s
  `opts.rendererFactory = L.canvas.tile` line.
- `public/vendor/leaflet.vectorgrid.min.js`: `createTile` (the `for (var o
  in i.layers)` render loop), `L.Canvas.Tile` (`_updateIcon`, `initialize`),
  `PointSymbolizer` (`render`, `_updatePath`, `_getImage`).
- `public/vendor/leaflet.js`: `L.Canvas.prototype._addPath` / `_requestRedraw`
  / `_redraw` / `_draw` — the real (non-vectorgrid) implementations these
  vendored classes extend, useful for understanding what's actually inherited
  vs. overridden.
