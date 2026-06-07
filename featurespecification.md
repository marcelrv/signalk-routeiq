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

*   **Technology Stack:** Node.js, TypeScript, `sqlite3`, customized A* pathfinding algorithm, `togpx` (for GPX conversion).
*   **Core Responsibilities:**
    1.  **Vessel Parameters:** On initialization, read the vessel's dimensions from the plugin configuration (`defaultDraft`, `defaultBeam`, `defaultAirDraft`) and subscribe to live updates from the Signal K delta tree (`vessels.self.design.draft`, `design.beam`, `design.airDraft`).
    2.  **Execute Pathfinding:** Listen for requests, apply the Cost Function (detailed in Section 2), attempt fallback routing if no path is found (Section 2b), and return GeoJSON with optional warnings.
    3.  **Config Persistence:** The `ApiHandler` and its Express routes survive stop/start cycles. On config save (Admin UI), only the `RoutingEngine` is recreated with the new config values — routes stay registered.

*   **Plugin Configuration (Admin UI):**
    - `routingDatabase`: Path to the SQLite routing graph
    - `defaultDraft` (m), `defaultBeam` (m), `defaultAirDraft` (m): Vessel defaults
    - `defaultCoastDistance` (NM): Default minimum distance from shore
    - `fairwayMultiplier`, `openWaterMultiplier`, `wrongWayPenalty`: Cost function coefficients
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

***

## Appendix: Known Graph Data Limitations

### Graph Connectivity
The routing graph is built from ENC data and may contain disconnected components. The main component covers the Netherlands coastal area (~51.33-51.85°N, 3.14-4.55°E, 3166 nodes). A second large component covers the northern Wadden area (~52.34-53.09°N, 4.96-5.83°E, 2496 nodes). Many smaller components (255 total) exist for harbors, inland cuts, and isolated water bodies.

The `findNearestNode` out-degree heuristic (Section 2c) and the fallback routing (Section 2b) mitigate this, but the fundamental fix requires improving the ENC preprocessing pipeline to bridge component gaps.

### Constraint Data Quality
- 3046 edges have negative `min_depth` values (sentinels for unknown data) — handled via Section 2a
- `distance_to_land` distribution is heavily skewed toward 0 (3264 edges at exactly 0) — coastal routing with high `minCoastDistance` values may struggle to find paths
- 12969 of 45587 edges have `distance_to_land >= 1000m`

***
