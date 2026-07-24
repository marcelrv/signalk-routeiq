# RouteIQ Plugin — Architecture Review (2026-07-24)

Scope: the TypeScript runtime plugin in this repo (`src/index.ts`, `src/api.ts`,
`src/database.ts`, `src/db-worker.ts`, plus the routing/tides layers). Findings
are grouped by severity. The three **high-severity** items have a remediation
plan (below); the **medium** and **low** items are documented here as a durable
backlog record with file:line anchors and a suggested fix each.

Line numbers are as of this review — treat them as a starting point, not a
guarantee, once code moves.

---

## Remediation plan — high-severity items

There are three high-severity findings. **H3 is independent and small** — do it
first as a standalone security patch. **H1 and H2 are the same problem** (four
endpoints exist because there are four in-memory stores) and must be fixed
together, as a staged refactor.

> **Progress (2026-07-24) — all three high-severity items DONE:**
> - **H3 — DONE**, commit `b75ec12`. `requireAuth` added to
>   `/databases/download`; CORS comment corrected. (This also resolves **M1**.)
> - **H1/H2 Stage 1 — DONE**, commit `dc86b03`. `coverageIndex` is the single
>   source of truth; `loadedDbFilenames`, `cachedDatabaseList`, and
>   `metadataCache` removed; all read models derive from it; regression test
>   added.
> - **H1/H2 Stage 3 (endpoint merge) — DONE**, commit `dcd0393`. Four read
>   endpoints → two: canonical `GET /databases` (`getDatabaseCatalog`) + the
>   `GET /databases/status` boot poller; `/databases/loaded` and
>   `/graph/databases` deleted; both frontend merge sites collapsed to one
>   fetch. Verified live against the container (unified shape served, removed
>   routes 404). 60/60 tests pass.
> - **NOT yet done — Stage 2 (retire the second worker in `reloadMetadata`).**
>   The Stage 1 change repointed `reloadMetadata` to merge into `coverageIndex`
>   but left its second-`Worker` spawn in place. That cleanup is tracked as
>   **M2** below, not done here.

### H3 — Unauthenticated destructive database download (do first)

**Problem.** `handleDownloadDatabase` (POST `/databases/download`,
`src/api.ts:936`) deletes **all** existing `.sqlite` files (`src/api.ts:1000-1009`)
and hot-reloads the engine, with **no `requireAuth()` check** — unlike every
graph-edit endpoint and `/databases/delete` (`src/api.ts:1150`). Only SSRF
origin-validation is present. Any request that reaches the server can wipe and
replace the routing database.

**Plan (single small PR, ~1 hour):**
1. Add `if (!this.requireAuth(req, res)) return;` as the first line of
   `handleDownloadDatabase`, matching `/databases/delete`.
2. Audit the other mutation endpoints for the same gap while here. Current
   `requireAuth` callers: overlay/repair, node/edge upsert+delete,
   `/databases/load`, `/databases/unload`, `/databases/delete`. Download is the
   one mutation missing it — confirm nothing else writes state without it.
3. Fix the misleading CORS comment (`src/api.ts:60-77`) in the same PR — see
   **M1**; the comment is what disguised this gap.
4. Test: with SK security enabled, an unauthenticated POST to
   `/databases/download` must return 401; an admin token must still succeed.

**Risk:** low. The webapp already sends the SK auth cookie/Bearer, so an
authenticated admin download is unaffected. Only unauthenticated callers change
behavior (they should never have worked).

---

### H1 + H2 — Four overlapping "databases" endpoints, backed by six mirrored stores

**Problem.**
- **H1 (endpoints):** `GET /databases` (`getDatabaseInfo`), `GET /graph/databases`
  (`getDatabaseList`), `GET /databases/loaded` (`getCoverageStatus`), and
  `GET /databases/status` (`getLoadingStatus`) all describe the same installed/
  loaded database set (filenames, bboxes, stats, load state) from four different
  backing collections. The frontend carries comments reconciling them
  (`public/index.html:2800`, `:6509`).
- **H2 (state):** those collections — `metadataCache`, `cachedDatabaseList`,
  `coverageIndex`, `loadedDbFilenames`, plus `nodesByDbIndex` / `nodeDbCount`
  (`src/database.ts:146-206`) — are hand-synced on every load/unload/reload
  (`src/database.ts:1000-1003`, `:1071-1075`). They can drift; this is the root
  cause of H1.

**Target design.** One authoritative per-database record keyed by filename —
extend the existing `DatabaseCoverageEntry` / `coverageIndex` to be *the* store
(it already holds filename, path, bbox, boundary, state, dbIndex, meta, stats).
Everything else becomes a derived view.

```ts
// coverageIndex: Map<filename, DatabaseRecord>  ← single source of truth
// Derived (computed, not stored):
//   loadedFilenames()  = [...records].filter(state==='loaded').map(filename)
//   databaseList()     = [...records].filter(loaded).map({index:dbIndex,filename,path})
//   metadata()         = [...records].map(r => r.meta + r.stats)
```

**Staged plan** (each stage is independently shippable and keeps the 56-test
suite green):

**Stage 1 — collapse the read models behind the coverage index (no API change).**
- Make `getDatabaseInfo`, `getDatabaseList`, `getLoadingStatus` compute their
  result from `coverageIndex` instead of `metadataCache` / `cachedDatabaseList` /
  `loadedDbFilenames`.
- Delete the now-unused private fields once nothing reads them. Keep
  `nodesByDbIndex` / `nodeDbCount` — those are the *graph* provenance refcounts,
  a legitimately separate concern from the DB catalog; they stay.
- The four endpoints keep returning their current JSON shapes (derived now), so
  the frontend is untouched. Regression-test each endpoint's payload before/after.

**Stage 2 — retire the redundant second worker (folds in M2).**
- `reloadMetadata` (`src/database.ts:401-451`) spawns a *second* Worker to
  re-read metadata after a download. With one store, refresh the coverage index
  via the existing worker's `peekMetadata`/`getMetadata` instead, and delete the
  second-worker plumbing. (The download path hot-reloads the whole DB right after
  anyway — `src/api.ts:1015-1032` — so this call is largely redundant.)

**Stage 3 (final) — merge the two rich catalog endpoints, delete the dead one,
migrate the frontend, in a single change.** No alias/deprecation window: RouteIQ
is unpublished and the only consumer is `public/index.html`.

Scope refined after reading the frontend consumers:
- **Merge `GET /databases` + `GET /databases/loaded` → one canonical
  `GET /databases`.** These are the two the Data Manager fetches *together* and
  reconciles client-side (`fetchCoverage`, `:2813`+`:5898` and `:6606`). The
  canonical endpoint returns one record per **installed** database:
  `{ filename, state, coverage (bbox), dbIndex, stats, ...meta }` (meta incl.
  `boundingBox`/`boundaryGeometry`/`tags`/name/country). Update both frontend
  merge sites to a single fetch; delete the reconciliation logic/comments
  (`:2800`, `:6599`). Delete the `/databases/loaded` route + `getCoverageStatus`.
- **Delete `GET /graph/databases` + `getDatabaseList`** — not referenced anywhere
  in `public/` (dead), and `dbIndex` is now available on the canonical record for
  any future editor use.
- **KEEP `GET /databases/status`** (`getLoadingStatus`). It is NOT catalog
  duplication — it is the lightweight boot poller the loading overlay hits every
  ~1.5s (`:4092`), returning `{ loaded, filenames, available, initError }` and a
  200 even when the DB isn't ready so `initError` can surface. Different purpose,
  different response contract; post-Stage-2 it already derives from
  `coverageIndex`, so no drift. Folding it into a full catalog would risk the boot
  path and make startup poll a heavy payload.
- **KEEP the action endpoints:** `/databases/available`, `/databases/download`,
  `/databases/load`, `/databases/unload`, `/databases/delete` — operations, not
  catalog reads.

Net: 4 read endpoints → 2 (a canonical catalog + a boot-status probe), and the
frontend's dual-fetch reconciliation goes away.

**Sequencing & risk.** Stages 1–2 (done) were pure internal refactor — lowest
risk, and they made this mechanical: with one backing store, the merge is mostly
deleting a route and pointing the UI at the survivor. The remaining risk is
entirely in the frontend (the Data Manager UI must keep rendering install/load
state correctly) — verify live against the running `signalk-server` container
after the change. H3 was done first (unrelated, urgent).

**Tests to add.** A load → unload → reload cycle asserting all four read models
report consistent filenames/states from the single store; a download-refresh test
asserting no second worker is spawned (Stage 2).

---

## Medium-severity findings (documented backlog)

> **Status (2026-07-24) — M1–M7 DONE, M8 open.** All verified with the Docker
> build+test (64/64) and a live smoke test against the container (boot poller,
> `/databases` catalog, and a real `POST /route` returning a 71-waypoint route
> that exercised on-demand loading + the grid changes).
> - **M1** — done in `b75ec12` (H3): CORS comment corrected.
> - **M2** — `bc4d202`: `reloadMetadata` reuses the main worker's `peekMetadata`;
>   second `Worker` removed.
> - **M3** — `bc4d202`: duplicate `haversineDistance` deleted.
> - **M4** — `be74ea7`: node queries routed through the grid (cos(lat) superset,
>   identical results; POI/edge queries left full-scan — follow-up).
> - **M5** — `0e7608e`: optional `maxLoadedRegions` LRU cap (default 0 = off).
>   The load-timeout half was intentionally skipped (worker sqlite read is
>   synchronous and can't be safely aborted) — still open as a sub-item.
> - **M6** — `be74ea7`: spatial grid maintained incrementally; full rebuild kept
>   only for the bulk `loadGraph()`.
> - **M7** — `f01e9de`: SK app/request/engine seams typed via narrow interfaces
>   instead of `as any`.
> - **M8** — NOT done (overlay-merge invariant hardening); left as backlog.

### M1 — CORS is used as if it were authorization
`src/api.ts:60-77`. The comment claims mutation routes omit
`Access-Control-Allow-Origin` so "browsers block unauthenticated cross-origin
writes." CORS restricts browser JS only — it is not server-side auth and does not
stop `curl`/native clients. The real gate is `requireAuth`. This false assurance
is how **H3** slipped through (download was left out of `CORS_SAFE_POSTS` but that
protects nothing). **Fix:** rewrite the comment to state plainly that
authorization is `requireAuth` and CORS is only about which origins the browser
webapp may read from; ensure every mutation has `requireAuth`.

### M2 — `reloadMetadata()` spawns a second worker and re-implements the RPC protocol
`src/database.ts:401-451`. Creates a new `Worker`, its own `pending` map, msgId
counter, and message handler — duplicating the main transport
(`src/database.ts:226-293`) — plus a `setTimeout(100)` terminate hack. Largely
redundant with the post-download hot-reload. **Fix:** folded into H1 **Stage 2**
— refresh via the existing worker and delete this method.

### M3 — `RoutingDatabase` is a ~2,000-line god object
`src/database.ts`. Owns worker RPC transport, in-memory graph store, spatial grid,
navmesh/funnel precomputation, land/waterway GeoJSON + raycast point-in-polygon,
and the dynamic load/unload lifecycle. `haversineMeters` (`:1503`) and
`haversineDistance` (`:1562`) are byte-identical duplicates. **Fix:** extract
`GeometryUtils` (haversine, projectOnEdge, bbox tests), `LandMask`
(`isLineCrossingLand` + raycast + bbox index, `:1843-1961`), `SpatialIndex`, and
a `WorkerClient` transport. Start by de-duplicating the two haversines (trivial,
zero-risk).

### M4 — Hot-path queries full-scan the collection despite a spatial index existing
`src/database.ts`. `findNearestNode` (`:1124`), `getNodesInRadius` (`:1174`),
`findKNearestMainGraphNodes` (`:1143`), `getNodesInBBox` (`:1391`),
`getPoisInBBox` (`:1464`), `getEdgesInBBox` (`:1411`), `getNearestPoi` (`:1484`),
and `searchPois` (`:1348`) iterate every node/edge/POI per call. The
`spatialGrid` is only consulted by `findNearestEdge`/`hasNodeWithinRadius`.
Additionally the bbox/POI methods `break` at `limit` **before** sorting, so a
capped query returns arbitrary rows rather than the nearest/best. **Fix:** route
point/radius/bbox queries through the grid; sort-then-slice so `limit` is
meaningful. Scales with multi-region loads.

### M5 — Cold region loads run synchronously on the route request path
`src/database.ts:778-826` (`ensureRegionsLoaded` / `ensureRegionsForBbox`).
`await loadDatabaseGraph` mid-request reads an entire sqlite into memory, rebuilds
the spatial index, and recomputes funnel edges — so the first route into a cold
region can block for seconds with no timeout. There is **no cap** on loaded
regions/memory (the "load cap" TODO). **Fix:** bound the working set (LRU evict by
`maxLoadedRegions`); add a load budget/timeout; consider surfacing "loading" to
the client instead of blocking.

### M6 — `buildSpatialIndex()` fully rebuilt on every incremental mutation
`src/database.ts:1546`. Rebuilt after each per-file load (`:975`), each unload
(`:1069`), and each `addNode` (which `.clear()`s then rebuilds, `:1756-1757`).
Loading 5 regions rebuilds the whole grid 5 times, and it is rarely read anyway
(see M4). **Fix:** insert incrementally into the grid on load; remove the
affected cells on unload.

### M7 — Pervasive `as any` at the SignalK integration seams
`app as any` for `getSelfPath`/`subscriptionmanager`/`resourcesApi`
(`src/index.ts:377`, `src/api.ts:391`), `req as any` for
`skIsAuthenticated`/`skPrincipal` (`src/api.ts:611`), `(engine as any)`
(`src/api.ts:451-453`). Type safety is discarded exactly where the SK server
contract is most likely to shift between versions. **Fix:** declare narrow local
interfaces for the SK surfaces actually used (a `SkApp`, `SkAuthedRequest`) and
cast once at the boundary.

### M8 — Overlay (user-edits) merge invariant is process-global and comment-protected
`src/database.ts:919-923`, `:998`. Correctness depends on `overlayMergedOnce`
being true after exactly one merge across the whole process; every subsequent
per-file load must pass `includeOverlay=false` or edges duplicate in
`edgesBySource`. Deleted-node/edge filters are also refetched and re-scanned on
every per-file load. Enforced only by prose. **Fix:** merge the overlay in a
dedicated step decoupled from region loads, or track merged-state per structure
so the invariant is structural rather than a boolean + comments.

---

## Low-severity findings (documented backlog)

### L1 — Inconsistent readiness contracts across handlers
Some handlers check `isReady()` (db **and** engine), others only `this.db`
(`handleNearestPoi`, `handleWaterways`, `handleListDatabases`), and
`handleDatabasesStatus` returns **200 with an error field** while its siblings
return 503 (`src/api.ts:879-893`). Clients face three different "not ready"
shapes. **Fix:** standardize on one readiness helper and one not-ready response
shape; document which endpoints are intentionally db-only.

### L2 — `res.json(...)` followed by `next(error)` double-handling
~15 handlers send a response and then call `next(error)`, forwarding to Express
error middleware after headers are sent (e.g. `handleSearch` `src/api.ts:333-334`,
`handleStats` `:421-423`). `handleRoute` explicitly warns against this
(`src/api.ts:232`) but the rest did not follow suit. **Fix:** drop the trailing
`next(error)` in handlers that already responded; log instead if needed.

### L3 — Module-level singletons + encapsulation breach
`database`/`routingEngine`/`apiHandler` are module-level `let`s
(`src/index.ts:21-23`), so only one plugin instance can exist, and `stop()` nulls
private fields via `(apiHandler as any).db = null` (`src/index.ts:158-159`)
despite `setComponents` existing. **Fix:** add a symmetric
`apiHandler.clearComponents()`; consider encapsulating the trio in an object the
constructor owns rather than module scope.

### L4 — "stats" means two different things
`/stats` returns in-memory **union** totals (`getStats`, `src/database.ts:1370`);
`/databases` reports **per-file** counts from the worker's `readStatsRow`. Same
word, different semantics, surfaced side by side. **Fix:** rename or document the
distinction in the payloads (e.g. `loadedTotals` vs per-record `stats`).

---

## Suggested order of work

1. **H3** — auth on download (standalone security patch, ~1h) + M1 comment fix.
2. **H1/H2 Stage 1** — collapse read models behind `coverageIndex` (internal, no
   API change). Highest payoff, lowest external risk.
3. **M3 quick win** — delete the duplicate haversine; extract `GeometryUtils`.
4. **H1/H2 Stages 2–4** — retire the second worker (M2), canonicalize `/databases`,
   migrate the frontend, remove aliases.
5. **M4 / M6** — grid-backed queries + incremental index (perf, scales with
   multi-region).
6. Remaining medium/low as capacity allows.
</content>
</invoke>
