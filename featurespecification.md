# Project Specification: SignalK Open-Source Nautical Route Planner

## 1. Project Overview
This project is an offline-first, vessel-aware nautical route planner designed to run natively as a webapp and plugin within the Signal K ecosystem. Optimized for inland waterways and coastal navigation, it dynamically calculates safe routes based on a vessel's physical dimensions (draft, beam, air draft) and user safety preferences.

To ensure high performance on low-power devices (like a Raspberry Pi), the heavy processing of raw vector charts (S-57/ENCs) is abstracted to an external cloud data-pipeline. The vessel downloads a lightweight, highly compressed "Routing Database" (SQLite) to perform instantaneous offline routing.

---

## 2. Core Routing Logic & The Cost Function
The heart of the router is a **Directed A* (A-Star) Pathfinding Algorithm**. Unlike a car router that only looks at distance, this algorithm evaluates every potential segment of water (an "Edge") using a multi-layered cost and safety function.

**Step 1: Hard Safety Constraints (The segment is discarded if:)**
*   `edge.min_depth < vessel.draft` (negative min_depth values are treated as unknown data gaps and pass through — see Section 2a)
*   `edge.max_air_draft < vessel.airDraft` (negative values pass through)
*   `edge.min_width < vessel.beam` (negative values pass through)
*   `edge.distance_to_land < user_min_coast_distance` (for coastal/sea routing)

**Step 2: The Cost Calculation (If the segment is safe, how "good" is it?)**
$$ Cost = Distance \times FairwayMultiplier \times DirectionalPenalty $$

*   **Fairway Multiplier:** Edges inside official buoyed waterways (e.g., Dutch RWS data) get a multiplier of `0.8` (preferred). Open-water grid segments get `1.2` (usable, but not preferred).
*   **Directional Penalty:** The graph is *directed*. Traveling on the starboard side of a separated channel has a multiplier of `1.0`. Traveling the wrong way (port side) gets a massive penalty (e.g., `5.0`), forcing the router to respect the BPR (Binnenvaartpolitiereglement) rules.

---

## 2a. Data Gap Handling
The routing graph is generated from S-57/ENC data. Some edges may have unknown or unset values for `min_depth`, `min_width`, or `max_air_draft` (stored as negative sentinel values like `-50`, `-4`, `-2`).

**Rule:** Any negative constraint value is treated as an *unknown data gap* — the edge is considered passable for that constraint. This prevents sentinel values from creating artificial disconnections in the graph.

---

## 2b. Fallback Routing & Warnings
When the A* algorithm cannot find a route between the start and end point (due to disconnected graph components, vessel dimension constraints, or coast distance constraints), the router automatically falls back to a **partial route** with warnings.

**Fallback logic:**

1. **Same component, constraints block:** If the start and end nodes are in the same connected component but safety constraints (draft, beam, coast distance) block all paths, the router retries with all constraints zeroed (draft=0, beam=0, airDraft=0, coastDistance=0). The returned route includes a warning explaining which constraints were relaxed.

2. **Different components:** If the start and end nodes are in disconnected graph components, the router finds the nearest node in the start's component to the destination ("bridge node"), routes to it via A*, and appends a straight-line segment. The response includes a warning describing the disconnected destination.

3. **Start in tiny component:** If the start node is in a tiny isolated component (<10 nodes), a separate warning is emitted.

**Response format:**
```json
{
  "type": "FeatureCollection",
  "warnings": [
    {
      "type": "end_unreachable",
      "message": "Route constrained by vessel dimensions (draft=1.9m, beam=1.9m) or coast distance. The route shown ignores some constraints — verify each segment is safe for your vessel.",
      "from": { "latitude": 51.66, "longitude": 4.20 },
      "to": { "latitude": 51.66, "longitude": 4.35 },
      "distanceMeters": 12927
    }
  ],
  "features": [ ... ]
}
```

Warning types:
- `start_unreachable`: Start is disconnected from the main graph. First segment is a straight line to the nearest reachable point.
- `end_unreachable`: End is disconnected or constraints block the route. Last segment is a straight line or constraints were relaxed.
- `both_unreachable`: Neither start nor end is connected to a shared navigable network.

---

## 2c. Nearest-Node Selection
When the user clicks a location, the router must find the nearest graph node. Rather than picking the absolute nearest (which could be in a tiny disconnected component), the router:
1. Finds the 50 nearest nodes within 5000m
2. Among those, selects the one with the highest out-degree (number of outgoing edges)
3. Tie-breaks by distance

This heuristic avoids selecting isolated nodes in tiny disconnected components and dramatically improves routing success.

---

## 2e. Path Smoothing (String Pulling)
Grid-based A* routing produces a staircase or zig-zag pattern in open water because the algorithm can only move in 45°/90° increments through the graph nodes. To eliminate this blockiness, the router applies a **greedy string-pulling algorithm** as a post-processing step after A* finds the path.

**How it works:**
1. After A* reconstructs the raw node path, `smoothPath()` iterates through the nodes with a greedy lookahead.
2. For each anchor node, it checks the furthest reachable node ahead to see if a direct straight line has clear **line-of-sight** — meaning the straight line doesn't cross any land or unmapped area.
3. Line-of-sight is verified by sampling points along the great-circle line at configurable intervals (default ~500m) and checking each sample has a graph node within the search radius (default 800m) via an in-memory spatial grid index. If a sample has no nearby node, the line would cross land — the shortcut is rejected.
4. When a clear line-of-sight is found, all intermediate nodes between anchor and lookahead are removed from the final path.
5. Segment metadata (min depth, max air draft, width) for shortcut edges is aggregated from all original edges along the skipped sub-path, preserving conservative safety values.

**Result:** The output GeoJSON contains far fewer coordinates in open-water sections, with smooth straight lines across open water while maintaining constraint-safety along official fairway channels.

**Spatial index:** The `RoutingDatabase` builds a grid-based spatial index (0.01° cells ≈ 1km) over all graph nodes after `loadGraph()` completes, enabling fast O(1) nearest-node lookups for line-of-sight checking without SQL queries.

---

## 2f. Adaptive Grid Resolution (Quadtree)

Instead of a fixed 0.01° grid, the coastal navmesh uses **recursive quadtree subdivision** to create variable-density nodes that adapt to local water body narrowness.

**Resolution tiers:**

| Narrowness (free-water radius) | Grid resolution | Approx spacing |
|-------------------------------|----------------|----------------|
| > 5 km (open sea) | 0.005° | ~500 m |
| 2 – 5 km | 0.0025° | ~250 m |
| 1 – 2 km | 0.001° | ~100 m |
| 0.2 – 1 km | 0.0005° | ~50 m |
| < 0.2 km (narrow channel) | 0.0002° | ~20 m |

**Subdivision criteria:**
A quadtree cell is subdivided (up to 12 levels deep) if any of:
- It contains an inland waterway centerline → subdivide to min resolution
- The cell center is on land but the cell has water → subdivide to follow coastline
- Narrowness (minimum distance to nearest land) < 5× the cell width → channel is too tight for this cell size
- Cell spans a land/water boundary → subdivide to capture the geometry

**Node connection:** All coastal nodes are connected to neighbors within `1.5 × local_resolution` using a spatial grid index, creating a smooth mesh that bridges resolution boundaries. Inland and coastal networks are cross-connected where they overlap.

---

## 2g. Bounding-Box Search Pruning

To keep A* fast despite the denser graph, each route search is constrained to a **bounding box** around the start and end points.

**Strategy:**
1. Compute initial bounding box with a configurable margin (default 0.1° ≈ 11km)
2. During A* expansion, skip any edge whose target node falls outside the box
3. If A* fails to reach the destination, **double the margin** and retry
4. Continue doubling up to the configured maximum extent (default 10°)
5. If all bbox attempts fail, fall back to the unconstrained full-graph A* (for disconnected components)

Results include a `warnings` entry if the box had to expand significantly, informing the user.

---

## 2d. Per-Request Vessel Dimensions
Users can override vessel dimensions per route request via `draft`, `beam`, and `airDraft` fields in the POST body. These overrides:
- Are applied only for that single request
- Do NOT mutate the engine's default dimensions (which come from the plugin config)
- Are restored after each request via a `try/finally` block

---

## Part 1: The Cloud Graph Generator (Data Pipeline)
**Purpose:** A standalone Python pipeline that ingests complex maritime vector data and outputs a mathematically navigable Directed Graph.

*   **Input Data:** S-57 ENCs and official Waterway centerlines (e.g., from the Dutch Hydrographic Office and Rijkswaterstaat).
*   **Technology Stack:** Python, GDAL/OGR (Geospatial parsing), NetworkX, SQLite.
*   **Processing Logic:**
    1.  **Parse Vector Data:** Extract Depth Areas, Bridges, Locks, and official Fairways.
    2.  **Generate the Directed Network:**
        *   *Inland:* Map the centerlines. For separated channels, create parallel directional paths.
        *   *Coastal:* Generate a Navigation Mesh (triangles or grid) across open water.
    3.  **Calculate Distance to Land:** For every open-water node/edge, calculate its closest distance to a land polygon and store it as `distance_to_land`.
    4.  **Apply Attributes:** Every Directed Edge (Node A $\rightarrow$ Node B) receives: `distance`, `min_depth`, `max_air_draft`, `min_width`, `is_fairway` (boolean), `direction_penalty`, and `distance_to_land`.
    5.  **Extract POIs:** Compile marinas, locks, buoys, and towns for offline searching.
*   **Output:** A highly compressed `routing_graph.sqlite` database containing Tables for `Nodes`, `Edges`, and `POIs`.

---

## Part 2: The Signal K Backend Plugin (The Router)
**Purpose:** A Node.js plugin running on the vessel's Signal K server. It holds the SQLite database in memory and provides the API for the frontend.

*   **Technology Stack:** Node.js (22+), TypeScript, `node:sqlite` (Node's built-in SQLite — no external dependencies), customized A* pathfinding algorithm with string-pulling path smoothing.
*   **Core Responsibilities:**
    1.  **Vessel Parameters:** On initialization, read the vessel's dimensions from the plugin configuration (`defaultDraft`, `defaultBeam`, `defaultAirDraft`) and subscribe to live updates from the Signal K delta tree (`vessels.self.design.draft`, `design.beam`, `design.airDraft`).
    2.  **Execute Pathfinding:** Listen for requests, apply the Cost Function (detailed in Section 2), apply string-pulling path smoothing (Section 2e), attempt fallback routing if no path is found (Section 2b), and return smooth GeoJSON with optional warnings.
    3.  **Config Persistence:** The `ApiHandler` and its Express routes survive stop/start cycles. On config save (Admin UI), only the `RoutingEngine` is recreated with the new config values — routes stay registered.

*   **Plugin Configuration (Admin UI):**
    - `routingDatabase`: Path to the SQLite routing graph
    - `defaultDraft` (m), `defaultBeam` (m), `defaultAirDraft` (m): Vessel defaults
    - `defaultCoastDistance` (NM): Default minimum distance from shore
    - `fairwayMultiplier`, `openWaterMultiplier`, `wrongWayPenalty`: Cost function coefficients
    - `routingBBoxMargin` (degrees): Initial A* bounding-box margin (0.1 ≈ 11km)
    - `routingBBoxMaxExtent` (degrees): Max bounding-box extent before full-graph fallback
    - `lineOfSightSampleInterval` (m): Sample spacing for string-pulling line-of-sight check
    - `lineOfSightSearchRadius` (m): Node search radius for line-of-sight verification
    - All dimension fields use `multipleOf: 0.1` for fine-grained control

*   **API Endpoints:**
    - `POST /signalk/v1/api/router/route`:
      Accepts Start, End, Via-Waypoints, `minCoastDistance`, and optional `draft`/`beam`/`airDraft` overrides.
      Returns GeoJSON FeatureCollection with optional `warnings` array (see Sections 2b, 2d).
      Accepts both `{lat, lng}` (Leaflet) and `{latitude, longitude}` formats.
    - `GET /signalk/v1/api/router/search?q=...`: Queries the POI table for offline text-based geocoding.
    - `POST /signalk/v1/api/router/export/gpx`: Takes the calculated route and returns a formatted `.gpx` file.
    - `POST /signalk/v1/api/router/push`: Formats the GeoJSON into the Signal K Route specification. (Note: currently returns 405 as the SK server's delta PUT handler does not support writing to `resources.routes.*`.)
    - `GET /signalk/v1/api/router/vessel`: Returns the current vessel dimensions from the routing engine.
    - `PUT /signalk/v1/api/router/vessel`: Overrides vessel dimensions for testing (persists until next start/config change).

*   **Error Responses:**
    - `400`: Missing or invalid parameters
    - `404`: Route truly not found (no fallback possible) with `code: "ROUTE_NOT_FOUND"` and descriptive message
    - `503`: Engine still initializing (database loading)

---

## Part 3: The Interactive WebApp (Frontend UI)
**Purpose:** The user-facing application hosted by the Signal K server, accessible via any browser on the boat's network.

*   **Technology Stack:** HTML, CSS, JavaScript, Leaflet.js, Leaflet Routing Machine.
*   **Core Features:**
    1.  **Map Display:** Renders the map using offline `.mbtiles` or standard online map tiles.
    2.  **Click-and-Drag UI:**
        *   Right-click map to set Start/End points.
        *   Click and drag the generated route line to dynamically create Via-Points (waypoints). Reroutes automatically.
    3.  **Offline Text Search:** Search bar to find ports, locks, or buoys, utilizing the backend POI database.
    4.  **Routing Parameters Panel:** Allows the user to override defaults:
        *   Override Draft / Air Draft (useful if heavily loaded or mast is down).
        *   **Minimum Coastline Distance:** A slider/input (e.g., "Keep at least 1 NM from shore").
    5.  **Warning Display:** When the route response contains a `warnings` array, the UI should display each warning to the user (e.g., as a notification or route instruction overlay). Warnings guide the user to manually navigate teleported sections or verify constraint compliance.
    6.  **Export Controls:**
        *   `[ Download GPX ]`: Saves the route locally to the user's tablet/PC.
                 *   `[ Activate Route in Signal K ]`: Pushes the route to the Signal K resources API so standard navigation software (OpenCPN, WilhelmSK, plotters) can steer the autopilot.

### 7. Route Details Pane (Collapsible Right Sidebar)
A collapsible route information panel sits on the right side of the screen, positioned between the Settings panel and Export panel.

**Collapse/Expand:** A small tab on the left edge of the pane toggles between collapsed (tab only) and expanded (full 300px panel). The pane auto-expands when a new route is calculated.

**Smart Node Culling:** Rather than showing every coordinate, the pane uses a **bearing-change threshold** algorithm to extract only major waypoints:
- For each point, the bearing change between incoming and outgoing segments is computed.
- Points with a bearing change above a **dynamic threshold** are kept as major nodes.
- Threshold adapts to route length: ~21° for short routes (2 km), up to 50° for long routes (50+ km).
- Hard cap of 15 nodes; when exceeded, the weakest turns are dropped first.
- Start and destination are always included.

**Per-Node Display:** Each major node shows a label (Start, Turn N, or Destination), turn angle badge (e.g. `34° R`), coordinates in decimal degrees, and cumulative distance from start with heading arrow.

**Expandable Leg Details:** Clicking a node row expands/collapses the leg segment below it, showing distance (m), minimum depth (m), minimum width (m), and maximum air draft (m) — aggregated from the backend segment data. Legs with shallow (< 2.5m) or narrow (< 6m) conditions are flagged inline with warning icons.

**Warning Display:** Overall backend warnings appear at the top in a red-tinted section. Per-leg warnings (shallow, narrow) appear inline when the leg is expanded. Nodes with warned legs show a warning indicator (⚠). The first warned leg auto-expands on route load.

### Bridge Crossing Path Quality
When a route passes through a bridge opening (e.g., Zeelandbrug), the A* path may exhibit a **zigzag pattern** — coordinates repeatedly reverse direction (north→south→north) across adjacent latitude rows.

**Root cause:** The coastal grid has nodes on both sides of the bridge structure (pillars, opening span). The A* path goes through the opening span nodes, but no direct long-spanning edge exists across the bridge because the fixed bridge pillar blocks line-of-sight. The `smoothPath` function cannot collapse these intermediate nodes since the pillar falls within the line-of-sight sampling corridor, causing the check to fail.

**Impact:** The resulting route geometry appears physically spurious — the bearing reverses sharply within a few hundred meters — and the segment edges may have misleading `minDepth`/`maxAirDraft` values when reconstructed via `aggregateSegmentEdges`.

**Possible fixes (not yet implemented):**
1. **Post-processing spike filter:** Detect bearing reversals >90° within short distances and collapse them if the cross-track line stays in water.
2. **Bridge-aware graph edges:** During navmesh generation, insert dedicated "bridge crossing" edges with realistic geometry that skip the pillar nodes entirely.
3. **Smoothing land-buffer:** Enlarge the line-of-sight sampling radius at known bridge crossings, or skip the land-intersection check for edges that cross a bridge POI.

***

## Appendix: Known Graph Data Limitations

### Graph Connectivity
The routing graph is built from ENC data and may contain disconnected components. Smaller disconnected components exist for harbors, inland cuts, and isolated water bodies.

The `findNearestNode` out-degree heuristic (Section 2c) and the fallback routing (Section 2b) mitigate this, but the fundamental fix requires improving the ENC preprocessing pipeline to bridge component gaps.

### Graph Size (Adaptive Grid)
With adaptive quadtree resolution (Section 2f), the coastal navmesh produces 50k–150k nodes (vs ~7,700 with the old fixed 0.01° grid). Nodes are concentrated in narrow channels and along coastlines where high resolution is needed, while open sea remains sparse. The graph loads once at plugin startup and fits comfortably in memory (25–80 MB).

### Constraint Data Quality
- Edges with negative `min_depth` values are treated as unknown data (Section 2a) — passable by default
- `distance_to_land` is computed per edge — coastal routing with high `minCoastDistance` values may struggle to find paths near shore

***
