# Feature: Bridge & lock waiting times

## Problem

The router currently assumes every opening bridge and lock crossing is
instant — an edge with `is_opening_bridge_edge` set (or a lock crossing,
which today isn't even distinctly flagged on the edge — see Data model
below) costs exactly its distance, same as open water. Real openings take
real time: a movable bridge might only open on request or on a fixed
cycle, a lock takes minutes to cycle traffic through regardless of
schedule. This matters more than it looks like once tidal-current-aware
routing (`feature-tidal-routing.md`) is in the picture: every downstream
current/depth sample after an unmodeled bridge/lock delay is computed at
the *wrong* clock time, so the tide-awareness the router already has gets
quietly less accurate the more bridges/locks a route crosses before the
point being evaluated.

Three tiers, roughly in the order the user proposed and in implementation
order — each is independently useful, none blocks route quality on the
next one existing:

1. **ETA-only impact** — a wait delay changes the reported arrival time
   and every downstream tide/current sample, but never changes *which*
   route is chosen.
2. **Schedule-aware minimum wait** — given real opening-hours/cycle data,
   compute "arrive whenever, but you can't pass before time X" instead of
   a flat guess.
3. **Route-choice impact** — wait cost becomes a real A* cost term, so a
   route through a lock with a long expected queue can lose to a longer
   route around it, the way a car navigator treats a traffic jam.

## Data model (pipeline + `router-data`, not this repo)

Today: bridges get a real, precise opening-point edge
(`_add_opening_bridge_edges`, `nautical_routing_pipeline.py`) but no wait
estimate at all. Locks are even less complete — `locks_gdf` is only
consulted in `_edge_attr_worker` to annotate an edge's attributes, there's
no dedicated lock-crossing edge marker the way `is_opening_bridge_edge`
exists for bridges (confirmed by reading the code — worth its own small
fix regardless of this feature, since a lock currently isn't
identifiable on an edge at all).

New, first-class fields needed on the relevant `pois` rows (`type_id`
`lock`/`bridge`) — **not** buried in the free-form `properties` JSON
(format spec §2.10) the way display-only attributes are, since these are
consumed by a cost function, not just shown to a user:

- `typical_wait_minutes REAL` — a single scalar estimate, tier-appropriate
  (see below).
- `opening_schedule TEXT (JSON)`, shape TBD but roughly:
  `[{ "days": ["mon","tue",...], "windows": [{"start":"06:00","end":"22:00"}], "interval_minutes": 30 }]`
  — covers both "fixed operating hours" and "opens on a cycle within those
  hours" bridges/locks, which covers the common real cases better than a
  single open/close pair would.

**This is a natural, concrete use case for the community override
workflow already designed in `PHASE_3_DESIGN.md` §3c** — official
ENC/IENC data essentially never carries real-world operational wait
times or schedules, so this data starts life as tier-6/community-sourced
almost by definition, gets reviewed the same way any other override does,
and is a good early real test of that workflow once it exists. Written up
as **PHASE_4_DESIGN.md §4c** in the sibling repo — read that for the
schema/override-schema details; this doc only covers the `autoroute`
consumption side.

## Architecture (this repo)

### Tier 1 — constant wait, ETA-only (do first)

The time-dependent A* machinery `feature-tidal-routing.md` added is the
right hook, already in place: `astarSearch` tracks per-node elapsed time
(`tSec`) and uses it to sample the tidal flow field at the right clock
time per edge (`routing.ts` ~1483-1500). Extending `edgeSeconds` for an
opening-bridge/lock edge is a small, local change — no new architecture:

```ts
// alongside the existing tidal edgeSeconds computation
if (edge.is_opening_bridge_edge || edge.requires_lock) {
  edgeSeconds += waitMinutesFor(edge) * 60;
}
```

For tier 1, `waitMinutesFor(edge)` is just a **config constant**
(`defaultBridgeWaitMinutes`, `defaultLockWaitMinutes`) — the "wild guess"
the user described, applied uniformly. Crucially, at this tier the extra
`edgeSeconds` feeds `tSec`/arrival-time propagation **only** — it does
**not** get added to `effDistance`/`edgeCost`, so route choice is
provably unaffected (same route as today, just a more honest ETA and more
accurate downstream tide sampling). This makes tier 1 safe to ship well
before tiers 2-3 are ready, and is the direct fix for the accuracy
problem described above.

### Tier 2 — schedule-aware minimum wait

Once `opening_schedule` data exists (per-POI, sourced via the override
workflow), `waitMinutesFor(edge)` becomes time-aware: given the edge's
estimated arrival time (`env.departureMs + (env.offsetSec + elapsed) * 1000`,
the same value already computed for tidal sampling), look up the next
valid opening window/cycle slot at or after that time and return the
difference. Still ETA-only at this tier (same "don't touch `effDistance`"
rule as tier 1) — "we at least know we won't be there any earlier," per
the user's framing, is a lower-bound correction to the ETA, not yet a
route-choice input.

### Tier 3 — route-choice impact

Fold the wait delay into `effDistance` the same way tidal current already
is (`effDistance = edge.distance × env.speedMs / sog` — wait time
composes the same way as an equivalent-distance penalty:
`effDistance += waitSeconds × env.speedMs`), so `calculateEdgeCost` sees
it and a long-expected-wait crossing can genuinely lose to a longer route
around it — the "traffic jam" behavior the user asked for.

**Correctness constraint that must hold before this tier ships, stated
explicitly because this project has already found three separate real A*
correctness bugs this way (Round 3, `NEXT_PHASES.md`)**: the wait function
must be **FIFO** — arriving later at a bridge/lock must never let you
depart earlier than arriving sooner would have. A schedule with regular
fixed-interval openings is naturally FIFO (later arrival ⇒ same or later
departure). A schedule with irregular/on-request openings could
technically violate this in edge cases; if it can, standard Dijkstra/A*'s
optimality guarantee no longer holds and the search would need a real
time-dependent-shortest-path adaptation, not just a bigger edge cost. Test
this explicitly against real schedule data before enabling tier 3, the
same way Round 3's SSFA/goal-test bugs were only caught by a real
automated regression test, not code review alone.

### API / config / UI (additive, all tiers)

- `RoutingRequest`: no new required fields — wait modeling is always-on
  once tier 1 ships (a 0-minute default is indistinguishable from today's
  behavior), same "off = bit-identical to today" principle
  `feature-tidal-routing.md` established for tides.
- Config (`src/index.ts`): `defaultBridgeWaitMinutes` (number, default
  TBD — needs a real-world reference value, not invented here),
  `defaultLockWaitMinutes` (likely higher than bridges — a lock cycles
  traffic, a bridge just needs to swing/lift), `considerBridgeLockWaits`
  (bool, default true — unlike tides this isn't optional per-request
  behavior a user toggles, it's just "how accurate is the ETA," so it
  should default on once tier 1 lands).
- Result additions: per-segment `waitSeconds` (0 when not applicable),
  surfaced in the itinerary the same way `seconds`/`currentKn` already are
  for tidal legs (`src/itinerary.ts`).
- Webapp/plotter: a wait indicator on the relevant leg ("+15 min wait —
  Zeelandbrug"), same visual treatment as the existing tide delta
  (`+0:25 tide`) in `feature-tidal-routing.md`'s summary line.

## Phasing

1. **Tier 1** — config constants, `edgeSeconds` extension, ETA/itinerary
   surfacing. No pipeline/schema change needed at all — ships against
   today's data using just the two config constants.
2. **Pipeline/`router-data` side** — `typical_wait_minutes`/
   `opening_schedule` schema fields, lock-crossing edge marker (the
   missing `is_opening_bridge_edge` analog for locks), first real
   community-sourced values via the override workflow. See
   `PHASE_4_DESIGN.md` §4c in the sibling repo.
3. **Tier 2** — schedule-aware minimum wait, once #2 has real data to
   query.
4. **Tier 3** — route-choice impact, only after the FIFO correctness
   check above, and only once real schedule data (not just a constant)
   makes the distinction between "always waits ~15 min" and "sometimes
   waits 2 hours" meaningful enough to be worth a route detour.
