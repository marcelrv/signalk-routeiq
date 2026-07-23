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

> **STITCHING MECHANISM: see [`signalk-router-pipeline/STITCHING_DESIGN.md`](../signalk-router-pipeline/STITCHING_DESIGN.md)**
> (design note, for review). Two experiments (2026-07-20) ruled out
> build-time seam-ID coincidence; the recommended mechanism is a routeiq
> **runtime proximity matcher** (overlap band + closest-node-first
> connectors), paused pending user review before implementation.
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
> unstarted — treat it as reference/spec, not a to-do.** Genuinely
> remaining work: (1) **pipeline** build-phase overlap + seam-node
> coincidence (`signalk-router-pipeline`, see its NEXT_PHASES "Next
> milestone" — the real stitching work); (2) a routeiq **coincident-node
> merge + edge-dedupe test** (the merge path exists but is untested for
> shared IDs and has no explicit identical-edge dedupe); (3) optional
> **position-triggered** auto-load/evict + `loadRadiusNm`/`unloadAfterIdleNm`/
> `maxLoadedRegions` (not implemented; on-demand route loading already
> covers correctness).

### Dynamic-loading UX follow-ups (surfaced 2026-07-21, live testing)

Flipping `dynamicLoading` default-on (committed `3bfbcd0`) fixed the
multi-region OOM but introduced a real UX regression: with many installed
regions and nothing triggered, **startup loads nothing**, so the webapp
reads as "no databases" even though every region is peeked with valid
coverage. Hit live during Round 25 stitched-pair testing. Fixes, in
priority order:

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
