# RouteIQ Next Phases — pointer

The full, canonical cross-repo plan and investigation log lives in
[`signalk-router-pipeline/NEXT_PHASES.md`](../signalk-router-pipeline/NEXT_PHASES.md)
(local checkout: `/home/node/signalkdev/signalk-router-pipeline/NEXT_PHASES.md`).
This repo (`routeiq`) is the TypeScript runtime side of that plan — most
of the recent work described there (navmesh funnel-algorithm consumption,
Phase 2 Hardening Rounds 1-4) lives in `src/navmesh.ts`, `src/database.ts`,
`src/routing.ts`, and `test/zeelandbrug.test.ts` here, with the
generation/pipeline side in the sibling repo. (Originally named
`AUTOROUTE_NEXT_PHASES.md`, renamed from `NEXT_PHASES.md` so the two
repos' file lists — and open editor tabs — aren't identically named; now
`ROUTEIQ_NEXT_PHASES.md` after the plugin's rebrand.)

## Committed next milestone — US East Coast multi-region routing (Round 25)

> **STITCHING MECHANISM — SETTLED, see [`signalk-router-pipeline/STITCHING_DESIGN.md`](../signalk-router-pipeline/STITCHING_DESIGN.md)
> §8–§10.8.** The old framing here (2026-07-20: "two experiments ruled out
> build-time coincidence; the recommended mechanism is a routeiq **runtime
> proximity matcher**, paused pending review") is **superseded and wrong** —
> keep reading only for history. What the 2026-07-30/08-08 measurements showed:
>
> - **Build-time coincidence works**, just not the way Chunk 1 measured it.
>   `clip_pilot_data.py` cuts adjacent files on the same meridian, so both get
>   identical boundary vertices; connectivity needs **one** shared node per water
>   body, not a high coincidence fraction. A narrow channel self-stitches on a
>   single node.
> - **The shared seam registry is load-bearing in sparse open water** — the case
>   a state-boundary meridian hits offshore. Without it: 0 shared ids, 0%
>   far-side reachability. With it: 86.3% reachable. It shipped
>   (`signalk-router-pipeline` `0cd3467` + fixes), and requires
>   `--overlap-deg ≥ stitch_band_m`.
> - **No runtime proximity matcher was ever needed** and none was built. The
>   committed node-ID merge does the whole job.
> - All 9 US East Coast regions are rebuilt against one registry; all six
>   geographically adjacent pairs are crossable and return genuinely routed
>   cross-state routes.
>
> **STATUS CORRECTION (2026-07-20, verified against committed code, not
> docs):** Phase 4a / WS2 **runtime core is already implemented and
> committed** — `94a0a27` "Phase 4a core: dynamic database loading (peek,
> per-file load/unload, on-demand)". It provides `peekMetadata` + coverage
> index, per-file `loadDatabaseGraph`/`unloadDatabaseGraph`, node-ID merge
> via `nodesByDbIndex`/`nodeDbCount` contributor ref-counting, inline
> route-triggered on-demand load, and `/databases/loaded|load|unload`
> endpoints + a webapp coverage toggle. `dynamicLoading` default is flipped
> `false→true` in the working tree (uncommitted), because loading ~527MB of
> US East Coast files unconditionally already hit a V8 heap OOM. **The WS2
> task list below was written before this was known and reads as if
> unstarted — treat it as reference/spec, not a to-do.** Remaining work,
> updated 2026-08-10: (1) **pipeline** seam stitching — **DONE**, shipped and
> measured (see STITCHING_DESIGN §8–§10.8); (2) coincident-node merge — **DONE**,
> union and de-duplication both, see below; (3) **position-triggered**
> auto-load — also **DONE**, contrary to what this line said until 2026-08-10:
> `eagerLoadAtPosition` (default on), `loadRadiusNm` and `maxLoadedRegions`
> (default 6) are all in `types.ts`, with a real `navigation.position`
> subscription in `index.ts` and an LRU cap in `database.ts`. What remains of
> §4a is the **loading indicator** for inline loads (below) and
> `unloadAfterIdleNm`-style distance eviction, which the LRU cap covers in
> practice.

### Coincident-node merge: union verified, de-duplication now done (2026-08-10)

**CLOSED.** `spliceEdge` in `src/database.ts` folds a second contributor's copy
of an already-stored `(source,target)` into the existing entry instead of
appending it, on both the per-file and the bulk load path. Verified against the
real stitched builds and matching the measurements below exactly: **CT↔RI
24,506** rows merged rather than appended (115,442 on disk → 90,936 added), and
**DE↔MD 26** (267,704 → 267,678). Committed fixture: `test/seam-merge.test.ts`.

Three things worth knowing, none of which were in the original plan:

- **Attribute conflicts fold to the more constrained value**, not to the first
  contributor. Between two files: known beats `-1` (the UNKNOWN convention
  consumers exclude from constraint checks, so it is the *least* constrained
  reading there is), then smaller wins; `cost_factor` takes the max. Only the
  three physical limits and `cost_factor` fold — `distance` is geometry both
  sides derive from the same coordinates.
- **De-duplication would have broken eviction**, silently. `unloadDatabaseGraph`
  drops edges by `dbIndex`, and a shared seam edge used to survive eviction of
  one contributor only because it was stored twice — once tagged per file. With
  one copy, a plain filter cuts a seam edge a still-loaded file authors: no
  failed route, just a hole where the regions joined. `EdgeRow.extraDbIndexes`
  is the per-edge contributor list that closes it, handing the edge to a
  remaining contributor on eviction.
- **The scan is gated on shared sources**, or it costs ~8% of load time. A
  second contributor's edge out of node S requires S itself to be shared, so
  both load paths collect the shared node ids and only those sources pay the
  adjacency scan. Re-measured on CT↔RI: within noise of the pre-change build
  (and the second file now loads slightly faster, having 24,506 fewer rows to
  append).

**FIXED 2026-08-10** (branch `fix/durable-edge-edits`): the overlay now records
which columns an edit actually set (`edited_fields`, a JSON array on the
overlay `edges` row, added by migration), and `spliceEdge` lets exactly those
outrank the region file while everything else on the row stays the file's. The
per-field choice is deliberate over storing a full snapshot: a correction is
per-field by nature, so re-downloading a region still delivers fresh values for
the columns the user never touched. Rows written before the column existed have
no marker — their intent is unrecoverable — and keep the conservative fold.
Worth knowing: node edits were never broken, because nodes merge into a Map
where the overlay's row overwrites, while edges merge into an array where
readers take the first match. Original writeup:

Also found here, **not addressed at the time** — a user's edge edit does not
survive a reload on its own merits. `updateEdge` writes a row into the overlay whose
unmentioned columns are placeholders (`distance` 0, limits `-1`,
`cost_factor` 1.2); before this change the file's row was simply stored first
and every reader's `.find()` returned it, so the edit reverted. The
de-duplication deliberately does *not* settle that precedence question — it
folds the overlay row by the same conservative rule as any other, so an edit
that tightens a limit takes effect and one that relaxes it still does not.
Deciding what an overlay row should outrank, and how to tell a placeholder
from an intended value, is its own piece of work.

### Original finding (2026-08-08), kept for the measurements

Measured across both the Zeeland fixtures and all 12 real US East Coast region
pairs (`signalk-router-pipeline/local_only/local_scripts/round25_seamroute/`
— `run_seam_route_test.mjs`, `verify_region_seams.mjs`):

- **Union is correct.** For every node id present in both files, the merged
  in-memory adjacency contains both files' edges: `missing = 0` and
  `syntheticExtra = 0` on every pair. This half of the old to-do is closed.
- **No de-duplication.** Where both files hold the *same* edge out of a shared
  node, the merged adjacency carries it twice. Measured duplicate adjacency
  entries: **CT↔RI 24,506**, DE↔NJ 1,820, NJ↔NY 67, DE↔MD 26, CT↔NJ 18, and
  62 of 211 shared nodes on the Zeeland pair (118 entries). Not a correctness
  bug — A* just re-evaluates a neighbour it has already seen — but it inflates
  the adjacency of exactly the nodes every cross-region route must traverse,
  and CT↔RI shows it is not a rounding-error quantity.
- **Fix shape:** dedupe on `(source, target)` when splicing a second
  contributor's edges into an existing node's adjacency, keeping the first
  contributor's attributes (or the more constrained ones — worth deciding
  explicitly rather than by insertion order). A regression test wants a fixture
  where both files hold one identical edge plus one edge unique to each side.

### Dynamic-loading UX follow-ups (surfaced 2026-07-21, live testing)

Flipping `dynamicLoading` default-on (committed `3bfbcd0`) fixed the
multi-region OOM but introduced a real UX regression: with many installed
regions and nothing triggered, **startup loads nothing**, so the webapp
reads as "no databases" even though every region is peeked with valid
coverage. Hit live during Round 25 stitched-pair testing.

**ALL FOUR SHIPPED 2026-07-21** (coverage overlay `47b6226`; position
eager-load + single-DB rule + empty-state `7a45094`; build clean, 56/56
tests). Items retained below as the record. Fixes, in priority order:

1. **DONE — coverage overlay shows all installed DBs, coloured by state**
   (routeiq `47b6226`). The Database coverage toggle read `/databases`
   (loaded-only); now reads `/databases/loaded` (all + state) and draws
   loaded = solid green (precise boundary when available), not-loaded =
   dashed grey box, with the load state in the tooltip. Surroundings are
   visible again regardless of load state.

2. **Position-based startup eager-load (the real fix — §4a trigger 1, the
   still-unbuilt "PR4").** Subscribe to `navigation.position` (confirmed NOT
   subscribed today — only `subscribeToVesselDimensions` exists,
   `src/index.ts`), and at startup + on >~1nm movement, eager-load the
   region(s) whose coverage contains the vessel position (or is within
   `loadRadiusNm`). A positioned vessel then boots with its local region
   loaded and routable instead of empty. This is exactly the trigger the
   §4a design specced; the shipped 4a core (`94a0a27`) only implemented
   route-triggered on-demand load, never the position trigger.

3. **Single-DB eager-load rule.** Verify/implement the §4a design rule: if
   exactly one installed DB, load it at startup unconditionally (nothing to
   choose) — keeps the common single-region deployment ready-at-boot even
   with `dynamicLoading` on.

4. **Clearer empty state.** Replace a bare "no databases" with e.g.
   "N regions available — none loaded yet (dynamic loading)", so a
   not-yet-triggered state doesn't read as a failure.

Config: `loadRadiusNm` (proactive band); consider an `eagerLoadAtPosition`
flag (default on) so the behaviour is opt-out. Tests: a `navigation.position`
inside a region's bbox ⇒ that region is `loaded` at startup and a route
there needs no manual load; no position + >1 DB ⇒ the clearer message
shows; a lone DB always boots loaded.

**Also shipped 2026-07-21 — transit-region on-demand loading** (§4a.1 task 4,
`a4611d0`). `ensureRegionsForBbox` loads every region whose coverage
intersects a route's search bbox, not just waypoint-containing ones — so a
route now traverses regions it merely passes through instead of drawing a
straight chord over them. 57/57 tests; verified live (route START 4.21 → DEST
3.83 now loads both the west clip (contains DEST) and the east clip (transit)).

**Non-urgent follow-ups (2026-07-21):**

1. ~~**Cap on regions loaded per request.**~~ — **done, and this note was
   already out of date when written.** `maxLoadedRegions` exists
   (`types.ts`, default **6**) and `enforceRegionCap()` evicts
   least-recently-used regions once no route is in flight. What is still
   uncapped is the number of regions `ensureRegionsForBbox` loads *within one
   request* — a very wide route (up to `routingBBoxMaxExtent`, 10°) over a
   densely-tiled area loads every intersecting region before the LRU trims
   back. Fine at current dataset size.
2. ~~**Loading indicator for on-demand region loads.**~~ — **done 2026-08-10**
   (branch `feat/region-loading-indicator`), by the poll route, not the `202`
   one. `getLoadingStatus()` now reports the regions in `state: "loading"`, and
   the webapp polls `/databases/status` while a route request is outstanding.
   Deliberately that endpoint and not `GET /databases`: the latter makes a
   worker round-trip, and during a load the worker is precisely what is busy,
   so the poll would queue behind the load it is asking about.

   **Measured first, because the design depended on it** (56 MB Maryland
   region, `us_east_md_stitched`): the server's event loop is free for the
   first ~2.5s of a 6.3s load — a 100 ms poll is answered on time — and then
   **blocked solid for the last 3.8s** while rows are merged into the graph.
   So the first poll lands and names the region; later ones may not be answered
   at all until the load finishes. The message is written to stay true while
   stale, and the toast carrying it animates in the browser, where nothing is
   blocked. Effective poll rate through a whole load: 3.3/s of 10/s attempted.

   Found and fixed alongside: the webapp aborted any route request at 30s, so a
   request waiting on a large region load was reported as a failure while the
   server was still working. Now on an extendable `AbortController` — which
   also drops `AbortSignal.timeout` (Chrome 103+) from a file whose floor is
   Chrome 66.

   The non-blocking `202`/status-handle pattern from §4a task 5 remains
   unbuilt, and is now the only thing left here — see the next section.

### Non-blocking `202` for route requests that trigger a load (§4a task 5) — OPEN, not urgent

Scoped 2026-08-11, after the polling indicator shipped. Recorded rather than
built, because the reason to defer is as useful as the design.

**Today.** A route needing an unloaded region loads it inline:
`RoutingEngine.calculateRoute` → `ensureRegionsForBbox` → `await
loadDatabaseGraph`, with the HTTP request open throughout — 6.3s for a 56 MB
region, ~76s for a full country before the pipeline started tiling. Everything
above makes that wait *legible* (the client says which region, and no longer
gives up at 30s). It does not make it stop.

**The change.** Instead of awaiting, the handler returns immediately:

```
HTTP 202 Accepted
{ "status": "loading", "regions": [{ "filename": "us_east_md.sqlite", "name": "Maryland" }] }
```

The client polls until the region is `loaded`, then re-issues the original
request, which then answers in the usual milliseconds. `api.ts` already has the
precedent the design points at — `isReady()` → `503` while the graph is coming
up. Most of the groundwork now exists: the `not_loaded → loading → loaded`
state machine, `/databases/status` reporting in-progress regions, and the
client-side poll loop. Missing: the early return, and the client re-issue.

**Why it is worth something.**

- The blocked event loop stops mattering. The measurement above found **3.8s of
  hard block** in a 6.3s load, during which the server answers *nothing* — not
  just that route. A `202` means no request is waiting on that stretch.
- The 180s client deadline becomes unnecessary; it is a workaround for a
  request that should never have been open that long.
- Connections are not held. Chart plotters are not generous with concurrent
  connections, and a minute-long POST is a real cost on one.

**Why it is not urgent, and what it would cost.** It changes the `/route`
contract for *every* client, not just this repo's — `AGENTS.md` is explicit
that the API is designed for any frontend. A client that does not know `202`
would try to parse the body as a `FeatureCollection` and fail, and would fail
**only on the first route into a new region**, which is about the worst failure
distribution there is for diagnosis. So it wants to be opt-in — a request flag
(`"async": true`) or `Accept` negotiation — with the blocking path remaining
the default. That roughly doubles the work: two code paths, both tested, and
**two** first-party clients to update (`public/app.js` and
`plotterext/panel.js`).

**Priority call.** Worth doing, behind the tide-informed depth work in
`todo.md`, which is a feature users would actually feel. The polling indicator
removed the sharp edge — no unexplained freeze, no spurious failure — so what
is left is architectural correctness rather than a user-visible fix.
Reprioritise immediately if regions get materially larger, or if anyone reports
the server going unresponsive during a load: that symptom is this cause.

**Decided 2026-07-20** (priority review of `PHASE_3_DESIGN.md` /
`PHASE_4_DESIGN.md`). Scale-out (3e) is the de-facto active track (PR
shipped R18/R22, ocean tiling R23, US East Coast files now being
generated as individual per-area `.sqlite` files), so the near-term
critical path is **scale-out → cross-database stitching → dynamic
loading**, not the Phase 3 data-fusion track (3a/3b/3d) the design doc
listed "first." **This milestone is WS2 only** (dynamic database
loading, **default on**). Cross-database stitching is handled primarily at
**build time** — adjacent files are generated with a fixed overlap band
whose boundary nodes snap to a global grid, so coincident seam nodes get
identical hash IDs and are merged into one node on load (see WS2 task 2 and
the pipeline doc). The heavy runtime synthetic-edge matcher (old WS1) is
**deferred to a later round as a fallback** for legacy/un-gridded files —
it is not needed for the grid-snapped happy path. The pipeline/cross-repo
half (build-phase overlap, global snapping grid, boundary-node stamp) lives
in `signalk-router-pipeline/NEXT_PHASES.md`, "Next milestone — US East Coast
multi-region routing"; keep the two in sync.

### Locked design decisions (do not re-litigate)

- **Primary stitching = build-time, automatic (not a runtime matcher).**
  Adjacent files are built with a fixed overlap band (pipeline side, no
  neighbour awareness) whose boundary/overlap-band nodes snap to a **single
  global lat/lon grid**. Because node IDs are coordinate-hash-derived,
  coincident seam nodes then get **identical IDs** in both builds and are
  merged into one node when the loader brings a second DB into the in-memory
  graph — the graph is stitched with zero runtime synthetic edges. Chosen
  over neighbour-aware overlap because a global grid preserves per-file
  independence (each build references a shared *constant*, never another
  file); neighbour-aware coupling fights the "independently re-downloadable
  DB" invariant and buys nothing the grid doesn't. See the pipeline doc's
  overlap/grid decision for the full rationale.
- **Runtime synthetic-edge matcher = DEFERRED fallback (not this
  milestone).** For legacy/un-gridded/abutting files where node IDs don't
  coincide, a later round adds the §4a.1 matcher (closest-node-first KNN,
  ≤2 connectors/node, LOS land check, stamp/envelope-band candidates,
  provenance registry). Kept out of scope here — the grid-snapped happy
  path doesn't need it, and building it now would gold-plate a fallback
  before the primary path is proven.
- **Scope = WS2 (4a dynamic-loading core), default on.** 3c community
  overrides is the intended fast-follow, deliberately **out** of this
  milestone to keep the bite managable.

### WS1 — Cross-database stitching (DEFERRED — fallback for a later round)

**Not in this milestone.** With build-time overlap + global-grid snapping
(above), grid-snapped seam nodes coincide by ID and are merged on load, so
no runtime synthetic edges are needed for the happy path. This section is
retained as the spec for the eventual fallback matcher, to be built later
only for legacy/un-gridded/abutting files. Design basis: `PHASE_4_DESIGN.md`
§4a.1. Synthetic runtime edges only — never written into any `.sqlite`
(databases stay independently re-downloadable), same in-memory convention
as funnel anchor-shortcuts.

1. **Overlap matcher (default path).** For each pair of loaded DBs whose
   coverage envelopes (`metadata.bounding_box`) intersect: collect each
   DB's nodes inside the intersection band (bbox-prefiltered), pair them
   across DBs by ascending distance (closest-first), dedupe near-identical
   pairs (<~5m → treat as one node, remap edges), and for the rest add a
   short synthetic connector. Cap ≤2 connectors per node.
2. **Fallback matcher (no overlap).** When two loaded DBs' envelopes are
   within `stitchRadiusM` (~500m) but do **not** overlap: candidate nodes
   = stamped `is_data_boundary` nodes if the file carries them, else nodes
   within `stitchBandM` (~250m) of `metadata.boundary_geometry`. Same
   closest-first KNN pairing, ≤2/node.
3. **Land + attribute gating** (both paths): gate every connector through
   the existing runtime line-of-sight land check (`isLineCrossingLand`
   sampling — build-time polygon data isn't available at runtime).
   Connector attributes are conservative: distance-based cost, `min_depth`
   = min of the two endpoint depths, short by construction so uncertainty
   stays bounded.
4. **Provenance registry — the part WS2 makes mandatory.** Register every
   stitch edge with `{dbIndexA, dbIndexB}` provenance in a separate
   registry, NOT mixed anonymously into `edgesBySource`. Loading a region
   stitches only the new DB against each already-loaded neighbor
   (incremental — cost scales with the new rim, not the whole world).
   Evicting a region removes exactly the stitch edges referencing it.

**WS1 tests** (`test/`, real fixtures per the `zeelandbrug.test.ts`
precedent):
- Primary committed regression: clip the existing Zeeland data into two
  **overlapping** halves, load both, assert a route whose start/end sit in
  different halves crosses the seam and matches (within tolerance) the
  single-file route for the same coordinates. Cheap, self-contained, no US
  data needed.
- Assert no stitch connector crosses land (LOS check fires).
- Assert the near-identical-node dedupe path (place two coincident nodes
  across DBs, assert one merged node, zero connectors).
- Assert the fallback matcher on an **abutting** (non-overlapping) fixture
  pair, once with stamped nodes and once relying on envelope-band.
- Assert evicting one DB removes exactly its stitch edges (registry
  provenance) and leaves the rest of the graph intact.

### WS2 — Dynamic database loading, 4a core (§4a tasks 1–4)

Today `RoutingDatabase.init()` (`src/database.ts:126`) opens *every*
`.sqlite` and full-loads it, unconditionally — unviable for N US East
Coast tiles (R22 measured ~76s for one region pre-tiling). New
`dynamicLoading` config flag, **default `on`** — the multi-region future is
the standard path, not an opt-in. Single-region UX is preserved by one
rule: **if exactly one local DB is present, eager-load it at startup**
(nothing to choose, so no behavior change for today's deployments). The
real cost of default-on is that the `202`/position/evict paths become
load-bearing for every deployment from day one, so they must be robust and
well-tested before the flip — reflected in the test list below.

1. **`peekMetadata(dbPaths)` worker message** + `RegionCoverageIndex:
   Map<filename,{bbox,boundary,state}>`. Opens each file only long enough
   to `SELECT bounding_box, boundary_geometry FROM metadata`. Turns
   startup from "load N regions" into "peek N regions."
2. **Per-file load/evict plumbing** in `db-worker.ts` — refactor today's
   "all handles, once" `loadNodes`/`loadEdges` loops into something
   callable per-handle, merging/removing one DB's nodes+edges from the
   in-memory graph. State machine: `not_loaded` → `loading` → `loaded`.
   **Node-ID merge on load (the stitching enabler):** when a newly-loaded
   DB contains a node ID already present (a grid-snapped coincident seam
   node from an overlapping neighbour), merge into the existing node and
   union their edge lists rather than treating them as separate — this is
   what turns build-time overlap+grid-snap into an automatically-connected
   cross-region graph, no synthetic edges. On evict, remove that DB's own
   nodes/edges, but keep a merged seam node alive if a still-loaded
   neighbour also contributed it (reference-count contributors per node).
3. **Position trigger** — subscribe to `navigation.position` (new
   plumbing, confirmed not present today). Throttled (re-evaluate on >1nm
   movement): proactively load any `not_loaded` region whose boundary is
   within `loadRadiusNm`; evict a `loaded` region more than
   `unloadAfterIdleNm` outside its boundary (**eviction off by default** —
   dropping a region mid-route is a worse failure than using more memory).
4. **Route-triggered on-demand load** — if a route's start/end/waypoint,
   **or any `not_loaded` region intersecting the search bbox** (the
   start-end-chord + `adaptiveMargin` bbox `tryRouteSegment` already
   computes — transit regions, not just waypoint containment), is not
   loaded, load it before searching. Long loads return `202 Accepted` with
   a status handle (extend the existing `isReady()`→`503` precedent in
   `api.ts`), never block the HTTP request for tens of seconds.
5. **Config** (`types.ts`): `dynamicLoading` (**default `on`**; the
   single-DB eager-load rule above is unconditional, not a separate flag),
   `loadRadiusNm`, `unloadAfterIdleNm`, `maxLoadedRegions` (hard cap as a
   second safety net).

Trailing (same milestone, lower half — can land just after 1–5):
`GET /signalk/v1/api/router/databases/loaded` + webapp "loading region…"
indicator that re-issues the original request when the region flips to
`loaded`.

**WS2 tests**:
- `peekMetadata` returns coverage for every local file without paying a
  full load (assert nodes/edges NOT populated after peek).
- Per-file load merges exactly that file's nodes/edges; evict removes
  exactly them; graph intact otherwise.
- Position update inside `loadRadiusNm` triggers a load; beyond
  `unloadAfterIdleNm` triggers an evict (when enabled).
- Route with start in a `not_loaded` region returns `202`, then succeeds
  after the region loads; a route transiting a `not_loaded` region (no
  waypoint in it) still loads it.
- **Single-DB eager-load: a lone local DB is `loaded` and route-ready at
  startup** (no `202` on first request), same as today.
- **Cross-region routing via grid-snapped seam nodes**: load two
  overlapping, grid-snapped adjacent fixtures; assert their coincident seam
  nodes merged to shared IDs (one node, unioned edges) and a route across
  the seam succeeds with **no** synthetic stitch edges present.
- **Regression: `dynamicLoading:on` with one region reproduces today's
  behavior** (ready at startup, same routes) — guard the common case.

### Sequencing

Tasks 1–2 (peek + per-file load/evict + node-ID merge) → task 3 (position
trigger) → task 4 (route-triggered load + `202`) → trailing UX. The
build-time overlap+grid-snap work (pipeline doc) must land alongside, since
it's what makes task 2's node merge produce a connected cross-region graph.
The deferred WS1 runtime matcher is a later round, only for un-gridded
files.

### PR-sized chunks

| PR | Scope | Files | Depends on |
|---|---|---|---|
| **PR1** | Per-file load/evict/merge refactor: extract per-handle load/evict, load state machine (`not_loaded`/`loading`/`loaded`), **node-ID merge on load** (union edges when an ID already exists) + per-node contributor ref-count for safe eviction. `init()` still loads **all** DBs so end-state is byte-identical to today — a pure refactor. | `db-worker.ts`, `database.ts` | — |
| **PR2** | `peekMetadata` worker msg + `RegionCoverageIndex`; config (`dynamicLoading` default `on`, `loadRadiusNm`, `unloadAfterIdleNm`, `maxLoadedRegions`); single-DB eager-load rule. `init()` peeks-not-loads when `on` (and >1 DB). | `db-worker.ts`, `database.ts`, `types.ts` | PR1 |
| **PR3** | Route-triggered on-demand load: load any `not_loaded` region intersecting the search bbox (transit regions too), `202 Accepted` + status handle. | `api.ts`, `routing.ts`, `db-worker.ts` | PR2 |
| **PR4** | `navigation.position` subscription + throttled (>1nm) auto-load within `loadRadiusNm`; opt-in evict beyond `unloadAfterIdleNm`. | plugin entry, `api.ts` | PR2 |
| **PR5** | `GET /databases/loaded` + webapp loading indicator with auto-retry. | `api.ts`, `public/index.html` | PR3/PR4 |

PR3 and PR4 parallelize once PR2 lands. Each PR: build + test via Docker
(no local node — see `AGENTS.md`/`AGENTS.local.md`), on its own branch,
existing suite must stay green.

---

## Ready to start now — no pipeline dependency

Everything below can be picked up immediately, independent of any
pipeline-side fix landing:

- **Phase 4 §4a — dynamic database loading** (sibling repo's
  `PHASE_4_DESIGN.md`) — explicitly independent of everything in Phase 3;
  most valuable once more than one real region exists locally, but not
  blocked on that either.
- **Phase 4 §4c, Tier 1 only — flat-constant bridge/lock wait ETA
  correction** (`feature-bridge-lock-waits.md`) — explicitly designed to
  need no pipeline/schema change at all; ships against today's data using
  just two config constants. **Tiers 2-3 of the same feature are
  pipeline-blocked, see below.**

*Resolved off this list: "Left-click vs. right-click placement" — checked
and confirmed intentional by design (commit `8663300`'s own message plus
in-code comments and user-facing hint text), not an open decision. No
code change made. Full detail: `todo.md`, "Open — Webapp UX".*

*Resolved off this list: a real bug found while investigating the above —
in edit mode, the route line (always brought to front on redraw) swallowed
clicks meant for any node/edge it visually overlapped. Fixed in
`renderCustomRoute()` by bringing the graph/edges layers back above the
route while `state.editMode` is on. Full detail: `todo.md`, "Open — Webapp
UX".*

*Resolved off this list: "Edge debug overlay coloring" — the existing
single "Graph edges" toggle now always renders three independent visual
channels instead of one: color = `edge_kind_id` (green=centerline,
amber=navmesh_boundary, violet=lane, pink=macro), dash = `edge_type_id`
(coastal long-dot-long vs. inland solid), opacity = `traffic_mode`
(one-way bolder). No separate mode toggle. Required exposing
`edge_kind_id` through `getEdgesInBBox()` (`src/database.ts`) — the
`/graph/edges` API didn't return it before. The dash pattern/opacity
values needed a second pass: the first attempt (`10,3,2,3` at 0.35/0.65
opacity) turned out to be genuinely invisible, confirmed by pixel-level
checks against the live render rather than trusting the DOM attribute
was set — tuned to `16,6,4,6` at 0.6/0.85 opacity, verified visible live.
Verified live: navmesh
boundary rings now render clearly distinct from skeleton centerlines.
Full detail: `todo.md`, "Open — Webapp UX".*

*Resolved off this list: "Isolate Issue B" — live-instrumentation trace
against the real live database (`data/zeeland.sqlite`) found the literal
claim ("Zandkreeksluis opening bridge not taken") **does not reproduce**:
in every reproduction (2 vessel profiles × both directions, direct
~10km crossing), `RoutingEngine.calculateRoute`'s returned `crossings`
always includes "Zandkreeksluis, brug over buitenhoofd" — the bridge is
never skipped. **This is routeiq-side confirmation that there's no
`astarSearch`/bridge-avoidance bug for this specific bridge.** Full
writeup and the real (different, pipeline-side) issue found along the
way: see Round 9 below.

## Webapp UX — manual-route editing, possible next improvements

Background: a 2026-07-18 UX review of the manual/auto route editing in
`public/index.html` produced 10 suggestions. Items 1–5 (drag-the-line via
insertion, leg-scoped context menu, hover-highlight of the affected leg,
final-leg `destMode` toggle on the destination marker, Shift+click for
straight-line points + visible manual-mode cursor) were implemented
immediately. The remaining five are queued here, we need to decide if we want these or not, so they are pending evaluation:

- **Live preview rubber-band line** — in manual mode (or while dragging a
  ghost point on the route line), draw a dashed magenta preview line from
  the last waypoint to the cursor so the user sees what a click will
  create before committing.
- **Insert plain-tap vias by leg projection, not nearest coordinate** —
  `sortViasWithModes()` picks the closest coordinate on the whole route,
  which misplaces points when the route doubles back (peninsula, river).
  Project the new point perpendicularly onto each leg between existing
  waypoints and insert into the nearest leg instead. (Segment-click and
  drag insertion already bypass this; this fixes the remaining plain-tap
  path.)
- **Waypoint list panel** — ordered sidebar list (Start, Via 1…n, Dest)
  with per-leg auto/straight toggle icons, delete buttons and
  drag-to-reorder; hovering a row highlights the corresponding leg on the
  map. Second, explicit editing surface for users who don't discover the
  map gestures.
- **Feedback toast after leg-mode changes** — e.g. "Leg 2 → 3 is now a
  straight line · Undo". The dash-pattern change alone is subtle when the
  leg was already nearly straight.
- **One-time coach mark** — the first time a full route exists, show a
  dismissible tip teaching the gestures ("Drag the route line to reshape
  it · Shift+click for a straight-line point · right-click a leg for
  options"). The hint-bar text is too terse to teach the model.

## Webapp UX — download manager improvements (port strong points from signalk-tidal-currents)

**Framework decision (resolved 2026-07-24): use Leaflet, no build tooling added.**
Checked `package.json`/`AGENTS.local.md` before deciding: `public/index.html` is
served as-is with zero build step (the only compiled artifacts are `src/*.ts`
→ `dist/`; the webapp has no bundler, no `webapp/` package.json, nothing under
`scripts` touches `public/`), and this repo deliberately has no local
node/npm (Docker-only, see `AGENTS.local.md`) — introducing React/JSX/a
bundler purely to reuse `react-leaflet` patterns would be a disproportionate
new dependency surface for one modal. It turned out to be moot either way:
**Leaflet is already loaded** (`leaflet@1.9.4` + `leaflet-routing-machine`
via `<script>`/`<link>` tags near the top of `public/index.html`, plus a
vendored `public/vendor/leaflet.vectorgrid.min.js`) and drives the main
chart map already. So the port is: create a second `L.map()` instance inside
the Data Manager modal, reusing the global `L` the page already loads —
zero new dependencies, zero new build tooling, fully consistent with the
existing "single static HTML file" pattern. Region polygons/backdrop are
rendered from already-local data (`world-countries.json`, catalog
`bounding_box`/`boundary_geometry`) with no additional tile/CDN calls for
this particular map (the main chart map already depends on OSM/OpenSeaMap
tile CDNs elsewhere in this same file, so that dependency is pre-existing,
not new). Click hit-testing is hand-rolled (ray-casting point-in-polygon,
antimeridian-aware, ported from signalk-tidal-currents' `lib/geo.ts`) rather
than relying on Leaflet's topmost-layer click semantics, so overlapping
regions are all matched — same behavior as the React reference without
needing `react-leaflet`'s event model.

Surfaced 2026-07-23: routeiq's own "Data Manager" (region-database download UI,
`public/index.html`, `dm*`-prefixed functions ~line 5828–6300+, modal markup
~line 1337–1490) is list-only — Available/Installed tabs of `.dm-region-card`
rows with a text filter (`dmFilter`) and a per-card Download button
(`dmRenderAvailable`/`dmStartDownload`). It already draws a
`<canvas id="dm-map-canvas">` mini-map (`dmRenderMiniMap`, ~line 5883,
region bboxes/polygons over a bundled `world-countries.json` coastline) but
**the canvas is purely decorative — confirmed no click/mousemove listener is
ever attached to it.** All selection happens via the list below.

The sibling `signalk-tidal-currents` plugin's download manager
(`webapp/src/components/browser/`, React + `react-leaflet`, local-vector-only,
no tile/CDN calls) solves the same "pick a region to download" problem with a
genuinely interactive map, plus several other patterns worth pulling in:

1. **Clickable map as the primary picker** — `SourceMap.tsx` renders every
   catalog region as a `GeoJSON` polygon, styled by type (color) and status
   (fill opacity/dash/stroke — not-installed = faint+dashed, installed =
   solid), with a DOM tooltip on hover (`buildTooltip`). A click hit-tests all
   region geometries at that point (`ClickCapture`/`useMapEvents` +
   `pointInGeometry`) and opens `RegionInspector.tsx`, a modal listing every
   overlapping dataset (handles overlapping global/coastal polygons) — each
   row is a `DownloadButton.tsx` that fires the actual download. routeiq's
   equivalent port: replace `dm-map-canvas`'s static paint with a Leaflet
   `MapContainer` over the existing region bbox/polygon data, add the
   click-hit-test → inspector-modal flow, keep the list view as a secondary/
   fallback picker rather than removing it.
2. **Per-region download progress**, not just one global bar —
   `useDownloadProgress`/`useGlobalDownloadEvents` (SSE with polling
   fallback) drive a live percent/byte badge on each `DownloadButton`.
   routeiq today only has `dmShowProgress`/`dm-progress-text`, one global
   progress element.
3. **Disk-space guardrail before large/unknown-size downloads** —
   `wouldExceedDiskThreshold`/`hasUnknownSizeRisk` pop a confirm modal.
   Relevant to routeiq given US East Coast per-state files can be large.
4. **"Update All" banner + storage gauge + smart-cleanup panel**
   (`UpdateAllBanner.tsx`, `StorageGauge.tsx`, `SmartCleanupPanel.tsx`) —
   surfaces available updates and lets a user reclaim space across all
   installed regions at once, rather than checking/deleting one at a time.
5. **Independent search/filter bar + "zoom to fit all data" control**
   (`QuickFilters.tsx`, `SearchBox.tsx`, `FitAllControl`) — keeps the list
   filter routeiq already has, additionally lets the map itself be
   searched/framed.
6. **"Near you" region surfacing** — `SourceList.tsx` fetches vessel
   position once at startup (`api.getVesselPosition()`, a plain fetch
   against `/signalk/v1/api/vessels/self/navigation/position`, stored in
   the Zustand store) and, in a one-shot effect once both the catalog and
   position are available, auto-expands only the provider groups whose
   region geometry contains the vessel's position
   (`pointInGeometry`, `lib/geo.ts` — ray-casting point-in-polygon with
   antimeridian handling; a containment test, not a distance sort/nearest-N
   list). `SourceMap.tsx` also plots the vessel as a `CircleMarker`, and
   `FitAllControl` frames all visible regions + the vessel in one click. No
   standalone hook — logic lives inline in those two components, both
   reading `vesselPosition` directly from the store. **routeiq port note:**
   WS2/PR4 above already adds a `navigation.position` subscription for
   dynamic database loading — that same subscription is the natural
   position source for this too, so this item should land after/alongside
   PR4 rather than growing its own separate position plumbing. In the
   Data Manager, the port is: auto-expand/highlight (or sort-to-top) the
   region card(s) containing the vessel position, and drop a vessel marker
   on the new Leaflet map from item 1.

Framework decision resolved above (Leaflet, already a dependency — no new
build tooling). **2026-07-24 slice landed item 1** (clickable Leaflet map
replacing `dm-map-canvas` on the Available tab, styled by install status,
ray-cast click hit-test → region-inspector modal reusing the existing
download-card markup, list view kept as fallback) plus a lightweight cut of
item 6 (near-you sort/badge + vessel marker, reusing the webapp's existing
one-shot `fetchBoatData()`/`lastBoat` position rather than adding a second
position-fetch path — no live-subscription wiring yet). Items 2–5 (per-region
progress badges, disk-space guardrail, update-all/storage-gauge/cleanup
panel, independent map search + fit-all control) remain queued, not started.

## Blocked — waiting on pipeline-side work

- **Round 9 master-finding re-verification** — re-time `loadGraph()`
  once the sibling repo populates `boundary_node_ids` for depth-split
  regions. Round 8's 1.84s number was measured while that mechanism was
  structurally disabled for 96% of regions — it will very likely change
  once real. Can't be done before that fix lands.
- **Phase 3 §3f — supernode/macro-edge hierarchical routing** —
  explicitly depends on §3e (scale-out) in the sibling repo first; no
  value hierarchizing a single small region.
- **Phase 4 §4c, Tiers 2-3 — schedule-aware minimum wait / route-choice
  impact** (`feature-bridge-lock-waits.md`) — needs the sibling repo's
  `typical_wait_minutes`/`opening_schedule` `pois` columns and real data
  (§4c there) before there's anything to consume.
- **Round 6's original open item** — closed from this repo's side (see
  below); the remaining work (`_ensure_coastal_connectivity` stitching
  inland nodes at genuine coastal-polygon touchpoints) is 100%
  pipeline-side. Nothing to do here until it lands and produces a new
  database to re-test against.

---

## Round 9 — live route review found a real defect in this repo's own
consumption contract, plus items still needing this repo's own look

Full writeup (with real reproduced numbers, not just theory) is in the
sibling repo's `NEXT_PHASES.md`, "Phase 2 Hardening, Round 9" — this
section is only the triage for what's actually this repo's work.

**The master finding is a pipeline bug, but it was found by reproducing
a route through this repo's own `RoutingEngine.calculateRoute`** — a
real returned route contained a 6,666.75m "segment" with exactly 2
coordinates (a straight chord) and `minDepth=0`. Traced to a stored
`edge_kind_id=1` (navmesh_boundary) edge the format spec explicitly says
should never be directly traversed — real navigability is supposed to
come from `database.ts`'s `precomputeFunnelEdges` upgrade, which turned
out to be silently disabled for 24 of 25 navmesh regions because the
pipeline never populates their `boundary_node_ids`. **The actual fix is
pipeline-side** (make the depth-split boundary contribute to the
seam-coordinate set) — nothing to change in `database.ts`/`routing.ts`
for the root cause itself.

**What genuinely is this repo's work, separate from the pipeline fix**
(also listed under "Ready to start now" above):
1. ~~Isolate Issue B~~ — **done, does not reproduce as described; found a
   different, real, pipeline-side issue instead.** Live-instrumentation
   trace against `data/zeeland.sqlite` (the actual deployed database),
   same method as Rounds 3/4/6:
   - Direct ~10km crossing straddling the Zandkreeksluis lock complex
     (51.550,3.800 → 51.550,3.950), tried both directions, two vessel
     profiles (draft 2.3m/airDraft 11.5m matching the live plugin config,
     and draft 1.2m/airDraft 17.0m matching the required-clearance
     numbers quoted in the original Round 9 report). **In all four runs,
     `calculateRoute`'s `crossings` array includes "Zandkreeksluis, brug
     over buitenhoofd"** — the opening bridge is used every time, never
     skipped. The literal Issue B claim does not hold for this bridge
     against current data; nothing to change in `astarSearch`/
     bridge-avoidance logic here.
   - **A real, different, and significant problem found along the way**:
     both profiles show large route inflation for this short, direct
     crossing (4.73x for the live-plugin profile, **8.73x** — 90.5km for
     a 10.4km straight line — for the taller-air-draft profile), the
     taller one detouring through a completely unrelated lock/bridge
     chain near Vlissingen (Koningin Beatrixbrug, Kleine/Grote Sluis,
     several Arne bridges) before reaching Zandkreeksluis at all. This is
     very likely the real mechanism behind Round 9's Issue A (the
     ~2x-distance southward-loop report) — a taller vessel needs to avoid
     far more fixed bridges, and something is making that avoidance far
     more costly than it should be.
   - **Root cause traced to a specific pipeline-side data-interpretation
     bug, not `astarSearch`**: `zeeland.sqlite` has 58 fixed bridges;
     several — including Koningin Beatrixbrug, one of the two named
     Wilhelminabrug POIs, and the Krammer locks' N-257 bridge — carry
     `"height": 0.0` in their POI properties. Traced this into
     `signalk-router-pipeline/nautical_routing_pipeline.py`'s edge
     air-draft computation (~line 152-158): `_is_valid(verclr)` (line
     30) treats `0.0` as a *valid* clearance reading (it only rejects
     `None`/`NaN`), so `clearance = float(verclr)` becomes exactly `0.0`
     and gets written to the edge's `max_air_draft`. Per the S-57 chart
     spec, `VERCLR=0` conventionally means "vertical clearance not
     surveyed," not "this bridge has zero clearance" — a real bridge
     charted as a navigable crossing with *genuinely* 0m clearance would
     be implausible. The practical effect: any vessel with air draft > 0m
     is hard-blocked from every fixed bridge whose height was never
     surveyed, forcing detours to whichever bridges happen to have a
     real charted height instead — exactly the pattern observed. **This
     is 100% pipeline-side** (the fix belongs in `_poi_properties`/the
     edge-attrs bridge block in `nautical_routing_pipeline.py` — e.g.
     treat `VERCLR=0` the same as "not present," falling back to the
     999.0/unlimited default the "no bridge found" branch already uses).
     Not touched here — the sibling repo has parallel work in flight;
     recording the finding rather than fixing it, per instruction.
2. ~~Design question: should `precomputeFunnelEdges` warn/log on empty
   `boundaryNodeIds`?~~ — **done.** `precomputeFunnelEdges` (`src/database.ts`)
   now `console.warn`s per-region plus a summary count instead of silently
   no-op'ing. Verified live against `data/zeeland.sqlite`: reproduces
   "24/25 navmesh regions have empty boundary_node_ids", matching this
   writeup's own master-finding number exactly. Regression test added:
   `test/navmesh-integration.test.ts`, "empty boundary_node_ids (Round 9
   warn-on-empty)".
   - **Two things found along the way, logged here rather than acted on
     further:**
     - **`region_id` is not a unique key** in the real generated database
       — every one of the 25 navmesh regions in `zeeland.sqlite` has
       `region_id=1` (confirmed directly against the sqlite file, not a
       parsing artifact). The warning logs the in-memory load-order index
       alongside `region_id` as a workaround so individual occurrences are
       distinguishable in logs, but the underlying non-uniqueness is a
       pipeline-side data-shape question — **not fixed here**, since the
       sibling repo has parallel work in flight; whoever owns that schema
       should decide whether `region_id` needs a real per-row identity or
       a separate rowid/PK should be exposed instead.
     - **Unrelated real bug found and fixed**: `RoutingDatabase`'s
       worker-message channel (`src/database.ts` / `src/db-worker.ts`)
       hung `loadGraph()` forever on any database whose `edges` table has
       zero rows. `loadEdges`'s chunked-response protocol only resolves
       the pending promise from a `chunk:true` message; with zero edges
       the worker sends only the trailing `chunk:false` terminator, which
       the client just ignored. Fixed by resolving with `[]` on
       `chunk:false` when no chunks ever arrived. Found because the new
       regression test's minimal fixture legitimately has an empty edges
       table — real pipeline databases always have edges, so this never
       fired in production, but it's a genuine hang for any future
       minimal/synthetic database.
3. **Re-verify load time once the pipeline fix lands, don't assume
   Round 8's 1.84s still holds** (also listed under "Blocked" above):
   that number was measured while the funnel-upgrade mechanism was
   structurally disabled for 96% of regions. Once `boundary_node_ids` is
   fixed, `precomputeFunnelEdges` will actually run for those regions for
   the first time — cost is O(boundary nodes) for the ring upgrade and
   O(anchors²) per region for shortcuts, so this needs the same
   `loadGraph()` timing check Round 4/7/8 all used, not an assumption
   that it's still fine.

## Round 6 — concluded from this repo's side; the remaining work is pipeline-side, not here

The real user-reported bad route (Oude-Tonge to Zierikzee) investigation
that used to be the priority item here is **done being investigated from
`routeiq`** — the live-instrumentation session (this repo's
`round6*.mjs` scratch scripts, `debug_region13.json`/`debug_region16.json`
node-ID watchlists) found the actual root cause: the route's southward
detour runs on `inland_waterways`-sourced graph edges, a separate data
source `_ensure_coastal_connectivity`
(`signalk-router-pipeline/nautical_routing_pipeline.py`) categorically
excludes from all stitching. **This is not a TypeScript bug** — nothing
in `astarSearch`/`navmesh.ts`/`database.ts` is implicated. The temporary
`[DEBUG round6]` logging this repo's `routing.ts` had for the
investigation has already been reverted and confirmed clean.

The `round6*.mjs` scripts and `debug_region13.json`/`debug_region16.json`
(briefly archived in `debug/round6-oude-tonge-zierikzee/`) have since been
deleted — they pointed at a database snapshot that predates the sibling
repo's Round 7/8/9 work and were already broken (relative paths only
valid from the original location; one script referenced a
`zeeland_prerounds4.sqlite` that was never actually present). Nothing of
value was lost: the root cause above is the part worth keeping, and it's
fully captured in prose, not in the scripts.

**The actual open item is 100% in `signalk-router-pipeline`**: whether/how
to let `_ensure_coastal_connectivity` stitch inland nodes to a coastal
component when they genuinely touch its polygon boundary (not a blanket
merge — see that repo's `NEXT_PHASES.md` §5.2.2 for the specific,
scoped recommendation). Nothing to do here until it lands.

## Forward design (Phase 3+)

Detailed design for what comes after the current Phase 2 Hardening work
lives in the sibling repo's
[`PHASE_3_DESIGN.md`](../signalk-router-pipeline/PHASE_3_DESIGN.md). Most
of it (data fusion, overrides, vessel-traffic validation, scale-out) is
pipeline-side and doesn't touch this repo — but **§3f, supernode/
macro-edge hierarchical routing, is a real `routeiq` change**: a coarse
supernode-graph search mode in `astarSearch` (sparse long-haul routing
over `edge_kind_id=3` macro-edges, already reserved in the schema but
unpopulated, falling back to today's full-resolution search only for
first-mile/last-mile legs). Not started; depends on §3e (scale-out) first
per that document's dependency ordering — no value hierarchizing a single
small region.

There's also
[`PHASE_4_DESIGN.md`](../signalk-router-pipeline/PHASE_4_DESIGN.md) in
the sibling repo, and **§4a there is entirely a `routeiq` change** (§4b
and §4c are pipeline/router-data-side): position- and route-aware dynamic
database loading, replacing `RoutingDatabase.init()`'s current
unconditional "open every `.sqlite` in the directory" behavior with a
peek-then-lazy-load model driven by vessel position and route requests.
Not started; independent of everything in Phase 3, but most valuable once
more than one real region exists locally at once.

**§4c's `routeiq`-side consumption is designed separately in this
repo**, `feature-bridge-lock-waits.md` — modeling bridge/lock waiting
time so routes aren't assumed instant-passage, phased in three tiers
(flat-constant ETA correction → schedule-aware minimum wait → full
route-choice impact). Tier 1 needs no pipeline data; Tiers 2-3 do. See
`todo.md`'s "Open — Routing features" item 3.

## Round 11 — real returned routes never show a curved navmesh-interior path: found and precisely located, not fixed yet

User's own hypothesis from a live screenshot (a route with a large,
clearly wrong circular loop through the Oosterschelde): "I'm pretty sure
it does not take any route inside the navmesh, just remains at the
boundaries." Investigated directly rather than theorizing further —
reproduced the exact route (start/via/dest from the screenshot) against
the current best pipeline build (post Round 9 + Round 10's lock fix) and
classified every returned segment's geometry: **270 straight 2-point
segments, 0 curved multi-point segments.** Not "mostly boundary, some
interior" — literally zero funnel-computed interior geometry anywhere in
the route.

**This is not the master finding regressing.** Added temporary
diagnostic counters to `upgradeRingBoundaryEdges` (reverted after use,
same live-instrumentation discipline as every prior round) and confirmed
the funnel-upgrade mechanism itself works perfectly: every region logged
`total=N upgraded=N nullResult=0 guardRejected=0` — a 100% success rate.
`Navmesh.funnelBetweenNodes` is being called, succeeding, and correctly
assigning real `path_points` to both ring-adjacency and anchor-shortcut
edges in memory, exactly as designed.

**Root cause, found by reading the actual path-reconstruction code,
`buildRouteResult`/`aggregateSegmentEdges` (`src/database.ts`)**: when
the search's path-smoothing step produces two consecutive path nodes
that don't have a *direct* edge between them (common — path smoothing
consolidates a long raw path into fewer, more direct hops, which
routinely spans what used to be several ring/shortcut edges),
`buildRouteResult` falls back to `this.db.aggregateSegmentEdges(prevNode,
currNode, originalPath)` (`database.ts:1037`). That function correctly
aggregates `distance`/`min_depth`/`max_air_draft`/`min_width`/
`cost_factor`/`traffic_mode` across every underlying edge it walks — but
**its returned object has no `path_points` field at all**. Back in
`buildRouteResult`, the `if (edge.path_points && edge.path_points.length
> 0)` check (line 1895) then always takes the `else` branch for these
aggregated edges, pushing a flat 2-point segment regardless of how many
real, curved, funnel-computed edges got aggregated underneath. Whenever
path-smoothing spans a funnel-upgraded stretch — which is routine for
any real crossing of a navmesh region — its curve is silently discarded.

**Important distinction, don't conflate with the still-open inflation
investigation**: `aggregateSegmentEdges`'s summed `distance` IS real
(sums actual underlying edge distances), and `buildRouteResult` uses
that real distance for `totalDistance`/cost. So this bug is very likely
**not** the cause of the Zandkreeksluis/Issue-A distance inflation
Round 10 was chasing — the route-*choice* and its reported distance
are probably still accurate. This is a distinct, separate bug: the
*drawn* geometry misrepresents the *chosen* path, which is its own real
problem (a rendered route that visually looks like it might cross land
or take an illogical loop, even when the underlying chosen path and its
distance are correct) and directly explains the user's screenshot and
Round 9's Issue D, but should be verified/fixed on its own terms, not
assumed to also resolve the inflation numbers.

**Not yet fixed**: `aggregateSegmentEdges` needs to either (a) return a
concatenated `path_points` array built from each underlying edge's own
points (correct but more work — must stitch multiple edges' points
together in the right order/direction), or (b) `buildRouteResult`'s
smoothed-path branch needs a different strategy entirely for edges with
real interior geometry (e.g. don't smooth across a funnel-upgraded edge
in the first place). Needs its own investigation into which of those is
right, plus a real before/after check (do the same segment-geometry
classification done here, confirm curved segments actually appear,
confirm total distance doesn't change) before considering it done.

## Round 12 — aggregateSegmentEdges fixed to carry real path_points; confirmed correct, but this route's own path barely exercises it

Investigated (a) vs (b) before touching anything, per Round 11's own
"needs its own investigation" note. `smoothPath` (`routing.ts`) already
has a "never string-pull across a funnel-augmented hop" guard — added
back in `bfd3560`, well before Round 11 — that explicitly refuses to LOS-
skip over any hop whose direct edge carries `path_points`. So option (b)
is *already implemented* for `smoothPath` specifically. But it's dead in
practice: `smoothPath` only runs when `config.lineOfSightSearchRadius` is
non-zero, and that defaults to `0` in both `DEFAULT_CONFIG` (`types.ts`)
and the live plugin's own saved config
(`/home/node/.signalk/plugin-config-data/signalk-routeiq.json`) — so
`smoothPath` returns its input unchanged and the guard never runs. The
actual gap-creator, confirmed by instrumenting both, is
**`compressCollinear`** (`routing.ts`), an earlier, *ungated* pre-pass
that always runs and has zero awareness of `path_points` — it drops a
path node whenever it sits within 2m of the straight line between its
neighbors, purely by node position, with no check on the geometry of the
edges either side of it. That's the real source of the two-consecutive-
smoothed-nodes-with-no-direct-edge gaps `aggregateSegmentEdges` has to
paper over. Given that, teaching `compressCollinear` about `path_points`
would only close one of the gap sources (and duplicates logic
`aggregateSegmentEdges` needs to keep anyway for other cases, e.g.
disconnected-graph bridging) — **option (a) is the right fix**: make
`aggregateSegmentEdges` itself always reconstruct the true geometry,
regardless of why the gap exists.

**Fix**: `aggregateSegmentEdges` (`database.ts`) now builds a `pathPoints`
array while it walks the underlying edges — for each underlying edge, its
own `path_points` (if any) followed by the coordinate of the next
original-path node (except after the final edge, whose target is `toNode`
itself, added separately by `buildRouteResult` the same way it already
handles a single direct edge). No direction-flipping logic was needed:
`upgradeRingBoundaryEdges`/`addFunnelShortcutEdge` already store each
direction of an edge as its own row with independently-correct
`path_points` orientation (confirmed by reading both, and re-confirmed by
a direct reverse-direction test below), so `getEdgeSync(source, target)`
always returns points already oriented `source→target` — the same
invariant `buildRouteResult` already relies on for un-aggregated edges.

**Verified mechanically correct**, independent of any real route: found a
genuine `A→B→C` chain in `data/zeeland_round10_locks.sqlite` where both
`A→B` and `B→C` are real funnel-upgraded edges with their own
`path_points`, and no direct `A→C` edge exists. Calling
`aggregateSegmentEdges(A, C, [A,B,C])` directly returns `distance` exactly
equal to the sum of the two edges' distances, and `path_points` of exactly
the expected length (`A→B`'s 2 interior points + `B`'s own coordinate +
`B→C`'s 2 interior points = 5), in the correct order. Ran the mirror-image
`C→B→A` aggregation too — distance identical, points correctly ordered in
reverse — confirming the "no reversal needed" reasoning above rather than
just assuming it.

**Verified against the full pipeline build**: rebuilt (`npx tsc`, Docker
node:22 pattern) and ran the full suite — 41/41 pass, same as before the
change. Reproduced the exact Round 11 route (Oude-Tonge start, via point,
near-Zierikzee destination; draft 1.5m/beam 5.0m/airDraft 17.3m) against
`data/zeeland_round10_locks.sqlite`:

| | before | after |
|---|---|---|
| smoothed-path hops | 266 | 266 (unchanged — fix is display-only) |
| flat (1 sub-segment) hops | 264 | 186 |
| curved (>1 sub-segment) hops | 2 | 80 |
| rendered 2-point features | 270 | 396 |
| `route.totalDistance` | 51633.33 | 51633.33 (byte-identical) |
| `route.totalCost` | 12002425269.136288 | 12002425269.136288 (byte-identical) |

Distance/cost being exactly unchanged confirms this is purely a
display/geometry fix, as expected — it doesn't touch route choice or the
Round 10 distance-inflation investigation.

**Honest caveat, found by checking under the hood rather than trusting
the hop-count improvement alone**: of the 80 hops that gained extra
points, *none* of their underlying edges actually carry real funnel
`path_points` — checked directly (0 of the 206 underlying edges spanned
by those 80 aggregation calls have `path_points` themselves). What's
rendering now is the real intermediate graph nodes `compressCollinear`
had dropped (correct — those are genuine path vertices, not just curve
interior — but they're near-collinear by construction of the 2m
threshold, so visually this specific improvement is subtle, not a
dramatic new curve). Went further and measured the *entire* raw A* path
for both legs of this route: 393 edges total, only 3 are
`edge_kind_id=1` (`EDGE_KIND_NAVMESH_BOUNDARY`) boundary/anchor edges, and
literally 0 of those 3 fall inside any of the 80 aggregated spans. So for
this specific route, on this specific database, the "real curved
navmesh-interior path" the Round 11 title asks about still doesn't
visibly appear — not because the fix doesn't work (the isolated
`A→B→C` test above proves it does, byte-exact), but because this route's
chosen path barely touches navmesh-upgraded edges at all despite ~99% of
its nodes geographically sitting inside a navmesh region's polygon
(measured: 149/150 and 242/243 raw-path nodes have `regionId != 0`). It
travels almost entirely via `edge_kind_id=0` ("centerline") edges instead.

That's a different, new observation from anything Round 9-11 measured:
not "the route hugs region boundaries" but "the route barely uses the
navmesh graph construct at all, preferring whatever centerline edges
happen to be nearby, even deep inside a region's footprint." Whether
that's correct (real charted channels legitimately running through open
water) or a route-*choice* bug (A* under-preferring cheaper funnel
shortcuts for some cost/heuristic reason) is exactly the kind of question
Round 10's still-open inflation investigation should fold in — flagging
it here rather than guessing further, per this round's scope being
display-correctness only, not route choice.

## Round 13 — "route follows the navmesh outer contour": root cause is pipeline-side (single-point region attachment), routeiq confirmed working

Full writeup in the sibling repo's `NEXT_PHASES.md`, "Phase 2 Hardening,
Round 13". Summary of what was established **from this repo's side**
(probes in `scratch_round13/*.mjs`, run against
`zeeland_round10_locks.sqlite` with this repo at `a4a0db5`):

- **This repo's navmesh machinery works**: `precomputeFunnelEdges` runs
  for 15/15 regions, same-region funnel crossing returns 1.18x
  straight-line at cost == distance, in-memory shortcut edges carry sane
  attributes. Nothing to fix here for the core defect.
- **The defect is graph data**: a pure-distance Dijkstra over the loaded
  graph (penalties ignored) reproduces the same giant detours the engine
  returns (27km for a 6.8km crossing) using zero shortcut/funnel edges —
  navmesh regions attach to the rest of the graph at ~1 point
  (`_stitch_component_pieces`'s union-find rejection, pipeline-side).
- **The live server runs a stale Round-8-era database** (24/25 empty
  `boundary_node_ids`) — the funnel mechanism is entirely disabled in
  production regardless of any code fix. Redeploy needed once the
  pipeline fix lands.
- Secondary, flagged for later rounds: 25% of centerline edges carry
  `min_depth=0` (charted drying/0-band floor), each eating the
  `+1e6 × meters` soft penalty for every real vessel — the source of the
  recurring "depth 0.0m" warnings and 1e10-scale costs; and the penalty
  × edge-length scaling structurally favors many short penalized edges
  over one long one.

**Rounds 14+15 (next session, user-diagnosed fairway issue): waterway↔navmesh
connection implemented pipeline-side, verified, deployed.** Waterway
crossing points are now seam-tagged navmesh boundary nodes, and inland
nodes inside coastal water participate in stitching (§5.2.2 resolved).
Probe C: 7,801m (1.15x, zero penalized meters); probe B (original bug
report): 37,274m, matching the pre-regression historical best. 41/41
tests, loadGraph 1.94s, no lock bypass (200 requires_lock edges). Live
server now runs the Round 15 build (backup:
`data/zeeland_pre_round15.sqlite.bak`). Remaining top items are now
routeiq-relevant: `min_depth=0` data poisoning and `getEdgePenalty`'s
1e6×meters penalty scaling (a 211m flagged edge = 211,000km-equivalent —
Round 14's interim regression showed the cliff). Probe scripts:
`scratch_round13/probe5-7.mjs` (hard-constraint cut analysis). Full
write-up: sibling repo `NEXT_PHASES.md`, "Rounds 14+15".

**Outcome (same session): fixed pipeline-side ("Pass 0c" local-adjacency
guarantee in `_stitch_component_pieces`), verified, and deployed.** The
6.8km cross-Oosterschelde probe went 33,703m → 10,489m (1.54x
straight-line) and now traverses real anchor shortcuts; region external
attachment edges went 135 → 2,395 across the 15 regions; 41/41 tests
pass; `loadGraph()` 1.72s (unchanged band). The live server now runs the
Round 13 database (old one backed up as
`data/zeeland_pre_round13.sqlite.bak`) and starts with zero
empty-`boundary_node_ids` warnings. Full write-up: sibling repo
`NEXT_PHASES.md`, "Round 13 outcome". The min_depth=0 and inland-detour
items above remain open follow-ups.

## Round 15 follow-up — reported "route through a fixed bridge" (Oude-Tonge → 51.4991,4.0670): reproduced, route is actually correct; the confusion is crossing naming

Reproduced twice against the deployed Round 15 database (default config
AND live config: coast distance 0.5nm, air margin 0.3, path-API dims
draft 1.2/air 17.0): 37.8-38.2km, crossings list "Krammer locks, bridge
in the N-257" twice, no air-draft warning. Coordinate-level check: the
route crosses the N-257 line at **51.66115,4.16180 — exactly the charted
"opening" (movable) span POI** of the southern Krammer lock. Physically
correct routing.

**The real, smaller issue this surfaced**: the Krammer complex has SIX
identically-named bridge POIs ("Krammer locks, bridge in the N-257"):
2 opening spans + 4 fixed spans (charted heights 0.0 / 0.1 / 0.1 / 18.4m
— S-57 gives every span the same OBJNAM). The webapp's crossing
label/marker cannot distinguish them, so a correct opening-span crossing
can read as "went through a fixed bridge". Improvement candidates (not
implemented): (a) append the span subtype and height to crossing names
("… (opening span)" / "… (fixed, 18.4m)"), (b) attach the crossing to
the span POI nearest the actual crossing coordinate, (c) dedupe the
double-listed crossing. Also noted: fixed spans charted height=0.1
escape Issue K's `VERCLR=0` fallback by design and correctly block as
0.1m — those are the dam/gate sections, working as intended.

## Round 16 — reported canal route through two fixed bridges: root-caused to bbox-expansion-never-fires-on-penalized-results; fixed, tested, deployed (uncommitted)

Follow-up to the Round 15 "fixed bridge" report: the user's screenshot
(same start/dest, Oude-Tonge → 51.4991,4.0670) showed a 23.9nmi route
down the Schelde-Rijn canal crossing Vossemeerbrug + Tholensebrug (both
fixed, 9.8m) against a required 17.3m air draft — NOT the correct
Krammer-locks route my earlier repro produced. Systematic elimination
(same DB generation × overlay × config permutations, scripts
`scratch_round13/probe10-12.mjs`): the databases and the user-edits
overlay were all innocent; **the flip is `routingBBoxMargin: 0.1` (live
user setting; default 1.0) alone**. The correct route's Keeten/Mastgat
stretch dips to lon 3.9602 — ~500m outside the 0.1-margin search box
(west edge 3.9670) — and the engine's bbox-expansion loop **only fired
on total failure, never on "found only a heavily-penalized route"**, so
a 5.70e8-cost route (two fixed-bridge violations) silently won over the
1.52e8 clean route just outside the box.

**Fix (`src/routing.ts`)**: `PENALIZED_RESULT_RETRY_FACTOR = 100` +
`isMateriallyPenalized()` (`totalCost > totalDistance × 100` — any
1e6-scale penalty trips it, legitimate cost never does); both the main
search loop and the via-leg loop now treat a materially-penalized
success like a failure: expand the bbox and retry, keep the lower-cost
result, stop on clean result / max extent / no improvement between
attempts (the stall check matters: even correct routes can carry a
minor depth-warning leg, so without it every such route would expand
to max extent). New regression test `test/bbox-penalty-retry.test.ts`
(clean-detour-outside-tight-bbox synthetic; also asserts the graceful
fallback still returns the penalized route when max extent genuinely
prevents reaching the clean one). 43/43 tests. Verified on the real
scenario: with the live 0.1 margin the route now returns the Krammer
result (38,161m, no air-draft warning); margin-1.0 and probes B/C
unchanged. Deployed (server restarted).

**Follow-up (user decision): `routingBBoxMargin`/`routingBBoxMaxExtent`
removed from the settings schema entirely** — they're internal search
tuning, not user-facing. `start()` now strips both keys from any
previously-persisted config before merging, so stale saved values (like
the frozen old 0.1 default that caused this whole round) can never
override the engine defaults again. Verified live: saved JSON still
contains 0.1, loaded config correctly shows 1.0. 43/43 tests.

Also shipped this session (separate user request): **debug coordinate
readout** in the webapp (`public/index.html`) — when the existing
"Debug logging" toggle is on, a bottom-right overlay shows live cursor
lat/lon (5 decimals) plus the last-clicked coordinate with a
copy-to-clipboard button; passive listeners, no interference with
existing map click handlers.

## Round 17 — "near-identical routes, one shows 20x shallow" report: warning dash painted at the wrong place (webapp index misalignment); fixed + verified

User report (two screenshots, near-identical routes, one with 17
"depth 0.0m" legs and an orange dashed stretch in the Keeten, one
clean). Reproduced both exactly (`scratch_round13/probe13/14.mjs`).
Two findings:

1. **The warnings themselves are genuine and destination-dependent, not
   nondeterministic**: all 17 flagged legs are charted DRVAL1 0/0.5/1.0m
   bands in the *final approach* to the first route's destination, which
   sits at the edge of the Verdronken Land van Zuid-Beveland drying
   flats (51.49-51.50, 4.10-4.13). The second route's destination (2.5km
   NW) approaches through deep water — correctly zero warnings. The
   shared corridor is clean in both.
2. **The orange dash was painted mid-route (Keeten) instead of at those
   approach legs — a real webapp bug**: `getAllCoords` concatenated
   per-segment 2-point features WITHOUT deduplicating shared seam
   coordinates (every interior point doubled), while `renderCustomRoute`'s
   warning-index mapping advanced its cursor assuming deduped coords —
   so warning flags landed at ~half their true position along the
   route. Fixed by deduplicating consecutive identical coordinates once
   in `getAllCoords` (all consumers — hover sync, itinerary snapping,
   major-node extraction, legacy segment mapping — checked and now
   consistent; also removes spurious zero-length "turns" at seam
   points). Scripted verification (`scratch_round13/verify_index_fix.mjs`):
   all 17 warning transitions now within the genuine shallow zone, none
   north of 51.56; clean route has zero; pre-fix control reproduced the
   misplacement exactly.

Also noticed in passing (not fixed, out of scope): the very short
`B→C` funnel shortcut edge found for the isolated test above has a
duplicate point within its own `path_points` (`[51.590306932259715,
3.8902612867207584]` appears twice consecutively) — looks like a
pre-existing degenerate case in the funnel algorithm for very short
edges, unrelated to this fix (`aggregateSegmentEdges` just concatenates
whatever each edge already stores). Worth a look if anyone's touching
`Navmesh.funnelBetweenNodes` next.

## Rounds 18+19 — NOAA-scale data fixes + penalty rescale (both verified, merged, deployed)

**Round 18 (pipeline, commit 9e0d45e there)**: Puerto Rico (154 NOAA ENC
cells) exposed two data-scaling defects — multi-scale DEPARE cell overlap
made the first-containing-polygon depth sampler pick effectively random
bands (65.7% of PR edges min_depth=0), and 2,835 obstruction points
hard-blocked the north coast outright. Fixed: per-sample-point max-DRVAL1
among containing polygons; obstructions downgraded to depth constraints
where sounded (VALSOU) or always-underwater (WATLEV 3/4), hard block kept
for dry/awash/unknown. PR: depth-0 65.7%->17.3%, obstacle blocks
3,990->12, San Juan->Fajardo NO ROUTE -> 93.6km. Zeeland unchanged — its
residual 1.0-1.5m flags verified as genuine charted depth.

**Round 19 (this repo, merge of round19-penalty-rescale, 45/45 tests)**:
soft-constraint penalties rescaled from +1e6 x meters (a 211m flagged
edge ~ 211,000km-equivalent — the Round 14 regression class) to per-class
per-meter rates: VIOLATION_RATE_CONSTRAINT=300 (depth/air/beam),
VIOLATION_RATE_COAST=50. Bbox penalized-result retry now triggers on
explicit violating-meters tracking (scale-independent), best-result
comparator is lexicographic (fewer violating meters, then cost). Route
choices verified unchanged on all guards (Krammer via locks, Zeelandbrug
opening, probes B/C); costs deflated ~3000x to meaningful magnitudes.

**Deployed multi-region**: zeeland.sqlite (r18) + puertorico.sqlite (r18)
loaded together — 63,619 nodes / 247,728 edges / 560 POIs, PR's known
1/12 empty-boundary region logged loudly. Zeeland backup:
zeeland_pre_round18.sqlite.bak.

## Rounds 20+21 — crossing span naming + Issue G; Phase 2 Hardening backlog CLEARED

**Round 20 (this repo, merge of round20-crossing-naming, 45/45)**:
`detectCrossings` now attaches the geometrically nearest same-named span
POI, merges same-name runs within 300m route distance, and appends span
info to crossing names — "Krammer locks, bridge in the N-257 (opening
span)" instead of the same bare name twice. Webapp/plotter badges skip
redundant suffixes. Verified on real data: the deduped crossing is the
opening POI 14.3m from the true crossing point.

**Round 21 (pipeline, commit 1e327ae there)**: Issue G fixed — the
depth-split closing no longer erases genuine enclosed drying/shallow
separators (Yerseke: 0 -> 14/15 holes survive, 99.9% by area), scoped to
interior rings so Round 8's fragmentation fix cannot regress. All
structural/probe gates pass. Secondary: the Zeelandbrug air-flagged
ring edges were confirmed CORRECT DATA (genuine VERCLR=11.0 fixed-span
intersections) — closed as working-as-intended, not a bug.

**Deployed**: zeeland.sqlite = round21 build + merged R19/R20 dist;
multi-region with puertorico.sqlite (64,520 nodes / 251,054 edges).
Backup: zeeland_pre_round21.sqlite.bak.

**Phase 2 Hardening status after Rounds 13-21: no open correctness
items.** Remaining known-and-accepted: PR's 1/12 empty-boundary region
(logged loudly at load), PR offshore fragment components, and genuine
charted-shallow warnings that are now correctly priced and correctly
drawn. Next real work is Phase 3 (PHASE_3_DESIGN.md) / Phase 4
(PHASE_4_DESIGN.md).

## Negative charted depths are read as "unknown" — OPEN, cross-repo, safety-relevant

Found 2026-08-12 while testing tide-aware depth against the live server.

`min_depth < 0` means "unknown, exempt from every constraint check" throughout
`routing.ts` (the sites are listed in the tide-depth work). But DEPARE depths
are legitimately negative: a bank that dries 2 m above chart datum is -2.0, and
that is a real, useful survey value — it is exactly the water a tide opens.

**Both meanings are already in shipped data.** Measured over `data/us_east_ct.sqlite`
(108,445 edges): `min_depth = -1` on **4** edges, and `min_depth < 0 AND <> -1`
on **94**, down to **-6.0 m**. So 94 edges that dry as much as six meters above
datum are currently treated as unknown and are freely routable at any state of
tide. That is a permissive hole that exists today, with or without tide-aware
depth. (`data/zeeland.sqlite`, schema_version 1, is worse in a different way:
137,350 edges, no negatives at all and a floor of exactly 0.0 — the sign was
discarded upstream, so nothing downstream can recover it.)

**The fix is a distinct unknown sentinel — `-999`** (Marcel's suggestion), so
negatives can mean what they say. Sequencing matters, because it cannot be done
from this repo alone:

1. **Pipeline** emits `-999` for unknown and preserves real drying heights,
   and bumps `metadata.schema_version`.
2. **routeiq** gates on that version: at or above it, unknown is `-999` and any
   other negative is a drying height; below it, `< 0` stays unknown as today.

**Do not reinterpret `-1` unilaterally.** It is the pipeline's current
`UNKNOWN_DEPTH` and newer regional builds lean on it heavily — STITCHING_DESIGN
§10.8 records unknown fractions of 73.9% (NH), 42.2% (RI), 32.8% (CT) after the
depth-band fix. Reading those as "dries 1 m" would make most of a region
impassable overnight.

**Interim step available now, and safe on every existing build:** treat
`min_depth < 0 && min_depth !== -1` as a real drying height, leaving exactly
`-1` as unknown. That constrains the 94 CT edges correctly without touching the
`-1` population, needs no schema change, and composes with tide-aware depth —
a -2.0 m bank becomes passable once the tide clears 2.0 m + draft + margin,
which is the "open shallow edges near HW" case the design was written for. The
residual collision is a bank drying exactly 1.0 m, which stays unknown; that is
today's behavior for it either way. Drop the special case once the pipeline
moves to `-999`.

**Consequence for the tide feature meanwhile:** on data whose depths are
floored at 0 (schema_version 1, e.g. `zeeland.sqlite`), a reported passage
depth can overstate the real water by the drying height — 0.0 + 4.3 m of tide
reads as 4.3 m where a bank drying 1.5 m really carries 2.8 m. The arithmetic
is right; the input has already lost the sign.

## Round 23 — deployed: tiled ocean regions + real edge geometry

Pipeline tiling (sibling 7aa98d9) killed the PR giant-region cost:
loadGraph 76.6s -> 8.8s, server startup-to-ready 32s for both regions —
the post-restart "route timeout" window is effectively gone. This
repo's 48b2da5 (merged) carries path_points through the graph-edges
debug API and draws real curves — the Ceiba "land-crossing navmesh"
artifact is closed. Known trade-off documented in the sibling repo:
+10.6% on very long open-ocean routes from tile-seam crossings;
revisit via anchor/hierarchy work (Phase 3f) or the tile-size knob.

## Round 24 — "segments is not iterable" crash on via routes (fixed, 8013a66)

Live user report on PR: "Routing failed: finalResult.features[0]
.properties.segments is not iterable". Root cause (pre-existing, made
easy to hit by PR's 482 disconnected offshore fragments): when a
via-route LEG lands in tryRouteSegment's disconnected-graph fallback,
fallbackRoute finalized the leg result — splitToSegmentFeatures strips
properties.segments — and routeViaPoints' merge crashed. Fix:
finalize flag (leg call passes false; via pipeline finalizes once on
the merged result; leg fallback now also receives the tidal env).
Regression test test/via-disconnected-leg.test.ts reproduces the exact
error pre-fix; 46/46 post-fix. Deployed.

## 2026-08-08 — Bounded penalty retry, falsy-zero vessel dimensions (`285bb3a`)

Found while investigating a cross-database route that returned **242,299 m for
an 18,406 m straight line with no warnings at all**. The merged graph held a
clean 27.4 km path the whole time — this was never a stitching problem.

**1. `isBetterCandidate` traded distance for compliance without bound.** It
ordered candidates strictly by violating meters, so a fully-compliant route beat
a shorter one carrying any violation, at any length. For that request it
preferred a 242 km clean route over a 36 km one with 3.6 km of "shallow" water
— most of which was a coarse DEPARE band (`DRVAL1=0, DRVAL2=18.2`: 0 is the
band floor, not a survey) rather than real shoal. New config
**`maxPenaltyDetourRatio`** (default **3.0**) bounds it: past the ratio the
shorter route wins and its violations surface as `via_constrained` warnings the
helm can act on. Set it to 0 for the old unbounded behavior. Result on that
request: 242,299 m → 41,643 m, with the 2,980 m of shallow water now *reported*
instead of silently avoided. Paired with the pipeline's depth-band fix
(`signalk-router-pipeline` `5931458`): **25,589 m, ×1.39, zero violating meters.**

**2. `(dims.draft || 2.0)` treated a draft of 0 as 2.0 m.** Nine call sites in
`routing.ts`, including `pathViolationMeters`; same falsy-zero on beam
(`|| 4.0`), and in `api.ts` an explicitly configured safety margin of 0 was
overridden by the default. All switched to `??`. Consequence worth knowing: every
"unconstrained vessel" measurement in STITCHING_DESIGN §8–§10 was really taken
at 2.3 m required depth. Connectivity conclusions are unaffected (graph
reachability never consults vessel dimensions); the route-parity ratios there
carry that implicit constraint.

131/131 tests pass.

### Related finding — ADDRESSED 2026-08-10: an unstitched seam fails silently

`coverage_gap`, a distinct `RouteWarning` type raised in place of
`start_connecting`/`end_connecting` once the connector exceeds
`coverageGapMeters` (default **1500 m**, 0 = off). Threshold sits in the empty
band between the measurements below: healthy connectors ran 4–893 m (§10.2's
real cross-state routes), teleports 3,485–4,597 m. **Internal, not in the
settings schema** — same treatment as `routingBBoxMargin`. The default needs no
per-deployment tuning, since the two populations are three-and-a-half times
apart, and the plugin config is already a candidate for *fewer* knobs
(`todo.md`, "Open — smaller/unscoped notes").

Ruled out as an alternative: pricing the leg through the cost function instead
of thresholding it. A land-crossing edge is already rejected outright
(`getEdgePenalty` returns -1 on `crosses_land`), so that lever is at maximum
already; and the connector is not an edge at all. `connectUserPoint` runs
*after* the search, prepending a synthetic `from: -1, to: -1` segment for a
requested point that is not on the graph, so there is nothing for A* to price.
`markOverland` does test the leg with `isLineCrossingLand` and marks it, but
these teleports are over open sea between two regions' coverage, where the
land test correctly finds nothing. The failure is uncharted water, not land.

Why a new type rather than a flag on the old one: **this repo's own webapp
drops `start_connecting`/`end_connecting` from the warnings pane outright**
(`public/app.js`, the `continue` at the top of the warnings loop) — right for
45 m, badly wrong for 4 km, and it meant a teleport was invisible to the helm.
A distinct type falls through to the generic renderer with no webapp change.
One warning per leg, not two, so a client filtering the routine type by name
cannot hide this one with it. The route is still returned — a straight line
over uncharted water may be perfectly navigable; it just has to say so.

Fixed in passing: the append-path `end_connecting` reported `nodeToSnap` as
its `distanceMeters` (travel along the last real edge) while its message
quoted `edgeSnap.distance` (the unverified straight line). The straight line
is the leg the warning is about, and now the one it reports.

Original finding, kept for the measurements:

When no graph path crosses a seam, `calculateRoute` does not fail — it projects
the start onto the nearest reachable waterway, which may be **on the far side of
the seam**, and joins it with a straight line: measured legs of **3,485–4,597 m**
carrying `minDepth: -1` (so constraint checks are bypassed), flagged only as
`start_connecting`. One such route came back *shorter* than the single-file
baseline (×0.89) by cutting the corner. Route distance alone is therefore a
useless stitching metric — graph reachability is the instrument. routeiq should
distinguish "routed across a seam" from "teleported over a gap"; a multi-km
connector leg is a data-coverage failure, not a connection.
