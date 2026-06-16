# TODO — Feature Planning

## 1. Tide-Informed Depth Calculation in Routing

### Problem
Chart depths are referenced to Lowest Astronomical Tide (LAT) — the lowest expected water level under normal conditions. Actual depth at any time = charted depth + local tidal height above LAT at that moment. A route that seems impassable for a given draft might be perfectly safe at high tide, and conversely, a route that seems safe might be dangerous at low tide.

### How It Should Work

**Data source**: Query tidal predictions via Signal K's `resources/tides/*` path, or via an integrated harmonic tide model (e.g., XTide / pyTide). Each request includes a position (lat, lon) and a UTC time, returning predicted tide height in meters above LAT.

**Depth adjustment per edge**: When evaluating an edge during A*, the system needs to know the "effective depth" at the time the vessel will *actually be at that edge*. This means:
1. Estimate the arrival time at each edge/node along the route based on accumulated travel time from the departure time + distance/speed for each preceding edge.
2. For each edge, query the tide height at the edge's midpoint (or a sample of points along it) for that estimated arrival time.
3. `effective_depth = charted_min_depth + tide_height_above_lat`
4. Filter: if `effective_depth < vessel_draft + safety_margin`, discard the edge.

**Optimization — skip sampling when not needed**: If `charted_min_depth` alone is already `>= vessel_draft + safety_margin + max_tide_range_for_region`, the edge is always safe regardless of tide — skip tide lookup entirely. This avoids expensive tide queries for deep-water edges. Similar to the "4-meter fast-path" in depth extraction, but applied at routing time.

**Tide variation along long edges**: For edges longer than ~2 km, take multiple tide samples at regular intervals. A 20 km coastal edge may cross from an area with high tidal range to one with low tidal range. Use the minimum effective depth across all samples.

**Fallback**: If tide data is unavailable for a given region/time, log a warning and fall back to using `charted_min_depth` alone (conservative, always safe).

**Data model changes**:
- `DepartureTime` becomes a required input (see feature #4).
- Each edge in the A* open set carries an `estimatedArrivalTime` field so that tide queries are anchored to the correct time.
- Tide data can be cached aggressively (keyed by `(rounded_lat_3dp, rounded_lon_3dp, date_hour)`) since it changes slowly and predictably.

---

## 2. Tidal Current (Stream) in Routing Cost

### Problem
Tidal streams add or subtract from a vessel's speed over ground. A 6-knot tidal current aligned with the route can double a 6-knot vessel's speed; the same current against the route can reduce it to zero. The current router assumes constant still-water speed, which can lead to wildly inaccurate ETAs and suboptimal route choices.

### How It Should Work

**Data source**: Tidal stream data from Signal K (`resources/currents/*`) or harmonic models. For a given position and time, returns: speed (knots) and direction (degrees true).

**Speed adjustment**: For each edge, calculate:
```
tidal_component = tidal_speed * cos(tidal_dir - edge_bearing)
effective_speed = vessel_speed + tidal_component  (can be > base or negative)
```
If `effective_speed <= 0`, the vessel is being pushed backwards — the edge is effectively impassable in the forward direction (or requires an extremely high penalty).

**Cost function impact**: The A* cost (time) for an edge becomes:
`edge_cost_seconds = edge_length_meters / (effective_speed * 0.514444)` (converting knots to m/s).
This makes the router naturally prefer edges where the tidal stream is favorable (or at least not opposing), and avoid routing against a strong current.

**Temporal dependence**: Like tide height, tidal streams vary by time. The estimated arrival time at each edge determines the tidal stream used. This makes the problem genuinely time-dependent (TDSP — Time-Dependent Shortest Path). The A* search must account for the fact that the cost of an edge depends on *when* you arrive at it, which in turn depends on the path taken so far.

**Efficient lookup**: Precompute a "tidal stream grid" at low resolution (e.g., 1 km grid, 1-hour time steps) to avoid per-edge harmonic calculations. Interpolate (bilinear in space, linear in time) for the exact query point.

**Fallback**: If tidal current data is unavailable, log a warning and use `effective_speed = vessel_speed` (no current). This keeps existing routes working in regions without current data.

---

## 3. Weather Routing & Sailing Polar Diagrams

### Problem
Sailing boats don't have a fixed speed. Their speed depends on wind speed and wind angle relative to the boat (True Wind Angle). The current router assumes a constant speed for all conditions, which is completely wrong for sailboats and inaccurate for power vessels in heavy weather.

### How It Should Work

**Polar data**: A "polar table" is a 2D lookup table: `boat_speed(TWS, TWA)` where:
- TWS = True Wind Speed (knots) — rows
- TWA = True Wind Angle (degrees) — columns (0° = headwind, 90° = beam reach, 180° = downwind)
The table is vessel-specific and stored in the vessel's Signal K configuration or hardcoded per vessel type.

**Wind data source**: Forecast wind data from Signal K (GRIB/WaveWatch III via `resources/weather/*` or forecast APIs). For a given position and time, returns: wind speed (knots) and direction (degrees true) at 10m height.

**Speed calculation for each edge**:
1. Look up wind at the edge's midpoint at the estimated arrival time.
2. Calculate True Wind Angle: `TWA = abs(wind_dir - edge_bearing)`. If TWA > 180°, use `360 - TWA` (sailing is symmetric).
3. Look up the polar table: `effective_speed = polar_table.lookup(TWS, TWA)`.
4. If TWS is above the boat's maximum wind tolerance, apply a heavy penalty (reefing / heaving-to).
5. If TWS is below the boat's minimum planing threshold for sail, use a minimal "ghosting" speed.

**Integration with tidal current**: First calculate the Through-Water speed from the polar, then apply tidal current adjustment (feature #2) to get Speed Over Ground. The order matters: wind affects the boat through the water, current adds to that.

**Non-sailing defaults**: If the vessel is a motorboat (or polar data is absent), use the configured `nominal_speed` regardless of wind, but still apply tidal current (feature #2). A power vessel might optionally have a "fuel efficiency vs. speed" curve for eco-routing.

**Storing polars**: Store as a JSON blob in vessel config in Signal K, or in the plugin config under a key like `vesselPolar`. Provide a simple editor in the UI to set speed values for each wind bin.

---

## 4. Departure Time Selection

### Problem
The router currently assumes departure is "right now." All time-dependent features (tide height, tidal current, wind) require knowing *when* the vessel departs, because conditions change over time and the arrival time at each waypoint depends on when you started.

### How It Should Work

**UI element**: Add a date/time picker in the sidebar (or above the map) with the current time as the default. Include:
- Departure date + time in local timezone (with UTC display)
- A "Now" button to reset to current time
- "Depart at" vs "Arrive by" toggle (see below)

**API change**: The `/route` POST request now includes:
```json
{
  "start": [...],
  "destination": [...],
  "departureTime": "2026-06-16T08:00:00Z",
  "arriveBy": false,
  ...
}
```
If `arriveBy: true`, `departureTime` is treated as the desired arrival time, and the router works backwards (or iterates to find the optimal departure).

**Backend propagation**: `departureTime` flows into the A* search as a `startTime` parameter. Each node in the search space carries `cumulativeTimeSeconds`. When evaluating an edge:
1. `edgeArrivalTime = startTime + cumulativeTime + edgeTravelTime(using_current_speed)`
2. Use `edgeArrivalTime` for all time-dependent lookups (tide height, tidal current, wind).

**Iterative refinement**: Since edge travel time depends on conditions (tidal current + wind) which depend on arrival time, there's a circular dependency. Use iterative refinement:
1. First pass: estimate travel time without time-dependent effects.
2. Look up conditions at the estimated time window.
3. Second pass: recalculate with better time estimates.
4. Iterate until convergence (or max 3 iterations).
This is standard practice in time-dependent routing.

**"Arrive by" mode**: Common for tide-dependent passages (arrive at a shallow lock/harbor before the tide falls). The router should search for the optimal departure time that minimizes total travel time while arriving before the specified time. This is effectively a 1D optimization over departure time.

---

## 5. Manual Routing (User Takes Over Where Auto-Router Fails)

### Problem
The autorouter works well in well-charted fairways but can fail in complex areas with missing data, narrow passages, or unusual constraints. Currently there's no fallback — the user gets "route not found." Manual routing lets the user draw their own segments, which is especially important when the automatic graph doesn't fully cover the desired route.

### How It Should Work

**Concept**: A route becomes a *mixed sequence* of auto-routed segments and manually drawn segments. The user clicks to place waypoints; the system auto-routes between consecutive waypoints when possible, and falls back to straight-line/drawn segments when the auto-router fails (or when the user explicitly draws a manual segment).

**UI interaction**:
- **Add waypoint**: Single-click on the map inserts a new waypoint at that location (connected by auto-route to the previous waypoint).
- **Manual segment toggle**: A "Draw" button/mode in the toolbar. When active, the user clicks to place individual routing points. Each click adds a point; connections between manual points are straight-line segments (or rhumb lines). These segments are labeled "manual" in the route result.
- **Visual distinction**: Auto-routed segments in blue, manual segments in dashed orange/red. The user can immediately see where the auto-router succeeded and where they had to draw manually.
- **Snapping**: When creating manual points, snap to the nearest node in the routing graph (within ~50m) to ensure the manual segment connects to the graph at both ends.
- **Drag to adjust**: After placement, drag any waypoint to reposition it. This triggers a re-route of the affected auto-segments while preserving manual segments.

**Backend**:
- The route request includes a `segments` array:
  ```json
  {
    "segments": [
      { "type": "auto", "start": [...], "end": [...] },
      { "type": "manual", "points": [[...], [...], ...] }
    ]
  }
  ```
- The router processes auto-segments normally via A*.
- Manual segments are returned as-is (straight-line or rhumb-line interpolation between the user's points).
- The router validates that manual segments don't cross land (optional, configurable). If they do, add a warning rather than blocking (the user may know about a bridge or ferry that isn't in the graph).

**Use case**: A user needs to go from Amsterdam to a small marina up a narrow creek not in the ENC data. They auto-route to the mouth of the creek, then switch to manual mode to draw the final few hundred meters into the marina.

---

## 6. Swap Left-Click / Right-Click Interaction

### Problem
Currently, right-click places start/destination/via points, and left-click is used for map panning. This is unintuitive and conflicts with standard web map conventions where left-click selects/interacts, right-click shows context menus or pans (or does nothing). It also makes the interface hard to discover — new users don't think to right-click.

### How It Should Work

**New convention**:
- **Left-click** on empty water → add a waypoint (start, via, or destination depending on state).
- **Left-click** on an existing waypoint → drag to reposition it.
- **Left-click** on a route segment (between waypoints) → insert a new via point at that position.
- **Left-click drag** on empty map → pan (Leaflet default).
- **Right-click** → context menu with options: "Set as departure", "Set as destination", "Add as via point", "Add manual segment here", "Remove waypoint", "Clear route".
- **Right-click drag** → continues to pan (Leaflet default), so users who expect right-click to pan still can.

**State machine**:
- **Idle**: Map pans with left-drag. Left-click shows a popup: "Create route here" or adds a start point if no route exists.
- **Has start, no destination**: Left-click adds destination (triggers route calculation).
- **Has route**: Left-click on empty water adds a via point. Left-click on an existing via point allows dragging.
- **Manual drawing mode**: Left-click adds manual routing points (see feature #5).
- **Right-click**: Always opens context menu relevant to the clicked location.

**Backward compatibility**: This is a significant UX change. Consider a settings option: "Use left-click for routing" (default ON). When OFF, revert to the current right-click-for-routing behavior. This gives experienced users a migration path.

**Touch devices**: On mobile/tablet, a tap (touch) replaces left-click. Long-press replaces right-click (context menu). Pinch to zoom continues to work as normal.

#### 1. Elevation/Depth Route Profile Graph
**Description**: When viewing a route, users want to visually understand where the shallow spots or low bridges are. A 2D profile graph charting Depth and Air Draft over Distance makes it instantly clear where the bottlenecks are.
**AI Prompt**:
> "In `public/index.html`, implement a route profile graph below the map using Chart.js or D3. When a route is calculated, plot the `minDepth` and `maxAirDraft` of the segments along the X-axis (cumulative distance). Add visual threshold lines for the current vessel's draft and air draft."

#### 2. Tidal Adjustments for Draft
**Description**: Signal K has access to live and forecasted tide data. A route that is currently "too shallow" might be perfectly safe in 3 hours. 
**AI Prompt**:
> "Create a feature in `src/routing.ts` to accept an 'estimated departure time' and average speed. Look up Signal K tidal height data along the route. Adjust the `min_depth` of coastal/estuary edges by adding the estimated tidal height at the time the vessel is expected to reach that specific segment."

#### 3. Dynamic Isochrones (Reachability Polygons)
**Description**: Instead of just routing point-to-point, show the user a polygon representing everywhere they can travel within 1, 2, or 4 hours based on their vessel speed and graph constraints.
**AI Prompt**:
> "Implement an Isochrone generation API in `src/routing.ts`. Use Dijkstra's algorithm originating from the vessel's location, expanding outward up to a specific time limit (cost). Return the boundary nodes as a GeoJSON Polygon. Display this layer in `public/index.html` to show reachability."

#### 4. Custom Avoidance Zones (No-Go Areas)
**Description**: Users might want to avoid specific areas due to temporary military exercises, regattas, or rough weather.
**AI Prompt**:
> "Add a feature to the web UI allowing users to draw GeoJSON polygons representing 'No-Go Zones'. Pass these polygons in the POST request to `/route`. In `src/routing.ts`, check if an edge intersects any No-Go Zone and apply a massive penalty (or remove it from the available A* nodes)."

#### 5. Turn-by-Turn Marine Instructions
**Description**: The current implementation just says "Start" and "Destination". It should provide actual marine instructions based on edge angles and fairway transitions.
**AI Prompt**:
> "Enhance `makeSimpleInstructions` in `public/index.html`. Iterate over the route nodes and calculate bearing changes. If the angle changes by more than 30 degrees, output 'Turn [Port/Starboard] heading [XXX°]'. If transitioning onto a fairway edge, output 'Enter fairway [POI Name if available]'."

#### 6. Energy / Fuel Consumption Estimation
**Description**: Electric vessels and motorboats need to know if they have enough range for a route.
**AI Prompt**:
> "Add 'fuel/battery capacity' and 'consumption rate per nautical mile' to the vessel settings in the UI. When displaying the route summary, calculate the estimated energy required. If it exceeds capacity, render a prominent warning in the `route-warnings` div."

#### 7. Marine Night Mode & High Contrast
**Description**: For a marine navigation app, blinding white panels at night are dangerous for night vision.
**AI Prompt**:
> "Implement a toggle for a true 'Night Mode' in `public/index.html`. Define CSS variables for deep reds and blacks (e.g., `#110000`, text `#ff5555`) to preserve night vision. Switch the Leaflet basemap to a dark or red-tinted tile layer when this mode is active."

#### 8. Bridge Opening Schedules & Wait Times
**Description**: A route taking 2 hours might actually take 5 hours if a bridge is closed. The router currently just knows if a bridge *can* open, not *when*.
**AI Prompt**:
> "Add a schedule metadata field to the Bridge POIs in the SQLite database. In the frontend, if a route passes through an 'opening' bridge, calculate the ETA to that bridge. If the ETA falls outside operating hours, add a specific `route-warning` indicating the required wait time."

#### 9. Undo/Redo Stack for Route Planning
**Description**: When users accidentally right-click and erase their carefully crafted 10-waypoint route, there is no way to get it back.
**AI Prompt**:
> "Implement an undo/redo stack in `public/index.html`. Whenever `applyWaypoints()` is called, push a deep copy of `state.startLatLng`, `state.destLatLng`, and `state.viaPoints` into a history array. Add Undo (Ctrl+Z) and Redo (Ctrl+Y) keyboard shortcuts and UI buttons to restore previous states."

#### 10. Weather Routing (Wind & Current Overlays)
**Description**: Nautical routing is heavily influenced by wind and water currents. Providing visual overlays helps users choose better via-points.
**AI Prompt**:
> "Integrate Leaflet-Velocity or a similar particle animation library into `public/index.html` to display GRIB data (wind/currents). Add an API endpoint to fetch the latest wind vectors from Signal K, and allow the user to toggle this weather overlay on the map while plotting routes."


### type ahead in POI
Better POI selection
#smaller search
#remove/simplify the config
#download UI for db files

#the segments (legs) vs the details in the leg seem to be very confusing for the UI.
We need to have this clarified. the frontend should be able to be dumb, so not too much logic in the frontend as other plugings much be able to use the endpoints and also provide the UI

database optiomisation --> types to enums with number
traffic dir and isoneway --> combine 1,2,3 
enum table 'field', id, 'desscription' + helper function
direction_penalty


'edge type to id'







supernodes architecture


Model 9:51 AM
ThinkingThoughts
Expand to view model thoughts

chevron_right
You have just identified one of the most complex challenges in modern constraint-based routing. You are 100% correct.
If the system only precalculates the absolute shortest path between Supernode A and Supernode B, a sailboat with a 2.0m draft will be completely trapped if that one precalculated macro-edge goes through a 1.0m deep shortcut.
The Solution: "Pareto-Optimal" Macro-Edges
Instead of storing one macro-edge between two Supernodes, the Python cloud pipeline must store a set of alternative macro-edges.
In graph theory, this is called finding the Pareto Front. The pipeline calculates and stores different variations of the path:
The Shortcut: 5 km long, Min Depth 1.0m, Max Air Draft 3.0m.
The Deep Channel: 8 km long, Min Depth 5.0m, Max Air Draft 3.0m.
The Mast-Up Route: 12 km long, Min Depth 5.0m, Max Air Draft 20.0m (no fixed bridges).
When the Signal K Node.js router runs, the A* algorithm looks at Supernode A and sees three macro-edges pointing to Supernode B.
If a small motorboat (draft 0.5m, air draft 2m) asks for a route, the router evaluates all three, sees they are all safe, and picks Edge 1 (the 5km shortcut).
If a sailboat (draft 1.8m, air draft 15m) asks for a route, the router evaluates all three. Edge 1 is too shallow. Edge 2 has a bridge that is too low. The router throws them out and seamlessly selects Edge 3.
How to implement this in the AI Prompts
We need to instruct the Python pipeline to find these alternative routes, and we need to ensure the Node.js backend knows how to filter them.
Phase 1: Python Precomputation (Cloud)
We will tell Python to use an algorithm (like Yen's k-shortest paths or bottleneck-removal) to find these alternative routes.
AI Prompt for Python:
"In backend/nautical_routing_pipeline.py, when generating the Hierarchical 'macro_edges' between Supernodes, we cannot just store the absolute shortest path. Different vessels have different dimensions, so a deep draft vessel cannot take a shallow shortcut.
Please update the Supernode macro-edge generation logic to store Pareto-optimal alternative paths.
Find the shortest path between Supernode A and B. Save it as a macro-edge.
Identify the bottleneck edge of that path (e.g., the edge with the lowest min_depth or max_air_draft).
Temporarily penalize or remove that bottleneck edge from the graph and run the shortest path algorithm again to find an alternative route (e.g., a longer route but with deeper water or higher clearance).
Repeat this until you have found the alternative paths (or up to a reasonable limit, like max 3 macro-edges between the same two supernodes).
Insert ALL of these alternative macro-edges into the macro_edges SQLite table. They will share the same source and target IDs, but have different distance, min_depth, max_air_draft, and path_json values."
Phase 2: Node.js Runtime (Signal K Plugin)
The Node.js logic barely has to change, we just need to ensure it evaluates all macro-edges between two nodes rather than just assuming there is only one.
AI Prompt for Node.js:
"In src/routing.ts and src/database.ts, the database now contains multiple alternative macro_edges between the same source and target Supernodes. These represent different physical routes (e.g., a shallow shortcut vs. a deep, longer channel).
Please update the astarSearch logic to handle this:
When expanding a Supernode, the algorithm must iterate over all available macro-edges to the target Supernodes.
For each macro-edge, strictly apply the dynamic vessel constraints (if edge.min_depth < vessel.draft + margin or edge.max_air_draft < vessel.airDraft + margin, discard that specific macro-edge).
Calculate the standard cost for the remaining valid macro-edges and push them to the A* Open Set.
Because A* naturally explores the lowest-cost path first, this will automatically result in the algorithm taking the fastest macro-edge that safely fits the specific vessel's dimensions."
Why this is the ultimate routing architecture
By doing this, you have effectively built the "Holy Grail" of marine routing.
The Python server does all the heavy lifting of figuring out the "shallow vs deep" topology of the Dutch waterways just once. The weak Raspberry Pi on the boat only does a few dozen calculations, instantly giving the perfect, vessel-specific route across the whole country.








"We need to fix an 'Edge Poisoning' bug in backend/nautical_routing_pipeline.py where coarse edges clip shallow sandbanks, while aggressively optimizing cloud CPU time using the nautical insight that any depth >= 4.0m is universally safe for our target vessels.
Please update the depth extraction logic in _edge_attr_worker to use a '4-Meter Fast-Path' combined with 10-point sampling:
Get the depth polygons intersecting the edge's bounding box:
candidates = _candidates_by_bounds_static(depare_gdf, edge_geom)
The Fast-Path: If candidates is not empty, check the DRVAL1 column. If the minimum DRVAL1 of all these candidates is >= 4.0, we don't need detailed sampling. Set attrs['min_depth'] = float(candidates['DRVAL1'].min()) and attrs['drval1'] = attrs['min_depth'], and skip step 3.
High-Precision Sampling: If any candidate has DRVAL1 < 4.0 (or NaN), perform a 10-point sample along the edge:
Generate 10 points: pts = [edge_geom.interpolate(f, normalized=True) for f in np.linspace(0.0, 1.0, 10)]
For each point, find the first polygon in candidates where geom.contains(pt) is true.
Extract its DRVAL1 (defaulting to 99.0 if no polygon is found).
The edge's min_depth is the minimum of those 10 sampled depths.
Assign attrs['min_depth'] = max(0.0, float(min_val)) and attrs['drval1'] = min_val if min_val < 99.0 else None.
This ensures edges near sandbanks are meticulously sampled to avoid false shallows, while edges in universally deep water are processed instantly."
