# Project Specification: SignalK Nautical Route Planner

## 1. Project Overview
This project is an offline-first, vessel-aware nautical route planner designed to run natively as a webapp and plugin within the Signal K ecosystem. Optimized for inland waterways and coastal navigation, it dynamically calculates safe routes based on a vessel's physical dimensions (draft, beam, air draft) and user safety preferences.

To ensure high performance on low-power marine devices (like a Raspberry Pi), the heavy processing of raw vector charts (S-57/ENCs) is abstracted to an external cloud data-pipeline. The vessel utilizes a built-in Data Manager to download lightweight, highly compressed regional "Routing Databases" (SQLite) to perform instantaneous, non-blocking offline routing.

---

## 2. Core Routing Logic & The Cost Function
The heart of the router is a **Directed A* (A-Star) Pathfinding Algorithm**. Unlike a car router that only looks at distance, this algorithm evaluates every potential segment of water (an "Edge") using a multi-layered cost and safety function.

**Step 1: Hard Safety Constraints (The segment is discarded if:)**
*   `edge.min_depth < vessel.draft + safety_margin`
*   `edge.max_air_draft < vessel.airDraft + safety_margin`
*   `edge.min_width < vessel.beam + safety_margin`
*   `edge.distance_to_land < user_min_coast_distance`
*   `edge.crosses_land == 1` or `edge.crosses_obstacle == 1`

**Step 2: The Cost Calculation (If the segment is safe, how "good" is it?)**
$$ Cost = Distance \times FairwayMultiplier \times DirectionalPenalty \times OneWayPenalty $$

*   **Fairway Multiplier:** Edges inside official buoyed waterways (e.g., Dutch RWS data) get a multiplier of `0.8` (preferred). Open-water grid segments get `1.2` (usable, but not preferred).
*   **Directional Penalty:** The graph is *directed*. Traveling on the starboard side of a separated channel has a multiplier of `1.0`. Traveling the wrong way (port side) gets a massive penalty (e.g., `5.0`).
*   **One-Way Penalty:** Navigating completely against official traffic directions incurs a `1,000,000` penalty, forcing the router to respect maritime rules.

---

## 3. Advanced Pathfinding & Optimization

### 3a. Hierarchical Routing (Supernodes & Macro-Edges)
To calculate 200km+ routes in milliseconds on low-power hardware, the system utilizes a Contraction Hierarchy approach via "Supernodes".
*   **Supernodes:** Automatically placed at major junctions, locks, bridges, and every 5 kilometers along uninterrupted waterways.
*   **Pareto-Optimal Macro-Edges:** The cloud pipeline precalculates routes between adjacent Supernodes. Because different ships have different limitations, multiple alternative paths are stored (e.g., a shallow 5km shortcut vs. a deep 8km channel).
*   **First-Mile / Last-Mile A*:** At runtime, the algorithm uses high-resolution nodes to leave a marina and reach the nearest Supernode. It then "leaps" across the country via the precalculated Macro-Edges, filtering them instantly against the vessel's constraints, before dropping back to high-resolution nodes to park at the destination.
*   **Binary Unrolling:** The exact geometry of the long-distance leaps is stored as a compressed binary BLOB. The frontend map receives a perfectly detailed, curved route without the Raspberry Pi having to perform math on thousands of intermediate nodes.

### 3b. Deterministic Node & POI Hashing (Seamless Borders)
The system supports loading multiple regional databases simultaneously (e.g., Netherlands, Belgium, France). To stitch these maps together without collisions:
*   **Node IDs:** Coordinates are snapped to 5 decimal places (~1.1 meters) and packed into a 53-bit JavaScript-safe integer using mathematical offsets: `ID = (Type * 648T) + (Lat * 36M) + Lon`. When overlapping maps are loaded, identical physical nodes generate the exact same ID and seamlessly merge in memory.
*   **POI IDs:** Points of Interest use a deterministic MD5 hash derived from their `type` and `location`. This merges spelling variations of the same lock/bridge at map borders while preserving structurally different stacked features.

### 3c. Adaptive Grid Resolution (Quadtree)
Instead of a fixed 0.01° grid, the coastal navmesh uses **recursive quadtree subdivision** to create variable-density nodes that adapt to local water body narrowness.
*   Resolution varies from `0.005°` (~500m in open sea) to `0.0002°` (~20m in narrow channels).
*   Subdivision criteria includes narrowness (distance to nearest land), presence of centerlines, and land/water boundaries.

### 3d. Path Smoothing (Line-of-Sight String Pulling)
Grid-based A* routing produces a staircase/zig-zag pattern in open water. The router applies a **greedy string-pulling algorithm** as a post-processing step.
*   It checks if a direct straight line between distant nodes has clear **line-of-sight**.
*   Line-of-sight is verified by sampling points (every ~50m) to ensure the path doesn't cross land polygons or stray too far from mapped navigable nodes.
*   Segment metadata (min depth, air draft) is safely aggregated for the new shortcut.

### 3e. Bounding-Box Search Pruning
To keep A* fast, each route search is constrained to a **bounding box** around the start and end points.
*   Initial bounding box uses a configurable margin (default `0.1°` ≈ 11km).
*   If A* fails to reach the destination, the margin doubles until a max extent is reached.
*   Expansion events log warnings for the user.

---

## 4. Safety & Edge Cases

### 4a. Fallback Routing & Warnings
When the A* algorithm cannot find a completed route (due to disconnected graph components or extreme constraints), it falls back to a **partial route**:
*   **Disconnected components:** The router finds the nearest node in the start's component to the destination, routes to it, and appends a straight-line segment ("teleporting" the gap).
*   **Response Warnings:** The GeoJSON response includes a dedicated `warnings` array indicating unmapped sections, relaxed constraints, or disconnected shores.

### 4b. Data Gap Handling
Any negative constraint value in the raw ENC data (e.g., `min_depth = -50`) is treated as an *unknown data gap* and is considered passable. Negative `DRVAL1` depths (above chart datum) are clamped to `0.0` for conservative routing prior to tidal adjustments.

### 4c. Nearest-Node Selection
When selecting the starting or ending graph node, the router:
1. Finds candidates within a set radius.
2. Prioritizes nodes with higher out-degrees (connections).
3. Evaluates surrounding depth vectors to prevent trapping a deep-draft vessel in a shallow coastal node when an adjacent deep inland node is available.

---

## 5. System Components

### 5a. The Cloud Graph Generator (Data Pipeline)
*   **Technology Stack:** Python, GDAL/OGR, NetworkX, SQLite.
*   **Processing:** Parses S-57 ENCs, generates Inland/Coastal network, calculates spatial constraints, and outputs a SQLite database.
*   **Deployment:** Generates `.sqlite.gz` files distributed via a static GitHub catalog (`index.json`).

### 5b. The Signal K Backend Plugin (The Router)
*   **Technology Stack:** Node.js (22+), TypeScript, `node:sqlite`, `worker_threads`.
*   **Non-Blocking Architecture:** Because SQLite's native Node wrapper is synchronous, all heavy map loading and database querying is offloaded to a **Worker Thread**. This ensures the main event loop is never blocked, maintaining flawless NMEA sensor processing.
*   **Vessel Subscription:** Listens to Signal K delta streams (`vessels.self.design.*`) to automatically update routing draft, beam, and air draft.

### 5c. The Interactive WebApp (Frontend UI)
*   **Technology Stack:** HTML, CSS, JavaScript, Leaflet.js.
*   **Data Manager:** Built-in UI to fetch the remote map catalog and download/update regional databases directly to the server.
*   **Smart Route Pane:** Turns raw coordinates into a "Turn-by-Turn" styled list by using a dynamic bearing-change threshold algorithm.
*   **Leg Insights:** Expanding a leg shows aggregated depth, width, and air-draft clearance, inline warnings for shallow water, and iconography for bridges/locks encountered.

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
---

## 6. Future/Known Limitations

### Bridge Crossing Path Quality
When crossing opening bridges (e.g., Zeelandbrug), paths may exhibit minor zig-zags because fixed bridge pillars block the line-of-sight smoother. Dedicated bridge-crossing edges (with true pillar-avoidant geometry) will be needed in the navmesh generator.

### Graph Connectivity
Smaller harbors or inland cuts in raw ENCs are sometimes entirely isolated. The fallback routing teleports across these gaps, but pipeline-level automatic topology bridging is a future target.