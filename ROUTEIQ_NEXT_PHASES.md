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
